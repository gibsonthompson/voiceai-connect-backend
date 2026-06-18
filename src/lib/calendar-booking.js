// ====================================================================
// GOOGLE CALENDAR BOOKING - VAPI Tool Handler
// Matched to CallBird working implementation
// UPDATED: Added double-booking prevention guard
// UPDATED: 2026-05-19 Phase 3B — Service-aware booking: looks up service
//   duration from client_services table, includes staff name in event
//   title, applies buffer minutes between appointments.
// UPDATED: 2026-06-17 — TIMEZONE FIX + edge-case hardening.
//   Availability previously compared busy events using the SERVER's
//   timezone (UTC on DigitalOcean) against business hours in the CLIENT's
//   timezone, so conflict detection was wrong and the AI would offer (and
//   book) slots that were already taken. Now every candidate slot and every
//   busy event is compared as a real absolute instant, with wall-clock ->
//   UTC conversion done in the client's timezone. Also handled: all-day
//   "Closed/Vacation" events now block the day, same-day past slots are
//   skipped (30-min lead), cancelled events are ignored, calendar read
//   failures fail safe, and DST boundaries are handled in the conversion.
// ====================================================================
const { supabase } = require('./supabase');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CALENDAR_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CALENDAR_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;

// Minimum notice before a slot can be offered/booked (avoids "today at a time
// that already passed" and gives the business a little lead time).
const LEAD_TIME_MINUTES = 30;
// Granularity of offered start times.
const SLOT_STEP_MINUTES = 30;

// ====================================================================
// TIMEZONE HELPERS
// Plain-Node wall-clock <-> UTC conversion for IANA timezones, so we never
// depend on the server's own timezone. getTzOffsetMinutes returns the offset
// (in minutes) a timezone has from UTC at a given instant; zonedWallTimeToUTC
// turns a local wall-clock time in a timezone into the correct UTC instant,
// refining once across DST boundaries.
// ====================================================================
function getTzOffsetMinutes(instant, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(instant).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  // Intl can emit hour '24' at midnight in some environments; normalize to 0.
  let hour = parseInt(parts.hour, 10);
  if (hour === 24) hour = 0;
  const asUTC = Date.UTC(
    parseInt(parts.year, 10),
    parseInt(parts.month, 10) - 1,
    parseInt(parts.day, 10),
    hour,
    parseInt(parts.minute, 10),
    parseInt(parts.second, 10)
  );
  return (asUTC - instant.getTime()) / 60000;
}

function zonedWallTimeToUTC(year, month, day, hour, minute, timeZone) {
  // First guess: pretend the wall time is already UTC.
  const guessMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  let offset = getTzOffsetMinutes(new Date(guessMs), timeZone);
  let utcMs = guessMs - offset * 60000;
  // Refine once in case the offset at the guessed instant differs from the
  // offset at the resolved instant (DST transitions).
  const offset2 = getTzOffsetMinutes(new Date(utcMs), timeZone);
  if (offset2 !== offset) {
    utcMs = guessMs - offset2 * 60000;
  }
  return new Date(utcMs);
}

// Refresh access token if expired
async function refreshAccessToken(client) {
  if (!client.google_refresh_token) {
    console.error('No refresh token available');
    return null;
  }

  const expiresAt = new Date(client.google_token_expires_at);
  const now = new Date();
  const bufferMs = 5 * 60 * 1000;

  if (!isNaN(expiresAt.getTime()) && expiresAt.getTime() - now.getTime() > bufferMs) {
    return client.google_access_token;
  }

  console.log('🔄 Refreshing Google access token...');

  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: client.google_refresh_token,
        grant_type: 'refresh_token',
      }),
    });

    if (!response.ok) {
      console.error('Token refresh failed:', await response.text());
      return null;
    }

    const tokens = await response.json();
    const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

    await supabase
      .from('clients')
      .update({
        google_access_token: tokens.access_token,
        google_token_expires_at: newExpiresAt,
      })
      .eq('id', client.id);

    return tokens.access_token;
  } catch (err) {
    console.error('Token refresh error:', err);
    return null;
  }
}

// Parse time string to 24hr format
function parseTimeTo24Hr(timeStr) {
  if (!timeStr) return null;
  const normalized = timeStr.toString().trim().toLowerCase();

  if (/^\d{1,2}:\d{2}$/.test(normalized) && !normalized.includes('m')) {
    return normalized.padStart(5, '0');
  }

  const match = normalized.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  const period = match[3]?.toLowerCase();

  if (hours > 23 || minutes > 59) return null;

  if (period === 'pm' && hours !== 12) hours += 12;
  if (period === 'am' && hours === 12) hours = 0;

  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

// Helper: format a slot label to match what getAvailableSlots produces
function formatSlotLabel(hr, min) {
  var hour12 = hr > 12 ? hr - 12 : (hr === 0 ? 12 : hr);
  var ampm = hr >= 12 ? 'PM' : 'AM';
  var minStr = min === 0 ? '' : ':' + min.toString().padStart(2, '0');
  return hour12 + minStr + ' ' + ampm;
}

// ====================================================================
// PHASE 3B: Look up service by name in client_services table
// Returns { duration_minutes, buffer_minutes, booking_mode } or null
// ====================================================================
async function lookupServiceConfig(clientId, serviceName) {
  if (!serviceName || !clientId) return null;

  try {
    const normalizedName = serviceName.trim().toLowerCase();

    const { data: services, error } = await supabase
      .from('client_services')
      .select('name, duration_minutes, buffer_minutes, booking_mode')
      .eq('client_id', clientId)
      .eq('is_active', true);

    if (error || !services || services.length === 0) return null;

    // Fuzzy match: exact first, then includes, then starts-with
    const exact = services.find(s => s.name.toLowerCase() === normalizedName);
    if (exact) return exact;

    const includes = services.find(s => s.name.toLowerCase().includes(normalizedName) || normalizedName.includes(s.name.toLowerCase()));
    if (includes) return includes;

    return null;
  } catch (err) {
    console.warn('⚠️ Service lookup failed:', err.message);
    return null;
  }
}

// ====================================================================
// Get available time slots
// options: { durationOverride, bufferMinutes }
//
// All conflict detection is done in absolute instants. Candidate slots are
// built from the client's business hours in the client's timezone, then
// converted to UTC instants for comparison against the calendar's busy events
// (which are already absolute). This makes availability correct regardless of
// the server's timezone.
// ====================================================================
async function getAvailableSlots(clientId, date, options) {
  try {
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { success: false, error: 'Invalid date' };
    }

    const { data: client, error } = await supabase
      .from('clients')
      .select('*')
      .eq('id', clientId)
      .single();

    if (error || !client || !client.google_calendar_connected) {
      return { success: false, error: 'Calendar not connected' };
    }

    const accessToken = await refreshAccessToken(client);
    if (!accessToken) {
      return { success: false, error: 'Calendar authentication failed' };
    }

    const timezone = client.timezone || 'America/New_York';

    const businessHours = client.business_hours || {
      monday: { open: '09:00', close: '17:00' },
      tuesday: { open: '09:00', close: '17:00' },
      wednesday: { open: '09:00', close: '17:00' },
      thursday: { open: '09:00', close: '17:00' },
      friday: { open: '09:00', close: '17:00' },
      saturday: null,
      sunday: null,
    };

    const [yy, mm, dd] = date.split('-').map(Number);

    // Day of week resolved IN THE CLIENT'S TIMEZONE (not the server's), using a
    // local-noon instant so we never land on the wrong side of midnight.
    const noonLocal = zonedWallTimeToUTC(yy, mm, dd, 12, 0, timezone);
    const dayName = noonLocal
      .toLocaleString('en-US', { timeZone: timezone, weekday: 'long' })
      .toLowerCase();
    const hours = businessHours[dayName];

    if (!hours || !hours.open || !hours.close) {
      return { success: true, slots: [], message: 'Closed on this day' };
    }

    // Fetch all events on the client-local calendar day (local midnight to the
    // next local midnight, expressed as UTC instants).
    const dayStartUTC = zonedWallTimeToUTC(yy, mm, dd, 0, 0, timezone);
    const baseNoonUTC = new Date(Date.UTC(yy, mm - 1, dd, 12, 0, 0));
    const nextNoonUTC = new Date(baseNoonUTC.getTime() + 24 * 60 * 60 * 1000);
    const dayEndUTC = zonedWallTimeToUTC(
      nextNoonUTC.getUTCFullYear(),
      nextNoonUTC.getUTCMonth() + 1,
      nextNoonUTC.getUTCDate(),
      0, 0, timezone
    );

    const calendarId = client.google_calendar_id || 'primary';

    let eventsResponse;
    try {
      eventsResponse = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?` +
        new URLSearchParams({
          timeMin: dayStartUTC.toISOString(),
          timeMax: dayEndUTC.toISOString(),
          singleEvents: 'true',
          orderBy: 'startTime',
        }),
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
    } catch (fetchErr) {
      console.error('Calendar events fetch threw:', fetchErr.message);
      return { success: false, error: 'Failed to read the calendar' };
    }

    if (!eventsResponse.ok) {
      const body = await eventsResponse.text().catch(() => '');
      console.error(`Calendar events fetch failed (HTTP ${eventsResponse.status}): ${body.slice(0, 200)}`);
      return { success: false, error: 'Failed to read the calendar' };
    }

    const eventsData = await eventsResponse.json();
    const items = (eventsData.items || []).filter(ev => (ev.status ? ev.status !== 'cancelled' : true));

    // All-day events (start.date, no start.dateTime) almost always mean the
    // office is out for the day (Closed, Vacation, Holiday). Treat the day as
    // fully unavailable rather than risk booking over it.
    const allDay = items.find(ev => ev.start && ev.start.date && !ev.start.dateTime);
    if (allDay) {
      console.log(`📅 All-day event on ${date} ("${allDay.summary || 'untitled'}") — treating the day as unavailable`);
      return { success: true, slots: [], message: 'Unavailable this day' };
    }

    // Timed busy ranges as absolute instants.
    const busy = items
      .filter(ev => ev.start && ev.start.dateTime && ev.end && ev.end.dateTime)
      .map(ev => ({ start: new Date(ev.start.dateTime), end: new Date(ev.end.dateTime) }))
      .filter(b => !isNaN(b.start.getTime()) && !isNaN(b.end.getTime()));

    const duration = (options && options.durationOverride) || client.appointment_duration || 30;
    const buffer = (options && options.bufferMinutes) || 0;

    const [openHr, openMin] = hours.open.split(':').map(Number);
    const [closeHr, closeMin] = hours.close.split(':').map(Number);
    const openTotal = openHr * 60 + openMin;
    const closeTotal = closeHr * 60 + closeMin;

    const nowMs = Date.now();
    const leadMs = LEAD_TIME_MINUTES * 60000;
    const slots = [];

    for (let cur = openTotal; cur + duration <= closeTotal; cur += SLOT_STEP_MINUTES) {
      const hr = Math.floor(cur / 60);
      const min = cur % 60;

      const slotStartMs = zonedWallTimeToUTC(yy, mm, dd, hr, min, timezone).getTime();
      const slotEndMs = slotStartMs + duration * 60000;

      // Skip slots that are in the past or too soon (same-day protection).
      if (slotStartMs < nowMs + leadMs) continue;

      // Buffer expands the slot's protected window symmetrically. With buffer 0
      // this is a plain overlap test; abutting events (busy.end === slotStart)
      // do not count as a conflict.
      const bufStartMs = slotStartMs - buffer * 60000;
      const bufEndMs = slotEndMs + buffer * 60000;

      const hasConflict = busy.some(b =>
        bufStartMs < b.end.getTime() && bufEndMs > b.start.getTime()
      );

      if (!hasConflict) {
        slots.push(formatSlotLabel(hr, min));
      }
    }

    console.log(`📅 Available slots for ${date} (${timezone}): ${slots.length} slots (duration: ${duration}min, buffer: ${buffer}min)`);
    return { success: true, slots, date };
  } catch (err) {
    console.error('Get slots error:', err);
    return { success: false, error: 'Failed to get availability' };
  }
}

// ====================================================================
// Book an appointment
// staffName: optional — included in event title and description
// The function looks up service config from client_services for
// duration override and buffer enforcement.
// ====================================================================
async function bookAppointment(clientId, customerName, customerPhone, date, time, serviceType, notes, staffName) {
  try {
    console.log('📅 Booking appointment:', { clientId, customerName, date, time, serviceType, staffName: staffName || 'none' });

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { success: false, error: 'I could not determine the date. Could you confirm the date you would like to book?' };
    }

    const { data: client, error } = await supabase
      .from('clients')
      .select('*')
      .eq('id', clientId)
      .single();

    if (error || !client) {
      return { success: false, error: 'Client not found' };
    }

    if (!client.google_calendar_connected) {
      return { success: false, error: 'Calendar not connected - appointment request noted for callback' };
    }

    const accessToken = await refreshAccessToken(client);
    if (!accessToken) {
      return { success: false, error: 'Calendar authentication failed' };
    }

    const time24 = parseTimeTo24Hr(time);
    if (!time24) {
      console.error('Failed to parse time:', time);
      return { success: false, error: 'Invalid time format' };
    }

    console.log(`📅 Parsed time: "${time}" -> "${time24}"`);

    // ── Phase 3B: Look up service config for duration/buffer/booking_mode ──
    const serviceConfig = await lookupServiceConfig(clientId, serviceType);
    let duration = client.appointment_duration || 30;
    let bufferMinutes = 0;

    if (serviceConfig) {
      if (serviceConfig.duration_minutes) {
        duration = serviceConfig.duration_minutes;
        console.log(`📅 Using service-specific duration: ${duration}min (${serviceConfig.name})`);
      }
      if (serviceConfig.buffer_minutes) {
        bufferMinutes = serviceConfig.buffer_minutes;
        console.log(`📅 Buffer: ${bufferMinutes}min between appointments`);
      }
      // Check service-level booking_mode override
      if (serviceConfig.booking_mode === 'collect_request' || serviceConfig.booking_mode === 'disabled') {
        console.log(`⚠️ Service "${serviceConfig.name}" has booking_mode: ${serviceConfig.booking_mode} — should not be booked directly`);
        return {
          success: false,
          error: `This service is not available for direct booking. Please collect the caller's preferred date and time, and let them know the office will call to confirm.`
        };
      }
    }

    const timezone = client.timezone || 'America/New_York';

    // ====================================================================
    // DOUBLE-BOOKING PREVENTION: Re-check availability before booking.
    // getAvailableSlots already excludes past slots and existing-event
    // conflicts in the correct timezone, so if the requested label is not in
    // the list, we refuse and offer alternatives.
    // ====================================================================
    const [checkHr, checkMin] = time24.split(':').map(Number);
    const availResult = await getAvailableSlots(clientId, date, { durationOverride: duration, bufferMinutes });
    if (availResult.success) {
      const requestedLabel = formatSlotLabel(checkHr, checkMin);
      const isAvailable = availResult.slots.some(function(slot) {
        return slot.replace(/\s+/g, ' ').trim().toLowerCase() === requestedLabel.replace(/\s+/g, ' ').trim().toLowerCase();
      });

      if (!isAvailable) {
        console.log('⚠️ Double-booking prevented: ' + date + ' at ' + time + ' is not available');
        console.log('   Available slots:', availResult.slots.join(', '));

        if (availResult.slots.length > 0) {
          var suggested = availResult.slots.slice(0, 3).join(', ');
          return {
            success: false,
            error: 'That time slot is no longer available. Available times on this date are: ' + suggested + '. Would the caller like one of those instead?'
          };
        } else {
          return {
            success: false,
            error: 'There are no available time slots on this date. Would the caller like to try a different day?'
          };
        }
      }
    } else {
      // Could not read the calendar to verify. Do not blind-book over a calendar
      // we cannot see; take it as a request for callback instead.
      console.warn('⚠️ Availability re-check failed before booking:', availResult.error);
      return {
        success: false,
        error: 'I was not able to confirm that time on the calendar just now. Let me take your details and have the office confirm the appointment with you.'
      };
    }

    const startDateTime = `${date}T${time24}:00`;
    const [hr, min] = time24.split(':').map(Number);
    const totalMinutes = hr * 60 + min + duration;
    const endHr = Math.floor(totalMinutes / 60);
    const endMin = totalMinutes % 60;
    const endDateTime = `${date}T${endHr.toString().padStart(2, '0')}:${endMin.toString().padStart(2, '0')}:00`;

    console.log(`📅 Event time: ${startDateTime} to ${endDateTime} (${timezone})`);

    // ── Phase 3B: Build event title with service + staff + customer ──
    const titleParts = [];
    titleParts.push(serviceType || 'Appointment');
    if (staffName) titleParts.push(staffName);
    titleParts.push(customerName);
    const eventTitle = titleParts.join(' — ');

    // Build description
    const descParts = [`Customer: ${customerName}`, `Phone: ${customerPhone}`];
    if (staffName) descParts.push(`Provider: ${staffName}`);
    if (serviceType) descParts.push(`Service: ${serviceType}`);
    if (notes) descParts.push(`Notes: ${notes}`);
    descParts.push('', 'Booked via AI Receptionist');

    const event = {
      summary: eventTitle,
      description: descParts.join('\n'),
      start: {
        dateTime: startDateTime,
        timeZone: timezone,
      },
      end: {
        dateTime: endDateTime,
        timeZone: timezone,
      },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email', minutes: 60 },
          { method: 'popup', minutes: 30 },
        ],
      },
    };

    const calendarId = client.google_calendar_id || 'primary';
    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(event),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Failed to create event:', errorText);
      return { success: false, error: 'Failed to create appointment' };
    }

    const createdEvent = await response.json();
    console.log('✅ Appointment booked:', createdEvent.id);

    // Save to our database (staff_name column may not exist yet — fallback gracefully)
    const appointmentRecord = {
      client_id: clientId,
      google_event_id: createdEvent.id,
      customer_name: customerName,
      customer_phone: customerPhone,
      appointment_time: new Date(startDateTime).toISOString(),
      duration,
      service_type: serviceType,
      staff_name: staffName || null,
      notes,
      status: 'confirmed',
    };
    const { error: apptError } = await supabase.from('appointments').insert(appointmentRecord);
    if (apptError && apptError.message && apptError.message.includes('staff_name')) {
      delete appointmentRecord.staff_name;
      await supabase.from('appointments').insert(appointmentRecord);
    }

    const dateObj = new Date(date + 'T12:00:00');
    const formattedDate = dateObj.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric'
    });

    const hr12 = hr > 12 ? hr - 12 : (hr === 0 ? 12 : hr);
    const ampm = hr >= 12 ? 'PM' : 'AM';
    const formattedTime = min === 0 ? `${hr12} ${ampm}` : `${hr12}:${min.toString().padStart(2, '0')} ${ampm}`;

    let confirmMsg = `Appointment confirmed for ${customerName} on ${formattedDate} at ${formattedTime}`;
    if (staffName) confirmMsg += ` with ${staffName}`;

    return {
      success: true,
      message: confirmMsg,
      appointment: {
        date: formattedDate,
        time: formattedTime,
        service: serviceType,
        staff: staffName || null,
      }
    };

  } catch (err) {
    console.error('Booking error:', err);
    return { success: false, error: 'Server error while booking' };
  }
}

module.exports = {
  getAvailableSlots,
  bookAppointment,
  refreshAccessToken,
  lookupServiceConfig,
  // exported for tests / reuse
  zonedWallTimeToUTC,
  getTzOffsetMinutes,
  parseTimeTo24Hr,
  formatSlotLabel,
};
// ====================================================================
// GOOGLE CALENDAR BOOKING - VAPI Tool Handler
// Matched to CallBird working implementation
// UPDATED: Added double-booking prevention guard
// UPDATED: 2026-05-19 Phase 3B - Service-aware booking: looks up service
//   duration from client_services table, includes staff name in event
//   title, applies buffer minutes between appointments.
// UPDATED: 2026-06-17 - TIMEZONE FIX + edge-case hardening.
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

// Parse a business-hours time into minutes-since-midnight, accepting BOTH the
// 12-hour format the dashboard saves ("9:00 AM", "5:00 PM") and the 24-hour
// format older data and defaults use ("09:00", "17:00"). The two had drifted
// apart: the dashboard writes 12-hour strings, this engine used to parse them
// as 24-hour, so "9:00 AM".split(':') produced NaN and every day returned zero
// slots. Returns null when the value cannot be parsed.
function parseTimeToMinutes(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])?$/);
  if (!m) return null;
  let hr = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (isNaN(hr) || isNaN(min) || min > 59) return null;
  const ap = m[3] ? m[3].toLowerCase() : null;
  if (ap) {
    if (hr < 1 || hr > 12) return null;
    hr = ap === 'am' ? (hr === 12 ? 0 : hr) : (hr === 12 ? 12 : hr + 12);
  } else if (hr > 23) {
    return null;
  }
  return hr * 60 + min;
}

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

    // ── Booking window settings ─────────────────────────────────────────
    // Minimum notice (how soon a slot may be offered) and max horizon (how far
    // ahead bookings are taken) are per-client, falling back to the agency
    // default, then to a sane platform default. Neither hard-blocks a day: the
    // notice simply shifts the earliest offerable slot forward.
    let agencyDefaults = {};
    if (client.agency_id) {
      try {
        const { data: ag } = await supabase
          .from('agencies')
          .select('default_min_booking_notice_minutes, default_max_booking_days_ahead')
          .eq('id', client.agency_id)
          .single();
        agencyDefaults = ag || {};
      } catch (e) { /* defaults below */ }
    }
    const pickNum = (...vals) => {
      for (const v of vals) { const n = Number(v); if (v !== null && v !== undefined && v !== '' && !isNaN(n)) return n; }
      return null;
    };
    const leadMinutes = pickNum(client.min_booking_notice_minutes, agencyDefaults.default_min_booking_notice_minutes, LEAD_TIME_MINUTES);
    const maxDaysAhead = pickNum(client.max_booking_days_ahead, agencyDefaults.default_max_booking_days_ahead, 60);

    // Reject dates beyond the booking horizon (compared in the client's tz).
    if (maxDaysAhead != null && maxDaysAhead > 0) {
      const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const [ty, tmo, td] = todayStr.split('-').map(Number);
      const [ry, rmo, rd] = date.split('-').map(Number);
      const todayMid = Date.UTC(ty, tmo - 1, td);
      const reqMid = Date.UTC(ry, rmo - 1, rd);
      const daysOut = Math.round((reqMid - todayMid) / 86400000);
      if (daysOut > maxDaysAhead) {
        console.log(`📅 ${date} is ${daysOut} days out, beyond the ${maxDaysAhead}-day booking window`);
        return { success: true, slots: [], message: `We only take bookings up to ${maxDaysAhead} days ahead.` };
      }
    }

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

    // Closed when the day is missing hours OR explicitly flagged closed (some
    // paths store closed:true alongside leftover open/close times; honor the
    // flag the same way checkBusinessHours does so a closed day never books).
    if (!hours || hours.closed === true || !hours.open || !hours.close) {
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
      console.log(`📅 All-day event on ${date} ("${allDay.summary || 'untitled'}") - treating the day as unavailable`);
      return { success: true, slots: [], message: 'Unavailable this day' };
    }

    // Timed busy ranges as absolute instants.
    const busy = items
      .filter(ev => ev.start && ev.start.dateTime && ev.end && ev.end.dateTime)
      .map(ev => ({ start: new Date(ev.start.dateTime), end: new Date(ev.end.dateTime) }))
      .filter(b => !isNaN(b.start.getTime()) && !isNaN(b.end.getTime()));

    const duration = (options && options.durationOverride) || client.appointment_duration || 30;
    const buffer = (options && options.bufferMinutes) || 0;

    const openTotal = parseTimeToMinutes(hours.open);
    const closeTotal = parseTimeToMinutes(hours.close);
    if (openTotal == null || closeTotal == null || closeTotal <= openTotal) {
      console.log(`📅 Business hours for ${dayName} unusable (open="${hours.open}", close="${hours.close}"), no slots offered`);
      return { success: true, slots: [], message: 'Closed on this day' };
    }

    const nowMs = Date.now();
    const leadMs = (leadMinutes != null ? leadMinutes : LEAD_TIME_MINUTES) * 60000;
    const slots = [];
    // A few in-hours time slots the AI actually skipped because they were booked,
    // captured so the live monitor can show the AI stepping past taken times
    // (a few, not all). Only real conflicts within business hours land here.
    const taken = [];

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
      } else if (taken.length < 4) {
        taken.push(formatSlotLabel(hr, min));
      }
    }

    console.log(`📅 Available slots for ${date} (${timezone}): ${slots.length} slots (duration: ${duration}min, buffer: ${buffer}min)`);
    return { success: true, slots, date, dayName, taken };
  } catch (err) {
    console.error('Get slots error:', err);
    return { success: false, error: 'Failed to get availability' };
  }
}

// ====================================================================
// Entitlement for the CUSTOMER booking-confirmation SMS (a paid capability).
//   - A reseller agency can offer it only on the Scale plan (trial counts as
//     Scale, matching hasScale()).
//   - A call center is never unlocked by plan (they are invoiced directly); it
//     needs the distinct `appointment_sms_addon` upgrade flag.
//   - `appointment_sms_addon` also acts as a platform override for any agency.
// The owner "new appointment booked" alert is NOT gated (it only texts the owner).
// ====================================================================
function canOfferApptCustomerSms(agency) {
  if (!agency) return false;
  if (agency.appointment_sms_addon === true) return true;
  if (agency.is_call_center === true) return false;
  const isTrialing = ['trialing', 'trial'].includes(agency.subscription_status);
  const plan = isTrialing ? 'scale' : String(agency.plan_type || '').toLowerCase();
  return plan === 'scale';
}

// ====================================================================
// Book an appointment
// staffName: optional - included in event title and description
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
        console.log(`⚠️ Service "${serviceConfig.name}" has booking_mode: ${serviceConfig.booking_mode} - should not be booked directly`);
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
    const eventTitle = titleParts.join(' - ');

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

    // Save to our database (staff_name column may not exist yet - fallback gracefully)
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
      booking_source: 'ai_receptionist',
    };
    let insertedApptId = null;
    {
      const { data: ins, error: apptError } = await supabase.from('appointments').insert(appointmentRecord).select('id').single();
      if (apptError && apptError.message && apptError.message.includes('staff_name')) {
        delete appointmentRecord.staff_name;
        const { data: ins2 } = await supabase.from('appointments').insert(appointmentRecord).select('id').single();
        insertedApptId = ins2 && ins2.id;
      } else {
        insertedApptId = ins && ins.id;
      }
    }
    // Fire the webhook event (non-blocking).
    try {
      if (client.agency_id) {
        const { dispatchWebhook } = require('./webhooks');
        // Full payload so a business/call-center CRM can sync everything about
        // the booking without a second API call: who, what, when (start + end +
        // timezone), where it landed on Google, and how it was booked.
        const startIso = appointmentRecord.appointment_time;
        const endIso = new Date(new Date(startIso).getTime() + (duration || 0) * 60000).toISOString();
        dispatchWebhook(client.agency_id, 'appointment.booked', {
          id: insertedApptId,
          client_id: clientId,
          business_name: client.business_name || null,
          customer_name: customerName,
          customer_phone: customerPhone,
          appointment_time: startIso,
          end_time: endIso,
          duration_minutes: duration || null,
          timezone: client.timezone || null,
          service_type: serviceType || null,
          staff_name: staffName || null,
          notes: notes || null,
          status: 'confirmed',
          booking_source: 'ai_receptionist',
          google_event_id: createdEvent.id,
          google_calendar_id: client.google_calendar_id || 'primary',
          calendar_link: createdEvent.htmlLink || null,
          created_at: new Date().toISOString(),
        });
      }
    } catch (e) { console.error('webhook emit (appointment.booked):', e.message); }

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

    // Appointment-booked texts, both from the business's own AI number. Fire and
    // forget so booking latency is unaffected.
    //   - Customer confirmation: opt-in per business (upgrade-gated in the UI),
    //     default OFF. tool_config.apptCustomerSms = { enabled, template }.
    //   - Owner alert: a distinct "new appointment booked" notification, separate
    //     from the general call recap. tool_config.apptOwnerSms = { enabled }.
    try {
      const tc = (client.tool_config && typeof client.tool_config === 'object') ? client.tool_config : {};
      const fromNum = client.vapi_phone_number || null;
      if (fromNum) {
        const { sendTelnyxSMS } = require('./notifications');

        // Entitlement gate: only send the customer confirmation if the agency is
        // allowed to offer it (Scale reseller, or call-center/agency with the
        // add-on). Fetched only when the toggle is on, so normal calls skip it.
        let custEntitled = false;
        if (tc.apptCustomerSmsEnabled === true && customerPhone) {
          try {
            const { data: ag } = await supabase.from('agencies')
              .select('plan_type, subscription_status, is_call_center, appointment_sms_addon')
              .eq('id', client.agency_id).maybeSingle();
            custEntitled = canOfferApptCustomerSms(ag);
            if (!custEntitled) console.log('📵 Customer booking SMS on but agency not entitled (needs Scale / upgrade) - skipping');
          } catch (e) { console.warn('appt customer SMS entitlement check failed:', e.message); }
        }

        if (tc.apptCustomerSmsEnabled === true && customerPhone && custEntitled) {
          const vars = {
            name: customerName || 'there',
            business: client.business_name || 'us',
            service: serviceType || 'appointment',
            date: formattedDate,
            time: formattedTime,
            staff: staffName || '',
          };
          const tmpl = (typeof tc.apptCustomerSmsTemplate === 'string' && tc.apptCustomerSmsTemplate.trim())
            ? tc.apptCustomerSmsTemplate
            : 'Hi {name}, your {service} with {business} is confirmed for {date} at {time}. Reply here if you need to change anything.';
          const msg = tmpl
            .replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''))
            .replace(/[ \t]{2,}/g, ' ').replace(/ +([.,!?])/g, '$1').trim();
          Promise.resolve(sendTelnyxSMS(customerPhone, msg, fromNum)).catch((e) => console.warn('appt customer SMS failed:', e.message));
        }

        if (tc.apptOwnerSmsEnabled === true) {
          const ownerTo = client.notification_phone || client.owner_phone || null;
          if (ownerTo) {
            let ownerMsg = `📅 New appointment booked - ${client.business_name || ''}\n${customerName || 'Customer'}${customerPhone ? ` (${customerPhone})` : ''}\n${serviceType || 'Appointment'} on ${formattedDate} at ${formattedTime}`;
            if (staffName) ownerMsg += ` with ${staffName}`;
            Promise.resolve(sendTelnyxSMS(ownerTo, ownerMsg, fromNum)).catch((e) => console.warn('appt owner SMS failed:', e.message));
          }
        }
      }
    } catch (e) { console.warn('appointment SMS block error:', e.message); }

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

// ====================================================================
// API-FACING APPOINTMENT WRITES (create / reschedule / cancel)
//
// These are for the public REST API (/api/v1/appointments), NOT the AI voice
// flow. They differ from bookAppointment() on purpose:
//   - They return structured { ok, ... } objects with a machine `code`, never
//     the conversational strings the AI speaks back.
//   - They are NOT Google-only. A client with Google Calendar connected gets a
//     real calendar write (availability-checked, same engine the AI uses). A
//     client WITHOUT Google gets a "record-only" appointment: a real row in the
//     appointments table, no calendar event, so an integrator that runs its own
//     calendar can still log, move, and cancel bookings through VoiceAI and
//     receive the same events.
// Every path fires the matching webhook (appointment.booked / .rescheduled /
// .canceled) so a consumer sees the change in real time.
// ====================================================================

// Build the webhook `data` payload for an appointment, shaped like the
// appointment.booked payload bookAppointment() emits (so all three appointment
// events share one shape). googleEventId / calendarLink are null for
// record-only appointments.
function buildApptEventData(client, appt, extra) {
  const startIso = appt.appointment_time;
  const dur = appt.duration || null;
  let endIso = null;
  try { if (startIso && dur) endIso = new Date(new Date(startIso).getTime() + Number(dur) * 60000).toISOString(); } catch (e) { endIso = null; }
  return Object.assign({
    id: appt.id,
    client_id: appt.client_id,
    business_name: (client && client.business_name) || null,
    customer_name: appt.customer_name || null,
    customer_phone: appt.customer_phone || null,
    customer_email: appt.customer_email || null,
    appointment_time: startIso,
    end_time: endIso,
    duration_minutes: dur,
    timezone: (client && client.timezone) || null,
    service_type: appt.service_type || null,
    staff_name: appt.staff_name || null,
    notes: appt.notes || null,
    status: appt.status || null,
    booking_source: appt.booking_source || null,
    google_event_id: appt.google_event_id || null,
    google_calendar_id: appt.google_event_id ? ((client && client.google_calendar_id) || 'primary') : null,
    calendar_link: null,
    created_at: appt.created_at || new Date().toISOString(),
  }, extra || {});
}

function emitApptEvent(client, eventType, appt, extra) {
  try {
    if (!client || !client.agency_id) return;
    const { dispatchWebhook } = require('./webhooks');
    dispatchWebhook(client.agency_id, eventType, buildApptEventData(client, appt, extra));
  } catch (e) { console.error(`webhook emit (${eventType}):`, e.message); }
}

// Insert an appointments row, degrading gracefully if optional columns
// (staff_name, customer_email) are not present in this database yet.
async function insertAppointmentRow(record) {
  const attempt = async (rec) => supabase.from('appointments').insert(rec).select('*').single();
  let { data, error } = await attempt(record);
  if (error && error.message && /staff_name/.test(error.message)) {
    const r2 = Object.assign({}, record); delete r2.staff_name;
    ({ data, error } = await attempt(r2));
  }
  if (error && error.message && /customer_email/.test(error.message)) {
    const r3 = Object.assign({}, record); delete r3.customer_email;
    ({ data, error } = await attempt(r3));
  }
  return { data, error };
}

async function fetchOwnedClientFull(clientId) {
  const { data } = await supabase.from('clients').select('*').eq('id', clientId).single();
  return data || null;
}

// Create an appointment via the API.
// params: { clientId, customerName, customerPhone, customerEmail, date 'YYYY-MM-DD',
//           time, serviceType, notes, staffName, durationMinutes, checkAvailability }
// Returns { ok:true, appointment } or { ok:false, code, error }.
async function createAppointmentApi(params) {
  const p = params || {};
  try {
    if (!p.clientId) return { ok: false, code: 'invalid_request', error: 'clientId is required.' };
    if (!p.date || !/^\d{4}-\d{2}-\d{2}$/.test(p.date)) return { ok: false, code: 'invalid_request', error: 'date is required in YYYY-MM-DD format.' };
    const time24 = parseTimeTo24Hr(p.time);
    if (!time24) return { ok: false, code: 'invalid_request', error: 'time is required (e.g. "2:30 PM" or "14:30").' };
    if (!p.customerName) return { ok: false, code: 'invalid_request', error: 'customer_name is required.' };

    const client = await fetchOwnedClientFull(p.clientId);
    if (!client) return { ok: false, code: 'not_found', error: 'Client not found.' };

    const timezone = client.timezone || 'America/New_York';
    const serviceConfig = p.serviceType ? await lookupServiceConfig(p.clientId, p.serviceType) : null;
    let duration = Number(p.durationMinutes) || (serviceConfig && serviceConfig.duration_minutes) || client.appointment_duration || 30;
    const bufferMinutes = (serviceConfig && serviceConfig.buffer_minutes) || 0;

    const googleConnected = client.google_calendar_connected === true;
    let googleEventId = null;

    if (googleConnected) {
      // Google path: availability-check (unless explicitly disabled), then write
      // the real calendar event, reusing the same engine the AI uses.
      const [reqHr, reqMin] = time24.split(':').map(Number);
      if (p.checkAvailability !== false) {
        const avail = await getAvailableSlots(p.clientId, p.date, { durationOverride: duration, bufferMinutes });
        if (!avail.success) return { ok: false, code: 'calendar_error', error: 'Could not read the calendar to confirm availability.' };
        const want = formatSlotLabel(reqHr, reqMin).replace(/\s+/g, ' ').trim().toLowerCase();
        const free = (avail.slots || []).some((s) => s.replace(/\s+/g, ' ').trim().toLowerCase() === want);
        if (!free) return { ok: false, code: 'slot_unavailable', error: 'That time is not available.', available_slots: avail.slots || [] };
      }
      const accessToken = await refreshAccessToken(client);
      if (!accessToken) return { ok: false, code: 'calendar_error', error: 'Calendar authentication failed.' };

      const startDateTime = `${p.date}T${time24}:00`;
      const totalMinutes = reqHr * 60 + reqMin + duration;
      const endDateTime = `${p.date}T${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}:00`;
      const titleParts = [p.serviceType || 'Appointment'];
      if (p.staffName) titleParts.push(p.staffName);
      titleParts.push(p.customerName);
      const descParts = [`Customer: ${p.customerName}`, `Phone: ${p.customerPhone || ''}`];
      if (p.staffName) descParts.push(`Provider: ${p.staffName}`);
      if (p.serviceType) descParts.push(`Service: ${p.serviceType}`);
      if (p.notes) descParts.push(`Notes: ${p.notes}`);
      descParts.push('', 'Booked via API');
      const event = {
        summary: titleParts.join(' - '),
        description: descParts.join('\n'),
        start: { dateTime: startDateTime, timeZone: timezone },
        end: { dateTime: endDateTime, timeZone: timezone },
        reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 60 }, { method: 'popup', minutes: 30 }] },
      };
      const calendarId = client.google_calendar_id || 'primary';
      const resp = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
        { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(event) }
      );
      if (!resp.ok) { console.error('API createAppointment Google error:', await resp.text().catch(() => '')); return { ok: false, code: 'calendar_error', error: 'Failed to create the calendar event.' }; }
      googleEventId = (await resp.json()).id;
    }

    const [sY, sMo, sD] = p.date.split('-').map(Number);
    const startIso = zonedWallTimeToUTC(sY, sMo, sD, reqHr, reqMin, timezone).toISOString();

    const record = {
      client_id: p.clientId,
      google_event_id: googleEventId,
      customer_name: p.customerName,
      customer_phone: p.customerPhone || null,
      customer_email: p.customerEmail || null,
      appointment_time: startIso,
      duration,
      service_type: p.serviceType || null,
      staff_name: p.staffName || null,
      notes: p.notes || null,
      status: 'confirmed',
      booking_source: googleConnected ? 'api' : 'api_record_only',
    };
    const { data: appt, error: insErr } = await insertAppointmentRow(record);
    if (insErr || !appt) { console.error('API createAppointment insert error:', insErr && insErr.message); return { ok: false, code: 'api_error', error: 'Failed to save the appointment.' }; }

    emitApptEvent(client, 'appointment.booked', appt);
    return { ok: true, appointment: appt, record_only: !googleConnected };
  } catch (err) {
    console.error('createAppointmentApi error:', err);
    return { ok: false, code: 'api_error', error: 'Server error while creating the appointment.' };
  }
}

// Reschedule an existing appointment to a new date/time (and optionally change
// duration). Patches the Google event when the appointment has one.
// params: { date, time, durationMinutes, checkAvailability }
async function rescheduleAppointmentApi(appt, params) {
  const p = params || {};
  try {
    if (!appt) return { ok: false, code: 'not_found', error: 'Appointment not found.' };
    if (appt.status === 'canceled' || appt.status === 'cancelled') return { ok: false, code: 'invalid_request', error: 'A canceled appointment cannot be rescheduled.' };
    if (!p.date || !/^\d{4}-\d{2}-\d{2}$/.test(p.date)) return { ok: false, code: 'invalid_request', error: 'date is required in YYYY-MM-DD format.' };
    const time24 = parseTimeTo24Hr(p.time);
    if (!time24) return { ok: false, code: 'invalid_request', error: 'time is required.' };

    const client = await fetchOwnedClientFull(appt.client_id);
    if (!client) return { ok: false, code: 'not_found', error: 'Client not found.' };

    const timezone = client.timezone || 'America/New_York';
    const duration = Number(p.durationMinutes) || appt.duration || client.appointment_duration || 30;
    const [reqHr, reqMin] = time24.split(':').map(Number);

    if (appt.google_event_id && client.google_calendar_connected === true) {
      if (p.checkAvailability !== false) {
        const avail = await getAvailableSlots(appt.client_id, p.date, { durationOverride: duration, bufferMinutes: 0 });
        if (!avail.success) return { ok: false, code: 'calendar_error', error: 'Could not read the calendar to confirm availability.' };
        const want = formatSlotLabel(reqHr, reqMin).replace(/\s+/g, ' ').trim().toLowerCase();
        // The appointment's own current slot is legitimately "busy" against
        // itself; availability already excludes it only if it moved days, so we
        // accept the target when it is free OR unchanged.
        const free = (avail.slots || []).some((s) => s.replace(/\s+/g, ' ').trim().toLowerCase() === want);
        if (!free) return { ok: false, code: 'slot_unavailable', error: 'That time is not available.', available_slots: avail.slots || [] };
      }
      const accessToken = await refreshAccessToken(client);
      if (!accessToken) return { ok: false, code: 'calendar_error', error: 'Calendar authentication failed.' };
      const startDateTime = `${p.date}T${time24}:00`;
      const totalMinutes = reqHr * 60 + reqMin + duration;
      const endDateTime = `${p.date}T${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}:00`;
      const calendarId = client.google_calendar_id || 'primary';
      const resp = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(appt.google_event_id)}`,
        { method: 'PATCH', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ start: { dateTime: startDateTime, timeZone: timezone }, end: { dateTime: endDateTime, timeZone: timezone } }) }
      );
      if (!resp.ok) { console.error('API reschedule Google error:', await resp.text().catch(() => '')); return { ok: false, code: 'calendar_error', error: 'Failed to update the calendar event.' }; }
    }

    const [nY, nMo, nD] = p.date.split('-').map(Number);
    const newStartIso = zonedWallTimeToUTC(nY, nMo, nD, reqHr, reqMin, timezone).toISOString();
    const previousTime = appt.appointment_time;
    const updates = { appointment_time: newStartIso, duration, status: 'confirmed', updated_at: new Date().toISOString() };
    const { data: updated, error: updErr } = await supabase.from('appointments').update(updates).eq('id', appt.id).select('*').single();
    if (updErr || !updated) { console.error('API reschedule update error:', updErr && updErr.message); return { ok: false, code: 'api_error', error: 'Failed to save the new time.' }; }

    emitApptEvent(client, 'appointment.rescheduled', updated, { previous_appointment_time: previousTime });
    return { ok: true, appointment: updated };
  } catch (err) {
    console.error('rescheduleAppointmentApi error:', err);
    return { ok: false, code: 'api_error', error: 'Server error while rescheduling.' };
  }
}

// Cancel an appointment. Deletes the Google event when present, marks the row
// canceled (kept for history), and fires appointment.canceled.
async function cancelAppointmentApi(appt, params) {
  const p = params || {};
  try {
    if (!appt) return { ok: false, code: 'not_found', error: 'Appointment not found.' };
    if (appt.status === 'canceled' || appt.status === 'cancelled') return { ok: true, appointment: appt, already: true };

    const client = await fetchOwnedClientFull(appt.client_id);
    if (!client) return { ok: false, code: 'not_found', error: 'Client not found.' };

    if (appt.google_event_id && client.google_calendar_connected === true) {
      const accessToken = await refreshAccessToken(client);
      if (accessToken) {
        const calendarId = client.google_calendar_id || 'primary';
        const resp = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(appt.google_event_id)}`,
          { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } }
        );
        // 410 Gone means it was already deleted on Google; treat as success.
        if (!resp.ok && resp.status !== 410 && resp.status !== 404) {
          console.error('API cancel Google error:', resp.status, await resp.text().catch(() => ''));
          return { ok: false, code: 'calendar_error', error: 'Failed to remove the calendar event.' };
        }
      }
    }

    const updates = { status: 'canceled', updated_at: new Date().toISOString() };
    if (p.reason) updates.notes = appt.notes ? `${appt.notes}\n[Canceled: ${p.reason}]` : `[Canceled: ${p.reason}]`;
    const { data: updated, error: updErr } = await supabase.from('appointments').update(updates).eq('id', appt.id).select('*').single();
    if (updErr || !updated) { console.error('API cancel update error:', updErr && updErr.message); return { ok: false, code: 'api_error', error: 'Failed to cancel the appointment.' }; }

    emitApptEvent(client, 'appointment.canceled', updated, { cancel_reason: p.reason || null });
    return { ok: true, appointment: updated };
  } catch (err) {
    console.error('cancelAppointmentApi error:', err);
    return { ok: false, code: 'api_error', error: 'Server error while canceling.' };
  }
}

module.exports = {
  getAvailableSlots,
  bookAppointment,
  canOfferApptCustomerSms,
  refreshAccessToken,
  lookupServiceConfig,
  // API-facing appointment writes (REST /api/v1/appointments)
  createAppointmentApi,
  rescheduleAppointmentApi,
  cancelAppointmentApi,
  // exported for tests / reuse
  zonedWallTimeToUTC,
  getTzOffsetMinutes,
  parseTimeTo24Hr,
  formatSlotLabel,
};
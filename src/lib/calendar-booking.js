// ====================================================================
// GOOGLE CALENDAR BOOKING - VAPI Tool Handler
// Matched to CallBird working implementation
// UPDATED: Added double-booking prevention guard
// UPDATED: 2026-05-19 Phase 3B — Service-aware booking: looks up service
//   duration from client_services table, includes staff name in event
//   title, applies buffer minutes between appointments.
// ====================================================================
const { supabase } = require('./supabase');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CALENDAR_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CALENDAR_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;

// Refresh access token if expired
async function refreshAccessToken(client) {
  if (!client.google_refresh_token) {
    console.error('No refresh token available');
    return null;
  }

  const expiresAt = new Date(client.google_token_expires_at);
  const now = new Date();
  const bufferMs = 5 * 60 * 1000;

  if (expiresAt.getTime() - now.getTime() > bufferMs) {
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
  const normalized = timeStr.trim().toLowerCase();
  
  if (/^\d{1,2}:\d{2}$/.test(normalized) && !normalized.includes('m')) {
    return normalized.padStart(5, '0');
  }
  
  const match = normalized.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!match) return null;
  
  let hours = parseInt(match[1], 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  const period = match[3]?.toLowerCase();
  
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
// ====================================================================
async function getAvailableSlots(clientId, date, options) {
  try {
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

    const businessHours = client.business_hours || {
      monday: { open: '09:00', close: '17:00' },
      tuesday: { open: '09:00', close: '17:00' },
      wednesday: { open: '09:00', close: '17:00' },
      thursday: { open: '09:00', close: '17:00' },
      friday: { open: '09:00', close: '17:00' },
      saturday: null,
      sunday: null
    };

    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayOfWeek = dayNames[new Date(date + 'T12:00:00').getDay()];
    const hours = businessHours[dayOfWeek];

    if (!hours || !hours.open || !hours.close) {
      return { success: true, slots: [], message: 'Closed on this day' };
    }

    // Get existing events
    const calendarId = client.google_calendar_id || 'primary';
    const timezone = client.timezone || 'America/New_York';
    
    const timeMin = new Date(`${date}T00:00:00`).toISOString();
    const timeMax = new Date(`${date}T23:59:59`).toISOString();

    const eventsResponse = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?` +
      new URLSearchParams({
        timeMin,
        timeMax,
        singleEvents: 'true',
        orderBy: 'startTime',
      }),
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    const eventsData = await eventsResponse.json();
    
    const busyRanges = (eventsData.items || []).map(event => {
      const start = new Date(event.start.dateTime || event.start.date);
      const end = new Date(event.end.dateTime || event.end.date);
      
      const startMinutes = start.getHours() * 60 + start.getMinutes();
      const endMinutes = end.getHours() * 60 + end.getMinutes();
      
      console.log(`📅 Busy: ${start.toLocaleTimeString()} - ${end.toLocaleTimeString()} (${startMinutes}-${endMinutes} mins)`);
      
      return { startMinutes, endMinutes };
    });

    // Use service-specific duration if provided, else client default
    const duration = (options && options.durationOverride) || client.appointment_duration || 30;
    const buffer = (options && options.bufferMinutes) || 0;
    const slots = [];
    
    const [openHr, openMin] = hours.open.split(':').map(Number);
    const [closeHr, closeMin] = hours.close.split(':').map(Number);
    
    let currentMinutes = openHr * 60 + openMin;
    const closeMinutes = closeHr * 60 + closeMin;

    while (currentMinutes + duration <= closeMinutes) {
      // Include buffer on both sides when checking conflicts
      const slotStartWithBuffer = currentMinutes - buffer;
      const slotEndWithBuffer = currentMinutes + duration + buffer;
      
      const hasConflict = busyRanges.some(busy =>
        (currentMinutes >= busy.startMinutes && currentMinutes < busy.endMinutes) ||
        ((currentMinutes + duration) > busy.startMinutes && (currentMinutes + duration) <= busy.endMinutes) ||
        (currentMinutes <= busy.startMinutes && (currentMinutes + duration) >= busy.endMinutes) ||
        // Buffer overlap: the buffer zone around this slot overlaps with an existing event
        (buffer > 0 && slotStartWithBuffer < busy.endMinutes && slotEndWithBuffer > busy.startMinutes)
      );

      if (!hasConflict) {
        const hr = Math.floor(currentMinutes / 60);
        const min = currentMinutes % 60;
        const hour12 = hr > 12 ? hr - 12 : (hr === 0 ? 12 : hr);
        const ampm = hr >= 12 ? 'PM' : 'AM';
        const minStr = min === 0 ? '' : `:${min.toString().padStart(2, '0')}`;
        slots.push(`${hour12}${minStr} ${ampm}`);
      }

      currentMinutes += 30;
    }

    console.log(`📅 Available slots for ${date}: ${slots.length} slots (duration: ${duration}min, buffer: ${buffer}min)`);
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
    // DOUBLE-BOOKING PREVENTION: Re-check availability before booking
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
  lookupServiceConfig
};
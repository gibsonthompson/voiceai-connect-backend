// ====================================================================
// GOOGLE CALENDAR BOOKING - VAPI Tool Handler
// Matched to CallBird working implementation
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
  
  // Already 24hr format
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

// Get available time slots
async function getAvailableSlots(clientId, date) {
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

    const duration = client.appointment_duration || 30;
    const slots = [];
    
    const [openHr, openMin] = hours.open.split(':').map(Number);
    const [closeHr, closeMin] = hours.close.split(':').map(Number);
    
    let currentMinutes = openHr * 60 + openMin;
    const closeMinutes = closeHr * 60 + closeMin;

    while (currentMinutes + duration <= closeMinutes) {
      const slotEndMinutes = currentMinutes + duration;
      
      const hasConflict = busyRanges.some(busy =>
        (currentMinutes >= busy.startMinutes && currentMinutes < busy.endMinutes) ||
        (slotEndMinutes > busy.startMinutes && slotEndMinutes <= busy.endMinutes) ||
        (currentMinutes <= busy.startMinutes && slotEndMinutes >= busy.endMinutes)
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

    console.log(`📅 Available slots for ${date}: ${slots.length} slots`);
    return { success: true, slots, date };
  } catch (err) {
    console.error('Get slots error:', err);
    return { success: false, error: 'Failed to get availability' };
  }
}

// Book an appointment
async function bookAppointment(clientId, customerName, customerPhone, date, time, serviceType, notes) {
  try {
    console.log('📅 Booking appointment:', { clientId, customerName, date, time, serviceType });

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

    const duration = client.appointment_duration || 30;
    const timezone = client.timezone || 'America/New_York';

    const startDateTime = `${date}T${time24}:00`;
    const [hr, min] = time24.split(':').map(Number);
    const totalMinutes = hr * 60 + min + duration;
    const endHr = Math.floor(totalMinutes / 60);
    const endMin = totalMinutes % 60;
    const endDateTime = `${date}T${endHr.toString().padStart(2, '0')}:${endMin.toString().padStart(2, '0')}:00`;

    console.log(`📅 Event time: ${startDateTime} to ${endDateTime} (${timezone})`);

    const event = {
      summary: `${serviceType || 'Appointment'} - ${customerName}`,
      description: `Customer: ${customerName}\nPhone: ${customerPhone}\n${notes ? `Notes: ${notes}` : ''}\n\nBooked via AI Receptionist`,
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

    // Save to our database
    await supabase.from('appointments').insert({
      client_id: clientId,
      google_event_id: createdEvent.id,
      customer_name: customerName,
      customer_phone: customerPhone,
      appointment_time: new Date(startDateTime).toISOString(),
      duration,
      service_type: serviceType,
      notes,
      status: 'confirmed',
    });

    const dateObj = new Date(date + 'T12:00:00');
    const formattedDate = dateObj.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric'
    });

    const hr12 = hr > 12 ? hr - 12 : (hr === 0 ? 12 : hr);
    const ampm = hr >= 12 ? 'PM' : 'AM';
    const formattedTime = min === 0 ? `${hr12} ${ampm}` : `${hr12}:${min.toString().padStart(2, '0')} ${ampm}`;

    return {
      success: true,
      message: `Appointment confirmed for ${customerName} on ${formattedDate} at ${formattedTime}`,
      appointment: {
        date: formattedDate,
        time: formattedTime,
        service: serviceType
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
  refreshAccessToken
};
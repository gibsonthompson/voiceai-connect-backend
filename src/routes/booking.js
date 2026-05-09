// ============================================================================
// BOOKING SYSTEM — Custom scheduling (replaces Calendly)
// - One-time Google OAuth to authorize calendar access
// - Availability endpoint (checks freebusy)
// - Create booking (Google Calendar event + Meet link + SMS)
// ============================================================================
const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const { supabase } = require('../lib/supabase');
const { sendTelnyxSMS } = require('../lib/notifications');

// ============================================================================
// CONFIG
// ============================================================================
const SLOT_DURATION = 30; // minutes
const BUFFER_MINUTES = 15; // gap between bookable slots and existing events
const TIMEZONE = 'America/New_York';
const NOTIFY_PHONE = process.env.PLATFORM_OWNER_PHONE;

// Business hours (ET) — days 0=Sun, 1=Mon ... 6=Sat
const BUSINESS_HOURS = {
  1: { start: 9, end: 17 }, // Mon
  2: { start: 9, end: 17 }, // Tue
  3: { start: 9, end: 17 }, // Wed
  4: { start: 9, end: 17 }, // Thu
  5: { start: 9, end: 17 }, // Fri
};

// ============================================================================
// GOOGLE OAUTH CLIENT
// ============================================================================
function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.BACKEND_URL}/api/booking/auth/callback`
  );
}

async function getAuthedCalendar() {
  // Fetch stored refresh token from Supabase
  const { data } = await supabase
    .from('platform_settings')
    .select('value')
    .eq('key', 'booking_google_refresh_token')
    .single();

  if (!data?.value) {
    throw new Error('Google Calendar not authorized. Visit /api/booking/auth to connect.');
  }

  const oauth2Client = createOAuthClient();
  oauth2Client.setCredentials({ refresh_token: data.value });

  return google.calendar({ version: 'v3', auth: oauth2Client });
}

// ============================================================================
// ONE-TIME AUTH: GET /api/booking/auth
// Visit this URL once to authorize Google Calendar access
// ============================================================================
router.get('/auth', (req, res) => {
  const oauth2Client = createOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.events',
    ],
  });
  res.redirect(url);
});

// ============================================================================
// AUTH CALLBACK: GET /api/booking/auth/callback
// ============================================================================
router.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing authorization code');

  try {
    const oauth2Client = createOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      return res.status(400).send('No refresh token received. Revoke app access in Google Account settings and try again.');
    }

    // Store refresh token in platform_settings table
    const { error } = await supabase
      .from('platform_settings')
      .upsert({ key: 'booking_google_refresh_token', value: tokens.refresh_token }, { onConflict: 'key' });

    if (error) {
      console.error('Failed to store booking token:', error);
      return res.status(500).send('Failed to save authorization');
    }

    console.log('✅ Booking calendar authorized successfully');
    res.send(`
      <html><body style="font-family:system-ui;padding:40px;background:#050505;color:#fafaf9;">
        <h2 style="color:#10b981;">✅ Calendar Connected</h2>
        <p>Google Calendar is now authorized for the booking system.</p>
        <p>You can close this window.</p>
      </body></html>
    `);
  } catch (err) {
    console.error('Booking auth error:', err);
    res.status(500).send('Authorization failed: ' + err.message);
  }
});

// ============================================================================
// GET /api/booking/availability?date=2026-05-15
// Returns available 30-minute slots for a given date
// ============================================================================
router.get('/availability', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Date required (YYYY-MM-DD)' });
    }

    const calendar = await getAuthedCalendar();

    // Parse date in ET
    const dayStart = new Date(`${date}T00:00:00`);
    const dayOfWeek = dayStart.getDay();
    const hours = BUSINESS_HOURS[dayOfWeek];

    // Not a business day
    if (!hours) {
      return res.json({ date, slots: [], message: 'No availability on this day' });
    }

    // Build time range in ET → UTC
    const timeMin = new Date(`${date}T${String(hours.start).padStart(2, '0')}:00:00-04:00`);
    const timeMax = new Date(`${date}T${String(hours.end).padStart(2, '0')}:00:00-04:00`);

    // Check if date is in the past
    const now = new Date();
    if (timeMax <= now) {
      return res.json({ date, slots: [], message: 'This date has passed' });
    }

    // Query Google Calendar freebusy
    const freebusyRes = await calendar.freebusy.query({
      requestBody: {
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        timeZone: TIMEZONE,
        items: [{ id: 'primary' }],
      },
    });

    const busySlots = freebusyRes.data.calendars?.primary?.busy || [];

    // Generate all possible slots
    const slots = [];
    let cursor = new Date(timeMin);

    while (cursor.getTime() + SLOT_DURATION * 60000 <= timeMax.getTime()) {
      const slotStart = new Date(cursor);
      const slotEnd = new Date(cursor.getTime() + SLOT_DURATION * 60000);

      // Skip if slot is in the past (with 30 min buffer)
      if (slotStart.getTime() < now.getTime() + 30 * 60000) {
        cursor = new Date(cursor.getTime() + SLOT_DURATION * 60000);
        continue;
      }

      // Check if slot overlaps with any busy period (including buffer)
      const bufferedStart = new Date(slotStart.getTime() - BUFFER_MINUTES * 60000);
      const bufferedEnd = new Date(slotEnd.getTime() + BUFFER_MINUTES * 60000);

      const isBusy = busySlots.some(busy => {
        const busyStart = new Date(busy.start);
        const busyEnd = new Date(busy.end);
        return bufferedStart < busyEnd && bufferedEnd > busyStart;
      });

      if (!isBusy) {
        // Format time in ET for display
        const etTime = slotStart.toLocaleTimeString('en-US', {
          timeZone: TIMEZONE,
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        });

        slots.push({
          start: slotStart.toISOString(),
          end: slotEnd.toISOString(),
          display: etTime,
        });
      }

      cursor = new Date(cursor.getTime() + SLOT_DURATION * 60000);
    }

    res.json({ date, timezone: TIMEZONE, slots });

  } catch (error) {
    console.error('Availability error:', error);
    if (error.message?.includes('not authorized')) {
      return res.status(401).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to fetch availability' });
  }
});

// ============================================================================
// POST /api/booking/create
// Creates a Google Calendar event with Meet link + sends SMS
// ============================================================================
router.post('/create', async (req, res) => {
  try {
    const { name, email, phone, company, message, slotStart, slotEnd } = req.body;

    if (!name || !email || !slotStart || !slotEnd) {
      return res.status(400).json({ error: 'Missing required fields: name, email, slotStart, slotEnd' });
    }

    const calendar = await getAuthedCalendar();

    // Build description
    const descParts = [`Name: ${name}`, `Email: ${email}`];
    if (phone) descParts.push(`Phone: ${phone}`);
    if (company) descParts.push(`Company: ${company}`);
    if (message) descParts.push(`\nNotes:\n${message}`);

    // Create event with Google Meet
    const event = await calendar.events.insert({
      calendarId: 'primary',
      conferenceDataVersion: 1,
      sendUpdates: 'all', // Sends invite to attendee
      requestBody: {
        summary: `VoiceAI Connect Demo — ${name}`,
        description: descParts.join('\n'),
        start: { dateTime: slotStart, timeZone: TIMEZONE },
        end: { dateTime: slotEnd, timeZone: TIMEZONE },
        attendees: [{ email }],
        conferenceData: {
          createRequest: {
            requestId: `booking-${Date.now()}`,
            conferenceSolutionKey: { type: 'hangoutsMeet' },
          },
        },
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'email', minutes: 60 },
            { method: 'popup', minutes: 15 },
          ],
        },
      },
    });

    const meetLink = event.data.hangoutLink || event.data.conferenceData?.entryPoints?.[0]?.uri || null;
    const eventId = event.data.id;

    // Format time for display
    const startDate = new Date(slotStart);
    const dateDisplay = startDate.toLocaleDateString('en-US', {
      timeZone: TIMEZONE, weekday: 'long', month: 'long', day: 'numeric',
    });
    const timeDisplay = startDate.toLocaleTimeString('en-US', {
      timeZone: TIMEZONE, hour: 'numeric', minute: '2-digit', hour12: true,
    });

    // Store booking in Supabase
    await supabase.from('bookings').insert({
      name, email, phone: phone || null, company: company || null,
      message: message || null,
      start_time: slotStart, end_time: slotEnd,
      google_event_id: eventId, google_meet_link: meetLink,
      status: 'confirmed',
    });

    // Send SMS notification to platform owner
    if (NOTIFY_PHONE) {
      const smsBody = [
        `📅 New Demo Booking`,
        `Name: ${name}`,
        company ? `Company: ${company}` : null,
        `Email: ${email}`,
        phone ? `Phone: ${phone}` : null,
        `When: ${dateDisplay} at ${timeDisplay} ET`,
        meetLink ? `Meet: ${meetLink}` : null,
        message ? `Notes: ${message}` : null,
      ].filter(Boolean).join('\n');

      sendTelnyxSMS(NOTIFY_PHONE, smsBody)
        .then(() => console.log('✅ Booking SMS sent'))
        .catch(err => console.error('❌ Booking SMS failed:', err.message));
    }

    console.log(`📅 Booking created: ${name} (${email}) → ${dateDisplay} ${timeDisplay} ET`);

    res.json({
      success: true,
      booking: {
        date: dateDisplay,
        time: timeDisplay,
        meetLink,
        eventId,
      },
    });

  } catch (error) {
    console.error('Booking create error:', error);
    if (error.message?.includes('not authorized')) {
      return res.status(401).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to create booking' });
  }
});

// ============================================================================
// GET /api/booking/upcoming (admin — list upcoming bookings)
// ============================================================================
router.get('/upcoming', async (req, res) => {
  try {
    const { data: bookings, error } = await supabase
      .from('bookings')
      .select('*')
      .gte('start_time', new Date().toISOString())
      .eq('status', 'confirmed')
      .order('start_time', { ascending: true })
      .limit(20);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ bookings: bookings || [] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

module.exports = router;
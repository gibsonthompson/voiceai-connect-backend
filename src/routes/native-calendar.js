// ============================================================================
// Native VoiceAI Connect calendar: dashboard management endpoints.
// ----------------------------------------------------------------------------
// Mounted at /api/client, so every route below carries a client UUID and is
// already ownership-checked by the global guard in server.js (the client, its
// staff, the managing agency, or super_admin). That guard sets req.user; the
// show/hide toggle is the one action gated to the agency (and super_admin),
// never the client themselves.
//
// The native calendar's source of truth is our own `appointments` table. These
// endpoints select the provider, manage scheduling settings, list appointments
// for the calendar view, and create/reschedule/cancel bookings by reusing the
// same calendar-booking helpers the AI and REST API use (so availability,
// double-booking checks, and the appointment.booked/rescheduled/canceled
// webhooks that drive the automations engine all behave identically).
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const calendarBooking = require('../lib/calendar-booking');

// True when the authenticated caller is the managing agency (owner or staff) or
// a super_admin, i.e. NOT the business/client itself. Used only for the
// show/hide-tab toggle, which is an agency-level decision.
function isAgencyCaller(user) {
  if (!user) return false;
  if (user.role === 'super_admin') return true;
  if (user.agencyId) return true;
  if (user.type === 'agency') return true;
  if (user.role === 'agency' || user.role === 'agency_staff') return true;
  return false;
}

// Shape an appointments row for the calendar UI. Only the fields the dashboard
// needs; nothing provider-secret.
function toCalendarAppt(a) {
  if (!a) return null;
  return {
    id: a.id,
    customer_name: a.customer_name || null,
    customer_phone: a.customer_phone || null,
    customer_email: a.customer_email || null,
    appointment_time: a.appointment_time,
    duration: a.duration || null,
    service_type: a.service_type || null,
    staff_name: a.staff_name || null,
    notes: a.notes || null,
    status: a.status || 'confirmed',
    booking_source: a.booking_source || null,
    external: !!(a.google_event_id || a.ghl_event_id),
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ----------------------------------------------------------------------------
// GET /:clientId/calendar/settings
// Current calendar provider + native scheduling settings + tab visibility.
// ----------------------------------------------------------------------------
router.get('/:clientId/calendar/settings', async (req, res) => {
  try {
    const { data: client, error } = await supabase
      .from('clients')
      .select('id, calendar_provider, google_calendar_connected, ghl_connected, show_client_calendar, business_hours, appointment_duration, timezone, min_booking_notice_minutes, max_booking_days_ahead, booking_slot_interval, booking_time_windows')
      .eq('id', req.params.clientId)
      .single();
    if (error || !client) return res.status(404).json({ success: false, error: 'Client not found' });
    res.json({
      success: true,
      provider: client.calendar_provider || null,
      is_native: client.calendar_provider === 'native',
      google_connected: client.google_calendar_connected === true,
      ghl_connected: client.ghl_connected === true,
      show_client_calendar: client.show_client_calendar === true,
      business_hours: client.business_hours || null,
      appointment_duration: client.appointment_duration || 30,
      timezone: client.timezone || 'America/New_York',
      min_booking_notice_minutes: client.min_booking_notice_minutes ?? null,
      max_booking_days_ahead: client.max_booking_days_ahead ?? null,
      booking_slot_interval: client.booking_slot_interval ?? null,
      booking_time_windows: Array.isArray(client.booking_time_windows) ? client.booking_time_windows : null,
    });
  } catch (e) {
    console.error('native-calendar GET settings:', e);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ----------------------------------------------------------------------------
// POST /:clientId/calendar/native/enable
// Select the native calendar as this client's provider. Optionally seeds
// scheduling settings in the same call. Shows the tab by default (the agency
// can still hide it later with the toggle below).
// ----------------------------------------------------------------------------
router.post('/:clientId/calendar/native/enable', async (req, res) => {
  try {
    const b = req.body || {};
    const updates = { calendar_provider: 'native', show_client_calendar: true };
    if (b.business_hours !== undefined) updates.business_hours = b.business_hours;
    if (b.appointment_duration !== undefined) {
      const d = Number(b.appointment_duration);
      if (!Number.isFinite(d) || d <= 0) return res.status(400).json({ success: false, error: 'appointment_duration must be a positive number of minutes' });
      updates.appointment_duration = d;
    }
    if (b.timezone !== undefined && b.timezone) updates.timezone = String(b.timezone);
    if (b.min_booking_notice_minutes !== undefined) updates.min_booking_notice_minutes = b.min_booking_notice_minutes === null ? null : Number(b.min_booking_notice_minutes);
    if (b.max_booking_days_ahead !== undefined) updates.max_booking_days_ahead = b.max_booking_days_ahead === null ? null : Number(b.max_booking_days_ahead);

    const { data, error } = await supabase
      .from('clients').update(updates).eq('id', req.params.clientId)
      .select('id, calendar_provider, show_client_calendar').single();
    if (error) return res.status(400).json({ success: false, error: error.message });
    console.log(`📅 Native calendar enabled for client ${req.params.clientId}`);
    res.json({ success: true, provider: data.calendar_provider, show_client_calendar: data.show_client_calendar });
  } catch (e) {
    console.error('native-calendar enable:', e);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ----------------------------------------------------------------------------
// POST /:clientId/calendar/native/disable
// Stop using the native calendar. Only clears the provider when it is currently
// native, so a later Google/GHL connection is never disturbed. Existing
// appointment rows are kept for history.
// ----------------------------------------------------------------------------
router.post('/:clientId/calendar/native/disable', async (req, res) => {
  try {
    const { data: client } = await supabase
      .from('clients').select('calendar_provider').eq('id', req.params.clientId).single();
    if (!client) return res.status(404).json({ success: false, error: 'Client not found' });
    if (client.calendar_provider !== 'native') {
      return res.json({ success: true, provider: client.calendar_provider || null, changed: false });
    }
    const { error } = await supabase.from('clients').update({ calendar_provider: null }).eq('id', req.params.clientId);
    if (error) return res.status(400).json({ success: false, error: error.message });
    console.log(`📅 Native calendar disabled for client ${req.params.clientId}`);
    res.json({ success: true, provider: null, changed: true });
  } catch (e) {
    console.error('native-calendar disable:', e);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ----------------------------------------------------------------------------
// PUT /:clientId/calendar/native/settings
// Update native scheduling settings (business hours, default duration,
// timezone, booking window). Each field is optional.
// ----------------------------------------------------------------------------
router.put('/:clientId/calendar/native/settings', async (req, res) => {
  try {
    const b = req.body || {};
    const updates = {};
    if (b.business_hours !== undefined) updates.business_hours = b.business_hours;
    if (b.appointment_duration !== undefined) {
      const d = Number(b.appointment_duration);
      if (!Number.isFinite(d) || d <= 0) return res.status(400).json({ success: false, error: 'appointment_duration must be a positive number of minutes' });
      updates.appointment_duration = d;
    }
    if (b.timezone !== undefined && b.timezone) updates.timezone = String(b.timezone);
    if (b.min_booking_notice_minutes !== undefined) updates.min_booking_notice_minutes = b.min_booking_notice_minutes === null ? null : Number(b.min_booking_notice_minutes);
    if (b.max_booking_days_ahead !== undefined) updates.max_booking_days_ahead = b.max_booking_days_ahead === null ? null : Number(b.max_booking_days_ahead);
    // Spacing between offered appointment times (minutes). null clears it back to
    // the platform default. Clamped to a sane range.
    if (b.booking_slot_interval !== undefined) {
      if (b.booking_slot_interval === null) {
        updates.booking_slot_interval = null;
      } else {
        const iv = Number(b.booking_slot_interval);
        if (!Number.isFinite(iv) || iv <= 0) return res.status(400).json({ success: false, error: 'booking_slot_interval must be a positive number of minutes' });
        updates.booking_slot_interval = Math.min(240, Math.max(5, Math.round(iv)));
      }
    }
    // Allowed day-parts for offered slots. Accepts any subset of morning /
    // afternoon / evening; empty or null means all day (within business hours).
    if (b.booking_time_windows !== undefined) {
      if (b.booking_time_windows === null) {
        updates.booking_time_windows = null;
      } else {
        const allowed = ['morning', 'afternoon', 'evening'];
        const clean = (Array.isArray(b.booking_time_windows) ? b.booking_time_windows : [])
          .map((w) => String(w).toLowerCase())
          .filter((w) => allowed.includes(w));
        // De-duplicate, preserve canonical order. Empty array stored as null (all day).
        const uniq = allowed.filter((w) => clean.includes(w));
        updates.booking_time_windows = uniq.length ? uniq : null;
      }
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ success: false, error: 'No settings to update' });

    const { error } = await supabase.from('clients').update(updates).eq('id', req.params.clientId);
    if (error) return res.status(400).json({ success: false, error: error.message });
    res.json({ success: true });
  } catch (e) {
    console.error('native-calendar settings:', e);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ----------------------------------------------------------------------------
// PUT /:clientId/calendar/visibility   (agency / super_admin only)
// Completely show or hide the calendar tab on this client's dashboard.
// ----------------------------------------------------------------------------
router.put('/:clientId/calendar/visibility', async (req, res) => {
  try {
    if (!isAgencyCaller(req.user)) {
      return res.status(403).json({ success: false, error: 'Only the agency can change calendar visibility.' });
    }
    const show = (req.body || {}).show;
    if (typeof show !== 'boolean') return res.status(400).json({ success: false, error: 'show (boolean) is required' });
    const { error } = await supabase.from('clients').update({ show_client_calendar: show }).eq('id', req.params.clientId);
    if (error) return res.status(400).json({ success: false, error: error.message });
    console.log(`📅 Calendar tab ${show ? 'shown' : 'hidden'} for client ${req.params.clientId}`);
    res.json({ success: true, show_client_calendar: show });
  } catch (e) {
    console.error('native-calendar visibility:', e);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ----------------------------------------------------------------------------
// GET /:clientId/calendar/availability?date=YYYY-MM-DD[&duration=30]
// Open slots for a date. Provider-aware (native/Google/GHL) via the booking
// engine, so the same booking UI works whatever the client is on.
// ----------------------------------------------------------------------------
router.get('/:clientId/calendar/availability', async (req, res) => {
  try {
    const date = req.query.date;
    if (!date || !ISO_DATE.test(date)) return res.status(400).json({ success: false, error: 'Pass ?date=YYYY-MM-DD' });
    const opts = {};
    const dur = parseInt(req.query.duration, 10);
    if (Number.isFinite(dur) && dur > 0) opts.durationOverride = dur;
    const result = await calendarBooking.getAvailabilityForClient(req.params.clientId, date, opts);
    if (!result.success) return res.status(409).json({ success: false, error: result.error || 'Could not read availability' });
    res.json({ success: true, date, slots: result.slots || [], provider: result.provider || null });
  } catch (e) {
    console.error('native-calendar availability:', e);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ----------------------------------------------------------------------------
// GET /:clientId/calendar/appointments?from=YYYY-MM-DD&to=YYYY-MM-DD[&status=]
// Appointments in a date range for the calendar view. Dates are inclusive and
// interpreted as whole days in UTC (the UI sends a comfortably wide window).
// Canceled appointments are included so the UI can show them struck through;
// pass status=confirmed to omit them.
// ----------------------------------------------------------------------------
router.get('/:clientId/calendar/appointments', async (req, res) => {
  try {
    const from = req.query.from;
    const to = req.query.to;
    if (from && !ISO_DATE.test(from)) return res.status(400).json({ success: false, error: 'from must be YYYY-MM-DD' });
    if (to && !ISO_DATE.test(to)) return res.status(400).json({ success: false, error: 'to must be YYYY-MM-DD' });

    let q = supabase
      .from('appointments')
      .select('id, customer_name, customer_phone, customer_email, appointment_time, duration, service_type, staff_name, notes, status, booking_source, google_event_id, ghl_event_id')
      .eq('client_id', req.params.clientId)
      .order('appointment_time', { ascending: true })
      .limit(1000);
    if (from) q = q.gte('appointment_time', `${from}T00:00:00.000Z`);
    if (to) q = q.lt('appointment_time', `${to}T23:59:59.999Z`);
    if (req.query.status) q = q.eq('status', req.query.status);

    const { data, error } = await q;
    if (error) return res.status(400).json({ success: false, error: error.message });
    res.json({ success: true, appointments: (data || []).map(toCalendarAppt) });
  } catch (e) {
    console.error('native-calendar list appointments:', e);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ----------------------------------------------------------------------------
// POST /:clientId/calendar/appointments
// Manually create an appointment from the dashboard. Reuses createAppointmentApi
// (native-aware, fires appointment.booked). check_availability defaults to true;
// pass false to deliberately book over a taken slot.
// ----------------------------------------------------------------------------
router.post('/:clientId/calendar/appointments', async (req, res) => {
  try {
    const b = req.body || {};
    const result = await calendarBooking.createAppointmentApi({
      clientId: req.params.clientId,
      date: b.date,
      time: b.time,
      durationMinutes: b.duration_minutes || b.duration || undefined,
      customerName: b.customer_name,
      customerPhone: b.customer_phone || null,
      customerEmail: b.customer_email || null,
      serviceType: b.service_type || null,
      staffName: b.staff_name || null,
      notes: b.notes || null,
      checkAvailability: b.check_availability !== false,
    });
    if (!result.ok) {
      const status = result.code === 'slot_unavailable' ? 409 : (result.code === 'invalid_request' ? 400 : (result.code === 'not_found' ? 404 : 500));
      return res.status(status).json({ success: false, error: result.error, code: result.code, available_slots: result.available_slots || undefined });
    }
    res.json({ success: true, appointment: toCalendarAppt(result.appointment) });
  } catch (e) {
    console.error('native-calendar create appointment:', e);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// Load an appointment and confirm it belongs to the client in the path (the
// ownership guard already authorized the caller for that client).
async function loadScopedAppt(clientId, apptId) {
  const { data: appt } = await supabase.from('appointments').select('*').eq('id', apptId).single();
  if (!appt || appt.client_id !== clientId) return null;
  return appt;
}

// ----------------------------------------------------------------------------
// PATCH /:clientId/calendar/appointments/:apptId   (reschedule)
// ----------------------------------------------------------------------------
router.patch('/:clientId/calendar/appointments/:apptId', async (req, res) => {
  try {
    const appt = await loadScopedAppt(req.params.clientId, req.params.apptId);
    if (!appt) return res.status(404).json({ success: false, error: 'Appointment not found' });
    const b = req.body || {};
    const result = await calendarBooking.rescheduleAppointmentApi(appt, {
      date: b.date,
      time: b.time,
      durationMinutes: b.duration_minutes || b.duration || undefined,
      checkAvailability: b.check_availability !== false,
    });
    if (!result.ok) {
      const status = result.code === 'slot_unavailable' ? 409 : (result.code === 'invalid_request' ? 400 : (result.code === 'not_found' ? 404 : 500));
      return res.status(status).json({ success: false, error: result.error, code: result.code, available_slots: result.available_slots || undefined });
    }
    res.json({ success: true, appointment: toCalendarAppt(result.appointment) });
  } catch (e) {
    console.error('native-calendar reschedule:', e);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ----------------------------------------------------------------------------
// DELETE /:clientId/calendar/appointments/:apptId   (cancel; row kept)
// ----------------------------------------------------------------------------
router.delete('/:clientId/calendar/appointments/:apptId', async (req, res) => {
  try {
    const appt = await loadScopedAppt(req.params.clientId, req.params.apptId);
    if (!appt) return res.status(404).json({ success: false, error: 'Appointment not found' });
    const reason = (req.body || {}).reason || (req.query || {}).reason || null;
    const result = await calendarBooking.cancelAppointmentApi(appt, { reason });
    if (!result.ok) {
      const status = result.code === 'not_found' ? 404 : 500;
      return res.status(status).json({ success: false, error: result.error, code: result.code });
    }
    res.json({ success: true, appointment: toCalendarAppt(result.appointment) });
  } catch (e) {
    console.error('native-calendar cancel:', e);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

module.exports = router;

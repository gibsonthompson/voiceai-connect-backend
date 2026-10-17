// ============================================================================
// src/routes/cc-business-config.js
// Mounted at: app.use('/api/agency', require('./routes/cc-business-config'))
//
// Lets a call-center manager configure a business they answer for, from inside
// the /cc console, without leaving for the reseller client editor:
//
//   GET /:agencyId/cc/businesses/:clientId/config  -> current config
//   PUT /:agencyId/cc/businesses/:clientId/config  -> save (partial, whitelist)
//
// Every field here is read by the assistant config builder at CALL time (the
// greeting, business hours + after-hours routing, and the transfer/handoff
// handling all resolve per call), so a direct column write takes effect on the
// next call - no VAPI rebuild needed. This matches how the existing per-section
// client endpoints (settings / business-hours) already write these columns.
//
// Scoped with requireAgencyAccess: the agency must own the client, and the
// :clientId path enforces call-center agent assignment too (though this is a
// manager surface in practice).
// ============================================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { requireAgencyAccess } = require('./auth');

// Normalize a US/CA number to E.164, or null if it is not a plausible number.
function toE164(input) {
  if (input === null) return null;
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (/^\+[1-9]\d{6,14}$/.test(raw)) return raw;
  const d = raw.replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return null;
}

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

// Coerce incoming business_hours to the CANONICAL stored shape this system
// already uses and every reader (the config builder, the client dashboard)
// understands: a closed day is `null`; an open day is `{ open, close }` (no
// `closed` flag). The editor sends `{open,close,closed}`; we translate. The
// builder's checkBusinessHours treats a null (or no open/close) day as closed.
function sanitizeHours(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  for (const day of WEEKDAYS) {
    const v = input[day];
    if (!v || typeof v !== 'object' || v.closed === true) { out[day] = null; continue; }
    const open = typeof v.open === 'string' && TIME_RE.test(v.open) ? v.open : '09:00';
    const close = typeof v.close === 'string' && TIME_RE.test(v.close) ? v.close : '17:00';
    out[day] = { open, close };
  }
  return out;
}

// Resolve + scope-check the client against the agency.
async function scopedClient(agencyId, clientId) {
  const { data: client } = await supabase
    .from('clients')
    .select('id, agency_id, business_name, owner_name, owner_phone, email, industry, business_city, business_state, business_website, notification_phone, post_call_sms_enabled, transfer_phone, timezone, greeting_message, business_hours, forwarding_mode, human_handoff, service_areas, ai_tone, booking_mode, min_booking_notice_minutes, max_booking_days_ahead, hipaa_mode, recording_enabled, tool_config, vapi_phone_number, forwarding_confirmed, voice_routing')
    .eq('id', clientId).maybeSingle();
  if (!client) return { error: 'Business not found', code: 404 };
  if (client.agency_id !== agencyId) return { error: 'Business not found', code: 404 };
  return { client };
}

// ---- GET config -----------------------------------------------------------
router.get('/:agencyId/cc/businesses/:clientId/config', requireAgencyAccess('clients'), async (req, res) => {
  try {
    const chk = await scopedClient(req.params.agencyId, req.params.clientId);
    if (chk.error) return res.status(chk.code).json({ success: false, error: chk.error });
    const c = chk.client;
    const tc = (c.tool_config && typeof c.tool_config === 'object') ? c.tool_config : {};

    // Booking-window defaults the business inherits when it sets no override
    // (null min/max). These come from the agency (Settings), falling back to the
    // platform default of 30 min notice / 60 days ahead. Surfaced so the editor
    // can show the business owner exactly what "blank = agency default" means.
    let agencyDefaults = { minNotice: 30, maxDays: 60 };
    try {
      const { data: ag } = await supabase.from('agencies')
        .select('default_min_booking_notice_minutes, default_max_booking_days_ahead')
        .eq('id', req.params.agencyId).maybeSingle();
      if (ag) {
        agencyDefaults = {
          minNotice: ag.default_min_booking_notice_minutes ?? 30,
          maxDays: ag.default_max_booking_days_ahead ?? 60,
        };
      }
    } catch (e) { /* keep platform fallback */ }

    // Opt-out status for the recap recipient (notification_phone, else owner
    // phone). If they replied STOP they get no texts, including the recap, until
    // they text START, so the editor warns next to the toggle. Best effort.
    const recipientPhone = c.notification_phone || c.owner_phone || null;
    let optOut = null;
    if (recipientPhone) {
      try {
        const { getOptOut } = require('../lib/sms-opt-out');
        const [platform, scoped] = await Promise.all([
          getOptOut(recipientPhone, null),
          getOptOut(recipientPhone, req.params.agencyId),
        ]);
        const activeRow = (platform && platform.opted_out) ? platform : ((scoped && scoped.opted_out) ? scoped : null);
        optOut = { optedOut: !!activeRow, phone: recipientPhone, since: activeRow ? activeRow.opted_out_at : null };
      } catch (e) { optOut = null; }
    }

    res.json({
      success: true,
      agencyDefaults,
      config: {
        optOut,
        businessName: c.business_name || '',
        ownerName: c.owner_name || '',
        ownerPhone: c.owner_phone || '',
        email: c.email || '',
        industry: c.industry || '',
        businessCity: c.business_city || '',
        businessState: c.business_state || '',
        businessWebsite: c.business_website || '',
        // Post-call recap SMS to the business owner. Per-business on/off; unset
        // (null) is treated as on, preserving the original always-on behavior.
        postCallSms: c.post_call_sms_enabled !== false,
        // Where the recap goes: the business owner. notification_phone overrides
        // owner_phone when set, so it can be pinned to the owner's own cell.
        notificationPhone: c.notification_phone || '',
        transferPhone: c.transfer_phone || '',
        timezone: c.timezone || '',
        greeting: c.greeting_message || '',
        businessHours: c.business_hours || null,
        forwardingMode: c.forwarding_mode || 'all',
        humanHandoff: c.human_handoff || 'transfer',
        serviceAreas: Array.isArray(c.service_areas) ? c.service_areas : [],
        aiTone: c.ai_tone || 'professional',
        bookingMode: c.booking_mode || 'auto_book',
        minBookingNotice: c.min_booking_notice_minutes ?? null,
        maxBookingDays: c.max_booking_days_ahead ?? null,
        // tool_config toggles, read with the same defaults the assistant uses
        // (on, except caller-text which is opt-in). The page's "afterHoursRouting"
        // is stored as tool_config.businessHoursRouting.
        spamDetection: tc.spamDetection !== false,
        callerRecognition: tc.callerRecognition !== false,
        transferCall: tc.transferCall !== false,
        afterHoursRouting: tc.businessHoursRouting !== false,
        smsToCaller: tc.smsToCaller === true,
        // Appointment-booked texts (default OFF). Owner alert is a plain toggle;
        // the customer confirmation is upgrade-gated in the UI. Both send from the
        // business's own AI number when an appointment is booked.
        apptOwnerSmsEnabled: tc.apptOwnerSmsEnabled === true,
        apptCustomerSmsEnabled: tc.apptCustomerSmsEnabled === true,
        apptCustomerSmsTemplate: tc.apptCustomerSmsTemplate || '',
        // Call-center escalation policies (only meaningful for call-center
        // agencies; the agent layer is what they gate).
        overflowAction: ['message', 'callback', 'ring_business'].includes(tc.overflowAction) ? tc.overflowAction : 'message',
        aiDirectRouting: tc.aiDirectRouting === true,
        // Consult (warm) transfer: agent briefs the recipient live before
        // connecting. Off = whisper transfer (recipient hears context, no live brief).
        consultTransfer: tc.consultTransfer === true,
        hipaaMode: c.hipaa_mode === true,
        recordingEnabled: c.recording_enabled !== false,
        vapiPhoneNumber: c.vapi_phone_number || null,
        forwardingConfirmed: c.forwarding_confirmed === true,
      },
    });
  } catch (e) {
    console.error('cc business-config GET error:', e.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ---- PUT config (partial, whitelisted) ------------------------------------
router.put('/:agencyId/cc/businesses/:clientId/config', requireAgencyAccess('clients'), async (req, res) => {
  try {
    const chk = await scopedClient(req.params.agencyId, req.params.clientId);
    if (chk.error) return res.status(chk.code).json({ success: false, error: chk.error });
    const b = req.body || {};
    const updates = {};

    if (typeof b.businessName === 'string' && b.businessName.trim()) updates.business_name = b.businessName.trim();
    if (typeof b.ownerName === 'string') updates.owner_name = b.ownerName.trim() || null;
    if (typeof b.timezone === 'string' && b.timezone.trim()) updates.timezone = b.timezone.trim();
    if (typeof b.greeting === 'string') updates.greeting_message = b.greeting.trim() || null;

    if (b.ownerPhone !== undefined) {
      const p = toE164(b.ownerPhone);
      if (b.ownerPhone && !p) return res.status(400).json({ success: false, error: 'Owner phone is not a valid number.' });
      updates.owner_phone = p;
    }
    if (b.transferPhone !== undefined) {
      const p = toE164(b.transferPhone);
      if (b.transferPhone && !p) return res.status(400).json({ success: false, error: 'Escalation phone is not a valid number.' });
      // Never let the transfer target equal the AI line (would loop the call).
      if (p && chk.client.vapi_phone_number && toE164(chk.client.vapi_phone_number) === p) {
        return res.status(400).json({ success: false, error: 'Escalation number cannot be the business’s own AI number.' });
      }
      updates.transfer_phone = p;
    }
    if (b.postCallSms !== undefined) {
      // Explicit per-business on/off (true/false). No inherit state.
      updates.post_call_sms_enabled = (b.postCallSms === true || b.postCallSms === 'on');
    }
    if (b.notificationPhone !== undefined) {
      const p = toE164(b.notificationPhone);
      if (b.notificationPhone && !p) return res.status(400).json({ success: false, error: 'Notification phone is not a valid number.' });
      updates.notification_phone = p;
    }
    if (b.forwardingMode !== undefined) updates.forwarding_mode = b.forwardingMode === 'missed' ? 'missed' : 'all';
    if (b.humanHandoff !== undefined) updates.human_handoff = b.humanHandoff === 'message' ? 'message' : 'transfer';

    if (b.businessHours !== undefined) {
      const h = sanitizeHours(b.businessHours);
      if (b.businessHours && !h) return res.status(400).json({ success: false, error: 'Business hours format is invalid.' });
      updates.business_hours = h;
    }
    if (b.serviceAreas !== undefined && Array.isArray(b.serviceAreas)) {
      updates.service_areas = b.serviceAreas.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 50);
    }

    // Identity extras.
    if (typeof b.email === 'string') updates.email = b.email.trim() || null;
    if (typeof b.businessCity === 'string') updates.business_city = b.businessCity.trim() || null;
    if (typeof b.businessState === 'string') updates.business_state = b.businessState.trim() || null;
    if (typeof b.businessWebsite === 'string') updates.business_website = b.businessWebsite.trim() || null;

    // Tone.
    if (b.aiTone !== undefined && ['professional', 'friendly', 'casual', 'clinical'].includes(b.aiTone)) updates.ai_tone = b.aiTone;

    // Booking. null/'' clears the per-business override so it inherits the agency
    // default; a value is range-clamped.
    if (b.bookingMode !== undefined && ['auto_book', 'collect_request', 'disabled'].includes(b.bookingMode)) updates.booking_mode = b.bookingMode;
    if (b.minBookingNotice !== undefined) {
      if (b.minBookingNotice === null || b.minBookingNotice === '') updates.min_booking_notice_minutes = null;
      else { const n = parseInt(b.minBookingNotice, 10); if (!isNaN(n) && n >= 0 && n <= 20160) updates.min_booking_notice_minutes = n; }
    }
    if (b.maxBookingDays !== undefined) {
      if (b.maxBookingDays === null || b.maxBookingDays === '') updates.max_booking_days_ahead = null;
      else { const n = parseInt(b.maxBookingDays, 10); if (!isNaN(n) && n >= 1 && n <= 365) updates.max_booking_days_ahead = n; }
    }

    // Compliance. recording_enabled is written as-is; the config builder still
    // force-disables recording (and caller recognition) under HIPAA at call time.
    if (b.hipaaMode !== undefined) updates.hipaa_mode = b.hipaaMode === true;
    if (b.recordingEnabled !== undefined) updates.recording_enabled = b.recordingEnabled === true;

    // Call-handling toggles live in tool_config (jsonb). MERGE so we never clobber
    // other keys (smsPresets, backgroundDenoising, etc.). The page's
    // "afterHoursRouting" is stored as businessHoursRouting.
    const tcKeys = ['spamDetection', 'callerRecognition', 'transferCall', 'afterHoursRouting', 'smsToCaller', 'overflowAction', 'aiDirectRouting', 'consultTransfer', 'apptOwnerSmsEnabled', 'apptCustomerSmsEnabled', 'apptCustomerSmsTemplate'];
    if (tcKeys.some((k) => b[k] !== undefined)) {
      const existingTc = (chk.client.tool_config && typeof chk.client.tool_config === 'object') ? chk.client.tool_config : {};
      const mergedTc = { ...existingTc };
      if (b.spamDetection !== undefined) mergedTc.spamDetection = b.spamDetection === true;
      if (b.callerRecognition !== undefined) mergedTc.callerRecognition = b.callerRecognition === true;
      if (b.transferCall !== undefined) mergedTc.transferCall = b.transferCall === true;
      if (b.afterHoursRouting !== undefined) mergedTc.businessHoursRouting = b.afterHoursRouting === true;
      if (b.smsToCaller !== undefined) mergedTc.smsToCaller = b.smsToCaller === true;
      if (b.overflowAction !== undefined && ['message', 'callback', 'ring_business'].includes(b.overflowAction)) mergedTc.overflowAction = b.overflowAction;
      if (b.aiDirectRouting !== undefined) mergedTc.aiDirectRouting = b.aiDirectRouting === true;
      if (b.consultTransfer !== undefined) mergedTc.consultTransfer = b.consultTransfer === true;
      if (b.apptOwnerSmsEnabled !== undefined) mergedTc.apptOwnerSmsEnabled = b.apptOwnerSmsEnabled === true;
      if (b.apptCustomerSmsEnabled !== undefined) mergedTc.apptCustomerSmsEnabled = b.apptCustomerSmsEnabled === true;
      if (b.apptCustomerSmsTemplate !== undefined) mergedTc.apptCustomerSmsTemplate = String(b.apptCustomerSmsTemplate || '').slice(0, 320);
      updates.tool_config = mergedTc;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'Nothing to update.' });
    }

    const { error } = await supabase.from('clients').update(updates).eq('id', req.params.clientId);
    if (error) { console.error('cc business-config PUT error:', error.message); return res.status(400).json({ success: false, error: error.message }); }
    res.json({ success: true, updated: Object.keys(updates) });
  } catch (e) {
    console.error('cc business-config PUT error:', e.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

module.exports = router;
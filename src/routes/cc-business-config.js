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
    .select('id, agency_id, business_name, owner_name, owner_phone, email, business_city, business_state, business_website, notification_phone, post_call_sms_enabled, transfer_phone, timezone, greeting_message, business_hours, forwarding_mode, human_handoff, service_areas, ai_tone, booking_mode, min_booking_notice_minutes, max_booking_days_ahead, tool_config, hipaa_mode, recording_enabled, vapi_phone_number, forwarding_confirmed, voice_routing')
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
    res.json({
      success: true,
      config: {
        businessName: c.business_name || '',
        ownerName: c.owner_name || '',
        ownerPhone: c.owner_phone || '',
        email: c.email || '',
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
        // AI behavior
        aiTone: c.ai_tone || 'professional',
        // Booking (null = inherit the agency default)
        bookingMode: c.booking_mode || 'collect_request',
        minBookingNotice: c.min_booking_notice_minutes ?? null,
        maxBookingDays: c.max_booking_days_ahead ?? null,
        // Call-handling toggles live in tool_config; defaults match the builder.
        spamDetection: (c.tool_config && c.tool_config.spamDetection) !== false,
        callerRecognition: (c.tool_config && c.tool_config.callerRecognition) !== false,
        transferCall: (c.tool_config && c.tool_config.transferCall) !== false,
        afterHoursRouting: (c.tool_config && c.tool_config.businessHoursRouting) !== false,
        smsToCaller: !!(c.tool_config && c.tool_config.smsToCaller === true),
        // Compliance
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
    if (typeof b.businessCity === 'string') updates.business_city = b.businessCity.trim() || null;
    if (typeof b.businessState === 'string') updates.business_state = b.businessState.trim() || null;
    if (b.businessWebsite !== undefined) updates.business_website = String(b.businessWebsite || '').trim() || null;

    // AI tone (enum, guarded).
    if (b.aiTone !== undefined && ['professional', 'friendly', 'casual', 'clinical'].includes(b.aiTone)) updates.ai_tone = b.aiTone;

    // Booking: mode (enum) + optional window (null = inherit the agency default).
    if (b.bookingMode !== undefined && ['auto_book', 'collect_request', 'disabled'].includes(b.bookingMode)) updates.booking_mode = b.bookingMode;
    if (b.minBookingNotice !== undefined) {
      const n = Number(b.minBookingNotice);
      updates.min_booking_notice_minutes = (b.minBookingNotice === null || b.minBookingNotice === '' || Number.isNaN(n)) ? null : Math.max(0, Math.floor(n));
    }
    if (b.maxBookingDays !== undefined) {
      const n = Number(b.maxBookingDays);
      updates.max_booking_days_ahead = (b.maxBookingDays === null || b.maxBookingDays === '' || Number.isNaN(n)) ? null : Math.max(1, Math.floor(n));
    }

    // Compliance. HIPAA mode is the master switch (the builder also forces
    // recording + caller recognition off when it is on); recording_enabled is a
    // standalone off switch that works independently of HIPAA.
    if (b.hipaaMode !== undefined) updates.hipaa_mode = (b.hipaaMode === true);
    if (b.recordingEnabled !== undefined) updates.recording_enabled = !(b.recordingEnabled === false || b.recordingEnabled === 'off');

    // Call-handling toggles are stored inside the tool_config jsonb. MERGE into
    // the existing object so keys this UI does not show (smsSnippets, smsPresets,
    // speechTimeout, and so on) are never wiped.
    const _tcKeys = ['spamDetection', 'callerRecognition', 'transferCall', 'afterHoursRouting', 'smsToCaller'];
    if (_tcKeys.some((k) => b[k] !== undefined)) {
      const tc = { ...(chk.client.tool_config && typeof chk.client.tool_config === 'object' && !Array.isArray(chk.client.tool_config) ? chk.client.tool_config : {}) };
      if (b.spamDetection !== undefined) tc.spamDetection = b.spamDetection === true;
      if (b.callerRecognition !== undefined) tc.callerRecognition = b.callerRecognition === true;
      if (b.transferCall !== undefined) tc.transferCall = b.transferCall === true;
      if (b.afterHoursRouting !== undefined) tc.businessHoursRouting = b.afterHoursRouting === true;
      if (b.smsToCaller !== undefined) tc.smsToCaller = b.smsToCaller === true;
      updates.tool_config = tc;
    }

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
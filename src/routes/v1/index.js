// /api/v1, the agency-facing REST API (Scale plan).
//
// Every route below is authenticated by apiKeyAuth, which attaches req.agency.
// TENANT ISOLATION RULE: every Supabase query in this file is scoped by
// req.agency.id (directly on clients, or via the agency's client ids for calls).
// Calls carry no agency_id, so we resolve the agency's client ids first and
// constrain by them, never trust a client_id from the query string without
// confirming it belongs to this agency.

const express = require('express');
const router = express.Router();

const { supabase } = require('../../lib/supabase');
const { resolveVapiRecordingUrl } = require('../../lib/vapi-recording');
const { handleAgencyAddClient } = require('../client-signup');
const { updateClientKnowledgeBase } = require('../client-knowledge-base');
const {
  apiKeyAuth, requireScope, fail,
  parsePagination, sendList, toPublicClient, toPublicCall,
} = require('../../middleware/api-auth');
const { EVENT_TYPES, sendPing, isSafeWebhookUrl } = require('../../lib/webhooks');

// Same default as google-calendar-auth.js so the OAuth connect link we hand back
// points at THIS deployment (the client finishes consent on our callback).
const BACKEND_URL = process.env.BACKEND_URL || 'https://urchin-app-bqb4i.ondigitalocean.app';

// Normalize a caller-supplied phone to E.164, or return an error string. Shared
// by the receptionist and escalation routes. Empty/null clears the field.
function normalizePhoneOrError(raw) {
  if (raw === null || raw === '') return { value: null };
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return { value: '+1' + digits };
  if (String(raw).startsWith('+') && digits.length >= 11 && digits.length <= 15) return { value: '+' + digits };
  return { error: 'phone must be a 10-digit US number or E.164 (e.g. +15551234567).' };
}

router.use(apiKeyAuth);

// Resolve the set of client ids owned by this agency (used to scope calls).
async function agencyClientIds(agencyId) {
  const { data, error } = await supabase
    .from('clients').select('id').eq('agency_id', agencyId);
  if (error) throw error;
  return (data || []).map((r) => r.id);
}

// ----------------------------------------------------------------------------
// Account
// ----------------------------------------------------------------------------
router.get('/account', (req, res) => {
  const a = req.agency;
  res.json({
    id: a.id,
    name: a.name,
    slug: a.slug,
    plan_type: a.plan_type,
    subscription_status: a.subscription_status,
    api: { scope: req.apiKey.scope, version: 'v1' },
  });
});

// ----------------------------------------------------------------------------
// Clients
// ----------------------------------------------------------------------------
router.get('/clients', async (req, res) => {
  try {
    const { limit, cursor } = parsePagination(req);
    let q = supabase
      .from('clients')
      .select('*')
      .eq('agency_id', req.agency.id)
      .order('created_at', { ascending: false })
      .limit(limit + 1);
    if (cursor) q = q.lt('created_at', cursor);
    if (req.query.status) q = q.eq('status', req.query.status);
    if (req.query.industry) q = q.eq('industry', req.query.industry);
    const { data, error } = await q;
    if (error) return fail(res, 400, 'api_error', error.message);
    return sendList(res, data, limit, toPublicClient);
  } catch (err) {
    console.error('v1 GET /clients:', err);
    return fail(res, 500, 'api_error', 'Failed to list clients.');
  }
});

// Create a client. Reuses the full async provisioning + rollback path
// (handleAgencyAddClient), which responds 202 with a provisioning job id.
router.post('/clients', requireScope('read_write'), async (req, res) => {
  try {
    const b = req.body || {};
    const pick = (snake, camel) => b[snake] !== undefined ? b[snake] : b[camel];
    // Normalize the public snake_case body into what handleAgencyAddClient reads.
    req.body = {
      firstName: pick('first_name', 'firstName'),
      lastName: pick('last_name', 'lastName') || '',
      email: pick('email', 'email'),
      phone: pick('phone', 'phone'),
      businessName: pick('business_name', 'businessName'),
      industry: pick('industry', 'industry'),
      businessCity: pick('business_city', 'businessCity'),
      businessState: pick('business_state', 'businessState'),
      businessCountry: pick('business_country', 'businessCountry'),
      websiteUrl: pick('website_url', 'websiteUrl'),
      planType: pick('plan_type', 'planType') || 'starter',
      pricingMode: pick('pricing_mode', 'pricingMode') || 'plan',
      customPricing: pick('custom_pricing', 'customPricing') || null,
      // Client login is set in-browser via an in-app token, not by this password,
      // so if the caller omits one we generate a throwaway that satisfies setup.
      tempPassword: pick('temp_password', 'tempPassword')
        || require('crypto').randomBytes(9).toString('base64url'),
    };
    req.params = req.params || {};
    req.params.agencyId = req.agency.id; // force the key's agency; never trust the body
    return handleAgencyAddClient(req, res);
  } catch (err) {
    console.error('v1 POST /clients:', err);
    return fail(res, 500, 'api_error', 'Failed to create client.');
  }
});

router.get('/clients/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('clients').select('*')
      .eq('id', req.params.id).eq('agency_id', req.agency.id).single();
    if (error || !data) return fail(res, 404, 'not_found', 'Client not found.');
    return res.json(toPublicClient(data));
  } catch (err) {
    console.error('v1 GET /clients/:id:', err);
    return fail(res, 500, 'api_error', 'Failed to fetch client.');
  }
});

// Update a whitelist of client fields. Provisioning-owned fields (numbers,
// assistant ids, billing) are intentionally not editable here.
router.patch('/clients/:id', requireScope('read_write'), async (req, res) => {
  try {
    const b = req.body || {};
    const allowed = ['business_name', 'industry', 'business_city', 'business_state', 'country', 'business_website', 'owner_name', 'owner_phone', 'notification_phone', 'email', 'post_call_sms_enabled'];
    const updates = {};
    for (const f of allowed) if (b[f] !== undefined) updates[f] = b[f];
    // Post-call recap SMS override: coerce to a strict boolean (false = off).
    if (updates.post_call_sms_enabled !== undefined) {
      updates.post_call_sms_enabled = updates.post_call_sms_enabled !== false;
    }
    if (Object.keys(updates).length === 0) {
      return fail(res, 400, 'invalid_request', 'No updatable fields provided.');
    }
    const { data: owned } = await supabase
      .from('clients').select('id').eq('id', req.params.id).eq('agency_id', req.agency.id).single();
    if (!owned) return fail(res, 404, 'not_found', 'Client not found.');
    const { data, error } = await supabase
      .from('clients').update(updates).eq('id', req.params.id).eq('agency_id', req.agency.id)
      .select('*').single();
    if (error) return fail(res, 400, 'api_error', error.message);
    return res.json(toPublicClient(data));
  } catch (err) {
    console.error('v1 PATCH /clients/:id:', err);
    return fail(res, 500, 'api_error', 'Failed to update client.');
  }
});

// Deletion tears down the provisioned number, VAPI assistant, and billing.
// That teardown is not yet wired into the API, and a partial delete would orphan
// a paid phone number, so this is deliberately blocked until Phase 2.
router.delete('/clients/:id', requireScope('read_write'), (req, res) => {
  return res.status(501).json({
    error: {
      type: 'not_implemented',
      message: 'Deleting a client via the API is not available yet. Remove the client from your dashboard so its number and assistant are released cleanly.',
    },
  });
});

router.get('/clients/:id/provisioning-status/:jobId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('client_provisioning_jobs')
      .select('id, status, result, created_at')
      .eq('id', req.params.jobId)
      .eq('agency_id', req.agency.id)
      .single();
    if (error || !data) return fail(res, 404, 'not_found', 'Provisioning job not found.');
    return res.json({
      id: data.id,
      status: data.status,
      result: data.result || null,
      created_at: data.created_at,
    });
  } catch (err) {
    console.error('v1 provisioning-status:', err);
    return fail(res, 500, 'api_error', 'Failed to fetch provisioning status.');
  }
});

// ----------------------------------------------------------------------------
// Calls
// ----------------------------------------------------------------------------
router.get('/calls', async (req, res) => {
  try {
    const { limit, cursor } = parsePagination(req);
    const ids = await agencyClientIds(req.agency.id);
    if (ids.length === 0) return res.json({ data: [], has_more: false, next_cursor: null });

    let scoped = ids;
    if (req.query.client_id) {
      if (!ids.includes(req.query.client_id)) {
        return fail(res, 404, 'not_found', 'Client not found.');
      }
      scoped = [req.query.client_id];
    }
    let q = supabase
      .from('calls').select('*')
      .in('client_id', scoped)
      .order('created_at', { ascending: false })
      .limit(limit + 1);
    if (cursor) q = q.lt('created_at', cursor);
    if (req.query.since) q = q.gte('created_at', req.query.since);
    if (req.query.until) q = q.lte('created_at', req.query.until);
    const { data, error } = await q;
    if (error) return fail(res, 400, 'api_error', error.message);
    return sendList(res, data, limit, toPublicCall);
  } catch (err) {
    console.error('v1 GET /calls:', err);
    return fail(res, 500, 'api_error', 'Failed to list calls.');
  }
});

// Fetch a call and confirm its client belongs to this agency before returning.
async function fetchOwnedCall(agencyId, callId) {
  const { data: call } = await supabase.from('calls').select('*').eq('id', callId).single();
  if (!call) return null;
  const { data: client } = await supabase
    .from('clients').select('id').eq('id', call.client_id).eq('agency_id', agencyId).single();
  if (!client) return null;
  return call;
}

router.get('/calls/:id', async (req, res) => {
  try {
    const call = await fetchOwnedCall(req.agency.id, req.params.id);
    if (!call) return fail(res, 404, 'not_found', 'Call not found.');
    if (call.recording_url) {
      try { call.recording_url = await resolveVapiRecordingUrl(call.recording_url); } catch (e) {}
    }
    return res.json(toPublicCall(call));
  } catch (err) {
    console.error('v1 GET /calls/:id:', err);
    return fail(res, 500, 'api_error', 'Failed to fetch call.');
  }
});

router.get('/calls/:id/recording', async (req, res) => {
  try {
    const call = await fetchOwnedCall(req.agency.id, req.params.id);
    if (!call) return fail(res, 404, 'not_found', 'Call not found.');
    if (!call.recording_url) return fail(res, 404, 'not_found', 'This call has no recording.');
    let url = call.recording_url;
    try { url = await resolveVapiRecordingUrl(call.recording_url); } catch (e) {}
    return res.json({ url });
  } catch (err) {
    console.error('v1 GET /calls/:id/recording:', err);
    return fail(res, 500, 'api_error', 'Failed to fetch recording.');
  }
});

// ----------------------------------------------------------------------------
// Receptionist configuration (per client)
// ----------------------------------------------------------------------------
// These fields are read by the dynamic VAPI assistant at call time, so a DB
// write takes effect on the next call, no assistant rebuild needed.
async function ownedClient(agencyId, clientId, columns) {
  const { data } = await supabase
    .from('clients').select(columns).eq('id', clientId).eq('agency_id', agencyId).single();
  return data || null;
}

function toPublicReceptionist(c) {
  return {
    client_id: c.id,
    greeting_message: c.greeting_message,
    voice_id: c.voice_id,
    human_handoff: c.human_handoff,        // 'transfer' | 'message'
    transfer_phone: c.transfer_phone,
    forwarding_mode: c.forwarding_mode,
    business_hours: c.business_hours,
  };
}

router.get('/clients/:id/receptionist', async (req, res) => {
  try {
    const c = await ownedClient(req.agency.id, req.params.id,
      'id, greeting_message, voice_id, human_handoff, transfer_phone, forwarding_mode, business_hours');
    if (!c) return fail(res, 404, 'not_found', 'Client not found.');
    return res.json(toPublicReceptionist(c));
  } catch (err) {
    console.error('v1 GET receptionist:', err);
    return fail(res, 500, 'api_error', 'Failed to fetch receptionist config.');
  }
});

router.patch('/clients/:id/receptionist', requireScope('read_write'), async (req, res) => {
  try {
    const owned = await ownedClient(req.agency.id, req.params.id, 'id');
    if (!owned) return fail(res, 404, 'not_found', 'Client not found.');
    const b = req.body || {};
    const updates = {};

    if (b.greeting_message !== undefined) {
      if (typeof b.greeting_message !== 'string') return fail(res, 400, 'invalid_request', 'greeting_message must be a string.');
      updates.greeting_message = b.greeting_message;
    }
    if (b.voice_id !== undefined) {
      if (b.voice_id !== null && typeof b.voice_id !== 'string') return fail(res, 400, 'invalid_request', 'voice_id must be a string.');
      updates.voice_id = b.voice_id;
    }
    if (b.human_handoff !== undefined) {
      if (!['transfer', 'message'].includes(b.human_handoff)) return fail(res, 400, 'invalid_request', "human_handoff must be 'transfer' or 'message'.");
      updates.human_handoff = b.human_handoff;
    }
    if (b.transfer_phone !== undefined) {
      const raw = b.transfer_phone;
      if (raw === null || raw === '') {
        updates.transfer_phone = null;
      } else {
        const digits = String(raw).replace(/\D/g, '');
        if (digits.length === 10) updates.transfer_phone = '+1' + digits;
        else if (String(raw).startsWith('+') && digits.length >= 11 && digits.length <= 15) updates.transfer_phone = '+' + digits;
        else return fail(res, 400, 'invalid_request', 'transfer_phone must be a 10-digit US number or E.164.');
      }
    }
    if (b.business_hours !== undefined) {
      updates.business_hours = b.business_hours; // JSON passthrough, same as dashboard
    }

    if (Object.keys(updates).length === 0) return fail(res, 400, 'invalid_request', 'No updatable fields provided.');

    const { data, error } = await supabase
      .from('clients').update(updates).eq('id', req.params.id).eq('agency_id', req.agency.id)
      .select('id, greeting_message, voice_id, human_handoff, transfer_phone, forwarding_mode, business_hours').single();
    if (error) return fail(res, 400, 'api_error', error.message);
    return res.json(toPublicReceptionist(data));
  } catch (err) {
    console.error('v1 PATCH receptionist:', err);
    return fail(res, 500, 'api_error', 'Failed to update receptionist config.');
  }
});

// ----------------------------------------------------------------------------
// Knowledge base (read). Writing the KB rebuilds a VAPI file + tool + assistant,
// so it is intentionally not exposed here yet; edit the KB from the dashboard.
// ----------------------------------------------------------------------------
router.put('/clients/:id/knowledge-base', requireScope('read_write'), async (req, res) => {
  try {
    const result = await updateClientKnowledgeBase(req.agency.id, req.params.id, (req.body || {}).content);
    if (!result.ok) {
      const type = result.status === 404 ? 'not_found' : 'invalid_request';
      return fail(res, result.status || 400, type, result.error);
    }
    return res.json({ client_id: req.params.id, content: result.content });
  } catch (err) {
    console.error('v1 PUT /clients/:id/knowledge-base:', err);
    return fail(res, 500, 'api_error', 'Failed to update knowledge base.');
  }
});

router.get('/clients/:id/knowledge-base', async (req, res) => {
  try {
    const c = await ownedClient(req.agency.id, req.params.id, 'id, knowledge_base_content, knowledge_base_updated_at');
    if (!c) return fail(res, 404, 'not_found', 'Client not found.');
    return res.json({
      client_id: c.id,
      content: c.knowledge_base_content || '',
      updated_at: c.knowledge_base_updated_at || null,
    });
  } catch (err) {
    console.error('v1 GET knowledge-base:', err);
    return fail(res, 500, 'api_error', 'Failed to fetch knowledge base.');
  }
});

// ----------------------------------------------------------------------------
// Phone numbers (the agency's provisioned client numbers)
// ----------------------------------------------------------------------------
router.get('/numbers', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('clients')
      .select('id, business_name, phone_number, status, created_at')
      .eq('agency_id', req.agency.id)
      .not('phone_number', 'is', null)
      .order('created_at', { ascending: false });
    if (error) return fail(res, 400, 'api_error', error.message);
    const numbers = (data || []).map((c) => ({
      client_id: c.id,
      business_name: c.business_name,
      phone_number: c.phone_number,
      status: c.status,
      created_at: c.created_at,
    }));
    return res.json({ data: numbers });
  } catch (err) {
    console.error('v1 GET numbers:', err);
    return fail(res, 500, 'api_error', 'Failed to list numbers.');
  }
});

// ----------------------------------------------------------------------------
// Usage & analytics (computed from calls; scoped to the agency's clients)
// ----------------------------------------------------------------------------
function windowFromQuery(req) {
  // Default: trailing 30 days. Override with ?since / ?until (ISO 8601).
  const until = req.query.until || new Date().toISOString();
  const since = req.query.since || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  return { since, until };
}

async function callsInWindow(agencyId, since, until, columns) {
  const { data: clients } = await supabase.from('clients').select('id, business_name').eq('agency_id', agencyId);
  const ids = (clients || []).map((c) => c.id);
  if (ids.length === 0) return { rows: [], clients: [] };
  const { data, error } = await supabase
    .from('calls').select(columns)
    .in('client_id', ids)
    .gte('created_at', since).lte('created_at', until);
  if (error) throw error;
  return { rows: data || [], clients: clients || [] };
}

router.get('/usage', async (req, res) => {
  try {
    // usage_records is the canonical billing source and carries agency_id
    // directly, so it is both cleaner and more accurate than summing calls.
    const { since, until } = windowFromQuery(req);
    let q = supabase
      .from('usage_records')
      .select('client_id, duration_seconds, duration_minutes, created_at')
      .eq('agency_id', req.agency.id);
    if (req.query.billing_month) q = q.eq('billing_month', req.query.billing_month);
    else q = q.gte('created_at', since).lte('created_at', until);
    const { data: recs, error } = await q;
    if (error) return fail(res, 400, 'api_error', error.message);

    const { data: clients } = await supabase
      .from('clients').select('id, business_name').eq('agency_id', req.agency.id);
    const names = Object.fromEntries((clients || []).map((c) => [c.id, c.business_name]));

    const per = {};
    let totalSeconds = 0, totalMinutes = 0, totalRecords = 0;
    for (const r of (recs || [])) {
      const secs = Number(r.duration_seconds) || 0;
      const mins = Number(r.duration_minutes) || 0;
      totalSeconds += secs; totalMinutes += mins; totalRecords += 1;
      if (!per[r.client_id]) per[r.client_id] = { client_id: r.client_id, business_name: names[r.client_id] || null, records: 0, seconds: 0, minutes: 0 };
      per[r.client_id].records += 1; per[r.client_id].seconds += secs; per[r.client_id].minutes += mins;
    }
    const by_client = Object.values(per).map((c) => ({ ...c, minutes: Math.round(c.minutes * 100) / 100 }));
    return res.json({
      period: req.query.billing_month ? { billing_month: req.query.billing_month } : { since, until },
      total_records: totalRecords,
      total_minutes: Math.round(totalMinutes * 100) / 100,
      total_seconds: totalSeconds,
      by_client,
    });
  } catch (err) {
    console.error('v1 GET /usage:', err);
    return fail(res, 500, 'api_error', 'Failed to compute usage.');
  }
});

router.get('/analytics/calls', async (req, res) => {
  try {
    const { since, until } = windowFromQuery(req);
    const { rows } = await callsInWindow(req.agency.id, since, until, 'duration_seconds, call_status, is_spam');
    const byStatus = {};
    let totalSeconds = 0, spam = 0;
    for (const r of rows) {
      totalSeconds += Number(r.duration_seconds) || 0;
      if (r.is_spam) spam += 1;
      const st = r.call_status || 'unknown';
      byStatus[st] = (byStatus[st] || 0) + 1;
    }
    return res.json({
      period: { since, until },
      total_calls: rows.length,
      total_minutes: Math.round(totalSeconds / 60),
      spam_calls: spam,
      by_status: byStatus,
    });
  } catch (err) {
    console.error('v1 GET analytics/calls:', err);
    return fail(res, 500, 'api_error', 'Failed to compute analytics.');
  }
});


// ----------------------------------------------------------------------------
// Appointments (booked by the AI; scoped by client_id, join via clients)
// ----------------------------------------------------------------------------
function toPublicAppointment(a) {
  return {
    id: a.id,
    client_id: a.client_id,
    customer_name: a.customer_name,
    customer_phone: a.customer_phone,
    customer_email: a.customer_email,
    appointment_time: a.appointment_time,
    duration: a.duration,
    service_type: a.service_type,
    status: a.status,
    notes: a.notes,
    staff_name: a.staff_name,
    booking_source: a.booking_source,
    google_event_id: a.google_event_id,
    calcom_booking_id: a.calcom_booking_id,
    created_at: a.created_at,
    updated_at: a.updated_at,
  };
}

router.get('/appointments', async (req, res) => {
  try {
    const { limit, cursor } = parsePagination(req);
    const ids = await agencyClientIds(req.agency.id);
    if (ids.length === 0) return res.json({ data: [], has_more: false, next_cursor: null });

    let scoped = ids;
    if (req.query.client_id) {
      if (!ids.includes(req.query.client_id)) return fail(res, 404, 'not_found', 'Client not found.');
      scoped = [req.query.client_id];
    }
    let q = supabase
      .from('appointments').select('*')
      .in('client_id', scoped)
      .order('appointment_time', { ascending: false })
      .limit(limit + 1);
    if (cursor) q = q.lt('appointment_time', cursor);
    if (req.query.status) q = q.eq('status', req.query.status);
    if (req.query.since) q = q.gte('appointment_time', req.query.since);
    if (req.query.until) q = q.lte('appointment_time', req.query.until);
    const { data, error } = await q;
    if (error) return fail(res, 400, 'api_error', error.message);
    return sendList(res, data, limit, toPublicAppointment, 'appointment_time');
  } catch (err) {
    console.error('v1 GET /appointments:', err);
    return fail(res, 500, 'api_error', 'Failed to list appointments.');
  }
});

router.get('/appointments/:id', async (req, res) => {
  try {
    const { data: appt } = await supabase.from('appointments').select('*').eq('id', req.params.id).single();
    if (!appt) return fail(res, 404, 'not_found', 'Appointment not found.');
    const owned = await ownedClient(req.agency.id, appt.client_id, 'id');
    if (!owned) return fail(res, 404, 'not_found', 'Appointment not found.');
    return res.json(toPublicAppointment(appt));
  } catch (err) {
    console.error('v1 GET /appointments/:id:', err);
    return fail(res, 500, 'api_error', 'Failed to fetch appointment.');
  }
});


// ----------------------------------------------------------------------------
// Webhooks (event subscriptions)
// ----------------------------------------------------------------------------
function toPublicWebhook(w) {
  return {
    id: w.id,
    url: w.url,
    events: w.events,
    status: w.status,
    description: w.description,
    created_at: w.created_at,
    last_delivery_at: w.last_delivery_at,
    last_error: w.last_error,
  };
}

function toPublicDelivery(d) {
  return {
    id: d.id,
    event_id: d.event_id,
    event_type: d.event_type,
    status: d.status,
    attempts: d.attempts,
    response_status: d.response_status,
    last_attempt_at: d.last_attempt_at,
    next_attempt_at: d.next_attempt_at,
    delivered_at: d.delivered_at,
    created_at: d.created_at,
    payload: d.payload,
  };
}

function validateEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return 'events must be a non-empty array.';
  for (const e of events) {
    if (e !== '*' && !EVENT_TYPES.includes(e)) return `Unknown event "${e}". Valid: ${['*', ...EVENT_TYPES].join(', ')}.`;
  }
  return null;
}

// List the event catalog.
router.get('/events', (req, res) => res.json({ data: EVENT_TYPES }));

router.post('/webhooks', requireScope('read_write'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.url || !isSafeWebhookUrl(b.url)) return fail(res, 400, 'invalid_request', 'url must be a public http(s) URL (no localhost or private addresses).');
    const events = b.events || ['*'];
    const evErr = validateEvents(events);
    if (evErr) return fail(res, 400, 'invalid_request', evErr);

    const secret = 'whsec_' + require('crypto').randomBytes(24).toString('hex');
    const { data, error } = await supabase
      .from('agency_webhooks')
      .insert({
        agency_id: req.agency.id, url: b.url, events,
        secret, description: (b.description || '').slice(0, 200) || null, status: 'active',
      })
      .select().single();
    if (error) return fail(res, 400, 'api_error', error.message);
    // secret is returned ONCE, at creation, for signature verification.
    return res.status(201).json({ ...toPublicWebhook(data), secret });
  } catch (err) {
    console.error('v1 POST /webhooks:', err);
    return fail(res, 500, 'api_error', 'Failed to create webhook.');
  }
});

router.get('/webhooks', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('agency_webhooks').select('*')
      .eq('agency_id', req.agency.id).order('created_at', { ascending: false });
    if (error) return fail(res, 400, 'api_error', error.message);
    return res.json({ data: (data || []).map(toPublicWebhook) });
  } catch (err) {
    console.error('v1 GET /webhooks:', err);
    return fail(res, 500, 'api_error', 'Failed to list webhooks.');
  }
});

async function ownedWebhook(agencyId, id) {
  const { data } = await supabase
    .from('agency_webhooks').select('*').eq('id', id).eq('agency_id', agencyId).single();
  return data || null;
}

router.get('/webhooks/:id', async (req, res) => {
  const w = await ownedWebhook(req.agency.id, req.params.id);
  if (!w) return fail(res, 404, 'not_found', 'Webhook not found.');
  return res.json(toPublicWebhook(w));
});

router.patch('/webhooks/:id', requireScope('read_write'), async (req, res) => {
  try {
    const w = await ownedWebhook(req.agency.id, req.params.id);
    if (!w) return fail(res, 404, 'not_found', 'Webhook not found.');
    const b = req.body || {};
    const updates = {};
    if (b.url !== undefined) {
      if (!isSafeWebhookUrl(b.url)) return fail(res, 400, 'invalid_request', 'url must be a public http(s) URL (no localhost or private addresses).');
      updates.url = b.url;
    }
    if (b.events !== undefined) {
      const evErr = validateEvents(b.events);
      if (evErr) return fail(res, 400, 'invalid_request', evErr);
      updates.events = b.events;
    }
    if (b.status !== undefined) {
      if (!['active', 'disabled'].includes(b.status)) return fail(res, 400, 'invalid_request', "status must be 'active' or 'disabled'.");
      updates.status = b.status;
    }
    if (b.description !== undefined) updates.description = (b.description || '').slice(0, 200) || null;
    if (Object.keys(updates).length === 0) return fail(res, 400, 'invalid_request', 'No updatable fields provided.');

    const { data, error } = await supabase
      .from('agency_webhooks').update(updates).eq('id', req.params.id).eq('agency_id', req.agency.id)
      .select().single();
    if (error) return fail(res, 400, 'api_error', error.message);
    return res.json(toPublicWebhook(data));
  } catch (err) {
    console.error('v1 PATCH /webhooks/:id:', err);
    return fail(res, 500, 'api_error', 'Failed to update webhook.');
  }
});

router.delete('/webhooks/:id', requireScope('read_write'), async (req, res) => {
  const w = await ownedWebhook(req.agency.id, req.params.id);
  if (!w) return fail(res, 404, 'not_found', 'Webhook not found.');
  const { error } = await supabase.from('agency_webhooks').delete().eq('id', req.params.id).eq('agency_id', req.agency.id);
  if (error) return fail(res, 400, 'api_error', error.message);
  return res.json({ deleted: true, id: req.params.id });
});

// Recent delivery attempts for one webhook (debugging).
router.get('/webhooks/:id/deliveries', async (req, res) => {
  try {
    const w = await ownedWebhook(req.agency.id, req.params.id);
    if (!w) return fail(res, 404, 'not_found', 'Webhook not found.');
    const { limit, cursor } = parsePagination(req);
    let q = supabase
      .from('webhook_deliveries').select('*')
      .eq('webhook_id', req.params.id)
      .order('created_at', { ascending: false }).limit(limit + 1);
    if (cursor) q = q.lt('created_at', cursor);
    const { data, error } = await q;
    if (error) return fail(res, 400, 'api_error', error.message);
    return sendList(res, data, limit, toPublicDelivery);
  } catch (err) {
    console.error('v1 GET /webhooks/:id/deliveries:', err);
    return fail(res, 500, 'api_error', 'Failed to list deliveries.');
  }
});

// Send a test event to the endpoint.
router.post('/webhooks/:id/ping', requireScope('read_write'), async (req, res) => {
  try {
    const w = await ownedWebhook(req.agency.id, req.params.id);
    if (!w) return fail(res, 404, 'not_found', 'Webhook not found.');
    const result = await sendPing(w);
    return res.json({ ok: result.ok, delivery_id: result.delivery_id || null });
  } catch (err) {
    console.error('v1 POST /webhooks/:id/ping:', err);
    return fail(res, 500, 'api_error', 'Failed to send test event.');
  }
});


// ----------------------------------------------------------------------------
// Services (client_services; AI-facing service menu). Scoped via client
// ownership, then by client_id on the row. Shapes and validation mirror the
// dashboard route (routes/client-services.js) so API and dashboard writes are
// identical and the assistant reads them the same way.
// ----------------------------------------------------------------------------
const SERVICE_BOOKING_MODES = ['auto_book', 'collect_request', 'disabled'];

function toPublicService(s) {
  return {
    id: s.id,
    client_id: s.client_id,
    name: s.name,
    price: s.price,
    description: s.description,
    duration_minutes: s.duration_minutes,
    buffer_minutes: s.buffer_minutes,
    booking_mode: s.booking_mode,
    assigned_staff: s.assigned_staff || [],
    is_active: s.is_active,
    sort_order: s.sort_order,
    created_at: s.created_at,
  };
}

router.get('/clients/:id/services', async (req, res) => {
  try {
    if (!(await ownedClient(req.agency.id, req.params.id, 'id'))) return fail(res, 404, 'not_found', 'Client not found.');
    const { data, error } = await supabase
      .from('client_services').select('*')
      .eq('client_id', req.params.id).order('sort_order', { ascending: true });
    if (error) return fail(res, 400, 'api_error', error.message);
    return res.json({ data: (data || []).map(toPublicService) });
  } catch (err) {
    console.error('v1 GET services:', err);
    return fail(res, 500, 'api_error', 'Failed to list services.');
  }
});

router.post('/clients/:id/services', requireScope('read_write'), async (req, res) => {
  try {
    if (!(await ownedClient(req.agency.id, req.params.id, 'id'))) return fail(res, 404, 'not_found', 'Client not found.');
    const b = req.body || {};
    if (!b.name || !String(b.name).trim()) return fail(res, 400, 'invalid_request', 'name is required.');
    if (b.booking_mode && !SERVICE_BOOKING_MODES.includes(b.booking_mode)) {
      return fail(res, 400, 'invalid_request', `booking_mode must be one of: ${SERVICE_BOOKING_MODES.join(', ')}.`);
    }
    const { data: existing } = await supabase
      .from('client_services').select('sort_order')
      .eq('client_id', req.params.id).order('sort_order', { ascending: false }).limit(1);
    const nextOrder = existing && existing.length ? (existing[0].sort_order || 0) + 1 : 0;
    const row = {
      client_id: req.params.id,
      name: String(b.name).trim(),
      price: (b.price === undefined || b.price === null || String(b.price).trim() === '') ? null : String(b.price).trim().slice(0, 100),
      description: (b.description === undefined || b.description === null || String(b.description).trim() === '') ? null : String(b.description).trim().slice(0, 500),
      duration_minutes: b.duration_minutes || 30,
      buffer_minutes: b.buffer_minutes || 0,
      booking_mode: b.booking_mode || 'auto_book',
      assigned_staff: Array.isArray(b.assigned_staff) ? b.assigned_staff : [],
      is_active: true,
      sort_order: nextOrder,
    };
    const { data, error } = await supabase.from('client_services').insert(row).select().single();
    if (error) return fail(res, 400, 'api_error', error.message);
    return res.status(201).json(toPublicService(data));
  } catch (err) {
    console.error('v1 POST services:', err);
    return fail(res, 500, 'api_error', 'Failed to create service.');
  }
});

router.patch('/clients/:id/services/:serviceId', requireScope('read_write'), async (req, res) => {
  try {
    if (!(await ownedClient(req.agency.id, req.params.id, 'id'))) return fail(res, 404, 'not_found', 'Client not found.');
    const b = req.body || {};
    const updates = {};
    if (b.name !== undefined) { if (!String(b.name).trim()) return fail(res, 400, 'invalid_request', 'name cannot be empty.'); updates.name = String(b.name).trim(); }
    if (b.price !== undefined) updates.price = (b.price === null || String(b.price).trim() === '') ? null : String(b.price).trim().slice(0, 100);
    if (b.description !== undefined) updates.description = (b.description === null || String(b.description).trim() === '') ? null : String(b.description).trim().slice(0, 500);
    if (b.duration_minutes !== undefined) { const d = parseInt(b.duration_minutes, 10); if (isNaN(d) || d < 5 || d > 480) return fail(res, 400, 'invalid_request', 'duration_minutes must be 5-480.'); updates.duration_minutes = d; }
    if (b.buffer_minutes !== undefined) { const bf = parseInt(b.buffer_minutes, 10); if (isNaN(bf) || bf < 0 || bf > 120) return fail(res, 400, 'invalid_request', 'buffer_minutes must be 0-120.'); updates.buffer_minutes = bf; }
    if (b.booking_mode !== undefined) { if (!SERVICE_BOOKING_MODES.includes(b.booking_mode)) return fail(res, 400, 'invalid_request', `booking_mode must be one of: ${SERVICE_BOOKING_MODES.join(', ')}.`); updates.booking_mode = b.booking_mode; }
    if (b.assigned_staff !== undefined) { if (!Array.isArray(b.assigned_staff)) return fail(res, 400, 'invalid_request', 'assigned_staff must be an array.'); updates.assigned_staff = b.assigned_staff; }
    if (b.is_active !== undefined) updates.is_active = b.is_active === true;
    if (Object.keys(updates).length === 0) return fail(res, 400, 'invalid_request', 'No updatable fields provided.');
    const { data, error } = await supabase
      .from('client_services').update(updates).eq('id', req.params.serviceId).eq('client_id', req.params.id).select().single();
    if (error) return fail(res, 400, 'api_error', error.message);
    if (!data) return fail(res, 404, 'not_found', 'Service not found.');
    return res.json(toPublicService(data));
  } catch (err) {
    console.error('v1 PATCH service:', err);
    return fail(res, 500, 'api_error', 'Failed to update service.');
  }
});

router.delete('/clients/:id/services/:serviceId', requireScope('read_write'), async (req, res) => {
  try {
    if (!(await ownedClient(req.agency.id, req.params.id, 'id'))) return fail(res, 404, 'not_found', 'Client not found.');
    const { error } = await supabase.from('client_services').delete().eq('id', req.params.serviceId).eq('client_id', req.params.id);
    if (error) return fail(res, 400, 'api_error', error.message);
    return res.json({ deleted: true, id: req.params.serviceId });
  } catch (err) {
    console.error('v1 DELETE service:', err);
    return fail(res, 500, 'api_error', 'Failed to delete service.');
  }
});

// ----------------------------------------------------------------------------
// Staff (staff_members; the AI's provider DIRECTORY, not dashboard users).
// Mirrors routes/staff-members.js, including cleaning a deleted member out of
// every service's assigned_staff so no service points at a ghost.
// ----------------------------------------------------------------------------
function toPublicStaff(s) {
  return {
    id: s.id,
    client_id: s.client_id,
    name: s.name,
    role: s.role,
    phone: s.phone,
    email: s.email,
    notes: s.notes,
    available_hours: s.available_hours || {},
    transferable: s.transferable === true,
    transfer_criteria: s.transfer_criteria,
    is_active: s.is_active,
    created_at: s.created_at,
  };
}

router.get('/clients/:id/staff', async (req, res) => {
  try {
    if (!(await ownedClient(req.agency.id, req.params.id, 'id'))) return fail(res, 404, 'not_found', 'Client not found.');
    const { data, error } = await supabase
      .from('staff_members').select('*')
      .eq('client_id', req.params.id).order('created_at', { ascending: true });
    if (error) return fail(res, 400, 'api_error', error.message);
    return res.json({ data: (data || []).map(toPublicStaff) });
  } catch (err) {
    console.error('v1 GET staff:', err);
    return fail(res, 500, 'api_error', 'Failed to list staff.');
  }
});

router.post('/clients/:id/staff', requireScope('read_write'), async (req, res) => {
  try {
    if (!(await ownedClient(req.agency.id, req.params.id, 'id'))) return fail(res, 404, 'not_found', 'Client not found.');
    const b = req.body || {};
    if (!b.name || !String(b.name).trim()) return fail(res, 400, 'invalid_request', 'name is required.');
    const row = {
      client_id: req.params.id,
      name: String(b.name).trim(),
      role: b.role ? String(b.role).trim() : null,
      phone: b.phone ? String(b.phone).trim() : null,
      email: b.email ? String(b.email).trim().toLowerCase() : null,
      notes: b.notes ? String(b.notes).trim() : null,
      available_hours: (b.available_hours && typeof b.available_hours === 'object') ? b.available_hours : {},
      services: [],
      is_active: true,
      transferable: b.transferable === true,
      transfer_criteria: b.transfer_criteria ? String(b.transfer_criteria).trim() : null,
    };
    const { data, error } = await supabase.from('staff_members').insert(row).select().single();
    if (error) return fail(res, 400, 'api_error', error.message);
    return res.status(201).json(toPublicStaff(data));
  } catch (err) {
    console.error('v1 POST staff:', err);
    return fail(res, 500, 'api_error', 'Failed to create staff member.');
  }
});

router.patch('/clients/:id/staff/:staffId', requireScope('read_write'), async (req, res) => {
  try {
    if (!(await ownedClient(req.agency.id, req.params.id, 'id'))) return fail(res, 404, 'not_found', 'Client not found.');
    const b = req.body || {};
    const updates = {};
    if (b.name !== undefined) { if (!String(b.name).trim()) return fail(res, 400, 'invalid_request', 'name cannot be empty.'); updates.name = String(b.name).trim(); }
    if (b.role !== undefined) updates.role = b.role ? String(b.role).trim() : null;
    if (b.phone !== undefined) updates.phone = b.phone ? String(b.phone).trim() : null;
    if (b.email !== undefined) updates.email = b.email ? String(b.email).trim().toLowerCase() : null;
    if (b.notes !== undefined) updates.notes = b.notes ? String(b.notes).trim() : null;
    if (b.available_hours !== undefined) { if (typeof b.available_hours !== 'object' || b.available_hours === null) return fail(res, 400, 'invalid_request', 'available_hours must be an object.'); updates.available_hours = b.available_hours; }
    if (b.is_active !== undefined) updates.is_active = b.is_active === true;
    if (b.transferable !== undefined) updates.transferable = b.transferable === true;
    if (b.transfer_criteria !== undefined) updates.transfer_criteria = b.transfer_criteria ? String(b.transfer_criteria).trim() : null;
    if (Object.keys(updates).length === 0) return fail(res, 400, 'invalid_request', 'No updatable fields provided.');
    const { data, error } = await supabase
      .from('staff_members').update(updates).eq('id', req.params.staffId).eq('client_id', req.params.id).select().single();
    if (error) return fail(res, 400, 'api_error', error.message);
    if (!data) return fail(res, 404, 'not_found', 'Staff member not found.');
    return res.json(toPublicStaff(data));
  } catch (err) {
    console.error('v1 PATCH staff:', err);
    return fail(res, 500, 'api_error', 'Failed to update staff member.');
  }
});

router.delete('/clients/:id/staff/:staffId', requireScope('read_write'), async (req, res) => {
  try {
    if (!(await ownedClient(req.agency.id, req.params.id, 'id'))) return fail(res, 404, 'not_found', 'Client not found.');
    // Unassign this member from any service that references them, so nothing
    // points at a deleted id (same cleanup the dashboard delete does).
    const { data: services } = await supabase
      .from('client_services').select('id, assigned_staff').eq('client_id', req.params.id);
    for (const svc of (services || [])) {
      if (Array.isArray(svc.assigned_staff) && svc.assigned_staff.includes(req.params.staffId)) {
        await supabase.from('client_services')
          .update({ assigned_staff: svc.assigned_staff.filter((x) => x !== req.params.staffId) })
          .eq('id', svc.id);
      }
    }
    const { error } = await supabase.from('staff_members').delete().eq('id', req.params.staffId).eq('client_id', req.params.id);
    if (error) return fail(res, 400, 'api_error', error.message);
    return res.json({ deleted: true, id: req.params.staffId });
  } catch (err) {
    console.error('v1 DELETE staff:', err);
    return fail(res, 500, 'api_error', 'Failed to delete staff member.');
  }
});

// ----------------------------------------------------------------------------
// Business hours (clients.business_hours jsonb). GET/PUT the whole object; the
// assistant reads it live, so a write takes effect on the next call.
// ----------------------------------------------------------------------------
router.get('/clients/:id/hours', async (req, res) => {
  try {
    const c = await ownedClient(req.agency.id, req.params.id, 'id, business_hours, timezone');
    if (!c) return fail(res, 404, 'not_found', 'Client not found.');
    return res.json({ client_id: c.id, timezone: c.timezone || null, business_hours: c.business_hours || null });
  } catch (err) {
    console.error('v1 GET hours:', err);
    return fail(res, 500, 'api_error', 'Failed to fetch hours.');
  }
});

router.put('/clients/:id/hours', requireScope('read_write'), async (req, res) => {
  try {
    if (!(await ownedClient(req.agency.id, req.params.id, 'id'))) return fail(res, 404, 'not_found', 'Client not found.');
    const b = req.body || {};
    if (b.business_hours === undefined) return fail(res, 400, 'invalid_request', 'business_hours is required.');
    if (b.business_hours !== null && typeof b.business_hours !== 'object') return fail(res, 400, 'invalid_request', 'business_hours must be an object or null.');
    const { data, error } = await supabase
      .from('clients').update({ business_hours: b.business_hours }).eq('id', req.params.id).eq('agency_id', req.agency.id)
      .select('id, business_hours').single();
    if (error) return fail(res, 400, 'api_error', error.message);
    return res.json({ client_id: data.id, business_hours: data.business_hours });
  } catch (err) {
    console.error('v1 PUT hours:', err);
    return fail(res, 500, 'api_error', 'Failed to update hours.');
  }
});

// ----------------------------------------------------------------------------
// Booking rules (clients: booking_mode + the booking window + default length).
// ----------------------------------------------------------------------------
const CLIENT_BOOKING_MODES = ['auto_book', 'collect_request', 'disabled'];

router.get('/clients/:id/booking', async (req, res) => {
  try {
    const c = await ownedClient(req.agency.id, req.params.id, 'id, booking_mode, min_booking_notice_minutes, max_booking_days_ahead, appointment_duration');
    if (!c) return fail(res, 404, 'not_found', 'Client not found.');
    return res.json({
      client_id: c.id,
      booking_mode: c.booking_mode,
      min_booking_notice_minutes: c.min_booking_notice_minutes,
      max_booking_days_ahead: c.max_booking_days_ahead,
      appointment_duration: c.appointment_duration,
    });
  } catch (err) {
    console.error('v1 GET booking:', err);
    return fail(res, 500, 'api_error', 'Failed to fetch booking rules.');
  }
});

router.patch('/clients/:id/booking', requireScope('read_write'), async (req, res) => {
  try {
    if (!(await ownedClient(req.agency.id, req.params.id, 'id'))) return fail(res, 404, 'not_found', 'Client not found.');
    const b = req.body || {};
    const updates = {};
    if (b.booking_mode !== undefined) {
      if (!CLIENT_BOOKING_MODES.includes(b.booking_mode)) return fail(res, 400, 'invalid_request', `booking_mode must be one of: ${CLIENT_BOOKING_MODES.join(', ')}.`);
      updates.booking_mode = b.booking_mode;
    }
    if (b.min_booking_notice_minutes !== undefined) {
      if (b.min_booking_notice_minutes === null) updates.min_booking_notice_minutes = null;
      else { const n = parseInt(b.min_booking_notice_minutes, 10); if (isNaN(n) || n < 0 || n > 20160) return fail(res, 400, 'invalid_request', 'min_booking_notice_minutes must be 0-20160 (up to 14 days).'); updates.min_booking_notice_minutes = n; }
    }
    if (b.max_booking_days_ahead !== undefined) {
      if (b.max_booking_days_ahead === null) updates.max_booking_days_ahead = null;
      else { const n = parseInt(b.max_booking_days_ahead, 10); if (isNaN(n) || n < 1 || n > 365) return fail(res, 400, 'invalid_request', 'max_booking_days_ahead must be 1-365.'); updates.max_booking_days_ahead = n; }
    }
    if (b.appointment_duration !== undefined) {
      if (b.appointment_duration === null) updates.appointment_duration = null;
      else { const n = parseInt(b.appointment_duration, 10); if (isNaN(n) || n < 5 || n > 480) return fail(res, 400, 'invalid_request', 'appointment_duration must be 5-480 minutes.'); updates.appointment_duration = n; }
    }
    if (Object.keys(updates).length === 0) return fail(res, 400, 'invalid_request', 'No updatable fields provided.');
    const { data, error } = await supabase
      .from('clients').update(updates).eq('id', req.params.id).eq('agency_id', req.agency.id)
      .select('id, booking_mode, min_booking_notice_minutes, max_booking_days_ahead, appointment_duration').single();
    if (error) return fail(res, 400, 'api_error', error.message);
    return res.json({
      client_id: data.id,
      booking_mode: data.booking_mode,
      min_booking_notice_minutes: data.min_booking_notice_minutes,
      max_booking_days_ahead: data.max_booking_days_ahead,
      appointment_duration: data.appointment_duration,
    });
  } catch (err) {
    console.error('v1 PATCH booking:', err);
    return fail(res, 500, 'api_error', 'Failed to update booking rules.');
  }
});

// ----------------------------------------------------------------------------
// Escalation routing (how/when the AI hands a live caller to a human).
// forwarding_mode + human_handoff + transfer_phone + ring_timeout + priority_rules
// are all read by the assistant at call time.
// ----------------------------------------------------------------------------
router.get('/clients/:id/escalation', async (req, res) => {
  try {
    const c = await ownedClient(req.agency.id, req.params.id, 'id, forwarding_mode, human_handoff, transfer_phone, ring_timeout, priority_rules');
    if (!c) return fail(res, 404, 'not_found', 'Client not found.');
    return res.json({
      client_id: c.id,
      forwarding_mode: c.forwarding_mode,
      human_handoff: c.human_handoff,
      transfer_phone: c.transfer_phone,
      ring_timeout: c.ring_timeout,
      priority_rules: c.priority_rules || null,
    });
  } catch (err) {
    console.error('v1 GET escalation:', err);
    return fail(res, 500, 'api_error', 'Failed to fetch escalation routing.');
  }
});

router.patch('/clients/:id/escalation', requireScope('read_write'), async (req, res) => {
  try {
    if (!(await ownedClient(req.agency.id, req.params.id, 'id'))) return fail(res, 404, 'not_found', 'Client not found.');
    const b = req.body || {};
    const updates = {};
    if (b.forwarding_mode !== undefined) {
      if (!['all', 'missed'].includes(b.forwarding_mode)) return fail(res, 400, 'invalid_request', "forwarding_mode must be 'all' or 'missed'.");
      updates.forwarding_mode = b.forwarding_mode;
    }
    if (b.human_handoff !== undefined) {
      if (!['transfer', 'message'].includes(b.human_handoff)) return fail(res, 400, 'invalid_request', "human_handoff must be 'transfer' or 'message'.");
      updates.human_handoff = b.human_handoff;
    }
    if (b.transfer_phone !== undefined) {
      const norm = normalizePhoneOrError(b.transfer_phone);
      if (norm.error) return fail(res, 400, 'invalid_request', 'transfer_' + norm.error);
      updates.transfer_phone = norm.value;
    }
    if (b.ring_timeout !== undefined) {
      const n = parseInt(b.ring_timeout, 10);
      if (isNaN(n) || n < 5 || n > 120) return fail(res, 400, 'invalid_request', 'ring_timeout must be 5-120 seconds.');
      updates.ring_timeout = n;
    }
    if (b.priority_rules !== undefined) {
      if (b.priority_rules !== null && typeof b.priority_rules !== 'object') return fail(res, 400, 'invalid_request', 'priority_rules must be an object/array or null.');
      updates.priority_rules = b.priority_rules;
    }
    if (Object.keys(updates).length === 0) return fail(res, 400, 'invalid_request', 'No updatable fields provided.');
    const { data, error } = await supabase
      .from('clients').update(updates).eq('id', req.params.id).eq('agency_id', req.agency.id)
      .select('id, forwarding_mode, human_handoff, transfer_phone, ring_timeout, priority_rules').single();
    if (error) return fail(res, 400, 'api_error', error.message);
    return res.json({
      client_id: data.id,
      forwarding_mode: data.forwarding_mode,
      human_handoff: data.human_handoff,
      transfer_phone: data.transfer_phone,
      ring_timeout: data.ring_timeout,
      priority_rules: data.priority_rules || null,
    });
  } catch (err) {
    console.error('v1 PATCH escalation:', err);
    return fail(res, 500, 'api_error', 'Failed to update escalation routing.');
  }
});

// ----------------------------------------------------------------------------
// Calendar connection (Google). OAuth needs the client to grant access in a
// browser, so the API hands back a connect link rather than connecting headless.
// Status and disconnect are fully server-side.
// ----------------------------------------------------------------------------
router.get('/clients/:id/calendar', async (req, res) => {
  try {
    const c = await ownedClient(req.agency.id, req.params.id, 'id, google_calendar_connected, google_calendar_email, google_refresh_token');
    if (!c) return fail(res, 404, 'not_found', 'Client not found.');
    let tokenValid = false;
    if (c.google_calendar_connected && c.google_refresh_token) {
      try {
        const { refreshAccessToken } = require('../../lib/calendar-booking');
        tokenValid = !!(await refreshAccessToken(c));
      } catch (e) { tokenValid = true; } // transient failure: do not nag a reconnect
    }
    return res.json({
      client_id: c.id,
      provider: 'google',
      connected: c.google_calendar_connected === true,
      token_valid: tokenValid,
      email: c.google_calendar_email || null,
    });
  } catch (err) {
    console.error('v1 GET calendar:', err);
    return fail(res, 500, 'api_error', 'Failed to fetch calendar status.');
  }
});

router.post('/clients/:id/calendar/connect-link', requireScope('read_write'), async (req, res) => {
  try {
    if (!(await ownedClient(req.agency.id, req.params.id, 'id'))) return fail(res, 404, 'not_found', 'Client not found.');
    // The client opens this URL, grants Google access, and our callback stores
    // the tokens and wires the booking tool onto the assistant. Direct OAuth is
    // not possible server-to-server (it needs the account owner's consent).
    const connectUrl = `${BACKEND_URL}/api/auth/google-calendar/connect?clientId=${encodeURIComponent(req.params.id)}`;
    return res.json({
      client_id: req.params.id,
      connect_url: connectUrl,
      note: 'Have the business owner open this link and grant Google Calendar access. Poll GET /clients/:id/calendar for connected=true.',
    });
  } catch (err) {
    console.error('v1 POST calendar connect-link:', err);
    return fail(res, 500, 'api_error', 'Failed to build connect link.');
  }
});

router.delete('/clients/:id/calendar', requireScope('read_write'), async (req, res) => {
  try {
    const c = await ownedClient(req.agency.id, req.params.id, 'id, google_access_token, vapi_assistant_id');
    if (!c) return fail(res, 404, 'not_found', 'Client not found.');
    // Best-effort revoke with Google.
    if (c.google_access_token) {
      try {
        await fetch(`https://oauth2.googleapis.com/revoke?token=${c.google_access_token}`, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
      } catch (e) { /* non-blocking */ }
    }
    const { error } = await supabase.from('clients').update({
      google_calendar_connected: false,
      google_access_token: null,
      google_refresh_token: null,
      google_token_expires_at: null,
      google_calendar_id: null,
      google_calendar_email: null,
      updated_at: new Date().toISOString(),
    }).eq('id', req.params.id).eq('agency_id', req.agency.id);
    if (error) return fail(res, 400, 'api_error', error.message);
    // Remove the booking tool from the assistant so it stops offering booking.
    if (c.vapi_assistant_id) {
      try {
        const { updateAssistantCalendar } = require('../../lib/calendar-tools');
        updateAssistantCalendar(c.vapi_assistant_id, req.params.id, false).catch(() => {});
      } catch (e) { /* non-blocking */ }
    }
    return res.json({ client_id: req.params.id, disconnected: true });
  } catch (err) {
    console.error('v1 DELETE calendar:', err);
    return fail(res, 500, 'api_error', 'Failed to disconnect calendar.');
  }
});

// ----------------------------------------------------------------------------
// Branding (agency white-label). Writes the same columns the dashboard settings
// page does; scoped to the key's own agency (never a body-supplied id).
// ----------------------------------------------------------------------------
const BRANDING_COLUMNS = 'id, name, logo_url, favicon_url, app_name, app_icon_url, primary_color, secondary_color, accent_color, website_theme, logo_background_color, branding_overrides, allow_client_branding, marketing_domain, domain_verified';

function toPublicBranding(a) {
  return {
    agency_id: a.id,
    name: a.name,
    logo_url: a.logo_url,
    favicon_url: a.favicon_url,
    app_name: a.app_name,
    app_icon_url: a.app_icon_url,
    primary_color: a.primary_color,
    secondary_color: a.secondary_color,
    accent_color: a.accent_color,
    website_theme: a.website_theme,
    logo_background_color: a.logo_background_color,
    branding_overrides: a.branding_overrides || null,
    allow_client_branding: a.allow_client_branding === true,
    marketing_domain: a.marketing_domain || null,
    domain_verified: a.domain_verified === true,
  };
}

router.get('/branding', async (req, res) => {
  try {
    const { data, error } = await supabase.from('agencies').select(BRANDING_COLUMNS).eq('id', req.agency.id).single();
    if (error || !data) return fail(res, 400, 'api_error', (error && error.message) || 'Failed to load branding.');
    return res.json(toPublicBranding(data));
  } catch (err) {
    console.error('v1 GET branding:', err);
    return fail(res, 500, 'api_error', 'Failed to fetch branding.');
  }
});

router.patch('/branding', requireScope('read_write'), async (req, res) => {
  try {
    const b = req.body || {};
    const updates = {};
    const strFields = ['name', 'logo_url', 'favicon_url', 'app_name', 'app_icon_url', 'primary_color', 'secondary_color', 'accent_color', 'logo_background_color'];
    for (const f of strFields) {
      if (b[f] !== undefined) updates[f] = (b[f] === null || b[f] === '') ? null : String(b[f]);
    }
    if (b.website_theme !== undefined) {
      if (!['light', 'dark'].includes(b.website_theme)) return fail(res, 400, 'invalid_request', "website_theme must be 'light' or 'dark'.");
      updates.website_theme = b.website_theme;
    }
    if (b.allow_client_branding !== undefined) updates.allow_client_branding = b.allow_client_branding === true;
    if (b.branding_overrides !== undefined) {
      if (b.branding_overrides !== null && typeof b.branding_overrides !== 'object') return fail(res, 400, 'invalid_request', 'branding_overrides must be an object or null.');
      updates.branding_overrides = b.branding_overrides;
    }
    if (b.name !== undefined && (updates.name === null || !String(b.name).trim())) {
      return fail(res, 400, 'invalid_request', 'name cannot be empty.');
    }
    if (Object.keys(updates).length === 0) return fail(res, 400, 'invalid_request', 'No updatable branding fields provided.');
    const { data, error } = await supabase.from('agencies').update(updates).eq('id', req.agency.id).select(BRANDING_COLUMNS).single();
    if (error) return fail(res, 400, 'api_error', error.message);
    return res.json(toPublicBranding(data));
  } catch (err) {
    console.error('v1 PATCH branding:', err);
    return fail(res, 500, 'api_error', 'Failed to update branding.');
  }
});


module.exports = router;
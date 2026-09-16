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
const {
  apiKeyAuth, requireScope, fail,
  parsePagination, sendList, toPublicClient, toPublicCall,
} = require('../../middleware/api-auth');
const { EVENT_TYPES, sendPing } = require('../../lib/webhooks');

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
    const allowed = ['business_name', 'industry', 'business_city', 'business_state', 'country', 'business_website', 'owner_name', 'owner_phone', 'notification_phone', 'email'];
    const updates = {};
    for (const f of allowed) if (b[f] !== undefined) updates[f] = b[f];
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
    if (!b.url || !/^https?:\/\//i.test(b.url)) return fail(res, 400, 'invalid_request', 'url must be an http(s) URL.');
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
      if (!/^https?:\/\//i.test(b.url)) return fail(res, 400, 'invalid_request', 'url must be an http(s) URL.');
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


module.exports = router;
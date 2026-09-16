// agency-webhooks.js - session-authenticated webhook management for the dashboard.
//
// Mirrors agency-api-keys.js: the /api/v1/webhooks endpoints are for API-key
// callers, these are for the logged-in agency managing webhooks in the UI.
// Both read/write the same agency_webhooks table and share the webhooks lib.

const crypto = require('crypto');
const { supabase } = require('../lib/supabase');
const { hasScale } = require('../middleware/api-auth');
const { EVENT_TYPES, sendPing, isSafeWebhookUrl } = require('../lib/webhooks');

async function getAgencyPlan(agencyId) {
  const { data } = await supabase
    .from('agencies').select('id, plan_type, subscription_status').eq('id', agencyId).single();
  return data || null;
}

function scaleGate(agency, res) {
  if (!agency) { res.status(404).json({ error: 'Agency not found' }); return false; }
  if (!hasScale(agency)) {
    res.status(403).json({
      error: 'upgrade_required', upgrade_required: true,
      message: 'Webhooks are a Scale plan feature. Upgrade to enable them.',
      current_plan: agency.plan_type,
    });
    return false;
  }
  return true;
}

function validateEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return 'Select at least one event.';
  for (const e of events) {
    if (e !== '*' && !EVENT_TYPES.includes(e)) return `Unknown event "${e}".`;
  }
  return null;
}

function toPublicWebhook(w) {
  return {
    id: w.id, url: w.url, events: w.events, status: w.status, description: w.description,
    created_at: w.created_at, last_delivery_at: w.last_delivery_at, last_error: w.last_error,
  };
}

// POST /api/agency/:agencyId/webhooks
async function createWebhook(req, res) {
  try {
    const { agencyId } = req.params;
    const agency = await getAgencyPlan(agencyId);
    if (!scaleGate(agency, res)) return;

    const b = req.body || {};
    if (!b.url || !isSafeWebhookUrl(b.url)) return res.status(400).json({ error: 'Enter a valid public http(s) URL (no localhost or private addresses).' });
    const events = b.events && b.events.length ? b.events : ['*'];
    const evErr = validateEvents(events);
    if (evErr) return res.status(400).json({ error: evErr });

    const secret = 'whsec_' + crypto.randomBytes(24).toString('hex');
    const { data, error } = await supabase
      .from('agency_webhooks')
      .insert({ agency_id: agencyId, url: b.url, events, secret, description: (b.description || '').slice(0, 200) || null, status: 'active' })
      .select().single();
    if (error) return res.status(400).json({ error: error.message });
    return res.status(201).json({ ...toPublicWebhook(data), secret }); // secret shown once
  } catch (err) {
    console.error('createWebhook error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// GET /api/agency/:agencyId/webhooks
async function listWebhooks(req, res) {
  try {
    const { agencyId } = req.params;
    const { data, error } = await supabase
      .from('agency_webhooks').select('*')
      .eq('agency_id', agencyId).order('created_at', { ascending: false });
    if (error) return res.status(400).json({ error: error.message });
    return res.json({ webhooks: (data || []).map(toPublicWebhook), events: EVENT_TYPES });
  } catch (err) {
    console.error('listWebhooks error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// PATCH /api/agency/:agencyId/webhooks/:webhookId
async function updateWebhook(req, res) {
  try {
    const { agencyId, webhookId } = req.params;
    const b = req.body || {};
    const updates = {};
    if (b.url !== undefined) {
      if (!isSafeWebhookUrl(b.url)) return res.status(400).json({ error: 'Enter a valid public http(s) URL (no localhost or private addresses).' });
      updates.url = b.url;
    }
    if (b.events !== undefined) {
      const evErr = validateEvents(b.events);
      if (evErr) return res.status(400).json({ error: evErr });
      updates.events = b.events;
    }
    if (b.status !== undefined) {
      if (!['active', 'disabled'].includes(b.status)) return res.status(400).json({ error: 'Invalid status.' });
      updates.status = b.status;
    }
    if (b.description !== undefined) updates.description = (b.description || '').slice(0, 200) || null;
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nothing to update.' });

    const { data, error } = await supabase
      .from('agency_webhooks').update(updates).eq('id', webhookId).eq('agency_id', agencyId)
      .select().single();
    if (error || !data) return res.status(404).json({ error: 'Webhook not found' });
    return res.json(toPublicWebhook(data));
  } catch (err) {
    console.error('updateWebhook error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// DELETE /api/agency/:agencyId/webhooks/:webhookId
async function deleteWebhook(req, res) {
  try {
    const { agencyId, webhookId } = req.params;
    const { data, error } = await supabase
      .from('agency_webhooks').delete().eq('id', webhookId).eq('agency_id', agencyId).select('id').single();
    if (error || !data) return res.status(404).json({ error: 'Webhook not found' });
    return res.json({ success: true });
  } catch (err) {
    console.error('deleteWebhook error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// POST /api/agency/:agencyId/webhooks/:webhookId/ping
async function pingWebhook(req, res) {
  try {
    const { agencyId, webhookId } = req.params;
    const { data: hook } = await supabase
      .from('agency_webhooks').select('*').eq('id', webhookId).eq('agency_id', agencyId).single();
    if (!hook) return res.status(404).json({ error: 'Webhook not found' });
    const result = await sendPing(hook);
    return res.json({ ok: result.ok, delivery_id: result.delivery_id || null });
  } catch (err) {
    console.error('pingWebhook error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// GET /api/agency/:agencyId/webhooks/:webhookId/deliveries
async function listWebhookDeliveries(req, res) {
  try {
    const { agencyId, webhookId } = req.params;
    const { data: hook } = await supabase
      .from('agency_webhooks').select('id').eq('id', webhookId).eq('agency_id', agencyId).single();
    if (!hook) return res.status(404).json({ error: 'Webhook not found' });
    const { data, error } = await supabase
      .from('webhook_deliveries')
      .select('id, event_type, status, attempts, response_status, last_attempt_at, delivered_at, created_at')
      .eq('webhook_id', webhookId).order('created_at', { ascending: false }).limit(20);
    if (error) return res.status(400).json({ error: error.message });
    return res.json({ deliveries: data || [] });
  } catch (err) {
    console.error('listWebhookDeliveries error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

module.exports = { createWebhook, listWebhooks, updateWebhook, deleteWebhook, pingWebhook, listWebhookDeliveries };
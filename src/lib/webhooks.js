// webhooks.js, outbound webhook delivery for the agency API.
//
// dispatchWebhook(agencyId, eventType, data) is called from wherever an event
// happens (a call is saved, a client is provisioned). It finds the agency's
// active webhooks subscribed to that event, writes a delivery row, and attempts
// delivery immediately. Failures are retried by processDueWebhookDeliveries(),
// which a cron hits on a schedule.
//
// Payloads are signed: header "X-VoiceAI-Signature: t=<unix>,v1=<hmac>" where
// hmac = HMAC-SHA256(secret, "<t>.<body>"). Consumers recompute and compare.

const crypto = require('crypto');
const { supabase } = require('./supabase');

const EVENT_TYPES = [
  'call.completed',
  'call.transferred',
  'appointment.booked',
  'client.provisioned',
  'client.provisioning_failed',
];

// Retry backoff by attempt number, in minutes. max_attempts defaults to 6.
const BACKOFF_MIN = [1, 5, 30, 120, 360, 720];
const DELIVERY_TIMEOUT_MS = 10000;
const STALE_PROCESSING_MIN = 10; // reclaim rows stuck 'processing' this long

function sign(secret, timestamp, body) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

// Baseline SSRF guard: reject endpoints on loopback / private / link-local ranges
// so a registered webhook cannot be used to probe internal services. Not a full
// defense (no DNS-rebind protection), but blocks the obvious targets.
function isSafeWebhookUrl(url) {
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host === '0.0.0.0' || host.endsWith('.local') || host.endsWith('.internal')) return false;
    const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (m) {
      const a = +m[1], b = +m[2];
      if (a === 127 || a === 10 || a === 0) return false;
      if (a === 192 && b === 168) return false;
      if (a === 169 && b === 254) return false;
      if (a === 172 && b >= 16 && b <= 31) return false;
    }
    if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return false;
    return true;
  } catch (e) { return false; }
}

function isSubscribed(webhook, eventType) {
  const ev = webhook.events || [];
  return ev.includes('*') || ev.includes(eventType);
}

// POST one delivery to its endpoint and record the outcome (success, or schedule
// a retry with backoff, or mark failed when attempts are exhausted).
async function attemptDelivery(delivery, hook) {
  const body = JSON.stringify(delivery.payload);
  const ts = Math.floor(Date.now() / 1000);
  const signature = sign(hook.secret, ts, body);
  const attemptNo = (delivery.attempts || 0) + 1;

  let ok = false, respStatus = null, respBody = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'VoiceAIConnect-Webhooks/1',
        'X-VoiceAI-Signature': `t=${ts},v1=${signature}`,
        'X-VoiceAI-Event': delivery.event_type,
        'X-VoiceAI-Delivery': delivery.id,
      },
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);
    respStatus = res.status;
    ok = res.status >= 200 && res.status < 300;
    try { respBody = (await res.text()).slice(0, 500); } catch (e) {}
  } catch (err) {
    respBody = String((err && err.message) || err).slice(0, 500);
  }

  const now = new Date().toISOString();
  if (ok) {
    await supabase.from('webhook_deliveries').update({
      status: 'success', attempts: attemptNo, response_status: respStatus,
      response_body: respBody, last_attempt_at: now, delivered_at: now,
    }).eq('id', delivery.id);
    await supabase.from('agency_webhooks').update({ last_delivery_at: now, last_error: null }).eq('id', hook.id);
  } else {
    const maxAttempts = delivery.max_attempts || 6;
    const exhausted = attemptNo >= maxAttempts;
    const backoff = BACKOFF_MIN[Math.min(attemptNo - 1, BACKOFF_MIN.length - 1)];
    const nextAt = new Date(Date.now() + backoff * 60000).toISOString();
    await supabase.from('webhook_deliveries').update({
      status: exhausted ? 'failed' : 'pending',
      attempts: attemptNo, response_status: respStatus, response_body: respBody,
      last_attempt_at: now, next_attempt_at: exhausted ? null : nextAt,
    }).eq('id', delivery.id);
    await supabase.from('agency_webhooks').update({ last_delivery_at: now, last_error: respBody }).eq('id', hook.id);
  }
  return ok;
}

// Called from event sources. Non-blocking: never let a webhook slow or break the
// thing that triggered it, so all errors are swallowed and logged.
async function dispatchWebhook(agencyId, eventType, data) {
  try {
    if (!agencyId || !EVENT_TYPES.includes(eventType)) return;
    const { data: hooks } = await supabase
      .from('agency_webhooks').select('*')
      .eq('agency_id', agencyId).eq('status', 'active');
    const targets = (hooks || []).filter((h) => isSubscribed(h, eventType));
    for (const hook of targets) {
      const eventId = crypto.randomUUID();
      const payload = { id: eventId, type: eventType, created_at: new Date().toISOString(), data };
      const { data: delivery } = await supabase
        .from('webhook_deliveries')
        .insert({
          webhook_id: hook.id, agency_id: agencyId, event_type: eventType,
          event_id: eventId, payload, status: 'pending', next_attempt_at: new Date().toISOString(),
        })
        .select().single();
      if (delivery) attemptDelivery(delivery, hook).catch(() => {});
    }
  } catch (err) {
    console.error('dispatchWebhook error:', (err && err.message) || err);
  }
}

// Send a one-off test event to a specific hook (dashboard/API "ping").
async function sendPing(hook) {
  const eventId = crypto.randomUUID();
  const payload = { id: eventId, type: 'ping', created_at: new Date().toISOString(), data: { message: 'Test event from VoiceAI Connect.' } };
  const { data: delivery } = await supabase
    .from('webhook_deliveries')
    .insert({
      webhook_id: hook.id, agency_id: hook.agency_id, event_type: 'ping',
      event_id: eventId, payload, status: 'pending', next_attempt_at: new Date().toISOString(),
    })
    .select().single();
  if (!delivery) return { ok: false };
  const ok = await attemptDelivery(delivery, hook);
  return { ok, delivery_id: delivery.id };
}

// Cron: retry due deliveries. Claims a batch by flipping 'pending' -> 'processing'
// on a fetched id set (only rows still 'pending' flip), so parallel instances do
// not double-send. Also reclaims rows stuck in 'processing' past the stale window.
async function processDueWebhookDeliveries(batchSize = 50) {
  const nowIso = new Date().toISOString();

  // Reclaim stale 'processing' rows (a crash mid-delivery).
  const staleCutoff = new Date(Date.now() - STALE_PROCESSING_MIN * 60000).toISOString();
  await supabase.from('webhook_deliveries')
    .update({ status: 'pending' })
    .eq('status', 'processing').lt('last_attempt_at', staleCutoff);

  const { data: due } = await supabase
    .from('webhook_deliveries')
    .select('id')
    .eq('status', 'pending')
    .lte('next_attempt_at', nowIso)
    .order('next_attempt_at', { ascending: true })
    .limit(batchSize);
  if (!due || due.length === 0) return { processed: 0 };

  const ids = due.map((d) => d.id);
  const { data: claimed } = await supabase
    .from('webhook_deliveries')
    .update({ status: 'processing', last_attempt_at: nowIso })
    .in('id', ids).eq('status', 'pending')
    .select('*');
  if (!claimed || claimed.length === 0) return { processed: 0 };

  const hookIds = [...new Set(claimed.map((d) => d.webhook_id))];
  const { data: hooks } = await supabase.from('agency_webhooks').select('*').in('id', hookIds);
  const hookById = Object.fromEntries((hooks || []).map((h) => [h.id, h]));

  let processed = 0;
  for (const delivery of claimed) {
    const hook = hookById[delivery.webhook_id];
    if (!hook || hook.status !== 'active') {
      await supabase.from('webhook_deliveries').update({ status: 'failed', last_attempt_at: nowIso }).eq('id', delivery.id);
      continue;
    }
    await attemptDelivery(delivery, hook);
    processed += 1;
  }
  return { processed };
}

module.exports = { EVENT_TYPES, sign, dispatchWebhook, sendPing, processDueWebhookDeliveries, isSafeWebhookUrl };
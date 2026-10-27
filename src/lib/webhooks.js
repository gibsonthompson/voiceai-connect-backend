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
const dns = require('dns').promises;
const { supabase } = require('./supabase');

// Public base used to build durable links in stored payloads (the signed
// recording URL expires, so consumers refetch via this stable endpoint).
const BACKEND_URL = process.env.BACKEND_URL || 'https://urchin-app-bqb4i.ondigitalocean.app';

const EVENT_TYPES = [
  'call.started',
  'call.completed',
  'call.transferred',
  // A call-center agent took over a live call (browser jump-in or their phone was
  // rung). Distinct from call.transferred, which is a dial to the business line.
  'call.escalated',
  'appointment.booked',
  // Appointment moved to a new time, or canceled. Fired by the API appointment
  // writes (create/reschedule/cancel) in calendar-booking.js.
  'appointment.rescheduled',
  'appointment.canceled',
  'client.provisioned',
  'client.provisioning_failed',
  // Account / billing lifecycle events (the automation subject is the business
  // itself, not a caller). Fired from notifications.js and stripe-connect.js.
  'client.payment_failed',
  'client.subscription_activated',
  'client.trial_expired',
  'client.canceled',
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

// IP denylist shared by the delivery-time guard: loopback, private, link-local,
// CGNAT, and the cloud metadata address (169.254.169.254). isSafeWebhookUrl()
// above only sees the hostname, so a public name that RESOLVES to one of these
// (DNS rebinding) would slip past it. This is the check that actually runs
// against the resolved address right before we POST.
function isBlockedIp(ip) {
  const s = String(ip).toLowerCase();
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;            // link-local + metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT
    return false;
  }
  if (s === '::1' || s === '::') return true;
  if (s.startsWith('fc') || s.startsWith('fd')) return true;  // ULA (incl. fd00:ec2 metadata)
  if (s.startsWith('fe80')) return true;                      // link-local
  const mapped = s.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);     // IPv4-mapped IPv6
  if (mapped) return isBlockedIp(mapped[1]);
  return false;
}

// Resolve the endpoint host and reject if ANY resolved address is in a blocked
// range. Returns null when safe, or a short reason string when blocked. The
// reason is safe to store (it never contains a fetched response body), so a
// rebind attempt cannot be used to read internal/metadata content back out
// through the deliveries log.
async function resolvedHostBlockReason(url) {
  let host;
  try { host = new URL(url).hostname; } catch (e) { return 'invalid url'; }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) {
    return isBlockedIp(host) ? `blocked address ${host}` : null;
  }
  let addrs;
  try { addrs = await dns.lookup(host, { all: true, verbatim: true }); }
  catch (e) { return `dns lookup failed for ${host}`; }
  for (const a of addrs) {
    if (isBlockedIp(a.address)) return `${host} resolves to a blocked address`;
  }
  return null;
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
    // SSRF guard at the moment of delivery: resolve the host and refuse if it
    // points anywhere internal. redirect:'error' stops a 3xx from bouncing the
    // request to an unchecked (internal) URL after the guard has run.
    const blocked = await resolvedHostBlockReason(hook.url);
    if (blocked) throw new Error(`refused: ${blocked}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
    const res = await fetch(hook.url, {
      method: 'POST',
      redirect: 'error',
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

    // Internal fan-out to the workflow engine. Runs regardless of whether the
    // agency has any external webhooks registered. Non-blocking and fully
    // isolated: a workflow error must never affect webhook delivery or the
    // event source. Lazy require avoids any load-order coupling.
    try {
      require('./workflow-triggers').onEvent(agencyId, eventType, data).catch(() => {});
    } catch (e) { /* workflow engine not available: ignore */ }

    const { data: hooks } = await supabase
      .from('agency_webhooks').select('*')
      .eq('agency_id', agencyId).eq('status', 'active');
    const targets = (hooks || []).filter((h) => isSubscribed(h, eventType));
    if (targets.length === 0) return;

    // Enrich COMPLETED/TRANSFERRED call events with the same public fields the
    // REST API returns, so a consumer can ingest a whole call from the webhook
    // alone, with no follow-up GET /calls/:id. (call.started is a live event
    // carrying a call_session_id, not a calls row id, so it is left as-is.)
    // Computed once, identical for every subscribed hook. Best effort: if the
    // lookup fails the lean payload still ships.
    let eventData = data;
    if ((eventType === 'call.completed' || eventType === 'call.transferred') && data && data.id) {
      try {
        const { data: call } = await supabase.from('calls').select('*').eq('id', data.id).single();
        if (call) {
          let recordingUrl = call.recording_url || null;
          if (recordingUrl) {
            try { recordingUrl = await require('./vapi-recording').resolveVapiRecordingUrl(recordingUrl); }
            catch (e) {}
          }
          eventData = {
            ...data,
            caller_phone: call.caller_phone,
            customer_name: call.customer_name,
            customer_phone: call.customer_phone,
            customer_email: call.customer_email,
            customer_address: call.customer_address,
            service_requested: call.service_requested,
            urgency_level: call.urgency_level,
            sentiment: call.sentiment,
            appointment_booked: call.appointment_booked,
            appointment_time: call.appointment_time,
            ai_summary: call.ai_summary,
            summary: call.summary,
            transcript: call.transcript,
            recording_url: recordingUrl,
            // Durable link: `recording_url` above is a short-lived signed URL, so a
            // stored webhook replayed later would have a dead link. This endpoint
            // returns a fresh URL on demand (auth with the agency API key).
            recording_api_url: call.recording_url ? `${BACKEND_URL}/api/v1/calls/${call.id}/recording` : null,
            ended_reason: call.ended_reason,
            transfer_status: call.transfer_status,
            is_spam: call.is_spam,
            spam_reason: call.spam_reason,
            call_language: call.call_language,
            started_at: call.started_at,
            ended_at: call.ended_at,
          };
        }
      } catch (e) { /* fall back to the lean payload */ }
    }

    for (const hook of targets) {
      const eventId = crypto.randomUUID();
      const payload = { id: eventId, type: eventType, created_at: new Date().toISOString(), data: eventData };
      const nowIso = new Date().toISOString();
      // Insert as 'processing' (not 'pending') for the immediate attempt so the
      // retry cron, which claims due 'pending' rows, cannot grab and re-send this
      // same row while the first POST is in flight. last_attempt_at is set so the
      // stale-'processing' reclaim can still rescue it if this process dies.
      const { data: delivery } = await supabase
        .from('webhook_deliveries')
        .insert({
          webhook_id: hook.id, agency_id: agencyId, event_type: eventType,
          event_id: eventId, payload, status: 'processing',
          last_attempt_at: nowIso, next_attempt_at: nowIso,
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
  const nowIso = new Date().toISOString();
  const { data: delivery } = await supabase
    .from('webhook_deliveries')
    .insert({
      webhook_id: hook.id, agency_id: hook.agency_id, event_type: 'ping',
      event_id: eventId, payload, status: 'processing',
      last_attempt_at: nowIso, next_attempt_at: nowIso,
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

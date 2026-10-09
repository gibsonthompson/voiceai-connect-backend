// ============================================================================
// src/lib/live-broadcast.js
//
// Fan live call events out to the monitor in a way that works across any number
// of backend instances. Two delivery paths, same event:
//   1. In-memory bus -> SSE  (viewers connected to THIS instance; also keeps the
//      snapshot ring buffer so a late joiner on this instance catches up).
//   2. Supabase Realtime broadcast  (viewers connected to ANY instance, via
//      their own WebSocket straight to Supabase). This is what makes the monitor
//      correct when the app runs more than one instance: the webhook can land on
//      one instance while the viewer's stream is on another, and Supabase is the
//      shared channel both reach.
//
// The channel name is a keyed HMAC of the client id, so it is unguessable. The
// webhook computes it to broadcast; /live/info hands the same name to an
// authorized viewer to subscribe. Both compute it identically from the client
// id and the server secret.
//
// Everything here is best-effort and non-blocking: a Supabase hiccup never slows
// or breaks the webhook (which is a live phone call).
// ============================================================================

const crypto = require('crypto');
const bus = require('./live-monitor-bus');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CHANNEL_SECRET = process.env.JWT_SECRET || process.env.SUPABASE_SERVICE_KEY || 'live-monitor';

function channelFor(clientId) {
  const h = crypto.createHmac('sha256', CHANNEL_SECRET).update(String(clientId || '')).digest('hex').slice(0, 24);
  return `lc-${h}`;
}

function supabaseBroadcast(channel, event) {
  try {
    if (!SUPABASE_URL || !SUPABASE_KEY || !channel) return;
    const controller = new AbortController();
    const timer = setTimeout(() => { try { controller.abort(); } catch (e) {} }, 4000);
    fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
      body: JSON.stringify({ messages: [{ topic: channel, event: 'event', payload: event }] }),
      signal: controller.signal,
    }).then(() => {}).catch(() => {}).finally(() => { clearTimeout(timer); });
  } catch (e) { /* never throw into a call path */ }
}

// Publish a live event to viewers on this instance (SSE) and every instance
// (Supabase). Stamps the event once so both carry the same id, which the browser
// uses to de-duplicate when it receives the same event on both paths.
function broadcastLiveEvent(clientId, event) {
  try {
    if (!clientId || !event) return;
    const stamped = {
      id: event.id || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      ts: event.ts || Date.now(),
      ...event,
    };
    // In-memory keeps the existing id because publishToClient spreads the event
    // after its own default id, so the same stamped id reaches both paths.
    bus.publishToClient(clientId, stamped);
    supabaseBroadcast(channelFor(clientId), stamped);
  } catch (e) { /* best effort */ }
}

module.exports = { channelFor, broadcastLiveEvent };
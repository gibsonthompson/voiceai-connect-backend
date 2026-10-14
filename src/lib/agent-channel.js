// ============================================================================
// src/lib/agent-channel.js
//
// Agent-level real-time delivery for escalation screen-pops. Mirrors
// live-broadcast.js, but keyed by the AGENT (member_user_id) rather than the
// client, because an offer has to reach an agent wherever they are in the /cc
// console - not only on a page watching one business.
//
// Two delivery paths, same event (identical to the live monitor):
//   1. In-memory bus -> SSE  (agents connected to THIS instance).
//   2. Supabase Realtime broadcast  (agents connected to ANY instance, over
//      their own WebSocket straight to Supabase). This is what makes offers
//      reach an agent whose SSE happens to be on a different instance from the
//      one handling the call.
//
// The channel name is a keyed HMAC of the agent id, so it is unguessable; the
// backend computes it to broadcast and hands the same name to an authenticated
// agent to subscribe. Everything is best-effort and never throws into a call.
// ============================================================================

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CHANNEL_SECRET = process.env.JWT_SECRET || process.env.SUPABASE_SERVICE_KEY || 'agent-channel';

// agentId -> Set<fn(event)>
const subscribers = new Map();

function channelForAgent(memberUserId) {
  const h = crypto.createHmac('sha256', CHANNEL_SECRET).update(String(memberUserId || '')).digest('hex').slice(0, 24);
  return `ag-${h}`;
}

function subscribeAgent(memberUserId, fn) {
  if (!memberUserId || typeof fn !== 'function') return () => {};
  let set = subscribers.get(memberUserId);
  if (!set) { set = new Set(); subscribers.set(memberUserId, set); }
  set.add(fn);
  return () => {
    const s = subscribers.get(memberUserId);
    if (s) { s.delete(fn); if (s.size === 0) subscribers.delete(memberUserId); }
  };
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

// Fan an event out to one agent on this instance (SSE) and every instance
// (Supabase). Stamps the event once so both paths carry the same id, which the
// browser uses to de-duplicate.
function broadcastToAgent(memberUserId, event) {
  try {
    if (!memberUserId || !event) return;
    const stamped = {
      id: event.id || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      ts: event.ts || Date.now(),
      ...event,
    };
    const set = subscribers.get(memberUserId);
    if (set) for (const fn of set) { try { fn(stamped); } catch (e) {} }
    supabaseBroadcast(channelForAgent(memberUserId), stamped);
  } catch (e) { /* best effort */ }
}

// Broadcast the same event to several agents at once (an offer fan-out).
function broadcastToAgents(memberUserIds, event) {
  if (!Array.isArray(memberUserIds)) return;
  for (const id of memberUserIds) broadcastToAgent(id, event);
}

module.exports = { channelForAgent, subscribeAgent, broadcastToAgent, broadcastToAgents };

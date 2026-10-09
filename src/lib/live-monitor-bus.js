// ============================================================================
// src/lib/live-monitor-bus.js
//
// In-memory pub/sub for the live call monitor. The VAPI webhook and the
// per-tool endpoints (calendar, voice) publish normalized events here; the SSE
// route (routes/live-monitor.js) fans them out to browsers watching a given
// client, so an agency can watch a live call (or a web demo call) in real time
// and, if they want, take it over.
//
// Design notes:
//  - Purely in-memory and best-effort. A process restart drops live state; a
//    call already in progress simply re-populates from its next event. Nothing
//    in here ever throws into a call path (every publisher is a live phone
//    call, so a bug here must never break answering a call).
//  - Keyed by clientId. Events that only carry a VAPI call id (transcript,
//    status-update) are mapped back to the owning client through a call index
//    that handleAssistantRequest populates when it resolves the client.
//  - The call index also holds each call's VAPI monitor controlUrl, so the
//    takeover endpoint can find the right control channel for a given call.
// ============================================================================

const MAX_RECENT = 150;                 // ring buffer per client (current call)
const CALL_TTL_MS = 2 * 60 * 60 * 1000; // forget a call 2h after its last event
const CLEAR_AFTER_END_MS = 20 * 1000;   // keep the transcript ~20s after hangup

const subscribers = new Map(); // clientId -> Set<fn(event)>
const recent = new Map();      // clientId -> event[]
const callIndex = new Map();   // callId  -> { clientId, agencyId, businessName, controlUrl, listenUrl, status, startedAt, touchedAt }

function now() { return Date.now(); }

function pruneCalls() {
  const t = now();
  for (const [callId, info] of callIndex) {
    if (t - (info.touchedAt || info.startedAt || 0) > CALL_TTL_MS) callIndex.delete(callId);
  }
}

// Link a VAPI call id to the client that owns it. Called from the webhook as
// soon as the client is resolved, so later transcript/status events can be
// routed. Merges, so calling again with more detail (controlUrl) is fine.
function registerCall(callId, info) {
  try {
    if (!callId) return;
    const prev = callIndex.get(callId) || {};
    callIndex.set(callId, {
      ...prev,
      ...(info || {}),
      callId,
      startedAt: prev.startedAt || now(),
      touchedAt: now(),
    });
    pruneCalls();
  } catch {}
}

function getCallInfo(callId) {
  try { return callId ? (callIndex.get(callId) || null) : null; } catch { return null; }
}

// Capture the per-call VAPI monitor URLs when we first see them on an event.
function setMonitorUrls(callId, controlUrl, listenUrl) {
  try {
    if (!callId || (!controlUrl && !listenUrl)) return;
    const info = callIndex.get(callId);
    if (info) {
      if (controlUrl) info.controlUrl = controlUrl;
      if (listenUrl) info.listenUrl = listenUrl;
      info.touchedAt = now();
    } else {
      registerCall(callId, { controlUrl, listenUrl });
    }
  } catch {}
}

function subscribe(clientId, fn) {
  if (!clientId || typeof fn !== 'function') return () => {};
  let set = subscribers.get(clientId);
  if (!set) { set = new Set(); subscribers.set(clientId, set); }
  set.add(fn);
  return () => {
    const s = subscribers.get(clientId);
    if (s) { s.delete(fn); if (s.size === 0) subscribers.delete(clientId); }
  };
}

function pushRecent(clientId, event) {
  let arr = recent.get(clientId);
  if (!arr) { arr = []; recent.set(clientId, arr); }
  arr.push(event);
  if (arr.length > MAX_RECENT) arr.splice(0, arr.length - MAX_RECENT);
}

// The buffered events for the current call, so a viewer who opens the page
// mid-call immediately sees what has happened so far.
function snapshot(clientId) {
  try { return (recent.get(clientId) || []).slice(); } catch { return []; }
}

function clearClient(clientId) {
  try { recent.delete(clientId); } catch {}
}

// Fan an event out to everyone watching clientId. Stamps an id + ts. The
// caller passes a plain object like { type:'transcript', role, text, final }.
// Best-effort: never throws.
function publishToClient(clientId, event) {
  try {
    if (!clientId || !event) return;
    const stamped = {
      id: `${now()}_${Math.random().toString(36).slice(2, 8)}`,
      ts: now(),
      ...event,
    };
    pushRecent(clientId, stamped);
    const set = subscribers.get(clientId);
    if (set) for (const fn of set) { try { fn(stamped); } catch {} }
    // After a call ends, hold the transcript briefly then clear so the next
    // call starts from a clean board.
    if (event.type === 'status' && event.status === 'ended') {
      const cid = clientId;
      setTimeout(() => clearClient(cid), CLEAR_AFTER_END_MS);
    }
  } catch {}
}

// Publish an event that only carries a VAPI call id. Resolves the owning client
// via the call index and stamps the callId on the event. Returns true when the
// call was known (and therefore delivered).
function publishByCall(callId, event) {
  try {
    const info = getCallInfo(callId);
    if (!info || !info.clientId) return false;
    info.touchedAt = now();
    if (event && event.type === 'status' && event.status) info.status = event.status;
    publishToClient(info.clientId, { callId, ...(event || {}) });
    return true;
  } catch { return false; }
}

module.exports = {
  registerCall,
  getCallInfo,
  setMonitorUrls,
  subscribe,
  snapshot,
  clearClient,
  publishToClient,
  publishByCall,
};

// ============================================================================
// src/lib/vapi-call-monitor.js
//
// Fallback lookup for a call's live monitor URLs. The webhook captures
// monitor.controlUrl / listenUrl opportunistically from call events, but VAPI
// does not guarantee those URLs ride on every event. When the live monitor
// needs them (takeover or live audio) and the bus has not cached them yet, we
// ask VAPI's API for the call directly. Best-effort: returns {} on any failure,
// so a missing key or a hiccup never throws into the monitor path.
// ============================================================================

const VAPI_API_KEY = process.env.VAPI_API_KEY;

async function fetchMonitorUrls(callId) {
  try {
    if (!callId || !VAPI_API_KEY) return {};
    const res = await fetch(`https://api.vapi.ai/call/${encodeURIComponent(callId)}`, {
      headers: { Authorization: `Bearer ${VAPI_API_KEY}` },
    });
    if (!res.ok) return {};
    const call = await res.json();
    const monitor = (call && call.monitor) || {};
    return { controlUrl: monitor.controlUrl || null, listenUrl: monitor.listenUrl || null };
  } catch {
    return {};
  }
}

// Resolve a call's live controlUrl (cached first, then VAPI's API) and POST a
// control message to it. Used for server-side takeover polish: parking the
// assistant (mute-assistant) while a human is on the call, and a clean scripted
// resume (say) on hand-back. Best-effort: returns false on any miss or failure
// so it can never block or break the call path. Payload is a VAPI live-control
// message, e.g. { type:'control', control:'mute-assistant' } or
// { type:'say', content:'...', interruptAssistantEnabled:true }.
async function sendVapiControl(callId, payload) {
  try {
    if (!callId || !payload) return false;
    let controlUrl = null;
    // Prefer the cached URL (lazy require avoids any load-time module cycle).
    try { const info = require('./live-monitor-bus').getCallInfo(callId); controlUrl = info && info.controlUrl; } catch { /* ignore */ }
    if (!controlUrl) { const urls = await fetchMonitorUrls(callId); controlUrl = urls.controlUrl || null; }
    if (!controlUrl) return false;
    const res = await fetch(controlUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return !!(res && res.ok);
  } catch {
    return false;
  }
}

module.exports = { fetchMonitorUrls, sendVapiControl };

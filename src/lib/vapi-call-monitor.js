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

module.exports = { fetchMonitorUrls };

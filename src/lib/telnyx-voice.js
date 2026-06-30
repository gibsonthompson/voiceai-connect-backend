// ============================================================================
// TELNYX VOICE - Call Control action helpers (warm transfer)
// ----------------------------------------------------------------------------
// Thin, well-logged wrappers over the Telnyx Call Control v2 API. These are the
// only building blocks the warm-transfer flow needs:
//
//   answer  -> pick up the inbound caller leg so we can control it
//   dial    -> originate a new leg (to VAPI over SIP, or to the office number)
//   speak   -> say a line to ONE leg only (this is the whisper to the office)
//   bridge  -> connect two legs together (caller + office)
//   hangup  -> end a leg (we drop the VAPI leg once the office is bridged in)
//   playback start/stop -> optional hold audio for the caller while we dial out
//
// All of these use the same TELNYX_API_KEY the SMS code already uses. Nothing
// here hardcodes your connection id or the VAPI SIP URI; the caller passes them
// in, with env-var defaults so the webhook handler can stay clean.
//
// Every function returns the parsed Telnyx response on success, or null on
// failure (and logs why). No function throws, so one failed leg never crashes
// the webhook that is mid-call.
// ============================================================================
const fetch = require('node-fetch');

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_VOICE_CONNECTION_ID = process.env.TELNYX_VOICE_CONNECTION_ID || null;
const VAPI_SIP_URI = process.env.VAPI_SIP_URI || null;
const TELNYX_BASE = 'https://api.telnyx.com/v2';

// Default voice for the whisper. Telnyx accepts simple values like 'female' or
// 'male', or specific provider voices. Override per call if needed.
const DEFAULT_SPEAK_VOICE = process.env.TELNYX_SPEAK_VOICE || 'female';
const DEFAULT_SPEAK_LANGUAGE = process.env.TELNYX_SPEAK_LANGUAGE || 'en-US';

// ----------------------------------------------------------------------------
// client_state is a base64 string Telnyx echoes back on every webhook for a
// leg. We use it to carry our call_sessions id (and a label for which leg this
// is) so the webhook handler always knows what a given leg is for, even before
// the database round-trip. Encode on the way out, decode on the way in.
// ----------------------------------------------------------------------------
function encodeClientState(obj) {
  try {
    return Buffer.from(JSON.stringify(obj || {}), 'utf-8').toString('base64');
  } catch {
    return null;
  }
}

function decodeClientState(state) {
  if (!state) return null;
  try {
    return JSON.parse(Buffer.from(String(state), 'base64').toString('utf-8'));
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// Low-level: POST an action to an existing leg.
//   /v2/calls/{call_control_id}/actions/{action}
// ----------------------------------------------------------------------------
async function callAction(callControlId, action, body = {}) {
  if (!TELNYX_API_KEY) { console.warn('telnyx-voice: TELNYX_API_KEY not set'); return null; }
  if (!callControlId) { console.warn(`telnyx-voice: ${action} called with no call_control_id`); return null; }

  try {
    const res = await fetch(`${TELNYX_BASE}/calls/${encodeURIComponent(callControlId)}/actions/${action}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TELNYX_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.error(`telnyx-voice: ${action} failed (HTTP ${res.status}): ${t.slice(0, 200)}`);
      return null;
    }

    const data = await res.json().catch(() => ({}));
    return data.data || data;
  } catch (err) {
    console.error(`telnyx-voice: ${action} error: ${err.message}`);
    return null;
  }
}

// ----------------------------------------------------------------------------
// answerCall - pick up an inbound caller leg so we can drive it.
// ----------------------------------------------------------------------------
async function answerCall(callControlId, clientStateObj = null) {
  const body = {};
  const cs = encodeClientState(clientStateObj);
  if (cs) body.client_state = cs;
  const out = await callAction(callControlId, 'answer', body);
  if (out) console.log(`telnyx-voice: answered ${callControlId}`);
  return out;
}

// ----------------------------------------------------------------------------
// dialCall - originate a NEW outbound leg. Used twice:
//   1. to VAPI over SIP (to = the VAPI SIP URI), stamping X-Client-Id so VAPI
//      knows which client this call is for.
//   2. to the office number (to = +1XXXXXXXXXX) with answering-machine
//      detection so we only whisper to a human, not a voicemail greeting.
//
// Returns the new leg's data, including its call_control_id, on success.
//
// opts:
//   to                 (required) E.164 number OR 'sip:...' URI
//   from               (required) caller ID to present (a number on your account)
//   fromDisplayName    optional display name
//   connectionId       defaults to TELNYX_VOICE_CONNECTION_ID
//   customHeaders      array of { name, value } added to the SIP INVITE
//   amd                'disabled' (default) | 'detect' | 'detect_beep' | 'premium'
//   clientState        object, echoed back on this leg's webhooks
//   webhookUrl         optional per-call webhook override
//   timeoutSecs        ring timeout before giving up (e.g. office no-answer)
// ----------------------------------------------------------------------------
async function dialCall(opts = {}) {
  if (!TELNYX_API_KEY) { console.warn('telnyx-voice: TELNYX_API_KEY not set'); return null; }

  const connectionId = opts.connectionId || TELNYX_VOICE_CONNECTION_ID;
  if (!connectionId) { console.warn('telnyx-voice: no connection id (set TELNYX_VOICE_CONNECTION_ID)'); return null; }
  if (!opts.to) { console.warn('telnyx-voice: dialCall called with no destination'); return null; }
  if (!opts.from) { console.warn('telnyx-voice: dialCall called with no from'); return null; }

  const body = {
    connection_id: connectionId,
    to: opts.to,
    from: opts.from,
  };
  if (opts.fromDisplayName) body.from_display_name = String(opts.fromDisplayName).slice(0, 128);
  if (Array.isArray(opts.customHeaders) && opts.customHeaders.length) body.custom_headers = opts.customHeaders;
  if (opts.amd && opts.amd !== 'disabled') body.answering_machine_detection = opts.amd;
  if (opts.timeoutSecs) body.timeout_secs = opts.timeoutSecs;
  if (opts.webhookUrl) body.webhook_url = opts.webhookUrl;
  const cs = encodeClientState(opts.clientState);
  if (cs) body.client_state = cs;

  try {
    const res = await fetch(`${TELNYX_BASE}/calls`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TELNYX_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.error(`telnyx-voice: dial to ${opts.to} failed (HTTP ${res.status}): ${t.slice(0, 200)}`);
      return null;
    }

    const data = await res.json().catch(() => ({}));
    const leg = data.data || data;
    console.log(`telnyx-voice: dialed ${opts.to} -> leg ${leg.call_control_id || '(pending)'}`);
    return leg;
  } catch (err) {
    console.error(`telnyx-voice: dial error: ${err.message}`);
    return null;
  }
}

// ----------------------------------------------------------------------------
// dialVapi - convenience: originate the AI leg into VAPI over SIP, carrying the
// client id as a custom SIP header so VAPI's assistant-request can pick the
// right client. 'to' defaults to VAPI_SIP_URI.
// ----------------------------------------------------------------------------
async function dialVapi({ clientId, from, fromDisplayName, sipUri, clientState, connectionId, webhookUrl }) {
  const to = sipUri || VAPI_SIP_URI;
  if (!to) { console.warn('telnyx-voice: no VAPI SIP URI (set VAPI_SIP_URI)'); return null; }
  if (!clientId) { console.warn('telnyx-voice: dialVapi called with no clientId'); return null; }

  return dialCall({
    to,
    from,
    fromDisplayName,
    connectionId,
    webhookUrl,
    clientState,
    customHeaders: [{ name: 'X-Client-Id', value: String(clientId) }],
  });
}

// ----------------------------------------------------------------------------
// speakToCall - say a line to ONE leg. This is the whisper: call it on the
// office leg only, before bridging, and the caller never hears it.
// ----------------------------------------------------------------------------
async function speakToCall(callControlId, text, opts = {}) {
  if (!text) { console.warn('telnyx-voice: speak called with empty text'); return null; }
  const body = {
    payload: String(text),
    payload_type: 'text',
    voice: opts.voice || DEFAULT_SPEAK_VOICE,
    language: opts.language || DEFAULT_SPEAK_LANGUAGE,
  };
  const cs = encodeClientState(opts.clientState);
  if (cs) body.client_state = cs;
  const out = await callAction(callControlId, 'speak', body);
  if (out) console.log(`telnyx-voice: speaking to ${callControlId}`);
  return out;
}

// ----------------------------------------------------------------------------
// bridgeCalls - connect two legs so the people on them can talk. Issued on one
// leg with the other leg's id. Used to merge caller + office.
// ----------------------------------------------------------------------------
async function bridgeCalls(callControlIdA, callControlIdB, opts = {}) {
  if (!callControlIdA || !callControlIdB) { console.warn('telnyx-voice: bridge needs two leg ids'); return null; }
  const body = { call_control_id: callControlIdB };
  const cs = encodeClientState(opts.clientState);
  if (cs) body.client_state = cs;
  const out = await callAction(callControlIdA, 'bridge', body);
  if (out) console.log(`telnyx-voice: bridged ${callControlIdA} <-> ${callControlIdB}`);
  return out;
}

// ----------------------------------------------------------------------------
// hangupCall - end a leg. We hang up the VAPI leg once the office is bridged in.
// ----------------------------------------------------------------------------
async function hangupCall(callControlId, opts = {}) {
  const body = {};
  const cs = encodeClientState(opts.clientState);
  if (cs) body.client_state = cs;
  const out = await callAction(callControlId, 'hangup', body);
  if (out) console.log(`telnyx-voice: hung up ${callControlId}`);
  return out;
}

// ----------------------------------------------------------------------------
// startPlayback / stopPlayback - optional hold audio for the caller while the
// office is being dialed. audioUrl must be a publicly reachable file.
// ----------------------------------------------------------------------------
async function startPlayback(callControlId, audioUrl, opts = {}) {
  if (!audioUrl) { console.warn('telnyx-voice: playback called with no audio url'); return null; }
  const body = { audio_url: audioUrl };
  if (opts.loop) body.loop = String(opts.loop);
  const cs = encodeClientState(opts.clientState);
  if (cs) body.client_state = cs;
  return callAction(callControlId, 'playback_start', body);
}

async function stopPlayback(callControlId) {
  return callAction(callControlId, 'playback_stop', {});
}

module.exports = {
  encodeClientState,
  decodeClientState,
  callAction,
  answerCall,
  dialCall,
  dialVapi,
  speakToCall,
  bridgeCalls,
  hangupCall,
  startPlayback,
  stopPlayback,
};
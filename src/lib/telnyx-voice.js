// ============================================================================
// TELNYX VOICE - Call Control action helpers (warm transfer)
// ----------------------------------------------------------------------------
// Thin, well-logged wrappers over the Telnyx Call Control v2 API. These are the
// building blocks the own-the-call warm-transfer flow needs:
//
//   answer  -> pick up the inbound caller leg so we can control it
//   dial    -> originate a new leg (to VAPI over SIP, or to the office number)
//   speak   -> say a line to ONE leg only (used for the ringback fallback)
//   gather  -> speak a prompt to ONE leg and collect a DTMF digit (press-1 gate)
//   bridge  -> connect two legs together (caller + office)
//   unbridge-> separate two bridged legs WITHOUT hanging either up (both parked)
//   hangup  -> end a leg (we drop the VAPI leg once the office is bridged in)
//   playback start/stop -> ringback audio for the caller while we dial out
//   record  start/stop  -> record the bridged caller<->office call for the recap
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
// A natural AWS Polly neural voice by default (the basic 'male'/'female' voices
// sound robotic). Override with TELNYX_SPEAK_VOICE, e.g. AWS.Polly.Matthew-Neural.
const DEFAULT_SPEAK_VOICE = process.env.TELNYX_SPEAK_VOICE || 'AWS.Polly.Joanna-Neural';
const DEFAULT_SPEAK_LANGUAGE = process.env.TELNYX_SPEAK_LANGUAGE || 'en-US';

// To use ElevenLabs (or Azure/Minimax/etc.) voices, Telnyx needs a reference to
// the provider API key stored as a Telnyx Integration Secret (never the raw key
// inline). Set TELNYX_VOICE_API_KEY_REF to that secret's identifier, and set
// TELNYX_SPEAK_VOICE to e.g. ElevenLabs.eleven_turbo_v2_5.<voiceId>. When the ref
// is set we attach voice_settings on every speak/gather so the provider is used.
const DEFAULT_VOICE_API_KEY_REF = process.env.TELNYX_VOICE_API_KEY_REF || null;

// Only voices from a provider that needs an API key (ElevenLabs) get
// voice_settings. Polly and Telnyx voices must NOT carry it, so the Polly
// fallback lines keep working even when the ElevenLabs key ref is set globally.
function buildVoiceSettings(opts = {}, voice = '') {
  if (!/^ElevenLabs\./i.test(String(voice || opts.voice || ''))) return null;
  const ref = opts.apiKeyRef || DEFAULT_VOICE_API_KEY_REF;
  return ref ? { type: 'elevenlabs', api_key_ref: ref } : null;
}

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
//      detection so we only gate a human, not a voicemail greeting.
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
// speakToCall - say a line to ONE leg. Used for the spoken ringback fallback
// (when no ringback audio url is configured) and any one-leg announcement.
// ----------------------------------------------------------------------------
async function speakToCall(callControlId, text, opts = {}) {
  if (!text) { console.warn('telnyx-voice: speak called with empty text'); return null; }
  const body = {
    payload: String(text),
    payload_type: 'text',
    voice: opts.voice || DEFAULT_SPEAK_VOICE,
    language: opts.language || DEFAULT_SPEAK_LANGUAGE,
  };
  const vs = buildVoiceSettings(opts, body.voice);
  if (vs) body.voice_settings = vs;
  const cs = encodeClientState(opts.clientState);
  if (cs) body.client_state = cs;
  const out = await callAction(callControlId, 'speak', body);
  if (out) console.log(`telnyx-voice: speaking to ${callControlId}`);
  return out;
}

// ----------------------------------------------------------------------------
// gatherUsingSpeak - speak a prompt to ONE leg and collect DTMF in the same
// command. This is the press-1-to-accept gate on the office leg: the agent
// hears the whisper, then presses 1 to take the call. A voicemail never presses
// a key, so this is the reliable backstop that answering-machine detection
// alone is not. The result arrives as a 'call.gather.ended' event whose
// payload.digits is what was pressed (empty on timeout).
//
// opts:
//   validDigits            default '1'
//   timeoutMillis          overall gather timeout (default 6000)
//   interDigitTimeoutMillis default 3000
//   voice / language       TTS voice + language
//   clientState            echoed back on the gather event
// ----------------------------------------------------------------------------
async function gatherUsingSpeak(callControlId, text, opts = {}) {
  if (!text) { console.warn('telnyx-voice: gatherUsingSpeak called with empty text'); return null; }
  const body = {
    payload: String(text),
    payload_type: 'text',
    voice: opts.voice || DEFAULT_SPEAK_VOICE,
    language: opts.language || DEFAULT_SPEAK_LANGUAGE,
    valid_digits: opts.validDigits || '1',
    minimum_digits: 1,
    maximum_digits: 1,
    timeout_millis: opts.timeoutMillis || 6000,
    inter_digit_timeout_millis: opts.interDigitTimeoutMillis || 3000,
  };
  const vs = buildVoiceSettings(opts, body.voice);
  if (vs) body.voice_settings = vs;
  const cs = encodeClientState(opts.clientState);
  if (cs) body.client_state = cs;
  const out = await callAction(callControlId, 'gather_using_speak', body);
  if (out) console.log(`telnyx-voice: gather_using_speak on ${callControlId}`);
  return out;
}

// ----------------------------------------------------------------------------
// gatherUsingAI - speak a greeting to ONE leg and collect a SPOKEN response the
// agent gives out loud (yes / no), interpreted by Telnyx's voice AI into the
// parameters schema. Used for the "want me to put them through?" accept gate so
// the person answers naturally instead of pressing a key. The result arrives as
// a 'call.ai_gather.ended' event.
//
// opts:
//   voice / apiKeyRef      TTS voice + ElevenLabs key ref (same as speak)
//   parameters             JSON schema to capture (defaults to { accept: bool })
//   instructions           extra guidance for the interpreting assistant
//   timeoutMillis          user response timeout (default 10000)
//   clientState            echoed back on the ai_gather event
// ----------------------------------------------------------------------------
async function gatherUsingAI(callControlId, greeting, opts = {}) {
  if (!greeting) { console.warn('telnyx-voice: gatherUsingAI called with empty greeting'); return null; }
  const body = {
    greeting: String(greeting),
    voice: opts.voice || DEFAULT_SPEAK_VOICE,
    parameters: opts.parameters || {
      type: 'object',
      properties: {
        accept: {
          type: 'boolean',
          description: 'true only if the team member clearly agrees to take the call now (yes, sure, put them through, send them). false if they decline or want a message.',
        },
      },
      required: ['accept'],
    },
    user_response_timeout_ms: opts.timeoutMillis || 10000,
    // Let the greeting finish before listening, so the brief is not cut off when
    // the agent says "hello"; set opts.allowInterrupt true to allow barge-in.
    interruption_settings: { enable: opts.allowInterrupt === true },
  };
  const instructions = opts.instructions
    || 'You are the phone system briefing a team member about a caller being transferred to them. After the greeting, listen for their answer and set accept to true only if they clearly agree to take the call now, or false if they decline or want to take a message. Do not chat or ask anything else.';
  body.assistant = { instructions: String(instructions) };
  const vs = buildVoiceSettings(opts, body.voice);
  if (vs) body.voice_settings = vs;
  const cs = encodeClientState(opts.clientState);
  if (cs) body.client_state = cs;
  const out = await callAction(callControlId, 'gather_using_ai', body);
  if (out) console.log(`telnyx-voice: gather_using_ai on ${callControlId}`);
  return out;
}

// ----------------------------------------------------------------------------
// bridgeCalls - connect two legs so the people on them can talk. Issued on one
// leg with the other leg's id. Used to merge caller + office.
// ----------------------------------------------------------------------------
async function bridgeCalls(callControlIdA, callControlIdB, opts = {}) {
  if (!callControlIdA || !callControlIdB) { console.warn('telnyx-voice: bridge needs two leg ids'); return null; }
  const body = { call_control_id: callControlIdB };
  if (opts.parkAfterUnbridge) body.park_after_unbridge = opts.parkAfterUnbridge;
  const cs = encodeClientState(opts.clientState);
  if (cs) body.client_state = cs;
  const out = await callAction(callControlIdA, 'bridge', body);
  if (out) console.log(`telnyx-voice: bridged ${callControlIdA} <-> ${callControlIdB}`);
  return out;
}

// ----------------------------------------------------------------------------
// unbridgeCall - separate two currently-bridged legs WITHOUT hanging up either.
// Both legs stay up and parked. We use this at transfer time to take the caller
// off the AI (so they can hear ringback while the office is dialed) while
// keeping the AI leg alive and parked, ready to be re-bridged to the caller if
// the office does not pick up.
// ----------------------------------------------------------------------------
async function unbridgeCall(callControlId, opts = {}) {
  const body = {};
  if (opts.otherCallControlId) body.call_control_id = opts.otherCallControlId;
  const cs = encodeClientState(opts.clientState);
  if (cs) body.client_state = cs;
  const out = await callAction(callControlId, 'unbridge', body);
  if (out) console.log(`telnyx-voice: unbridged ${callControlId}`);
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
// startPlayback / stopPlayback - ringback (or hold) audio for the caller while
// the office is being dialed. audioUrl must be a publicly reachable file. Pass
// opts.loop = 'infinity' to loop a short ringback tone for the whole ring.
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

// ----------------------------------------------------------------------------
// recordStart / recordStop - record a leg and whatever it is bridged to. We
// start recording on the caller leg right after it is bridged to the office so
// the whole human conversation is captured for the owner recap. channels
// 'dual' keeps the two parties on separate channels. The finished file arrives
// as a 'call.recording.saved' event carrying the recording url(s).
// ----------------------------------------------------------------------------
async function recordStart(callControlId, opts = {}) {
  const body = {
    format: opts.format || 'mp3',
    channels: opts.channels || 'dual',
  };
  if (opts.playBeep) body.play_beep = true;
  const cs = encodeClientState(opts.clientState);
  if (cs) body.client_state = cs;
  const out = await callAction(callControlId, 'record_start', body);
  if (out) console.log(`telnyx-voice: recording started on ${callControlId}`);
  return out;
}

async function recordStop(callControlId) {
  return callAction(callControlId, 'record_stop', {});
}

// ----------------------------------------------------------------------------
// startTranscription / stopTranscription - real-time Speech-to-Text on a leg.
//
// Used during a browser human-barge: once the VAPI leg is gone, VAPI no longer
// supplies a live transcript, so we transcribe the caller<->agent audio with
// Telnyx real-time STT and stream the partial/final results to the live monitor
// (they arrive as 'call.transcription' webhook events). transcription_tracks
// 'both' captures both parties (inbound = caller, outbound = agent). Started on
// the caller leg, which survives the whole call, so one transcription spans the
// takeover (and the return to the AI, if that happens).
//
// opts:
//   language     BCP-47 language (default 'en')
//   interim      stream partial results too (default true)
//   tracks       'inbound' | 'outbound' | 'both' (default 'both')
//   engine       optional STT engine override (e.g. 'B' for the premium engine)
//   clientState  echoed back on the call.transcription events
// ----------------------------------------------------------------------------
async function startTranscription(callControlId, opts = {}) {
  const body = {
    language: opts.language || 'en',
    interim_results: opts.interim !== false,
    transcription_tracks: opts.tracks || 'both',
  };
  if (opts.engine) body.transcription_engine = opts.engine;
  const cs = encodeClientState(opts.clientState);
  if (cs) body.client_state = cs;
  const out = await callAction(callControlId, 'transcription_start', body);
  if (out) console.log(`telnyx-voice: transcription started on ${callControlId}`);
  return out;
}

async function stopTranscription(callControlId) {
  return callAction(callControlId, 'transcription_stop', {});
}

// ----------------------------------------------------------------------------
// WEBRTC CREDENTIAL MINTING (browser human-barge)
// ----------------------------------------------------------------------------
// To let a human agent join a live call and talk from the browser, the browser
// registers as a Telnyx WebRTC endpoint using a short-lived telephony-credential
// token. The backend then dials that endpoint (sip:<sip_username>@sip.telnyx.com)
// as a normal Call Control leg and bridges it to the caller. These helpers mint
// (and revoke) those credentials. They talk to the plain v2 REST resources, not
// the /calls/{id}/actions path, so they use their own fetch wrapper.
//
// Nothing here stores a secret: the credential's SIP password never leaves
// Telnyx (the browser authenticates with the minted JWT token, not a password),
// and the token is returned to the authorized caller and never logged.
// ----------------------------------------------------------------------------
async function telnyxRest(method, path, body) {
  if (!TELNYX_API_KEY) { console.warn('telnyx-voice: TELNYX_API_KEY not set'); return null; }
  try {
    const res = await fetch(`${TELNYX_BASE}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${TELNYX_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.error(`telnyx-voice: ${method} ${path} failed (HTTP ${res.status}): ${t.slice(0, 200)}`);
      return null;
    }
    const data = await res.json().catch(() => ({}));
    return data.data || data;
  } catch (err) {
    console.error(`telnyx-voice: ${method} ${path} error: ${err.message}`);
    return null;
  }
}

// Create a Credential Connection to parent the per-agent telephony credentials.
// One is enough for the whole platform; the caller caches its id (we store it in
// platform_settings). The connection's own user_name/password are never used for
// WebRTC login (the browser logs in with a telephony-credential token), but the
// API requires them, so we set long random values.
async function createWebrtcConnection(name) {
  const rand = () => require('crypto').randomBytes(18).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
  const out = await telnyxRest('POST', '/credential_connections', {
    connection_name: name || `voiceai-webrtc-${Date.now()}`,
    user_name: `va${rand()}`,
    password: rand() + rand(),
    // Receive inbound dials from our Call Control app and register WebRTC clients.
    webrtc_enabled: true,
  });
  return out && out.id ? out : null;
}

// Update the WebRTC credential connection (PATCH). Used to enable SIP URI
// calling (sip_uri_calling_preference) so a call dialed to a registered
// credential's sip:username@sip.telnyx.com is accepted instead of refused with
// a 403. Disabled is the Telnyx default, which is why the first barge dial was
// rejected. Best-effort; returns the updated connection or null.
async function updateWebrtcConnection(connectionId, body) {
  if (!connectionId) return null;
  return telnyxRest('PATCH', `/credential_connections/${encodeURIComponent(connectionId)}`, body || {});
}

// Mint a telephony credential (per agent-session) tied to the WebRTC connection.
// Returns { id, sip_username, ... }. expiresInSecs auto-expires it so a leaked
// credential is short-lived; we also delete it explicitly on jump-out.
async function createTelephonyCredential(connectionId, opts = {}) {
  if (!connectionId) { console.warn('telnyx-voice: createTelephonyCredential needs a connection id'); return null; }
  const body = { connection_id: String(connectionId) };
  if (opts.name) body.name = String(opts.name).slice(0, 80);
  const secs = opts.expiresInSecs || 0;
  if (secs > 0) body.expires_at = new Date(Date.now() + secs * 1000).toISOString();
  const out = await telnyxRest('POST', '/telephony_credentials', body);
  return out && out.id ? out : null;
}

// Mint a login token (JWT) for a telephony credential. The token endpoint returns
// text/plain (the JWT itself), not JSON, so this reads text. The browser passes
// it to TelnyxRTC({ login_token }). Never logged.
async function mintCredentialToken(credentialId) {
  if (!TELNYX_API_KEY || !credentialId) return null;
  try {
    const res = await fetch(`${TELNYX_BASE}/telephony_credentials/${encodeURIComponent(credentialId)}/token`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TELNYX_API_KEY}` },
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.error(`telnyx-voice: mint token failed (HTTP ${res.status}): ${t.slice(0, 120)}`);
      return null;
    }
    const token = (await res.text().catch(() => '')).trim();
    return token || null;
  } catch (err) {
    console.error(`telnyx-voice: mint token error: ${err.message}`);
    return null;
  }
}

// Revoke a telephony credential (on jump-out / cleanup). Best-effort.
async function deleteTelephonyCredential(credentialId) {
  if (!credentialId) return null;
  return telnyxRest('DELETE', `/telephony_credentials/${encodeURIComponent(credentialId)}`);
}

// ----------------------------------------------------------------------------
// CONFERENCE helpers (live monitor: seat a supervisor on a real call).
//
// A watched call is promoted into a Telnyx conference so a third leg (the
// supervisor's browser over WebRTC) can be added. The supervisor joins with
// supervisor_role 'monitor' (muted, hears everyone) to listen, and is flipped to
// 'barge' (talks to everyone) to jump in. comfort_noise is off and beep is never
// so the caller hears nothing when the conference is created or joined.
// ----------------------------------------------------------------------------
async function createConference(callControlId, name, opts = {}) {
  if (!callControlId || !name) { console.warn('telnyx-voice: createConference needs a leg id and name'); return null; }
  const body = {
    call_control_id: callControlId,
    name: String(name),
    beep_enabled: 'never',
    comfort_noise: opts.comfortNoise === true, // default false: no hiss
    start_conference_on_create: true,
  };
  const cs = encodeClientState(opts.clientState);
  if (cs) body.client_state = cs;
  const out = await telnyxRest('POST', '/conferences', body);
  if (out && out.id) console.log(`telnyx-voice: conference created ${out.id} (${name})`);
  return out && out.id ? out : null;
}

// Add a leg to a conference. opts.supervisorRole: 'monitor' | 'barge' | 'whisper'
// | 'none'. opts.mute mutes on join. opts.endConferenceOnExit ends the whole
// conference when this leg leaves (used for nothing by default; the caller leg
// governs call end via normal hangup handling).
async function conferenceJoin(conferenceId, callControlId, opts = {}) {
  if (!conferenceId || !callControlId) { console.warn('telnyx-voice: conferenceJoin needs conference id + leg id'); return null; }
  const body = { call_control_id: callControlId };
  if (opts.supervisorRole) body.supervisor_role = opts.supervisorRole;
  if (opts.mute === true) body.mute = true;
  if (opts.hold === true) body.hold = true;
  if (opts.startConferenceOnEnter === true) body.start_conference_on_enter = true;
  if (opts.endConferenceOnExit === true) body.end_conference_on_exit = true;
  if (opts.softEndConferenceOnExit === true) body.soft_end_conference_on_exit = true;
  if (Array.isArray(opts.whisperCallControlIds)) body.whisper_call_control_ids = opts.whisperCallControlIds;
  const cs = encodeClientState(opts.clientState);
  if (cs) body.client_state = cs;
  const out = await telnyxRest('POST', `/conferences/${encodeURIComponent(conferenceId)}/actions/join`, body);
  if (out) console.log(`telnyx-voice: joined leg ${callControlId} to conference ${conferenceId}${opts.supervisorRole ? ' as ' + opts.supervisorRole : ''}`);
  return out;
}

// Change a participant's supervisor role mid-call (monitor <-> barge).
async function conferenceUpdateParticipant(conferenceId, callControlId, supervisorRole, opts = {}) {
  if (!conferenceId || !callControlId || !supervisorRole) return null;
  const body = { call_control_id: callControlId, supervisor_role: supervisorRole };
  if (Array.isArray(opts.whisperCallControlIds)) body.whisper_call_control_ids = opts.whisperCallControlIds;
  const out = await telnyxRest('POST', `/conferences/${encodeURIComponent(conferenceId)}/actions/update`, body);
  if (out) console.log(`telnyx-voice: conference ${conferenceId} set ${callControlId} -> ${supervisorRole}`);
  return out;
}

async function conferenceMute(conferenceId, callControlIds) {
  if (!conferenceId) return null;
  const body = Array.isArray(callControlIds) && callControlIds.length ? { call_control_ids: callControlIds } : {};
  return telnyxRest('POST', `/conferences/${encodeURIComponent(conferenceId)}/actions/mute`, body);
}

async function conferenceUnmute(conferenceId, callControlIds) {
  if (!conferenceId) return null;
  const body = Array.isArray(callControlIds) && callControlIds.length ? { call_control_ids: callControlIds } : {};
  return telnyxRest('POST', `/conferences/${encodeURIComponent(conferenceId)}/actions/unmute`, body);
}

// Hold participants in a conference: they are removed from the audio mix (hear
// hold audio, not the other legs, and are not heard). Used to park the caller
// while an agent briefs the transfer recipient (consult transfer). unhold puts
// them back in the mix.
async function conferenceHold(conferenceId, callControlIds, audioUrl) {
  if (!conferenceId) return null;
  const body = Array.isArray(callControlIds) && callControlIds.length ? { call_control_ids: callControlIds } : {};
  if (audioUrl) body.audio_url = audioUrl;
  return telnyxRest('POST', `/conferences/${encodeURIComponent(conferenceId)}/actions/hold`, body);
}
async function conferenceUnhold(conferenceId, callControlIds) {
  if (!conferenceId) return null;
  const body = Array.isArray(callControlIds) && callControlIds.length ? { call_control_ids: callControlIds } : {};
  return telnyxRest('POST', `/conferences/${encodeURIComponent(conferenceId)}/actions/unhold`, body);
}

module.exports = {
  encodeClientState,
  decodeClientState,
  callAction,
  answerCall,
  dialCall,
  dialVapi,
  speakToCall,
  gatherUsingSpeak,
  gatherUsingAI,
  bridgeCalls,
  unbridgeCall,
  hangupCall,
  startPlayback,
  stopPlayback,
  recordStart,
  recordStop,
  startTranscription,
  stopTranscription,
  createWebrtcConnection,
  updateWebrtcConnection,
  createTelephonyCredential,
  mintCredentialToken,
  deleteTelephonyCredential,
  createConference,
  conferenceJoin,
  conferenceUpdateParticipant,
  conferenceMute,
  conferenceUnmute,
  conferenceHold,
  conferenceUnhold,
};
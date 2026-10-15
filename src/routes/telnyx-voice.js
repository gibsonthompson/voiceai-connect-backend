// ============================================================================
// TELNYX VOICE ROUTES - Own-the-call warm transfer engine (telnyx_cc clients)
// ----------------------------------------------------------------------------
// Deploy to: src/routes/telnyx-voice.js
// Mount in server.js with:   app.use('/', require('./routes/telnyx-voice'));
// AND add '/webhook/telnyx-voice' to the express.raw() exception list so the
// Telnyx webhook arrives as a raw Buffer for signature verification.
//
// This file owns these endpoints:
//
//   POST /webhook/telnyx-voice       <- Telnyx Call Control events (raw body)
//   POST /api/voice/request-transfer <- VAPI calls this when the AI decides to
//                                        hand the caller to a human (JSON body)
//   POST /api/voice/send-sms         <- the AI's send_sms tool (text the caller)
//
// THE THREE LEGS of a telnyx_cc call:
//   A = caller   (inbound PSTN leg, we answer it)
//   B = VAPI     (outbound SIP leg into VAPI, bridged to A so the AI can talk)
//   C = office   (outbound PSTN leg to a person, created only on transfer)
//
// FULL TRANSFER FLOW (own-the-call):
//   1. Caller dials in. We answer A, create a call_sessions row, dial VAPI (B),
//      and bridge A<->B. The caller is talking to the AI.
//   2. Caller asks for a human. VAPI calls /api/voice/request-transfer. We
//      UNBRIDGE A from B (keeping B alive and parked), play ringback to A so
//      the caller hears the phone ring, and dial the office (C) with premium
//      answering-machine detection.
//   3. A person answers C. We play a whisper + "press 1 to take the call"
//      (gather_using_speak) to C only. On digit 1 we stop ringback, hang up B,
//      bridge A<->C, and start recording for the owner recap.
//   4. If no one answers, it rolls to voicemail, or no key is pressed, we stop
//      ringback, hang up C, and RE-BRIDGE A<->B so the SAME AI resumes and
//      offers to book an appointment or take a message (never voicemail).
//   5. When the bridged human call ends, the recording is transcribed and
//      summarized, and the owner gets ONE recap SMS with the recording link.
//
// MULTI-INSTANCE SAFE: the transfer state lives in call_sessions.status, and
// the ring/gate/accept/return handlers each claim their step with an atomic
// status transition, so a step runs exactly once even if Telnyx delivers the
// deciding event to a different backend instance. request-transfer learns the
// outcome by polling that status (not an in-memory promise).
//
// SAFETY: vapi_direct clients never touch this file. Their calls go straight
// into VAPI exactly as before. This path only runs for numbers pointed at the
// Telnyx Call Control app.
// ============================================================================

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const router = express.Router();

const { supabase, getClientByVapiPhoneNumber } = require('../lib/supabase');
const { getPhoneNumberFromVapi } = require('../lib/vapi');
const { sendAndLogSMS } = require('../lib/sms-logger');
const { sendCallNotificationSMS } = require('../lib/notifications');
const spaces = require('../lib/spaces');
const liveMonitor = require('../lib/live-monitor-bus');
const { broadcastLiveEvent } = require('../lib/live-broadcast');
// Call-center escalation routing (opt-in, call-center agencies only).
const agentPresence = require('../lib/agent-presence');
const escalationOffers = require('../lib/escalation-offers');
const { broadcastToAgents } = require('../lib/agent-channel');
const {
  callAction,
  answerCall,
  dialCall,
  speakToCall,
  gatherUsingSpeak,
  gatherUsingAI,
  bridgeCalls,
  hangupCall,
  startPlayback,
  stopPlayback,
  recordStart,
  startTranscription,
  stopTranscription,
  deleteTelephonyCredential,
  createConference,
  conferenceJoin,
  conferenceUpdateParticipant,
  conferenceMute,
  conferenceUnmute,
  decodeClientState,
} = require('../lib/telnyx-voice');

const VAPI_SIP_URI = process.env.VAPI_SIP_URI || null;
const TELNYX_PUBLIC_KEY = process.env.TELNYX_PUBLIC_KEY || null;
const BACKEND_URL = process.env.BACKEND_URL || 'https://urchin-app-bqb4i.ondigitalocean.app';

// Ringback the caller hears while the office is dialed. Set TELNYX_RINGBACK_URL
// to a publicly reachable short ringback tone (mp3/wav) for a true phone-ring
// sound; it is looped for the whole ring. If unset, we fall back to a single
// spoken "please hold" line so the caller is never met with dead air.
const RINGBACK_AUDIO_URL = process.env.TELNYX_RINGBACK_URL || null;

// When true, a webhook with no/invalid signature is REJECTED even if
// TELNYX_PUBLIC_KEY is somehow missing. Set this (and the key) at go-live so
// the webhook is fail-closed. Left unset during first bring-up so the flow can
// be tested before the key is wired.
const REQUIRE_SIGNATURE = String(process.env.TELNYX_REQUIRE_SIGNATURE || '').toLowerCase() === 'true';

// How long the office is allowed to ring before we give up and return the
// caller to the AI.
const OFFICE_RING_SECONDS = 16;
// How long to wait for the agent to press 1 after the whisper (gives them time
// to react once they have heard who is calling).
const GATHER_TIMEOUT_MS = 10000;
// How long /api/voice/request-transfer polls for an outcome before returning
// the caller to the AI. Keep this a few seconds UNDER the VAPI tool timeout
// (set to 25s on the request_human_transfer tool in the config builder) so VAPI
// does not time the tool out first.
const TRANSFER_WAIT_MS = 27000;
// Call-center escalation: how long to wait for an assigned agent to take an
// offered call (claim it, or jump in from the browser) before falling back to
// the business's own line. A slice of the transfer budget, so the fallback dial
// still fits. Once an agent actively claims, we extend the wait for them to
// finish connecting (up to the shared transfer deadline).
const ESCALATION_OFFER_WAIT_MS = Number(process.env.ESCALATION_OFFER_WAIT_MS || 10000);
// Pause after the AI calls the transfer tool, before we take the caller off the
// AI, so the AI's short "connecting you" line finishes instead of being cut off
// mid sentence. The caller stays bridged to the AI during this pause.
const TRANSFER_PREROLL_MS = Number(process.env.TRANSFER_PREROLL_MS || 1000);

// Whisper voice matching. When Telnyx holds the ElevenLabs key as an integration
// secret (TELNYX_VOICE_API_KEY_REF set), the whisper is spoken in the client's
// own ElevenLabs voice (clients.voice_id) so it matches the AI receptionist. The
// model defaults to flash v2.5 (low latency); override with TELNYX_ELEVENLABS_MODEL.
const WHISPER_ELEVENLABS_MODEL = process.env.TELNYX_ELEVENLABS_MODEL || 'eleven_multilingual_v2';
const WHISPER_VOICE_API_KEY_REF = process.env.TELNYX_VOICE_API_KEY_REF || null;

async function whisperVoiceFor(clientId) {
  if (!WHISPER_VOICE_API_KEY_REF || !clientId) return {};
  try {
    const { data: client } = await supabase.from('clients').select('voice_id').eq('id', clientId).single();
    const vid = client && client.voice_id ? String(client.voice_id).trim() : null;
    if (!vid) return {};
    return { voice: `ElevenLabs.${WHISPER_ELEVENLABS_MODEL}.${vid}`, apiKeyRef: WHISPER_VOICE_API_KEY_REF };
  } catch (e) {
    console.warn('telnyx-voice: whisperVoiceFor lookup failed:', e.message);
    return {};
  }
}

// Pull the yes/no decision out of the (undocumented) call.ai_gather.ended
// payload. Checks the likely spots for our { accept: boolean } result and
// defaults to false (do not connect) when a clear true is not found.
function parseAiAccept(payload) {
  const candidates = [payload && payload.result, payload && payload.data && payload.data.result, payload];
  for (let c of candidates) {
    if (typeof c === 'string') { try { c = JSON.parse(c); } catch (e) { continue; } }
    if (c && typeof c === 'object') {
      if (typeof c.accept === 'boolean') return c.accept;
      if (c.result && typeof c.result.accept === 'boolean') return c.result.accept;
      if (c.parameters && typeof c.parameters.accept === 'boolean') return c.parameters.accept;
    }
  }
  return false;
}

// ----------------------------------------------------------------------------
// Whisper infra ids live in platform_settings (created lazily by vapi.js
// ensureWhisperInfra during provisioning). Read them here, cached for 60s, with
// env fallback so a manually-set env still works. DB value wins when present.
// ----------------------------------------------------------------------------
let _whisperCfg = null;
let _whisperCfgAt = 0;
async function getWhisperConfig() {
  const now = Date.now();
  if (_whisperCfg && (now - _whisperCfgAt) < 60000) return _whisperCfg;
  let connectionId = process.env.TELNYX_VOICE_CONNECTION_ID || null;
  let sipUri = process.env.VAPI_SIP_URI || null;
  try {
    const { data } = await supabase
      .from('platform_settings')
      .select('key, value')
      .in('key', ['telnyx_voice_connection_id', 'vapi_sip_uri']);
    for (const row of (data || [])) {
      if (row.key === 'telnyx_voice_connection_id' && row.value) connectionId = row.value;
      if (row.key === 'vapi_sip_uri' && row.value) sipUri = row.value;
    }
  } catch (err) {
    console.warn('telnyx-voice: getWhisperConfig settings read failed:', err.message);
  }
  _whisperCfg = { connectionId, sipUri };
  _whisperCfgAt = now;
  return _whisperCfg;
}

// ----------------------------------------------------------------------------
// E.164 formatter (local copy so this route has no dependency on vapi.js).
// ----------------------------------------------------------------------------
function toE164(phone) {
  if (!phone) return null;
  const s = String(phone).trim();
  if (s.startsWith('+') && s.length >= 11) return s;
  const digits = s.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

// ----------------------------------------------------------------------------
// Verify the Telnyx webhook signature (Ed25519).
//
// Telnyx signs `${timestamp}|${rawBody}` and sends the signature in
// 'telnyx-signature-ed25519' (base64) with the timestamp in 'telnyx-timestamp'.
// TELNYX_PUBLIC_KEY is the base64 raw 32-byte public key from the portal; we
// wrap it in the standard Ed25519 SPKI DER prefix so Node's crypto can use it.
//
// Fail-closed: once TELNYX_PUBLIC_KEY is set, a bad signature is rejected. If
// the key is NOT set, we allow the request through ONLY while TELNYX_REQUIRE_
// SIGNATURE is not 'true' (first bring-up). Set both at go-live.
// ----------------------------------------------------------------------------
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function verifyTelnyxSignature(rawBody, signatureB64, timestamp) {
  if (!TELNYX_PUBLIC_KEY) {
    if (REQUIRE_SIGNATURE) {
      console.error('telnyx-voice: TELNYX_PUBLIC_KEY not set but TELNYX_REQUIRE_SIGNATURE=true - rejecting');
      return false;
    }
    console.warn('telnyx-voice: TELNYX_PUBLIC_KEY not set - skipping signature check (set it before going live)');
    return true;
  }
  if (!signatureB64 || !timestamp) {
    console.error('telnyx-voice: missing signature or timestamp header');
    return false;
  }
  try {
    const signedPayload = Buffer.concat([
      Buffer.from(`${timestamp}|`, 'utf-8'),
      Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf-8'),
    ]);
    const rawKey = Buffer.from(TELNYX_PUBLIC_KEY, 'base64');
    const der = Buffer.concat([ED25519_SPKI_PREFIX, rawKey]);
    const keyObject = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    const signature = Buffer.from(signatureB64, 'base64');
    return crypto.verify(null, signedPayload, keyObject, signature);
  } catch (err) {
    console.error('telnyx-voice: signature verification error:', err.message);
    return false;
  }
}

// ----------------------------------------------------------------------------
// Small helpers for the call_sessions table.
// ----------------------------------------------------------------------------
async function getSessionById(id) {
  if (!id) return null;
  const { data } = await supabase.from('call_sessions').select('*').eq('id', id).single();
  return data || null;
}

async function getSessionByVapiCallId(vapiCallId) {
  if (!vapiCallId) return null;
  const { data } = await supabase
    .from('call_sessions')
    .select('*')
    .eq('vapi_call_id', vapiCallId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

async function updateSession(id, fields) {
  if (!id) return;
  fields.updated_at = new Date().toISOString();
  await supabase.from('call_sessions').update(fields).eq('id', id);
}

// Atomically move a session from one of `fromStatuses` to `toStatus`. Returns
// true only for the single caller that wins the transition. This is the lock
// that makes the ring/gate/accept/return handlers each run exactly once, even
// if Telnyx delivers the deciding event to more than one backend instance (the
// DB row is the shared store).
async function atomicTransition(sessionId, fromStatuses, toStatus, extraFields = {}) {
  if (!sessionId) return false;
  const from = Array.isArray(fromStatuses) ? fromStatuses : [fromStatuses];
  const { data, error } = await supabase
    .from('call_sessions')
    .update(Object.assign({ status: toStatus, updated_at: new Date().toISOString() }, extraFields))
    .eq('id', sessionId)
    .in('status', from)
    .select('id');
  if (error) {
    console.error('telnyx-voice: atomicTransition failed:', error.message);
    return false;
  }
  return !!(data && data.length);
}

// ============================================================================
// INBOUND: a caller dialed a telnyx_cc number. Answer, set up the session,
// dial VAPI, and bridge them so the AI can start talking.
// ============================================================================
async function handleInbound(payload) {
  const callerLeg = payload.call_control_id;
  const toNumber = payload.to;     // the client's number (DID on the Telnyx app)
  const fromNumber = payload.from; // the actual caller

  console.log(`telnyx-voice: inbound ${fromNumber} -> ${toNumber} (leg ${callerLeg})`);

  const client = await getClientByVapiPhoneNumber(toNumber);
  if (!client) {
    console.error(`telnyx-voice: no client for ${toNumber} - answering and hanging up`);
    await answerCall(callerLeg);
    await speakToCall(callerLeg, "We're sorry, this number is not in service. Goodbye.");
    setTimeout(() => hangupCall(callerLeg), 4000);
    return;
  }

  const agencyId = client.agency_id || client.agencies?.id || null;
  const officeNumber = toE164(client.transfer_phone || client.owner_phone);

  const { data: session, error } = await supabase
    .from('call_sessions')
    .insert({
      client_id: client.id,
      agency_id: agencyId,
      caller_number: fromNumber,
      office_number: officeNumber,
      telnyx_caller_control_id: callerLeg,
      status: 'active',
    })
    .select('id')
    .single();

  if (error || !session) {
    console.error('telnyx-voice: failed to create call_sessions row:', error?.message);
    await answerCall(callerLeg);
    return;
  }

  const sessionId = session.id;

  await answerCall(callerLeg, { role: 'caller', sessionId });

  const { connectionId, sipUri } = await getWhisperConfig();
  if (!sipUri) {
    console.error('telnyx-voice: no VAPI SIP URI (platform_settings.vapi_sip_uri / VAPI_SIP_URI) - cannot route call to AI');
    return;
  }

  const vapiLeg = await dialCall({
    to: sipUri,
    from: fromNumber,
    connectionId,
    customHeaders: [
      { name: 'X-Client-Id', value: String(client.id) },
      { name: 'X-Session-Id', value: String(sessionId) },
    ],
    clientState: { role: 'vapi', sessionId },
  });

  if (!vapiLeg || !vapiLeg.call_control_id) {
    console.error('telnyx-voice: failed to dial VAPI - taking caller off hold');
    return;
  }

  await updateSession(sessionId, { telnyx_vapi_control_id: vapiLeg.call_control_id });
}

// ============================================================================
// VAPI leg answered: bridge the caller to the AI.
//
// park_after_unbridge:'self' on the caller leg means that whenever this bridge
// ends by the VAPI leg hanging up, the caller leg STAYS ALIVE (parked) instead
// of dropping. We also explicitly unbridge at transfer time (see below), which
// likewise leaves both legs parked.
// ============================================================================
async function handleVapiAnswered(sessionId) {
  const session = await getSessionById(sessionId);
  if (!session) return;
  const caller = session.telnyx_caller_control_id;
  const vapi = session.telnyx_vapi_control_id;
  if (!caller || !vapi) return;

  // If the call is running as a conference (a supervisor is watching), a fresh
  // AI leg re-dialed for hand-back joins the conference instead of bridging.
  if (session.conference_active && session.telnyx_conference_id) {
    await conferenceJoin(session.telnyx_conference_id, vapi, { clientState: { role: 'vapi', sessionId } });
    if (session.status === 'agent_bridged') {
      await atomicTransition(sessionId, ['agent_bridged'], 'active');
    }
    console.log(`telnyx-voice: AI re-joined conference ${session.telnyx_conference_id} (session ${sessionId})`);
    return;
  }

  await callAction(caller, 'bridge', {
    call_control_id: vapi,
    park_after_unbridge: 'self',
  });

  // If this VAPI leg is the fresh one dialed to hand a caller BACK to the AI
  // after a human barge ended, flip the session back to the live state so the
  // normal hangup/transfer logic applies again, and let the monitor show "live".
  if (session.status === 'returning_to_ai') {
    const back = await atomicTransition(sessionId, ['returning_to_ai'], 'active');
    if (back) {
      try {
        broadcastLiveEvent(session.client_id, { type: 'status', status: 'in-progress', label: 'Back with the AI' });
        broadcastLiveEvent(session.client_id, { type: 'activity', tool: 'barge_returned', label: 'Teammate handed the call back to the AI' });
      } catch (e) {}
    }
  }
  console.log(`telnyx-voice: caller bridged to AI (session ${sessionId})`);
}

// ----------------------------------------------------------------------------
// Ringback helpers for the caller while the office is dialed.
// ----------------------------------------------------------------------------
async function startRingback(caller, audioUrl) {
  if (!caller) return;
  if (audioUrl) {
    await startPlayback(caller, audioUrl, { loop: 'infinity' });
  } else {
    await speakToCall(caller, 'Please hold while I connect you to the team.');
  }
}

// White-label the ringback/hold audio the caller hears while the agent is
// dialed. An agency can set its own ring or hold track, and a client can
// override it; otherwise the platform default (TELNYX_RINGBACK_URL) is used, and
// if none is set the caller hears a short spoken line. URLs must be publicly
// reachable by Telnyx (mp3/wav), and are looped for the whole ring.
//   client.tool_config.transferHoldAudioUrl        (per-client override)
//   agency.marketing_config.transferHoldAudioUrl    (agency white-label default)
//   TELNYX_RINGBACK_URL                             (platform default)
function resolveHoldAudioUrl(clientToolConfig, agencyMarketingConfig) {
  const c = clientToolConfig && clientToolConfig.transferHoldAudioUrl;
  const a = agencyMarketingConfig && agencyMarketingConfig.transferHoldAudioUrl;
  return (c && String(c).trim()) || (a && String(a).trim()) || RINGBACK_AUDIO_URL || null;
}

async function stopRingback(caller) {
  if (!caller) return;
  // No-op if the spoken fallback was used (nothing is playing to stop).
  await stopPlayback(caller);
}

// ============================================================================
// Office answered (human, or AMD could not confirm a machine): open the
// press-1-to-accept gate. Only the winner of transferring -> ringing_gate
// actually plays the gather, so the whisper prompt is spoken exactly once.
// ============================================================================
async function startGate(sessionId, recipientName) {
  const won = await atomicTransition(sessionId, ['transferring'], 'ringing_gate');
  if (!won) return;

  const session = await getSessionById(sessionId);
  if (!session) return;
  const office = session.telnyx_office_control_id;
  if (!office) return;

  // A comprehensive, natural whisper that greets the person by name, gives the
  // caller and reason (the AI's summary), and asks to put them through.
  const summary = session.whisper_summary || 'A caller would like to speak with you.';
  const hey = recipientName ? `Hey ${recipientName}, ` : '';
  const greeting = `${hey}${summary} Want me to send them through?`;

  // Live monitor: the team member answered and is being briefed (the whisper).
  try {
    broadcastLiveEvent(session.client_id, {
      type: 'activity', tool: 'transfer_whisper',
      label: recipientName ? `Briefing ${recipientName}` : 'Briefing the team',
    });
  } catch (e) {}

  // Speak in this client's own receptionist voice when the ElevenLabs key is
  // wired (TELNYX_VOICE_API_KEY_REF), otherwise the lib default (Polly neural).
  const voiceOpts = await whisperVoiceFor(session.client_id);

  // Accept gate: ask for a spoken yes/no via Telnyx voice AI. If the AI gather
  // cannot start (e.g. not enabled), fall back to a press-1 DTMF gate so the
  // transfer can still complete.
  const aiRes = await gatherUsingAI(office, greeting, Object.assign({
    timeoutMillis: GATHER_TIMEOUT_MS,
    clientState: { role: 'office', sessionId },
  }, voiceOpts));

  if (!aiRes) {
    console.warn(`telnyx-voice: gather_using_ai unavailable (session ${sessionId}), falling back to press-1`);
    await gatherUsingSpeak(office, `${greeting} If so, press 1.`, Object.assign({
      validDigits: '1',
      timeoutMillis: GATHER_TIMEOUT_MS,
      clientState: { role: 'office', sessionId },
    }, voiceOpts));
  }
  console.log(`telnyx-voice: accept gate opened on office (session ${sessionId})${voiceOpts.voice ? ' [voice ' + voiceOpts.voice + ']' : ''}`);
}

// ============================================================================
// Agent pressed 1: complete the handoff.
//   1. Stop ringback to the caller.
//   2. Hang up the VAPI leg (the AI's job is done).
//   3. Bridge the caller to the office.
//   4. Start recording the conversation (for the owner recap), unless HIPAA.
// Because the caller leg was parked when we unbridged it from VAPI, it survives
// the VAPI hangup and is ready to bridge to the office.
// ============================================================================
// How long to wait for the confirmation speak to finish before bridging anyway.
// call.speak.ended normally fires in ~2s; this is only a backstop so a missing
// event can never strand a caller who was told they are being connected.
const CONFIRM_FALLBACK_MS = 4500;

async function completeAccept(sessionId, recipientName) {
  // Move to a short 'confirming' phase and tell the AGENT out loud that we are
  // connecting them, so they know the transfer actually completed (otherwise
  // the line just goes quiet after they say yes). We bridge only once that
  // confirmation finishes (finalizeBridge, on call.speak.ended), so it is never
  // cut off. The caller stays on ringback for this ~2s.
  const won = await atomicTransition(sessionId, ['ringing_gate'], 'confirming');
  if (!won) return;

  const session = await getSessionById(sessionId);
  if (!session) return;
  const office = session.telnyx_office_control_id;
  if (!office) return;

  const voiceOpts = await whisperVoiceFor(session.client_id);
  await speakToCall(office, 'Perfect, connecting you now.', Object.assign({
    clientState: { role: 'office', sessionId, phase: 'confirm', recipientName: recipientName || null },
  }, voiceOpts));
  console.log(`telnyx-voice: spoke accept confirmation to agent (session ${sessionId}), awaiting speak.ended to bridge`);

  // Backstop: bridge even if call.speak.ended never arrives. Idempotent via the
  // 'confirming' -> 'bridged' transition inside finalizeBridge.
  setTimeout(() => { finalizeBridge(sessionId, recipientName).catch(() => {}); }, CONFIRM_FALLBACK_MS);
}

// Actually connect the caller to the agent. Triggered by call.speak.ended once
// the confirmation finishes (or the backstop timer). The confirming->bridged
// transition lets only the first caller through, so the event and the timer can
// never double-bridge.
async function finalizeBridge(sessionId, recipientName) {
  const won = await atomicTransition(sessionId, ['confirming'], 'bridged');
  if (!won) return;

  const session = await getSessionById(sessionId);
  if (!session) return;
  const caller = session.telnyx_caller_control_id;
  const vapi = session.telnyx_vapi_control_id;
  const office = session.telnyx_office_control_id;
  if (!caller || !office) return;

  await stopRingback(caller);
  if (vapi) await hangupCall(vapi);
  await bridgeCalls(caller, office);

  // Record the human conversation for the owner recap, unless this client is in
  // HIPAA mode (no stored recordings).
  try {
    const { data: client } = await supabase
      .from('clients').select('hipaa_mode').eq('id', session.client_id).single();
    if (client && client.hipaa_mode === true) {
      console.log(`telnyx-voice: HIPAA client - not recording transfer (session ${sessionId})`);
    } else {
      await recordStart(caller, { channels: 'dual', clientState: { role: 'caller', sessionId } });
    }
  } catch (e) {
    console.warn('telnyx-voice: hipaa check failed, recording skipped:', e.message);
  }

  // Live monitor: the AI has handed the caller to a person, so the monitor
  // should show "connected to the team" (not "ended"). The VAPI leg just went
  // away, so its transcript stops here; the viewer sees why. Best-effort.
  try {
    const who = recipientName ? `Connected to ${recipientName}` : 'Connected to the team';
    broadcastLiveEvent(session.client_id, { type: 'status', status: 'bridged', label: who });
    broadcastLiveEvent(session.client_id, {
      type: 'activity', tool: 'transfer_connected',
      label: recipientName ? `Caller connected to ${recipientName}` : 'Caller connected to the team',
    });
  } catch (e) {}

  console.log(`telnyx-voice: caller bridged to office (session ${sessionId}) - transfer connected`);
}

// ============================================================================
// Office not reached (no answer, voicemail, declined, hangup, no keypress, or
// we timed out): put the caller back with the SAME AI. The VAPI leg was parked
// (never hung up) when we unbridged for the ring, so it is still alive to
// re-bridge. request-transfer, polling the status, then tells the AI to
// apologize and offer to book or take a message.
// ============================================================================
async function returnToAI(sessionId, reason) {
  const won = await atomicTransition(sessionId, ['transferring', 'ringing_gate', 'confirming'], 'transfer_returned');
  if (!won) return;

  const session = await getSessionById(sessionId);
  if (!session) return;
  const caller = session.telnyx_caller_control_id;
  const office = session.telnyx_office_control_id;

  // The caller never left the AI (we did not unbridge), so there is nothing to
  // re-bridge: just stop the ringback and drop the office leg, and the AI is
  // already there to resume.
  await stopRingback(caller);
  if (office) await hangupCall(office);

  // Live monitor: the team did not pick up, so the caller is back with the AI.
  // Flip the pill back to Live and note it on the activity rail. Best-effort.
  try {
    broadcastLiveEvent(session.client_id, {
      type: 'activity', tool: 'transfer_returned',
      label: 'No answer from the team, caller back with the AI',
    });
    broadcastLiveEvent(session.client_id, { type: 'status', status: 'in-progress', label: 'Back with the AI' });
  } catch (e) {}

  console.log(`telnyx-voice: office not reached (${reason || 'no_answer'}) - caller stays with AI (session ${sessionId})`);
}

// ============================================================================
// BROWSER HUMAN BARGE-IN (live monitor / call-center "jump in")
// ----------------------------------------------------------------------------
// A human agent joins a live call and talks to the caller straight from the
// browser (WebRTC), replacing the AI. This reuses the own-the-call bridge-swap:
// the agent's browser registers as a Telnyx WebRTC endpoint, the backend dials
// it as a new leg, and on answer we hang up the VAPI (AI) leg (the caller parks
// alive via park_after_unbridge:'self' set at the original bridge) and bridge
// the caller to the agent. The whole takeover is recorded and transcribed in
// real time (unless HIPAA), and when the agent leaves the caller is either
// handed back to the AI (default / on an unexpected drop) or the call is ended.
//
// State: active|transfer_returned -> agent_dialing -> agent_bridged ->
//        (returning_to_ai -> active) | (ending_after_barge -> ended).
//
// These functions are exported on the router (bottom of file) so the live-
// monitor jump-in/out endpoints can drive the barge while all session logic
// stays in this one file.
// ============================================================================

// How long the browser endpoint is allowed to ring before we give up.
const AGENT_RING_SECONDS = 30;
// Backstop: if call.speak.ended never arrives after the end-of-barge goodbye,
// hang the caller up anyway so a missing event cannot strand them.
const BARGE_END_FALLBACK_MS = 7000;

// Best-effort revoke of the per-barge WebRTC credential once the agent is gone.
async function cleanupBargeCredential(session) {
  try {
    if (session && session.telnyx_agent_credential_id) {
      await deleteTelephonyCredential(session.telnyx_agent_credential_id);
    }
  } catch (e) { /* credential auto-expires anyway */ }
}

// Start a barge: dial the agent's registered WebRTC endpoint as a new leg. The
// atomic active->agent_dialing transition makes this safe against a double
// jump-in (only the first wins) and against barging a call that is mid-transfer
// or already ended. completeBarge (on the agent's call.answered) does the swap.
async function startBarge({ sessionId, sipUsername, credentialId }) {
  if (!sessionId || !sipUsername) return { ok: false, code: 400, error: 'Missing session or endpoint.' };

  const won = await atomicTransition(sessionId, ['active', 'transfer_returned'], 'agent_dialing', {
    telnyx_agent_sip_username: String(sipUsername),
    telnyx_agent_credential_id: credentialId || null,
    telnyx_agent_control_id: null,
    agent_leave_mode: null,
  });
  if (!won) {
    const s = await getSessionById(sessionId);
    const st = (s && s.status) || 'unknown';
    if (st === 'agent_dialing' || st === 'agent_bridged') {
      return { ok: false, code: 409, error: 'A teammate is already on this call.' };
    }
    if (st === 'transferring' || st === 'ringing_gate' || st === 'confirming' || st === 'bridged') {
      return { ok: false, code: 409, error: 'This call is being transferred to a person already.' };
    }
    return { ok: false, code: 409, error: `This call can't be joined right now (${st}).` };
  }

  const session = await getSessionById(sessionId);
  const caller = session && session.telnyx_caller_control_id;
  if (!caller) {
    await atomicTransition(sessionId, ['agent_dialing'], 'active', { telnyx_agent_control_id: null });
    return { ok: false, code: 409, error: 'That call is no longer live.' };
  }

  // Present the business line as the caller ID on the agent leg (cosmetic; the
  // agent sees the call in their browser regardless).
  let fromNumber = session.caller_number || null;
  try {
    const { data: client } = await supabase.from('clients').select('vapi_phone_number').eq('id', session.client_id).single();
    if (client && client.vapi_phone_number) fromNumber = toE164(client.vapi_phone_number) || fromNumber;
  } catch (e) {}

  const { connectionId } = await getWhisperConfig();
  const agentLeg = await dialCall({
    to: `sip:${String(sipUsername)}@sip.telnyx.com`,
    from: fromNumber || session.caller_number || '+10000000000',
    connectionId,
    timeoutSecs: AGENT_RING_SECONDS,
    clientState: { role: 'agent', sessionId },
  });

  if (!agentLeg || !agentLeg.call_control_id) {
    // Could not reach the browser endpoint: abort cleanly, caller stays with the
    // AI (the VAPI leg was never touched).
    await atomicTransition(sessionId, ['agent_dialing'], 'active', { telnyx_agent_control_id: null });
    await cleanupBargeCredential(session);
    return { ok: false, code: 502, error: 'Could not reach your browser audio. Check your mic permission and try again.' };
  }

  await updateSession(sessionId, { telnyx_agent_control_id: agentLeg.call_control_id });
  try {
    broadcastLiveEvent(session.client_id, { type: 'activity', tool: 'barge_dialing', label: 'A teammate is joining the call' });
  } catch (e) {}
  console.log(`telnyx-voice: 🎧 barge dialing sip:${sipUsername}@sip.telnyx.com from ${fromNumber} -> agent leg ${agentLeg.call_control_id} (session ${sessionId}); awaiting call.answered`);
  return { ok: true };
}

// The agent's browser answered: swap the AI out for the human.
//   1. Hang up the VAPI leg (the caller parks, alive, via park_after_unbridge).
//   2. Bridge the caller to the agent, parking the caller again so it survives
//      the agent leaving (so we can hand it back to the AI or end it cleanly).
//   3. Record + transcribe the takeover for the recap + live monitor (non-HIPAA).
async function completeBarge(sessionId) {
  const won = await atomicTransition(sessionId, ['agent_dialing'], 'agent_bridged', { barged: true });
  if (!won) {
    // The call ended (or was torn down) while the browser was ringing. Drop the
    // stray agent leg so it does not sit connected to nothing.
    const s = await getSessionById(sessionId);
    if (s && s.telnyx_agent_control_id) await hangupCall(s.telnyx_agent_control_id);
    return;
  }

  const session = await getSessionById(sessionId);
  if (!session) return;
  const caller = session.telnyx_caller_control_id;
  const vapi = session.telnyx_vapi_control_id;
  const agent = session.telnyx_agent_control_id;
  if (!caller || !agent) {
    console.error(`telnyx-voice: completeBarge missing legs (session ${sessionId})`);
    return;
  }

  // Swap: drop the AI, then connect the caller to the human. The caller was
  // bridged to VAPI with park_after_unbridge:'self', so hanging up VAPI parks
  // the caller (alive) instead of dropping it.
  if (vapi) await hangupCall(vapi);
  await bridgeCalls(caller, agent, { parkAfterUnbridge: 'self' });

  // Record + transcribe the human takeover unless this client is HIPAA (no
  // stored audio/transcripts). The recording is on the caller leg, which lives
  // through the whole call, so it captures the takeover (and the AI before and
  // after it) as one file; the real-time transcript keeps the live monitor
  // flowing now that the VAPI transcript has stopped.
  let hipaa = false;
  try {
    const { data: client } = await supabase.from('clients').select('hipaa_mode').eq('id', session.client_id).single();
    hipaa = !!(client && client.hipaa_mode === true);
  } catch (e) {}

  if (!hipaa) {
    await recordStart(caller, { channels: 'dual', clientState: { role: 'caller', sessionId } });
    await startTranscription(caller, { tracks: 'both', interim: true, clientState: { role: 'caller', sessionId } });
    console.log(`telnyx-voice: 🎧 barge recording + live transcription started on caller leg (session ${sessionId})`);
  } else {
    console.log(`telnyx-voice: 🎧 barge HIPAA client - not recorded/transcribed (session ${sessionId})`);
  }

  try {
    broadcastLiveEvent(session.client_id, { type: 'status', status: 'agent_connected', label: 'Teammate on the call' });
    broadcastLiveEvent(session.client_id, { type: 'activity', tool: 'barge_connected', label: 'A teammate joined and is talking to the caller' });
  } catch (e) {}
  console.log(`telnyx-voice: barge connected - caller bridged to agent browser (session ${sessionId})`);
}

// The agent left the call (clicked leave/end in the UI, or their browser leg
// dropped). Decide what happens to the caller:
//   - agent never connected (still 'agent_dialing'): the AI was never swapped
//     out, so just clear the barge; the caller is still with the AI.
//   - leave mode 'end_call': end the call (recap fires on the recording).
//   - otherwise (explicit 'return_ai', or an unexpected drop): hand the caller
//     back to the AI by dialing a fresh VAPI leg, so they are never abandoned.
async function handleAgentLeave(sessionId, reason) {
  const session = await getSessionById(sessionId);
  if (!session) return;

  // Agent leg went away before it ever connected: the caller never left the AI.
  if (session.status === 'agent_dialing') {
    const reverted = await atomicTransition(sessionId, ['agent_dialing'], 'active', { telnyx_agent_control_id: null });
    if (reverted) {
      await cleanupBargeCredential(session);
      try { broadcastLiveEvent(session.client_id, { type: 'activity', tool: 'barge_canceled', label: 'Teammate did not connect, caller still with the AI' }); } catch (e) {}
      console.log(`telnyx-voice: barge canceled before connect (${reason || 'drop'}) - caller stays with AI (session ${sessionId})`);
    }
    return;
  }

  if (session.status !== 'agent_bridged') return; // already ended / returning; nothing to do.

  const mode = session.agent_leave_mode || 'return_ai';
  const caller = session.telnyx_caller_control_id;

  if (mode === 'end_call') {
    const won = await atomicTransition(sessionId, ['agent_bridged'], 'ending_after_barge');
    if (!won) return;
    await stopTranscription(caller).catch(() => {});
    await cleanupBargeCredential(session);
    try { broadcastLiveEvent(session.client_id, { type: 'activity', tool: 'barge_ended', label: 'Teammate ended the call' }); } catch (e) {}
    // Hang the caller up: this fires call.hangup (role caller) which finalizes
    // the session as ended, and call.recording.saved then sends the one recap.
    if (caller) await hangupCall(caller);
    console.log(`telnyx-voice: barge ended by agent - hanging up caller (session ${sessionId})`);
    return;
  }

  // Default: hand the caller back to the AI (also the safe path for an
  // unexpected browser drop, so a caller is never left in silence).
  const won = await atomicTransition(sessionId, ['agent_bridged'], 'returning_to_ai');
  if (!won) return;
  await stopTranscription(caller).catch(() => {});
  await cleanupBargeCredential(session);
  await reBridgeToAI(await getSessionById(sessionId), reason);
}

// Driven by the jump-out endpoint for an INTENTIONAL leave. We record the mode,
// then hang up the agent's browser leg; the resulting call.hangup(role:agent)
// runs handleAgentLeave with the right sequencing (agent gone -> caller parked
// -> back to AI or end). An UNEXPECTED browser drop skips this and lands on the
// same webhook handler directly (with the default return-to-AI mode).
async function requestAgentLeave(sessionId, mode) {
  const session = await getSessionById(sessionId);
  if (!session) return { ok: false, error: 'No live session.' };
  const leaveMode = mode === 'end_call' ? 'end_call' : 'return_ai';
  await updateSession(sessionId, { agent_leave_mode: leaveMode });

  if (session.telnyx_agent_control_id &&
      (session.status === 'agent_bridged' || session.status === 'agent_dialing')) {
    await hangupCall(session.telnyx_agent_control_id);
  } else if (session.status === 'agent_bridged' || session.status === 'agent_dialing') {
    // No agent leg id on record (shouldn't happen) but we are mid-barge: fall
    // back to driving the leave directly so the caller is not left stranded.
    await handleAgentLeave(sessionId, 'jump_out_no_leg');
  }
  return { ok: true, mode: leaveMode };
}

// Dial a fresh VAPI leg and hand the (parked) caller back to the AI. On answer,
// handleVapiAnswered bridges them and flips the session back to 'active'.
async function reBridgeToAI(session, reason) {
  if (!session) return;
  const sessionId = session.id;
  const caller = session.telnyx_caller_control_id;
  if (!caller) { await updateSession(sessionId, { status: 'ended' }); return; }

  const { connectionId, sipUri } = await getWhisperConfig();
  if (!sipUri) {
    // No way to reach the AI: at least do not leave the caller in silence.
    await speakToCall(caller, 'Thanks for calling. Goodbye.');
    setTimeout(() => hangupCall(caller).catch(() => {}), 3000);
    await updateSession(sessionId, { status: 'ending_after_barge' });
    return;
  }

  const vapiLeg = await dialCall({
    to: sipUri,
    from: session.caller_number,
    connectionId,
    customHeaders: [
      { name: 'X-Client-Id', value: String(session.client_id) },
      { name: 'X-Session-Id', value: String(sessionId) },
    ],
    clientState: { role: 'vapi', sessionId, rebridge: true },
  });

  if (!vapiLeg || !vapiLeg.call_control_id) {
    // Could not reach the AI: say goodbye and end rather than stranding the caller.
    await speakToCall(caller, 'Sorry about that. Thanks for calling. Goodbye.');
    setTimeout(() => hangupCall(caller).catch(() => {}), 3500);
    await atomicTransition(sessionId, ['returning_to_ai'], 'ending_after_barge');
    console.warn(`telnyx-voice: re-dial to AI failed (session ${sessionId}) - ending call`);
    return;
  }

  await updateSession(sessionId, { telnyx_vapi_control_id: vapiLeg.call_control_id });
  console.log(`telnyx-voice: handing caller back to AI (${reason || 'agent_left'}) - dialed fresh VAPI leg (session ${sessionId})`);
}

// A real-time transcription fragment arrived during a barge. Push it to the live
// monitor and accumulate finals onto the session as a recap fallback.
async function handleBargeTranscription(sessionId, payload) {
  try {
    const t = payload.transcription_data || payload.transcription || payload || {};
    const text = (t.transcript || t.text || '').toString().trim();
    if (!text) return;
    const isFinal = (t.is_final === true) || (payload.is_final === true) || ((t.type || '').toString() === 'final');
    // Telnyx labels the track: inbound = caller, outbound = the agent.
    const track = (t.track || payload.track || '').toString();
    const who = track === 'outbound' ? 'agent' : (track === 'inbound' ? 'caller' : 'unknown');

    const session = await getSessionById(sessionId);
    if (!session) return;

    try {
      broadcastLiveEvent(session.client_id, {
        type: 'transcript', role: who === 'agent' ? 'assistant' : 'user', speaker: who,
        text, final: !!isFinal, source: 'barge',
      });
    } catch (e) {}

    // Keep a running transcript of the human takeover so the recap still has
    // text even if the recording STT later fails. Finals only, to avoid churn.
    if (isFinal) {
      const prefix = who === 'agent' ? 'Agent' : (who === 'caller' ? 'Caller' : 'Speaker');
      const line = `${prefix}: ${text}`;
      const prev = (session.agent_transcript || '').trim();
      const next = prev ? `${prev}\n${line}` : line;
      await updateSession(sessionId, { agent_transcript: next.slice(0, 20000) });
    }
  } catch (e) {
    console.warn(`telnyx-voice: handleBargeTranscription failed: ${e.message}`);
  }
}

// ============================================================================
// CONFERENCE LIVE-MONITOR SEAT (real-time listen + jump-in)
// ----------------------------------------------------------------------------
// When a supervisor opens a live own-the-call call to listen, we promote the
// 2-leg caller<->VAPI bridge into a Telnyx conference and seat the supervisor's
// browser (over WebRTC) in it. supervisor_role 'monitor' = listen (muted, hears
// all); 'barge' = talk to the caller. Listening is real-time WebRTC audio (no
// PCM relay, no sync slider). Jump-in drops the AI and flips the seat to barge;
// hand-back re-dials the AI into the conference.
//
// SAFETY: promotion is fail-safe. We create the conference FROM the VAPI leg,
// which unbridges the caller; the caller parks alive (park_after_unbridge:'self'
// from the original bridge), then we join it into the conference. If any step
// fails, we re-bridge caller<->VAPI so the call is never left broken.
// ============================================================================
const CONF_PREFIX = 'vac';
const AGENT_RING_SECONDS_SEAT = 30;

// The display name of the teammate seated on each live call (sessionId -> name),
// set from the logged-in user when they start listening. Used to attribute the
// listen/jump-in/hand-back events to the actual person instead of "a teammate",
// which is what a call center needs (who is on which call). In-memory and
// best-effort: a missing name just falls back to the generic wording.
const supervisorNames = new Map();
function nameFor(sessionId) {
  const n = supervisorNames.get(sessionId);
  return (typeof n === 'string' && n.trim()) ? n.trim() : null;
}

// Durable-for-the-call timeline of who listened / jumped in / handed back on
// each call (sessionId -> [{ name, action, at }]). Accumulated in memory as the
// events happen, then flushed onto the call record (calls.call_metadata) at save
// time so the post-call review can show exactly who handled the call. Entries
// are pruned by a TTL so a long-running process never grows unbounded.
const supervisorEvents = new Map();
const SUP_EVENTS_TTL_MS = 6 * 60 * 60 * 1000;
function recordSupervisorEvent(sessionId, action) {
  if (!sessionId || !action) return;
  try {
    const list = supervisorEvents.get(sessionId) || [];
    list.push({ name: nameFor(sessionId) || null, action, at: new Date().toISOString() });
    supervisorEvents.set(sessionId, list);
    // Prune stale sessions.
    const cutoff = Date.now() - SUP_EVENTS_TTL_MS;
    for (const [sid, arr] of supervisorEvents) {
      const last = arr.length ? Date.parse(arr[arr.length - 1].at) : 0;
      if (last && last < cutoff) supervisorEvents.delete(sid);
    }
  } catch (e) { /* best effort */ }
}
function getSupervisorEvents(sessionId) {
  try { return (supervisorEvents.get(sessionId) || []).slice(); } catch { return []; }
}

// Promote a live call into a conference (idempotent). Returns the conference id.
async function ensureConference(session) {
  if (!session) return null;
  if (session.conference_active && session.telnyx_conference_id) return session.telnyx_conference_id;
  const caller = session.telnyx_caller_control_id;
  const vapi = session.telnyx_vapi_control_id;
  if (!caller || !vapi) { console.warn(`telnyx-voice: 🎧 cannot promote, missing legs (session ${session.id})`); return null; }

  // Only one promotion at a time, and only from a live AI state.
  const won = await atomicTransition(session.id, ['active', 'transfer_returned'], 'conferencing');
  if (!won) {
    const s = await getSessionById(session.id);
    return (s && s.conference_active && s.telnyx_conference_id) ? s.telnyx_conference_id : null;
  }

  const name = `${CONF_PREFIX}-${session.id}`;
  const conf = await createConference(vapi, name, { clientState: { role: 'vapi', sessionId: session.id } });
  if (!conf || !conf.id) {
    console.error(`telnyx-voice: 🎧 conference create failed (session ${session.id}) - restoring bridge`);
    await bridgeCalls(caller, vapi, { parkAfterUnbridge: 'self' }).catch(() => {});
    await atomicTransition(session.id, ['conferencing'], 'active');
    return null;
  }
  const joined = await conferenceJoin(conf.id, caller, { clientState: { role: 'caller', sessionId: session.id } });
  if (!joined) {
    console.error(`telnyx-voice: 🎧 caller join failed (session ${session.id}) - restoring bridge`);
    await bridgeCalls(caller, vapi, { parkAfterUnbridge: 'self' }).catch(() => {});
    await atomicTransition(session.id, ['conferencing'], 'active');
    return null;
  }

  await updateSession(session.id, { telnyx_conference_id: conf.id, conference_active: true });
  await atomicTransition(session.id, ['conferencing'], 'active');
  console.log(`telnyx-voice: 🎧 call promoted to conference ${conf.id} (session ${session.id})`);
  return conf.id;
}

// Start a listen seat: promote to a conference and dial the supervisor's browser.
// On answer, completeSupervisorSeat joins it as a muted monitor.
async function startSupervisorListen({ sessionId, sipUsername, credentialId, agentName }) {
  if (!sessionId || !sipUsername) return { ok: false, code: 400, error: 'Missing session or endpoint.' };
  // Remember who is seating in, so every event on this call names the person.
  if (agentName && String(agentName).trim()) supervisorNames.set(sessionId, String(agentName).trim().slice(0, 80));
  const session = await getSessionById(sessionId);
  if (!session) return { ok: false, code: 404, error: 'No live session.' };
  if (session.telnyx_agent_control_id && session.supervisor_role) {
    return { ok: false, code: 409, error: 'A teammate is already on this call.' };
  }
  if (!session.telnyx_caller_control_id || !session.telnyx_vapi_control_id) {
    return { ok: false, code: 409, error: 'That call is no longer live.' };
  }

  const confId = await ensureConference(session);
  if (!confId) return { ok: false, code: 502, error: 'Could not open the live audio for this call. Try again.' };

  let fromNumber = session.caller_number || null;
  try {
    const { data: client } = await supabase.from('clients').select('vapi_phone_number').eq('id', session.client_id).single();
    if (client && client.vapi_phone_number) fromNumber = toE164(client.vapi_phone_number) || fromNumber;
  } catch (e) {}

  await updateSession(sessionId, {
    telnyx_agent_sip_username: String(sipUsername),
    telnyx_agent_credential_id: credentialId || null,
    telnyx_agent_control_id: null,
    supervisor_role: null,
    agent_leave_mode: null,
  });

  const { connectionId } = await getWhisperConfig();
  const seatLeg = await dialCall({
    to: `sip:${String(sipUsername)}@sip.telnyx.com`,
    from: fromNumber || session.caller_number || '+10000000000',
    connectionId,
    timeoutSecs: AGENT_RING_SECONDS_SEAT,
    clientState: { role: 'supervisor', sessionId },
  });
  if (!seatLeg || !seatLeg.call_control_id) {
    return { ok: false, code: 502, error: 'Could not reach your browser audio. Check mic permission and try again.' };
  }
  await updateSession(sessionId, { telnyx_agent_control_id: seatLeg.call_control_id });
  console.log(`telnyx-voice: 🎧 supervisor seat dialing sip:${sipUsername}@sip.telnyx.com -> leg ${seatLeg.call_control_id} (session ${sessionId})`);
  return { ok: true };
}

// The supervisor browser answered: seat it in the conference as a muted monitor.
async function completeSupervisorSeat(sessionId) {
  const session = await getSessionById(sessionId);
  if (!session || !session.telnyx_conference_id || !session.telnyx_agent_control_id) {
    const s = session || await getSessionById(sessionId);
    if (s && s.telnyx_agent_control_id) await hangupCall(s.telnyx_agent_control_id);
    return;
  }
  // Join as a normal participant that is server-MUTED, not as a Telnyx
  // "monitor" supervisor. Jumping in later only unmutes this leg (server side),
  // which does NOT change the browser's own media direction. The old monitor->
  // barge role flip DID change it, which renegotiated the browser's WebRTC media
  // and sent the @telnyx/webrtc SDK into a _dispatchNotification/setState loop
  // ("Maximum call stack size exceeded") that crashed the page and dropped the
  // seat the instant the agent jumped in. supervisor_role in our DB stays the
  // logical 'monitor'/'barge' label the state machine checks.
  await conferenceJoin(session.telnyx_conference_id, session.telnyx_agent_control_id, {
    mute: true,
    clientState: { role: 'supervisor', sessionId },
  });
  await updateSession(sessionId, { supervisor_role: 'monitor' });
  try {
    broadcastLiveEvent(session.client_id, { type: 'activity', tool: 'barge_dialing', label: `${nameFor(session.id) || 'A teammate'} is listening in` });
  } catch (e) {}
  recordSupervisorEvent(sessionId, 'listening');
  console.log(`telnyx-voice: 🎧 supervisor seated as monitor in conference ${session.telnyx_conference_id} (session ${sessionId})`);
}

// Jump in: drop the AI and flip the supervisor seat to barge so the human talks
// to the caller. Record + transcribe the takeover (unless HIPAA).
async function supervisorJumpIn(sessionId) {
  const session = await getSessionById(sessionId);
  if (!session) return { ok: false, code: 404, error: 'No live session.' };
  if (!session.telnyx_conference_id || session.supervisor_role !== 'monitor' || !session.telnyx_agent_control_id) {
    return { ok: false, code: 409, error: 'Start listening first, then jump in.' };
  }
  const won = await atomicTransition(sessionId, ['active'], 'agent_bridged', { barged: true, supervisor_role: 'barge' });
  if (!won) return { ok: false, code: 409, error: 'This call can’t be joined right now.' };

  const caller = session.telnyx_caller_control_id;
  const vapi = session.telnyx_vapi_control_id;
  // Remove the AI from the conference so the human fully takes over. Log each
  // step: if the caller gets dropped ("couldn't find number"), these lines show
  // whether it was the AI hangup collapsing the conference or a failed role flip.
  console.log(`telnyx-voice: 🎧 jump-in begin (session ${sessionId}) conf=${session.telnyx_conference_id} caller=${caller} vapi=${vapi} seat=${session.telnyx_agent_control_id}`);
  if (vapi) {
    const hv = await hangupCall(vapi).catch((e) => { console.warn(`telnyx-voice: 🎧 jump-in hangup(vapi) threw: ${e.message}`); return null; });
    console.log(`telnyx-voice: 🎧 jump-in hung up AI leg ${vapi} (session ${sessionId}) ok=${!!hv}`);
  }
  // Unmute the seat so the human is heard. We do NOT flip the Telnyx supervisor
  // role (monitor->barge): that change renegotiated the browser's media and
  // crashed the page SDK. The seat joined as a normal muted participant, so a
  // plain server-side unmute is all it takes and the browser media never moves.
  const unmuted = await conferenceUnmute(session.telnyx_conference_id, [session.telnyx_agent_control_id]);
  console.log(`telnyx-voice: 🎧 jump-in unmute seat (session ${sessionId}) ok=${!!unmuted}`);

  let hipaa = false;
  try {
    const { data: client } = await supabase.from('clients').select('hipaa_mode').eq('id', session.client_id).single();
    hipaa = !!(client && client.hipaa_mode === true);
  } catch (e) {}
  if (!hipaa && caller) {
    await recordStart(caller, { channels: 'dual', clientState: { role: 'caller', sessionId } });
    await startTranscription(caller, { tracks: 'both', interim: true, clientState: { role: 'caller', sessionId } });
    console.log(`telnyx-voice: 🎧 jump-in recording + transcription started (session ${sessionId})`);
  }
  try {
    broadcastLiveEvent(session.client_id, { type: 'status', status: 'agent_connected', label: `${nameFor(session.id) || 'A teammate'} is on the call` });
    broadcastLiveEvent(session.client_id, { type: 'activity', tool: 'barge_connected', label: `${nameFor(session.id) || 'A teammate'} took over the call` });
  } catch (e) {}
  recordSupervisorEvent(sessionId, 'jumped_in');
  console.log(`telnyx-voice: 🎧 supervisor jumped in (session ${sessionId})`);
  return { ok: true };
}

// Hand the caller back to the AI: re-dial a fresh VAPI leg into the conference
// and flip the supervisor back to a muted monitor.
async function supervisorHandBack(session) {
  const sessionId = session.id;
  const caller = session.telnyx_caller_control_id;
  await stopTranscription(caller).catch(() => {});
  // Re-mute the seat (server side) instead of flipping its supervisor role back
  // to monitor. Same reason as jump-in: a role change renegotiates the browser
  // media and crashes the SDK. Muting leaves the browser leg untouched.
  if (session.telnyx_agent_control_id && session.telnyx_conference_id) {
    await conferenceMute(session.telnyx_conference_id, [session.telnyx_agent_control_id]).catch(() => {});
    await updateSession(sessionId, { supervisor_role: 'monitor' });
  }
  const { connectionId, sipUri } = await getWhisperConfig();
  if (!sipUri) { await updateSession(sessionId, { status: 'active' }); return; }
  const vapiLeg = await dialCall({
    to: sipUri,
    from: session.caller_number,
    connectionId,
    customHeaders: [
      { name: 'X-Client-Id', value: String(session.client_id) },
      { name: 'X-Session-Id', value: String(sessionId) },
    ],
    clientState: { role: 'vapi', sessionId, rebridge: true },
  });
  if (!vapiLeg || !vapiLeg.call_control_id) {
    await atomicTransition(sessionId, ['agent_bridged'], 'active');
    console.warn(`telnyx-voice: 🎧 hand-back re-dial failed (session ${sessionId})`);
    return;
  }
  await updateSession(sessionId, { telnyx_vapi_control_id: vapiLeg.call_control_id });
  recordSupervisorEvent(sessionId, 'handed_back');
  console.log(`telnyx-voice: 🎧 handing caller back to AI in conference (session ${sessionId})`);
}

// Supervisor leaves the seat entirely (stop listening). Hang up their leg; the
// caller + AI stay in the conference and the call continues.
async function supervisorLeaveSeat(sessionId) {
  const session = await getSessionById(sessionId);
  if (!session) return { ok: true };
  if (session.status === 'agent_bridged') {
    // They were talking: hand back to the AI first so the caller is not dropped.
    await supervisorHandBack(session);
    await atomicTransition(sessionId, ['agent_bridged'], 'active');
  }
  const seat = session.telnyx_agent_control_id;
  const who = nameFor(sessionId) || 'A teammate';
  const wasBarged = session.status === 'agent_bridged';
  await updateSession(sessionId, { supervisor_role: null, telnyx_agent_control_id: null });
  if (seat) await hangupCall(seat);
  await cleanupBargeCredential(session);
  try {
    // If they had taken over, the AI is back now, so flip the pill off "on the
    // call" and back to the AI. (A plain listener leaving changes nothing.)
    if (wasBarged) broadcastLiveEvent(session.client_id, { type: 'status', status: 'in-progress', label: 'AI on the call' });
    broadcastLiveEvent(session.client_id, { type: 'activity', tool: 'barge_ended', label: `${who} stopped monitoring` });
  } catch (e) {}
  supervisorNames.delete(sessionId);
  recordSupervisorEvent(sessionId, 'left');
  console.log(`telnyx-voice: 🎧 supervisor left the seat (session ${sessionId})`);
  return { ok: true };
}

// Driven by jump-out endpoint. mode 'end_call' hangs up the caller (ends the
// conference); 'return_ai' hands back to the AI and stays seated as monitor.
async function supervisorJumpOut(sessionId, mode) {
  const session = await getSessionById(sessionId);
  if (!session) return { ok: false, error: 'No live session.' };
  if (session.status !== 'agent_bridged') return { ok: true };
  const leaveMode = mode === 'end_call' ? 'end_call' : 'return_ai';
  if (leaveMode === 'end_call') {
    await stopTranscription(session.telnyx_caller_control_id).catch(() => {});
    await updateSession(sessionId, { status: 'ending_after_barge', agent_leave_mode: 'end_call' });
    if (session.telnyx_caller_control_id) await hangupCall(session.telnyx_caller_control_id);
    recordSupervisorEvent(sessionId, 'ended_call');
    try { broadcastLiveEvent(session.client_id, { type: 'activity', tool: 'barge_ended', label: `${nameFor(sessionId) || 'A teammate'} ended the call` }); } catch (e) {}
    return { ok: true, mode: 'end_call' };
  }
  await supervisorHandBack(session);
  await atomicTransition(sessionId, ['agent_bridged'], 'active');
  try {
    // AI is back on the line now, so reset the pill off "on the call".
    broadcastLiveEvent(session.client_id, { type: 'status', status: 'in-progress', label: 'AI on the call' });
    broadcastLiveEvent(session.client_id, { type: 'activity', tool: 'barge_returned', label: `${nameFor(sessionId) || 'A teammate'} handed the call back to the AI` });
  } catch (e) {}
  return { ok: true, mode: 'return_ai' };
}

// ===========================================================================
// TRANSFER-CALL RECAP: the caller<->agent conversation happens on Telnyx after
// the AI is gone, so we record it, transcribe it with Telnyx Speech-to-Text,
// summarize it with Claude, and text the owner what actually happened plus the
// recording. All best-effort: if transcription fails, the owner still gets the
// recording link. (Mirrors the proven REFER-path recap.)
// ===========================================================================

// Format a US phone number as (XXX) XXX-XXXX for the owner SMS, matching how a
// normal call's notification shows it. Telephony gives us the raw caller id
// (e.g. +16783161454 / 6783161454); this presents it the same friendly way.
// Non-US / unexpected lengths are returned unchanged.
function formatPhoneUS(raw) {
  if (!raw) return '';
  let d = String(raw).replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return String(raw);
}

// Download a hosted recording to a Buffer. The Telnyx presigned S3 URL works
// for a plain GET but expires in ~10 minutes, so we fetch the bytes ONCE here
// and reuse them for both transcription and permanent storage.
async function fetchRecordingBuffer(fileUrl) {
  if (!fileUrl) return null;
  try {
    const res = await fetch(fileUrl);
    if (!res.ok) { console.error(`telnyx-voice: recording download failed [${res.status}]`); return null; }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) { console.error('telnyx-voice: recording download was empty'); return null; }
    return buf;
  } catch (e) { console.error(`telnyx-voice: recording download threw: ${e.message}`); return null; }
}

// Transcribe already-downloaded recording bytes with Telnyx Speech-to-Text
// (synchronous). Takes a Buffer (not a URL): STT's file_url path rejected the
// presigned recording URL with "content-length not found", so we upload the
// bytes as a file.
async function telnyxTranscribe(buf) {
  const key = process.env.TELNYX_API_KEY;
  if (!key || !buf || !buf.length) return null;
  try {
    const fd = new FormData();
    fd.set('model', 'openai/whisper-large-v3-turbo');
    fd.set('file', new Blob([buf], { type: 'audio/mpeg' }), 'recording.mp3');
    fd.set('response_format', 'json');
    const controller = new AbortController();
    const timer = setTimeout(() => { try { controller.abort(); } catch (e) {} }, 60000);
    const r = await fetch('https://api.telnyx.com/v2/ai/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: fd,
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (!r.ok) { console.error(`telnyx-voice: STT failed [${r.status}]: ${(await r.text().catch(() => '')).slice(0, 180)}`); return null; }
    const data = await r.json();
    return (data && (data.text || (data.data && data.data.text))) || null;
  } catch (e) { console.error(`telnyx-voice: STT threw: ${e.message}`); return null; }
}

// Persist recording bytes to DigitalOcean Spaces so the dashboard player has a
// durable URL (the raw Telnyx URL dies in ~10 min). Returns the permanent
// public URL, or null if Spaces is not configured / the upload failed (callers
// then leave recording_url untouched rather than store a URL that will expire).
async function persistTransferRecording(clientId, sessionId, buf) {
  if (!buf || !buf.length || !spaces.spacesConfigured) return null;
  try {
    const key = `transfer-recordings/${clientId}/${sessionId}-${Date.now()}.mp3`;
    const url = await spaces.uploadBuffer(key, buf, 'audio/mpeg');
    console.log(`telnyx-voice: transfer recording stored in Spaces (${key})`);
    return url;
  } catch (e) {
    console.error(`telnyx-voice: Spaces upload failed: ${e.message}`);
    return null;
  }
}

// Combine the pre-transfer AI transcript (speaker-labeled, from VAPI) with the
// post-transfer human conversation (plain text, from Telnyx STT) into one
// transcript the dashboard shows. Either part may be empty.
function buildCombinedTranscript(aiTranscript, humanTranscript) {
  const human = (humanTranscript || '').trim();
  if (!human) return (aiTranscript || '').trim() || null;
  const divider = '\n\n----------\n[Call transferred to a team member]\n\n';
  const ai = (aiTranscript || '').trim();
  return ai ? ai + divider + human : `[Call transferred to a team member]\n\n${human}`;
}

// Summarize the transferred (human) conversation with Claude. callerContext is
// the AI's one-line intake summary (whisper_summary), passed so the recap ties
// what the caller originally wanted to what was discussed with the person.
async function summarizeTransferCall(transcript, businessName, callerContext) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !transcript) return null;
  const ctx = callerContext ? `\n\nFor context, before the transfer the AI receptionist noted: ${callerContext}` : '';
  const prompt = `This is a transcript of a phone call between a caller and a team member at ${businessName || 'the business'}, after an AI receptionist transferred the call to a person. In 2 to 4 short sentences, summarize what actually happened: what the caller needed, what was discussed or agreed, and any follow-up or next step. Be concrete and factual. No greetings, no labels, just the summary.${ctx}\n\nTranscript:\n${transcript}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => { try { controller.abort(); } catch (e) {} }, 20000);
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 400, temperature: 0.3, messages: [{ role: 'user', content: prompt }] }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (!r.ok) { console.error(`telnyx-voice: anthropic recap failed [${r.status}]`); return null; }
    const data = await r.json();
    const text = data && data.content && data.content[0] && data.content[0].text;
    return (text || '').trim() || null;
  } catch (e) { console.error(`telnyx-voice: anthropic recap threw: ${e.message}`); return null; }
}

// Recording of the bridged human call is ready: transcribe, summarize, and text
// the owner the recap + recording link. This is the SINGLE owner text on a
// connected transfer (the intake end-of-call SMS is suppressed in vapi-webhook
// for bridged sessions). Best-effort throughout.
async function handleRecordingSaved(sessionId, recordingUrl) {
  if (!recordingUrl) { console.warn(`telnyx-voice: recording.saved with no url (session ${sessionId})`); return; }
  try {
    const session = await getSessionById(sessionId);
    if (!session || !session.client_id) return;

    const { data: client } = await supabase
      .from('clients')
      .select('id, agency_id, business_name, owner_phone, notification_phone, post_call_sms_enabled, vapi_phone_number, industry, hipaa_mode')
      .eq('id', session.client_id).single();
    if (!client) return;

    if (client.hipaa_mode === true) {
      console.log(`telnyx-voice: HIPAA client - skipping recap (session ${sessionId})`);
      return;
    }

    let agency = null;
    if (client.agency_id) {
      const { data } = await supabase.from('agencies').select('id, name, demo_phone_number').eq('id', client.agency_id).single();
      agency = data || null;
    }

    // Fetch the recording bytes ONCE (the Telnyx URL expires in ~10 min), then
    // reuse them for permanent storage and transcription.
    const buf = await fetchRecordingBuffer(recordingUrl);

    // Store the recording somewhere durable so the dashboard player keeps
    // working after the Telnyx URL expires. Null if Spaces is off / the upload
    // failed, in which case we leave recording_url alone (never store a URL that
    // will 404 in the player).
    const storedRecordingUrl = await persistTransferRecording(client.id, sessionId, buf);

    // Transcribe the human conversation, then summarize it for the owner recap.
    // If the recording STT is unavailable, fall back to the real-time transcript
    // we accumulated during a browser barge so the recap still has something.
    const humanTranscript = (await telnyxTranscribe(buf)) || (session.agent_transcript || '').trim() || null;
    const recap = humanTranscript ? await summarizeTransferCall(humanTranscript, client.business_name, session.whisper_summary) : null;
    console.log(`telnyx-voice: transfer recap (session ${sessionId}): stored=${storedRecordingUrl ? 'spaces' : 'no'} transcriptLen=${humanTranscript ? humanTranscript.length : 0} recap=${recap ? 'yes' : 'no'}`);

    // Find the dashboard call row this transfer belongs to. Prefer an EXACT
    // match on the VAPI call id stamped into calls.conversation_id at
    // end-of-call; fall back to the most-recent transferred call in a 30-min
    // window for older rows / any edge case.
    let callRow = null;
    const callSelect = 'id, ai_summary, call_metadata, customer_name, customer_phone, urgency_level, transcript, recording_url';
    if (session.vapi_call_id) {
      try {
        const { data: exact } = await supabase
          .from('calls')
          .select(callSelect)
          .eq('client_id', client.id)
          .eq('conversation_id', session.vapi_call_id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (exact) { callRow = exact; console.log(`telnyx-voice: matched calls row ${exact.id} by conversation_id`); }
      } catch (e) { console.error(`telnyx-voice: exact calls-row lookup failed: ${e.message}`); }
    }
    if (!callRow) {
      try {
        const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
        const { data: rows } = await supabase
          .from('calls')
          .select(callSelect)
          .eq('client_id', client.id)
          .eq('call_status', 'transferred')
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(2);
        if (rows && rows.length === 1) callRow = rows[0];
        else console.log(`telnyx-voice: fallback calls-row match: ${rows ? rows.length : 0} candidates`);
      } catch (e) { console.error(`telnyx-voice: calls-row lookup failed: ${e.message}`); }
    }

    // Owner SMS: the SAME template a normal post-call notification uses, with the
    // recap as the Summary, so a transferred call's text looks identical to a
    // regular one. Only send when there is a recap (no summary, no text, no link).
    if (client.owner_phone && recap) {
      try {
        await sendCallNotificationSMS(client, agency, {
          customerName: (callRow && callRow.customer_name) || 'Caller',
          customerPhone: formatPhoneUS(session.caller_number) || (callRow && callRow.customer_phone) || '',
          urgency: (callRow && callRow.urgency_level) || 'routine',
          summary: recap,
        });
        console.log(`telnyx-voice: transfer recap SMS sent to owner (standard template)`);
      } catch (e) { console.error(`telnyx-voice: recap SMS failed: ${e.message}`); }
    } else {
      console.log(`telnyx-voice: no recap summary (session ${sessionId}), skipping recap SMS`);
    }

    // Save the recording + transcript into the dashboard call row so BOTH the
    // client and agency call-detail pages play the recording and show the full
    // transcript (both read calls.recording_url and calls.transcript directly,
    // and a Spaces URL passes through the VAPI resolver untouched). Best-effort
    // and non-destructive: only overwrite recording_url with a DURABLE Spaces
    // URL, append the human conversation to the AI intake transcript, and keep
    // the prior VAPI recording in call_metadata.
    if (callRow) {
      try {
        const meta = Object.assign({}, callRow.call_metadata || {}, {
          transfer_recording_url: storedRecordingUrl || recordingUrl,
        });
        if (humanTranscript) meta.transfer_transcript = humanTranscript;
        // Persist who listened / jumped in / handed back, for the post-call review.
        const supEvents = getSupervisorEvents(sessionId);
        if (supEvents.length) meta.supervisor_events = supEvents;
        const update = { call_metadata: meta };
        if (storedRecordingUrl) {
          if (callRow.recording_url && callRow.recording_url !== storedRecordingUrl) {
            meta.ai_recording_url = callRow.recording_url; // preserve the pre-transfer AI recording
          }
          update.recording_url = storedRecordingUrl;
        }
        if (humanTranscript) update.transcript = buildCombinedTranscript(callRow.transcript, humanTranscript);
        if (recap) update.ai_summary = (callRow.ai_summary ? callRow.ai_summary + '\n\n' : '') + `After transfer: ${recap}`;
        await supabase.from('calls').update(update).eq('id', callRow.id);
        console.log(`telnyx-voice: saved transfer recording${update.recording_url ? '' : ' (metadata only)'} + transcript into call ${callRow.id}`);
      } catch (e) { console.error(`telnyx-voice: calls update failed: ${e.message}`); }
    } else {
      console.log(`telnyx-voice: no calls row matched (session ${sessionId}); recording stored at ${storedRecordingUrl || 'n/a'} but not linked`);
    }

    await updateSession(sessionId, { status: 'transfer_recapped' });
  } catch (e) {
    console.error(`telnyx-voice: handleRecordingSaved failed: ${e.message}`);
  }
}

// ============================================================================
// MAIN WEBHOOK: Telnyx Call Control events.
// ============================================================================
router.post('/webhook/telnyx-voice', async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}), 'utf-8');

  const signature = req.headers['telnyx-signature-ed25519'];
  const timestamp = req.headers['telnyx-timestamp'];
  if (!verifyTelnyxSignature(rawBody, signature, timestamp)) {
    return res.status(401).json({ error: 'invalid signature' });
  }

  // Acknowledge immediately. Telnyx retries on non-2xx, and our work is async.
  res.status(200).json({ received: true });

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf-8'));
  } catch (err) {
    console.error('telnyx-voice: bad JSON body:', err.message);
    return;
  }

  const data = event.data || {};
  const eventType = data.event_type;
  const payload = data.payload || {};
  const state = decodeClientState(payload.client_state);
  const role = state?.role || null;
  const sessionId = state?.sessionId || null;

  try {
    switch (eventType) {
      case 'call.initiated':
        // Only inbound caller legs are unlabeled. Our own outbound legs (VAPI,
        // office) carry a role in client_state and are ignored here.
        if (payload.direction === 'incoming' && !role) {
          await handleInbound(payload);
        }
        break;

      case 'call.answered':
        if (role === 'vapi' && sessionId) {
          await handleVapiAnswered(sessionId);
        }
        // Open the accept gate the instant the office answers (no AMD wait).
        // startGate is a no-op unless the session is still 'transferring'.
        if (role === 'office' && sessionId) {
          await startGate(sessionId, state && state.recipientName);
        }
        // The agent's browser (WebRTC) answered a barge dial: swap the AI out.
        if (role === 'agent' && sessionId) {
          console.log(`telnyx-voice: 🎧 barge call.answered agent leg (session ${sessionId}) - browser is on the line`);
          await completeBarge(sessionId);
        }
        // The supervisor's browser answered: seat it in the conference as a muted
        // monitor (conference live-monitor seat, the phase-2 path).
        if (role === 'supervisor' && sessionId) {
          console.log(`telnyx-voice: 🎧 supervisor call.answered seat leg (session ${sessionId}) - browser is on the line`);
          await completeSupervisorSeat(sessionId);
        }
        break;

      case 'call.gather.ended':
        if (role === 'office' && sessionId) {
          const digits = (payload.digits || '').toString();
          if (digits.includes('1')) {
            await completeAccept(sessionId, state && state.recipientName);
          } else {
            await returnToAI(sessionId, 'no_keypress');
          }
        }
        break;

      case 'call.ai_gather.ended':
        if (role === 'office' && sessionId) {
          // Telnyx does not publicly document this payload, so log it once and
          // parse the accept decision defensively. Anything not a clear yes
          // returns the caller to the AI (safe default).
          try { console.log(`telnyx-voice: ai_gather.ended payload: ${JSON.stringify(payload).slice(0, 600)}`); } catch (e) {}
          if (parseAiAccept(payload) === true) {
            await completeAccept(sessionId, state && state.recipientName);
          } else {
            await returnToAI(sessionId, 'declined_or_no_response');
          }
        }
        break;

      case 'call.speak.ended':
        // The agent's accept confirmation ("connecting you now") just finished.
        // Now bridge the caller to them. Only the confirm speak carries
        // phase:'confirm', so other speaks (hold message, spoken ringback) are
        // ignored here.
        if (role === 'office' && sessionId && state && state.phase === 'confirm') {
          await finalizeBridge(sessionId, state.recipientName);
        }
        break;

      case 'call.recording.saved':
        if (sessionId) {
          const urls = payload.recording_urls || payload.public_recording_urls || {};
          const url = urls.mp3 || urls.wav
            || (Array.isArray(payload.recording_urls) ? payload.recording_urls[0] : null);
          await handleRecordingSaved(sessionId, url);
        }
        break;

      case 'call.transcription':
        // Real-time STT fragment. Only relevant during a human barge (the AI
        // supplies its own transcript the rest of the time), so route it to the
        // live monitor + recap accumulator. Harmless if it arrives otherwise.
        if (sessionId) {
          await handleBargeTranscription(sessionId, payload);
        }
        break;

      case 'call.hangup':
        if (sessionId) {
          const s = await getSessionById(sessionId);
          const st = s && s.status;
          const bargeState = st === 'agent_dialing' || st === 'agent_bridged' || st === 'returning_to_ai';

          // Ignore a STALE VAPI-leg hangup. When a supervisor jumps in we hang up
          // the AI leg, and hand-back re-dials a fresh one. The OLD leg's late
          // hangup must never tear down the caller or the conference: only the
          // CURRENT vapi leg is the live AI. Without this, an old leg's hangup
          // arriving after a re-dial hit the conference teardown and hung up the
          // caller (the "hung up again" cascade).
          if (role === 'vapi' && s && s.telnyx_vapi_control_id && payload.call_control_id &&
              payload.call_control_id !== s.telnyx_vapi_control_id) {
            console.log(`telnyx-voice: 🎧 ignoring stale vapi-leg hangup ${payload.call_control_id} (current=${s.telnyx_vapi_control_id}, session ${sessionId})`);
            break;
          }

          // The human agent's browser leg dropped (clicked leave/end, closed the
          // tab, or lost connection). Decide the caller's fate (back to AI / end).
          // The hangup cause is the key signal when a browser dial never rings:
          // a routing miss (e.g. the SIP username not reachable) shows here as a
          // cause like "unallocated_number" BEFORE any call.answered arrives.
          if (role === 'agent') {
            console.log(`telnyx-voice: 🎧 barge call.hangup agent leg (session ${sessionId}) status=${st} cause=${payload.hangup_cause || '?'} sip_cause=${payload.sip_hangup_cause || '?'}`);
            await handleAgentLeave(sessionId, 'agent_hangup');
            break;
          }

          // The supervisor's conference seat dropped (left, closed the tab, or
          // lost connection). If they were talking, hand the caller back to the
          // AI; otherwise just clear the seat. The call continues either way.
          if (role === 'supervisor') {
            console.log(`telnyx-voice: 🎧 supervisor call.hangup seat leg (session ${sessionId}) status=${st} cause=${payload.hangup_cause || '?'}`);
            await supervisorLeaveSeat(sessionId);
            break;
          }

          // A VAPI-leg hangup DURING a barge is expected (we swap the AI out, and
          // the old AI leg drops again on a return-to-AI), so it must not end the
          // monitor or the session. Ignore it.
          if (role === 'vapi' && bargeState) {
            break;
          }

          // Diagnostic: a caller/AI-leg hangup during a conference is where a
          // dropped-caller bug ("couldn't find number") surfaces. Log the cause
          // and the branch about to run so the next jump-in test is conclusive.
          if (s && (role === 'caller' || role === 'vapi')) {
            console.log(`telnyx-voice: 🎧 hangup role=${role} status=${st} conf_active=${!!s.conference_active} barged=${!!s.barged} cause=${payload.hangup_cause || '?'} sip_cause=${payload.sip_hangup_cause || '?'} (session ${sessionId})`);
          }

          // Live monitor: a caller (or AI-leg) hangup is the TRUE end of the
          // call. On a connected transfer/barge it fires after the human
          // conversation wraps, so close the monitor here even though we
          // deliberately leave the DB status for vapi-webhook to read.
          if (s && (role === 'caller' || role === 'vapi')) {
            try { broadcastLiveEvent(s.client_id, { type: 'status', status: 'ended' }); } catch (e) {}
          }
          // Leave 'bridged' alone so vapi-webhook can detect the connected
          // transfer, and leave terminal states alone.
          if (st && st !== 'bridged' && st !== 'ended' && st !== 'transfer_recapped') {
            if (role === 'office') {
              // Office dropped before we connected -> return caller to the AI.
              await returnToAI(sessionId, 'office_hangup');
            } else if (role === 'caller' || role === 'vapi') {
              // Caller (or AI leg) ended. Tear down any outstanding office leg
              // AND any pending/active agent (barge) leg so nothing is left
              // ringing or connected to a dead call.
              if ((st === 'transferring' || st === 'ringing_gate' || st === 'confirming') && s.telnyx_office_control_id) {
                await hangupCall(s.telnyx_office_control_id);
              }
              if ((st === 'agent_dialing' || st === 'agent_bridged' || st === 'ending_after_barge') && s.telnyx_agent_control_id) {
                await hangupCall(s.telnyx_agent_control_id);
                await cleanupBargeCredential(s);
              }
              // Conference call: nothing auto-ends when one leg leaves, so tear
              // down the other legs (supervisor seat + the AI, or the caller) so
              // nothing lingers in the conference.
              if (s.conference_active) {
                if (s.telnyx_agent_control_id) { await hangupCall(s.telnyx_agent_control_id); await cleanupBargeCredential(s); }
                if (role === 'caller' && s.telnyx_vapi_control_id) await hangupCall(s.telnyx_vapi_control_id);
                if (role === 'vapi' && s.telnyx_caller_control_id) await hangupCall(s.telnyx_caller_control_id);
              }
              await updateSession(sessionId, { status: 'ended' });
            }
          }
        }
        break;

      default:
        // status-update and other events are not needed for the transfer flow.
        break;
    }
  } catch (err) {
    console.error(`telnyx-voice: error handling ${eventType}:`, err.message);
  }
});

// ============================================================================
// VAPI TRANSFER REQUEST: the AI's request_human_transfer function tool calls
// this. We take the caller off the AI, ring the office, and poll the session
// status until the transfer is connected (press 1) or returns the caller to the
// AI (no answer / voicemail / no keypress / timeout).
//
// Returns the VAPI tool-result shape: { results: [{ toolCallId, result }] }.
// ============================================================================
router.post('/api/voice/request-transfer', async (req, res) => {
  const body = req.body || {};
  const msg = body.message || body;
  const vapiCallId = msg.call?.id || body.call?.id || null;

  const toolCalls = msg.toolCallList || msg.toolCalls
    || (Array.isArray(msg.toolWithToolCallList)
        ? msg.toolWithToolCallList.map(t => t.toolCall).filter(Boolean)
        : []);
  const tc = (toolCalls || []).find(t => (t.function?.name || t.name) === 'request_human_transfer')
    || (toolCalls || [])[0]
    || {};
  const toolCallId = tc.id || tc.toolCallId || 'transfer';

  let args = tc.function?.arguments ?? tc.arguments ?? {};
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { args = { summary: args }; }
  }
  const summary = (args.summary || '').toString().trim() || 'A caller would like to speak with you.';
  const transferToLabel = (args.transfer_to || '').toString().trim() || null;

  // Decode the label->number destination map the config builder stamped on the
  // tool URL (?t=base64), so we dial the person the AI chose (transfer_to), not
  // just the main line.
  let transferTargets = [];
  try {
    const t = req.query && req.query.t;
    if (t) transferTargets = JSON.parse(Buffer.from(String(t), 'base64').toString('utf-8')) || [];
  } catch (e) { transferTargets = []; }

  const reply = (text) => res.status(200).json({ results: [{ toolCallId, result: text }] });

  try {
    const session = await getSessionByVapiCallId(vapiCallId);
    if (!session) {
      console.error(`telnyx-voice: request-transfer with no session for vapi call ${vapiCallId} (is vapi-webhook.js storing vapi_call_id on the session yet?)`);
      return reply('I could not reach the team line right now. Apologize and offer to book an appointment or take a detailed message with the caller name, number, and reason for calling.');
    }

    try {
      broadcastLiveEvent(session.client_id, {
        type: 'activity', tool: 'request_human_transfer', label: 'Connecting to the team',
        detail: summary || null,
      });
      broadcastLiveEvent(session.client_id, { type: 'status', status: 'dialing_team', label: 'Transferring to the team' });
    } catch (e) {}

    if (session.status === 'bridged' || session.status === 'transferring' || session.status === 'ringing_gate') {
      return reply('A transfer is already in progress. Please hold.');
    }

    const { data: client } = await supabase
      .from('clients')
      .select('vapi_phone_number, owner_phone, transfer_phone, tool_config, agency_id, owner_name, business_name')
      .eq('id', session.client_id)
      .single();

    // Pick the number to dial: the staff member the AI chose (transfer_to),
    // matched against the stamped label->number map, else the main business line.
    let chosenNumber = null;
    if (transferToLabel && transferTargets.length) {
      const hit = transferTargets.find(x => x && x.label === transferToLabel);
      if (hit && hit.number) chosenNumber = hit.number;
    }
    let officeNumber = toE164(chosenNumber || session.office_number || client?.transfer_phone || client?.owner_phone);
    const businessDid = toE164(client?.vapi_phone_number) || officeNumber;
    if (transferToLabel) console.log(`telnyx-voice: transfer_to="${transferToLabel}" -> ${officeNumber}${chosenNumber ? '' : ' (no match, used main line)'}`);

    // First name of whoever we are connecting, so the whisper can greet them by
    // name. A chosen staff label looks like "Jonathan, Stylist"; the main line
    // falls back to the owner's first name.
    const firstName = (s) => (s ? String(s).split(',')[0].trim().split(/\s+/)[0] : '') || '';
    let recipientName = chosenNumber ? firstName(transferToLabel) : firstName(client?.owner_name);

    if (!officeNumber) {
      return reply('There is no team phone number on file to transfer to. Apologize and offer to book an appointment or take a detailed message instead.');
    }

    // Guard against a forwarding loop: never dial the same line the caller's
    // call may have forwarded from.
    if (businessDid && officeNumber === businessDid) {
      console.warn(`telnyx-voice: transfer number equals business DID (session ${session.id}) - refusing to avoid a loop`);
      return reply('I am not able to connect that call right now. Apologize and offer to book an appointment or take a detailed message instead.');
    }

    // Single budget shared by the escalation wait AND the dial poll below, so
    // the whole handler stays within the VAPI tool timeout no matter the path.
    const transferDeadline = Date.now() + TRANSFER_WAIT_MS;

    // ---- Call-center escalation routing (opt-in; call-center agencies only) ----
    // Before dialing the business's own line, offer the caller to the assigned,
    // available agents - a screen-pop in their /cc console. A browser agent takes
    // over through the existing jump-in (we keep the call 'active' and watch for
    // them to bridge); a phone agent is dialed at their own number through the
    // normal gate below. Fully gated: a non-call-center agency, or one with no
    // agent online, skips this entire block and dials exactly as before. The
    // whole block is best-effort - any error falls through to the business line.
    try {
      const escAgencyId = client?.agency_id || session.agency_id;
      let isCallCenter = false;
      if (escAgencyId) {
        const { data: agency } = await supabase.from('agencies').select('is_call_center').eq('id', escAgencyId).maybeSingle();
        isCallCenter = !!(agency && agency.is_call_center);
      }
      if (isCallCenter) {
        const avail = await agentPresence.listAvailableForClient({ agencyId: escAgencyId, clientId: session.client_id });
        if (avail.length) {
          const offeredTo = avail.map((a) => a.memberUserId);
          const offer = await escalationOffers.createOffer({
            agencyId: escAgencyId, clientId: session.client_id, sessionId: session.id,
            vapiCallId, callerNumber: session.caller_number || null,
            businessName: client?.business_name || null,
            reason: 'A caller asked to speak with a person', summary,
            collected: null, offeredTo,
          });
          if (offer) {
            const popPayload = {
              id: offer.id, clientId: session.client_id, vapiCallId,
              businessName: client?.business_name || null,
              callerNumber: session.caller_number || null,
              reason: offer.reason, summary,
              createdAt: offer.created_at, expiresAt: offer.expires_at,
            };
            broadcastToAgents(offeredTo, { type: 'offer', offer: popPayload });
            try {
              broadcastLiveEvent(session.client_id, { type: 'activity', tool: 'agent_offer', label: `Offered to ${offeredTo.length} agent${offeredTo.length === 1 ? '' : 's'}` });
            } catch (e) {}

            // Only 'agent_bridged' means a human actually took the caller. NOT
            // 'conferencing': ensureConference flips to it transiently while a
            // browser agent is merely LISTENING (then back to 'active'), so
            // treating it as connected would hand off on a listen.
            const BRIDGED = ['agent_bridged'];
            let waitUntil = Date.now() + ESCALATION_OFFER_WAIT_MS;
            let phoneRouted = false;    // a phone agent took it -> dial their number below
            let browserClaimed = false; // a browser agent committed -> hold for their jump-in

            while (Date.now() < Math.min(waitUntil, transferDeadline - 1500)) {
              await new Promise((r) => setTimeout(r, 700));
              const s = await getSessionById(session.id);
              // A transient read miss (null) is not a hangup - a real hangup
              // comes back as status 'ended' below. Just retry on null.
              if (!s) { continue; }
              if (s.status === 'ended') { await escalationOffers.resolveOffer(offer.id, 'cancelled'); return reply('The caller has hung up. The call is over.'); }
              if (BRIDGED.includes(s.status)) {
                await escalationOffers.resolveOffer(offer.id, 'connected');
                return reply('Connecting you now. Do not say anything further; the team member is taking over the call.');
              }
              const o = await escalationOffers.getOffer(offer.id);
              if (o && o.status === 'claimed') {
                if (o.claimed_delivery === 'phone') {
                  let ph = null;
                  try {
                    const { data: tm } = await supabase.from('team_members')
                      .select('agent_phone, display_name')
                      .eq('entity_type', 'agency').eq('entity_id', escAgencyId)
                      .eq('member_user_id', o.claimed_by).maybeSingle();
                    ph = tm?.agent_phone || null;
                    if (tm?.display_name) recipientName = firstName(tm.display_name);
                  } catch (e) {}
                  const phE164 = toE164(ph);
                  if (phE164 && !(businessDid && phE164 === businessDid)) {
                    officeNumber = phE164;         // dial the agent, not the office
                    phoneRouted = true;
                    break;                          // fall through to the gate/dial below
                  }
                  // Unusable number: release the claim back to the pool and keep waiting.
                  await escalationOffers.resolveOffer(offer.id, 'open');
                } else if (!browserClaimed) {
                  // Browser agent committed: give them the rest of the budget to
                  // finish listen + jump-in (which flips status into BRIDGED above).
                  browserClaimed = true;
                  waitUntil = transferDeadline - 1500;
                  try { broadcastLiveEvent(session.client_id, { type: 'activity', tool: 'agent_taking', label: `${o.claimed_name || 'A teammate'} is taking the call` }); } catch (e) {}
                }
              }
            }

            if (!phoneRouted) {
              if (browserClaimed) {
                // An agent grabbed it but never connected - take a message rather
                // than silently ringing the business owner.
                await escalationOffers.resolveOffer(offer.id, 'expired').catch(() => {});
                await returnToAI(session.id, 'agent_no_show');
                return reply('I could not get a team member onto the line in time, so you are back with the caller. Apologize and offer to take a detailed message with their name, number, and reason for calling.');
              }
              // No agent responded: fall through to the business line, unchanged.
              await escalationOffers.resolveOffer(offer.id, 'no_agents').catch(() => {});
            }
          }
        }
      }
    } catch (e) {
      console.warn('telnyx-voice: call-center escalation routing skipped:', e.message);
    }
    // ---- end call-center escalation routing ----

    await updateSession(session.id, { status: 'transferring', whisper_summary: summary });

    // Let the AI finish its short "connecting you" line before we take the
    // caller off it, so the caller is not cut off mid sentence. The AI is still
    // bridged to the caller during this pause.
    if (TRANSFER_PREROLL_MS > 0) await new Promise((r) => setTimeout(r, TRANSFER_PREROLL_MS));

    // The caller stays bridged to the AI while the office rings (Telnyx has no
    // unbridge). We play ringback over that leg, and keep the AI leg alive so it
    // is still there if the office does not answer. On accept we hang up the AI
    // leg, which parks the caller (park_after_unbridge:'self' set at bridge time)
    // so it survives to be bridged to the office.
    const caller = session.telnyx_caller_control_id;
    const vapi = session.telnyx_vapi_control_id;

    // Resolve the white-label ringback/hold audio (client override -> agency
    // default -> platform default -> spoken fallback) and play it to the caller.
    let agencyMarketingConfig = null;
    try {
      const agyId = client?.agency_id || session.agency_id;
      if (agyId) {
        const { data: agency } = await supabase.from('agencies').select('marketing_config').eq('id', agyId).single();
        agencyMarketingConfig = agency?.marketing_config || null;
      }
    } catch (e) { /* non-fatal; fall back to the platform default */ }
    const holdAudioUrl = resolveHoldAudioUrl(client?.tool_config, agencyMarketingConfig);
    if (caller) await startRingback(caller, holdAudioUrl);

    const { connectionId } = await getWhisperConfig();
    const officeLeg = await dialCall({
      to: officeNumber,
      from: businessDid,
      connectionId,
      // No answering-machine detection: it adds several seconds of latency
      // before the gate opens. The press-1 gate is the real backstop (a
      // voicemail never presses 1), so we gate the instant the office answers.
      timeoutSecs: OFFICE_RING_SECONDS,
      clientState: { role: 'office', sessionId: session.id, recipientName },
    });

    if (!officeLeg || !officeLeg.call_control_id) {
      // Could not even dial: put the caller straight back with the AI.
      await returnToAI(session.id, 'dial_failed');
      return reply('I could not reach the team right now. Apologize and offer to book an appointment or take a detailed message with the caller name, number, and reason for calling.');
    }

    await updateSession(session.id, { telnyx_office_control_id: officeLeg.call_control_id });

    // Poll the session status (the shared store) until a Telnyx-driven handler
    // settles the transfer, or we time out. Polling the DB (rather than holding
    // an in-memory promise) means this resolves whether the Telnyx events land
    // on this instance or another one. Uses the shared transfer deadline so any
    // time already spent offering the call to agents is counted against the same
    // budget (the whole handler stays within the VAPI tool timeout).
    const deadline = transferDeadline;
    let outcome = 'pending';
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      const s = await getSessionById(session.id);
      if (!s) { outcome = 'take_message'; break; }
      if (s.status === 'bridged' || s.status === 'transfer_recapped') { outcome = 'connected'; break; }
      if (s.status === 'transfer_returned') { outcome = 'take_message'; break; }
      if (s.status === 'ended') { outcome = 'ended'; break; }
      // 'transferring' / 'ringing_gate' -> still trying
    }

    if (outcome === 'pending') {
      // Deadline hit. If the agent already accepted (we are confirming out loud
      // or just bridged), the connection is in flight (finalizeBridge runs on
      // the confirmation's speak-end or its backstop timer), so treat it as
      // connected instead of yanking the caller back to the AI. Only a call
      // still ringing or gating falls back to take-a-message.
      const s = await getSessionById(session.id);
      if (s && (s.status === 'confirming' || s.status === 'bridged' || s.status === 'transfer_recapped')) {
        outcome = 'connected';
      } else {
        await returnToAI(session.id, 'timeout');
        outcome = 'take_message';
      }
    }

    if (outcome === 'connected') {
      return reply('Connecting you now. Do not say anything further; the team member is taking over the call.');
    }
    if (outcome === 'ended') {
      return reply('The caller has hung up. The call is over.');
    }
    return reply('No one on the team was available, so you are back with the caller. Apologize that you could not reach them, then offer to book an appointment or take a detailed message with their name, number, and reason for calling.');
  } catch (err) {
    console.error('telnyx-voice: request-transfer error:', err.message);
    return reply('I ran into a problem connecting that call. Apologize and offer to book an appointment or take a detailed message instead.');
  }
});


// Compose a saved-link/info SMS. A business can save either a full message
// ("Hi! Here's our booking link: https://...  See you soon!") or just a bare
// value (a lone link, an address, a short token). A full message is sent
// verbatim, exactly as written. A BARE value is wrapped in a short, friendly
// message so the caller gets "Thanks for calling Bella's Salon! Here's the
// coloring website you asked about: <link> ..." instead of a naked URL.
//   biz        - business name (no wrapper if we don't have it)
//   key        - the preset/snippet key (for a tailored lead line)
//   descriptor - human label for the generic lead ("coloring website")
//   value      - the saved value to send
function composeSavedSms(biz, key, descriptor, value) {
  const val = (value || '').toString().trim();
  if (!val || !biz) return val;
  // Bare = a lone token (a URL of any length, no spaces) OR a short value with
  // no sentence punctuation or line breaks. Anything else is already prose and
  // is sent word-for-word.
  const bare = !/\s/.test(val) || (val.length <= 120 && !/[.!?]\s/.test(val) && !/\n/.test(val));
  if (!bare) return val;
  const k = (key || '').toString().toLowerCase();
  const lead = ({
    website: `Thanks for calling ${biz}! Here's our website:`,
    address: `Thanks for calling ${biz}! Here's where to find us:`,
    booking: `Thanks for calling ${biz}! Here's the link to book:`,
    booking_link: `Thanks for calling ${biz}! Here's the link to book:`,
    payment: `Here's your secure payment link from ${biz}:`,
    payment_link: `Here's your secure payment link from ${biz}:`,
    review: `It was great talking with you! If you have a moment, we'd really appreciate a quick review for ${biz}:`,
    review_link: `It was great talking with you! If you have a moment, we'd really appreciate a quick review for ${biz}:`,
  })[k] || `Thanks for calling ${biz}! Here's the ${(descriptor || 'link').toString().trim()} you asked about:`;
  const closer = (k === 'review' || k === 'review_link') ? 'Thank you!' : "Let us know if there's anything else we can help with!";
  return `${lead}\n${val}\n\n${closer}`;
}

// ============================================================================
// AI SENDS SMS TO CALLER
// The assistant's send_sms function tool calls this to text the person on the
// call (booking link, confirmation, address, reminder). The destination is the
// caller's own number, pulled from the session server-side, never from the
// model, so the AI can only ever text the person who actually called in.
// ============================================================================
router.post('/api/voice/send-sms', async (req, res) => {
  const body = req.body || {};
  const msg = body.message || body;
  const vapiCallId = msg.call?.id || body.call?.id || null;

  const toolCalls = msg.toolCallList || msg.toolCalls
    || (Array.isArray(msg.toolWithToolCallList)
        ? msg.toolWithToolCallList.map(t => t.toolCall).filter(Boolean)
        : []);
  const tc = (toolCalls || []).find(t => (t.function?.name || t.name) === 'send_sms')
    || (toolCalls || [])[0]
    || {};
  const toolCallId = tc.id || tc.toolCallId || 'send_sms';

  let args = tc.function?.arguments ?? tc.arguments ?? {};
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { args = { message: args }; }
  }
  const savedKey = (args.saved_text || '').toString().trim();
  let text = (args.message || '').toString().trim();

  const reply = (result) => res.status(200).json({ results: [{ toolCallId, result }] });

  if (!text && !savedKey) {
    return reply('No message was provided, so nothing was sent. Ask the caller what they would like texted.');
  }

  try {
    const session = await getSessionByVapiCallId(vapiCallId);

    let callerNumber = (session && session.caller_number) || msg.call?.customer?.number || null;
    let clientId = (session && session.client_id) || null;

    if (!clientId) {
      let vapiNumber = msg.call?.phoneNumber?.number || msg.phoneNumber?.number || null;
      const phoneNumberId = msg.call?.phoneNumberId || msg.phoneNumber?.id || null;
      if (!vapiNumber && phoneNumberId) {
        try { vapiNumber = await getPhoneNumberFromVapi(phoneNumberId); } catch (_) { /* non-fatal */ }
      }
      if (vapiNumber) {
        const c = await getClientByVapiPhoneNumber(vapiNumber);
        if (c) clientId = c.id;
      }
    }

    if (!callerNumber) {
      return reply('I could not send that text right now. Apologize and offer to read the information out loud instead.');
    }

    const { data: client } = clientId
      ? await supabase.from('clients').select('agency_id, tool_config, vapi_phone_number, business_name').eq('id', clientId).single()
      : { data: null };

    try {
      // Name which link/info was texted, so the monitor shows "Texted the caller
      // the booking link" instead of a generic "Texting the caller".
      const SMS_LABELS = {
        website: 'Texted the caller the website link',
        address: 'Texted the caller the address',
        booking: 'Texted the caller the booking link',
        booking_link: 'Texted the caller the booking link',
        review: 'Texted the caller the review link',
        review_link: 'Texted the caller the review link',
        payment: 'Texted the caller the payment link',
        payment_link: 'Texted the caller the payment link',
      };
      const smsLabel = (savedKey && SMS_LABELS[savedKey])
        || (savedKey ? `Texted the caller the ${savedKey.replace(/_/g, ' ')}` : 'Texted the caller');
      broadcastLiveEvent(clientId, {
        type: 'activity', tool: 'send_sms', label: smsLabel,
        detail: savedKey ? null : (text ? 'custom message' : null),
      });
    } catch (e) {}

    if (savedKey) {
      const biz = client && client.business_name;
      const preset = client && client.tool_config && client.tool_config.smsPresets && client.tool_config.smsPresets[savedKey];
      if (preset && preset.enabled && (preset.value || '').toString().trim()) {
        // Built-in preset (website / address / booking / payment / review): a
        // bare link gets the friendly wrapper; a full message is sent verbatim.
        text = composeSavedSms(biz, savedKey, savedKey.replace(/_/g, ' '), preset.value.toString().trim());
      } else {
        // Custom saved text ("+ Add a custom text"): the AI passes its name as
        // the key. Match it (case-insensitive). A business that wrote a full
        // message gets it word-for-word; one that saved just a link gets the
        // same friendly wrapper, keyed off the snippet's own label (e.g.
        // "coloring website"), so the caller never receives a naked URL.
        const snippets = (client && client.tool_config && Array.isArray(client.tool_config.smsSnippets)) ? client.tool_config.smsSnippets : [];
        const snip = snippets.find(s => s && (s.label || '').toString().trim().toLowerCase() === savedKey.toLowerCase() && (s.value || '').toString().trim());
        if (snip) {
          text = composeSavedSms(biz, savedKey, (snip.label || '').toString().trim() || 'link', snip.value.toString().trim());
        } else if (!text) {
          return reply('That saved text is not set up, so nothing was sent. Read the information out loud instead.');
        }
      }
    }

    try {
      const { count } = await supabase
        .from('sms_log')
        .select('id', { count: 'exact', head: true })
        .eq('message_type', 'ai_call_sms')
        .filter('metadata->>vapi_call_id', 'eq', vapiCallId);
      if ((count || 0) >= 5) {
        return reply('You have already texted the caller several times on this call. Read the information out loud instead.');
      }
    } catch (capErr) {
      console.warn('telnyx-voice: send-sms cap check failed', capErr.message);
    }

    const sent = await sendAndLogSMS({
      phone: callerNumber,
      message: text,
      from: (client && client.vapi_phone_number) || null,
      agencyId: (client && client.agency_id) || null,
      recipientType: 'caller',
      messageType: 'ai_call_sms',
      metadata: { source: 'ai_receptionist', vapi_call_id: vapiCallId, client_id: clientId || null, saved_text: savedKey || null },
    });

    if (sent) {
      return reply('The text has been sent to the caller. Tell them you have just texted it.');
    }
    return reply('The text did not go through. Apologize and offer to read the information out loud instead.');
  } catch (err) {
    console.error('telnyx-voice: send-sms error', err.message);
    return reply('I could not send the text right now. Apologize and offer to read it out loud instead.');
  }
});

// ============================================================================
// DEFAULT RINGBACK TONE
// Serves the platform ringback so TELNYX_RINGBACK_URL can point at our own
// backend (no third-party host to rot). Commit the file at src/audio/ringback.mp3.
//   TELNYX_RINGBACK_URL = https://<your-backend>/audio/ringback.mp3
// This router is mounted at '/', so the public path is /audio/ringback.mp3.
// ============================================================================
router.get('/audio/ringback.mp3', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'audio', 'ringback.mp3'), (err) => {
    if (err) {
      console.error('telnyx-voice: ringback file missing:', err.message);
      if (!res.headersSent) res.status(404).end();
    }
  });
});

// Expose the barge controls (and a couple of session helpers) on the router so
// the live-monitor jump-in/out endpoints can drive a browser human-barge while
// all of the call/session logic stays in this one file. server.js still mounts
// the router itself (app.use('/', require('./routes/telnyx-voice'))); attaching
// these as properties does not change that.
router.barge = {
  startBarge,
  requestAgentLeave,
  // Conference live-monitor seat (phase 2): listen + jump-in.
  startSupervisorListen,
  supervisorJumpIn,
  supervisorJumpOut,
  supervisorLeaveSeat,
  getSessionById,
  getSessionByVapiCallId,
  updateSession,
  getSupervisorEvents,
};

module.exports = router;
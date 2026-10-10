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

  await callAction(caller, 'bridge', {
    call_control_id: vapi,
    park_after_unbridge: 'self',
  });
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
async function completeAccept(sessionId) {
  const won = await atomicTransition(sessionId, ['ringing_gate'], 'bridged');
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
  const won = await atomicTransition(sessionId, ['transferring', 'ringing_gate'], 'transfer_returned');
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
  console.log(`telnyx-voice: office not reached (${reason || 'no_answer'}) - caller stays with AI (session ${sessionId})`);
}

// ===========================================================================
// TRANSFER-CALL RECAP: the caller<->agent conversation happens on Telnyx after
// the AI is gone, so we record it, transcribe it with Telnyx Speech-to-Text,
// summarize it with Claude, and text the owner what actually happened plus the
// recording. All best-effort: if transcription fails, the owner still gets the
// recording link. (Mirrors the proven REFER-path recap.)
// ===========================================================================

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
      .select('id, agency_id, business_name, owner_phone, vapi_phone_number, industry, hipaa_mode')
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
    const humanTranscript = await telnyxTranscribe(buf);
    const recap = humanTranscript ? await summarizeTransferCall(humanTranscript, client.business_name, session.whisper_summary) : null;
    console.log(`telnyx-voice: transfer recap (session ${sessionId}): stored=${storedRecordingUrl ? 'spaces' : 'no'} transcriptLen=${humanTranscript ? humanTranscript.length : 0} recap=${recap ? 'yes' : 'no'}`);

    // Find the dashboard call row this transfer belongs to. Prefer an EXACT
    // match on the VAPI call id stamped into calls.conversation_id at
    // end-of-call; fall back to the most-recent transferred call in a 30-min
    // window for older rows / any edge case.
    let callRow = null;
    const callSelect = 'id, ai_summary, call_metadata, customer_name, urgency_level, transcript, recording_url';
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
          customerPhone: session.caller_number || '',
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
        break;

      case 'call.gather.ended':
        if (role === 'office' && sessionId) {
          const digits = (payload.digits || '').toString();
          if (digits.includes('1')) {
            await completeAccept(sessionId);
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
            await completeAccept(sessionId);
          } else {
            await returnToAI(sessionId, 'declined_or_no_response');
          }
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

      case 'call.hangup':
        if (sessionId) {
          const s = await getSessionById(sessionId);
          const st = s && s.status;
          // Leave 'bridged' alone so vapi-webhook can detect the connected
          // transfer, and leave terminal states alone.
          if (st && st !== 'bridged' && st !== 'ended' && st !== 'transfer_recapped') {
            if (role === 'office') {
              // Office dropped before we connected -> return caller to the AI.
              await returnToAI(sessionId, 'office_hangup');
            } else if (role === 'caller' || role === 'vapi') {
              // Caller (or AI leg) ended. Tear down any outstanding office leg.
              if ((st === 'transferring' || st === 'ringing_gate') && s.telnyx_office_control_id) {
                await hangupCall(s.telnyx_office_control_id);
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
    const officeNumber = toE164(chosenNumber || session.office_number || client?.transfer_phone || client?.owner_phone);
    const businessDid = toE164(client?.vapi_phone_number) || officeNumber;
    if (transferToLabel) console.log(`telnyx-voice: transfer_to="${transferToLabel}" -> ${officeNumber}${chosenNumber ? '' : ' (no match, used main line)'}`);

    // First name of whoever we are connecting, so the whisper can greet them by
    // name. A chosen staff label looks like "Jonathan, Stylist"; the main line
    // falls back to the owner's first name.
    const firstName = (s) => (s ? String(s).split(',')[0].trim().split(/\s+/)[0] : '') || '';
    const recipientName = chosenNumber ? firstName(transferToLabel) : firstName(client?.owner_name);

    if (!officeNumber) {
      return reply('There is no team phone number on file to transfer to. Apologize and offer to book an appointment or take a detailed message instead.');
    }

    // Guard against a forwarding loop: never dial the same line the caller's
    // call may have forwarded from.
    if (businessDid && officeNumber === businessDid) {
      console.warn(`telnyx-voice: transfer number equals business DID (session ${session.id}) - refusing to avoid a loop`);
      return reply('I am not able to connect that call right now. Apologize and offer to book an appointment or take a detailed message instead.');
    }

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
    // on this instance or another one.
    const deadline = Date.now() + TRANSFER_WAIT_MS;
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
      // Timed out while still ringing or gating: return the caller to the AI.
      await returnToAI(session.id, 'timeout');
      outcome = 'take_message';
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
      broadcastLiveEvent(clientId, {
        type: 'activity', tool: 'send_sms', label: 'Texting the caller',
        detail: savedKey ? `saved: ${savedKey}` : (text ? 'custom message' : null),
      });
    } catch (e) {}

    if (savedKey) {
      const preset = client && client.tool_config && client.tool_config.smsPresets && client.tool_config.smsPresets[savedKey];
      if (preset && preset.enabled && (preset.value || '').toString().trim()) {
        const value = preset.value.toString().trim();
        const looksBare = value.length <= 90 && !/[.!?]\s/.test(value) && !/\n/.test(value);
        if (looksBare && client.business_name) {
          const biz = client.business_name;
          const lead = {
            website: `Thanks for calling ${biz}! Here's our website so you can take a look:`,
            address: `Thanks for calling ${biz}! Here's where to find us:`,
            payment: `Here's your secure payment link from ${biz}:`,
            review: `It was great talking with you! If you have a moment, we'd really appreciate a quick review for ${biz}:`,
          }[savedKey] || `Thanks for calling ${biz}! Here's what you asked for:`;
          const closer = savedKey === 'review' ? 'Thank you!' : 'Let us know if there\'s anything else we can help with!';
          text = `${lead}\n${value}\n\n${closer}`;
        } else {
          text = value;
        }
      } else if (!text) {
        return reply('That saved text is not set up, so nothing was sent. Read the information out loud instead.');
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

module.exports = router;
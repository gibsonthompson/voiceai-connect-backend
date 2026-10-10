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
const liveMonitor = require('../lib/live-monitor-bus');
const { broadcastLiveEvent } = require('../lib/live-broadcast');
const {
  callAction,
  answerCall,
  dialCall,
  speakToCall,
  gatherUsingSpeak,
  bridgeCalls,
  unbridgeCall,
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
const OFFICE_RING_SECONDS = 18;
// Overall press-1 gate timeout once the office answers.
const GATHER_TIMEOUT_MS = 6000;
// How long /api/voice/request-transfer polls for an outcome before returning
// the caller to the AI. Keep this a few seconds UNDER the VAPI tool timeout
// (set to 25s on the request_human_transfer tool in the config builder) so VAPI
// does not time the tool out first.
const TRANSFER_WAIT_MS = 22000;
// Pause after the AI calls the transfer tool, before we take the caller off the
// AI, so the AI's short "connecting you" line finishes instead of being cut off
// mid sentence. The caller stays bridged to the AI during this pause.
const TRANSFER_PREROLL_MS = Number(process.env.TRANSFER_PREROLL_MS || 2500);

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
async function startGate(sessionId) {
  const won = await atomicTransition(sessionId, ['transferring'], 'ringing_gate');
  if (!won) return;

  const session = await getSessionById(sessionId);
  if (!session) return;
  const office = session.telnyx_office_control_id;
  if (!office) return;

  const summary = session.whisper_summary || 'A caller would like to speak with you.';
  const callerLabel = session.caller_number ? ` The caller's number is ${session.caller_number}.` : '';
  const prompt = `You have a call from your A I receptionist. ${summary}${callerLabel} To take the call, press 1. Otherwise, just hang up and I will take a message.`;

  await gatherUsingSpeak(office, prompt, {
    validDigits: '1',
    timeoutMillis: GATHER_TIMEOUT_MS,
    clientState: { role: 'office', sessionId },
  });
  console.log(`telnyx-voice: press-1 gate opened on office (session ${sessionId})`);
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
  const vapi = session.telnyx_vapi_control_id;
  const office = session.telnyx_office_control_id;

  await stopRingback(caller);
  if (office) await hangupCall(office);
  if (caller && vapi) {
    await callAction(caller, 'bridge', { call_control_id: vapi, park_after_unbridge: 'self' });
  }
  console.log(`telnyx-voice: office not reached (${reason || 'no_answer'}) - caller returned to AI (session ${sessionId})`);
}

// ===========================================================================
// TRANSFER-CALL RECAP: the caller<->agent conversation happens on Telnyx after
// the AI is gone, so we record it, transcribe it with Telnyx Speech-to-Text,
// summarize it with Claude, and text the owner what actually happened plus the
// recording. All best-effort: if transcription fails, the owner still gets the
// recording link. (Mirrors the proven REFER-path recap.)
// ===========================================================================

// Transcribe a hosted recording with Telnyx Speech-to-Text (synchronous).
async function telnyxTranscribe(fileUrl) {
  const key = process.env.TELNYX_API_KEY;
  if (!key || !fileUrl) return null;
  try {
    const fd = new FormData();
    fd.set('model', 'openai/whisper-large-v3-turbo');
    fd.set('file_url', fileUrl);
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

    const transcript = await telnyxTranscribe(recordingUrl);
    const recap = transcript ? await summarizeTransferCall(transcript, client.business_name, session.whisper_summary) : null;
    console.log(`telnyx-voice: transfer recap (session ${sessionId}): transcriptLen=${transcript ? transcript.length : 0} recap=${recap ? 'yes' : 'no'}`);

    if (client.owner_phone) {
      const who = session.caller_number ? `${session.caller_number}` : 'the caller';
      const smsBody = recap
        ? `Recap of the transferred call for ${client.business_name} (${who}):\n\n${recap}\n\nRecording: ${recordingUrl}`
        : `A transferred call for ${client.business_name} (${who}) just wrapped up. Recording: ${recordingUrl}`;
      await sendAndLogSMS({
        phone: client.owner_phone,
        message: smsBody,
        from: client.vapi_phone_number || (agency && agency.demo_phone_number) || null,
        agencyId: client.agency_id || null,
        recipientType: 'client_owner',
        messageType: 'transfer_recap',
        metadata: { sessionId, hasRecap: !!recap },
      });
      console.log(`telnyx-voice: transfer recap SMS to owner (recap=${!!recap})`);
    }

    // Best-effort: fold the recap into the dashboard call record (the
    // transferred calls row the end-of-call report created). Non-destructive:
    // append to ai_summary and stash the transfer recording in call_metadata.
    if (recap) {
      try {
        const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
        const { data: rows } = await supabase
          .from('calls')
          .select('id, ai_summary, call_metadata')
          .eq('client_id', client.id)
          .eq('call_status', 'transferred')
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(2);
        if (rows && rows.length === 1) {
          const row = rows[0];
          const merged = (row.ai_summary ? row.ai_summary + '\n\n' : '') + `After transfer: ${recap}`;
          const meta = Object.assign({}, row.call_metadata || {}, { transfer_recording_url: recordingUrl });
          await supabase.from('calls').update({ ai_summary: merged, call_metadata: meta }).eq('id', row.id);
          console.log(`telnyx-voice: folded transfer recap into call ${row.id}`);
        } else {
          console.log(`telnyx-voice: calls-row recap match: ${rows ? rows.length : 0} candidates, skipped dashboard update`);
        }
      } catch (e) { console.error(`telnyx-voice: calls recap update failed: ${e.message}`); }
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
        // If answering-machine detection never fires (some carriers), fall back
        // to opening the press-1 gate after a short grace period. startGate is a
        // no-op unless the session is still 'transferring'.
        if (role === 'office' && sessionId) {
          setTimeout(() => { startGate(sessionId).catch(() => {}); }, 6000);
        }
        break;

      case 'call.machine.detection.ended':
        if (role === 'office' && sessionId) {
          // A confirmed 'machine' is treated as voicemail and returned to the
          // AI. 'human', 'not_sure', and 'silence' open the press-1 gate, where
          // the keypress is the real human check.
          if (payload.result === 'machine') {
            await returnToAI(sessionId, 'voicemail');
          } else {
            await startGate(sessionId);
          }
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
      .select('vapi_phone_number, owner_phone, transfer_phone, tool_config, agency_id')
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

    // Take the caller OFF the AI so they hear ringing (not the AI) during the
    // dial. The VAPI leg is kept alive and parked so we can re-bridge the caller
    // to it if the office does not answer.
    const caller = session.telnyx_caller_control_id;
    const vapi = session.telnyx_vapi_control_id;
    if (caller && vapi) await unbridgeCall(caller, { otherCallControlId: vapi });

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
      amd: 'premium',
      timeoutSecs: OFFICE_RING_SECONDS,
      clientState: { role: 'office', sessionId: session.id },
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
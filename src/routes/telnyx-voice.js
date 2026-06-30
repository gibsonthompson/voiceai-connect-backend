// ============================================================================
// TELNYX VOICE ROUTES - Whisper warm transfer engine (telnyx_cc clients only)
// ----------------------------------------------------------------------------
// Deploy to: src/routes/telnyx-voice.js
// Mount in server.js with:   app.use('/', require('./routes/telnyx-voice'));
// AND add '/webhook/telnyx-voice' to the express.raw() exception list so the
// Telnyx webhook arrives as a raw Buffer for signature verification.
//
// This file owns two endpoints:
//
//   POST /webhook/telnyx-voice      <- Telnyx Call Control events (raw body)
//   POST /api/voice/request-transfer <- VAPI calls this when the AI decides to
//                                        hand the caller to a human (JSON body)
//
// THE THREE LEGS of a telnyx_cc call:
//   A = caller   (inbound PSTN leg, we answer it)
//   B = VAPI     (outbound SIP leg into VAPI, bridged to A so the AI can talk)
//   C = office   (outbound PSTN leg to the owner, created only on transfer)
//
// HAPPY PATH:
//   1. Caller dials in. Telnyx fires call.initiated. We answer A, create a
//      call_sessions row, then dial VAPI (B) carrying the client id + session
//      id as SIP headers. We bridge A<->B. Caller is now talking to the AI.
//   2. Caller asks for a human. VAPI calls /api/voice/request-transfer with a
//      one-line summary. We dial the office (C) with answering-machine
//      detection, and hold the HTTP response open briefly.
//   3. A real person answers C. We speak the whisper to C ONLY (the caller does
//      not hear it). When the whisper finishes, we hang up the VAPI leg (B) and
//      bridge the caller (A) to the office (C). Done.
//   4. If nobody answers / it hits voicemail, we hang up C, leave the caller
//      with the AI (A<->B is untouched), and tell the AI to take a message.
//
// SAFETY: vapi_direct clients never touch this file. Their calls go straight
// into VAPI exactly as before. This path only runs for numbers pointed at the
// Telnyx Call Control app.
// ============================================================================

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const { supabase, getClientByVapiPhoneNumber } = require('../lib/supabase');
const {
  callAction,
  answerCall,
  dialCall,
  speakToCall,
  bridgeCalls,
  hangupCall,
  decodeClientState,
} = require('../lib/telnyx-voice');

const VAPI_SIP_URI = process.env.VAPI_SIP_URI || null;
const TELNYX_PUBLIC_KEY = process.env.TELNYX_PUBLIC_KEY || null;
const BACKEND_URL = process.env.BACKEND_URL || 'https://urchin-app-bqb4i.ondigitalocean.app';

// Whisper infra ids live in platform_settings (created lazily by vapi.js
// ensureWhisperInfra during provisioning). Read them here, cached for 60s, with
// env fallback so a manually-set env still works. DB value wins when present.
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

// How long the office is allowed to ring before we give up and take a message.
const OFFICE_RING_SECONDS = 20;
// How long /api/voice/request-transfer waits for an answer before telling the
// AI to take a message. Keep this a few seconds UNDER the VAPI tool timeout
// (set to 25s on the tool in the config builder) so VAPI does not time out
// first. If answering-machine detection is slow, we still resolve by here.
const TRANSFER_WAIT_MS = 19000;

// ----------------------------------------------------------------------------
// In-memory registry of transfers waiting on an office answer. Keyed by session
// id. Each entry lets the Telnyx event handler resolve the HTTP request that is
// still open in /api/voice/request-transfer.
//
// NOTE: this assumes a single backend instance (DigitalOcean App Platform with
// 1 instance, which is the current setup). If you scale to multiple instances,
// the bridge/whisper still works (it is driven entirely by Telnyx events), but
// the "tell the AI it failed" message may not fire on the instance holding the
// HTTP request. Move this to a shared store (Redis) before scaling out.
// ----------------------------------------------------------------------------
const pendingTransfers = new Map();

function settleTransfer(sessionId, outcome) {
  const entry = pendingTransfers.get(sessionId);
  if (!entry) return;
  pendingTransfers.delete(sessionId);
  if (entry.timer) clearTimeout(entry.timer);
  try { entry.resolve(outcome); } catch (_) { /* already responded */ }
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
// Telnyx signs the raw body as `${timestamp}|${rawBody}` and sends the
// signature in the 'telnyx-signature-ed25519' header (base64) with the
// timestamp in 'telnyx-timestamp'. TELNYX_PUBLIC_KEY is the base64 raw 32-byte
// public key from the Telnyx portal. We wrap it in the standard Ed25519 SPKI
// DER prefix so Node's crypto can use it with no extra dependency.
//
// If TELNYX_PUBLIC_KEY is not set yet, we log a warning and ALLOW the request
// through, so you can get the flow working before wiring the key. Once the key
// is set, a bad signature is rejected.
// ----------------------------------------------------------------------------
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function verifyTelnyxSignature(rawBody, signatureB64, timestamp) {
  if (!TELNYX_PUBLIC_KEY) {
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

// ============================================================================
// INBOUND: a caller dialed a telnyx_cc number. Answer, set up the session,
// dial VAPI, and bridge them so the AI can start talking.
// ============================================================================
async function handleInbound(payload) {
  const callerLeg = payload.call_control_id;
  const toNumber = payload.to;     // the client's number (DID on the Telnyx app)
  const fromNumber = payload.from; // the actual caller

  console.log(`telnyx-voice: inbound ${fromNumber} -> ${toNumber} (leg ${callerLeg})`);

  // Which client owns this number?
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

  // Create the session row that ties all three legs together.
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

  // Answer the caller, tagging the leg so later events know what it is.
  await answerCall(callerLeg, { role: 'caller', sessionId });

  // Dial VAPI over SIP. The two custom headers are how the shared VAPI SIP
  // endpoint figures out which client this is (X-Client-Id) and which session
  // to attach the VAPI call id to (X-Session-Id, read in vapi-webhook.js).
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
// park_after_unbridge:'self' on the caller leg is the key detail: it means when
// we later hang up the VAPI leg, the caller leg STAYS ALIVE (parked) instead of
// dropping, so we can immediately bridge the caller to the office.
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

// ============================================================================
// Office answered + machine detection finished: decide human vs voicemail.
// On a human, whisper the summary. On a machine, give up and take a message.
// ============================================================================
async function handleOfficeDecision(sessionId, isHuman) {
  const session = await getSessionById(sessionId);
  if (!session || session.status === 'bridged') return;
  const office = session.telnyx_office_control_id;
  if (!office) return;

  if (!isHuman) {
    console.log(`telnyx-voice: office reached voicemail/no-answer (session ${sessionId}) - taking message`);
    await hangupCall(office);
    await updateSession(sessionId, { status: 'office_failed' });
    settleTransfer(sessionId, 'take_message');
    return;
  }

  // Human answered. Whisper the summary to the office leg ONLY.
  const summary = session.whisper_summary || 'A caller is being connected to you.';
  const callerLabel = session.caller_number ? ` The caller's number is ${session.caller_number}.` : '';
  const whisper = `You have a call from your A I receptionist. ${summary}${callerLabel} Connecting you now.`;

  await speakToCall(office, whisper, { clientState: { role: 'office', sessionId } });
  // The bridge happens on call.speak.ended (below), once the whisper finishes.
  // Tell the AI it succeeded so it stops talking; the leg drop is imminent.
  settleTransfer(sessionId, 'connected');
}

// ============================================================================
// Whisper finished playing to the office: complete the handoff.
//   1. Hang up the VAPI leg (the AI's job is done).
//   2. Bridge the caller to the office.
// Because the caller leg was parked on unbridge, it survives step 1.
// ============================================================================
async function handleWhisperDone(sessionId) {
  const session = await getSessionById(sessionId);
  if (!session || session.status === 'bridged') return;
  const caller = session.telnyx_caller_control_id;
  const vapi = session.telnyx_vapi_control_id;
  const office = session.telnyx_office_control_id;
  if (!caller || !office) return;

  if (vapi) await hangupCall(vapi);
  await bridgeCalls(caller, office);
  await updateSession(sessionId, { status: 'bridged' });
  console.log(`telnyx-voice: caller bridged to office (session ${sessionId}) - whisper transfer complete`);
}

// ============================================================================
// MAIN WEBHOOK: Telnyx Call Control events.
// ============================================================================
router.post('/webhook/telnyx-voice', async (req, res) => {
  // req.body is a Buffer when '/webhook/telnyx-voice' is in the express.raw()
  // exception list (it must be). Fall back gracefully if it is an object.
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
        // Office answer is handled via machine-detection below. If AMD never
        // fires (some carriers), fall back to treating the answer as human
        // after a short grace period.
        if (role === 'office' && sessionId) {
          setTimeout(async () => {
            const s = await getSessionById(sessionId);
            if (s && s.status === 'transferring') {
              console.log(`telnyx-voice: no AMD result for office (session ${sessionId}) - assuming human`);
              await handleOfficeDecision(sessionId, true);
            }
          }, 6000);
        }
        break;

      case 'call.machine.detection.ended':
        if (role === 'office' && sessionId) {
          // 'human', 'not_sure', and 'silence' all get the whisper (never drop
          // a real person). Only a confirmed 'machine' is treated as voicemail.
          const result = payload.result;
          const isHuman = result !== 'machine';
          await handleOfficeDecision(sessionId, isHuman);
        }
        break;

      case 'call.speak.ended':
        if (role === 'office' && sessionId) {
          await handleWhisperDone(sessionId);
        }
        break;

      case 'call.hangup':
        if (sessionId) {
          const s = await getSessionById(sessionId);
          if (s && s.status !== 'bridged' && s.status !== 'ended') {
            // If the office leg drops before we bridged, it was a no-answer.
            if (role === 'office') {
              await updateSession(sessionId, { status: 'office_failed' });
              settleTransfer(sessionId, 'take_message');
            } else if (role === 'caller' || role === 'vapi') {
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
// this. We dial the office, then hold the response open until the office
// answers (whisper + bridge proceed via Telnyx events) or fails (take message).
//
// Returns the VAPI tool-result shape: { results: [{ toolCallId, result }] }.
// ============================================================================
router.post('/api/voice/request-transfer', async (req, res) => {
  const body = req.body || {};
  const msg = body.message || body;
  const vapiCallId = msg.call?.id || body.call?.id || null;

  // VAPI has used a few shapes for tool calls across versions. Check all.
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

  const reply = (text) => res.status(200).json({ results: [{ toolCallId, result: text }] });

  try {
    const session = await getSessionByVapiCallId(vapiCallId);
    if (!session) {
      console.error(`telnyx-voice: request-transfer with no session for vapi call ${vapiCallId} (is vapi-webhook.js storing vapi_call_id on the session yet?)`);
      return reply('I could not reach the team line right now. Apologize and offer to take a detailed message with the caller name, number, and reason for calling.');
    }

    if (session.status === 'bridged' || session.status === 'transferring') {
      return reply('A transfer is already in progress. Please hold.');
    }

    // Need the client to present a valid caller ID (the business DID) on the
    // outbound office leg.
    const { data: client } = await supabase
      .from('clients')
      .select('vapi_phone_number, owner_phone, transfer_phone')
      .eq('id', session.client_id)
      .single();

    const officeNumber = toE164(session.office_number || client?.transfer_phone || client?.owner_phone);
    const businessDid = toE164(client?.vapi_phone_number) || officeNumber;

    if (!officeNumber) {
      return reply('There is no team phone number on file to transfer to. Apologize and offer to take a detailed message instead.');
    }

    // Guard against a forwarding loop: never dial the same line the caller's
    // call may have forwarded from.
    if (businessDid && officeNumber === businessDid) {
      console.warn(`telnyx-voice: transfer number equals business DID (session ${session.id}) - refusing to avoid a loop`);
      return reply('I am not able to connect that call right now. Apologize and offer to take a detailed message instead.');
    }

    await updateSession(session.id, { status: 'transferring', whisper_summary: summary });

    const { connectionId } = await getWhisperConfig();
    const officeLeg = await dialCall({
      to: officeNumber,
      from: businessDid,
      connectionId,
      amd: 'detect',
      timeoutSecs: OFFICE_RING_SECONDS,
      clientState: { role: 'office', sessionId: session.id },
    });

    if (!officeLeg || !officeLeg.call_control_id) {
      await updateSession(session.id, { status: 'active' });
      return reply('I could not reach the team right now. Apologize and offer to take a detailed message with the caller name, number, and reason for calling.');
    }

    await updateSession(session.id, { telnyx_office_control_id: officeLeg.call_control_id });

    // Hold the response open until a Telnyx event settles this transfer, or we
    // time out and fall back to taking a message.
    const outcome = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingTransfers.delete(session.id);
        // Cancel the ringing office leg so it cannot answer after we have
        // already told the AI to take a message.
        hangupCall(officeLeg.call_control_id).catch(() => {});
        updateSession(session.id, { status: 'office_failed' }).catch(() => {});
        resolve('take_message');
      }, TRANSFER_WAIT_MS);
      pendingTransfers.set(session.id, { resolve, timer });
    });

    if (outcome === 'connected') {
      return reply('Connecting you now. Do not say anything further; the team member is taking over the call.');
    }
    return reply('No one on the team is available right now. Apologize to the caller and offer to take a detailed message with their name, number, and reason for calling.');
  } catch (err) {
    console.error('telnyx-voice: request-transfer error:', err.message);
    return reply('I ran into a problem connecting that call. Apologize and offer to take a detailed message instead.');
  }
});

module.exports = router;
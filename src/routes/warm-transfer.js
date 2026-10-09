// ============================================================================
// src/routes/warm-transfer.js
// Phase 1 warm transfer with a SPOKEN whisper, on Telnyx, no Twilio, and
// without running every call through Telnyx Call Control (the telnyx_cc engine).
//
// THE IDEA
//   The AI keeps running on VAPI as normal. When it decides to hand the caller
//   to a person, it calls the `warm_transfer` function tool with a one-line
//   summary. We then use the call's own controlUrl (VAPI live call control) to
//   REFER the caller to a Telnyx TeXML app at a per-call SIP address that
//   carries a token. Telnyx now owns the caller leg, dials the team member,
//   speaks the summary to them alone, and bridges the caller in. Telnyx is only
//   involved at transfer time, so normal calls stay cheap.
//
// THE LEGS
//   A = caller (on VAPI via the Telnyx SIP trunk)
//   On transfer: VAPI REFERs A to  sip:wt-<sessionId>@<TELNYX_TEXML_SIP_DOMAIN>
//   Telnyx answers A, runs our TeXML, dials B = team member, whispers, bridges.
//
// CONTEXT PASSING
//   No dependency on custom SIP headers. We mint a row in call_sessions (which
//   already has whisper_summary, office_number, caller_number) and put its id in
//   the SIP user part. The TeXML webhook reads the id back from the To param; if
//   Telnyx does not surface the user part, it falls back to matching the most
//   recent pending session by caller number. Cross-instance safe (Supabase).
//
// ENDPOINTS
//   POST /api/voice/warm-transfer      <- VAPI function-tool target (JSON)
//   POST /texml/warm-transfer          <- Telnyx TeXML, inbound REFER (form)
//   POST /texml/whisper                <- Telnyx TeXML, agent-leg pre-bridge hook
//   POST /texml/warm-transfer/after    <- Telnyx TeXML, Dial result (no-answer)
//   POST /texml/voicemail              <- Telnyx TeXML, voicemail capture
//
// DIAGNOSTICS
//   Every step logs under the [warm-transfer] tag with the call id / token so a
//   failed hand-off can be traced end to end in the DigitalOcean logs. The TeXML
//   webhooks log the raw Telnyx params on arrival so we can see exactly what
//   Telnyx sends (especially whether the token survives in To).
//
// SETUP: create a Telnyx TeXML Application whose Voice webhook points at
//   {BACKEND_URL}/texml/warm-transfer, give it an inbound SIP subdomain, assign
//   an Outbound Voice Profile, and set TELNYX_TEXML_SIP_DOMAIN to that
//   subdomain (e.g. voiceai.sip.telnyx.com). Until that env var is set,
//   assistant-config-builder keeps the old blind transferCall, so deploying this
//   file changes nothing on its own.
//
// CREATED: 2026-10-09
// ============================================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { sendAndLogSMS } = require('../lib/sms-logger');
const { broadcastLiveEvent } = require('../lib/live-broadcast');
const { fetchMonitorUrls } = require('../lib/vapi-call-monitor');

const TEXML_SIP_DOMAIN = process.env.TELNYX_TEXML_SIP_DOMAIN || null;
const BACKEND_URL = process.env.BACKEND_URL || '';

const log = (...a) => console.log('[warm-transfer]', ...a);
const logErr = (...a) => console.error('[warm-transfer]', ...a);

// ---- helpers ---------------------------------------------------------------

// XML-escape anything we drop into a TeXML <Say> (the summary is model text and
// can contain &, <, >, ", ').
function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Best-effort E.164: keep a leading +, strip spaces/dashes/parens. A US 10/11
// digit number with no + gets one. Anything else is returned as-is for Telnyx
// to judge.
function normE164(raw) {
  if (!raw) return null;
  let p = String(raw).trim().replace(/[()\s.-]/g, '');
  if (p.startsWith('+')) return p;
  if (/^1\d{10}$/.test(p)) return `+${p}`;
  if (/^\d{10}$/.test(p)) return `+1${p}`;
  return p.startsWith('+') ? p : `+${p}`;
}

function sendTexml(res, xml) {
  res.set('Content-Type', 'text/xml');
  res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>\n${xml}`);
}

// A TeXML document that apologizes and takes a voicemail. Used whenever we
// cannot reach a person, so the caller is never dropped in silence.
function voicemailXml(sessionId) {
  const action = `${BACKEND_URL}/texml/voicemail?token=${encodeURIComponent(sessionId || '')}`;
  return `<Response>
  <Say voice="Polly.Joanna">Sorry, no one is available to take your call right now. Please leave a message after the tone, and someone will get back to you.</Say>
  <Record maxLength="120" playBeep="true" transcribe="true" transcriptionCallback="${action}" action="${action}" method="POST"/>
  <Hangup/>
</Response>`;
}

// Telnyx posts TeXML webhooks as application/x-www-form-urlencoded. The global
// express.json parser ignores that content-type, so parse it here for /texml.
router.use('/texml', express.urlencoded({ extended: false }));

// ===========================================================================
// POST /api/voice/warm-transfer   (VAPI function-tool target, JSON body)
// The AI calls this with { summary }. We REFER the caller into Telnyx via the
// call's controlUrl. Always answer 200 with a tool result so the AI can speak.
// ===========================================================================
router.post('/api/voice/warm-transfer', async (req, res) => {
  const body = req.body || {};
  const msg = body.message || body;
  const vapiCallId = msg.call?.id || body.call?.id || null;
  const callerNumber = msg.call?.customer?.number || body.call?.customer?.number || null;

  const toolCalls = msg.toolCallList || msg.toolCalls
    || (Array.isArray(msg.toolWithToolCallList)
        ? msg.toolWithToolCallList.map(t => t.toolCall).filter(Boolean)
        : []);
  const tc = (toolCalls || []).find(t => (t.function?.name || t.name) === 'warm_transfer')
    || (toolCalls || [])[0]
    || {};
  const toolCallId = tc.id || tc.toolCallId || 'warm_transfer';

  let args = tc.function?.arguments ?? tc.arguments ?? {};
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = { summary: args }; } }
  const summary = (args.summary || '').toString().trim();

  const reply = (result) => res.status(200).json({ results: [{ toolCallId, result }] });
  const takeMessage = 'I could not reach the team right now. Apologize, then take a detailed message: the caller\'s name, number, and reason for calling.';

  log(`tool call: callId=${vapiCallId} caller=${callerNumber || '?'} summaryLen=${summary.length}`);

  try {
    if (!TEXML_SIP_DOMAIN) { logErr('TELNYX_TEXML_SIP_DOMAIN not set; cannot whisper, taking a message'); return reply(takeMessage); }

    const clientId = (req.query && req.query.clientId) || body.clientId || null;
    if (!clientId) { logErr(`no clientId on request for call ${vapiCallId}`); return reply(takeMessage); }

    const { data: client, error: cErr } = await supabase
      .from('clients')
      .select('id, agency_id, business_name, owner_phone, transfer_phone, vapi_phone_number')
      .eq('id', clientId)
      .single();
    if (cErr || !client) { logErr(`client ${clientId} not found: ${cErr && cErr.message}`); return reply(takeMessage); }

    const agentPhone = normE164(client.transfer_phone || client.owner_phone);
    if (!agentPhone) { logErr(`client ${clientId} has no transfer_phone/owner_phone`); return reply(takeMessage); }

    let controlUrl = msg.call?.monitor?.controlUrl || body.call?.monitor?.controlUrl || null;
    log(`controlUrl on event: ${controlUrl ? 'present' : 'absent'}`);
    if (!controlUrl && vapiCallId) {
      try {
        const urls = await fetchMonitorUrls(vapiCallId);
        controlUrl = urls && urls.controlUrl ? urls.controlUrl : null;
        log(`controlUrl via GET /call fallback: ${controlUrl ? 'present' : 'absent'}`);
      } catch (e) { logErr(`fetchMonitorUrls failed: ${e.message}`); }
    }
    if (!controlUrl) { logErr(`no controlUrl for call ${vapiCallId}; taking a message`); return reply(takeMessage); }

    const { data: sessionRow, error: insErr } = await supabase
      .from('call_sessions')
      .insert([{
        client_id: client.id,
        agency_id: client.agency_id || null,
        caller_number: callerNumber,
        office_number: agentPhone,
        vapi_call_id: vapiCallId,
        whisper_summary: summary || null,
        status: 'warm_pending',
      }])
      .select('id')
      .single();
    if (insErr || !sessionRow) { logErr(`call_sessions insert failed: ${insErr && insErr.message}`); return reply(takeMessage); }
    const token = sessionRow.id;
    const sipUri = `sip:wt-${token}@${TEXML_SIP_DOMAIN}`;
    log(`session ${token} created; agent=${agentPhone}; REFER target=${sipUri}`);

    const controlBody = {
      type: 'transfer',
      destination: { type: 'sip', sipUri },
      content: 'One moment, connecting you now.',
    };
    const controller = new AbortController();
    const timer = setTimeout(() => { try { controller.abort(); } catch (e) {} }, 8000);
    let transferred = false;
    try {
      const r = await fetch(controlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(controlBody),
        signal: controller.signal,
      });
      transferred = !!(r && r.ok);
      const t = await r.text().catch(() => '');
      log(`controlUrl transfer response: status=${r && r.status} ok=${transferred} body=${(t || '').slice(0, 160)}`);
    } catch (e) {
      logErr(`controlUrl POST threw: ${e.message}`);
    } finally { clearTimeout(timer); }

    if (!transferred) {
      await supabase.from('call_sessions').update({ status: 'warm_failed' }).eq('id', token).then(() => {}, () => {});
      return reply(takeMessage);
    }

    try {
      broadcastLiveEvent(client.id, {
        callId: vapiCallId, type: 'activity', tool: 'warm_transfer',
        label: 'Connecting to the team with a spoken briefing',
      });
    } catch (e) { /* best effort */ }

    log(`REFER sent for session ${token}; handing off to Telnyx`);
    return reply('Connecting the caller now. Stop talking; the system takes over from here.');
  } catch (err) {
    logErr(`handler failed: ${err.message}`);
    return reply(takeMessage);
  }
});

// ===========================================================================
// POST /texml/warm-transfer   (Telnyx TeXML Voice webhook: the REFER landed)
// ===========================================================================
router.post('/texml/warm-transfer', async (req, res) => {
  const b = req.body || {};
  log(`texml/warm-transfer inbound: keys=${Object.keys(b).join(',')} To=${b.To || b.to || ''} From=${b.From || b.from || ''} CallSid=${b.CallSid || b.CallSidLegacy || ''}`);
  try {
    const to = (b.To || b.to || '');
    const from = (b.From || b.from || '');
    const m = /wt-([0-9a-fA-F-]{10,})/.exec(to);
    let token = m ? m[1] : null;

    let session = null;
    if (token) {
      const { data } = await supabase
        .from('call_sessions')
        .select('id, office_number, caller_number, vapi_call_id, status')
        .eq('id', token).single();
      session = data || null;
      log(`token from To=${token}; session ${session ? 'found' : 'MISSING'}`);
    }
    // Fallback: Telnyx may not surface the SIP user part in To. Match the most
    // recent pending session for this caller.
    if (!session && from) {
      const fromNorm = normE164(from);
      const { data } = await supabase
        .from('call_sessions')
        .select('id, office_number, caller_number, vapi_call_id, status')
        .in('status', ['warm_pending', 'warm_dialing'])
        .order('created_at', { ascending: false })
        .limit(10);
      const match = (data || []).find(s => normE164(s.caller_number) === fromNorm) || null;
      if (match) { session = match; token = match.id; log(`fallback matched session ${token} by caller ${fromNorm}`); }
      else { logErr(`no token in To and no caller match for From=${from}`); }
    }

    const agent = session && normE164(session.office_number);
    if (!session || !agent) {
      logErr(`no session/agent; sending caller to voicemail (token=${token || 'none'})`);
      return sendTexml(res, voicemailXml(token));
    }

    const callerId = (session.caller_number && normE164(session.caller_number)) || agent;
    const whisperUrl = `${BACKEND_URL}/texml/whisper?token=${encodeURIComponent(token)}`;
    const afterUrl = `${BACKEND_URL}/texml/warm-transfer/after?token=${encodeURIComponent(token)}`;

    await supabase.from('call_sessions').update({ status: 'warm_dialing' }).eq('id', token).then(() => {}, () => {});
    log(`dialing agent ${agent} for session ${token} (callerId=${callerId})`);

    const xml = `<Response>
  <Dial answerOnBridge="true" callerId="${escapeXml(callerId)}" timeout="25" action="${afterUrl}" method="POST">
    <Number url="${whisperUrl}" method="POST">${escapeXml(agent)}</Number>
  </Dial>
</Response>`;
    return sendTexml(res, xml);
  } catch (err) {
    logErr(`texml/warm-transfer failed: ${err.message}`);
    return sendTexml(res, '<Response><Say voice="Polly.Joanna">Sorry, we could not connect your call.</Say><Hangup/></Response>');
  }
});

// ===========================================================================
// POST /texml/whisper   (runs on the AGENT leg, before the caller is bridged)
// ===========================================================================
router.post('/texml/whisper', async (req, res) => {
  const token = (req.query && req.query.token) || (req.body && req.body.token) || null;
  log(`texml/whisper for session ${token}`);
  try {
    let summary = '';
    if (token) {
      const { data: session } = await supabase
        .from('call_sessions').select('whisper_summary').eq('id', token).single();
      summary = (session && session.whisper_summary) || '';
    }
    const spoken = summary
      ? `You have a call from your A I receptionist. ${summary}. Connecting you now.`
      : 'You have a call from your A I receptionist. Connecting you now.';
    log(`whisper summaryLen=${summary.length} for session ${token}`);
    const xml = `<Response>
  <Gather numDigits="1" timeout="6">
    <Say voice="Polly.Joanna">${escapeXml(spoken)}</Say>
  </Gather>
</Response>`;
    return sendTexml(res, xml);
  } catch (err) {
    logErr(`texml/whisper failed: ${err.message}`);
    return sendTexml(res, '<Response></Response>');
  }
});

// ===========================================================================
// POST /texml/warm-transfer/after   (Dial finished)
// ===========================================================================
router.post('/texml/warm-transfer/after', async (req, res) => {
  const token = (req.query && req.query.token) || (req.body && req.body.token) || null;
  const status = (req.body && (req.body.DialCallStatus || req.body.dialCallStatus)) || '';
  log(`texml/warm-transfer/after session=${token} DialCallStatus=${status}`);
  try {
    if (status === 'completed' || status === 'answered') {
      await supabase.from('call_sessions').update({ status: 'bridged' }).eq('id', token).then(() => {}, () => {});
      return sendTexml(res, '<Response><Hangup/></Response>');
    }
    await supabase.from('call_sessions').update({ status: 'warm_no_answer' }).eq('id', token).then(() => {}, () => {});
    log(`agent did not answer (status=${status}); sending caller to voicemail for session ${token}`);
    return sendTexml(res, voicemailXml(token));
  } catch (err) {
    logErr(`texml/warm-transfer/after failed: ${err.message}`);
    return sendTexml(res, voicemailXml(token));
  }
});

// ===========================================================================
// POST /texml/voicemail   (voicemail captured; notify the owner)
// ===========================================================================
router.post('/texml/voicemail', async (req, res) => {
  const token = (req.query && req.query.token) || (req.body && req.body.token) || null;
  const recordingUrl = (req.body && (req.body.RecordingUrl || req.body.recordingUrl)) || null;
  const transcript = (req.body && (req.body.TranscriptionText || req.body.transcriptionText)) || null;
  log(`texml/voicemail session=${token} recording=${recordingUrl ? 'yes' : 'no'} transcript=${transcript ? 'yes' : 'no'}`);
  try {
    if (token) {
      const { data: session } = await supabase
        .from('call_sessions')
        .select('id, client_id, caller_number')
        .eq('id', token).single();

      if (session && session.client_id) {
        const { data: client } = await supabase
          .from('clients')
          .select('id, agency_id, business_name, owner_phone, vapi_phone_number')
          .eq('id', session.client_id).single();
        let agency = null;
        if (client && client.agency_id) {
          const { data } = await supabase
            .from('agencies').select('id, name, demo_phone_number').eq('id', client.agency_id).single();
          agency = data || null;
        }
        if (client && client.owner_phone) {
          const fromLabel = (session.caller_number ? `from ${session.caller_number} ` : '');
          let smsBody = `New voicemail for ${client.business_name} ${fromLabel}(the AI could not reach the team).`;
          if (transcript) smsBody += `\n\n"${transcript}"`;
          if (recordingUrl) smsBody += `\n\nRecording: ${recordingUrl}`;
          const sent = await sendAndLogSMS({
            phone: client.owner_phone,
            message: smsBody,
            from: client.vapi_phone_number || (agency && agency.demo_phone_number) || null,
            agencyId: client.agency_id || null,
            recipientType: 'client_owner',
            messageType: 'transfer_voicemail',
            metadata: { token, hasTranscript: !!transcript },
          });
          log(`voicemail owner SMS to ${client.owner_phone}: ${sent ? 'sent' : 'FAILED'}`);
        }
      }
      await supabase.from('call_sessions').update({ status: 'voicemail' }).eq('id', token).then(() => {}, () => {});
    }
    return sendTexml(res, '<Response><Hangup/></Response>');
  } catch (err) {
    logErr(`texml/voicemail failed: ${err.message}`);
    return sendTexml(res, '<Response><Hangup/></Response>');
  }
});

module.exports = router;
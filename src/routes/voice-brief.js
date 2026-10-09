// ============================================================================
// src/routes/voice-brief.js
// POST /api/voice/brief-operator?clientId=<id>   (VAPI function-tool target)
//
// Phase 0 of the warm-transfer work. The AI calls the `brief_operator` tool the
// moment before it transfers a caller to a human, passing a one-line summary
// (who is calling and why). We text that summary to the team member about to be
// connected, so they have context the instant their phone rings, even though
// the native VAPI transfer itself is still a blind hand-off on Telnyx.
//
// Sender policy matches the post-call owner SMS: from the client's own AI
// number first (white-label, recognizable to the owner), then the agency's warm
// demo number, never the bare platform number first.
//
// Body is JSON (the global express.json parser; this path is NOT in the raw
// webhook exemption list in server.js).
// Returns the VAPI tool-result shape: { results: [{ toolCallId, result }] }.
//
// Mounted in server.js:  app.use('/', require('./routes/voice-brief'));
// CREATED: 2026-10-09
// ============================================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { sendAndLogSMS } = require('../lib/sms-logger');
const { broadcastLiveEvent } = require('../lib/live-broadcast');

router.post('/api/voice/brief-operator', async (req, res) => {
  const body = req.body || {};
  const msg = body.message || body;
  const vapiCallId = msg.call?.id || body.call?.id || null;

  // VAPI has used a few tool-call shapes across versions. Check all, the same
  // way the request-transfer and send_sms handlers do.
  const toolCalls = msg.toolCallList || msg.toolCalls
    || (Array.isArray(msg.toolWithToolCallList)
        ? msg.toolWithToolCallList.map(t => t.toolCall).filter(Boolean)
        : []);
  const tc = (toolCalls || []).find(t => (t.function?.name || t.name) === 'brief_operator')
    || (toolCalls || [])[0]
    || {};
  const toolCallId = tc.id || tc.toolCallId || 'brief_operator';

  let args = tc.function?.arguments ?? tc.arguments ?? {};
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { args = { summary: args }; }
  }
  const summary = (args.summary || '').toString().trim();

  // Always answer 200 with a result string so the AI can speak its line and
  // move straight on to the transfer. A failure here must NEVER block the
  // hand-off, so every path below returns through reply().
  const reply = (result) => res.status(200).json({ results: [{ toolCallId, result }] });

  try {
    const clientId = (req.query && req.query.clientId) || body.clientId || null;
    if (!clientId) return reply('Go ahead and connect the call.');

    const { data: client } = await supabase
      .from('clients')
      .select('id, agency_id, business_name, owner_phone, transfer_phone, vapi_phone_number')
      .eq('id', clientId)
      .single();
    if (!client) return reply('Go ahead and connect the call.');

    // Who is about to be connected: the dedicated transfer number if set,
    // otherwise the business owner. Same target the transfer itself uses.
    const operatorPhone = client.transfer_phone || client.owner_phone || null;
    if (!operatorPhone) return reply('Go ahead and connect the call.');

    let agency = null;
    if (client.agency_id) {
      try {
        const { data } = await supabase
          .from('agencies')
          .select('id, name, demo_phone_number')
          .eq('id', client.agency_id)
          .single();
        agency = data || null;
      } catch (e) { /* agency / branding is optional */ }
    }

    const brief = summary
      ? `Incoming call for ${client.business_name}: ${summary} Connecting you now.`
      : `Incoming call for ${client.business_name}. Connecting you now.`;

    const sent = await sendAndLogSMS({
      phone: operatorPhone,
      message: brief,
      // Same sender policy as the post-call owner SMS: the client's own AI
      // number first, then the agency warm demo number, never the bare platform
      // number first.
      from: client.vapi_phone_number || (agency && agency.demo_phone_number) || null,
      agencyId: client.agency_id || null,
      recipientType: 'client_owner',
      messageType: 'transfer_brief',
      metadata: { clientName: client.business_name, hasSummary: !!summary },
    });

    // Surface the hand-off in the live monitor, best-effort.
    try {
      broadcastLiveEvent(client.id, {
        callId: vapiCallId,
        type: 'activity',
        tool: 'brief_operator',
        label: 'Texting the team a heads-up',
      });
    } catch (e) { /* best effort */ }

    console.log(`📲 Transfer brief to ${operatorPhone} for ${client.business_name}: ${sent ? 'sent' : 'FAILED'}`);
    return reply(sent
      ? 'The team member has been texted a heads-up. Go ahead and connect the call now.'
      : 'Go ahead and connect the call.');
  } catch (err) {
    console.error('brief-operator failed:', err.message);
    return reply('Go ahead and connect the call.');
  }
});

module.exports = router;
// ============================================================================
// TEMPORARY DEBUG ROUTE (READ ONLY) - Coastal Living Team greeting diagnosis
// ----------------------------------------------------------------------------
// GET /api/debug-number/coastal
//
// Pulls VAPI's own record of the recent real calls to +13615890163 and shows,
// per call, what actually happened: whether a dynamic (transient) or a static
// assistant served it, the exact firstMessage VAPI was told to speak, and the
// literal first line spoken from the transcript. Also runs the builder once to
// show what a call RIGHT NOW would be handed. It performs NO writes.
//
// This is the ground truth for "it plays the default, not the custom greeting".
//
// DELETE this file and its one mount line in src/server.js after diagnosis.
// ============================================================================
const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const { supabase, getClientByVapiPhoneNumber } = require('../lib/supabase');
const { buildDynamicAssistantConfig } = require('../lib/assistant-config-builder');

const CLIENT_ID = 'af190bc2-995a-451f-a045-a3d2c828a445';
const TARGET_E164 = '+13615890163';
const VAPI_PHONE_ID_FALLBACK = 'a8e2c649-734f-4fde-8076-f7a0f778c645';
const VAPI_BASE = 'https://api.vapi.ai';

async function vapiGet(path) {
  try {
    const res = await fetch(`${VAPI_BASE}${path}`, {
      headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` },
    });
    const raw = await res.text();
    let body;
    try { body = JSON.parse(raw); } catch (e) { body = raw; }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: { fetchError: err.message } };
  }
}

function firstSpokenLine(call) {
  const msgs = (call.artifact && Array.isArray(call.artifact.messages))
    ? call.artifact.messages
    : (Array.isArray(call.messages) ? call.messages : []);
  const bot = msgs.find((m) => m && (m.role === 'bot' || m.role === 'assistant'));
  if (!bot) return null;
  return bot.message || bot.content || null;
}

router.get('/debug-number/coastal', async (req, res) => {
  const out = { generatedAt: new Date().toISOString(), target: TARGET_E164 };

  // Current DB greeting + the VAPI phone id to list calls for.
  let vapiPhoneId = VAPI_PHONE_ID_FALLBACK;
  try {
    const { data } = await supabase
      .from('clients')
      .select('greeting_message, vapi_phone_id, vapi_phone_number_id, updated_at, industry')
      .eq('id', CLIENT_ID)
      .single();
    if (data) {
      out.currentGreetingInDb = data.greeting_message || null;
      out.currentGreetingChars = data.greeting_message ? data.greeting_message.length : 0;
      out.clientUpdatedAt = data.updated_at || null;
      out.industry = data.industry || null;
      vapiPhoneId = data.vapi_phone_id || data.vapi_phone_number_id || VAPI_PHONE_ID_FALLBACK;
    }
  } catch (err) {
    out.currentGreetingInDb = { error: err.message };
  }

  // What a call RIGHT NOW would be handed by the builder.
  try {
    const liveClient = await getClientByVapiPhoneNumber(TARGET_E164);
    if (liveClient) {
      const built = await buildDynamicAssistantConfig(liveClient, liveClient.agencies || null, null);
      out.builderNow = {
        ok: true,
        firstMessage: built && built.firstMessage != null ? built.firstMessage : null,
        matchesDbGreeting: Boolean(
          built && built.firstMessage && out.currentGreetingInDb &&
          typeof out.currentGreetingInDb === 'string' &&
          built.firstMessage.trim() === out.currentGreetingInDb.trim()
        ),
      };
    } else {
      out.builderNow = { ok: false, note: 'live client lookup returned null' };
    }
  } catch (err) {
    out.builderNow = { ok: false, error: err.message, stack: (err.stack || '').split('\n').slice(0, 6).join(' || ') };
  }

  // THE GROUND TRUTH: VAPI's own record of recent real calls on this number.
  out.vapiPhoneIdUsed = vapiPhoneId;
  const callsRes = await vapiGet(`/call?phoneNumberId=${vapiPhoneId}&limit=10`);
  if (Array.isArray(callsRes.body)) {
    out.recentVapiCalls = callsRes.body.map((call) => {
      const servedBy = call.assistantId
        ? `STATIC assistantId=${call.assistantId}`
        : (call.assistant ? 'TRANSIENT (dynamic assistant-request)' : 'NONE / unknown');
      return {
        id: call.id,
        startedAt: call.startedAt || call.createdAt || null,
        endedReason: call.endedReason || null,
        caller: (call.customer && call.customer.number) || null,
        servedBy,
        greetingVapiWasToldToSay: call.assistant ? (call.assistant.firstMessage ?? null) : null,
        firstLineActuallySpoken: firstSpokenLine(call),
      };
    });
  } else {
    out.recentVapiCalls = { error: 'Unexpected /call response', status: callsRes.status, body: callsRes.body };
  }

  res.json(out);
});

module.exports = router;
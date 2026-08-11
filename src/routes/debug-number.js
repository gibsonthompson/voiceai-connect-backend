// ============================================================================
// TEMPORARY DEBUG ROUTE (READ ONLY) - Coastal Living Team greeting diagnosis
// ----------------------------------------------------------------------------
// GET /api/debug-number/coastal
//
// Confirmed so far from the VAPI object: the number is dynamic (assistantId
// null, serverUrl points at this backend), gates pass, greeting is saved. The
// only thing left to prove is what buildDynamicAssistantConfig actually emits
// as the first message for THIS client. This route now runs that builder with
// the exact arguments the webhook uses and returns the literal firstMessage, so
// we can see what a caller hears with no phone call. It performs NO writes.
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

router.get('/debug-number/coastal', async (req, res) => {
  const out = {
    generatedAt: new Date().toISOString(),
    target: TARGET_E164,
    clientId: CLIENT_ID,
    backendUrlEnv: process.env.BACKEND_URL || null,
  };

  // Live lookup via the exact function the webhook uses.
  let liveClient = null;
  try {
    liveClient = await getClientByVapiPhoneNumber(TARGET_E164);
    if (!liveClient) {
      out.liveLookup = { found: false };
    } else {
      out.liveLookup = {
        found: true,
        matchedClientId: liveClient.id,
        matchesTargetClient: liveClient.id === CLIENT_ID,
        greetingCharsSeenByHandler: liveClient.greeting_message ? liveClient.greeting_message.length : 0,
        greetingSeenByHandler: liveClient.greeting_message || null,
        embedsAgency: Boolean(liveClient.agencies),
        embeddedAgencySubStatus: liveClient.agencies ? (liveClient.agencies.subscription_status ?? null) : null,
        voice_id: liveClient.voice_id || null,
      };
    }
  } catch (err) {
    out.liveLookup = { error: err.message };
  }

  // THE DECISIVE TEST: run the real builder with the same args the handler uses
  // (client, client.agencies, callerContext=null for a fresh caller) and report
  // the literal firstMessage a caller would hear. If it throws, that is exactly
  // the crash the live handler would catch and mask by falling back to static.
  if (liveClient && liveClient.id) {
    try {
      const built = await buildDynamicAssistantConfig(liveClient, liveClient.agencies || null, null);
      const fm = (built && built.firstMessage != null) ? built.firstMessage : null;
      const greet = liveClient.greeting_message || null;
      out.builderOutput = {
        ok: true,
        firstMessage: fm,
        firstMessageMatchesGreeting: Boolean(fm && greet && fm.trim() === greet.trim()),
        voiceProvider: built && built.voice ? (built.voice.provider ?? null) : null,
        voiceId: built && built.voice ? (built.voice.voiceId ?? built.voice.voice_id ?? null) : null,
        modelProvider: built && built.model ? (built.model.provider ?? null) : null,
        modelName: built && built.model ? (built.model.model ?? null) : null,
        configKeys: built ? Object.keys(built) : null,
      };
    } catch (err) {
      out.builderOutput = {
        ok: false,
        error: err.message,
        stack: (err.stack || '').split('\n').slice(0, 8).join(' || '),
      };
    }
  } else {
    out.builderOutput = { skipped: 'no live client to build for' };
  }

  // VAPI object (kept for the record, already known dynamic).
  const listRes = await vapiGet('/phone-number?limit=1000');
  if (Array.isArray(listRes.body)) {
    const match = listRes.body.find((n) => n && n.number === TARGET_E164);
    out.vapiNumber = match
      ? { id: match.id ?? null, assistantId: match.assistantId ?? null, serverUrl: match.serverUrl ?? null, provider: match.provider ?? null, status: match.status ?? null }
      : { note: 'no match' };
  } else {
    out.vapiNumber = { error: 'unexpected list response', status: listRes.status };
  }

  res.json(out);
});

module.exports = router;
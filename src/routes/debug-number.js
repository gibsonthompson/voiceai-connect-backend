// ============================================================================
// TEMPORARY DEBUG ROUTE (READ ONLY) - Coastal Living Team greeting diagnosis
// ----------------------------------------------------------------------------
// GET /api/debug-number/coastal
//
// Purpose: settle from ground truth what a real inbound call to +13615890163
// actually does. It performs NO writes. It returns, side by side:
//
//   1. clientRow            - the clients row, both vapi id columns + greeting
//   2. agencyRow            - the owning agency's status/trial fields
//   3. liveLookup           - the result of getClientByVapiPhoneNumber(E164),
//                             the SAME function the webhook uses, including
//                             whether it embeds the agency (client.agencies)
//   4. gateEvaluation       - the assistant-request decision tree replayed on
//                             the live data, so we can see whether a call WOULD
//                             hit a disconnected/limit message or reach the
//                             dynamic greeting builder (only meaningful if the
//                             number is dynamic and the handler is even called)
//   5. vapiNumberByE164     - the VAPI phone object matched by the E164 string
//                             (ground truth: assistantId set = static wiring)
//                             plus the full raw object so nothing is missed
//   6. vapiNumberByDbId     - cross-check: does the id stored in the DB resolve
//   7. staticAssistant      - the static assistant firstMessage (what callers
//                             hear if the number is static OR if the builder
//                             crashes and the handler falls back to it)
//   8. backendUrlEnv        - what a migrated number's serverUrl should equal
//   9. recentCalls          - 5 most recent call rows (recency / reachability)
//
// DELETE this file and its one mount line in src/server.js after diagnosis.
// ============================================================================
const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const { supabase, getClientByVapiPhoneNumber } = require('../lib/supabase');

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

function isTrialExpired(trialEndsAt) {
  if (!trialEndsAt) return false;
  return new Date(trialEndsAt) < new Date();
}

// Replays handleAssistantRequest's gate tree using the agency object exactly as
// the live lookup hands it over (client.agencies). Predicts what a real inbound
// call WOULD do IF the number is dynamic and reaches the handler. If the number
// is static (assistantId set on the VAPI object), none of this runs at all.
function evaluateGates(client, agencyAsHandlerSees) {
  const agency = agencyAsHandlerSees || null;
  if (agency) {
    if (!['active', 'trial', 'trialing'].includes(agency.subscription_status)) {
      return { outcome: 'DISCONNECTED', reason: `agency.subscription_status='${agency.subscription_status}' not in [active,trial,trialing]`, caller_hears: 'no longer in service' };
    }
    if (['trial', 'trialing'].includes(agency.subscription_status) && isTrialExpired(agency.trial_ends_at)) {
      return { outcome: 'DISCONNECTED', reason: `agency trial expired (trial_ends_at=${agency.trial_ends_at})`, caller_hears: 'no longer in service' };
    }
  }
  if (!['active', 'trial'].includes(client.subscription_status)) {
    return { outcome: 'DISCONNECTED', reason: `client.subscription_status='${client.subscription_status}' not in [active,trial]`, caller_hears: 'no longer in service' };
  }
  if (client.subscription_status === 'trial' && isTrialExpired(client.trial_ends_at)) {
    return { outcome: 'DISCONNECTED', reason: `client trial expired (trial_ends_at=${client.trial_ends_at})`, caller_hears: 'no longer in service' };
  }
  const callLimit = client.monthly_call_limit == null ? 50 : client.monthly_call_limit;
  const calls = client.calls_this_month || 0;
  if (callLimit !== -1 && calls >= callLimit) {
    return { outcome: 'CALL_LIMIT', reason: `calls_this_month ${calls} >= monthly_call_limit ${callLimit}`, caller_hears: 'unable to take your call' };
  }
  return { outcome: 'DYNAMIC_BUILDER', reason: 'all gates passed; buildDynamicAssistantConfig runs and should speak greeting_message', caller_hears: '(greeting_message via builder)' };
}

router.get('/debug-number/coastal', async (req, res) => {
  const out = {
    generatedAt: new Date().toISOString(),
    target: TARGET_E164,
    clientId: CLIENT_ID,
    backendUrlEnv: process.env.BACKEND_URL || null,
    hasVapiKey: Boolean(process.env.VAPI_API_KEY),
  };

  // 1. Client row (both id columns, greeting, and every gate input)
  try {
    const { data, error } = await supabase
      .from('clients')
      .select('id, business_name, agency_id, industry, subscription_status, status, trial_ends_at, plan_type, monthly_call_limit, calls_this_month, hipaa_mode, timezone, voice_id, greeting_message, vapi_phone_number, vapi_phone_id, vapi_phone_number_id, vapi_assistant_id, vapi_query_tool_id, tool_config, provisioning_method, created_at, updated_at')
      .eq('id', CLIENT_ID)
      .single();
    if (error) {
      out.clientRow = { error: error.message };
    } else {
      out.clientRow = data;
      out.greetingSavedChars = data.greeting_message ? data.greeting_message.length : 0;
    }
  } catch (err) {
    out.clientRow = { error: err.message };
  }

  // 2. Agency row (true status/trial, independent of the join)
  const agencyId = (out.clientRow && out.clientRow.agency_id) || null;
  if (agencyId) {
    try {
      const { data, error } = await supabase
        .from('agencies')
        .select('id, name, slug, subscription_status, status, trial_ends_at, plan_type')
        .eq('id', agencyId)
        .single();
      out.agencyRow = error ? { error: error.message } : data;
    } catch (err) {
      out.agencyRow = { error: err.message };
    }
  } else {
    out.agencyRow = { note: 'No agency_id on client row' };
  }

  // 3. Live lookup via the exact function the webhook uses, so we see whether
  //    the agency is embedded (client.agencies) the way the handler expects.
  let liveClient = null;
  try {
    liveClient = await getClientByVapiPhoneNumber(TARGET_E164);
    if (!liveClient) {
      out.liveLookup = { found: false, note: 'getClientByVapiPhoneNumber returned null for this E164' };
    } else {
      const embeddedAgency = liveClient.agencies || null;
      out.liveLookup = {
        found: true,
        matchedClientId: liveClient.id,
        matchedBusinessName: liveClient.business_name,
        matchesTargetClient: liveClient.id === CLIENT_ID,
        greetingCharsSeenByHandler: liveClient.greeting_message ? liveClient.greeting_message.length : 0,
        embedsAgency: Boolean(embeddedAgency),
        embeddedAgencySubStatus: embeddedAgency ? (embeddedAgency.subscription_status ?? null) : null,
      };
      out._embeddedAgency = embeddedAgency; // used by gate eval below
    }
  } catch (err) {
    out.liveLookup = { error: err.message };
  }

  // 4. Gate evaluation, using the agency object AS THE HANDLER SEES IT.
  if (liveClient && liveClient.id) {
    out.gateEvaluation = evaluateGates(liveClient, out._embeddedAgency || null);
  } else if (out.clientRow && !out.clientRow.error) {
    // Fall back to the raw rows if the live lookup did not return an object.
    out.gateEvaluation = evaluateGates(out.clientRow, out.agencyRow && !out.agencyRow.error ? out.agencyRow : null);
    out.gateEvaluation.note = 'evaluated on raw rows (live lookup did not return a client)';
  }
  delete out._embeddedAgency;

  // 5. VAPI number matched by E164 from the full account list (ground truth)
  const listRes = await vapiGet('/phone-number?limit=1000');
  if (Array.isArray(listRes.body)) {
    out.vapiListCount = listRes.body.length;
    const match = listRes.body.find((n) => n && n.number === TARGET_E164);
    if (match) {
      out.vapiNumberByE164 = {
        id: match.id ?? null,
        number: match.number ?? null,
        provider: match.provider ?? null,
        assistantId: match.assistantId ?? null,
        squadId: match.squadId ?? null,
        serverUrl: match.serverUrl ?? null,
        server: match.server ?? null,
        credentialId: match.credentialId ?? null,
        name: match.name ?? null,
        status: match.status ?? null,
      };
      out.rawVapiNumber = match;
    } else {
      out.vapiNumberByE164 = { note: 'No VAPI number on this account matches the E164 string' };
    }
  } else {
    out.vapiNumberByE164 = { error: 'Unexpected /phone-number response', status: listRes.status, body: listRes.body };
  }

  // 6. Cross-check: fetch by whatever id the DB stores (either column)
  const dbId = (out.clientRow && (out.clientRow.vapi_phone_id || out.clientRow.vapi_phone_number_id)) || null;
  if (dbId) {
    const byId = await vapiGet(`/phone-number/${dbId}`);
    out.vapiNumberByDbId = byId.ok
      ? { usedId: dbId, id: byId.body.id ?? null, number: byId.body.number ?? null, assistantId: byId.body.assistantId ?? null, serverUrl: byId.body.serverUrl ?? null, server: byId.body.server ?? null }
      : { error: `GET /phone-number/${dbId} failed`, status: byId.status, body: byId.body };
  } else {
    out.vapiNumberByDbId = { note: 'DB has no vapi_phone_id or vapi_phone_number_id to cross-check' };
  }

  // 7. Static assistant firstMessage (frozen greeting callers hear now)
  const staticAssistantId = (out.clientRow && out.clientRow.vapi_assistant_id) || null;
  if (staticAssistantId) {
    const a = await vapiGet(`/assistant/${staticAssistantId}`);
    if (a.ok && a.body) {
      out.staticAssistant = {
        id: a.body.id ?? null,
        firstMessage: a.body.firstMessage ?? null,
        firstMessageMode: a.body.firstMessageMode ?? null,
        modelProvider: a.body.model ? (a.body.model.provider ?? null) : null,
        modelName: a.body.model ? (a.body.model.model ?? null) : null,
        serverUrl: a.body.serverUrl ?? null,
        serverMessages: a.body.serverMessages ?? null,
      };
    } else {
      out.staticAssistant = { error: `GET /assistant/${staticAssistantId} failed`, status: a.status, body: a.body };
    }
  } else {
    out.staticAssistant = { note: 'No vapi_assistant_id on the client row' };
  }

  // 8. Recent calls (two near-certain columns only, to avoid schema guessing)
  try {
    const { data: calls, error } = await supabase
      .from('calls')
      .select('id, created_at')
      .eq('client_id', CLIENT_ID)
      .order('created_at', { ascending: false })
      .limit(5);
    out.recentCalls = error ? { error: error.message } : (calls || []);
  } catch (err) {
    out.recentCalls = { error: err.message };
  }

  res.json(out);
});

module.exports = router;
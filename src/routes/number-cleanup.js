// ============================================================================
// NUMBER CLEANUP - stop paying for numbers that belong to dead clients
// ----------------------------------------------------------------------------
// Three tools, all reachable as cron routes and all DRY-RUN by default (they
// only act when called with ?apply=true, so nothing is ever deleted by
// accident):
//
//   releaseClientEverywhere(client)   - the canonical teardown. Releases a
//       client's number from EVERY billable system: the VAPI phone object, the
//       platform Telnyx rental (with retry to beat the "number is still being
//       provisioned and cannot yet be deleted" race that leaked a line during a
//       failed add), the agency's OWN Twilio for BYOT clients, plus the VAPI
//       assistant and query tool. Never throws; returns a per-system summary
//       and flags anything it could not confirm-release as stillLeaking.
//
//   backfillDeadClientNumbers()       - DB-driven sweep. Finds every client the
//       database knows is dead (terminal status, or an active row whose
//       subscription_status is an unambiguous death marker like trial_expired)
//       that is STILL holding a number or VAPI resource, releases it everywhere,
//       and nulls the telephony columns so it can never collide with a future
//       signup or be re-processed.
//
//   reconcileTelnyxAccount()          - carrier-truth sweep, the strongest
//       guarantee. Lists every number actually on the platform Telnyx account
//       (what you are actually being billed for), builds an allowlist of numbers
//       owned by LIVE clients, live agency demos, and platform numbers, and
//       deletes every Telnyx number not on that allowlist. This catches orphans
//       that have no DB row at all (for example a number left behind by a failed
//       add whose delete lost the provisioning race). It ABORTS rather than
//       delete anything if the allowlist cannot be built or comes back empty, so
//       an incomplete query can never nuke live numbers.
//
// BYOT numbers live on each agency's own Twilio, never on the platform Telnyx
// account, so reconcileTelnyxAccount only ever sees platform-provisioned US
// numbers, demos, and platform numbers. It cannot touch a BYOT line.
//
// Destination: src/routes/number-cleanup.js
// Mount in server.js:  app.use('/api/cron', require('./routes/number-cleanup'));
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { fullyReleaseNumber, releaseTelnyxNumber } = require('../lib/vapi');
const { releaseBYOTNumber } = require('./byot');
const { updateClientBillingQuantity } = require('../lib/usage-tracker');

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;

// A client is DEAD (its number should be released) when its own status is
// terminal. status is the authority: a paying client is never terminal-status.
const DEAD_STATUS = ['expired', 'cancelled', 'canceled'];

// subscription_status values that mean "this client never paid / is gone".
// These mark the stale active/trial_expired zombies too. Once a client pays or
// upgrades, the webhook flips subscription_status to active/trial, so a row
// still carrying one of these has not paid and is safe to reclaim.
const DEAD_SUB_STATUS = ['trial_expired', 'expired', 'agency_canceled', 'canceled', 'cancelled'];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Normalize any stored number to E.164 so DB values, Telnyx values, and env
// values compare as equal. Returns null for empty input.
function normalizeE164(v) {
  if (!v) return null;
  let s = String(v).trim();
  if (!s) return null;
  if (!s.startsWith('+')) {
    const d = s.replace(/\D/g, '');
    if (d.length === 10) s = `+1${d}`;
    else if (d.length === 11 && d.startsWith('1')) s = `+${d}`;
    else s = `+${d}`;
  }
  return s;
}

// Delete a VAPI object (assistant | tool | phone-number). Tolerates 404 (already
// gone) and never throws.
async function deleteVapiResource(kind, id) {
  if (!id || !VAPI_API_KEY) return true;
  try {
    const res = await fetch(`https://api.vapi.ai/${kind}/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${VAPI_API_KEY}` },
    });
    return res.ok || res.status === 404;
  } catch (e) {
    console.warn(`VAPI ${kind} delete failed for ${id}: ${e.message}`);
    return false;
  }
}

async function loadAgency(agencyId) {
  if (!agencyId) return null;
  const { data } = await supabase
    .from('agencies')
    .select('id, name, twilio_account_sid, twilio_api_key_encrypted, twilio_api_secret_encrypted')
    .eq('id', agencyId)
    .single();
  return data || null;
}

// ============================================================================
// CANONICAL TEARDOWN
// ----------------------------------------------------------------------------
// Release ONE client's number from every billable system, plus its VAPI
// assistant and query tool. Does NOT write to the DB, the caller decides
// whether/how to null columns (backfill nulls them; a future cancel path may
// want the same). Retries the Telnyx release for platform numbers to beat the
// "still being provisioned" race. Returns a summary and never throws.
// ============================================================================
async function releaseClientEverywhere(client, { agency = null, retries = 4, retryDelayMs = 3000 } = {}) {
  const e164 = normalizeE164(client.vapi_phone_number || client.phone_number);
  const vapiPhoneId = client.vapi_phone_id || client.vapi_phone_number_id || null;
  const method = (client.provisioning_method || 'platform').toLowerCase();
  const out = {
    id: client.id,
    business_name: client.business_name,
    e164,
    method,
    vapiDeleted: false,
    telnyxReleased: false,
    byotReleased: null,
    assistantDeleted: false,
    toolDeleted: false,
    stillLeaking: false,
  };

  // 1 + first Telnyx attempt: fullyReleaseNumber deletes the VAPI phone object
  // and takes one shot at the Telnyx rental.
  if (vapiPhoneId || e164) {
    try {
      const r = await fullyReleaseNumber(vapiPhoneId, e164);
      out.vapiDeleted = r.vapiDeleted;
      out.telnyxReleased = r.telnyxReleased;
    } catch (e) {
      console.error(`fullyReleaseNumber failed for ${client.business_name}: ${e.message}`);
    }
  }

  // 2. Retry the Telnyx release for platform numbers. This is the fix for the
  // race where a number was just provisioned and Telnyx refuses to delete it
  // ("still being provisioned and cannot yet be deleted"). Only platform
  // numbers live on Telnyx; BYOT is handled below.
  if (!out.telnyxReleased && e164 && method !== 'byot') {
    for (let i = 0; i < retries && !out.telnyxReleased; i++) {
      await sleep(retryDelayMs);
      out.telnyxReleased = await releaseTelnyxNumber(e164);
      if (out.telnyxReleased) console.log(`✅ Telnyx released on retry ${i + 1} for ${e164}`);
    }
  }

  // 3. BYOT: the number is on the agency's OWN Twilio, so release it there.
  if (method === 'byot' && e164) {
    const ag = agency || client.agencies || (await loadAgency(client.agency_id));
    if (ag && ag.twilio_account_sid && ag.twilio_api_key_encrypted) {
      try {
        out.byotReleased = await releaseBYOTNumber(ag, e164);
      } catch (e) {
        console.error(`BYOT release failed for ${e164}: ${e.message}`);
        out.byotReleased = false;
      }
    } else {
      out.byotReleased = false;
    }
  }

  // 4. VAPI assistant + query tool.
  out.assistantDeleted = await deleteVapiResource('assistant', client.vapi_assistant_id);
  out.toolDeleted = await deleteVapiResource('tool', client.vapi_query_tool_id);

  // Did the carrier release actually confirm? For BYOT the carrier is Twilio;
  // for everything else it is Telnyx. A number we could not confirm-release is
  // flagged so the caller (and the operator) can see what still needs the
  // reconcile sweep.
  const carrierOk = method === 'byot' ? out.byotReleased === true : (!e164 || out.telnyxReleased === true);
  out.stillLeaking = !!e164 && !carrierOk;
  return out;
}

// Null the telephony columns after a release so the dead row can never collide
// with a future signup (clients_phone_number_key) or be re-processed. Optionally
// promote a stale active zombie to status='expired' so it reads as retired.
async function nullClientTelephony(clientId, { markExpired = false } = {}) {
  const patch = {
    vapi_phone_id: null,
    vapi_phone_number: null,
    vapi_phone_number_id: null,
    phone_number: null,
    phone_area_code: null,
    vapi_assistant_id: null,
    vapi_query_tool_id: null,
    updated_at: new Date().toISOString(),
  };
  if (markExpired) patch.status = 'expired';
  await supabase.from('clients').update(patch).eq('id', clientId);
}

const CLIENT_SELECT =
  'id, business_name, agency_id, status, subscription_status, provisioning_method, ' +
  'phone_number, phone_area_code, vapi_phone_number, vapi_phone_id, vapi_phone_number_id, ' +
  'vapi_assistant_id, vapi_query_tool_id, ' +
  'agencies!clients_agency_id_fkey(id, name, twilio_account_sid, twilio_api_key_encrypted, twilio_api_secret_encrypted)';

function holdsSomething(c) {
  return !!(c.vapi_phone_number || c.phone_number || c.vapi_phone_id || c.vapi_phone_number_id || c.vapi_assistant_id || c.vapi_query_tool_id);
}

// ============================================================================
// BACKFILL: release every dead client still holding a number / VAPI resource.
// ============================================================================
async function backfillDeadClientNumbers({ dryRun = true } = {}) {
  // Bucket 1: terminal status (agency-cancelled, direct-cancelled, expired).
  const { data: terminal, error: e1 } = await supabase
    .from('clients')
    .select(CLIENT_SELECT)
    .in('status', DEAD_STATUS);
  if (e1) return { ok: false, error: `terminal query failed: ${e1.message}` };

  // Bucket 2: stale active zombies (status still 'active' but subscription_status
  // is an unambiguous death marker, e.g. trial_expired from an old sweep).
  const { data: zombies, error: e2 } = await supabase
    .from('clients')
    .select(CLIENT_SELECT)
    .eq('status', 'active')
    .in('subscription_status', DEAD_SUB_STATUS);
  if (e2) return { ok: false, error: `zombie query failed: ${e2.message}` };

  const byId = new Map();
  for (const c of [...(terminal || []), ...(zombies || [])]) byId.set(c.id, c);
  const targets = [...byId.values()].filter(holdsSomething);

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      count: targets.length,
      sample: targets.slice(0, 60).map((c) => ({
        id: c.id,
        business_name: c.business_name,
        status: c.status,
        subscription_status: c.subscription_status,
        method: c.provisioning_method,
        e164: normalizeE164(c.vapi_phone_number || c.phone_number),
        has_vapi_id: !!(c.vapi_phone_id || c.vapi_phone_number_id),
        has_assistant: !!c.vapi_assistant_id,
      })),
    };
  }

  const results = [];
  const agencyIds = new Set();
  for (const c of targets) {
    const rel = await releaseClientEverywhere(c, { agency: c.agencies });
    await nullClientTelephony(c.id, { markExpired: String(c.status).toLowerCase() === 'active' });
    if (c.agency_id) agencyIds.add(c.agency_id);
    results.push(rel);
  }

  // Refresh per-client billing quantity for each affected agency (best-effort).
  for (const aid of agencyIds) {
    try { await updateClientBillingQuantity(aid); } catch (e) { console.warn(`billing refresh failed for agency ${aid}: ${e.message}`); }
  }

  const stillLeaking = results.filter((r) => r.stillLeaking);
  return {
    ok: true,
    dryRun: false,
    processed: results.length,
    stillLeaking: stillLeaking.length,
    stillLeakingNumbers: stillLeaking.map((r) => r.e164),
    results,
  };
}

// ============================================================================
// TELNYX ACCOUNT RECONCILIATION
// ============================================================================

// Build the set of E.164 numbers that must NEVER be deleted: numbers owned by a
// live client, live agency demos, and platform numbers. Throws on query failure
// so the caller aborts rather than deleting against an incomplete allowlist.
async function buildLiveAllowlist() {
  const set = new Set();

  const { data: clients, error } = await supabase
    .from('clients')
    .select('vapi_phone_number, phone_number, status, subscription_status');
  if (error) throw new Error(`allowlist client query failed: ${error.message}`);

  for (const c of clients || []) {
    const status = String(c.status || '').toLowerCase();
    const sub = String(c.subscription_status || '').toLowerCase();
    // A client is protected UNLESS it is dead. Dead = terminal status OR a
    // death-marker subscription_status (this is what leaves the trial_expired
    // zombies UNprotected so their numbers can be reclaimed).
    const dead = DEAD_STATUS.includes(status) || DEAD_SUB_STATUS.includes(sub);
    if (dead) continue;
    const a = normalizeE164(c.vapi_phone_number);
    const b = normalizeE164(c.phone_number);
    if (a) set.add(a);
    if (b) set.add(b);
  }

  // Live agency demo lines.
  const { data: agencies, error: agErr } = await supabase.from('agencies').select('demo_phone_number');
  if (agErr) throw new Error(`allowlist agency query failed: ${agErr.message}`);
  for (const ag of agencies || []) {
    const d = normalizeE164(ag.demo_phone_number);
    if (d) set.add(d);
  }

  // Platform numbers and any extra safety allowlist from env
  // (NUMBER_CLEANUP_ALLOWLIST is a comma-separated list of E.164 numbers).
  const platform = [
    process.env.TELNYX_SMS_FROM_NUMBER,
    process.env.PLATFORM_OWNER_PHONE,
    ...(process.env.NUMBER_CLEANUP_ALLOWLIST || '').split(','),
  ];
  for (const p of platform) {
    const n = normalizeE164((p || '').trim());
    if (n) set.add(n);
  }

  return set;
}

// List every number on the platform Telnyx account, paginated. Throws on error.
async function listAllTelnyxNumbers() {
  const nums = [];
  let page = 1;
  for (;;) {
    const res = await fetch(
      `https://api.telnyx.com/v2/phone_numbers?page[number]=${page}&page[size]=100`,
      { headers: { Authorization: `Bearer ${TELNYX_API_KEY}` } }
    );
    if (!res.ok) throw new Error(`Telnyx list failed on page ${page}: HTTP ${res.status}`);
    const body = await res.json();
    const data = body.data || [];
    for (const d of data) {
      const e164 = normalizeE164(d.phone_number);
      if (e164) nums.push({ id: d.id, e164 });
    }
    const totalPages = body.meta && body.meta.total_pages ? body.meta.total_pages : 1;
    if (data.length === 0 || page >= totalPages) break;
    page++;
    if (page > 100) break; // hard safety cap
  }
  return nums;
}

async function reconcileTelnyxAccount({ dryRun = true } = {}) {
  if (!TELNYX_API_KEY) return { ok: false, error: 'TELNYX_API_KEY not set' };

  // Build the protect list FIRST. If this fails, abort and delete nothing.
  let allow;
  try {
    allow = await buildLiveAllowlist();
  } catch (e) {
    return { ok: false, error: `aborted, allowlist build failed: ${e.message}` };
  }
  if (allow.size === 0) {
    return { ok: false, error: 'aborted, allowlist came back empty (safety guard)' };
  }

  let all;
  try {
    all = await listAllTelnyxNumbers();
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const orphans = all.filter((n) => n.e164 && !allow.has(n.e164));

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      totalOnTelnyx: all.length,
      protected: all.length - orphans.length,
      orphanCount: orphans.length,
      orphans: orphans.map((o) => o.e164),
    };
  }

  const deleted = [];
  const failed = [];
  for (const o of orphans) {
    let ok = await releaseTelnyxNumber(o.e164);
    // Retry the provisioning race for freshly-bought orphans.
    for (let i = 0; i < 3 && !ok; i++) {
      await sleep(3000);
      ok = await releaseTelnyxNumber(o.e164);
    }
    if (ok) deleted.push(o.e164);
    else failed.push(o.e164);
  }

  return {
    ok: true,
    dryRun: false,
    totalOnTelnyx: all.length,
    deleted: deleted.length,
    deletedNumbers: deleted,
    failed: failed.length,
    failedNumbers: failed,
  };
}

// ============================================================================
// ROUTES  (mount under /api/cron)
// ----------------------------------------------------------------------------
// Both are DRY-RUN unless called with ?apply=true (or { "apply": true } body),
// so a plain call only ever reports what WOULD happen. Guarded by CRON_SECRET
// the same way the other cron routes are.
// ============================================================================
function cronGuard(req, res, next) {
  const secret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function wantsApply(req) {
  return req.query.apply === 'true' || req.body?.apply === true;
}

router.post('/backfill-dead-numbers', cronGuard, async (req, res) => {
  try {
    const result = await backfillDeadClientNumbers({ dryRun: !wantsApply(req) });
    res.json(result);
  } catch (e) {
    console.error('backfill-dead-numbers error:', e.message);
    res.status(500).json({ ok: false, error: 'Backfill failed' });
  }
});

router.post('/reconcile-telnyx', cronGuard, async (req, res) => {
  try {
    const result = await reconcileTelnyxAccount({ dryRun: !wantsApply(req) });
    res.json(result);
  } catch (e) {
    console.error('reconcile-telnyx error:', e.message);
    res.status(500).json({ ok: false, error: 'Reconcile failed' });
  }
});

module.exports = router;
module.exports.releaseClientEverywhere = releaseClientEverywhere;
module.exports.nullClientTelephony = nullClientTelephony;
module.exports.backfillDeadClientNumbers = backfillDeadClientNumbers;
module.exports.reconcileTelnyxAccount = reconcileTelnyxAccount;
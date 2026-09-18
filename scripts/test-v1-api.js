#!/usr/bin/env node
/**
 * scripts/test-v1-api.js
 * ---------------------------------------------------------------------------
 * End-to-end smoke test for the agency API (/api/v1) and outbound webhooks.
 * Proves: your API keys authenticate, every read endpoint responds, and a
 * webhook can be created, pinged, and actually delivered.
 *
 * It is SAFE: read-only except for creating one throwaway webhook (free) which
 * it deletes at the end. It never calls POST /clients (that provisions a real,
 * paid phone number).
 *
 * SETUP:
 *   1. In your agency dashboard -> Settings -> API, create an API key.
 *      Use a read_write key to also test the webhook write flow.
 *   2. (Optional but recommended) get a free receiver URL at https://webhook.site
 *      so you can watch the test event land and inspect the signature.
 *
 * RUN:
 *   V1_API_KEY=sk_... \
 *   V1_BASE_URL=https://api.myvoiceaiconnect.com/api/v1 \
 *   WEBHOOK_RECEIVER_URL=https://webhook.site/xxxx \
 *   node scripts/test-v1-api.js
 *
 *   (V1_BASE_URL can be omitted if BACKEND_URL is set; WEBHOOK_RECEIVER_URL can
 *    be omitted to skip the live-delivery test.)
 * ---------------------------------------------------------------------------
 */
// Load the backend .env so BACKEND_URL and other vars come from there when run
// from the backend folder (harmless if dotenv isn't installed / on the server).
try { require('dotenv').config(); } catch (e) {}

const API_KEY = process.env.V1_API_KEY;
const BASE = (process.env.V1_BASE_URL
  || (process.env.BACKEND_URL ? process.env.BACKEND_URL.replace(/\/+$/, '') + '/api/v1' : '')
).replace(/\/+$/, '');
const RECEIVER = process.env.WEBHOOK_RECEIVER_URL || null;

if (!API_KEY) { console.error('\n❌ V1_API_KEY not set.\n'); process.exit(1); }
if (!BASE) { console.error('\n❌ V1_BASE_URL (or BACKEND_URL) not set.\n'); process.exit(1); }

let passed = 0, failed = 0;
const results = [];
function ok(name, detail){ passed++; results.push(`  ✅ ${name}${detail ? '  ('+detail+')' : ''}`); }
function no(name, detail){ failed++; results.push(`  ❌ ${name}${detail ? '  ('+detail+')' : ''}`); }

async function call(method, path, { key = API_KEY, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Authorization': `Bearer ${key}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch (e) {}
  return { status: res.status, json };
}

async function expect(name, method, path, wantStatus, check) {
  try {
    const r = await call(method, path);
    if (r.status !== wantStatus) return no(name, `HTTP ${r.status}, wanted ${wantStatus}`);
    if (check) { const msg = check(r.json); if (msg) return no(name, msg); }
    ok(name, `HTTP ${r.status}`);
    return r;
  } catch (e) { no(name, e.message); }
}

(async () => {
  console.log(`\n🔎 Testing ${BASE}\n`);

  // ── AUTH (the core "do API keys work" checks) ──────────────────────────
  const acct = await expect('API key authenticates (GET /account)', 'GET', '/account', 200,
    (j) => (j && j.id) ? null : 'no agency id in response');
  const scope = acct?.json?.api?.scope || 'unknown';
  console.log(`  ↪ key belongs to: ${acct?.json?.name || '?'}  (scope: ${scope}, plan: ${acct?.json?.plan_type || '?'})\n`);

  try {
    const bad = await call('GET', '/account', { key: 'sk_definitely_invalid_key' });
    if (bad.status === 401) ok('Bad key is rejected (401)'); else no('Bad key is rejected', `got HTTP ${bad.status}, wanted 401`);
  } catch (e) { no('Bad key is rejected', e.message); }

  // ── READ ENDPOINTS ─────────────────────────────────────────────────────
  await expect('GET /events', 'GET', '/events', 200, (j) => Array.isArray(j?.data) ? null : 'no data array');
  await expect('GET /clients', 'GET', '/clients?limit=1', 200, (j) => Array.isArray(j?.data) ? null : 'no data array');
  await expect('GET /calls', 'GET', '/calls?limit=1', 200, (j) => Array.isArray(j?.data) ? null : 'no data array');
  await expect('GET /numbers', 'GET', '/numbers', 200, (j) => Array.isArray(j?.data) ? null : 'no data array');
  await expect('GET /usage', 'GET', '/usage', 200, (j) => (typeof j?.total_minutes === 'number') ? null : 'no total_minutes');
  await expect('GET /analytics/calls', 'GET', '/analytics/calls', 200, (j) => (typeof j?.total_calls === 'number') ? null : 'no total_calls');
  await expect('GET /appointments', 'GET', '/appointments?limit=1', 200, (j) => Array.isArray(j?.data) ? null : 'no data array');
  await expect('GET /webhooks (list)', 'GET', '/webhooks', 200, (j) => Array.isArray(j?.data) ? null : 'no data array');

  // ── WEBHOOK LIFECYCLE (needs read_write scope + a receiver URL) ─────────
  if (scope !== 'read_write') {
    results.push('  ⚠️  Webhook write tests skipped: this key is not read_write. Make a read_write key to test them.');
  } else if (!RECEIVER) {
    results.push('  ⚠️  Webhook delivery test skipped: set WEBHOOK_RECEIVER_URL (e.g. a webhook.site URL) to run it.');
  } else {
    let hookId = null, secret = null;
    // create
    try {
      const c = await call('POST', '/webhooks', { body: { url: RECEIVER, events: ['*'], description: 'test-v1-api harness' } });
      if (c.status === 201 && c.json?.id) { hookId = c.json.id; secret = c.json.secret; ok('POST /webhooks (create)', 'HTTP 201'); }
      else no('POST /webhooks (create)', `HTTP ${c.status} ${JSON.stringify(c.json).slice(0,120)}`);
    } catch (e) { no('POST /webhooks (create)', e.message); }

    if (hookId) {
      // ping
      try {
        const p = await call('POST', `/webhooks/${hookId}/ping`, { body: {} });
        if (p.status === 200 && p.json?.ok) ok('POST /webhooks/:id/ping (delivered)', 'receiver returned 2xx');
        else no('POST /webhooks/:id/ping', `HTTP ${p.status}, ok=${p.json?.ok}. Receiver may not have returned 2xx.`);
      } catch (e) { no('POST /webhooks/:id/ping', e.message); }

      // confirm the delivery was logged as success (poll briefly)
      let delivered = false;
      for (let i = 0; i < 4 && !delivered; i++) {
        await new Promise(r => setTimeout(r, 1200));
        const d = await call('GET', `/webhooks/${hookId}/deliveries?limit=5`);
        const latest = (d.json?.data || [])[0];
        if (latest && latest.status === 'success') delivered = true;
      }
      if (delivered) ok('Delivery logged as success (GET /webhooks/:id/deliveries)');
      else no('Delivery logged as success', 'no success delivery row found, check the receiver got the POST');

      console.log(`\n  ↪ test webhook secret (verify the X-VoiceAI-Signature header at your receiver):\n     ${secret}\n     signature = HMAC_SHA256(secret, "<t>.<raw-body>"), header "X-VoiceAI-Signature: t=<t>,v1=<hmac>"\n`);

      // cleanup
      try {
        const del = await call('DELETE', `/webhooks/${hookId}`);
        if (del.status === 200 && del.json?.deleted) ok('DELETE /webhooks/:id (cleanup)');
        else no('DELETE /webhooks/:id (cleanup)', `HTTP ${del.status}`);
      } catch (e) { no('DELETE /webhooks/:id (cleanup)', e.message); }
    }
  }

  // ── SUMMARY ────────────────────────────────────────────────────────────
  console.log(results.join('\n'));
  console.log(`\n${failed === 0 ? '✅ ALL PASSED' : '❌ ' + failed + ' FAILED'}  (${passed} passed, ${failed} failed)\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('\n❌ Harness crashed:', e.message, '\n'); process.exit(1); });
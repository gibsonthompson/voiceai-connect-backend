#!/usr/bin/env node
/**
 * scripts/provision-concierge-number.js
 * ---------------------------------------------------------------------------
 * Buys a number in area code 404 (or one you pass) on Telnyx and imports it
 * into VAPI, using the SAME tested path your client numbers use
 * (lib/vapi.js -> provisionPhoneNumber), then points it at the concierge
 * webhook. No hand-rolled Telnyx/VAPI calls; it reuses your production code.
 *
 * ENV: loaded from the backend's own .env (dotenv), so TELNYX_API_KEY,
 * VAPI_API_KEY, BACKEND_URL, VAPI_WEBHOOK_SECRET, SUPABASE_*, the Telnyx
 * credential, etc. all come from there. Run it FROM THE BACKEND FOLDER so the
 * .env and node_modules resolve.
 *
 * USAGE (from the backend directory):
 *   node scripts/provision-concierge-number.js            # explains, buys nothing
 *   node scripts/provision-concierge-number.js --buy      # buys a 404 number + wires it up
 *   node scripts/provision-concierge-number.js 470 --buy  # different area code
 *
 * This BUYS a real number (a monthly rental), so it does nothing without --buy.
 * ---------------------------------------------------------------------------
 */

// Load the backend .env first, before requiring lib/vapi (its module-level
// consts read TELNYX_API_KEY / VAPI_API_KEY at require time). Harmless if dotenv
// isn't installed or you're on the server where env is already injected.
try { require('dotenv').config(); } catch (e) {}

const areaArg = process.argv.find((a) => /^\d{3}$/.test(a));
const AREA = areaArg || '404';
const BUY = process.argv.includes('--buy');
const BACKEND_URL = process.env.BACKEND_URL;

function die(m) { console.error('\n❌ ' + m + '\n'); process.exit(1); }

if (!process.env.TELNYX_API_KEY) die('TELNYX_API_KEY not set. Run this from the backend folder so its .env loads (or `npm i dotenv`).');
if (!process.env.VAPI_API_KEY) die('VAPI_API_KEY not set (same .env issue).');
if (!BACKEND_URL) die('BACKEND_URL not set. It should be in your backend .env; that is the value the concierge webhook URL is built from.');

// Reuse the production provisioning function (Telnyx buy + VAPI import + dynamic).
const { provisionPhoneNumber } = require('../lib/vapi');

// After provisionPhoneNumber pins the number to dynamic mode pointing at the
// normal /webhook/vapi, override the serverUrl to the CONCIERGE webhook.
async function pointAtConcierge(vapiPhoneId) {
  const res = await fetch(`https://api.vapi.ai/phone-number/${vapiPhoneId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      assistantId: null,
      serverUrl: `${BACKEND_URL}/webhook/vapi-concierge`,
      serverUrlSecret: process.env.VAPI_WEBHOOK_SECRET, // JSON.stringify drops it if unset
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Concierge webhook PATCH failed (HTTP ${res.status}): ${t.slice(0, 220)}`);
  }
}

(async () => {
  console.log(`\nConcierge number provisioning — area code ${AREA}`);
  console.log(`Concierge webhook: ${BACKEND_URL}/webhook/vapi-concierge`);
  console.log(`Secret: ${process.env.VAPI_WEBHOOK_SECRET ? 'will be set (VAPI_WEBHOOK_SECRET)' : 'not set yet (fine — fail-open until you turn auth on)'}\n`);

  if (!BUY) {
    console.log(`This will BUY a real Telnyx number in area code ${AREA} (a monthly rental),`);
    console.log('import it into VAPI (same path your client numbers use), and point it at the');
    console.log('concierge webhook. It buys nothing until you add --buy:\n');
    console.log(`  node scripts/provision-concierge-number.js ${AREA} --buy\n`);
    return;
  }

  console.log(`📞 Searching Telnyx for a ${AREA} number, ordering it, and importing to VAPI...`);
  const phone = await provisionPhoneNumber(AREA, {});
  if (!phone || !phone.id) die('Provisioning returned no VAPI phone id — check the log above.');
  console.log(`✅ Bought + imported: ${phone.number}  (VAPI id: ${phone.id})`);

  console.log('🔧 Pointing it at the concierge webhook...');
  await pointAtConcierge(phone.id);
  console.log('✅ Done. This number is now the VoiceAI Connect concierge / demo line.\n');
  console.log(`   Number: ${phone.number}`);
  console.log('   Put it on the marketing site as "call and talk to it", and call it now to confirm it answers.\n');
})().catch((e) => die(e.message));
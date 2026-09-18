#!/usr/bin/env node
// ============================================================================
// PROVISION THE PLATFORM CONCIERGE / DEMO NUMBER
// ----------------------------------------------------------------------------
// Buys a US number on Telnyx, imports it into VAPI, assigns it for two-way SMS,
// and points it at the concierge webhook so it answers with the SDR/demo AI.
//
// It reuses the app's OWN provisioning (lib/vapi.provisionPhoneNumber), so the
// Telnyx order, the VAPI import, the messaging-profile + 10DLC assignment, and
// the credential lookup are all done exactly the way live client numbers are.
// The only extra step is re-pointing the number's serverUrl from the default
// client webhook (/webhook/vapi) to the concierge webhook (/webhook/vapi-concierge).
//
// WHERE TO RUN IT
//   In the backend's own environment so every secret is already present and you
//   don't have to pass any envs. On DigitalOcean App Platform: open the backend
//   component's Console and run it from the app root:
//
//     node scripts/provision-platform-number.js 404 --confirm
//
//   (Add it to the repo under scripts/, push so it deploys, then run in Console.)
//
// USAGE
//   node scripts/provision-platform-number.js <areaCode> [--confirm] [options]
//
//   <areaCode>          3-digit US area code to search (e.g. 404, 678, 212)
//   --confirm           actually buy. Without it this is a DRY RUN that only
//                       prints what it would do and buys nothing.
//   --webhook=<path>    VAPI serverUrl path to point the number at.
//                       default: /webhook/vapi-concierge
//   --label=<name>      label used only in the printed summary. default: concierge
//
// It buys ONE number and prints the E.164 number plus the exact next steps.
// A real Telnyx purchase costs about $1/mo + usage, hence the --confirm gate.
// ============================================================================

require('dotenv').config();

const path = require('path');
const fetch = global.fetch || require('node-fetch');

// Reuse the app's provisioning. This script is expected to live in scripts/ at
// the repo root, so lib is one level up under src/.
let vapi;
try {
  vapi = require(path.join(__dirname, '..', 'src', 'lib', 'vapi'));
} catch (e) {
  console.error('Could not load src/lib/vapi.js from this script location.');
  console.error('Place this file at <repo-root>/scripts/provision-platform-number.js and run it from the repo root.');
  console.error('Loader error:', e.message);
  process.exit(1);
}

const args = process.argv.slice(2);
const areaCode = (args.find((a) => /^\d{3}$/.test(a)) || '').trim();
const confirm = args.includes('--confirm');
const getOpt = (k, d) => {
  const p = args.find((a) => a.startsWith(`--${k}=`));
  return p ? p.slice(k.length + 3) : d;
};
const webhookPath = getOpt('webhook', '/webhook/vapi-concierge');
const label = getOpt('label', 'concierge');

const BACKEND_URL = process.env.BACKEND_URL;
const VAPI_API_KEY = process.env.VAPI_API_KEY;

function requireEnv(name) {
  if (!process.env[name]) {
    console.error(`\nMissing env ${name}.`);
    console.error('Run this in the backend environment (DigitalOcean App Platform Console), where all secrets are already set.');
    process.exit(1);
  }
}

(async () => {
  if (!areaCode) {
    console.error('Usage: node scripts/provision-platform-number.js <areaCode> --confirm [--webhook=/webhook/vapi-concierge] [--label=concierge]');
    process.exit(1);
  }

  // These must exist for provisioning to work at all (same set the live client
  // provisioning depends on). We fail fast with a clear message if any is missing.
  ['TELNYX_API_KEY', 'VAPI_API_KEY', 'BACKEND_URL'].forEach(requireEnv);

  const target = `${BACKEND_URL.replace(/\/+$/, '')}${webhookPath}`;

  console.log('\nPlatform number provisioning');
  console.log(`  area code   : ${areaCode}`);
  console.log(`  label       : ${label}`);
  console.log(`  point at    : ${target}`);
  console.log('  buy + VAPI import + SMS assignment: handled by lib/vapi.provisionPhoneNumber');
  console.log('  (needs a Telnyx credential added in the VAPI dashboard, and');
  console.log('   TELNYX_MESSAGING_PROFILE_ID set for two-way SMS)\n');

  if (!confirm) {
    console.log('DRY RUN — nothing was purchased. Re-run with --confirm to actually buy the number.\n');
    process.exit(0);
  }

  // ── 1) Buy on Telnyx + import to VAPI + assign SMS (+ default dynamic pin) ──
  let phone;
  try {
    phone = await vapi.provisionPhoneNumber(areaCode);
  } catch (e) {
    console.error(`\n❌ Provisioning failed: ${e.message}`);
    if (/credential/i.test(e.message)) {
      console.error('   Add your Telnyx API key as a provider credential in the VAPI dashboard (Provider Keys), then retry.');
    }
    process.exit(1);
  }

  if (!phone || !phone.id || !phone.number) {
    console.error('\n❌ Provisioning returned no VAPI phone id/number:', JSON.stringify(phone));
    console.error('   The number may have been purchased on Telnyx but not imported to VAPI. Check the Telnyx and VAPI dashboards before retrying.');
    process.exit(1);
  }
  console.log(`\n✅ Bought + imported: ${phone.number}  (VAPI phone id ${phone.id})`);

  // ── 2) Re-point the number at the concierge webhook ────────────────────────
  // provisionPhoneNumber pins new numbers to /webhook/vapi (the client
  // receptionist handler). The concierge line answers from its OWN webhook, so
  // override serverUrl. assistantId stays null (dynamic assistant-request).
  try {
    const patch = await fetch(`https://api.vapi.ai/phone-number/${phone.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${VAPI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assistantId: null,
        serverUrl: target,
        serverUrlSecret: process.env.VAPI_WEBHOOK_SECRET || undefined,
      }),
    });
    if (!patch.ok) {
      const t = await patch.text().catch(() => '');
      console.error(`\n⚠️  Bought ${phone.number} but could NOT point it at ${target} (HTTP ${patch.status}): ${t.slice(0, 200)}`);
      console.error(`    Fix manually in VAPI: set this number's serverUrl to ${target} and assistantId to null.`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`\n⚠️  Bought ${phone.number} but re-pointing threw: ${e.message}`);
    console.error(`    Fix manually in VAPI: set this number's serverUrl to ${target} and assistantId to null.`);
    process.exit(1);
  }
  console.log(`✅ Pointed ${phone.number} at ${target}`);

  // ── 3) Next steps ──────────────────────────────────────────────────────────
  console.log('\nDone. Your concierge / demo line is: ' + phone.number);
  console.log('\nNext:');
  console.log('  1. Put this number on the marketing site as the "call and talk to it" line.');
  console.log('  2. Make sure the transfer-destination env vars are set so the demo transfer works:');
  console.log('       DEMO_HOMESERVICES_NUMBER = +1XXXXXXXXXX   (home-services receptionist demo)');
  console.log('       DEMO_AGENCY_NUMBER       = +1XXXXXXXXXX   (agency demo line)');
  console.log('     (The concierge number itself needs NO env var — it is identified by being');
  console.log('      pointed at the concierge webhook.)');
  console.log('  3. Confirm the platform_demo_calls table exists (call logging + admin panel).');
  console.log('  4. Redeploy if you changed any env vars.\n');
  process.exit(0);
})();
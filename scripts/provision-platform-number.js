#!/usr/bin/env node
// ============================================================================
// PROVISION THE PLATFORM CONCIERGE / DEMO NUMBER  (hardened)
// ----------------------------------------------------------------------------
// Buys a US number on Telnyx, imports it to VAPI, points it at the concierge
// webhook so it answers with the SDR/demo AI, verifies it took, and SAVES the
// number to platform_settings so it is never lost again.
//
// WHERE TO RUN
//   In the backend's own environment so every secret is already present.
//   DigitalOcean App Platform: open the backend component's Console, then:
//
//     node scripts/provision-platform-number.js 404 --confirm
//
// USAGE
//   node scripts/provision-platform-number.js <areaCode> [--confirm] [--force] [options]
//     <areaCode>       3-digit US area code (e.g. 404, 678, 212)
//     --confirm        actually buy. Without it this is a DRY RUN (buys nothing).
//     --force          buy a NEW number even if a concierge line already exists.
//     --webhook=<path> serverUrl path. default: /webhook/vapi-concierge
//     --label=<name>   summary label only. default: concierge
//
// EDGE CASES HANDLED
//   1. Idempotency: pre-flight scans VAPI for an existing concierge number. If
//      one exists it PRINTS it, saves it to platform_settings, and exits WITHOUT
//      buying (unless --force). This is also how you "find" the number later:
//      run it with no --confirm and it reports the existing line.
//   2. Missing secrets: requires TELNYX_API_KEY, VAPI_API_KEY, BACKEND_URL and
//      VAPI_WEBHOOK_SECRET (the webhook validates it). Warns if the SMS profile
//      is missing (voice still works; the trial-link text would not).
//   3. Orphaned paid number: if the Telnyx buy succeeds but VAPI import fails,
//      the number is surfaced with release guidance so you are not billed for a
//      ghost number.
//   4. Re-point failure: if pointing the number at the concierge webhook fails,
//      the exact manual fix (number + VAPI id + target) is printed.
//   5. Read-back verify: after re-pointing, it GETs the number and confirms the
//      serverUrl actually equals the concierge webhook before declaring success.
//   6. Persistence: on success (or when found) the number is written to
//      platform_settings.concierge_demo_number so the admin page and marketing
//      site can read it and you never dig through VAPI again.
// ============================================================================

require('dotenv').config();

const path = require('path');
const fetch = global.fetch || require('node-fetch');

let vapi;
try {
  vapi = require(path.join(__dirname, '..', 'src', 'lib', 'vapi'));
} catch (e) {
  console.error('Could not load src/lib/vapi.js. Place this at <repo-root>/scripts/ and run from the repo root.');
  console.error('Loader error:', e.message);
  process.exit(1);
}

const args = process.argv.slice(2);
const areaCode = (args.find((a) => /^\d{3}$/.test(a)) || '').trim();
const confirm = args.includes('--confirm');
const force = args.includes('--force');
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
    console.error(`\nMissing env ${name}. Run this in the backend environment (DigitalOcean Console), where all secrets are set.`);
    process.exit(1);
  }
}

function serverUrlOf(pn) {
  return (pn && ((pn.server && pn.server.url) || pn.serverUrl)) || '';
}

async function listVapiNumbers() {
  const res = await fetch('https://api.vapi.ai/phone-number?limit=1000', {
    headers: { Authorization: `Bearer ${VAPI_API_KEY}` },
  });
  if (!res.ok) {
    throw new Error(`VAPI list failed (HTTP ${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }
  const body = await res.json();
  return Array.isArray(body) ? body : (body.results || body.data || []);
}

// Best-effort persistence. Never fatal: a saved number is a convenience, the
// printed number is the source of truth.
async function saveConciergeNumber(number) {
  try {
    const mod = require(path.join(__dirname, '..', 'src', 'lib', 'supabase'));
    const supabase = mod.supabase || mod.default || mod;
    if (!supabase || !supabase.from) throw new Error('supabase client not found');
    const { error } = await supabase
      .from('platform_settings')
      .upsert({ key: 'concierge_demo_number', value: number }, { onConflict: 'key' });
    if (error) throw new Error(error.message);
    console.log(`💾 Saved to platform_settings.concierge_demo_number = ${number}`);
  } catch (e) {
    console.warn(`⚠️  Could not save to platform_settings (${e.message}). The number above is still valid.`);
  }
}

(async () => {
  if (!areaCode) {
    console.error('Usage: node scripts/provision-platform-number.js <areaCode> --confirm [--force] [--webhook=/webhook/vapi-concierge]');
    process.exit(1);
  }

  ['TELNYX_API_KEY', 'VAPI_API_KEY', 'BACKEND_URL', 'VAPI_WEBHOOK_SECRET'].forEach(requireEnv);
  if (!process.env.TELNYX_MESSAGING_PROFILE_ID) {
    console.warn('⚠️  TELNYX_MESSAGING_PROFILE_ID is not set. Voice will work, but the concierge cannot text the trial link (two-way SMS off).');
  }

  const target = `${BACKEND_URL.replace(/\/+$/, '')}${webhookPath}`;

  console.log('\nPlatform concierge line provisioning');
  console.log(`  area code : ${areaCode}`);
  console.log(`  label     : ${label}`);
  console.log(`  point at  : ${target}`);

  // ── Pre-flight: is a concierge line already attached? (read-only) ──────────
  let existing = [];
  try {
    const nums = await listVapiNumbers();
    existing = nums.filter((pn) => serverUrlOf(pn).replace(/\/+$/, '') === target.replace(/\/+$/, ''));
  } catch (e) {
    console.warn(`⚠️  Could not pre-check existing VAPI numbers (${e.message}). Continuing.`);
  }

  if (existing.length && !force) {
    console.log(`\n✅ A concierge line already exists, no need to buy another:`);
    for (const pn of existing) console.log(`     ${pn.number}   (VAPI id ${pn.id})`);
    console.log(`\n   (Re-run with --force to buy an ADDITIONAL number anyway.)`);
    await saveConciergeNumber(existing[0].number);
    console.log(`\n   Put ${existing[0].number} on the marketing site as the call line.\n`);
    process.exit(0);
  }
  if (existing.length && force) {
    console.log(`\n⚠️  A concierge line already exists (${existing.map((p) => p.number).join(', ')}). --force set, buying another anyway.`);
  }

  if (!confirm) {
    console.log('\nDRY RUN, nothing was purchased. Re-run with --confirm to actually buy the number.\n');
    process.exit(0);
  }

  // ── 1) Buy on Telnyx + import to VAPI + assign SMS ────────────────────────
  let phone;
  try {
    phone = await vapi.provisionPhoneNumber(areaCode);
  } catch (e) {
    console.error(`\n❌ Provisioning failed: ${e.message}`);
    if (/purchased/i.test(e.message)) {
      console.error('   A Telnyx number may have been BOUGHT but not imported to VAPI. Find it in the Telnyx dashboard and release it so you are not billed, then retry.');
    }
    if (/credential/i.test(e.message)) {
      console.error('   Add your Telnyx API key as a provider credential in VAPI (Provider Keys), then retry.');
    }
    process.exit(1);
  }

  if (!phone || !phone.id || !phone.number) {
    console.error('\n❌ Provisioning returned no VAPI phone id/number:', JSON.stringify(phone));
    console.error('   The number may be on Telnyx but not in VAPI. Check both dashboards before retrying.');
    process.exit(1);
  }
  console.log(`\n✅ Bought + imported: ${phone.number}  (VAPI phone id ${phone.id})`);

  // ── 2) Re-point at the concierge webhook (dynamic assistant) ──────────────
  try {
    const patch = await fetch(`https://api.vapi.ai/phone-number/${phone.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${VAPI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assistantId: null,
        serverUrl: target,
        serverUrlSecret: process.env.VAPI_WEBHOOK_SECRET,
      }),
    });
    if (!patch.ok) {
      const t = await patch.text().catch(() => '');
      console.error(`\n⚠️  Bought ${phone.number} but could NOT point it at ${target} (HTTP ${patch.status}): ${t.slice(0, 200)}`);
      console.error(`    Fix in VAPI: set this number's serverUrl to ${target} and assistantId to null.`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`\n⚠️  Bought ${phone.number} but re-pointing threw: ${e.message}`);
    console.error(`    Fix in VAPI: set this number's serverUrl to ${target} and assistantId to null.`);
    process.exit(1);
  }

  // ── 3) Read-back verify the serverUrl actually took ───────────────────────
  try {
    const check = await fetch(`https://api.vapi.ai/phone-number/${phone.id}`, {
      headers: { Authorization: `Bearer ${VAPI_API_KEY}` },
    });
    const pn = check.ok ? await check.json() : null;
    const got = serverUrlOf(pn).replace(/\/+$/, '');
    if (got !== target.replace(/\/+$/, '')) {
      console.error(`\n⚠️  Re-point did not stick. VAPI reports serverUrl = "${got || '(none)'}", expected "${target}".`);
      console.error(`    Set it manually in VAPI before putting the number live.`);
      process.exit(1);
    }
    console.log(`✅ Verified ${phone.number} is pointed at ${target}`);
  } catch (e) {
    console.warn(`⚠️  Could not verify the serverUrl (${e.message}). Double-check it in VAPI.`);
  }

  // ── 4) Persist so it is findable ──────────────────────────────────────────
  await saveConciergeNumber(phone.number);

  // ── 5) Next steps ─────────────────────────────────────────────────────────
  console.log('\nDone. Your concierge / demo line is: ' + phone.number);
  console.log('\nNext:');
  console.log(`  1. Put ${phone.number} on the marketing site as the "call and talk to it" line.`);
  console.log('  2. Confirm the transfer targets are set so the demo transfer works:');
  console.log('       DEMO_HOMESERVICES_NUMBER = +1XXXXXXXXXX   (home-services receptionist demo)');
  console.log('       DEMO_AGENCY_NUMBER       = +1XXXXXXXXXX   (agency demo line)');
  console.log('  3. Confirm the platform_demo_calls table exists (call logging + admin panel).');
  console.log('  4. Redeploy if you changed any env vars.\n');
  process.exit(0);
})();
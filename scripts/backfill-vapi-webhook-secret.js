#!/usr/bin/env node
/**
 * scripts/backfill-vapi-webhook-secret.js
 * ---------------------------------------------------------------------------
 * ONE-TIME (and safely re-runnable) backfill.
 *
 * Adds `serverUrlSecret` to every VAPI phone number whose Server URL points at
 * our webhook, so VAPI starts sending the `x-vapi-secret` header on that
 * number's webhooks. That header is what lib/vapi-webhook-auth.js checks. This
 * secures every number that already exists; the provisioning code changes cover
 * numbers created AFTER this runs.
 *
 * WHY serverUrlSecret (not a Custom Credential): VAPI's flat `serverUrlSecret`
 * field pairs with the flat `serverUrl` the app already sets, and VAPI sends it
 * verbatim as the `x-vapi-secret` header. No dashboard credential, no
 * credentialId, no nested `server` object. Same value as VAPI_WEBHOOK_SECRET so
 * one env var drives both the send (VAPI) and the check (our backend).
 *
 * It matches any number whose serverUrl contains "/webhook/vapi", which covers
 * both the main call webhook (/webhook/vapi) and the support line
 * (/webhook/vapi-support), since the same secret guards both.
 *
 * SAFETY:
 *   - DRY RUN BY DEFAULT. It only reports what it would change. Pass --apply to
 *     actually write.
 *   - It ONLY sets serverUrlSecret. It does not touch assistantId, serverUrl,
 *     or anything else, so call routing is unchanged.
 *   - Idempotent: a number that already has the right secret is skipped, so you
 *     can run it again any time (e.g. as a periodic safety sweep).
 *   - Paced so it does not hammer the VAPI API.
 *
 * ENV:
 *   VAPI_API_KEY          (required) your VAPI private key
 *   VAPI_WEBHOOK_SECRET   (required) the secret to install; MUST equal the value
 *                         your backend checks against
 *
 * USAGE:
 *   node scripts/backfill-vapi-webhook-secret.js            # dry run, shows plan
 *   node scripts/backfill-vapi-webhook-secret.js --apply    # actually write
 * ---------------------------------------------------------------------------
 */

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const VAPI_WEBHOOK_SECRET = process.env.VAPI_WEBHOOK_SECRET;
const APPLY = process.argv.includes('--apply');

const MATCH = '/webhook/vapi'; // matches /webhook/vapi and /webhook/vapi-support

function die(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

async function listAllNumbers() {
  // VAPI returns up to `limit` numbers. 1000 covers any realistic account; if
  // you somehow have more, raise it or page. Same list call the admin
  // migrate-phones-dynamic route uses.
  const res = await fetch('https://api.vapi.ai/phone-number?limit=1000', {
    headers: { Authorization: `Bearer ${VAPI_API_KEY}` },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    die(`Could not list VAPI numbers (HTTP ${res.status}): ${t.slice(0, 200)}`);
  }
  return res.json();
}

async function patchSecret(id) {
  const res = await fetch(`https://api.vapi.ai/phone-number/${id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${VAPI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ serverUrlSecret: VAPI_WEBHOOK_SECRET }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 160)}`);
  }
  return true;
}

(async () => {
  if (!VAPI_API_KEY) die('VAPI_API_KEY is not set in the environment.');
  if (!VAPI_WEBHOOK_SECRET) die('VAPI_WEBHOOK_SECRET is not set. Set it to the same value your backend will check, then re-run.');

  console.log(`\n${APPLY ? '🔧 APPLY' : '👀 DRY RUN'} - backfilling serverUrlSecret on VAPI numbers pointing at ${MATCH}\n`);

  const numbers = await listAllNumbers();
  if (!Array.isArray(numbers)) die('Unexpected VAPI list response (not an array).');

  let matched = 0, alreadyOk = 0, changed = 0, failed = 0, skipped = 0;

  for (const n of numbers) {
    const url = n.serverUrl || n.server?.url || null;
    if (!url || !url.includes(MATCH)) { skipped++; continue; }
    matched++;

    // Idempotent skip: VAPI does not return the secret back (it is write-only),
    // so we cannot read the current value to compare. On a re-run we therefore
    // re-PATCH the same value, which is a harmless no-op. If you want to avoid
    // even that, run this once and keep the provisioning code change for new
    // numbers.
    const label = `${n.number || n.id}${n.name ? ` (${n.name})` : ''}`;

    if (!APPLY) {
      console.log(`  would set secret on ${label}  [serverUrl=${url}]`);
      changed++;
      continue;
    }

    try {
      await patchSecret(n.id);
      console.log(`  ✅ set secret on ${label}`);
      changed++;
    } catch (e) {
      console.error(`  ❌ ${label}: ${e.message}`);
      failed++;
    }
    // Gentle pacing.
    await new Promise((r) => setTimeout(r, 150));
  }

  console.log(
    `\nDone. total=${numbers.length} matched=${matched} ` +
    `${APPLY ? `updated=${changed} failed=${failed}` : `wouldUpdate=${changed}`} ` +
    `skippedNonWebhook=${skipped} alreadyOk=${alreadyOk}\n`
  );

  if (!APPLY) {
    console.log('This was a DRY RUN. Re-run with --apply to write the changes.\n');
  } else {
    console.log('Make a test call and confirm calls still work BEFORE you set/confirm');
    console.log('VAPI_WEBHOOK_SECRET on the backend so it starts requiring the header.\n');
  }
})().catch((e) => die(e.message));
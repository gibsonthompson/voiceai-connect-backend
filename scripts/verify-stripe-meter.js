#!/usr/bin/env node
/**
 * ============================================================================
 * verify-stripe-meter.js
 * VoiceAI Connect — Stripe Billing Meter sanity check
 * ============================================================================
 *
 * Verifies that the `voice_minutes` Billing Meter in your Stripe account
 * matches the payload shape your usage-tracker.js is sending. If it doesn't
 * match, your voice-minute usage is being silently dropped by Stripe (the
 * catch block in sendVoiceMinutesMeterEvent classes errors as non-fatal).
 *
 * Specifically checks:
 *   - Meter exists and is active
 *   - default_aggregation.formula     = 'sum'
 *   - customer_mapping.type            = 'by_id'
 *   - customer_mapping.event_payload_key = 'stripe_customer_id'
 *   - value_settings.event_payload_key   = 'value'
 *
 * Read-only. Never writes to Stripe.
 *
 * USAGE:
 *   STRIPE_SECRET_KEY=sk_test_xxx node verify-stripe-meter.js
 *   STRIPE_SECRET_KEY=sk_live_xxx node verify-stripe-meter.js
 *
 *   # Check a different event name (defaults to voice_minutes):
 *   EVENT_NAME=custom_event STRIPE_SECRET_KEY=sk_xxx node verify-stripe-meter.js
 * ============================================================================
 */

const Stripe = require('stripe');

const stripeKey = process.env.STRIPE_SECRET_KEY;
if (!stripeKey) {
  console.error('\n✗ STRIPE_SECRET_KEY env var is required.\n');
  process.exit(1);
}

const stripe = new Stripe(stripeKey);
const isLive = stripeKey.startsWith('sk_live_');
const eventName = process.env.EVENT_NAME || 'voice_minutes';

// ─── Expected config (what your usage-tracker.js sends) ───────────────────
// usage-tracker.js → sendVoiceMinutesMeterEvent calls:
//   stripe.billing.meterEvents.create({
//     event_name: 'voice_minutes',
//     payload: {
//       stripe_customer_id: agency.stripe_customer_id,   ← key 'stripe_customer_id'
//       value: String(minutes),                           ← key 'value'
//     },
//   });
//
// For Stripe to route those events correctly, the meter's mapping must agree:
//   customer_mapping.event_payload_key MUST equal 'stripe_customer_id'
//   value_settings.event_payload_key   MUST equal 'value'
//
// Aggregation 'sum' is correct because each meter event reports the
// incremental minutes for one call. Stripe sums them across the billing
// period to compute the invoice line.
const EXPECTED = {
  status: 'active',
  aggregation_formula: 'sum',
  customer_mapping_type: 'by_id',
  customer_payload_key: 'stripe_customer_id',
  value_payload_key: 'value',
};

// ─── Pretty logging ───────────────────────────────────────────────────────
const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};
function check(label, actual, expected) {
  const pass = actual === expected;
  const symbol = pass ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
  const actualStr = actual === undefined || actual === null ? '(missing)' : String(actual);
  if (pass) {
    console.log(`  ${symbol} ${label}: ${c.dim}${actualStr}${c.reset}`);
  } else {
    console.log(`  ${symbol} ${label}: ${c.red}${actualStr}${c.reset} ${c.dim}(expected: ${expected})${c.reset}`);
  }
  return pass;
}

async function main() {
  console.log('');
  console.log(`${c.bold}🎤 Stripe Meter Verification${c.reset}`);
  console.log(`   Mode:       ${isLive ? `${c.red}LIVE${c.reset}` : `${c.green}TEST${c.reset}`}`);
  console.log(`   Event name: ${c.cyan}${eventName}${c.reset}`);
  console.log('');

  // Page through meters and find by event_name. An account can have at most
  // one ACTIVE meter per event_name, but archived/inactive duplicates can
  // exist from prior failed setups — we surface those too.
  console.log(`${c.dim}Fetching meters from Stripe...${c.reset}`);
  let allMeters = [];
  let cursor = undefined;
  do {
    const page = await stripe.billing.meters.list({ limit: 100, starting_after: cursor });
    allMeters = allMeters.concat(page.data);
    if (!page.has_more) break;
    cursor = page.data[page.data.length - 1]?.id;
  } while (cursor);

  const matching = allMeters.filter((m) => m.event_name === eventName);

  if (matching.length === 0) {
    console.log('');
    console.log(`${c.red}${c.bold}✗ NO METER FOUND for event_name="${eventName}"${c.reset}`);
    console.log('');
    console.log(`${c.yellow}Implications:${c.reset}`);
    console.log(`  • Every voice-minute meter event your backend has sent has been failing.`);
    console.log(`  • sendVoiceMinutesMeterEvent in lib/usage-tracker.js swallows the error`);
    console.log(`    in a non-fatal catch, so you would not have seen it in logs unless`);
    console.log(`    alertError piped it to your SMS alert channel.`);
    console.log(`  • Your usage_records table has rows with reported_to_stripe=false that`);
    console.log(`    have never landed in Stripe and won't be billed at cycle close.`);
    console.log('');
    console.log(`${c.cyan}Fix:${c.reset} run the setup script — it creates the meter if missing:`);
    console.log(`  STRIPE_SECRET_KEY=${stripeKey.slice(0, 12)}... node setup-stripe-products.js`);
    console.log('');
    process.exit(1);
  }

  console.log(`${c.dim}Found ${matching.length} meter(s) with event_name="${eventName}".${c.reset}`);
  console.log('');

  const active = matching.filter((m) => m.status === 'active');
  if (active.length > 1) {
    console.log(`${c.yellow}⚠ More than one ACTIVE meter exists for this event_name.${c.reset}`);
    console.log(`${c.dim}  Stripe normally enforces uniqueness — investigate manually.${c.reset}`);
    console.log('');
  }

  // ─── Check each meter ──────────────────────────────────────────────────
  let anyPassedFully = false;

  for (const meter of matching) {
    console.log(`${c.bold}━━━ Meter ${meter.id} ━━━${c.reset}`);
    console.log(`  Display name: ${meter.display_name || '(unset)'}`);
    console.log('');

    const checks = [
      check('status', meter.status, EXPECTED.status),
      check('default_aggregation.formula', meter.default_aggregation?.formula, EXPECTED.aggregation_formula),
      check('customer_mapping.type', meter.customer_mapping?.type, EXPECTED.customer_mapping_type),
      check('customer_mapping.event_payload_key', meter.customer_mapping?.event_payload_key, EXPECTED.customer_payload_key),
      check('value_settings.event_payload_key', meter.value_settings?.event_payload_key, EXPECTED.value_payload_key),
    ];

    const allPassed = checks.every(Boolean);
    if (allPassed) {
      console.log('');
      console.log(`  ${c.green}${c.bold}✓ This meter matches the expected config.${c.reset}`);
      anyPassedFully = true;
    } else {
      console.log('');
      console.log(`  ${c.red}${c.bold}✗ This meter has mismatches.${c.reset}`);
    }
    console.log('');
  }

  if (anyPassedFully) {
    console.log(`${c.green}${c.bold}✓ Verification passed.${c.reset}`);
    console.log(`${c.dim}  setup-stripe-products.js will safely reuse this meter.${c.reset}`);
    console.log('');
    process.exit(0);
  } else {
    console.log(`${c.red}${c.bold}✗ Verification failed — no meter matches the expected config.${c.reset}`);
    console.log('');
    console.log(`${c.yellow}Options:${c.reset}`);
    console.log(`  1. Recreate the meter with the correct mapping. In Stripe, meters are`);
    console.log(`     mostly immutable after creation (only display_name is editable), so`);
    console.log(`     this means archiving the existing meter and creating a new one. Note`);
    console.log(`     event_name must be unique across active meters, so archive first.`);
    console.log('');
    console.log(`  2. Or adjust lib/usage-tracker.js → sendVoiceMinutesMeterEvent to send`);
    console.log(`     payload keys that match what the existing meter expects. This is`);
    console.log(`     easier but means your code drifts from the spec.`);
    console.log('');
    console.log(`${c.dim}  Recommended: option 1, then re-run setup-stripe-products.js${c.reset}`);
    console.log('');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('');
  console.error(`${c.red}✗ Script failed: ${e.message}${c.reset}`);
  if (e.raw) console.error(JSON.stringify(e.raw, null, 2));
  process.exit(1);
});

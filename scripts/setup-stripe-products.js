#!/usr/bin/env node
/**
 * ============================================================================
 * setup-stripe-products.js
 * VoiceAI Connect — Stripe Product/Price setup
 * ============================================================================
 *
 * Creates the optimal 3-Product Stripe architecture:
 *
 *   1. Platform Subscription
 *      - Pro Platform     ($99/mo recurring)
 *      - Scale Platform   ($499/mo recurring)
 *
 *   2. Per-Client Billing
 *      - Free Per-Client  ($29.99/client/mo recurring)
 *      - Pro Per-Client   ($9.99/client/mo recurring)
 *
 *   3. Voice Minutes
 *      - Free Voice Minutes  ($0.12/min metered)
 *      - Pro Voice Minutes   ($0.10/min metered)
 *      - Scale Voice Minutes ($0.05/min metered)
 *
 * Outputs Price IDs as env-var assignments ready to paste into your .env or
 * DigitalOcean App config, AND writes them to .env.stripe-new in the current
 * directory.
 *
 * SAFETY:
 *   - Idempotent. Safe to re-run. Detects existing Products by name and
 *     existing Prices by nickname; skips creation if found, reuses IDs.
 *   - Looks up your existing voice_minutes Meter (the one your code already
 *     reports usage to). Creates it only if missing.
 *   - Does NOT touch or archive any existing Products/Prices — your live
 *     subscriptions are untouched.
 *   - Uses --dry-run to print what would be created without writing anything.
 *   - When run against a sk_live_ key, pauses 5 seconds for Ctrl+C before
 *     making any writes.
 *
 * USAGE:
 *   STRIPE_SECRET_KEY=sk_test_xxx node setup-stripe-products.js --dry-run
 *   STRIPE_SECRET_KEY=sk_test_xxx node setup-stripe-products.js
 *   STRIPE_SECRET_KEY=sk_live_xxx node setup-stripe-products.js
 *
 *   Add `--help` for flag reference.
 *
 * PLACEMENT:
 *   Drop this file into your backend repo root or scripts/ folder. The `stripe`
 *   package is already a dep there (it's used by src/routes/stripe-platform.js).
 *   No new npm install needed.
 *
 * REQUIRES:
 *   - Node.js 18+ (for top-level async)
 *   - stripe SDK v14+ (you're already on a recent version — your code uses
 *     stripe.billing.meterEvents.create which is post-v14)
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const Stripe = require('stripe');

// ─── CLI args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage:
  STRIPE_SECRET_KEY=sk_xxx node setup-stripe-products.js [options]

Options:
  --dry-run   Print what would be created. No Stripe writes.
  --help      This message.

Examples:
  # Test mode dry-run (safe first step)
  STRIPE_SECRET_KEY=sk_test_xxx node setup-stripe-products.js --dry-run

  # Test mode for real
  STRIPE_SECRET_KEY=sk_test_xxx node setup-stripe-products.js

  # Live mode for real (5-sec confirmation pause built in)
  STRIPE_SECRET_KEY=sk_live_xxx node setup-stripe-products.js
`);
  process.exit(0);
}

const stripeKey = process.env.STRIPE_SECRET_KEY;
if (!stripeKey) {
  console.error('\n✗ STRIPE_SECRET_KEY env var is required.\n');
  console.error('  Run: STRIPE_SECRET_KEY=sk_xxx node setup-stripe-products.js\n');
  process.exit(1);
}

const stripe = new Stripe(stripeKey);
const isLive = stripeKey.startsWith('sk_live_');

// ─── Pretty logging ───────────────────────────────────────────────────────
const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
};
const ok      = (m) => console.log(`  ${c.green}✓${c.reset} ${m}`);
const warn    = (m) => console.log(`  ${c.yellow}⚠${c.reset} ${m}`);
const fail    = (m) => console.log(`  ${c.red}✗${c.reset} ${m}`);
const dim     = (m) => console.log(`  ${c.gray}${m}${c.reset}`);
const heading = (m) => console.log(`\n${c.bold}${c.cyan}━━━ ${m} ━━━${c.reset}`);

// ─── Spec: what we want to exist in Stripe ────────────────────────────────
// Money is in CENTS. Stripe stores unit_amount as an integer in the smallest
// currency unit (cents for USD).
const SPEC = [
  {
    productName: 'Platform Subscription',
    description: 'Your fully white-labeled AI receptionist agency workspace — branded marketing site, agency dashboard, client management, lead generation CRM, and Stripe Connect for direct client payouts.',
    prices: [
      { nickname: 'Pro Platform',   unit_amount: 9900,  envVar: 'STRIPE_PRICE_PRO_PLATFORM',   metered: false },
      { nickname: 'Scale Platform', unit_amount: 49900, envVar: 'STRIPE_PRICE_SCALE_PLATFORM', metered: false },
    ],
  },
  {
    productName: 'Per-Client Billing',
    description: "Monthly fee per active client business running on your platform. Quantity tracks your live client count — you're only billed for businesses you've actually onboarded.",
    prices: [
      { nickname: 'Free Per-Client', unit_amount: 2999, envVar: 'STRIPE_PRICE_FREE_CLIENT', metered: false },
      { nickname: 'Pro Per-Client',  unit_amount: 999,  envVar: 'STRIPE_PRICE_PRO_CLIENT',  metered: false },
    ],
  },
  {
    productName: 'Voice Minutes',
    description: 'Per-minute usage charge for AI voice call time across all your clients. Billed at each cycle close based on actual minutes consumed.',
    meterEventName: 'voice_minutes',
    prices: [
      { nickname: 'Free Voice Minutes',  unit_amount: 12, envVar: 'STRIPE_PRICE_FREE_MINUTE',  metered: true },
      { nickname: 'Pro Voice Minutes',   unit_amount: 10, envVar: 'STRIPE_PRICE_PRO_MINUTE',   metered: true },
      { nickname: 'Scale Voice Minutes', unit_amount: 5,  envVar: 'STRIPE_PRICE_SCALE_MINUTE', metered: true },
    ],
  },
];

// ─── Meter lookup / creation ──────────────────────────────────────────────
async function ensureMeter(eventName, displayName) {
  heading(`Voice usage meter (event_name=${eventName})`);

  // List active meters and match by event_name. Stripe's meters.list returns
  // newest-first with a 'status' field — we want the active one (an account
  // can have at most one active meter per event_name).
  let cursor = undefined;
  let found = null;
  do {
    const page = await stripe.billing.meters.list({ limit: 100, starting_after: cursor });
    for (const m of page.data) {
      if (m.event_name === eventName && m.status === 'active') {
        found = m;
        break;
      }
    }
    if (found || !page.has_more) break;
    cursor = page.data[page.data.length - 1]?.id;
  } while (cursor);

  if (found) {
    ok(`Reusing meter: ${found.id}`);
    dim(`status=${found.status} · aggregation=${found.default_aggregation?.formula} · customer_key=${found.customer_mapping?.event_payload_key} · value_key=${found.value_settings?.event_payload_key}`);
    return found;
  }

  warn(`No active meter found for event_name="${eventName}"`);

  if (dryRun) {
    dim('[dry-run] Would create meter:');
    dim(`  display_name="${displayName}"`);
    dim(`  event_name="${eventName}"`);
    dim('  aggregation=sum, customer_key=stripe_customer_id, value_key=value');
    return { id: `mtr_DRYRUN_${eventName}` };
  }

  const meter = await stripe.billing.meters.create({
    display_name: displayName,
    event_name: eventName,
    default_aggregation: { formula: 'sum' },
    customer_mapping: { type: 'by_id', event_payload_key: 'stripe_customer_id' },
    value_settings: { event_payload_key: 'value' },
  });
  ok(`Created meter: ${meter.id}`);
  return meter;
}

// ─── Product lookup / creation ────────────────────────────────────────────
async function ensureProduct(productSpec) {
  heading(`Product: ${productSpec.productName}`);

  // Page through active Products to find by exact name. Stripe doesn't filter
  // products.list by name, so we paginate. In practice you'll have < 100
  // products, but we paginate properly to be safe.
  let cursor = undefined;
  let existing = null;
  do {
    const page = await stripe.products.list({ limit: 100, active: true, starting_after: cursor });
    existing = page.data.find((p) => p.name === productSpec.productName);
    if (existing || !page.has_more) break;
    cursor = page.data[page.data.length - 1]?.id;
  } while (cursor);

  if (existing) {
    ok(`Reusing Product: ${existing.id}`);

    // Sync description if drifted. Stripe Checkout pulls this live, so keeping
    // it in sync ensures the spec wins on re-run.
    if (existing.description !== productSpec.description) {
      if (dryRun) {
        warn('Description differs from spec — would update.');
        dim(`  Stripe:    ${(existing.description || '(empty)').slice(0, 80)}...`);
        dim(`  Spec:      ${productSpec.description.slice(0, 80)}...`);
      } else {
        await stripe.products.update(existing.id, { description: productSpec.description });
        ok('Description updated to match spec');
      }
    }
    return existing;
  }

  if (dryRun) {
    dim('[dry-run] Would create Product:');
    dim(`  name="${productSpec.productName}"`);
    dim(`  description="${productSpec.description.slice(0, 80)}..."`);
    return { id: `prod_DRYRUN_${productSpec.productName.replace(/\s+/g, '_')}` };
  }

  const product = await stripe.products.create({
    name: productSpec.productName,
    description: productSpec.description,
  });
  ok(`Created Product: ${product.id}`);
  return product;
}

// ─── Price lookup / creation ──────────────────────────────────────────────
async function ensurePrice(product, priceSpec, meter) {
  // List Prices on this Product and match by nickname. Active filter avoids
  // matching against archived Prices from prior runs.
  let cursor = undefined;
  let existing = null;
  do {
    const page = await stripe.prices.list({
      product: product.id, limit: 100, active: true, starting_after: cursor,
    });
    existing = page.data.find((p) => p.nickname === priceSpec.nickname);
    if (existing || !page.has_more) break;
    cursor = page.data[page.data.length - 1]?.id;
  } while (cursor);

  if (existing) {
    if (existing.unit_amount !== priceSpec.unit_amount) {
      // Stripe Prices are immutable for amount. If amounts diverge, surface it
      // loudly — Gibson must decide whether to archive + recreate manually.
      warn(`Price "${priceSpec.nickname}" exists with amount=${existing.unit_amount}c, spec wants ${priceSpec.unit_amount}c. Stripe Prices are immutable — reusing existing.`);
    } else {
      ok(`Reusing Price: ${existing.id} (${priceSpec.nickname})`);
    }
    return existing;
  }

  if (dryRun) {
    dim(`[dry-run] Would create Price:`);
    dim(`  nickname="${priceSpec.nickname}"`);
    dim(`  unit_amount=${priceSpec.unit_amount} (${formatUsd(priceSpec.unit_amount)})`);
    dim(`  recurring=monthly, usage_type=${priceSpec.metered ? 'metered' : 'licensed'}${priceSpec.metered ? `, meter=${meter.id}` : ''}`);
    return { id: `price_DRYRUN_${priceSpec.envVar}` };
  }

  const recurring = { interval: 'month' };
  if (priceSpec.metered) {
    recurring.usage_type = 'metered';
    recurring.meter = meter.id;
  }
  // licensed (default) is implicit when usage_type is omitted

  const price = await stripe.prices.create({
    product: product.id,
    currency: 'usd',
    unit_amount: priceSpec.unit_amount,
    nickname: priceSpec.nickname,
    recurring,
    tax_behavior: 'exclusive',
  });
  ok(`Created Price: ${price.id} (${priceSpec.nickname})`);
  return price;
}

// ─── Format helper ────────────────────────────────────────────────────────
function formatUsd(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log(`${c.bold}🎤 VoiceAI Connect — Stripe Product Setup${c.reset}`);
  console.log(`   Mode:    ${isLive ? `${c.red}${c.bold}LIVE${c.reset}` : `${c.green}TEST${c.reset}`}`);
  console.log(`   Dry-run: ${dryRun ? `${c.yellow}YES (no writes)${c.reset}` : 'NO'}`);
  console.log('');

  if (isLive && !dryRun) {
    warn(`${c.bold}About to write to LIVE Stripe account.${c.reset}`);
    warn('Press Ctrl+C within 5 seconds to cancel...');
    await new Promise((r) => setTimeout(r, 5000));
  }

  // Find/create the voice_minutes meter. Same meter serves all 3 Voice Minutes
  // Prices (Free/Pro/Scale) — Stripe sums all events tagged to a customer's
  // subscription regardless of which Price they're on.
  const voiceMeter = await ensureMeter('voice_minutes', 'Voice Minutes');

  // Walk the spec
  const results = []; // { envVar, priceId, nickname, isMeter? }

  // Surface meter ID as an env var. usage-tracker.js's meterEvents.create
  // references the meter by event_name (not ID), so the backend doesn't read
  // this var today — but it's listed in the agency's env and is needed for
  // admin / dashboard code that queries meter detail or pulls eventSummaries
  // directly (e.g. stripe.billing.meters.eventSummaries.list(meterId, ...)).
  results.push({
    envVar: 'STRIPE_METER_VOICE_MINUTES',
    priceId: voiceMeter.id,
    nickname: 'Voice Minutes meter',
    productName: '(Meter)',
    productId: '',
    amount: '',
    metered: false,
    isMeter: true,
  });

  for (const productSpec of SPEC) {
    const product = await ensureProduct(productSpec);
    for (const priceSpec of productSpec.prices) {
      const price = await ensurePrice(product, priceSpec, voiceMeter);
      results.push({
        envVar: priceSpec.envVar,
        priceId: price.id,
        nickname: priceSpec.nickname,
        productName: productSpec.productName,
        productId: product.id,
        amount: formatUsd(priceSpec.unit_amount),
        metered: priceSpec.metered,
      });
    }
  }

  // ─── Output env vars ────────────────────────────────────────────────────
  heading('Env vars — paste these into DigitalOcean App config');
  console.log('');
  for (const r of results) {
    if (r.isMeter) {
      console.log(`  ${c.cyan}${r.envVar}${c.reset}=${r.priceId}  ${c.gray}# ${r.nickname}${c.reset}`);
      continue;
    }
    const note = r.metered ? `${c.dim}metered${c.reset}` : '';
    console.log(`  ${c.cyan}${r.envVar}${c.reset}=${r.priceId}  ${c.gray}# ${r.nickname} · ${r.amount}${r.metered ? '/min' : '/mo'} ${note}${c.reset}`);
  }
  console.log('');

  // ─── Plain copy-paste block ─────────────────────────────────────────────
  heading('Plain copy-paste block (no colors)');
  console.log('');
  for (const r of results) {
    console.log(`${r.envVar}=${r.priceId}`);
  }
  console.log('');

  // ─── Write .env.stripe-new file ─────────────────────────────────────────
  if (!dryRun) {
    const outFile = path.join(process.cwd(), '.env.stripe-new');
    const fileContent = [
      '# ============================================================',
      '# VoiceAI Connect — Stripe Price IDs + Meter',
      `# Generated:  ${new Date().toISOString()}`,
      `# Mode:       ${isLive ? 'LIVE' : 'TEST'}`,
      `# Source key: ${stripeKey.slice(0, 12)}...${stripeKey.slice(-4)}`,
      '#',
      '# Product IDs (for reference):',
      ...Array.from(new Set(
        results
          .filter((r) => !r.isMeter)
          .map((r) => `#   ${r.productName} → ${r.productId}`)
      )),
      '# ============================================================',
      '',
      ...results.map((r) => {
        if (r.isMeter) {
          return `${r.envVar}=${r.priceId}    # ${r.nickname}`;
        }
        return `${r.envVar}=${r.priceId}    # ${r.nickname} · ${r.amount}${r.metered ? '/min metered' : '/mo recurring'}`;
      }),
      '',
    ].join('\n');
    fs.writeFileSync(outFile, fileContent);
    ok(`Wrote: ${outFile}`);
  }

  // ─── Next steps ─────────────────────────────────────────────────────────
  heading('Next steps');
  console.log('');
  console.log(`  1. ${c.bold}Update env vars${c.reset} in DigitalOcean App console:`);
  console.log('       https://cloud.digitalocean.com → Apps → your backend → Settings → App-Level Environment Variables');
  console.log('     Paste the 7 lines above. Save. The app will restart automatically.');
  console.log('');
  console.log(`  2. ${c.bold}Test a fresh signup${c.reset} in incognito at https://myvoiceaiconnect.com/signup`);
  console.log('     - Verify the new Product names appear as separate line items');
  console.log('     - Verify there\'s no spurious $9.99 per-client line for 0 clients');
  console.log('     - Verify the Voice Minutes line shows "usage-based" with no upfront amount');
  console.log('');
  console.log(`  3. ${c.bold}Sanity-check on Stripe Dashboard${c.reset}:`);
  console.log('     - Settings → Branding → confirm both Icon AND Logo uploaded');
  console.log('     - Settings → Public business details → confirm "VoiceAI Connect" merchant name');
  console.log('     - Settings → Public business details → confirm statement_descriptor is set');
  console.log('');
  console.log(`  4. ${c.bold}(Optional, later)${c.reset} once all existing subs migrate naturally:`);
  console.log('     - Rename old "VoiceAI Connect Pro" Product to "[ARCHIVED] VoiceAI Connect Pro"');
  console.log('     - Same for old "VoiceAI Connect Scale"');
  console.log('     - Do NOT delete or archive Prices — existing subs still reference them.');
  console.log('');
  if (isLive) {
    console.log(`  ${c.yellow}⚠ You ran this against LIVE. Existing subscriptions are untouched.${c.reset}`);
  }
  console.log('');
}

main().catch((e) => {
  console.error('');
  fail(`Script failed: ${e.message}`);
  if (e.raw) {
    console.error('');
    console.error('Stripe error detail:');
    console.error(JSON.stringify(e.raw, null, 2));
  }
  process.exit(1);
});

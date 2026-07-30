// ============================================================================
// STRIPE MODE RESOLVER  (flip test <-> live with ONE env var)
// ----------------------------------------------------------------------------
// Require this ONCE at the very top of server.js, right after
// require('dotenv').config(), BEFORE any module that builds a Stripe client or
// reads a STRIPE_PRICE_* env at load time (stripe-platform.js, stripe-connect.js).
//
// THE PROBLEM THIS SOLVES
// Switching the backend between test and live means changing every Stripe value
// the runtime reads: the secret key, both webhook signing secrets, and the five
// fixed platform price IDs stripe-platform.js uses. That is 8 vars to swap by
// hand in the DigitalOcean env UI every time. This module collapses that to ONE
// change: you store each value twice (..._TEST and ..._LIVE), set STRIPE_MODE,
// and this copies the selected set onto the plain names the app already reads.
//
// WHAT IS AND IS NOT SCRIPTABLE (so we are precise this time)
// - The account secret/publishable keys (sk_/pk_) are grabbed from the Stripe
//   dashboard once per mode. Stripe has no API to mint those.
// - Everything else the app needs IS created by your existing setup scripts:
//   products, prices (the price IDs below), the voice_minutes meter, and the
//   webhook endpoints whose signing secrets those scripts print. Run those
//   scripts once against your TEST secret key to produce the _TEST values.
//
// DEPLOYED BEHAVIOR
// On DigitalOcean the env vars are injected at container boot. This runs before
// any Stripe client is constructed and mutates process.env in place, so every
// downstream `new Stripe(process.env.STRIPE_SECRET_KEY)` and every
// `process.env.STRIPE_PRICE_*` read sees the resolved value. Identical in dev
// and production. Nothing is written to disk.
//
// FRONTEND (Vercel) is separate. The publishable key it uses
// (NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY) is a build-time Vercel env this backend
// cannot touch. Mirror the same _TEST/_LIVE + STRIPE_MODE pattern in Vercel, or
// just set that one var to match the mode you are deploying.
// ============================================================================

// Every Stripe value the runtime reads. For each, this reads `${base}_${MODE}`
// (e.g. STRIPE_SECRET_KEY_TEST) and copies it onto `base` (STRIPE_SECRET_KEY).
const VARS = [
  // Credentials / secrets
  { base: 'STRIPE_SECRET_KEY',             required: true,  isSecretKey: true },
  { base: 'STRIPE_WEBHOOK_SECRET',          required: false }, // platform webhook: /webhook/stripe
  { base: 'STRIPE_CONNECT_WEBHOOK_SECRET',  required: false }, // connect webhook:  /webhook/stripe-connect
  { base: 'STRIPE_PUBLISHABLE_KEY',         required: false }, // only if the backend returns it anywhere

  // Fixed platform (agency-facing) price IDs read by stripe-platform.js. Test
  // and live price IDs are different objects, so they must be split too.
  { base: 'STRIPE_PRICE_PRO_PLATFORM',      required: false },
  { base: 'STRIPE_PRICE_PRO_CLIENT',        required: false },
  { base: 'STRIPE_PRICE_PRO_MINUTE',        required: false },
  { base: 'STRIPE_PRICE_SCALE_PLATFORM',    required: false },
  { base: 'STRIPE_PRICE_SCALE_MINUTE',      required: false },

  // Produced by the setup scripts but not read by runtime today. Split anyway
  // so a mode flip leaves nothing pointing at the wrong mode later.
  { base: 'STRIPE_METER_VOICE_MINUTES',     required: false },
  { base: 'STRIPE_PRICE_FREE_CLIENT',       required: false },
  { base: 'STRIPE_PRICE_FREE_MINUTE',       required: false },
];

function resolveStripeMode() {
  // Required, no default. A default would silently pick a mode, and with a flat
  // live key already in the env that means either running live when you meant
  // test, or refusing to boot on a mismatch. Force the choice to be explicit:
  // STRIPE_MODE=live in DigitalOcean, STRIPE_MODE=test locally.
  const rawMode = (process.env.STRIPE_MODE || '').trim().toLowerCase();

  if (rawMode !== 'test' && rawMode !== 'live') {
    throw new Error(
      '[stripe-mode] STRIPE_MODE is not set (must be "test" or "live"). ' +
      'Set STRIPE_MODE=live in DigitalOcean and STRIPE_MODE=test locally. ' +
      'No default is used, to avoid silently running the wrong mode.'
    );
  }

  const MODE = rawMode;
  const SUFFIX = MODE.toUpperCase(); // TEST | LIVE

  // Live-mode guardrail. Running live from a dev/staging box is how real cards
  // get charged by accident. Require an explicit opt-in there. Production
  // (NODE_ENV=production) is allowed to run live without the flag.
  if (MODE === 'live'
      && process.env.NODE_ENV !== 'production'
      && process.env.STRIPE_ALLOW_LIVE !== 'true') {
    throw new Error(
      '[stripe-mode] Refusing to run LIVE mode outside production. This box is ' +
      'not NODE_ENV=production. If you really mean it, set STRIPE_ALLOW_LIVE=true. ' +
      'Otherwise set STRIPE_MODE=test.'
    );
  }

  const resolved = [];

  for (const { base, required, isSecretKey } of VARS) {
    const modeVar = `${base}_${SUFFIX}`;
    let value = process.env[modeVar];
    let source = modeVar;

    // Legacy fallback: if the _TEST/_LIVE var is not set but a plain flat var
    // exists, use it and warn. This lets the current single-set env keep working
    // the moment this file ships, before the split vars are added. Adopt the
    // split gradually; no big-bang env rewrite required.
    if (!value && process.env[base]) {
      value = process.env[base];
      source = `${base} (legacy flat, add ${base}_TEST and ${base}_LIVE to enable switching)`;
      console.warn(`[stripe-mode] ${base}: using ${source}`);
    }

    if (!value) {
      if (required) {
        throw new Error(
          `[stripe-mode] Missing ${modeVar} (and no legacy ${base}). ` +
          `Set your ${MODE}-mode value.`
        );
      }
      // Optional and absent: warn so a missing price ID in the active mode is
      // visible now, not a confusing checkout failure later.
      console.warn(`[stripe-mode] ${base}: not set for ${MODE} mode (${modeVar} absent). Skipping.`);
      continue;
    }

    // Guard the secret key hard: a mode/key mismatch either charges real cards
    // when you thought you were testing, or silently fails when you meant live.
    // Price IDs cannot be checked this way (test and live IDs both start with
    // "price_" with no visible difference), so only the secret key is guarded.
    if (isSecretKey) {
      const isTestKey = /^(sk|rk)_test_/.test(value);
      const isLiveKey = /^(sk|rk)_live_/.test(value);
      if (MODE === 'test' && !isTestKey) {
        throw new Error(
          `[stripe-mode] STRIPE_MODE=test but ${source} is not a test key ` +
          `(expected sk_test_ or rk_test_). Refusing to start to avoid live charges.`
        );
      }
      if (MODE === 'live' && !isLiveKey) {
        throw new Error(
          `[stripe-mode] STRIPE_MODE=live but ${source} is not a live key ` +
          `(expected sk_live_ or rk_live_).`
        );
      }
    }

    process.env[base] = value;
    resolved.push(base);
  }

  // One clear line so it is never a mystery which mode a running server is in.
  if (MODE === 'live') {
    console.log('');
    console.log('  ============================================');
    console.log('   STRIPE MODE: LIVE  (real cards, real money)');
    console.log('  ============================================');
    console.log('');
  } else {
    console.log('[stripe-mode] STRIPE MODE: TEST (no real charges)');
  }

  return { mode: MODE, resolved };
}

const result = resolveStripeMode();

module.exports = { STRIPE_MODE: result.mode, resolvedStripeVars: result.resolved };
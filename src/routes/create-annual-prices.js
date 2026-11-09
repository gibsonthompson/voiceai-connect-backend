// ============================================================================
// CREATE ANNUAL PLATFORM PRICES (maintenance endpoint)
// ----------------------------------------------------------------------------
// Creates the yearly platform prices used by annual billing:
//   Pro   -> $891/yr   (9x $99,  i.e. 3 months free)
//   Scale -> $4,491/yr (9x $499, i.e. 3 months free)
//
// Runs on the DEPLOYED backend, so it uses the exact same Stripe environment the
// app already has (STRIPE_SECRET_KEY + the monthly platform price ids). There is
// nothing to set locally and no .env file to create. Hit it once with curl, read
// the two price ids out of the JSON response, set them as env vars on the
// backend, and redeploy.
//
// Each annual price is created on the SAME Stripe product as that plan's existing
// monthly platform price, so a plan is one product with a monthly price and a
// yearly price. Idempotent: it tags each price with a lookup_key and reuses the
// existing one on re-run instead of creating duplicates.
//
// Mount:  app.use('/api/admin', require('./routes/create-annual-prices'));
//   POST /api/admin/create-annual-prices
// Auth: x-cron-secret header (CRON_SECRET), same as the other maintenance
//       endpoints (orphan-cleanup, crons).
// ============================================================================
const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// plan -> monthly price env, annual amount in cents, a stable lookup_key, and
// the env var name the app expects for the resulting annual price id.
const PLANS = [
  {
    name: 'Pro',
    monthlyPriceId: process.env.STRIPE_PRICE_PRO_PLATFORM,
    monthlyEnvName: 'STRIPE_PRICE_PRO_PLATFORM',
    annualCents: 89100, // $891.00
    lookupKey: 'pro_platform_annual',
    envVar: 'STRIPE_PRICE_PRO_PLATFORM_ANNUAL',
  },
  {
    name: 'Scale',
    monthlyPriceId: process.env.STRIPE_PRICE_SCALE_PLATFORM,
    monthlyEnvName: 'STRIPE_PRICE_SCALE_PLATFORM',
    annualCents: 449100, // $4,491.00
    lookupKey: 'scale_platform_annual',
    envVar: 'STRIPE_PRICE_SCALE_PLATFORM_ANNUAL',
  },
];

async function ensureAnnualPrice(p) {
  if (!p.monthlyPriceId) {
    throw new Error(
      `${p.monthlyEnvName} is not set on the backend. It is needed so the annual ` +
      `price lands on the same product as the monthly ${p.name} platform price.`
    );
  }

  // Idempotent: reuse an annual price we already created (matched by lookup_key).
  const existing = await stripe.prices.list({ lookup_keys: [p.lookupKey], active: true, limit: 1 });
  if (existing.data.length > 0) {
    const pr = existing.data[0];
    let message = `${p.name}: reused existing annual price ${pr.id}`;
    if (pr.unit_amount !== p.annualCents || pr.recurring?.interval !== 'year') {
      message =
        `${p.name}: existing price ${pr.id} (lookup_key=${p.lookupKey}) is ` +
        `${pr.unit_amount} ${pr.recurring?.interval}, not ${p.annualCents} year. ` +
        `Left as-is; deactivate it in Stripe if you want it recreated.`;
    }
    return { id: pr.id, message, reused: true };
  }

  // Put the annual price on the SAME product as the monthly platform price.
  const monthly = await stripe.prices.retrieve(p.monthlyPriceId);
  const productId = typeof monthly.product === 'string' ? monthly.product : monthly.product?.id;
  if (!productId) {
    throw new Error(`Could not resolve the product for ${p.monthlyEnvName} (${p.monthlyPriceId}).`);
  }

  const price = await stripe.prices.create({
    product: productId,
    currency: monthly.currency || 'usd',
    unit_amount: p.annualCents,
    recurring: { interval: 'year' },
    nickname: `${p.name} Platform (Annual)`,
    lookup_key: p.lookupKey,
    metadata: { plan: p.name.toLowerCase(), interval: 'year', purpose: 'platform_annual_flat_fee' },
  });
  return {
    id: price.id,
    message: `${p.name}: created annual price ${price.id} ($${(p.annualCents / 100).toFixed(2)}/yr) on product ${productId}`,
    reused: false,
  };
}

router.post('/create-annual-prices', async (req, res) => {
  const cronSecret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'STRIPE_SECRET_KEY is not configured on the backend.' });
  }

  try {
    const mode = process.env.STRIPE_SECRET_KEY.startsWith('sk_live') ? 'LIVE' : 'TEST';
    const env = {};
    const log = [];
    for (const p of PLANS) {
      const r = await ensureAnnualPrice(p);
      env[p.envVar] = r.id;
      log.push(r.message);
    }
    return res.json({
      success: true,
      mode,
      env,
      log,
      next: 'Set these two env vars on the backend (DigitalOcean) and redeploy, then the Monthly/Annual toggle can go live.',
    });
  } catch (e) {
    console.error('create-annual-prices error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;

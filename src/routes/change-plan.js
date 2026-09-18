// ============================================================================
// IN-APP PLAN CHANGE (Pro <-> Scale)
// ----------------------------------------------------------------------------
// POST /api/agency/change-plan  { agency_id, plan }
//
// Why this exists: createAgencyCheckout intentionally 409s an agency that
// already has an active subscription (it would mint a second, double-billing
// subscription). That left the ONLY in-app path to "Manage Subscription", the
// Stripe portal, which by default shows just "Cancel". So a paid agency had no
// way to upgrade Pro -> Scale from the app.
//
// What it does: it does exactly what a Stripe-portal plan switch does, swap the
// subscription's platform price and metered-minute price to the target plan and
// set metadata.plan. It does NOT reconcile the DB itself; the resulting
// customer.subscription.updated event runs handleAgencySubscriptionUpdated,
// which already: detects the plan change from the platform price, updates
// plan_type, removes/adds the per-client item (syncPerClientSubscriptionItem),
// and reconciles team seats. Same tested path, no duplicate logic, no race.
//
// Free -> paid is NOT a plan change (there's no subscription yet), so this
// returns { needs_checkout: true } and the frontend runs the normal checkout.
//
// Mount (server.js), guarded so only the owner/billing-staff of THAT agency can
// change its plan:
//   const { changeAgencyPlan } = require('./routes/change-plan');
//   app.post('/api/agency/change-plan', requireAgencyAccessFromBody('billing'), changeAgencyPlan);
// ============================================================================
const Stripe = require('stripe');
const { supabase } = require('../lib/supabase');
const { PLATFORM_PLANS } = require('./stripe-platform');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Only these are valid targets for an in-app *change*. Free is a cancel/downgrade
// with number teardown, not a simple price swap, so it's excluded here.
const SWITCHABLE = ['pro', 'scale'];

async function changeAgencyPlan(req, res) {
  try {
    const { agency_id, plan } = req.body || {};
    if (!agency_id || !plan) {
      return res.status(400).json({ error: 'agency_id and plan are required' });
    }
    if (!SWITCHABLE.includes(plan)) {
      return res.status(400).json({ error: 'plan must be one of: ' + SWITCHABLE.join(', ') });
    }

    const target = PLATFORM_PLANS[plan];
    if (!target || !target.platformPrice) {
      return res.status(500).json({ error: `Plan "${plan}" is not fully configured (missing platform price env var).` });
    }

    const { data: agency, error } = await supabase
      .from('agencies')
      .select('id, plan_type, stripe_subscription_id, stripe_customer_id, subscription_status, status')
      .eq('id', agency_id)
      .single();
    if (error || !agency) return res.status(404).json({ error: 'Agency not found' });

    if (agency.plan_type === plan) {
      return res.json({ success: true, already_on_plan: true, plan });
    }

    // No live subscription (Free agency): this is a NEW subscription, not a
    // switch. Tell the frontend to run the normal checkout flow.
    if (!agency.stripe_subscription_id) {
      return res.json({ needs_checkout: true, plan });
    }

    // Retrieve the subscription and confirm it's in a switchable state.
    let sub;
    try {
      sub = await stripe.subscriptions.retrieve(agency.stripe_subscription_id);
    } catch (e) {
      // Subscription vanished on Stripe's side -> fall back to checkout.
      console.warn(`change-plan: could not retrieve ${agency.stripe_subscription_id}: ${e.message}`);
      return res.json({ needs_checkout: true, plan });
    }
    if (!['active', 'trialing', 'past_due'].includes(sub.status)) {
      return res.json({ needs_checkout: true, plan, note: `subscription is ${sub.status}` });
    }

    // Find the platform item and the metered-minute item among all plans' prices
    // (so we correctly locate them regardless of which plan they're currently on).
    const allPlatformPrices = Object.values(PLATFORM_PLANS).map((p) => p.platformPrice).filter(Boolean);
    const allMinutePrices = Object.values(PLATFORM_PLANS).map((p) => p.minutePrice).filter(Boolean);

    const items = sub.items?.data || [];
    const platformItem = items.find((i) => i.price && allPlatformPrices.includes(i.price.id));
    const minuteItem = items.find((i) => i.price && allMinutePrices.includes(i.price.id));

    if (!platformItem) {
      return res.status(500).json({ error: 'Could not find the platform subscription item to switch.' });
    }

    // Build the item swaps. The per-client item is deliberately NOT touched here;
    // the subscription.updated webhook reconciles it (removes the Pro per-client
    // item when moving to Scale, adds it when moving to Pro).
    const updateItems = [];
    if (platformItem.price.id !== target.platformPrice) {
      updateItems.push({ id: platformItem.id, price: target.platformPrice });
    }
    if (minuteItem && target.minutePrice && minuteItem.price.id !== target.minutePrice) {
      updateItems.push({ id: minuteItem.id, price: target.minutePrice });
    }

    if (updateItems.length === 0) {
      // Prices already match the target (metadata was just stale).
      await stripe.subscriptions.update(agency.stripe_subscription_id, {
        metadata: { ...(sub.metadata || {}), plan },
      });
      return res.json({ success: true, plan, note: 'prices already matched; metadata synced' });
    }

    await stripe.subscriptions.update(agency.stripe_subscription_id, {
      items: updateItems,
      proration_behavior: 'create_prorations',
      metadata: { ...(sub.metadata || {}), plan },
    });

    console.log(`📈 change-plan: agency ${agency_id} ${agency.plan_type} -> ${plan} (subscription ${agency.stripe_subscription_id})`);

    // plan_type / per-client / seats are updated by handleAgencySubscriptionUpdated
    // when Stripe fires customer.subscription.updated (usually within seconds).
    return res.json({
      success: true,
      plan,
      message: `Upgraded to ${target.name}. Your billing updates in a moment.`,
      processing: true,
    });
  } catch (err) {
    console.error('change-plan error:', err);
    return res.status(500).json({ error: 'Failed to change plan', detail: err.message });
  }
}

module.exports = { changeAgencyPlan };
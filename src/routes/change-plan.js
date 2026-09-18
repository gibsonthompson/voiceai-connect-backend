// ============================================================================
// IN-APP PLAN CHANGE (Pro <-> Scale)
// ----------------------------------------------------------------------------
// POST /api/agency/change-plan  { agency_id, plan }
//
// Why this exists: createAgencyCheckout intentionally 409s an agency that
// already has an active subscription (it would mint a second, double-billing
// subscription). That left the ONLY in-app path to "Manage Subscription", the
// Stripe portal, which by default shows just "Cancel". So a paid agency had no
// way to upgrade Pro -> Scale (or switch back) from the app.
//
// What it does: swaps the subscription's platform price and metered-minute
// price to the target plan (Stripe prorates the difference), then applies the
// resulting change to our own DB *synchronously* in this request:
//   - agencies.plan_type = target (and clears the per-row team caps so the
//     plan defaults in team.js take effect)
//   - reconciles the per-client subscription item (removes the Pro $9.99/client
//     item on the way to Scale, adds it on the way to Pro)
//   - reconciles agency team seats for the new cap
//
// WHY SYNCHRONOUS (this is the fix): the previous version did NONE of this and
// relied entirely on the customer.subscription.updated webhook to reconcile the
// DB. Stripe webhooks take a few seconds (sometimes longer) to arrive, so the
// frontend's post-change reload often showed the OLD plan, making a real,
// successful switch look like it silently failed, especially "switching back".
// Doing the reconcile here makes the change reflect immediately and behave the
// same in both directions.
//
// NO DOUBLE-WORK / NO RACE: handleAgencySubscriptionUpdated still runs when the
// webhook arrives, but it only acts when the plan it detects on the
// subscription differs from agencies.plan_type. Because we set plan_type here,
// the webhook simply no-ops for changes made through this route. It remains the
// authority for Stripe-portal-driven plan changes (where this route isn't
// involved). Every Stripe/DB op below is idempotent.
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
const { PLATFORM_PLANS, reconcileAgencyTeamSeats } = require('./stripe-platform');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Only these are valid targets for an in-app *change*. Free is a cancel/downgrade
// with number teardown, not a simple price swap, so it's excluded here.
const SWITCHABLE = ['pro', 'scale'];

// ----------------------------------------------------------------------------
// Reconcile the per-client subscription item against the target plan. Mirrors
// syncPerClientSubscriptionItem in stripe-platform.js, kept inline so this
// route is self-contained (one file to deploy). Idempotent: lists items first,
// removes any per-client item that isn't the target plan's, then adds the
// target plan's item at the current real-client count if it isn't attached.
//   Pro -> Scale : removes the Pro $9.99/client item, adds nothing
//   Scale -> Pro : adds the Pro $9.99/client item at current client count
// ----------------------------------------------------------------------------
async function syncPerClientItem(agencyId, planId, subscriptionId) {
  if (!subscriptionId) return;
  const planConfig = PLATFORM_PLANS[planId];
  if (!planConfig) return;

  let existingItems = [];
  try {
    const list = await stripe.subscriptionItems.list({ subscription: subscriptionId, limit: 100 });
    existingItems = list.data || [];
  } catch (e) {
    console.error('change-plan syncPerClientItem: list failed:', e.message);
    return;
  }

  const allClientPriceIds = Object.values(PLATFORM_PLANS).map((c) => c.clientPrice).filter(Boolean);
  const perClientItems = existingItems.filter((i) => i.price && allClientPriceIds.includes(i.price.id));
  const targetPriceId = planConfig.clientPrice; // null for Scale

  // Remove any per-client item that isn't the target plan's.
  for (const item of perClientItems) {
    if (item.price.id !== targetPriceId) {
      try {
        await stripe.subscriptionItems.del(item.id, { proration_behavior: 'create_prorations' });
        console.log(`🗑️  change-plan: removed stale per-client item ${item.id}`);
      } catch (e) {
        console.error(`change-plan: failed to remove per-client item ${item.id}:`, e.message);
      }
    }
  }

  // Add the target plan's per-client item (Pro) if it isn't already attached.
  if (targetPriceId) {
    const already = perClientItems.some((i) => i.price.id === targetPriceId);
    if (!already) {
      try {
        const { count } = await supabase
          .from('clients')
          .select('id', { count: 'exact', head: true })
          .eq('agency_id', agencyId)
          .eq('is_test_client', false);
        await stripe.subscriptionItems.create({
          subscription: subscriptionId,
          price: targetPriceId,
          quantity: count || 0,
          proration_behavior: 'create_prorations',
        });
        console.log(`✅ change-plan: added per-client item for ${planId} (qty=${count || 0})`);
      } catch (e) {
        console.error(`change-plan: failed to add per-client item for ${planId}:`, e.message);
      }
    }
  }
}

// Apply the completed switch to our DB + Stripe items. Idempotent; safe to run
// even if the webhook also runs later (it will no-op once plan_type matches).
async function applyPlanChange(agencyId, plan, subscriptionId) {
  const { error: updErr } = await supabase
    .from('agencies')
    .update({
      plan_type: plan,
      // Clear per-row caps so team.js plan defaults (Pro=3, Scale=unlimited)
      // take effect. A non-null value (including 0) is treated as a hard
      // override, which would otherwise block or mis-limit team members.
      max_team_members_agency: null,
      max_team_members_client: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', agencyId);
  if (updErr) console.error('change-plan: plan_type update failed:', updErr.message);

  try { await syncPerClientItem(agencyId, plan, subscriptionId); }
  catch (e) { console.error('change-plan: per-client sync failed:', e.message); }

  // Downgrade enforcement (e.g. Scale -> Pro): disable newest over-cap staff.
  try { await reconcileAgencyTeamSeats(agencyId, plan); }
  catch (e) { console.error('change-plan: seat reconcile failed:', e.message); }
}

async function changeAgencyPlan(req, res) {
  const { agency_id, plan } = req.body || {};
  let lockAcquired = false;
  try {
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

    // Short per-agency billing lock so two concurrent change-plan requests
    // can't both mutate the same subscription (e.g. double-add a per-client
    // item). Considered stale after ~60s and released in the finally below.
    // Fail-open: if the lock column/query errors (e.g. before the migration is
    // applied), we log and proceed without the lock rather than block changes.
    {
      const nowIso = new Date().toISOString();
      const staleIso = new Date(Date.now() - 60 * 1000).toISOString();
      try {
        const { data: lockRows, error: lockErr } = await supabase
          .from('agencies')
          .update({ billing_change_lock: nowIso })
          .eq('id', agency_id)
          .or(`billing_change_lock.is.null,billing_change_lock.lt.${staleIso}`)
          .select('id');
        if (lockErr) {
          console.warn('change-plan: lock acquire error (proceeding without lock):', lockErr.message);
        } else if (!lockRows || lockRows.length === 0) {
          return res.status(409).json({ error: 'change_in_progress', message: 'A plan change is already in progress. Give it a few seconds and try again.' });
        } else {
          lockAcquired = true;
        }
      } catch (e) {
        console.warn('change-plan: lock acquire threw (proceeding without lock):', e.message);
      }
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
    // (so we locate them regardless of which plan they're currently on).
    const allPlatformPrices = Object.values(PLATFORM_PLANS).map((p) => p.platformPrice).filter(Boolean);
    const allMinutePrices = Object.values(PLATFORM_PLANS).map((p) => p.minutePrice).filter(Boolean);

    const items = sub.items?.data || [];
    const platformItem = items.find((i) => i.price && allPlatformPrices.includes(i.price.id));
    const minuteItem = items.find((i) => i.price && allMinutePrices.includes(i.price.id));

    if (!platformItem) {
      return res.status(500).json({ error: 'Could not find the platform subscription item to switch.' });
    }

    // Build the item swaps. The per-client item is reconciled by
    // applyPlanChange below, not here.
    const updateItems = [];
    if (platformItem.price.id !== target.platformPrice) {
      updateItems.push({ id: platformItem.id, price: target.platformPrice });
    }
    if (minuteItem) {
      if (target.minutePrice && minuteItem.price.id !== target.minutePrice) {
        updateItems.push({ id: minuteItem.id, price: target.minutePrice });
      }
    } else if (target.minutePrice) {
      // The subscription is missing its metered-minute item entirely. Every
      // plan meters minutes, so this is a data anomaly; add the target plan's
      // minute price so the agency is billed at the correct per-minute rate
      // instead of not at all. Logged loudly so the anomaly is visible.
      console.warn(`⚠️  change-plan: subscription ${agency.stripe_subscription_id} had no metered-minute item; adding ${plan} minute price`);
      updateItems.push({ price: target.minutePrice });
    }

    if (updateItems.length > 0) {
      await stripe.subscriptions.update(agency.stripe_subscription_id, {
        items: updateItems,
        proration_behavior: 'create_prorations',
        metadata: { ...(sub.metadata || {}), plan },
      });
    } else {
      // Prices already match the target (only metadata was stale). Sync it.
      await stripe.subscriptions.update(agency.stripe_subscription_id, {
        metadata: { ...(sub.metadata || {}), plan },
      });
    }

    console.log(`📈 change-plan: agency ${agency_id} ${agency.plan_type} -> ${plan} (subscription ${agency.stripe_subscription_id})`);

    // Apply the DB + billing reconcile NOW so the app reflects the change
    // immediately instead of waiting on / racing the webhook.
    await applyPlanChange(agency_id, plan, agency.stripe_subscription_id);

    return res.json({
      success: true,
      plan,
      message: `You're now on ${target.name}.`,
    });
  } catch (err) {
    console.error('change-plan error:', err);
    return res.status(500).json({ error: 'Failed to change plan', detail: err.message });
  } finally {
    // Release the billing lock if we took it (fail-open: a release miss just
    // means the row's lock goes stale on its own after ~60s).
    if (lockAcquired) {
      try {
        await supabase.from('agencies').update({ billing_change_lock: null }).eq('id', agency_id);
      } catch (e) {
        console.warn('change-plan: lock release failed:', e.message);
      }
    }
  }
}

module.exports = { changeAgencyPlan };
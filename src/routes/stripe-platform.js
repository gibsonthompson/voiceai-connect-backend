// ============================================================================
// STRIPE PLATFORM BILLING - Agencies Pay Platform
// ----------------------------------------------------------------------------
// 3-Product architecture (Pro / Scale) with metered voice minutes + per-client
// quantity-based charging. Plan keys match what the frontend's handleUpgrade
// in agency-settings-page.tsx sends ('pro' / 'scale'), and env var names match
// what setup-stripe-products.js outputs (STRIPE_PRICE_PRO_PLATFORM,
// STRIPE_PRICE_PRO_CLIENT, STRIPE_PRICE_PRO_MINUTE, STRIPE_PRICE_SCALE_PLATFORM,
// STRIPE_PRICE_SCALE_MINUTE).
//
// Updated 2026-06-10, replaces the pre-3-Product version that used the stale
// starter/professional/enterprise keys and STRIPE_PRICE_AGENCY_* env vars.
//
// Updated 2026-07-02, handleAgencySubscriptionDeleted now cascades a number
// release to every client under the canceled agency (releaseAgencyClientNumbers).
// Previously an agency platform-cancel suspended the agency but left all of its
// clients' Telnyx numbers renting monthly forever. This closes the agency-level
// half of the number-release leak (the client-level half is fixed in
// stripe-connect.js).
//
// Updated 2026-08-12, the four agency billing emails (cancellation, payment
// failed, trial ending, trial warning) now render through the shared branded
// email layout (lib/email-layout.js) instead of bare unstyled HTML. Copy on the
// two trial emails was corrected: paid trials are card-required, so the plan
// continues automatically on the card on file rather than needing one added.
//
// Updated 2026-08-13, createAgencyCheckout now honors skipTrial from the body.
// Reactivation and trial-expired resubscribe flows (both already send
// skipTrial:true) previously still got a fresh 14-day trial because the flag
// was ignored, letting an agency farm repeat free trials by cancelling and
// resubscribing. With skipTrial:true we omit trial_period_days (Stripe charges
// immediately on the card entered at checkout) and stamp skip_trial:'true' into
// the subscription + session metadata. handleAgencyCheckoutCompleted reads that
// flag and activates the agency straight to 'active' with no trial_ends_at,
// instead of 'trial'. New signups do NOT send skipTrial, so they keep the
// 14-day trial exactly as before.
// ============================================================================
const Stripe = require('stripe');
const { supabase, getAgencyByStripeCustomerId } = require('../lib/supabase');
const { sendEmail, sendPlatformNotificationSMS, sendAgencySignupNotificationSMS } = require('../lib/notifications');
const { fullyReleaseNumber, disableAssistant } = require('../lib/vapi');
const { renderBrandedEmail } = require('../lib/email-layout');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ============================================================================
// PLAN CONFIGURATION
// ----------------------------------------------------------------------------
// platform -> flat recurring fee. quantity is always 1.
// client   -> per-unit recurring (not metered). The subscription item is added
//            in handleAgencyCheckoutCompleted with qty = current real (non-
//            test) client count, then kept in sync by updateClientBillingQuantity
//            as clients are added/removed. We don't include it in checkout
//            line_items because Stripe Checkout requires qty>=1, and a newly-
//            upgraded agency typically has 0 paying clients.
// minute   -> metered via voice_minutes meter. Stripe rejects `quantity` on
//            metered prices, so the line item must omit it entirely.
// ============================================================================
const PLATFORM_PLANS = {
  free: {
    name: 'Free',
    price: 0, // $0/mo platform fee; billed per-client ($29.99) + per-minute only
    platformPrice: process.env.STRIPE_PRICE_FREE_PLATFORM, // a $0/mo recurring price
    clientPrice: process.env.STRIPE_PRICE_FREE_CLIENT,
    minutePrice: process.env.STRIPE_PRICE_FREE_MINUTE,
    clientLimit: -1, // unlimited
  },
  pro: {
    name: 'Pro',
    price: 9900, // $99/mo flat
    platformPrice: process.env.STRIPE_PRICE_PRO_PLATFORM,
    clientPrice: process.env.STRIPE_PRICE_PRO_CLIENT,
    minutePrice: process.env.STRIPE_PRICE_PRO_MINUTE,
    clientLimit: -1, // unlimited
  },
  scale: {
    name: 'Scale',
    price: 49900, // $499/mo flat
    platformPrice: process.env.STRIPE_PRICE_SCALE_PLATFORM,
    clientPrice: null, // Scale is unlimited clients at $0, no per-client item
    minutePrice: process.env.STRIPE_PRICE_SCALE_MINUTE,
    clientLimit: -1,
  },
};

// Backward-compat exports for any callers expecting the old constants.
const PLATFORM_PRICES = {
  pro: process.env.STRIPE_PRICE_PRO_PLATFORM,
  scale: process.env.STRIPE_PRICE_SCALE_PLATFORM,
};

const PLAN_DETAILS = {
  pro: { name: 'Pro', clientLimit: -1, price: 9900 },
  scale: { name: 'Scale', clientLimit: -1, price: 49900 },
};

// ============================================================================
// HELPERS
// ----------------------------------------------------------------------------
// normalizeSubscriptionStatus: Stripe emits its own status vocabulary
// ('trialing', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete',
// 'incomplete_expired', 'paused'). Our internal subscription_status column
// is referenced by team.js, the warnExpiringAgencyTrials cron, and several
// other queries that expect a stable set of values. We always write the
// normalized form so downstream consumers can equality-check against one
// known string instead of two.
//
// detectPlanFromSubscription: Stripe portal lets users change plan without
// going through our checkout. The new plan is reflected in subscription.items
// (which prices are attached), not in metadata. We map active price ids back
// to our plan ids so handleAgencySubscriptionUpdated can keep plan_type in
// sync. Returns null if no known platform price is present.
// ============================================================================
function normalizeSubscriptionStatus(stripeStatus) {
  switch (stripeStatus) {
    case 'trialing':           return 'trial';
    case 'active':             return 'active';
    case 'past_due':           return 'past_due';
    case 'canceled':           return 'canceled';
    case 'unpaid':             return 'unpaid';
    case 'incomplete':         return 'incomplete';
    case 'incomplete_expired': return 'canceled';
    case 'paused':             return 'paused';
    default:                   return stripeStatus || 'unknown';
  }
}

function detectPlanFromSubscription(subscription) {
  // Items reflect the current truth. Stripe portal plan switches update
  // subscription.items but NOT subscription.metadata, so the metadata.plan
  // stays at whatever the original checkout set (e.g., 'pro') even after
  // the user switches to Scale. Always scan items first.
  const items = subscription?.items?.data || [];
  for (const item of items) {
    const priceId = item?.price?.id;
    if (!priceId) continue;
    for (const [planId, cfg] of Object.entries(PLATFORM_PLANS)) {
      if (cfg.platformPrice === priceId) return planId;
    }
  }

  // Fall back to metadata only when items don't reveal a known platform
  // price (e.g., subscription created with a different price for some
  // promotional/grandfathered reason).
  const metaPlan = subscription?.metadata?.plan;
  if (metaPlan && PLATFORM_PLANS[metaPlan]) return metaPlan;

  return null;
}

// syncPerClientSubscriptionItem: reconciles the per-client subscription item
// against the target plan. Called from checkout-completed (new subscription),
// subscription-created (defense in depth), and subscription-updated (portal
// plan switch). Idempotent: lists existing items first, removes any stale
// per-client items from a previous plan, then adds the target plan's per-
// client item if applicable and not already attached.
//
// Flow per plan transition:
//   Pro -> Scale: removes Pro $9.99/client item, adds nothing (Scale has no
//                per-client price)
//   Scale -> Pro: adds Pro $9.99/client item at current client count
//   Pro -> Pro / Scale -> Scale: no-op (target already matches)
//   anything -> Free: not reached (Free has no Stripe subscription)
async function syncPerClientSubscriptionItem(agencyId, planId, subscriptionId) {
  if (!subscriptionId) return;
  const planConfig = PLATFORM_PLANS[planId];
  if (!planConfig) return;

  let existingItems;
  try {
    const list = await stripe.subscriptionItems.list({
      subscription: subscriptionId,
      limit: 100,
    });
    existingItems = list.data || [];
  } catch (e) {
    console.error('syncPerClientSubscriptionItem: failed to list items:', e.message);
    return;
  }

  // Set of every per-client price id across all plans so we can detect
  // stale items left over from a prior plan.
  const allClientPriceIds = Object.values(PLATFORM_PLANS)
    .map((cfg) => cfg.clientPrice)
    .filter(Boolean);

  const perClientItems = existingItems.filter(
    (item) => item.price && allClientPriceIds.includes(item.price.id)
  );

  const targetPriceId = planConfig.clientPrice; // null for Scale

  // Remove stale per-client items (any item whose price doesn't match target).
  for (const item of perClientItems) {
    if (item.price.id !== targetPriceId) {
      try {
        await stripe.subscriptionItems.del(item.id, { proration_behavior: 'create_prorations' });
        console.log(`🗑️ Removed stale per-client item ${item.id} (price=${item.price.id})`);
      } catch (e) {
        console.error(`Failed to remove stale per-client item ${item.id}:`, e.message);
      }
    }
  }

  // Add target per-client item if applicable and not already attached.
  if (targetPriceId) {
    const alreadyAttached = perClientItems.some((item) => item.price.id === targetPriceId);
    if (!alreadyAttached) {
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
        console.log(`✅ Added per-client item for plan=${planId} (qty=${count || 0})`);
      } catch (e) {
        console.error(`Failed to add per-client item for plan=${planId}:`, e.message);
      }
    }
  }
}

// ============================================================================
// RECONCILE AGENCY TEAM SEATS
// ----------------------------------------------------------------------------
// Enforces the agency team-member seat cap after a plan change or cancel.
// checkTeamLimit() in routes/team.js gates seats at ADD time, but members
// already added under a roomier plan would otherwise keep logging in after a
// downgrade, agencyLogin only blocks team_members whose status is 'disabled'.
// This disables the newest-over-cap members so that existing login gate takes
// over, with NO change needed in auth.js.
//
// Policy (approved): oldest kept, newest disabled. Caps by plan:
//   scale / enterprise -> unlimited (no-op)
//   pro / professional -> 3
//   free / anything else -> 0  (disable every active agency staff member)
//
// Notes:
//   - Only agency-scope team_members are touched. Client team members and the
//     agency OWNER (a users row, not a team_members row) are never affected.
//   - We disable rather than delete so a later re-upgrade can re-enable the
//     same people and their credentials/data survive.
//   - Counts match checkTeamLimit(): the cap is a number of staff seats, the
//     owner is not counted.
// ============================================================================
async function reconcileAgencyTeamSeats(agencyId, plan) {
  if (!agencyId) return;

  const p = (plan || 'free').toLowerCase();
  const cap =
    (p === 'scale' || p === 'enterprise')   ? -1 :
    (p === 'pro' || p === 'professional')    ? 3  :
    0;

  // Unlimited, nothing to enforce.
  if (cap === -1) return;

  // Active (non-disabled) agency members, oldest first so the first `cap`
  // rows are the keepers and everything after them is over the cap.
  const { data: members, error } = await supabase
    .from('team_members')
    .select('id, created_at, status')
    .eq('entity_type', 'agency')
    .eq('entity_id', agencyId)
    .neq('status', 'disabled')
    .order('created_at', { ascending: true });

  if (error) {
    console.error(`reconcileAgencyTeamSeats: failed to list members for ${agencyId}:`, error.message);
    return;
  }

  const active = members || [];
  if (active.length <= cap) return; // within cap, nothing to do

  const overCap = active.slice(cap); // everything past the first `cap` keepers
  const ids = overCap.map((m) => m.id);

  const { error: updErr } = await supabase
    .from('team_members')
    .update({ status: 'disabled', updated_at: new Date().toISOString() })
    .in('id', ids);

  if (updErr) {
    console.error(`reconcileAgencyTeamSeats: failed to disable ${ids.length} member(s) for ${agencyId}:`, updErr.message);
    return;
  }

  console.log(`🔒 Seat reconcile (plan=${p}, cap=${cap}): disabled ${ids.length} over-cap agency member(s) for ${agencyId}`);
}

// ============================================================================
// RELEASE ALL CLIENT NUMBERS FOR A CANCELED AGENCY (cascade)
// ----------------------------------------------------------------------------
// When an agency's PLATFORM subscription is deleted, the agency is suspended
// and dropped to Free, and it can no longer manage its clients. Every Telnyx
// number held by those clients would otherwise keep renting monthly forever
// (~$1 each). This releases each one (VAPI object + Telnyx rental via
// fullyReleaseNumber), disables the assistant, and nulls the number fields,
// mirroring what the client cancel path in stripe-connect.js and expireTrials
// already do.
//
// TRADEOFF (intentional): this kills dial-in for the agency's end clients even
// if those clients were still paying the agency on the connected account. An
// agency whose platform subscription lapsed is suspended and cannot serve them
// anyway, so releasing stops the recurring cost. If the agency reactivates,
// clients re-provision fresh numbers (the same gap trial-expiry already has).
// If you would rather keep numbers alive through a short dunning window, gate
// this behind a grace period instead of calling it on delete.
//
// Idempotent: once a client's number fields are null, fullyReleaseNumber is a
// no-op and the update simply re-nulls, so a webhook retry is safe.
// ============================================================================
async function releaseAgencyClientNumbers(agencyId) {
  if (!agencyId) return;

  const { data: clients, error } = await supabase
    .from('clients')
    .select('id, business_name, vapi_phone_id, vapi_phone_number, vapi_assistant_id')
    .eq('agency_id', agencyId)
    .or('vapi_phone_id.not.is.null,vapi_phone_number.not.is.null');

  if (error) {
    console.error(`releaseAgencyClientNumbers: failed to list clients for ${agencyId}:`, error.message);
    return;
  }

  if (!clients || clients.length === 0) return;

  console.log(`📞 Agency ${agencyId} canceled, releasing ${clients.length} client number(s)`);

  for (const c of clients) {
    try {
      const release = await fullyReleaseNumber(c.vapi_phone_id, c.vapi_phone_number);
      console.log(`   [agency_canceled] ${c.business_name}: VAPI=${release.vapiDeleted} Telnyx=${release.telnyxReleased}`);
      if (!release.telnyxReleased) {
        console.error(`   ⚠️ Telnyx NOT released for ${c.business_name} (${c.vapi_phone_number})`);
      }
    } catch (relErr) {
      console.error(`   ❌ Release failed for ${c.business_name}:`, relErr.message);
    }

    if (c.vapi_assistant_id) {
      try { await disableAssistant(c.vapi_assistant_id); } catch {}
    }

    const { error: nullErr } = await supabase
      .from('clients')
      .update({
        subscription_status: 'agency_canceled',
        status: 'suspended',
        vapi_phone_id: null,
        vapi_phone_number: null,
        phone_number: null,
        phone_area_code: null,
      })
      .eq('id', c.id);

    if (nullErr) {
      console.error(`   ❌ Failed to null number fields for ${c.business_name}:`, nullErr.message);
    }
  }
}

// ============================================================================
// CREATE CHECKOUT SESSION (Agency subscribes to platform)
// ----------------------------------------------------------------------------
// skipTrial (body, optional): when true, no free trial is granted. Stripe
// charges the card entered at checkout immediately and the agency activates
// straight to 'active'. Sent by the reactivation page and the trial-expired
// resubscribe screen, both of which involve agencies that already used their
// one trial. Absent/false (new signups) keeps the standard 14-day trial.
// ============================================================================
async function createAgencyCheckout(req, res) {
  try {
    const { agency_id, plan, skipTrial } = req.body;

    if (!agency_id || !plan) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['agency_id', 'plan'],
      });
    }

    const planConfig = PLATFORM_PLANS[plan];
    if (!planConfig) {
      return res.status(400).json({
        error: 'Invalid plan',
        valid_plans: Object.keys(PLATFORM_PLANS),
      });
    }

    if (!planConfig.platformPrice) {
      console.error(`❌ Missing env var: STRIPE_PRICE_${plan.toUpperCase()}_PLATFORM`);
      return res.status(500).json({ error: 'Platform price not configured. Contact support.' });
    }

    // Get agency
    const { data: agency, error } = await supabase
      .from('agencies')
      .select('*')
      .eq('id', agency_id)
      .single();

    if (error || !agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    const noTrial = skipTrial === true || skipTrial === 'true' || plan === 'free';
    console.log(`🛒 Creating ${plan} checkout for: ${agency.email}${noTrial ? ' (no trial, immediate charge)' : ''}`);

    // Defense against duplicate subscriptions. If the agency already has an
    // active/trialing/past_due subscription, force them through the Stripe
    // Customer Portal to change plans instead of letting createAgencyCheckout
    // mint a second concurrent subscription that would double-charge them.
    // Frontend gates this at the button level on /agency/settings, but a
    // direct API hit (or stale tab) could otherwise sneak through. A suspended
    // agency has had its stripe_subscription_id nulled on cancel/delete, so
    // reactivation passes this guard and proceeds to a fresh checkout.
    if (agency.stripe_subscription_id) {
      try {
        const existingSub = await stripe.subscriptions.retrieve(agency.stripe_subscription_id);
        const blockingStatuses = ['active', 'trialing', 'past_due'];
        if (blockingStatuses.includes(existingSub.status)) {
          return res.status(409).json({
            error: 'subscription_exists',
            message: 'You already have an active subscription. Use Manage Subscription to change plans.',
            existing_status: existingSub.status,
          });
        }
      } catch (e) {
        // Stripe returns 404 if the subscription was deleted externally or
        // belongs to a different mode (test vs live). Log and continue with
        // checkout, since there's effectively no active subscription.
        console.warn(`Could not retrieve existing subscription ${agency.stripe_subscription_id}:`, e.message);
      }
    }

    // Create or get Stripe customer
    let customerId = agency.stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: agency.email,
        name: agency.name,
        metadata: {
          agency_id: agency_id,
          type: 'agency',
        },
      });
      customerId = customer.id;

      await supabase
        .from('agencies')
        .update({ stripe_customer_id: customerId })
        .eq('id', agency_id);
    }

    // Build line items: platform fee (flat, qty 1) + metered minute price
    // (no quantity allowed, Stripe rejects it on metered prices). The per-
    // client subscription item is added after subscription creation in the
    // checkout.session.completed webhook handler.
    const lineItems = [
      { price: planConfig.platformPrice, quantity: 1 },
    ];
    if (planConfig.minutePrice) {
      lineItems.push({ price: planConfig.minutePrice });
    }

    // subscription_data: attach a 14-day trial ONLY when not skipping. On a
    // skipTrial checkout we omit trial_period_days (immediate charge) and mark
    // skip_trial in metadata so the completed webhook activates straight to
    // 'active' instead of 'trial'.
    const subscriptionData = {
      metadata: {
        agency_id: agency_id,
        plan: plan,
      },
    };
    if (noTrial) {
      subscriptionData.metadata.skip_trial = 'true';
    } else {
      subscriptionData.trial_period_days = 14;
    }

    // Create checkout session.
    // The frontend (signup-plan-page.tsx, agency-settings-page.tsx, the
    // reactivation page) passes successUrl / cancelUrl in the request body so
    // each flow can chain to the right place (signup -> set-password;
    // reactivation -> an activating screen that waits for the webhook). Without
    // honoring these, the new agency user never sets a password and the
    // post-checkout redirect auto-logs them in as whatever auth_token is
    // already in localStorage. Fall back to sensible defaults otherwise.
    const defaultSuccess = `${process.env.FRONTEND_URL}/agency/dashboard?upgraded=${plan}&session_id={CHECKOUT_SESSION_ID}`;
    const defaultCancel = `${process.env.FRONTEND_URL}/agency/settings?tab=billing&canceled=true`;
    const successUrl = req.body.successUrl || defaultSuccess;
    const cancelUrl = req.body.cancelUrl || defaultCancel;

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      // Show the "Add promotion code" box on the hosted checkout page. Without
      // this flag the box never renders, so a coupon (e.g. a 100%-off comp
      // account) can never be redeemed by the agency at checkout. The customer
      // types the promotion code (not the coupon id) and Stripe applies the
      // linked coupon to every invoice per the coupon's duration.
      allow_promotion_codes: true,
      line_items: lineItems,
      subscription_data: subscriptionData,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        agency_id: agency_id,
        plan: plan,
        type: 'agency_subscription',
        skip_trial: noTrial ? 'true' : 'false',
      },
    });

    console.log(`✅ Checkout session created: ${session.id}`);

    res.json({
      success: true,
      sessionId: session.id,
      url: session.url,
    });
  } catch (error) {
    console.error('❌ Checkout error:', error);
    res.status(500).json({
      error: 'Failed to create checkout session',
      detail: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
}

// ============================================================================
// CREATE PORTAL SESSION (Agency manages subscription)
// ============================================================================
async function createAgencyPortal(req, res) {
  try {
    const { agency_id } = req.body;

    if (!agency_id) {
      return res.status(400).json({ error: 'agency_id required' });
    }

    const { data: agency, error } = await supabase
      .from('agencies')
      .select('*')
      .eq('id', agency_id)
      .single();

    if (error || !agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    if (!agency.stripe_customer_id) {
      // Frontend should hide the "Manage Subscription" button when the agency
      // is on the Free plan, but if a Free agency somehow hits this endpoint
      // we surface needs_payment_method=true so the frontend can redirect to
      // the upgrade flow instead of showing a generic error.
      return res.status(400).json({
        error: 'No active subscription',
        needs_payment_method: true,
      });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: agency.stripe_customer_id,
      return_url: `${process.env.FRONTEND_URL}/agency/settings?tab=billing`,
    });

    res.json({
      success: true,
      url: session.url,
    });
  } catch (error) {
    console.error('❌ Portal error:', error);
    res.status(500).json({ error: 'Failed to create portal session' });
  }
}

// ============================================================================
// WEBHOOK HANDLER - Platform Stripe Events
// ============================================================================
async function handlePlatformStripeWebhook(req, res) {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('⚠️ Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('📥 Platform Stripe webhook:', event.type);

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleAgencyCheckoutCompleted(event.data.object);
        break;

      case 'customer.subscription.created':
        await handleAgencySubscriptionCreated(event.data.object);
        break;

      case 'customer.subscription.updated':
        await handleAgencySubscriptionUpdated(event.data.object);
        break;

      case 'customer.subscription.deleted':
        await handleAgencySubscriptionDeleted(event.data.object);
        break;

      case 'invoice.payment_succeeded':
        await handleAgencyPaymentSucceeded(event.data.object);
        break;

      case 'invoice.payment_failed':
        await handleAgencyPaymentFailed(event.data.object);
        break;

      case 'customer.subscription.trial_will_end':
        await handleAgencyTrialEnding(event.data.object);
        break;
    }

    res.json({ received: true });
  } catch (error) {
    console.error('❌ Webhook processing error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
}

// ============================================================================
// WEBHOOK HANDLERS
// ============================================================================

async function handleAgencyCheckoutCompleted(session) {
  console.log('🎉 Agency checkout completed:', session.id);

  const agencyId = session.metadata?.agency_id;
  const plan = session.metadata?.plan;
  const skipTrial = session.metadata?.skip_trial === 'true';

  if (!agencyId) return;
  if (!plan || !PLATFORM_PLANS[plan]) {
    console.error(`Invalid/missing plan in checkout metadata: ${plan}`);
    return;
  }

  const planConfig = PLATFORM_PLANS[plan];

  // Load the agency BEFORE the activation update so we can tell whether this is
  // its first activation. checkout.session.completed can be retried by Stripe,
  // and customer.subscription.created fires alongside it; keying off status is
  // robust because at signup status is 'pending_payment' and only this handler
  // moves it off pending. A retry then sees a non-pending status and skips, so
  // the owner is texted exactly once, with the plan they picked.
  const { data: agencyBefore } = await supabase
    .from('agencies')
    .select('id, name, email, phone, referral_source, country, status')
    .eq('id', agencyId)
    .single();

  const isFirstActivation =
    !!agencyBefore &&
    (agencyBefore.status === 'pending' || agencyBefore.status === 'pending_payment');

  if (skipTrial) {
    // Reactivation / resubscribe: no new trial. Stripe charged the card at
    // checkout, so activate the agency straight to 'active' with no
    // trial_ends_at. This is the path a suspended agency takes; flipping
    // status off 'suspended' here is what lets the dashboard back in.
    await supabase
      .from('agencies')
      .update({
        status: 'active',
        subscription_status: 'active',
        usage_billing_enabled: true,  // turn on per-minute + per-client usage billing at activation
        plan_type: plan,
        stripe_subscription_id: session.subscription,
        trial_ends_at: null,
        max_team_members_agency: null,
        max_team_members_client: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', agencyId);

    console.log('✅ Agency reactivated (no trial):', agencyId);
  } else {
    // New signup: standard 14-day trial. The checkout.session event doesn't
    // include the subscription's trial_end, so use Date.now + 14 days as an
    // initial value; handleAgencySubscriptionUpdated overwrites it with
    // subscription.trial_end (Stripe's authoritative value) within seconds.
    const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

    await supabase
      .from('agencies')
      .update({
        status: 'trial',
        subscription_status: 'trial', // normalized (Stripe will say 'trialing')
        plan_type: plan,
        stripe_subscription_id: session.subscription,
        trial_ends_at: trialEndsAt,
        // Clear per-row team caps so plan-based defaults in routes/team.js
        // (checkTeamLimit) take effect. The column is treated as a hard
        // override when non-null, including the value 0 which would block
        // adding team members on an otherwise unlimited Pro/Scale plan.
        max_team_members_agency: null,
        max_team_members_client: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', agencyId);

    console.log('✅ Agency activated (trial):', agencyId);
  }

  // Reconcile the per-client subscription item against the new plan. Sync
  // is idempotent so a Stripe webhook retry won't create duplicates, and it
  // handles the rare case where the agency already had per-client items
  // from a previous canceled subscription that need to be cleaned up.
  if (session.subscription) {
    await syncPerClientSubscriptionItem(agencyId, plan, session.subscription);
  }

  // Log event
  await supabase.from('agency_subscription_events').insert({
    agency_id: agencyId,
    event_type: 'checkout_completed',
    stripe_event_id: session.id,
    metadata: { plan, skip_trial: skipTrial },
  });

  // Notify the platform owner that a paid agency just activated, WITH the plan.
  // Guarded on the pending -> activated transition above so a webhook retry or
  // the parallel subscription.created event cannot double-text. A reactivation
  // (status was 'suspended', not pending) is not a first activation and does
  // not fire this. Best-effort: a failed SMS must not fail the webhook.
  if (isFirstActivation) {
    try {
      await sendAgencySignupNotificationSMS({ ...agencyBefore, plan_type: plan });
    } catch (e) {
      console.error('Failed to send agency activation SMS:', e.message);
    }
  }
}

async function handleAgencySubscriptionCreated(subscription) {
  console.log('📝 Agency subscription created:', subscription.id);

  const agency = await getAgencyByStripeCustomerId(subscription.customer);
  if (!agency) return;

  const plan = subscription.metadata?.plan;
  if (!plan || !PLATFORM_PLANS[plan]) {
    console.error(`Invalid/missing plan in subscription metadata: ${plan}`);
    return;
  }

  await supabase
    .from('agencies')
    .update({
      stripe_subscription_id: subscription.id,
      subscription_status: normalizeSubscriptionStatus(subscription.status),
      plan_type: plan,
      // See handleAgencyCheckoutCompleted comment. Clear caps so plan
      // defaults apply (Pro=3, Scale=unlimited via team.js).
      max_team_members_agency: null,
      max_team_members_client: null,
    })
    .eq('id', agency.id);

  // Defense in depth: only call sync here when metadata.plan is missing,
  // which indicates the subscription was created outside our checkout flow
  // (e.g., manual creation via Stripe Dashboard). For normal checkouts,
  // metadata.plan is set and handleAgencyCheckoutCompleted has already
  // called sync. Calling it again here risks a webhook delivery race
  // where two concurrent syncs both see an empty item list and both
  // create the per-client item, producing duplicates.
  if (!subscription.metadata?.plan) {
    await syncPerClientSubscriptionItem(agency.id, plan, subscription.id);
  }
}

async function handleAgencySubscriptionUpdated(subscription) {
  console.log('🔄 Agency subscription updated:', subscription.id);

  const agency = await getAgencyByStripeCustomerId(subscription.customer);
  if (!agency) return;

  // Stale-event guard: see handleAgencySubscriptionDeleted comment. An old
  // canceled subscription can still emit updated events (e.g., refund
  // processing) after we've moved to a new subscription on the same
  // customer. Processing those updates would corrupt the current state.
  if (agency.stripe_subscription_id && agency.stripe_subscription_id !== subscription.id) {
    console.log(
      `Ignoring update for stale subscription ${subscription.id} ` +
      `(agency current = ${agency.stripe_subscription_id})`
    );
    return;
  }

  const status = normalizeSubscriptionStatus(subscription.status);

  // Map normalized status to internal agency.status (the broader account
  // gate used to suspend access). Covers Stripe's full status set including
  // incomplete/paused which the prior version silently fell through.
  let agencyStatus = agency.status;
  switch (status) {
    case 'active':     agencyStatus = 'active'; break;
    case 'trial':      agencyStatus = 'trial'; break;
    case 'past_due':   agencyStatus = 'active'; break;       // keep usable, flag via subscription_status
    case 'incomplete': agencyStatus = 'pending_payment'; break;
    case 'paused':     agencyStatus = 'suspended'; break;
    case 'canceled':
    case 'unpaid':     agencyStatus = 'suspended'; break;
  }

  // Detect plan change (portal-driven plan switches don't fire a fresh
  // checkout, only this update event). If the active platform price now
  // maps to a different plan than our DB has, sync plan_type and clear
  // team caps so team.js plan defaults take effect immediately. The
  // per-client subscription item is also reconciled to the new plan via
  // syncPerClientSubscriptionItem (removes Pro $9.99 item on upgrade to
  // Scale, adds it on downgrade to Pro, no-op otherwise).
  const detectedPlan = detectPlanFromSubscription(subscription);
  const planChanged = detectedPlan && detectedPlan !== agency.plan_type;

  const updates = {
    subscription_status: status,
    status: agencyStatus,
    trial_ends_at: subscription.trial_end
      ? new Date(subscription.trial_end * 1000)
      : null,
  };

  if (planChanged) {
    console.log(`📈 Plan change detected: ${agency.plan_type} -> ${detectedPlan}`);
    updates.plan_type = detectedPlan;
    updates.max_team_members_agency = null;
    updates.max_team_members_client = null;
  }

  await supabase
    .from('agencies')
    .update(updates)
    .eq('id', agency.id);

  if (planChanged) {
    await syncPerClientSubscriptionItem(agency.id, detectedPlan, subscription.id);
    // Downgrade enforcement: if the new plan's cap is lower than the current
    // active staff count (e.g. Scale -> Pro), disable the newest over-cap
    // members so they can no longer log in.
    await reconcileAgencyTeamSeats(agency.id, detectedPlan);
  }
}

async function handleAgencySubscriptionDeleted(subscription) {
  console.log('❌ Agency subscription deleted:', subscription.id);

  const agency = await getAgencyByStripeCustomerId(subscription.customer);
  if (!agency) return;

  // Stale-event guard: an agency that cancels and re-subscribes quickly can
  // receive delete events for the OLD subscription AFTER we've already
  // recorded the new subscription_id. Suspending them now would wipe the
  // fresh subscription. Ignore deletions that don't match the current id.
  if (agency.stripe_subscription_id && agency.stripe_subscription_id !== subscription.id) {
    console.log(
      `Ignoring deletion of stale subscription ${subscription.id} ` +
      `(agency current = ${agency.stripe_subscription_id})`
    );
    return;
  }

  // Full reset back to a clean Free state. Clearing stripe_subscription_id
  // is important because createAgencyCheckout's duplicate-subscription guard
  // would otherwise treat the stale id as an active subscription and block
  // the agency from re-subscribing after cancellation. trial_ends_at is also
  // nulled so the trial-warning cron doesn't keep emailing about an ended
  // trial on a canceled agency.
  await supabase
    .from('agencies')
    .update({
      subscription_status: 'canceled',
      status: 'suspended',
      plan_type: 'free',
      stripe_subscription_id: null,
      trial_ends_at: null,
      max_team_members_agency: null,
      max_team_members_client: null,
    })
    .eq('id', agency.id);

  // Cancel drops the agency to Free (0 staff seats). Disable every active
  // agency staff member so none of them can keep logging in. The agency is
  // also suspended above, but reconciling here keeps the seat state correct
  // for a later reactivation/upgrade.
  await reconcileAgencyTeamSeats(agency.id, 'free');

  // Cascade a number release to every client under this agency. Without this,
  // the agency is suspended but all of its clients' Telnyx numbers keep
  // renting monthly forever. See releaseAgencyClientNumbers for the tradeoff.
  await releaseAgencyClientNumbers(agency.id);

  // Capture cancellation details. Both paths land here eventually:
  //   1. In-app cancel: cancelAgencySubscription already inserted a row keyed
  //      on stripe_subscription_id. Our upsert with ignoreDuplicates:false
  //      will update the same row with effective_at = now if we get newer
  //      data from Stripe (e.g., paid user's period actually ended).
  //   2. Stripe portal cancel: no row exists yet. This insert creates it
  //      with the reason+comment the user supplied in the portal survey.
  //      We also fire the admin SMS so portal-driven churn is visible.
  try {
    const details = subscription.cancellation_details || {};
    const reason = details.feedback || null;           // enum value
    const comment = details.comment || null;           // free text
    const mrrLost =
      agency.plan_type === 'pro'   ? 9900  :
      agency.plan_type === 'scale' ? 49900 :
      0;
    const effectiveAt = subscription.ended_at
      ? new Date(subscription.ended_at * 1000)
      : new Date();

    // Find any existing record from the in-app path before upserting, so
    // we know whether to SMS the admin (we don't want a duplicate SMS for
    // the same cancellation).
    const { data: existing } = await supabase
      .from('subscription_cancellations')
      .select('id, source')
      .eq('stripe_subscription_id', subscription.id)
      .maybeSingle();

    await supabase
      .from('subscription_cancellations')
      .upsert(
        {
          agency_id: agency.id,
          stripe_subscription_id: subscription.id,
          source: existing?.source || 'stripe_portal',
          reason,
          feedback: comment,
          plan_type: agency.plan_type,
          mrr_lost: mrrLost,
          canceled_at: subscription.canceled_at
            ? new Date(subscription.canceled_at * 1000).toISOString()
            : new Date().toISOString(),
          effective_at: effectiveAt.toISOString(),
        },
        { onConflict: 'stripe_subscription_id', ignoreDuplicates: false }
      );

    // Only send admin SMS for portal-driven cancellations (in-app path
    // already sent one in cancelAgencySubscription).
    if (!existing) {
      const reasonLabel = CANCELLATION_REASON_LABELS[reason] || reason || 'No reason given (Stripe portal)';
      const planLabel =
        agency.plan_type === 'pro'   ? 'Pro ($99/mo)' :
        agency.plan_type === 'scale' ? 'Scale ($499/mo)' :
        agency.plan_type || 'Free';

      let msg = `❌ Agency Cancellation (via Stripe Portal)\n`;
      msg += `Agency: ${agency.name}\n`;
      msg += `Email: ${agency.email}\n`;
      msg += `Plan: ${planLabel}\n`;
      msg += `Reason: ${reasonLabel}\n`;
      if (comment && comment.trim()) {
        msg += `\n"${comment.trim()}"\n`;
      }
      if (mrrLost > 0) {
        msg += `\nMRR lost: $${(mrrLost / 100).toFixed(0)}/mo`;
      }

      await sendPlatformNotificationSMS(msg).catch((e) =>
        console.error('Failed to send portal-cancel SMS:', e.message)
      );
    }
  } catch (e) {
    console.error('Failed to capture cancellation details:', e.message);
  }

  await sendEmail({
    to: agency.email,
    subject: 'Your VoiceAI Connect subscription was cancelled',
    html: renderBrandedEmail({
      preheader: 'Your subscription was cancelled and your agency is now suspended.',
      heading: 'Your subscription was cancelled',
      bodyHtml:
        `<p style="margin:0 0 16px;">Hi ${agency.name}, your VoiceAI Connect subscription has been cancelled. Your agency and all of its client AI assistants are now suspended.</p>` +
        `<p style="margin:0;">You can reactivate any time from your billing settings. Your branding, pricing, and clients are all preserved.</p>`,
      cta: { label: 'Reactivate your agency', url: `${process.env.FRONTEND_URL}/agency/settings?tab=billing` },
    }),
  }).catch((e) => console.error('Failed to send cancellation email:', e.message));
}

async function handleAgencyPaymentSucceeded(invoice) {
  console.log('✅ Agency payment succeeded:', invoice.id);

  const agency = await getAgencyByStripeCustomerId(invoice.customer);
  if (!agency) return;

  // A $0 invoice is Stripe's trial-start invoice (or a 100%-off comp), which
  // Stripe auto-marks paid and fires invoice.payment_succeeded for. That is NOT
  // a real payment. Flipping the agency to 'active' here mislabels every trial
  // as active the moment it starts, which is why trialing agencies show up as
  // active and paying counts look inflated. Only a real charge activates.
  if (!invoice.amount_paid || invoice.amount_paid <= 0) {
    console.log(`Skipping activation for $0 invoice ${invoice.id} (trial start / comp) for agency ${agency.id}`);
    return;
  }

  await supabase
    .from('agencies')
    .update({
      subscription_status: 'active',
      usage_billing_enabled: true,  // turn on per-minute + per-client usage billing at activation
      status: 'active',
    })
    .eq('id', agency.id);
}

async function handleAgencyPaymentFailed(invoice) {
  console.log('❌ Agency payment failed:', invoice.id);

  const agency = await getAgencyByStripeCustomerId(invoice.customer);
  if (!agency) return;

  await supabase
    .from('agencies')
    .update({
      subscription_status: 'past_due',
    })
    .eq('id', agency.id);

  await sendEmail({
    to: agency.email,
    subject: 'Payment failed, action required',
    html: renderBrandedEmail({
      preheader: 'We could not process your payment. Update your method to avoid interruption.',
      heading: 'Payment failed',
      bodyHtml:
        `<p style="margin:0 0 16px;">Hi ${agency.name}, we could not process your latest payment. Please update your payment method to avoid any interruption to your agency and its clients.</p>`,
      cta: { label: 'Update payment method', url: invoice.hosted_invoice_url },
    }),
  }).catch((e) => console.error('Failed to send payment-failed email:', e.message));
}

async function handleAgencyTrialEnding(subscription) {
  console.log('⏰ Agency trial ending:', subscription.id);

  const agency = await getAgencyByStripeCustomerId(subscription.customer);
  if (!agency) return;

  const trialEnd = new Date(subscription.trial_end * 1000);
  const daysLeft = Math.ceil((trialEnd - new Date()) / (1000 * 60 * 60 * 24));

  // State the plan, the exact amount that will be charged, the date, and how to
  // cancel. Auto-renewal laws (e.g. California ARL) want the pre-conversion
  // notice to give the amount, the conversion date, and an easy way to cancel,
  // not just the bare fact of an automatic charge. Plan/price come from the
  // agency's current plan_type, which the subscription handlers keep in sync.
  const planCfg = PLATFORM_PLANS[agency.plan_type];
  const planName = planCfg?.name || agency.plan_type || 'your';
  const priceLabel = planCfg?.price ? `$${(planCfg.price / 100).toFixed(0)}/mo` : null;
  const endDateLabel = trialEnd.toLocaleDateString();
  const chargeLine = priceLabel
    ? `the card on file will be charged <strong>${priceLabel}</strong> for the ${planName} plan, and then ${priceLabel} each month until you cancel`
    : `the card on file will be charged for the ${planName} plan, and then each month until you cancel`;

  await sendEmail({
    to: agency.email,
    subject: `Your VoiceAI Connect trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}${priceLabel ? ` (${priceLabel} after)` : ''}`,
    html: renderBrandedEmail({
      preheader: `Your trial ends on ${endDateLabel}${priceLabel ? `, then ${priceLabel}` : ''}.`,
      heading: 'Your trial is ending soon',
      bodyHtml:
        `<p style="margin:0 0 16px;">Hi ${agency.name}, your 14-day trial ends on <strong>${endDateLabel}</strong>. Unless you cancel before then, your ${planName} plan begins automatically and ${chargeLine}.</p>` +
        `<p style="margin:0;">You can review, change, or cancel your plan any time in your billing settings. Cancel before ${endDateLabel} to avoid any charge.</p>`,
      cta: { label: 'Manage or cancel subscription', url: `${process.env.FRONTEND_URL}/agency/settings?tab=billing` },
    }),
  }).catch((e) => console.error('Failed to send trial-ending email:', e.message));
}

// ============================================================================
// CRON: WARN AGENCIES WITH TRIALS ENDING IN 3 DAYS
// ----------------------------------------------------------------------------
// server.js imports this for /api/cron/warn-agency-trials. The original file
// declared the import in server.js but never defined or exported the function,
// which would crash the cron endpoint with "warnExpiringAgencyTrials is not a
// function". Stripe also fires customer.subscription.trial_will_end 3 days
// before trial end automatically, so this is a redundant safety net. NOTE: as
// a result an agency can receive BOTH this email and handleAgencyTrialEnding's
// around the same time; if that double-send is unwanted, disable one.
// ============================================================================
async function warnExpiringAgencyTrials() {
  console.log('⏰ Running agency trial warning check...');

  try {
    const threeDaysFromNow = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const twoDaysFromNow = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);

    const { data: agencies, error } = await supabase
      .from('agencies')
      .select('id, name, email, trial_ends_at, plan_type')
      .eq('subscription_status', 'trial')
      .gte('trial_ends_at', twoDaysFromNow.toISOString())
      .lte('trial_ends_at', threeDaysFromNow.toISOString());

    if (error) {
      console.error('Failed to query expiring trials:', error.message);
      return { warned: 0, error: error.message };
    }

    let warned = 0;
    for (const agency of agencies || []) {
      try {
        // Give the plan, the exact price, the conversion date, and how to
        // cancel, so the pre-conversion notice meets auto-renewal-law
        // expectations (amount + date + easy cancel), not just "auto-charges".
        const planCfg = PLATFORM_PLANS[agency.plan_type];
        const planName = planCfg?.name || agency.plan_type;
        const priceLabel = planCfg?.price ? `$${(planCfg.price / 100).toFixed(0)}/mo` : null;
        const endDateLabel = new Date(agency.trial_ends_at).toLocaleDateString();
        const chargeLine = priceLabel
          ? `the card on file will be charged <strong>${priceLabel}</strong> for the ${planName} plan, and then ${priceLabel} each month until you cancel`
          : `the card on file will be charged for the ${planName} plan, and then each month until you cancel`;
        await sendEmail({
          to: agency.email,
          subject: `Your VoiceAI Connect trial ends in 3 days${priceLabel ? ` (${priceLabel} after)` : ''}`,
          html: renderBrandedEmail({
            preheader: `Your ${planName} trial ends on ${endDateLabel}${priceLabel ? `, then ${priceLabel}` : ''}.`,
            heading: 'Your trial ends in 3 days',
            bodyHtml:
              `<p style="margin:0 0 16px;">Hi ${agency.name}, your 14-day trial of the <strong>${planName}</strong> plan ends on <strong>${endDateLabel}</strong>. Unless you cancel before then, your ${planName} plan begins automatically and ${chargeLine}.</p>` +
              `<p style="margin:0;">You can review, change, or cancel your plan any time in your billing settings. Cancel before ${endDateLabel} to avoid any charge.</p>`,
            cta: { label: 'Manage or cancel subscription', url: `${process.env.FRONTEND_URL}/agency/settings?tab=billing` },
          }),
        });
        warned++;
      } catch (e) {
        console.error(`Failed to email agency ${agency.id}:`, e.message);
      }
    }

    console.log(`✅ Warned ${warned} agency trials expiring in 3 days`);
    return { warned };
  } catch (e) {
    console.error('Trial warning cron error:', e.message);
    return { warned: 0, error: e.message };
  }
}

// ============================================================================
// CAN AGENCY ADD CLIENT
// ----------------------------------------------------------------------------
// Called by routes/client-signup.js when an agency tries to add a new client.
// In the current pricing model all plans (Free/Pro/Scale) have unlimited
// clients, they are billed per-unit (Free $29.99, Pro $9.99, Scale $0) rather
// than capped. The only gate is that Free agencies with no stripe_customer_id
// can't attach per-client billing yet, so they need to upgrade first.
//
// Returns { allowed, reason?, message?, limit, current } so the call site can
// distinguish a hard block (no agency, no billing) from a soft "you can add".
// ============================================================================
async function canAgencyAddClient(agencyId) {
  const { data: agency, error } = await supabase
    .from('agencies')
    .select('id, plan_type, status, stripe_customer_id')
    .eq('id', agencyId)
    .single();

  if (error || !agency) {
    return {
      allowed: false,
      reason: 'agency_not_found',
      message: 'Agency not found',
      limit: 0,
      current: 0,
    };
  }

  const { count } = await supabase
    .from('clients')
    .select('id', { count: 'exact', head: true })
    .eq('agency_id', agencyId)
    .eq('is_test_client', false);

  const current = count || 0;

  // Free agencies need a Stripe customer before they can add real clients,
  // because per-client billing attaches a subscription item that requires
  // a payment source. Pro/Scale agencies always have stripe_customer_id
  // from the checkout flow, so this gate only ever fires on Free.
  const isFree = !agency.plan_type || agency.plan_type === 'free';
  if (isFree && !agency.stripe_customer_id) {
    return {
      allowed: false,
      reason: 'billing_required',
      message: 'Set up billing to add your first client',
      limit: -1,
      current,
    };
  }

  return {
    allowed: true,
    current,
    limit: -1, // unlimited on all plans in the new pricing model
  };
}

// ============================================================================
// CANCELLATION REASON LABELS
// ----------------------------------------------------------------------------
// Reason values match Stripe's cancellation_details.feedback enum so the
// in-app cancel path (server.js inline /api/agency/cancel handler) and the
// Stripe portal cancel path produce the same vocabulary in our
// subscription_cancellations table. SMS uses friendly labels for readability.
// Used by handleAgencySubscriptionDeleted to format the admin SMS for
// portal-driven cancellations.
// ============================================================================
const CANCELLATION_REASON_LABELS = {
  too_expensive:     'Too expensive',
  missing_features:  'Missing features',
  switched_service:  'Switched to another service',
  unused:            'Not using it enough',
  customer_service:  'Customer service issues',
  too_complex:       'Too complex',
  low_quality:       'Quality issues',
  other:             'Other',
};

// ============================================================================
// EXPORTS
// ============================================================================
module.exports = {
  createAgencyCheckout,
  createAgencyPortal,
  handlePlatformStripeWebhook,
  warnExpiringAgencyTrials,
  canAgencyAddClient,
  reconcileAgencyTeamSeats,
  releaseAgencyClientNumbers,
  CANCELLATION_REASON_LABELS,
  PLATFORM_PLANS,
  PLATFORM_PRICES,
  PLAN_DETAILS,
};
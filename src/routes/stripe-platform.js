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
// Updated 2026-06-10 — replaces the pre-3-Product version that used the stale
// starter/professional/enterprise keys and STRIPE_PRICE_AGENCY_* env vars.
// ============================================================================
const Stripe = require('stripe');
const { supabase, getAgencyByStripeCustomerId } = require('../lib/supabase');
const { sendEmail } = require('../lib/notifications');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ============================================================================
// PLAN CONFIGURATION
// ----------------------------------------------------------------------------
// platform → flat recurring fee. quantity is always 1.
// client   → per-unit recurring (not metered). The subscription item is added
//            in handleAgencyCheckoutCompleted with qty = current real (non-
//            test) client count, then kept in sync by updateClientBillingQuantity
//            as clients are added/removed. We don't include it in checkout
//            line_items because Stripe Checkout requires qty>=1, and a newly-
//            upgraded agency typically has 0 paying clients.
// minute   → metered via voice_minutes meter. Stripe rejects `quantity` on
//            metered prices, so the line item must omit it entirely.
// ============================================================================
const PLATFORM_PLANS = {
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
    clientPrice: null, // Scale is unlimited clients at $0 — no per-client item
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
// CREATE CHECKOUT SESSION (Agency subscribes to platform)
// ============================================================================
async function createAgencyCheckout(req, res) {
  try {
    const { agency_id, plan } = req.body;

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

    console.log(`🛒 Creating ${plan} checkout for: ${agency.email}`);

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
    // (no quantity allowed — Stripe rejects it on metered prices). The per-
    // client subscription item is added after subscription creation in the
    // checkout.session.completed webhook handler.
    const lineItems = [
      { price: planConfig.platformPrice, quantity: 1 },
    ];
    if (planConfig.minutePrice) {
      lineItems.push({ price: planConfig.minutePrice });
    }

    // Create checkout session with 14-day trial
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: lineItems,
      subscription_data: {
        trial_period_days: 14,
        metadata: {
          agency_id: agency_id,
          plan: plan,
        },
      },
      success_url: `${process.env.FRONTEND_URL}/agency/dashboard?upgraded=${plan}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/agency/settings?tab=billing&canceled=true`,
      metadata: {
        agency_id: agency_id,
        plan: plan,
        type: 'agency_subscription',
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

  if (!agencyId) return;
  if (!plan || !PLATFORM_PLANS[plan]) {
    console.error(`Invalid/missing plan in checkout metadata: ${plan}`);
    return;
  }

  const planConfig = PLATFORM_PLANS[plan];

  await supabase
    .from('agencies')
    .update({
      status: 'trial',
      subscription_status: 'trial',
      plan_type: plan,
      stripe_subscription_id: session.subscription,
      trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      // Clear per-row team caps so plan-based defaults in routes/team.js
      // (checkTeamLimit) take effect. The column is treated as a hard
      // override when non-null, including the value 0 which would block
      // adding team members on an otherwise unlimited Pro/Scale plan.
      max_team_members_agency: null,
      max_team_members_client: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', agencyId);

  // Add the per-client subscription item if the plan has a per-client price.
  // Quantity starts at the current real (non-test) client count — typically 0
  // for an agency upgrading from Free, but could be non-zero if they had a
  // previous paid subscription that was canceled or they pre-added clients.
  if (planConfig.clientPrice && session.subscription) {
    try {
      const { count } = await supabase
        .from('clients')
        .select('id', { count: 'exact', head: true })
        .eq('agency_id', agencyId)
        .eq('is_test_client', false);

      await stripe.subscriptionItems.create({
        subscription: session.subscription,
        price: planConfig.clientPrice,
        quantity: count || 0,
      });
      console.log(`✅ Added per-client subscription item (qty=${count || 0})`);
    } catch (e) {
      console.error('Failed to add per-client subscription item:', e.message);
    }
  }

  // Log event
  await supabase.from('agency_subscription_events').insert({
    agency_id: agencyId,
    event_type: 'checkout_completed',
    stripe_event_id: session.id,
    metadata: { plan },
  });

  console.log('✅ Agency activated:', agencyId);
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
      subscription_status: subscription.status,
      plan_type: plan,
      // See handleAgencyCheckoutCompleted comment. Clear caps so plan
      // defaults apply (Pro=3, Scale=unlimited via team.js).
      max_team_members_agency: null,
      max_team_members_client: null,
    })
    .eq('id', agency.id);
}

async function handleAgencySubscriptionUpdated(subscription) {
  console.log('🔄 Agency subscription updated:', subscription.id);

  const agency = await getAgencyByStripeCustomerId(subscription.customer);
  if (!agency) return;

  const status = subscription.status;
  let agencyStatus = agency.status;

  // Map Stripe status to our internal agency.status
  if (status === 'active') {
    agencyStatus = 'active';
  } else if (status === 'trialing') {
    agencyStatus = 'trial';
  } else if (status === 'past_due') {
    agencyStatus = 'active'; // keep active but flag via subscription_status
  } else if (status === 'canceled' || status === 'unpaid') {
    agencyStatus = 'suspended';
  }

  await supabase
    .from('agencies')
    .update({
      subscription_status: status,
      status: agencyStatus,
      trial_ends_at: subscription.trial_end
        ? new Date(subscription.trial_end * 1000)
        : null,
    })
    .eq('id', agency.id);
}

async function handleAgencySubscriptionDeleted(subscription) {
  console.log('❌ Agency subscription deleted:', subscription.id);

  const agency = await getAgencyByStripeCustomerId(subscription.customer);
  if (!agency) return;

  await supabase
    .from('agencies')
    .update({
      subscription_status: 'canceled',
      status: 'suspended',
      plan_type: 'free',
      // Clear caps so team.js plan-based logic returns Free defaults (0).
      max_team_members_agency: null,
      max_team_members_client: null,
    })
    .eq('id', agency.id);

  await sendEmail({
    to: agency.email,
    subject: 'VoiceAI Connect Subscription Cancelled',
    html: `
      <h2>Your subscription has been cancelled</h2>
      <p>Hi ${agency.name},</p>
      <p>Your VoiceAI Connect subscription has been cancelled. Your agency and all client AI assistants will be suspended.</p>
      <p>To reactivate, visit your dashboard.</p>
    `,
  });
}

async function handleAgencyPaymentSucceeded(invoice) {
  console.log('✅ Agency payment succeeded:', invoice.id);

  const agency = await getAgencyByStripeCustomerId(invoice.customer);
  if (!agency) return;

  await supabase
    .from('agencies')
    .update({
      subscription_status: 'active',
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
    subject: '🚨 VoiceAI Connect Payment Failed - Action Required',
    html: `
      <h2>Payment Failed</h2>
      <p>Hi ${agency.name},</p>
      <p>We couldn't process your payment. Please update your payment method to avoid service interruption.</p>
      <p><a href="${invoice.hosted_invoice_url}">Update Payment Method</a></p>
    `,
  });
}

async function handleAgencyTrialEnding(subscription) {
  console.log('⏰ Agency trial ending:', subscription.id);

  const agency = await getAgencyByStripeCustomerId(subscription.customer);
  if (!agency) return;

  const trialEnd = new Date(subscription.trial_end * 1000);
  const daysLeft = Math.ceil((trialEnd - new Date()) / (1000 * 60 * 60 * 24));

  await sendEmail({
    to: agency.email,
    subject: `⏰ Your VoiceAI Connect trial ends in ${daysLeft} days`,
    html: `
      <h2>Your trial is ending soon</h2>
      <p>Hi ${agency.name},</p>
      <p>Your 14-day trial ends on ${trialEnd.toLocaleDateString()}.</p>
      <p>Add a payment method to continue growing your AI agency.</p>
    `,
  });
}

// ============================================================================
// CRON: WARN AGENCIES WITH TRIALS ENDING IN 3 DAYS
// ----------------------------------------------------------------------------
// server.js imports this for /api/cron/warn-agency-trials. The original file
// declared the import in server.js but never defined or exported the function,
// which would crash the cron endpoint with "warnExpiringAgencyTrials is not a
// function". Stripe also fires customer.subscription.trial_will_end 3 days
// before trial end automatically, so this is a redundant safety net.
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
        await sendEmail({
          to: agency.email,
          subject: '⏰ Your VoiceAI Connect trial ends in 3 days',
          html: `
            <h2>Your trial ends soon</h2>
            <p>Hi ${agency.name},</p>
            <p>Your 14-day trial of the ${PLATFORM_PLANS[agency.plan_type]?.name || agency.plan_type} plan ends on ${new Date(agency.trial_ends_at).toLocaleDateString()}.</p>
            <p>Add a payment method now to keep your agency active and avoid service interruption.</p>
          `,
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
// EXPORTS
// ============================================================================
module.exports = {
  createAgencyCheckout,
  createAgencyPortal,
  handlePlatformStripeWebhook,
  warnExpiringAgencyTrials,
  canAgencyAddClient,
  PLATFORM_PLANS,
  PLATFORM_PRICES,
  PLAN_DETAILS,
};
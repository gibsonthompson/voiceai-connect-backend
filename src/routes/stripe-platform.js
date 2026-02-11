// ============================================================================
// STRIPE PLATFORM BILLING - Agencies Pay Platform
// ============================================================================
const Stripe = require('stripe');
const { supabase, getAgencyByStripeCustomerId } = require('../lib/supabase');
const { 
  sendEmail,
  sendAgencyTrialEndingSMS,
  sendAgencyPaymentFailedSMS,
  sendAgencySubscriptionCanceledSMS
} = require('../lib/notifications');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Platform subscription price IDs (agencies pay these)
const PLATFORM_PRICES = {
  starter: process.env.STRIPE_PRICE_AGENCY_STARTER,       // $99/mo
  professional: process.env.STRIPE_PRICE_AGENCY_PRO,      // $199/mo
  enterprise: process.env.STRIPE_PRICE_AGENCY_ENTERPRISE  // $499/mo
};

const PLAN_DETAILS = {
  starter: { name: 'Starter', clientLimit: 25, price: 9900 },           // $99/mo - 25 clients max
  professional: { name: 'Professional', clientLimit: 100, price: 19900 }, // $199/mo - 100 clients max
  enterprise: { name: 'Enterprise', clientLimit: -1, price: 49900 }       // $499/mo - unlimited
}; // -1 = unlimited

// Referral commission rate - 40% to match GoHighLevel
const COMMISSION_RATE = 0.40; // 40%

// ============================================================================
// CREATE CHECKOUT SESSION (Agency subscribes to platform)
// ============================================================================
async function createAgencyCheckout(req, res) {
  try {
    const { agency_id, plan } = req.body;

    if (!agency_id || !plan) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['agency_id', 'plan']
      });
    }

    if (!PLATFORM_PRICES[plan]) {
      return res.status(400).json({ 
        error: 'Invalid plan',
        valid_plans: Object.keys(PLATFORM_PRICES)
      });
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

    console.log('🛒 Creating platform checkout for:', agency.email, 'Plan:', plan);

    // Create or get Stripe customer
    let customerId = agency.stripe_customer_id;
    
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: agency.email,
        name: agency.name,
        metadata: {
          agency_id: agency_id,
          type: 'agency'
        }
      });
      customerId = customer.id;

      await supabase
        .from('agencies')
        .update({ stripe_customer_id: customerId })
        .eq('id', agency_id);
    }

    // Create checkout session with 14-day trial
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{
        price: PLATFORM_PRICES[plan],
        quantity: 1
      }],
      subscription_data: {
        trial_period_days: 14,
        metadata: {
          agency_id: agency_id,
          plan: plan
        }
      },
      success_url: `${process.env.FRONTEND_URL}/onboarding?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/signup?canceled=true`,
      metadata: {
        agency_id: agency_id,
        plan: plan,
        type: 'agency_subscription'
      }
    });

    console.log('✅ Checkout session created:', session.id);

    res.json({
      success: true,
      sessionId: session.id,
      url: session.url
    });

  } catch (error) {
    console.error('❌ Checkout error:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
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
      return res.status(400).json({ error: 'No Stripe customer found' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: agency.stripe_customer_id,
      return_url: `${process.env.FRONTEND_URL}/agency/settings?tab=billing`
    });

    res.json({
      success: true,
      url: session.url
    });

  } catch (error) {
    console.error('❌ Portal error:', error);
    res.status(500).json({ error: 'Failed to create portal session' });
  }
}

// ============================================================================
// GET CLIENT LIMIT FOR PLAN
// ============================================================================
function getClientLimitForPlan(plan) {
  const details = PLAN_DETAILS[plan];
  if (!details) return 25; // Default to starter limit
  return details.clientLimit;
}

// ============================================================================
// CHECK IF AGENCY CAN ADD MORE CLIENTS
// ============================================================================
async function canAgencyAddClient(agencyId) {
  const { data: agency, error } = await supabase
    .from('agencies')
    .select('plan_type, subscription_status')
    .eq('id', agencyId)
    .single();

  if (error || !agency) {
    return { allowed: false, reason: 'Agency not found' };
  }

  // Check subscription is active or trialing
  if (!['active', 'trialing', 'trial'].includes(agency.subscription_status)) {
    return { allowed: false, reason: 'Subscription not active' };
  }

  // During trial, grant enterprise-level access (unlimited clients)
  const isTrialing = ['trialing', 'trial'].includes(agency.subscription_status);
  const effectivePlan = isTrialing ? 'enterprise' : agency.plan_type;
  const clientLimit = getClientLimitForPlan(effectivePlan);
  
  // -1 means unlimited
  if (clientLimit === -1) {
    return { allowed: true, limit: 'unlimited', current: 0 };
  }

  // Count current clients
  const { count, error: countError } = await supabase
    .from('clients')
    .select('*', { count: 'exact', head: true })
    .eq('agency_id', agencyId)
    .neq('status', 'deleted');

  if (countError) {
    return { allowed: false, reason: 'Error counting clients' };
  }

  const currentCount = count || 0;
  
  if (currentCount >= clientLimit) {
    return { 
      allowed: false, 
      reason: `Client limit reached (${currentCount}/${clientLimit}). Upgrade your plan to add more clients.`,
      limit: clientLimit,
      current: currentCount
    };
  }

  return { 
    allowed: true, 
    limit: clientLimit, 
    current: currentCount,
    remaining: clientLimit - currentCount
  };
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
  // Frontend sends 'plan_type', backend checkout sends 'plan' — check both
  const plan = session.metadata?.plan_type || session.metadata?.plan || 'starter';
  
  if (!agencyId) return;
  
  const planDetails = PLAN_DETAILS[plan];
  
  await supabase
    .from('agencies')
    .update({
      status: 'trial',
      subscription_status: 'trialing',
      plan_type: plan,
      stripe_subscription_id: session.subscription,
      trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      updated_at: new Date().toISOString()
    })
    .eq('id', agencyId);
  
  // Log event
  await supabase.from('agency_subscription_events').insert({
    agency_id: agencyId,
    event_type: 'checkout_completed',
    stripe_event_id: session.id,
    metadata: { plan }
  });
  
  console.log('✅ Agency activated:', agencyId, 'Plan:', plan);
}

async function handleAgencySubscriptionCreated(subscription) {
  console.log('📝 Agency subscription created:', subscription.id);
  
  const agency = await getAgencyByStripeCustomerId(subscription.customer);
  if (!agency) return;
  
  // Frontend sends 'plan_type', backend checkout sends 'plan' — check both
  const plan = subscription.metadata?.plan_type || subscription.metadata?.plan || 'starter';
  
  // Respect Stripe's actual status — don't override trialing with active
  const stripeStatus = subscription.status; // 'trialing', 'active', etc.
  
  await supabase
    .from('agencies')
    .update({
      stripe_subscription_id: subscription.id,
      subscription_status: stripeStatus,
      plan_type: plan
    })
    .eq('id', agency.id);
  
  console.log(`   Status: ${stripeStatus}, Plan: ${plan}`);
}

async function handleAgencySubscriptionUpdated(subscription) {
  console.log('🔄 Agency subscription updated:', subscription.id);
  
  const agency = await getAgencyByStripeCustomerId(subscription.customer);
  if (!agency) return;
  
  let status = subscription.status;
  let agencyStatus = agency.status;
  
  // Map Stripe status to our status
  if (status === 'active') {
    agencyStatus = 'active';
  } else if (status === 'trialing') {
    agencyStatus = 'trial';
  } else if (status === 'past_due') {
    agencyStatus = 'active'; // Keep active but flag past_due
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
        : null
    })
    .eq('id', agency.id);
  
  console.log(`   Stripe status: ${status} → agency status: ${agencyStatus}`);
}

async function handleAgencySubscriptionDeleted(subscription) {
  console.log('❌ Agency subscription deleted:', subscription.id);
  
  const agency = await getAgencyByStripeCustomerId(subscription.customer);
  if (!agency) return;
  
  await supabase
    .from('agencies')
    .update({
      subscription_status: 'canceled',
      status: 'suspended'
    })
    .eq('id', agency.id);
  
  // TODO: Disable all agency's client assistants
  
  // Send SMS notification
  await sendAgencySubscriptionCanceledSMS(agency);
}

async function handleAgencyPaymentSucceeded(invoice) {
  console.log('✅ Agency payment succeeded:', invoice.id, `Amount: $${(invoice.amount_paid / 100).toFixed(2)}`);
  
  const agency = await getAgencyByStripeCustomerId(invoice.customer);
  if (!agency) return;
  
  // =========================================================================
  // FIX: Don't override trialing status for $0 trial invoices
  // When Stripe starts a trial, it creates a $0 invoice and fires
  // invoice.payment_succeeded. Previously this blindly set status to 'active',
  // overwriting the correct 'trialing' status from checkout.session.completed.
  // =========================================================================
  if (invoice.amount_paid === 0) {
    console.log(`ℹ️ $0 invoice (trial) for ${agency.name} — skipping status update, keeping: ${agency.subscription_status}`);
    
    // Still log the event but don't change status
    await supabase.from('agency_subscription_events').insert({
      agency_id: agency.id,
      event_type: 'trial_invoice_paid',
      stripe_event_id: invoice.id,
      metadata: { amount: 0, note: 'Trial $0 invoice — status preserved' }
    }).catch(() => {}); // Non-critical
    
    return;
  }
  
  // Real payment ($1+) — this is a genuine paid invoice, activate the agency
  console.log(`💰 Real payment received for ${agency.name}: $${(invoice.amount_paid / 100).toFixed(2)}`);
  
  await supabase
    .from('agencies')
    .update({
      subscription_status: 'active',
      status: 'active',
      updated_at: new Date().toISOString()
    })
    .eq('id', agency.id);

  // =========================================================================
  // PROCESS REFERRAL COMMISSION (40%)
  // =========================================================================
  if (agency.referred_by) {
    try {
      // Find the referrer by their referral code
      const { data: referrer, error: referrerError } = await supabase
        .from('agencies')
        .select('id, name, referral_earnings_cents, referral_balance_cents, stripe_account_id')
        .eq('referral_code', agency.referred_by)
        .single();

      if (referrerError || !referrer) {
        console.warn(`⚠️ Referrer not found for code: ${agency.referred_by}`);
      } else {
        // Check for duplicate (same invoice already processed)
        const { data: existingCommission } = await supabase
          .from('referral_commissions')
          .select('id')
          .eq('stripe_invoice_id', invoice.id)
          .single();

        if (existingCommission) {
          console.log(`ℹ️ Commission already processed for invoice: ${invoice.id}`);
        } else {
          // Calculate commission (40% of payment)
          const paymentAmount = invoice.amount_paid; // in cents
          const commissionAmount = Math.round(paymentAmount * COMMISSION_RATE);

          // Create commission record
          const { error: insertError } = await supabase
            .from('referral_commissions')
            .insert({
              referrer_id: referrer.id,
              referred_id: agency.id,
              payment_amount_cents: paymentAmount,
              commission_rate: COMMISSION_RATE,
              commission_amount_cents: commissionAmount,
              stripe_invoice_id: invoice.id,
              status: 'pending'
            });

          if (insertError) {
            console.error('❌ Error inserting commission:', insertError);
          } else {
            // Update referrer's earnings and balance
            await supabase
              .from('agencies')
              .update({
                referral_earnings_cents: (referrer.referral_earnings_cents || 0) + commissionAmount,
                referral_balance_cents: (referrer.referral_balance_cents || 0) + commissionAmount
              })
              .eq('id', referrer.id);

            console.log(`💰 Referral commission: $${(commissionAmount / 100).toFixed(2)} for ${referrer.name} (referred ${agency.name})`);
          }
        }
      }
    } catch (commissionError) {
      console.error('❌ Error processing referral commission:', commissionError);
      // Don't throw - payment succeeded, commission is secondary
    }
  }
  // =========================================================================
}

async function handleAgencyPaymentFailed(invoice) {
  console.log('❌ Agency payment failed:', invoice.id);
  
  const agency = await getAgencyByStripeCustomerId(invoice.customer);
  if (!agency) return;
  
  // Don't mark as past_due for $0 trial invoices that fail (edge case)
  if (invoice.amount_due === 0) {
    console.log(`ℹ️ $0 invoice failure for ${agency.name} — skipping status update`);
    return;
  }
  
  await supabase
    .from('agencies')
    .update({
      subscription_status: 'past_due'
    })
    .eq('id', agency.id);
  
  // Send SMS notification
  await sendAgencyPaymentFailedSMS(agency);
}

async function handleAgencyTrialEnding(subscription) {
  console.log('⏰ Agency trial ending:', subscription.id);
  
  const agency = await getAgencyByStripeCustomerId(subscription.customer);
  if (!agency) return;
  
  const trialEnd = new Date(subscription.trial_end * 1000);
  const daysLeft = Math.ceil((trialEnd - new Date()) / (1000 * 60 * 60 * 24));
  
  // Send SMS notification
  await sendAgencyTrialEndingSMS(agency, daysLeft);
}

// ============================================================================
// EXPORTS
// ============================================================================
module.exports = {
  createAgencyCheckout,
  createAgencyPortal,
  handlePlatformStripeWebhook,
  getClientLimitForPlan,
  canAgencyAddClient,
  PLATFORM_PRICES,
  PLAN_DETAILS
};
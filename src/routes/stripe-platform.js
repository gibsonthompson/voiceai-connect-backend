// ============================================================================
// STRIPE PLATFORM BILLING - Agencies Pay Platform
// ============================================================================
const Stripe = require('stripe');
const { supabase, getAgencyByStripeCustomerId } = require('../lib/supabase');
const { sendEmail } = require('../lib/notifications');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Platform subscription price IDs (agencies pay these)
const PLATFORM_PRICES = {
  starter: process.env.STRIPE_PRICE_AGENCY_STARTER,       // $99/mo
  professional: process.env.STRIPE_PRICE_AGENCY_PRO,      // $199/mo
  enterprise: process.env.STRIPE_PRICE_AGENCY_ENTERPRISE  // $299/mo
};

const PLAN_DETAILS = {
  starter: { name: 'Starter', clientLimit: 50, price: 9900 },        // $99/mo - 50 clients max
  professional: { name: 'Professional', clientLimit: -1, price: 19900 }, // $199/mo - unlimited
  enterprise: { name: 'Enterprise', clientLimit: -1, price: 29900 }      // $299/mo - unlimited + priority support
}; // -1 = unlimited

// Referral commission rate
const COMMISSION_RATE = 0.20; // 20%

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
      return_url: `${process.env.FRONTEND_URL}/agency/settings/billing`
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
  const plan = session.metadata?.plan || 'starter';
  
  if (!agencyId) return;
  
  const planDetails = PLAN_DETAILS[plan];
  
  await supabase
    .from('agencies')
    .update({
      status: 'trial',
      subscription_status: 'trial',
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
  
  console.log('✅ Agency activated:', agencyId);
}

async function handleAgencySubscriptionCreated(subscription) {
  console.log('📝 Agency subscription created:', subscription.id);
  
  const agency = await getAgencyByStripeCustomerId(subscription.customer);
  if (!agency) return;
  
  const plan = subscription.metadata?.plan || 'starter';
  
  await supabase
    .from('agencies')
    .update({
      stripe_subscription_id: subscription.id,
      subscription_status: subscription.status,
      plan_type: plan
    })
    .eq('id', agency.id);
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
  
  await sendEmail({
    to: agency.email,
    subject: 'VoiceAI Connect Subscription Cancelled',
    html: `
      <h2>Your subscription has been cancelled</h2>
      <p>Hi ${agency.name},</p>
      <p>Your VoiceAI Connect subscription has been cancelled. Your agency and all client AI assistants will be suspended.</p>
      <p>To reactivate, visit your dashboard.</p>
    `
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
      status: 'active'
    })
    .eq('id', agency.id);

  // =========================================================================
  // PROCESS REFERRAL COMMISSION
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
          // Calculate commission (20% of payment)
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
  
  await supabase
    .from('agencies')
    .update({
      subscription_status: 'past_due'
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
    `
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
    `
  });
}

// ============================================================================
// EXPORTS
// ============================================================================
module.exports = {
  createAgencyCheckout,
  createAgencyPortal,
  handlePlatformStripeWebhook,
  PLATFORM_PRICES,
  PLAN_DETAILS
};
// ============================================================================
// STRIPE CONNECT - Clients Pay Agencies Directly
// UPDATED: expireTrials disables VAPI phone number (not just static assistant)
// UPDATED: reactivation re-enables VAPI phone number
// ============================================================================
const Stripe = require('stripe');
const { 
  supabase, 
  getAgencyById, 
  getAgencyByStripeAccountId,
  getClientByStripeConnectedCustomerId,
  getClientById
} = require('../lib/supabase');
const { 
  sendEmail,
  sendClientTrialExpiredSMS,
  sendClientPaymentFailedSMS,
  sendClientSubscriptionActivatedSMS,
  sendPlatformNotificationSMS
} = require('../lib/notifications');
const { enableAssistant, disableAssistant, disablePhoneNumber, enablePhoneNumber } = require('../lib/vapi');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ============================================================================
// COUNTRY → CURRENCY MAPPING
// ============================================================================
const countryCurrencyMap = {
  US: 'usd', CA: 'cad', GB: 'gbp', MX: 'mxn', BR: 'brl',
  // Eurozone
  AT: 'eur', BE: 'eur', CY: 'eur', EE: 'eur', FI: 'eur', FR: 'eur',
  DE: 'eur', GR: 'eur', IE: 'eur', IT: 'eur', LV: 'eur', LT: 'eur',
  LU: 'eur', MT: 'eur', NL: 'eur', PT: 'eur', SK: 'eur', SI: 'eur',
  ES: 'eur', HR: 'eur',
  // Europe non-Euro
  BG: 'bgn', CZ: 'czk', DK: 'dkk', HU: 'huf', NO: 'nok',
  PL: 'pln', RO: 'ron', SE: 'sek', CH: 'chf',
  // Asia-Pacific
  AU: 'aud', NZ: 'nzd', JP: 'jpy', SG: 'sgd', HK: 'hkd',
  MY: 'myr', TH: 'thb', IN: 'inr',
  // Middle East
  AE: 'aed',
};

function getCurrencyForCountry(countryCode) {
  return countryCurrencyMap[countryCode] || 'usd';
}

// ============================================================================
// CREATE CONNECT ACCOUNT LINK (Agency onboards to Stripe Connect)
// ============================================================================
async function createConnectAccountLink(req, res) {
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

    console.log('Creating Stripe Connect account for:', agency.name, '| Country:', agency.country || 'US');

    // Create or get Connect account
    let accountId = agency.stripe_account_id;

    if (!accountId) {
      // Create Express account with agency's country
      const account = await stripe.accounts.create({
        type: 'express',
        country: agency.country || 'US',
        email: agency.email,
        metadata: {
          agency_id: agency_id
        },
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true }
        }
      });
      
      accountId = account.id;

      // Save account ID
      await supabase
        .from('agencies')
        .update({ stripe_account_id: accountId })
        .eq('id', agency_id);

      console.log('Connect account created:', accountId, '| Country:', agency.country || 'US');
    }

    // Create account link for onboarding
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${process.env.FRONTEND_URL}/agency/settings?tab=payments&refresh=true`,
      return_url: `${process.env.FRONTEND_URL}/agency/settings?tab=payments&success=true`,
      type: 'account_onboarding'
    });

    console.log('Connect onboarding link created');

    res.json({
      success: true,
      url: accountLink.url,
      account_id: accountId
    });

  } catch (error) {
    console.error('Connect account error:', error);
    res.status(500).json({ error: 'Failed to create Connect account' });
  }
}

// ============================================================================
// GET CONNECT STATUS
// ============================================================================
async function getConnectStatus(req, res) {
  try {
    const { agencyId } = req.params;

    const { data: agency, error } = await supabase
      .from('agencies')
      .select('stripe_account_id, stripe_onboarding_complete, stripe_charges_enabled, stripe_payouts_enabled')
      .eq('id', agencyId)
      .single();

    if (error || !agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    if (!agency.stripe_account_id) {
      return res.json({
        connected: false,
        onboarding_complete: false,
        charges_enabled: false,
        payouts_enabled: false
      });
    }

    // Get fresh status from Stripe
    const account = await stripe.accounts.retrieve(agency.stripe_account_id);

    // Update database if status changed
    if (
      account.charges_enabled !== agency.stripe_charges_enabled ||
      account.payouts_enabled !== agency.stripe_payouts_enabled
    ) {
      await supabase
        .from('agencies')
        .update({
          stripe_charges_enabled: account.charges_enabled,
          stripe_payouts_enabled: account.payouts_enabled,
          stripe_onboarding_complete: account.charges_enabled && account.payouts_enabled
        })
        .eq('id', agencyId);
    }

    res.json({
      connected: true,
      account_id: agency.stripe_account_id,
      onboarding_complete: account.charges_enabled && account.payouts_enabled,
      charges_enabled: account.charges_enabled,
      payouts_enabled: account.payouts_enabled,
      details_submitted: account.details_submitted
    });

  } catch (error) {
    console.error('Connect status error:', error);
    res.status(500).json({ error: 'Failed to get Connect status' });
  }
}

// ============================================================================
// DISCONNECT CONNECT ACCOUNT
// ============================================================================
async function disconnectConnectAccount(req, res) {
  try {
    const { agencyId } = req.params;

    if (!agencyId) {
      return res.status(400).json({ error: 'agencyId required' });
    }

    // Get agency
    const { data: agency, error: fetchError } = await supabase
      .from('agencies')
      .select('stripe_account_id, name')
      .eq('id', agencyId)
      .single();

    if (fetchError || !agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    if (!agency.stripe_account_id) {
      return res.status(400).json({ error: 'No Stripe account connected' });
    }

    console.log('Disconnecting Stripe Connect for:', agency.name);

    // Clear the Connect account from database
    const { error: updateError } = await supabase
      .from('agencies')
      .update({
        stripe_account_id: null,
        stripe_onboarding_complete: false,
        stripe_charges_enabled: false,
        stripe_payouts_enabled: false,
        updated_at: new Date().toISOString()
      })
      .eq('id', agencyId);

    if (updateError) {
      console.error('Failed to update agency:', updateError);
      return res.status(500).json({ error: 'Failed to disconnect account' });
    }

    console.log('Stripe Connect disconnected for:', agency.name);

    res.json({
      success: true,
      message: 'Stripe account disconnected'
    });

  } catch (error) {
    console.error('Disconnect Connect error:', error);
    res.status(500).json({ error: 'Failed to disconnect Stripe account' });
  }
}

// ============================================================================
// CREATE CLIENT CHECKOUT (Client subscribes via agency's Connect account)
// ============================================================================
async function createClientCheckout(req, res) {
  try {
    const { client_id, plan } = req.body;

    if (!client_id || !plan) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['client_id', 'plan']
      });
    }

    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select(`
        *,
        agencies (*)
      `)
      .eq('id', client_id)
      .single();

    if (clientError || !client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const agency = client.agencies;

    if (!agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    if (!agency.stripe_account_id || !agency.stripe_charges_enabled) {
      return res.status(400).json({ 
        error: 'Agency has not completed Stripe Connect setup'
      });
    }

    console.log('Creating client checkout for:', client.email, 'via agency:', agency.name);

    const priceAmounts = {
      starter: agency.price_starter || 4900,
      pro: agency.price_pro || 9900,
      growth: agency.price_growth || 14900
    };

    const callLimits = {
      starter: agency.limit_starter || 50,
      pro: agency.limit_pro || 150,
      growth: agency.limit_growth || 500
    };

    const priceAmount = priceAmounts[plan];
    if (!priceAmount) {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    const currency = getCurrencyForCountry(agency.country || 'US');

    let connectedCustomerId = client.stripe_connected_customer_id;

    if (!connectedCustomerId) {
      const customer = await stripe.customers.create({
        email: client.email,
        name: client.owner_name || client.business_name,
        metadata: {
          client_id: client_id,
          business_name: client.business_name
        }
      }, {
        stripeAccount: agency.stripe_account_id
      });

      connectedCustomerId = customer.id;

      await supabase
        .from('clients')
        .update({ stripe_connected_customer_id: connectedCustomerId })
        .eq('id', client_id);
    }

    const product = await stripe.products.create({
      name: `AI Receptionist - ${plan.charAt(0).toUpperCase() + plan.slice(1)}`,
      metadata: { client_id, plan }
    }, {
      stripeAccount: agency.stripe_account_id
    });

    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: priceAmount,
      currency: currency,
      recurring: { interval: 'month' }
    }, {
      stripeAccount: agency.stripe_account_id
    });

    const agencyUrl = agency.marketing_domain && agency.domain_verified
      ? `https://${agency.marketing_domain}`
      : `https://${agency.slug}.myvoiceaiconnect.com`;

    const session = await stripe.checkout.sessions.create({
      customer: connectedCustomerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{
        price: price.id,
        quantity: 1
      }],
      success_url: `${agencyUrl}/client/dashboard?upgrade=success`,
      cancel_url: `${agencyUrl}/client/upgrade?canceled=true`,
      metadata: {
        client_id: client_id,
        agency_id: agency.id,
        plan: plan,
        call_limit: callLimits[plan].toString(),
        type: 'client_subscription'
      },
      subscription_data: {
        metadata: {
          client_id: client_id,
          agency_id: agency.id,
          plan: plan
        }
      }
    }, {
      stripeAccount: agency.stripe_account_id
    });

    console.log('Client checkout created:', session.id, '| Currency:', currency);

    res.json({
      success: true,
      sessionId: session.id,
      url: session.url
    });

  } catch (error) {
    console.error('Client checkout error:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
}

// ============================================================================
// CREATE CLIENT PORTAL (Client manages subscription on agency's Connect)
// ============================================================================
async function createClientPortal(req, res) {
  try {
    const { client_id } = req.body;

    if (!client_id) {
      return res.status(400).json({ error: 'client_id required' });
    }

    const client = await getClientById(client_id);

    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    if (!client.stripe_connected_customer_id) {
      return res.status(400).json({ error: 'No Stripe customer found' });
    }

    const agency = client.agencies;
    if (!agency?.stripe_account_id) {
      return res.status(400).json({ error: 'Agency Connect not configured' });
    }

    const agencyUrl = agency.marketing_domain && agency.domain_verified
      ? `https://${agency.marketing_domain}`
      : `https://${agency.slug}.myvoiceaiconnect.com`;

    const session = await stripe.billingPortal.sessions.create({
      customer: client.stripe_connected_customer_id,
      return_url: `${agencyUrl}/client/billing`
    }, {
      stripeAccount: agency.stripe_account_id
    });

    res.json({
      success: true,
      url: session.url
    });

  } catch (error) {
    console.error('Client portal error:', error);
    res.status(500).json({ error: 'Failed to create portal session' });
  }
}

// ============================================================================
// EXPIRE TRIALS - Cron job to disable expired trials
// UPDATED: Now disables the VAPI phone number (removes serverUrl) instead of
// just the static assistant. Since Phase 2 dynamic assistant-request, the
// phone number's serverUrl is what matters — the static assistant is just
// a fallback reference.
//
// Also keeps the old disableAssistant call as belt-and-suspenders.
// ============================================================================
async function expireTrials() {
  console.log('Checking for expired trials...');

  const now = new Date().toISOString();

  const { data: expiredClients, error } = await supabase
    .from('clients')
    .select('*, agencies(*)')
    .eq('subscription_status', 'trial')
    .lt('trial_ends_at', now);

  if (error) {
    console.error('Error fetching expired trials:', error);
    return { success: false, error: error.message };
  }

  console.log(`Found ${expiredClients?.length || 0} expired trials`);

  const results = [];

  for (const client of expiredClients || []) {
    try {
      // ── Disable VAPI phone number (PRIMARY — stops calls from routing) ──
      if (client.vapi_phone_id) {
        try {
          await disablePhoneNumber(client.vapi_phone_id);
          console.log('✅ VAPI phone number disabled (serverUrl removed):', client.vapi_phone_id);
        } catch (phoneError) {
          console.error('❌ Failed to disable VAPI phone number:', phoneError.message);
        }
      } else {
        console.warn('⚠️ No vapi_phone_id for client:', client.business_name, '— phone number not disabled');
      }

      // ── Disable static assistant (SECONDARY — belt-and-suspenders) ──
      if (client.vapi_assistant_id) {
        try {
          await disableAssistant(client.vapi_assistant_id);
          console.log('✅ VAPI static assistant disabled:', client.vapi_assistant_id);
        } catch (vapiError) {
          console.error('⚠️ Failed to disable VAPI assistant (non-critical):', vapiError.message);
        }
      }

      // ── Update client status ──
      await supabase
        .from('clients')
        .update({
          subscription_status: 'trial_expired',
          status: 'suspended'
        })
        .eq('id', client.id);

      const agency = client.agencies;
      await sendClientTrialExpiredSMS(client, agency);

      console.log('✅ Trial expired for:', client.business_name);
      results.push({ id: client.id, business_name: client.business_name, success: true });

    } catch (err) {
      console.error('Error expiring trial for', client.id, err);
      results.push({ id: client.id, business_name: client.business_name, success: false, error: err.message });
    }
  }

  return { success: true, processed: results.length, results };
}

// ============================================================================
// WEBHOOK HANDLER - Connected Account Events
// ============================================================================
async function handleConnectStripeWebhook(req, res) {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_CONNECT_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Connect webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('Connect webhook:', event.type, '| Account:', event.account);

  try {
    switch (event.type) {
      case 'account.updated':
        await handleAccountUpdated(event.data.object);
        break;

      case 'checkout.session.completed':
        await handleClientCheckoutCompleted(event.data.object, event.account);
        break;

      case 'customer.subscription.updated':
        await handleClientSubscriptionUpdated(event.data.object, event.account);
        break;

      case 'customer.subscription.deleted':
        await handleClientSubscriptionDeleted(event.data.object, event.account);
        break;

      case 'invoice.payment_succeeded':
        await handleClientPaymentSucceeded(event.data.object, event.account);
        break;

      case 'invoice.payment_failed':
        await handleClientPaymentFailed(event.data.object, event.account);
        break;
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Connect webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
}

// ============================================================================
// CONNECT WEBHOOK HANDLERS
// ============================================================================

async function handleAccountUpdated(account) {
  console.log('Connect account updated:', account.id);

  const agency = await getAgencyByStripeAccountId(account.id);
  if (!agency) return;

  await supabase
    .from('agencies')
    .update({
      stripe_charges_enabled: account.charges_enabled,
      stripe_payouts_enabled: account.payouts_enabled,
      stripe_onboarding_complete: account.charges_enabled && account.payouts_enabled
    })
    .eq('id', agency.id);

  if (account.charges_enabled && !agency.stripe_charges_enabled) {
    console.log('Agency can now accept payments:', agency.name);
    
    // Notify platform owner — key conversion milestone
    sendPlatformNotificationSMS(
      `Agency Connected Stripe\n` +
      `Name: ${agency.name}\n` +
      `Email: ${agency.email || 'N/A'}\n` +
      `Plan: ${agency.plan_type || 'starter'}\n` +
      `Ready to accept client payments`
    ).catch(err => console.error('Failed to send Stripe connect notification:', err));
  }
}

async function handleClientCheckoutCompleted(session, stripeAccountId) {
  console.log('Client checkout completed:', session.id);

  const clientId = session.metadata?.client_id;
  const plan = session.metadata?.plan || 'starter';
  const callLimit = parseInt(session.metadata?.call_limit) || 50;

  if (!clientId) {
    console.error('No client_id in checkout metadata');
    return;
  }

  const { data: client, error } = await supabase
    .from('clients')
    .select('*, agencies(*)')
    .eq('id', clientId)
    .single();

  if (error || !client) {
    console.error('Client not found:', clientId);
    return;
  }

  const isUpgrade = client.subscription_status === 'trial_expired' || 
                    client.subscription_status === 'canceled' ||
                    client.subscription_status === 'past_due';

  const { error: updateError } = await supabase
    .from('clients')
    .update({
      subscription_status: 'active',
      plan_type: plan,
      monthly_call_limit: callLimit,
      stripe_connected_subscription_id: session.subscription,
      trial_ends_at: null,
      status: 'active',
      calls_this_month: 0
    })
    .eq('id', clientId);

  if (updateError) {
    console.error('Failed to update client:', updateError);
    return;
  }

  console.log(`Client ${isUpgrade ? 'upgraded' : 'activated'}:`, client.business_name);

  // ── Re-enable VAPI phone number (PRIMARY — restores call routing) ──
  if (client.vapi_phone_id) {
    try {
      await enablePhoneNumber(client.vapi_phone_id);
      console.log('✅ VAPI phone number re-enabled:', client.vapi_phone_id);
    } catch (phoneError) {
      console.error('❌ Failed to re-enable VAPI phone number:', phoneError.message);
    }
  }

  // ── Re-enable static assistant (SECONDARY — belt-and-suspenders) ──
  if (client.vapi_assistant_id) {
    try {
      await enableAssistant(client.vapi_assistant_id);
      console.log('✅ VAPI assistant re-enabled:', client.vapi_assistant_id);
    } catch (vapiError) {
      console.error('⚠️ Failed to re-enable VAPI assistant (non-critical):', vapiError.message);
    }
  }

  if (session.amount_total > 0) {
    await supabase
      .from('payments')
      .insert({
        client_id: clientId,
        agency_id: client.agency_id,
        stripe_payment_intent_id: session.payment_intent,
        stripe_subscription_id: session.subscription,
        amount: session.amount_total,
        currency: session.currency || 'usd',
        status: 'succeeded',
        type: 'subscription',
        description: `${isUpgrade ? 'Upgrade' : 'Initial'} subscription - ${plan} plan`,
        plan_type: plan,
        paid_out: false
      });
    
    console.log(`Payment recorded: ${session.currency?.toUpperCase() || 'USD'} ${(session.amount_total / 100).toFixed(2)}`);
  }

  const agency = client.agencies;
  await sendClientSubscriptionActivatedSMS(client, agency, plan);
}

async function handleClientSubscriptionUpdated(subscription, stripeAccountId) {
  console.log('Client subscription updated:', subscription.id);

  const client = await getClientByStripeConnectedCustomerId(
    subscription.customer, 
    stripeAccountId
  );
  if (!client) return;

  let status = subscription.status;
  let clientStatus = client.status;

  if (status === 'active') {
    clientStatus = 'active';
    // Re-enable phone number when subscription becomes active
    if (client.vapi_phone_id) {
      await enablePhoneNumber(client.vapi_phone_id).catch(err =>
        console.error('Failed to enable phone on subscription update:', err.message)
      );
    }
    if (client.vapi_assistant_id) {
      await enableAssistant(client.vapi_assistant_id);
    }
  } else if (status === 'canceled' || status === 'unpaid') {
    clientStatus = 'suspended';
    // Disable phone number when subscription is canceled/unpaid
    if (client.vapi_phone_id) {
      await disablePhoneNumber(client.vapi_phone_id).catch(err =>
        console.error('Failed to disable phone on subscription cancel:', err.message)
      );
    }
    if (client.vapi_assistant_id) {
      await disableAssistant(client.vapi_assistant_id);
    }
  }

  await supabase
    .from('clients')
    .update({
      subscription_status: status,
      status: clientStatus,
      trial_ends_at: subscription.trial_end 
        ? new Date(subscription.trial_end * 1000) 
        : null
    })
    .eq('id', client.id);
}

async function handleClientSubscriptionDeleted(subscription, stripeAccountId) {
  console.log('Client subscription deleted:', subscription.id);

  const client = await getClientByStripeConnectedCustomerId(
    subscription.customer,
    stripeAccountId
  );
  if (!client) return;

  // Disable phone number (PRIMARY)
  if (client.vapi_phone_id) {
    try {
      await disablePhoneNumber(client.vapi_phone_id);
      console.log('✅ VAPI phone number disabled:', client.vapi_phone_id);
    } catch (phoneError) {
      console.error('❌ Failed to disable VAPI phone number:', phoneError.message);
    }
  }

  // Disable static assistant (SECONDARY)
  if (client.vapi_assistant_id) {
    try {
      await disableAssistant(client.vapi_assistant_id);
      console.log('✅ VAPI assistant disabled:', client.vapi_assistant_id);
    } catch (vapiError) {
      console.error('Failed to disable VAPI assistant:', vapiError);
    }
  }

  await supabase
    .from('clients')
    .update({
      subscription_status: 'canceled',
      status: 'suspended'
    })
    .eq('id', client.id);
}

async function handleClientPaymentSucceeded(invoice, stripeAccountId) {
  console.log('Client payment succeeded:', invoice.id);

  const client = await getClientByStripeConnectedCustomerId(
    invoice.customer,
    stripeAccountId
  );
  
  if (!client) {
    console.error('Client not found for payment:', invoice.customer);
    return;
  }

  await supabase
    .from('clients')
    .update({
      subscription_status: 'active',
      status: 'active',
      calls_this_month: 0
    })
    .eq('id', client.id);

  // Re-enable phone number on successful payment (PRIMARY)
  if (client.vapi_phone_id) {
    try {
      await enablePhoneNumber(client.vapi_phone_id);
    } catch (phoneError) {
      console.error('Failed to enable VAPI phone number:', phoneError.message);
    }
  }

  // Re-enable static assistant (SECONDARY)
  if (client.vapi_assistant_id) {
    try {
      await enableAssistant(client.vapi_assistant_id);
    } catch (vapiError) {
      console.error('Failed to enable VAPI assistant:', vapiError);
    }
  }

  await supabase
    .from('payments')
    .insert({
      client_id: client.id,
      agency_id: client.agency_id,
      stripe_invoice_id: invoice.id,
      stripe_payment_intent_id: invoice.payment_intent,
      stripe_charge_id: invoice.charge,
      stripe_subscription_id: invoice.subscription,
      amount: invoice.amount_paid || 0,
      currency: invoice.currency || 'usd',
      status: 'succeeded',
      type: 'subscription',
      description: invoice.lines?.data?.[0]?.description || 'Subscription payment',
      plan_type: client.plan_type,
      paid_out: false
    });

  console.log(`Payment recorded: ${(invoice.currency || 'usd').toUpperCase()} ${((invoice.amount_paid || 0) / 100).toFixed(2)}`);
}

async function handleClientPaymentFailed(invoice, stripeAccountId) {
  console.log('Client payment failed:', invoice.id);

  const client = await getClientByStripeConnectedCustomerId(
    invoice.customer,
    stripeAccountId
  );
  if (!client) return;

  await supabase
    .from('clients')
    .update({
      subscription_status: 'past_due'
    })
    .eq('id', client.id);

  const agency = client.agencies;
  await sendClientPaymentFailedSMS(client, agency, invoice.hosted_invoice_url);
}

// ============================================================================
// EXPORTS
// ============================================================================
module.exports = {
  createConnectAccountLink,
  getConnectStatus,
  disconnectConnectAccount,
  createClientCheckout,
  createClientPortal,
  handleConnectStripeWebhook,
  expireTrials
};
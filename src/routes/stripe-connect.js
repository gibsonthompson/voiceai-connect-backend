// ============================================================================
// STRIPE CONNECT - Clients Pay Agencies Directly
// ============================================================================
const Stripe = require('stripe');
const { 
  supabase, 
  getAgencyById, 
  getAgencyByStripeAccountId,
  getClientByStripeConnectedCustomerId,
  getClientById
} = require('../lib/supabase');
const { sendEmail } = require('../lib/notifications');
const { enableAssistant, disableAssistant } = require('../lib/vapi');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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

    console.log('🔗 Creating Stripe Connect account for:', agency.name);

    // Create or get Connect account
    let accountId = agency.stripe_account_id;

    if (!accountId) {
      // Create Express account
      const account = await stripe.accounts.create({
        type: 'express',
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

      console.log('✅ Connect account created:', accountId);
    }

    // Create account link for onboarding
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${process.env.FRONTEND_URL}/agency/settings?tab=payments&refresh=true`,
      return_url: `${process.env.FRONTEND_URL}/agency/settings?tab=payments&success=true`,
      type: 'account_onboarding'
    });

    console.log('✅ Connect onboarding link created');

    res.json({
      success: true,
      url: accountLink.url,
      account_id: accountId
    });

  } catch (error) {
    console.error('❌ Connect account error:', error);
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
    console.error('❌ Connect status error:', error);
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

    console.log('🔌 Disconnecting Stripe Connect for:', agency.name);

    // Note: We don't delete the Stripe account - just remove the association
    // The agency can reconnect later or the account stays in Stripe

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
      console.error('❌ Failed to update agency:', updateError);
      return res.status(500).json({ error: 'Failed to disconnect account' });
    }

    console.log('✅ Stripe Connect disconnected for:', agency.name);

    res.json({
      success: true,
      message: 'Stripe account disconnected'
    });

  } catch (error) {
    console.error('❌ Disconnect Connect error:', error);
    res.status(500).json({ error: 'Failed to disconnect Stripe account' });
  }
}

// ============================================================================
// CREATE CLIENT CHECKOUT (Client subscribes via agency's Connect account)
// ============================================================================
async function createClientCheckout(req, res) {
  try {
    const { client_id, plan, agency_id } = req.body;

    if (!client_id || !plan || !agency_id) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['client_id', 'plan', 'agency_id']
      });
    }

    // Get agency with Connect account
    const { data: agency, error: agencyError } = await supabase
      .from('agencies')
      .select('*')
      .eq('id', agency_id)
      .single();

    if (agencyError || !agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    if (!agency.stripe_account_id || !agency.stripe_charges_enabled) {
      return res.status(400).json({ 
        error: 'Agency has not completed Stripe Connect setup'
      });
    }

    // Get client
    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('*')
      .eq('id', client_id)
      .eq('agency_id', agency_id)
      .single();

    if (clientError || !client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    console.log('🛒 Creating client checkout for:', client.email, 'via agency:', agency.name);

    // Get price from agency's settings
    const priceAmounts = {
      starter: agency.price_starter || 4900,
      pro: agency.price_pro || 9900,
      growth: agency.price_growth || 14900
    };

    const priceAmount = priceAmounts[plan];
    if (!priceAmount) {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    // Create customer on connected account
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

    // Create product on connected account
    const product = await stripe.products.create({
      name: `AI Receptionist - ${plan.charAt(0).toUpperCase() + plan.slice(1)}`,
      metadata: { client_id, plan }
    }, {
      stripeAccount: agency.stripe_account_id
    });

    // Create price on connected account
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: priceAmount,
      currency: 'usd',
      recurring: { interval: 'month' }
    }, {
      stripeAccount: agency.stripe_account_id
    });

    // Build success/cancel URLs
    const agencyUrl = agency.marketing_domain && agency.domain_verified
      ? `https://${agency.marketing_domain}`
      : `https://${agency.slug}.voiceaiconnect.com`;

    // Create checkout session on connected account
    const session = await stripe.checkout.sessions.create({
      customer: connectedCustomerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{
        price: price.id,
        quantity: 1
      }],
      subscription_data: {
        trial_period_days: 7,
        metadata: {
          client_id: client_id,
          agency_id: agency_id,
          plan: plan
        }
      },
      success_url: `${agencyUrl}/signup/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${agencyUrl}/signup?canceled=true`,
      metadata: {
        client_id: client_id,
        agency_id: agency_id,
        plan: plan,
        type: 'client_subscription'
      }
    }, {
      stripeAccount: agency.stripe_account_id
    });

    console.log('✅ Client checkout created:', session.id);

    res.json({
      success: true,
      sessionId: session.id,
      url: session.url
    });

  } catch (error) {
    console.error('❌ Client checkout error:', error);
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
      : `https://${agency.slug}.voiceaiconnect.com`;

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
    console.error('❌ Client portal error:', error);
    res.status(500).json({ error: 'Failed to create portal session' });
  }
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
    console.error('⚠️ Connect webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('📥 Connect webhook:', event.type, '| Account:', event.account);

  try {
    switch (event.type) {
      // Account events
      case 'account.updated':
        await handleAccountUpdated(event.data.object);
        break;

      // Client subscription events (on connected account)
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
    console.error('❌ Connect webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
}

// ============================================================================
// CONNECT WEBHOOK HANDLERS
// ============================================================================

async function handleAccountUpdated(account) {
  console.log('🔄 Connect account updated:', account.id);

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
    console.log('✅ Agency can now accept payments:', agency.name);
    // Send email notification
    await sendEmail({
      to: agency.email,
      subject: '✅ Stripe Connect Setup Complete!',
      html: `
        <h2>You can now accept payments!</h2>
        <p>Hi ${agency.name},</p>
        <p>Your Stripe Connect setup is complete. Client payments will now go directly to your Stripe account.</p>
        <p>Start acquiring clients with your signup link!</p>
      `
    });
  }
}

async function handleClientCheckoutCompleted(session, stripeAccountId) {
  console.log('🎉 Client checkout completed:', session.id);

  const clientId = session.metadata?.client_id;
  const plan = session.metadata?.plan || 'starter';

  if (!clientId) return;

  // Get plan limits from agency
  const client = await getClientById(clientId);
  if (!client) return;

  const agency = client.agencies;
  const callLimits = {
    starter: agency?.limit_starter || 50,
    pro: agency?.limit_pro || 150,
    growth: agency?.limit_growth || 500
  };

  await supabase
    .from('clients')
    .update({
      subscription_status: 'trial',
      plan_type: plan,
      monthly_call_limit: callLimits[plan],
      stripe_connected_subscription_id: session.subscription,
      trial_ends_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      status: 'active'
    })
    .eq('id', clientId);

  console.log('✅ Client activated:', clientId);
}

async function handleClientSubscriptionUpdated(subscription, stripeAccountId) {
  console.log('🔄 Client subscription updated:', subscription.id);

  const client = await getClientByStripeConnectedCustomerId(
    subscription.customer, 
    stripeAccountId
  );
  if (!client) return;

  let status = subscription.status;
  let clientStatus = client.status;

  if (status === 'active') {
    clientStatus = 'active';
    // Re-enable VAPI assistant
    if (client.vapi_assistant_id) {
      await enableAssistant(client.vapi_assistant_id);
    }
  } else if (status === 'canceled' || status === 'unpaid') {
    clientStatus = 'suspended';
    // Disable VAPI assistant
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
  console.log('❌ Client subscription deleted:', subscription.id);

  const client = await getClientByStripeConnectedCustomerId(
    subscription.customer,
    stripeAccountId
  );
  if (!client) return;

  // Disable VAPI assistant
  if (client.vapi_assistant_id) {
    await disableAssistant(client.vapi_assistant_id);
  }

  await supabase
    .from('clients')
    .update({
      subscription_status: 'canceled',
      status: 'suspended'
    })
    .eq('id', client.id);

  // Send cancellation email (branded with agency)
  const agency = client.agencies;
  const agencyName = agency?.name || 'Your AI Receptionist';

  await sendEmail({
    to: client.email,
    subject: `${agencyName} Subscription Cancelled`,
    html: `
      <p>Hi ${client.owner_name || client.business_name},</p>
      <p>Your AI receptionist subscription has been cancelled. Your phone number will stop answering calls.</p>
      <p>To reactivate, contact ${agency?.support_email || 'support'}.</p>
    `
  });
}

async function handleClientPaymentSucceeded(invoice, stripeAccountId) {
  console.log('✅ Client payment succeeded:', invoice.id);

  const client = await getClientByStripeConnectedCustomerId(
    invoice.customer,
    stripeAccountId
  );
  if (!client) return;

  await supabase
    .from('clients')
    .update({
      subscription_status: 'active',
      status: 'active',
      calls_this_month: 0 // Reset for new billing period
    })
    .eq('id', client.id);

  // Re-enable assistant if it was disabled
  if (client.vapi_assistant_id) {
    await enableAssistant(client.vapi_assistant_id);
  }
}

async function handleClientPaymentFailed(invoice, stripeAccountId) {
  console.log('❌ Client payment failed:', invoice.id);

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

  // Send payment failed email
  const agency = client.agencies;
  const agencyName = agency?.name || 'Your AI Receptionist';

  await sendEmail({
    to: client.email,
    subject: `🚨 ${agencyName} Payment Failed`,
    html: `
      <h2>Payment Failed</h2>
      <p>Hi ${client.owner_name || client.business_name},</p>
      <p>We couldn't process your payment. Please update your payment method to avoid service interruption.</p>
      <p><a href="${invoice.hosted_invoice_url}">Update Payment Method</a></p>
    `
  });
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
  handleConnectStripeWebhook
};
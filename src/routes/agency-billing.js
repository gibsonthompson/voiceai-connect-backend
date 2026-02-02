// routes/agency-billing.js
// Agency subscription management - portal and cancel

const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ============================================================================
// POST /api/agency/billing/portal
// Creates a Stripe billing portal session for the agency
// ============================================================================
router.post('/portal', async (req, res) => {
  try {
    const { agency_id } = req.body;

    if (!agency_id) {
      return res.status(400).json({ error: 'agency_id required' });
    }

    // Get agency
    const { data: agency, error } = await supabase
      .from('agencies')
      .select('id, name, email, stripe_customer_id')
      .eq('id', agency_id)
      .single();

    if (error || !agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    if (!agency.stripe_customer_id) {
      return res.status(400).json({ error: 'No Stripe customer found. Please contact support.' });
    }

    console.log('🔗 Creating billing portal for:', agency.name);

    // Create billing portal session
    const session = await stripe.billingPortal.sessions.create({
      customer: agency.stripe_customer_id,
      return_url: `${process.env.FRONTEND_URL}/agency/settings?tab=billing`,
    });

    console.log('✅ Billing portal created');

    res.json({
      success: true,
      url: session.url,
    });

  } catch (error) {
    console.error('❌ Billing portal error:', error);
    res.status(500).json({ error: 'Failed to create billing portal' });
  }
});

// ============================================================================
// POST /api/agency/billing/cancel
// Cancels the agency's subscription immediately
// ============================================================================
router.post('/cancel', async (req, res) => {
  try {
    const { agency_id } = req.body;

    if (!agency_id) {
      return res.status(400).json({ error: 'agency_id required' });
    }

    // Get agency
    const { data: agency, error } = await supabase
      .from('agencies')
      .select('id, name, email, stripe_subscription_id, subscription_status')
      .eq('id', agency_id)
      .single();

    if (error || !agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    console.log('🛑 Canceling subscription for:', agency.name);

    // Cancel Stripe subscription if exists
    if (agency.stripe_subscription_id) {
      try {
        await stripe.subscriptions.cancel(agency.stripe_subscription_id);
        console.log('✅ Stripe subscription canceled:', agency.stripe_subscription_id);
      } catch (stripeError) {
        console.error('Stripe cancel error:', stripeError);
        // Continue anyway - subscription might already be canceled
      }
    }

    // Update agency status
    const { error: updateError } = await supabase
      .from('agencies')
      .update({
        subscription_status: 'canceled',
        status: 'canceled',
        updated_at: new Date().toISOString(),
      })
      .eq('id', agency_id);

    if (updateError) {
      console.error('Failed to update agency:', updateError);
      return res.status(500).json({ error: 'Failed to update agency status' });
    }

    // Disable all agency's client assistants
    const { data: clients } = await supabase
      .from('clients')
      .select('id, vapi_assistant_id')
      .eq('agency_id', agency_id);

    if (clients && clients.length > 0) {
      // Update all clients to suspended
      await supabase
        .from('clients')
        .update({ 
          status: 'suspended',
          subscription_status: 'agency_canceled'
        })
        .eq('agency_id', agency_id);

      console.log(`⚠️ Suspended ${clients.length} clients for canceled agency`);
      
      // Optionally disable VAPI assistants
      // This would require importing the VAPI disable function
      // for (const client of clients) {
      //   if (client.vapi_assistant_id) {
      //     await disableAssistant(client.vapi_assistant_id);
      //   }
      // }
    }

    console.log('✅ Agency subscription canceled:', agency.name);

    res.json({
      success: true,
      message: 'Subscription canceled',
    });

  } catch (error) {
    console.error('❌ Cancel subscription error:', error);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

module.exports = router;

// ============================================================================
// USAGE: Add to your main routes file
// ============================================================================
// const agencyBillingRoutes = require('./routes/agency-billing');
// app.use('/api/agency/billing', agencyBillingRoutes);
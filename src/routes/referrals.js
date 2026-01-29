// ============================================================================
// REFERRAL SYSTEM ROUTES
// VoiceAI Connect - Agency referral program (20% recurring commission)
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase, getAgencyById } = require('../lib/supabase');

const COMMISSION_RATE = 0.20; // 20%

// ============================================================================
// GET /api/agency/:agencyId/referrals
// Get referral dashboard data for an agency
// ============================================================================
router.get('/:agencyId/referrals', async (req, res) => {
  try {
    const { agencyId } = req.params;

    // Get agency with referral info
    const { data: agency, error: agencyError } = await supabase
      .from('agencies')
      .select('id, referral_code, referral_earnings_cents, referral_balance_cents, stripe_account_id')
      .eq('id', agencyId)
      .single();

    if (agencyError || !agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    // Get referrals (agencies this agency referred)
    const { data: referrals, error: referralsError } = await supabase
      .from('agencies')
      .select('id, name, slug, status, subscription_status, plan_type, created_at')
      .eq('referred_by', agency.referral_code)
      .order('created_at', { ascending: false });

    if (referralsError) {
      console.error('Error fetching referrals:', referralsError);
    }

    // Get commission history
    const { data: commissions, error: commissionsError } = await supabase
      .from('referral_commissions')
      .select(`
        id,
        commission_amount_cents,
        status,
        created_at,
        transferred_at,
        referred:referred_id (
          name,
          slug
        )
      `)
      .eq('referrer_id', agencyId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (commissionsError) {
      console.error('Error fetching commissions:', commissionsError);
    }

    // Calculate stats
    const activeReferrals = referrals?.filter(r => 
      r.subscription_status === 'active' || r.subscription_status === 'trial'
    ).length || 0;

    const totalReferrals = referrals?.length || 0;

    // This month's earnings
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const thisMonthEarnings = commissions
      ?.filter(c => new Date(c.created_at) >= startOfMonth)
      .reduce((sum, c) => sum + c.commission_amount_cents, 0) || 0;

    // Build referral link
    const platformDomain = process.env.PLATFORM_DOMAIN || 'myvoiceaiconnect.com';
    const referralLink = `https://${platformDomain}/signup?ref=${agency.referral_code}`;

    res.json({
      referralCode: agency.referral_code,
      referralLink,
      canReceivePayouts: !!agency.stripe_account_id,
      stats: {
        totalReferrals,
        activeReferrals,
        lifetimeEarnings: agency.referral_earnings_cents || 0,
        availableBalance: agency.referral_balance_cents || 0,
        thisMonthEarnings,
      },
      referrals: referrals || [],
      commissions: commissions || [],
    });

  } catch (error) {
    console.error('Error fetching referral data:', error);
    res.status(500).json({ error: 'Failed to fetch referral data' });
  }
});

// ============================================================================
// PUT /api/agency/:agencyId/referrals/code
// Update custom referral code
// ============================================================================
router.put('/:agencyId/referrals/code', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({ error: 'Referral code is required' });
    }

    // Sanitize code
    const sanitizedCode = code
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9-]/g, '')
      .substring(0, 30);

    if (sanitizedCode.length < 3) {
      return res.status(400).json({ 
        error: 'Referral code must be at least 3 characters (letters, numbers, hyphens only)' 
      });
    }

    // Check if code is taken
    const { data: existing } = await supabase
      .from('agencies')
      .select('id')
      .eq('referral_code', sanitizedCode)
      .neq('id', agencyId)
      .single();

    if (existing) {
      return res.status(409).json({ error: 'This referral code is already taken' });
    }

    // Update
    const { error: updateError } = await supabase
      .from('agencies')
      .update({ referral_code: sanitizedCode })
      .eq('id', agencyId);

    if (updateError) {
      console.error('Error updating referral code:', updateError);
      return res.status(500).json({ error: 'Failed to update referral code' });
    }

    const platformDomain = process.env.PLATFORM_DOMAIN || 'myvoiceaiconnect.com';

    res.json({
      success: true,
      referralCode: sanitizedCode,
      referralLink: `https://${platformDomain}/signup?ref=${sanitizedCode}`,
    });

  } catch (error) {
    console.error('Error updating referral code:', error);
    res.status(500).json({ error: 'Failed to update referral code' });
  }
});

// ============================================================================
// POST /api/agency/:agencyId/referrals/payout
// Request a payout (transfer balance to Stripe Connect account)
// ============================================================================
router.post('/:agencyId/referrals/payout', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    // Get agency
    const { data: agency, error: agencyError } = await supabase
      .from('agencies')
      .select('id, name, referral_balance_cents, stripe_account_id')
      .eq('id', agencyId)
      .single();

    if (agencyError || !agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    // Check Stripe Connect account
    if (!agency.stripe_account_id) {
      return res.status(400).json({ 
        error: 'Stripe Connect account required. Complete Stripe onboarding first.' 
      });
    }

    // Check minimum balance ($10 = 1000 cents)
    const minPayout = 1000;
    if ((agency.referral_balance_cents || 0) < minPayout) {
      return res.status(400).json({ 
        error: `Minimum payout is $10. Current balance: $${((agency.referral_balance_cents || 0) / 100).toFixed(2)}` 
      });
    }

    const payoutAmount = agency.referral_balance_cents;

    // Create transfer to connected account
    const transfer = await stripe.transfers.create({
      amount: payoutAmount,
      currency: 'usd',
      destination: agency.stripe_account_id,
      description: `VoiceAI Connect referral commission payout`,
      metadata: {
        agency_id: agencyId,
        type: 'referral_payout'
      }
    });

    // Update balance
    await supabase
      .from('agencies')
      .update({ referral_balance_cents: 0 })
      .eq('id', agencyId);

    // Mark pending commissions as transferred
    await supabase
      .from('referral_commissions')
      .update({ 
        status: 'transferred',
        transfer_id: transfer.id,
        transferred_at: new Date().toISOString()
      })
      .eq('referrer_id', agencyId)
      .eq('status', 'pending');

    console.log(`✅ Referral payout: $${(payoutAmount / 100).toFixed(2)} to ${agency.name} (${transfer.id})`);

    res.json({
      success: true,
      amount: payoutAmount,
      transferId: transfer.id,
      message: `$${(payoutAmount / 100).toFixed(2)} transferred to your Stripe account`
    });

  } catch (error) {
    console.error('Error processing payout:', error);
    res.status(500).json({ error: 'Failed to process payout' });
  }
});

// ============================================================================
// HELPER: Process referral commission (called from Stripe webhook)
// ============================================================================
async function processReferralCommission(invoice, agency) {
  try {
    // Check if this agency was referred
    if (!agency.referred_by) {
      return { processed: false, reason: 'Agency has no referrer' };
    }

    // Find the referrer
    const { data: referrer, error: referrerError } = await supabase
      .from('agencies')
      .select('id, name, referral_earnings_cents, referral_balance_cents, stripe_account_id')
      .eq('referral_code', agency.referred_by)
      .single();

    if (referrerError || !referrer) {
      console.warn(`Referrer not found for code: ${agency.referred_by}`);
      return { processed: false, reason: 'Referrer not found' };
    }

    // Check for duplicate (same invoice already processed)
    const { data: existingCommission } = await supabase
      .from('referral_commissions')
      .select('id')
      .eq('stripe_invoice_id', invoice.id)
      .single();

    if (existingCommission) {
      return { processed: false, reason: 'Commission already processed for this invoice' };
    }

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
      console.error('Error inserting commission:', insertError);
      throw insertError;
    }

    // Update referrer's earnings and balance
    await supabase
      .from('agencies')
      .update({
        referral_earnings_cents: (referrer.referral_earnings_cents || 0) + commissionAmount,
        referral_balance_cents: (referrer.referral_balance_cents || 0) + commissionAmount
      })
      .eq('id', referrer.id);

    console.log(`💰 Referral commission: $${(commissionAmount / 100).toFixed(2)} for ${referrer.name} (referred ${agency.name})`);

    return { 
      processed: true, 
      commission: commissionAmount,
      referrerId: referrer.id,
      referrerName: referrer.name
    };

  } catch (error) {
    console.error('Error processing referral commission:', error);
    return { processed: false, reason: error.message };
  }
}

// ============================================================================
// HELPER: Attribute referral on signup
// ============================================================================
async function attributeReferral(agencyId, referralCode) {
  try {
    if (!referralCode) return { success: false, reason: 'No referral code provided' };

    const cleanCode = referralCode.toLowerCase().trim();

    // Verify referral code exists and isn't self-referral
    const { data: referrer } = await supabase
      .from('agencies')
      .select('id, referral_code')
      .eq('referral_code', cleanCode)
      .single();

    if (!referrer) {
      return { success: false, reason: 'Invalid referral code' };
    }

    if (referrer.id === agencyId) {
      return { success: false, reason: 'Cannot use own referral code' };
    }

    // Update the new agency with referred_by
    const { error } = await supabase
      .from('agencies')
      .update({ referred_by: cleanCode })
      .eq('id', agencyId);

    if (error) {
      console.error('Error attributing referral:', error);
      return { success: false, reason: error.message };
    }

    console.log(`🤝 Referral attributed: ${agencyId} referred by ${cleanCode}`);
    return { success: true, referrerCode: cleanCode };

  } catch (error) {
    console.error('Error attributing referral:', error);
    return { success: false, reason: error.message };
  }
}

// ============================================================================
// EXPORTS
// ============================================================================
module.exports = router;
module.exports.processReferralCommission = processReferralCommission;
module.exports.attributeReferral = attributeReferral;
module.exports.COMMISSION_RATE = COMMISSION_RATE;
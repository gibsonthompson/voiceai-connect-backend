// ============================================================================
// ADMIN AGENCY EXPANDED DETAIL
// GET /api/admin/agencies/:agencyId/expanded
//
// Returns rich data for the expanded agency row in the admin panel:
// - clients (all clients with test client flagged)
// - sms_history (recent SMS from sms_log)
// - test_client (test client details if exists)
// - checklist (setup completion status mirroring dashboard SetupChecklist)
//
// Mount in admin.js or server.js:
//   app.use('/api/admin', require('./routes/admin-agency-detail'));
//
// CREATED: 2026-05-10
// ============================================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const jwt = require('jsonwebtoken');

function requireAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'platform_admin') return res.status(403).json({ error: 'Not authorized' });
    req.admin = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

router.get('/agencies/:agencyId/expanded', requireAdmin, async (req, res) => {
  try {
    const { agencyId } = req.params;

    // Fetch agency
    const { data: agency, error: agencyError } = await supabase
      .from('agencies')
      .select('*')
      .eq('id', agencyId)
      .single();

    if (agencyError || !agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    // ── Clients ─────────────────────────────────────────────────────────
    const { data: clients } = await supabase
      .from('clients')
      .select('id, business_name, email, owner_name, owner_phone, vapi_phone_number, industry, plan_type, subscription_status, status, calls_this_month, monthly_call_limit, is_test_client, created_at')
      .eq('agency_id', agencyId)
      .order('is_test_client', { ascending: true })
      .order('created_at', { ascending: false });

    const clientList = clients || [];
    const testClient = clientList.find(c => c.is_test_client);
    const billableClients = clientList.filter(c => !c.is_test_client);

    // ── SMS History (last 20 from sms_log) ──────────────────────────────
    let smsHistory = [];
    try {
      const { data: smsLogs } = await supabase
        .from('sms_log')
        .select('id, recipient_phone, recipient_type, message_type, message_body, delivery_status, created_at')
        .eq('agency_id', agencyId)
        .order('created_at', { ascending: false })
        .limit(20);
      smsHistory = smsLogs || [];
    } catch (e) {
      // sms_log table might not exist yet
      console.warn('SMS log query failed:', e.message);
    }

    // ── Setup Checklist (mirrors dashboard SetupChecklist.tsx) ───────────
    const DEFAULT_PRICES = { starter: 4900, pro: 9900, growth: 14900 };
    const checklist = {
      logo: {
        done: !!agency.logo_url,
        label: 'Upload logo',
      },
      colors: {
        done: !!(agency.primary_color && agency.primary_color !== '#10b981'),
        label: 'Set brand colors',
      },
      pricing: {
        done: !!(
          (agency.price_starter ?? DEFAULT_PRICES.starter) !== DEFAULT_PRICES.starter ||
          (agency.price_pro ?? DEFAULT_PRICES.pro) !== DEFAULT_PRICES.pro ||
          (agency.price_growth ?? DEFAULT_PRICES.growth) !== DEFAULT_PRICES.growth
        ),
        label: 'Configure client pricing',
      },
      stripe: {
        done: !!agency.stripe_account_id,
        label: 'Connect Stripe',
      },
      stripe_charges: {
        done: !!agency.stripe_charges_enabled,
        label: 'Stripe charges enabled',
      },
      first_client: {
        done: billableClients.length > 0,
        label: 'Add first client',
      },
    };
    const checklistComplete = checklist.logo.done && checklist.colors.done && checklist.pricing.done && checklist.stripe.done && checklist.first_client.done;
    const checklistDone = [checklist.logo, checklist.colors, checklist.pricing, checklist.stripe, checklist.first_client].filter(c => c.done).length;

    // ── Test Client Details ─────────────────────────────────────────────
    let testClientDetail = null;
    if (testClient) {
      testClientDetail = {
        id: testClient.id,
        phone: testClient.vapi_phone_number,
        calls_used: testClient.calls_this_month || 0,
        call_limit: testClient.monthly_call_limit || 30,
        status: testClient.subscription_status,
      };
    }

    // ── Referral Chain ──────────────────────────────────────────────────
    let referredAgencies = [];
    if (agency.referral_code) {
      const { data: referred } = await supabase
        .from('agencies')
        .select('id, name, email, plan_type, subscription_status, created_at')
        .eq('referred_by', agency.referral_code)
        .order('created_at', { ascending: false });
      referredAgencies = referred || [];
    }

    // ── Activation SMS Progress ─────────────────────────────────────────
    const activationProgress = {
      step: agency.activation_sms_step || 0,
      last_sent: agency.activation_sms_last_sent_at || null,
      onboarding_completed_at: agency.onboarding_completed_at || null,
    };

    // ── Response ────────────────────────────────────────────────────────
    res.json({
      clients: clientList,
      billable_client_count: billableClients.length,
      sms_history: smsHistory,
      checklist: {
        items: checklist,
        done: checklistDone,
        total: 5,
        complete: checklistComplete,
      },
      test_client: testClientDetail,
      referral_chain: {
        referred_by: agency.referred_by || null,
        referred_agencies: referredAgencies,
        earnings_cents: agency.referral_earnings_cents || 0,
      },
      activation: activationProgress,
    });

  } catch (error) {
    console.error('Admin agency expanded error:', error);
    res.status(500).json({ error: 'Failed to load agency detail' });
  }
});

module.exports = router;

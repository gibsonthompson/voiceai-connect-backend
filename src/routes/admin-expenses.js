// ============================================================================
// ADMIN EXPENSE TRACKING ROUTES
// Mount in server.js: app.use('/api/admin', require('./routes/admin-expenses'));
// Created: 2026-06-02
//
// Shows what each agency actually COSTS you (voice minutes × your blended
// cost rate) vs what you bill them (plan rates), and whether you're currently
// recovering it (usage_billing_enabled). Headline number: exposure — the cost
// you're eating on agencies that aren't being metered yet.
//
// Data source: get_agency_voice_usage() RPC aggregates straight from the calls
// table (complete history), so this reflects true cost since day one — not
// just since metered tracking started.
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const jwt = require('jsonwebtoken');
const { PLAN_RATES } = require('../lib/usage-tracker');

// ── Admin auth (same pattern as admin.js) ───────────────────────────────────
function requireAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    if (decoded.role !== 'platform_admin') {
      return res.status(403).json({ error: 'Not authorized as platform admin' });
    }
    req.admin = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

const DEFAULT_VOICE_COST = {
  blended_per_minute: 0.10,
  telnyx: 0.007,
  vapi: 0.05,
  elevenlabs: 0.03,
  deepgram: 0.013,
};

async function getVoiceCost() {
  try {
    const { data } = await supabase
      .from('platform_settings')
      .select('value')
      .eq('key', 'voice_cost')
      .single();
    return { ...DEFAULT_VOICE_COST, ...(data?.value || {}) };
  } catch {
    return DEFAULT_VOICE_COST;
  }
}

// ============================================================================
// GET /api/admin/expenses — per-agency cost / billed / margin + platform totals
// ============================================================================
router.get('/expenses', requireAdmin, async (req, res) => {
  try {
    const voiceCost = await getVoiceCost();
    const costPerMin = Number(voiceCost.blended_per_minute) || DEFAULT_VOICE_COST.blended_per_minute;

    // 1. Voice usage per agency (server-side aggregation from calls table)
    const { data: usageRows, error: usageErr } = await supabase.rpc('get_agency_voice_usage');
    if (usageErr) {
      console.error('get_agency_voice_usage RPC error:', usageErr.message);
      return res.status(500).json({ error: 'Usage aggregation failed', details: usageErr.message });
    }
    const usageByAgency = {};
    (usageRows || []).forEach(r => { usageByAgency[r.agency_id] = r; });

    // 2. Billable client counts per agency
    const { data: clientRows } = await supabase.rpc('get_agency_billable_clients');
    const billableByAgency = {};
    (clientRows || []).forEach(r => { billableByAgency[r.agency_id] = Number(r.billable_count) || 0; });

    // 3. Agency metadata
    const { data: agencies, error: agencyErr } = await supabase
      .from('agencies')
      .select('id, name, plan_type, subscription_status, usage_billing_enabled');
    if (agencyErr) throw agencyErr;

    const minutesFromSeconds = (s) => Math.round((Number(s) || 0) / 60);
    const costFromSeconds = (s) => ((Number(s) || 0) / 60) * costPerMin;

    const rows = (agencies || []).map(a => {
      const u = usageByAgency[a.id] || { total_seconds: 0, total_calls: 0, month_seconds: 0, month_calls: 0 };
      const rates = PLAN_RATES[a.plan_type] || PLAN_RATES.free;
      const billable = billableByAgency[a.id] || 0;

      const allTimeMinutes = minutesFromSeconds(u.total_seconds);
      const monthMinutes = minutesFromSeconds(u.month_seconds);
      const allTimeCost = costFromSeconds(u.total_seconds);
      const monthCost = costFromSeconds(u.month_seconds);

      // What you SHOULD bill them this month at their plan rates
      const wouldBillMonth =
        (rates.platformFee || 0) +
        (billable * (rates.perClient || 0)) +
        (monthMinutes * (rates.perMinute || 0));

      const recovering = a.usage_billing_enabled === true;

      return {
        agency_id: a.id,
        name: a.name,
        plan_type: a.plan_type || 'free',
        subscription_status: a.subscription_status,
        usage_billing_enabled: recovering,
        billable_clients: billable,
        all_time: {
          minutes: allTimeMinutes,
          calls: Number(u.total_calls) || 0,
          est_cost: Math.round(allTimeCost * 100) / 100,
        },
        this_month: {
          minutes: monthMinutes,
          calls: Number(u.month_calls) || 0,
          est_cost: Math.round(monthCost * 100) / 100,
        },
        plan_rates: {
          platform_fee: rates.platformFee || 0,
          per_client: rates.perClient || 0,
          per_minute: rates.perMinute || 0,
        },
        would_bill_month: Math.round(wouldBillMonth * 100) / 100,
        // Margin this month = (what you'd charge for usage) − (your cost).
        // Only counts usage charges (per-minute + per-client), not platform fee,
        // since the platform fee is separate flat revenue.
        usage_margin_month: Math.round(
          ((billable * (rates.perClient || 0)) + (monthMinutes * (rates.perMinute || 0)) - monthCost) * 100
        ) / 100,
        recovering,
      };
    });

    // Sort by all-time cost descending — biggest cost drivers first
    rows.sort((x, y) => y.all_time.est_cost - x.all_time.est_cost);

    // Platform totals
    const sum = (arr, fn) => arr.reduce((s, r) => s + fn(r), 0);
    const totals = {
      blended_per_minute: costPerMin,
      total_agencies: rows.length,
      all_time: {
        minutes: sum(rows, r => r.all_time.minutes),
        est_cost: Math.round(sum(rows, r => r.all_time.est_cost) * 100) / 100,
      },
      this_month: {
        minutes: sum(rows, r => r.this_month.minutes),
        est_cost: Math.round(sum(rows, r => r.this_month.est_cost) * 100) / 100,
        would_bill: Math.round(sum(rows, r => r.would_bill_month) * 100) / 100,
        // Exposure = cost this month on agencies NOT being metered (you're eating it)
        exposure: Math.round(sum(rows.filter(r => !r.recovering), r => r.this_month.est_cost) * 100) / 100,
        recovering_count: rows.filter(r => r.recovering).length,
        not_recovering_count: rows.filter(r => !r.recovering).length,
      },
    };

    res.json({ voice_cost: voiceCost, totals, agencies: rows });
  } catch (error) {
    console.error('Admin expenses error:', error);
    res.status(500).json({ error: 'Failed to load expenses' });
  }
});

// ============================================================================
// GET /api/admin/expenses/settings — read the voice cost config
// ============================================================================
router.get('/expenses/settings', requireAdmin, async (req, res) => {
  const voiceCost = await getVoiceCost();
  res.json({ voice_cost: voiceCost });
});

// ============================================================================
// PUT /api/admin/expenses/settings — update the voice cost config
// Body: { blended_per_minute, telnyx?, vapi?, elevenlabs?, deepgram? }
// ============================================================================
router.put('/expenses/settings', requireAdmin, async (req, res) => {
  try {
    const current = await getVoiceCost();
    const next = { ...current };

    for (const key of ['blended_per_minute', 'telnyx', 'vapi', 'elevenlabs', 'deepgram']) {
      if (req.body[key] !== undefined) {
        const n = Number(req.body[key]);
        if (isNaN(n) || n < 0) {
          return res.status(400).json({ error: `Invalid value for ${key}` });
        }
        next[key] = n;
      }
    }

    const { error } = await supabase
      .from('platform_settings')
      .upsert({ key: 'voice_cost', value: next, updated_at: new Date().toISOString() }, { onConflict: 'key' });

    if (error) throw error;

    res.json({ success: true, voice_cost: next });
  } catch (error) {
    console.error('Update voice cost error:', error);
    res.status(500).json({ error: 'Failed to update cost settings' });
  }
});

module.exports = router;
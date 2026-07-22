// ============================================================================
// PLATFORM ADMIN: MARGIN / UNIT ECONOMICS
// Location: src/routes/admin-margin.js
// Mounted at /api/admin (see server.js), platform-owner only.
// ----------------------------------------------------------------------------
// Answers the one question nothing else in the platform answers: for each
// agency (and each client), am I making money on voice minutes?
//
//   revenue  = what the AGENCY pays the platform this month
//              (PLAN_RATES: monthly platform fee + per-active-client fee +
//               per-minute rate * minutes)  [source: lib/usage-tracker.js]
//   cost     = what the platform actually paid to run those minutes
//              = VAPI's own reported per-call cost (captured on usage_records)
//              + Telnyx telephony leg for whisper (telnyx_cc) clients only
//   margin   = revenue - cost
//
// VAPI cost is the ACTUAL figure VAPI reports on each end-of-call-report
// (message.cost), captured onto usage_records.vapi_cost by the webhook. It
// already includes hosting + STT + LLM + TTS + transport for vapi_direct
// clients, so the Telnyx rate is applied ONLY to telnyx_cc client minutes to
// avoid double counting the telephony leg.
//
// The Telnyx rate lives in platform_settings (key 'telnyx_cost_per_minute') so
// it can be edited from the admin UI without a deploy. Resolution order:
// settings row -> PLATFORM_TELNYX_COST_PER_MINUTE env -> 0.007 default.
// ============================================================================
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { supabase } = require('../lib/supabase');
const { getPlanRates } = require('../lib/usage-tracker');

const TELNYX_SETTING_KEY = 'telnyx_cost_per_minute';
const TELNYX_DEFAULT_RATE = 0.007;

// ── Admin auth: mirrors the guard used by the other /api/admin route files ──
function requireAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'platform_admin') {
      return res.status(403).json({ error: 'Not authorized as platform admin' });
    }
    req.admin = decoded;
    next();
  } catch (error) {
    console.error('Admin auth error:', error.message);
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function currentBillingMonth() {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().split('T')[0];
}

// Resolve the Telnyx per-minute rate: platform_settings row first, then env,
// then default. Any read failure (for example the table not existing yet)
// falls through to env/default instead of breaking the margin call.
async function resolveTelnyxRate() {
  try {
    const { data } = await supabase
      .from('platform_settings')
      .select('value')
      .eq('key', TELNYX_SETTING_KEY)
      .maybeSingle();
    if (data && data.value !== null && data.value !== undefined) {
      const v = parseFloat(data.value);
      if (Number.isFinite(v) && v >= 0) return v;
    }
  } catch (e) {
    console.warn('Telnyx rate: settings lookup failed, using env/default:', e.message);
  }
  const env = parseFloat(process.env.PLATFORM_TELNYX_COST_PER_MINUTE || '');
  if (Number.isFinite(env) && env >= 0) return env;
  return TELNYX_DEFAULT_RATE;
}

// ============================================================================
// GET /api/admin/margin/settings  reads the editable Telnyx rate
// PUT /api/admin/margin/settings  sets it { telnyx_cost_per_minute: number }
// (declared before /margin/:anything so there is no route-order ambiguity)
// ============================================================================
router.get('/margin/settings', requireAdmin, async (req, res) => {
  try {
    const rate = await resolveTelnyxRate();
    res.json({ telnyx_cost_per_minute: rate, default: TELNYX_DEFAULT_RATE });
  } catch (error) {
    console.error('Margin settings read error:', error.message);
    res.status(500).json({ error: 'Failed to read settings' });
  }
});

router.put('/margin/settings', requireAdmin, async (req, res) => {
  try {
    const raw = req.body && req.body.telnyx_cost_per_minute;
    const rate = parseFloat(raw);
    if (!Number.isFinite(rate) || rate < 0) {
      return res.status(400).json({ error: 'telnyx_cost_per_minute must be a non-negative number' });
    }
    const { error } = await supabase
      .from('platform_settings')
      .upsert(
        { key: TELNYX_SETTING_KEY, value: String(rate), updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
    if (error) {
      console.error('Margin settings write error:', error.message);
      return res.status(400).json({ error: error.message });
    }
    console.log(`\uD83D\uDD27 Telnyx cost rate set to $${rate}/min by ${req.admin?.email || 'admin'}`);
    res.json({ success: true, telnyx_cost_per_minute: rate });
  } catch (error) {
    console.error('Margin settings write error:', error.message);
    res.status(500).json({ error: 'Failed to write settings' });
  }
});

// ============================================================================
// GET /api/admin/margin
//   ?month=YYYY-MM-DD   (billing_month, defaults to current month)
//   ?agencyId=UUID      (restrict to one agency AND include per-client detail)
// ============================================================================
router.get('/margin', requireAdmin, async (req, res) => {
  try {
    const billingMonth = req.query.month || currentBillingMonth();
    const filterAgencyId = req.query.agencyId || null;
    const telnyxRate = await resolveTelnyxRate();

    // 1. Agencies in scope
    let agencyQuery = supabase.from('agencies').select('id, name, plan_type');
    if (filterAgencyId) agencyQuery = agencyQuery.eq('id', filterAgencyId);
    const { data: agencies, error: aErr } = await agencyQuery;
    if (aErr) throw aErr;

    const agencyIds = (agencies || []).map(a => a.id);
    if (agencyIds.length === 0) {
      return res.json({
        billing_month: billingMonth,
        telnyx_rate_per_min: telnyxRate,
        agencies: [],
        totals: { minutes: 0, revenue: 0, vapi_cost: 0, telnyx_cost: 0, total_cost: 0, margin: 0, margin_pct: null },
      });
    }

    // 2. Clients (billable count + voice_routing so we know who is telnyx_cc)
    const { data: clients, error: cErr } = await supabase
      .from('clients')
      .select('id, agency_id, voice_routing, is_test_client, status')
      .in('agency_id', agencyIds);
    if (cErr) throw cErr;

    // 3. This month's usage ledger (duration + actual VAPI cost)
    const { data: usage, error: uErr } = await supabase
      .from('usage_records')
      .select('agency_id, client_id, duration_seconds, vapi_cost')
      .eq('billing_month', billingMonth)
      .in('agency_id', agencyIds);
    if (uErr) throw uErr;

    // Index clients; count billable (active, non-test) per agency
    const clientById = {};
    const billableByAgency = {};
    (clients || []).forEach(c => {
      clientById[c.id] = c;
      if (!c.is_test_client && c.status === 'active') {
        billableByAgency[c.agency_id] = (billableByAgency[c.agency_id] || 0) + 1;
      }
    });

    // Aggregate usage per agency and per client
    const perAgency = {};
    const perClient = {};
    const bucket = () => ({ seconds: 0, vapiCost: 0, telnyxSeconds: 0, costRows: 0, totalRows: 0 });

    (usage || []).forEach(u => {
      const secs = u.duration_seconds || 0;
      const cost = (u.vapi_cost !== null && u.vapi_cost !== undefined) ? Number(u.vapi_cost) : null;
      const cl = clientById[u.client_id];
      const isTelnyx = !!cl && cl.voice_routing === 'telnyx_cc';

      const A = perAgency[u.agency_id] || (perAgency[u.agency_id] = bucket());
      A.seconds += secs;
      A.totalRows += 1;
      if (cost !== null) { A.vapiCost += cost; A.costRows += 1; }
      if (isTelnyx) A.telnyxSeconds += secs;

      const C = perClient[u.client_id] || (perClient[u.client_id] = Object.assign(bucket(), {
        client_id: u.client_id,
        agency_id: u.agency_id,
        voice_routing: cl ? (cl.voice_routing || 'vapi_direct') : 'vapi_direct',
      }));
      C.seconds += secs;
      C.totalRows += 1;
      if (cost !== null) { C.vapiCost += cost; C.costRows += 1; }
      if (isTelnyx) C.telnyxSeconds += secs;
    });

    // Build per-agency rows
    const results = (agencies || []).map(a => {
      const A = perAgency[a.id] || bucket();
      const rates = getPlanRates(a.plan_type);
      const minutes = Math.ceil(A.seconds / 60);
      const billableClients = billableByAgency[a.id] || 0;

      const revenue = rates.platformFee + billableClients * rates.perClient + minutes * rates.perMinute;
      const telnyxMinutes = Math.ceil(A.telnyxSeconds / 60);
      const telnyxCost = telnyxMinutes * telnyxRate;
      const vapiCost = round2(A.vapiCost);
      const totalCost = round2(vapiCost + telnyxCost);
      const margin = round2(revenue - totalCost);

      // true only when every usage row this month has a captured cost (or none exist)
      const costCaptureComplete = A.totalRows === 0 ? true : A.costRows === A.totalRows;

      return {
        agency_id: a.id,
        agency_name: a.name,
        plan_type: a.plan_type || 'free',
        billable_clients: billableClients,
        minutes,
        revenue: round2(revenue),
        vapi_cost: vapiCost,
        telnyx_cost: round2(telnyxCost),
        total_cost: totalCost,
        margin,
        margin_pct: revenue > 0 ? Math.round((margin / revenue) * 1000) / 10 : null,
        cost_capture_complete: costCaptureComplete,
        usage_rows: A.totalRows,
        cost_captured_rows: A.costRows,
      };
    });

    // Platform totals
    const totals = results.reduce((t, r) => {
      t.minutes += r.minutes;
      t.revenue += r.revenue;
      t.vapi_cost += r.vapi_cost;
      t.telnyx_cost += r.telnyx_cost;
      t.total_cost += r.total_cost;
      t.margin += r.margin;
      return t;
    }, { minutes: 0, revenue: 0, vapi_cost: 0, telnyx_cost: 0, total_cost: 0, margin: 0 });
    ['revenue', 'vapi_cost', 'telnyx_cost', 'total_cost', 'margin'].forEach(k => { totals[k] = round2(totals[k]); });
    totals.margin_pct = totals.revenue > 0 ? Math.round((totals.margin / totals.revenue) * 1000) / 10 : null;

    const response = {
      billing_month: billingMonth,
      telnyx_rate_per_min: telnyxRate,
      agencies: results,
      totals,
    };

    // Per-client cost detail only when a single agency is requested. Client-level
    // revenue is not shown because the monthly platform fee is agency-level and
    // not attributable per client; what matters here is which clients burn cost.
    if (filterAgencyId) {
      response.clients = Object.values(perClient).map(C => {
        const minutes = Math.ceil(C.seconds / 60);
        const telnyxMinutes = Math.ceil(C.telnyxSeconds / 60);
        const telnyxCost = round2(telnyxMinutes * telnyxRate);
        const vapiCost = round2(C.vapiCost);
        return {
          client_id: C.client_id,
          voice_routing: C.voice_routing,
          minutes,
          vapi_cost: vapiCost,
          telnyx_cost: telnyxCost,
          total_cost: round2(vapiCost + telnyxCost),
          cost_capture_complete: C.totalRows === 0 ? true : C.costRows === C.totalRows,
        };
      }).sort((x, y) => y.total_cost - x.total_cost);
    }

    console.log(`\uD83D\uDCB0 Admin margin: ${results.length} agencies, ${billingMonth}, margin $${totals.margin}`);
    res.json(response);
  } catch (error) {
    console.error('Admin margin error:', error.message);
    res.status(500).json({ error: 'Failed to compute margin' });
  }
});

module.exports = router;
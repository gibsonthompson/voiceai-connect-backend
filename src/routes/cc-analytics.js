// ============================================================================
// src/routes/cc-analytics.js
//
// Call-center analytics + live-ops overview. Powers the dedicated /cc dashboard:
//   GET /api/agency/:agencyId/cc/overview   -> today's live-ops snapshot (home)
//   GET /api/agency/:agencyId/cc/analytics  -> deep call analytics (range)
//
// Call-center operators do not use Stripe Connect, so there is zero revenue here
// on purpose. This is pure call insight: volume, outcomes, AI deflection,
// escalation, booking, handle time, per-business and per-agent breakdowns, and
// an hour-of-day heatmap. Source of truth is the `calls` table (post-call
// records) plus `call_sessions` (live) and `team_members` (agents).
//
// Both endpoints are scoped to the viewer: an owner/manager sees every business,
// an assigned agent sees only the businesses assigned to them. Mounted in
// server.js: app.use('/api/agency', require('./routes/cc-analytics'));
// ============================================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { requireAgencyAccess } = require('./auth');

const LIVE_STATUSES = [
  'active', 'ringing_gate', 'confirming', 'transferring', 'bridged',
  'conferencing', 'agent_dialing', 'agent_bridged', 'returning_to_ai',
];

const TZ = 'America/New_York'; // ops day/heatmap bucketed in ET (labeled in UI)
const etHour = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false });
const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }); // YYYY-MM-DD

function hourOf(iso) { try { return parseInt(etHour.format(new Date(iso)), 10) % 24; } catch { return 0; } }
function dateOf(iso) { try { return etDate.format(new Date(iso)); } catch { return ''; } }

// Agent scoping: a non-null assigned_client_ids array limits an agency_staff
// viewer to those clients. Null = unrestricted (owner/manager/plain staff).
async function resolveScope(decoded, agencyId) {
  if (decoded && decoded.role === 'agency_staff') {
    const { data: m } = await supabase
      .from('team_members').select('assigned_client_ids')
      .eq('member_user_id', decoded.userId).eq('entity_type', 'agency').eq('entity_id', agencyId).single();
    if (m && Array.isArray(m.assigned_client_ids)) return m.assigned_client_ids;
  }
  return null;
}

// The viewer's in-scope clients (id -> business_name).
async function scopedClients(req, agencyId) {
  const { data: clients } = await supabase
    .from('clients').select('id, business_name').eq('agency_id', agencyId);
  let list = clients || [];
  const scope = await resolveScope(req.user, agencyId);
  if (Array.isArray(scope)) { const ok = new Set(scope); list = list.filter(c => ok.has(c.id)); }
  return list;
}

// Outcome helpers (values verified against prod: call_status in
// completed|transferred|spam, transfer_status in transferred|null).
function isSpam(c) { return c.is_spam === true || c.call_status === 'spam'; }
function isTransferred(c) { return c.call_status === 'transferred' || c.transfer_status === 'transferred'; }
function tookOver(c) {
  const ev = c.call_metadata && Array.isArray(c.call_metadata.supervisor_events) ? c.call_metadata.supervisor_events : [];
  return ev.some(e => e && e.action === 'jumped_in');
}
function humanHandled(c) { return isTransferred(c) || tookOver(c); } // escalated to a person
function outcomeLabel(c) {
  if (isSpam(c)) return 'Spam';
  if (humanHandled(c)) return c.call_status === 'transferred' || c.transfer_status === 'transferred' ? 'Transferred' : 'Agent took over';
  if (c.appointment_booked) return 'Booked';
  return 'Handled by AI';
}

const CALL_COLS = 'id, created_at, client_id, caller_phone, customer_name, customer_phone, duration_seconds, appointment_booked, call_status, transfer_status, is_spam, call_metadata';

// ---------------------------------------------------------------------------
// GET /:agencyId/cc/overview  — today's live-ops snapshot for the home screen.
// ---------------------------------------------------------------------------
router.get('/:agencyId/cc/overview', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const { agencyId } = req.params;
    const clients = await scopedClients(req, agencyId);
    const nameById = new Map(clients.map(c => [c.id, c.business_name || 'Business']));
    const clientIds = clients.map(c => c.id);
    if (clientIds.length === 0) {
      return res.json({ success: true, businessesServed: 0, live: 0, agentsActive: 0, today: emptyToday(), recent: [], busiest: [] });
    }

    // Live right now.
    const { data: live } = await supabase
      .from('call_sessions').select('client_id').in('client_id', clientIds).in('status', LIVE_STATUSES)
      .gte('created_at', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString());

    // Agents on the roster (active).
    const { count: agentsActive } = await supabase
      .from('team_members').select('id', { count: 'exact', head: true })
      .eq('entity_type', 'agency').eq('entity_id', agencyId).neq('status', 'disabled');

    // Calls in the last 48h, then filter to the ET calendar "today".
    const { data: rows } = await supabase
      .from('calls').select(CALL_COLS).in('client_id', clientIds)
      .gte('created_at', new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString())
      .order('created_at', { ascending: false });
    const todayStr = dateOf(new Date().toISOString());
    const calls = (rows || []).filter(c => dateOf(c.created_at) === todayStr);

    const today = emptyToday();
    const perBiz = new Map();
    for (const c of calls) {
      today.calls++;
      if (isSpam(c)) today.spam++;
      else {
        if (humanHandled(c)) today.escalated++; else today.aiHandled++;
        if (isTransferred(c)) today.transferred++;
        if (c.appointment_booked) today.booked++;
      }
      if (hourOf(c.created_at) < 8 || hourOf(c.created_at) >= 18) today.afterHours++;
      today.talkSeconds += c.duration_seconds || 0;
      perBiz.set(c.client_id, (perBiz.get(c.client_id) || 0) + 1);
    }
    today.talkMinutes = Math.round(today.talkSeconds / 60);

    const recent = calls.slice(0, 12).map(c => ({
      id: c.id,
      clientId: c.client_id,
      businessName: nameById.get(c.client_id) || 'Business',
      caller: c.customer_name && c.customer_name.toLowerCase() !== 'unknown' ? c.customer_name : (c.customer_phone || c.caller_phone || null),
      outcome: outcomeLabel(c),
      durationSeconds: c.duration_seconds || 0,
      at: c.created_at,
    }));

    const busiest = [...perBiz.entries()]
      .map(([id, count]) => ({ clientId: id, businessName: nameById.get(id) || 'Business', count }))
      .sort((a, b) => b.count - a.count).slice(0, 5);

    res.json({
      success: true,
      businessesServed: clientIds.length,
      live: (live || []).length,
      agentsActive: agentsActive || 0,
      today, recent, busiest,
    });
  } catch (e) {
    console.error('cc/overview error:', e.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

function emptyToday() {
  return { calls: 0, aiHandled: 0, escalated: 0, transferred: 0, booked: 0, spam: 0, afterHours: 0, talkSeconds: 0, talkMinutes: 0 };
}

// ---------------------------------------------------------------------------
// GET /:agencyId/cc/analytics?range=7d|30d|90d  — deep call analytics.
// ---------------------------------------------------------------------------
router.get('/:agencyId/cc/analytics', requireAgencyAccess('analytics'), async (req, res) => {
  try {
    const { agencyId } = req.params;
    const days = ({ '7d': 7, '30d': 30, '90d': 90 })[String(req.query.range || '30d')] || 30;

    const clients = await scopedClients(req, agencyId);
    const nameById = new Map(clients.map(c => [c.id, c.business_name || 'Business']));
    const clientIds = clients.map(c => c.id);
    if (clientIds.length === 0) return res.json({ success: true, range: `${days}d`, totals: emptyTotals(), byDay: [], byHour: hourArray(), byBusiness: [], byAgent: [] });

    const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    // Page through to a sane cap so a very busy call center still aggregates.
    const { data: rows } = await supabase
      .from('calls').select(CALL_COLS).in('client_id', clientIds)
      .gte('created_at', sinceIso).order('created_at', { ascending: false }).limit(20000);
    const calls = rows || [];

    const totals = emptyTotals();
    const byDayMap = new Map();
    const byHour = hourArray();
    const byBizMap = new Map();
    const byAgentMap = new Map();
    let durSum = 0, durCount = 0;

    for (const c of calls) {
      totals.calls++;
      const spam = isSpam(c);
      if (spam) totals.spam++;
      const human = !spam && humanHandled(c);
      if (!spam) {
        if (human) totals.escalated++; else totals.aiHandled++;
        if (isTransferred(c)) totals.transferred++;
        if (c.appointment_booked) totals.booked++;
      }
      if (hourOf(c.created_at) < 8 || hourOf(c.created_at) >= 18) totals.afterHours++;
      if (c.duration_seconds) { durSum += c.duration_seconds; durCount++; }

      const d = dateOf(c.created_at);
      byDayMap.set(d, (byDayMap.get(d) || 0) + 1);
      byHour[hourOf(c.created_at)].count++;

      const b = byBizMap.get(c.client_id) || { clientId: c.client_id, businessName: nameById.get(c.client_id) || 'Business', calls: 0, booked: 0, transferred: 0, spam: 0, durSum: 0, durCount: 0 };
      b.calls++;
      if (spam) b.spam++; else { if (isTransferred(c)) b.transferred++; if (c.appointment_booked) b.booked++; }
      if (c.duration_seconds) { b.durSum += c.duration_seconds; b.durCount++; }
      byBizMap.set(c.client_id, b);

      const ev = c.call_metadata && Array.isArray(c.call_metadata.supervisor_events) ? c.call_metadata.supervisor_events : [];
      const seen = new Set();
      for (const e of ev) {
        const name = (e && e.name) ? String(e.name).trim() : '';
        if (!name || seen.has(name)) continue; // one credit per call per agent
        seen.add(name);
        const a = byAgentMap.get(name) || { name, calls: 0, tookOver: 0, listened: 0 };
        a.calls++;
        if (ev.some(x => x.name === name && x.action === 'jumped_in')) a.tookOver++;
        else a.listened++;
        byAgentMap.set(name, a);
      }
    }

    totals.avgHandleSeconds = durCount ? Math.round(durSum / durCount) : 0;
    const realCalls = totals.calls - totals.spam;
    totals.deflectionRate = realCalls > 0 ? Math.round((totals.aiHandled / realCalls) * 100) : 0;
    totals.escalationRate = realCalls > 0 ? Math.round((totals.escalated / realCalls) * 100) : 0;
    totals.bookingRate = realCalls > 0 ? Math.round((totals.booked / realCalls) * 100) : 0;

    // Fill the day series across the whole range (zero-fill gaps).
    const byDay = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = dateOf(new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString());
      byDay.push({ date: d, count: byDayMap.get(d) || 0 });
    }

    const byBusiness = [...byBizMap.values()]
      .map(b => ({ clientId: b.clientId, businessName: b.businessName, calls: b.calls, booked: b.booked, transferred: b.transferred, spam: b.spam, avgHandleSeconds: b.durCount ? Math.round(b.durSum / b.durCount) : 0 }))
      .sort((a, b) => b.calls - a.calls);

    const byAgent = [...byAgentMap.values()].sort((a, b) => b.calls - a.calls);

    res.json({ success: true, range: `${days}d`, totals, byDay, byHour, byBusiness, byAgent });
  } catch (e) {
    console.error('cc/analytics error:', e.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

function emptyTotals() {
  return { calls: 0, aiHandled: 0, escalated: 0, transferred: 0, booked: 0, spam: 0, afterHours: 0, avgHandleSeconds: 0, deflectionRate: 0, escalationRate: 0, bookingRate: 0 };
}
function hourArray() { return Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 })); }

module.exports = router;

// ============================================================================
// src/routes/agency-wallboard.js
//
// Call-center wallboard: every call live RIGHT NOW across all the businesses a
// call-center agency serves, in one list. A manager (or an assigned agent) opens
// this to see who is on the line and jump into any of them.
//
// Mounted in server.js: app.use('/api/agency', require('./routes/agency-wallboard'));
//
// Source of truth is call_sessions (durable), so the board survives a refresh
// and does not depend on in-memory monitor state. Only own-the-call (telnyx_cc)
// clients have sessions, which is exactly the set a human can monitor/jump into.
// The frontend polls this every few seconds for a near-live board; the live
// event stream is used once a specific call is opened in the monitor.
// ============================================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { requireAgencyAccess } = require('./auth');
const { getAgencyCapacity } = require('../lib/concurrency');

// Session statuses that mean the call is still live (not finished).
const LIVE_STATUSES = [
  'active', 'ringing_gate', 'confirming', 'transferring', 'bridged',
  'conferencing', 'agent_dialing', 'agent_bridged', 'returning_to_ai',
];

// Resolve which of the agency's clients the VIEWER is allowed to see on the
// board. An agency_owner / super_admin / impersonation token sees every
// business. An agency_staff member (an agent) is scoped to the businesses the
// manager assigned to them (team_members.assigned_client_ids): null = see all
// (manager-like staff, and every plain reseller staff member), an array = only
// those. Returns null to mean "no scoping" so the caller keeps the full set.
async function resolveViewerClientScope(decoded, agencyId) {
  if (!decoded) return null;
  if (decoded.role === 'agency_staff') {
    const { data: member } = await supabase
      .from('team_members')
      .select('assigned_client_ids')
      .eq('member_user_id', decoded.userId)
      .eq('entity_type', 'agency')
      .eq('entity_id', agencyId)
      .single();
    // Only a real array scopes; null/undefined leaves the viewer unrestricted.
    if (member && Array.isArray(member.assigned_client_ids)) {
      return member.assigned_client_ids;
    }
  }
  return null; // owner, impersonation, super_admin, or unscoped staff
}

// GET /api/agency/:agencyId/live-calls
// Returns the live calls across the businesses THIS VIEWER can see, plus the
// in-scope business roster so the board can also list quiet businesses (an agent
// can open any assigned business even when no call is live right now). Managers
// see every business; an assigned agent sees only the businesses assigned to
// them. Scope is resolved server-side from the token on every poll, so editing
// an agent's assignments takes effect without them re-logging in.
router.get('/:agencyId/live-calls', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const { agencyId } = req.params;

    // Live concurrency: how many of this account's lines are in use right now vs
    // its cap (agencies.concurrent_lines; null = no app cap, the VAPI pool is the
    // real ceiling). Reads the active-call registry. Best-effort, never blocks.
    let capacity = null;
    try {
      const { data: ag } = await supabase.from('agencies').select('concurrent_lines').eq('id', agencyId).maybeSingle();
      capacity = await getAgencyCapacity(agencyId, ag ? ag.concurrent_lines : null);
    } catch { capacity = null; }

    // The businesses this call center serves.
    const { data: clients, error: cErr } = await supabase
      .from('clients')
      .select('id, business_name')
      .eq('agency_id', agencyId);
    if (cErr) return res.status(400).json({ success: false, error: cErr.message });

    // Scope to the viewer (agent assignment). An empty assignment array means a
    // real "assigned to nothing yet" scope, so the agent correctly sees nothing.
    const scope = await resolveViewerClientScope(req.user, agencyId);
    let visibleClients = clients || [];
    if (Array.isArray(scope)) {
      const allowed = new Set(scope);
      visibleClients = visibleClients.filter(c => allowed.has(c.id));
    }

    const clientIds = visibleClients.map(c => c.id);
    const nameById = new Map(visibleClients.map(c => [c.id, c.business_name]));
    if (clientIds.length === 0) return res.json({ success: true, calls: [], businesses: [], capacity });

    // Live sessions for those businesses. A 2-hour floor guards against a stale
    // row that never got a terminal status.
    const sinceIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { data: sessions, error: sErr } = await supabase
      .from('call_sessions')
      .select('id, client_id, caller_number, status, barged, supervisor_role, conference_active, created_at, vapi_call_id')
      .in('client_id', clientIds)
      .in('status', LIVE_STATUSES)
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false });
    if (sErr) return res.status(400).json({ success: false, error: sErr.message });

    const liveClientIds = new Set();
    const calls = (sessions || []).map(s => {
      liveClientIds.add(s.client_id);
      const humanOnCall = s.status === 'agent_bridged' || s.supervisor_role === 'barge';
      const beingMonitored = !!s.supervisor_role; // a teammate is seated (listening or barged)
      return {
        sessionId: s.id,
        clientId: s.client_id,
        businessName: nameById.get(s.client_id) || 'Business',
        callerNumber: s.caller_number || null,
        status: s.status,
        humanOnCall,
        beingMonitored,
        startedAt: s.created_at,
        vapiCallId: s.vapi_call_id || null,
      };
    });

    // Roster of in-scope businesses (name-sorted) with a live flag, so the board
    // can show quiet businesses too and an agent can open any assigned business.
    const businesses = visibleClients
      .map(c => ({ clientId: c.id, businessName: c.business_name || 'Business', live: liveClientIds.has(c.id) }))
      .sort((a, b) => a.businessName.localeCompare(b.businessName));

    res.json({ success: true, calls, businesses, capacity });
  } catch (e) {
    console.error('agency-wallboard live-calls error:', e.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

module.exports = router;
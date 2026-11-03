// ============================================================================
// src/routes/cc-wallboard.js
//
// Call-center live wallboard: every call live right now across the businesses a
// CALL CENTER owns (clients.call_center_id), in one list. The call-center
// mirror of agency-wallboard.js — same call_sessions source of truth and the
// same shape, but scoped to a call center and guarded by requireCallCenterAccess.
// The agency wallboard (agency-wallboard.js) is untouched.
//
// Mounted in server.js: app.use('/api/agency', require('./routes/cc-wallboard'));
// URL: GET /api/agency/:callCenterId/cc/live-calls
// ============================================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { requireCallCenterAccess } = require('./auth');

// Session statuses that mean the call is still live (not finished). Same set the
// agency wallboard uses.
const LIVE_STATUSES = [
  'active', 'ringing_gate', 'confirming', 'transferring', 'bridged',
  'conferencing', 'agent_dialing', 'agent_bridged', 'returning_to_ai',
];

// Which of the call center's businesses may THIS viewer see. A cc_owner /
// cc_manager / super_admin sees every business. A cc_agent is scoped to the
// businesses assigned to them (team_members.assigned_client_ids): null = see
// all, an array = only those. Returns null for "no scoping".
async function resolveViewerClientScope(decoded, callCenterId) {
  if (!decoded) return null;
  if (decoded.role === 'cc_agent') {
    const { data: member } = await supabase
      .from('team_members')
      .select('assigned_client_ids')
      .eq('member_user_id', decoded.userId)
      .eq('entity_type', 'call_center')
      .eq('entity_id', callCenterId)
      .single();
    if (member && Array.isArray(member.assigned_client_ids)) {
      return member.assigned_client_ids;
    }
  }
  return null; // owner, manager, super_admin, or unscoped agent
}

// GET /api/agency/:callCenterId/cc/live-calls
router.get('/:callCenterId/cc/live-calls', requireCallCenterAccess('dashboard'), async (req, res) => {
  try {
    const { callCenterId } = req.params;

    // The businesses this call center owns.
    const { data: clients, error: cErr } = await supabase
      .from('clients')
      .select('id, business_name')
      .eq('call_center_id', callCenterId);
    if (cErr) return res.status(400).json({ success: false, error: cErr.message });

    // Scope to the viewer (agent assignment). An empty array = assigned to
    // nothing yet, so the agent correctly sees no businesses.
    const scope = await resolveViewerClientScope(req.user, callCenterId);
    let visibleClients = clients || [];
    if (Array.isArray(scope)) {
      const allowed = new Set(scope);
      visibleClients = visibleClients.filter(c => allowed.has(c.id));
    }

    const clientIds = visibleClients.map(c => c.id);
    const nameById = new Map(visibleClients.map(c => [c.id, c.business_name]));
    // capacity is an agency-level meter (agencies.concurrent_lines); call centers
    // are invoiced and not line-capped here, so it is omitted.
    if (clientIds.length === 0) return res.json({ success: true, calls: [], businesses: [], capacity: null });

    // Live sessions for those businesses. A 2-hour floor guards a stale row that
    // never got a terminal status.
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
      const beingMonitored = !!s.supervisor_role;
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

    const businesses = visibleClients
      .map(c => ({ clientId: c.id, businessName: c.business_name || 'Business', live: liveClientIds.has(c.id) }))
      .sort((a, b) => a.businessName.localeCompare(b.businessName));

    res.json({ success: true, calls, businesses, capacity: null });
  } catch (e) {
    console.error('cc-wallboard live-calls error:', e.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

module.exports = router;

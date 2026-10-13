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

// Session statuses that mean the call is still live (not finished).
const LIVE_STATUSES = [
  'active', 'ringing_gate', 'confirming', 'transferring', 'bridged',
  'conferencing', 'agent_dialing', 'agent_bridged', 'returning_to_ai',
];

// GET /api/agency/:agencyId/live-calls
// Returns the live calls across this agency's clients. Agent scoping (only the
// businesses a manager assigned to an agent) is layered on in a later phase;
// for now a manager sees all of the agency's businesses.
router.get('/:agencyId/live-calls', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const { agencyId } = req.params;

    // The businesses this call center serves.
    const { data: clients, error: cErr } = await supabase
      .from('clients')
      .select('id, business_name')
      .eq('agency_id', agencyId);
    if (cErr) return res.status(400).json({ success: false, error: cErr.message });

    const clientIds = (clients || []).map(c => c.id);
    if (clientIds.length === 0) return res.json({ success: true, calls: [] });
    const nameById = new Map((clients || []).map(c => [c.id, c.business_name]));

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

    const calls = (sessions || []).map(s => {
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

    res.json({ success: true, calls });
  } catch (e) {
    console.error('agency-wallboard live-calls error:', e.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

module.exports = router;
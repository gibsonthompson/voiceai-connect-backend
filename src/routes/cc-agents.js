// ============================================================================
// src/routes/cc-agents.js
// Mounted at: app.use('/api/cc', require('./routes/cc-agents'))
//
// The agent real-time plane for call-center escalation:
//
//   POST /api/cc/agent/heartbeat        -> presence upsert (online + available)
//   POST /api/cc/agent/status           -> flip available / away
//   POST /api/cc/agent/override         -> agent flips their own availability override
//   POST /api/cc/agent/delivery         -> agent sets browser vs phone delivery
//   GET  /api/cc/agent/me               -> agent's own availability snapshot
//   GET  /api/cc/agent/stream           -> SSE: live escalation offers for me
//   POST /api/cc/offer/:offerId/claim   -> race to take an offered call (atomic)
//   POST /api/cc/offer/:offerId/decline -> dismiss my pop
//   GET  /api/cc/:agencyId/agents/presence     -> agency manager presence bar
//   POST /api/cc/:agencyId/agents/test-offer   -> agency demo pop (manager only)
//   GET  /api/cc/:callCenterId/cc/presence     -> call-center manager presence bar
//
// OWNER-AGNOSTIC: an agent is owned by EITHER an agency (token.agencyId, roles
// agency_owner/agency_staff) OR a call center (token.callCenterId, roles
// cc_owner/cc_manager/cc_agent). resolveAgent returns which, and every presence/
// offer call is scoped to that owner. Passing an agency token reproduces the
// original agency behavior exactly.
// ============================================================================

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { supabase } = require('../lib/supabase');
const { requireAgencyAccess, requireCallCenterAccess } = require('./auth');
const presence = require('../lib/agent-presence');
const offers = require('../lib/escalation-offers');
const { channelForAgent, subscribeAgent, broadcastToAgent, broadcastToAgents } = require('../lib/agent-channel');

const JWT_SECRET = process.env.JWT_SECRET;

function decodeToken(raw) {
  if (!raw || !JWT_SECRET) return null;
  const token = String(raw).startsWith('Bearer ') ? String(raw).slice(7) : String(raw);
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

// Resolve the logged-in agent from the token, and WHICH owner they belong to.
// Call center (cc_* role + callCenterId) or agency (agency_* role / impersonation
// + agencyId). The owner + agent identity come from the token, never the body.
function resolveAgent(decoded) {
  if (!decoded) return null;
  const role = decoded.role;
  const memberUserId = decoded.userId || decoded.id || null;
  if (!memberUserId) return null;

  if (role === 'cc_owner' || role === 'cc_manager' || role === 'cc_agent') {
    const callCenterId = decoded.callCenterId || null;
    if (!callCenterId) return null;
    return { agencyId: null, callCenterId, memberUserId, role };
  }

  const agencyId = decoded.agencyId || (decoded.type === 'agency' ? decoded.id : null);
  if (!agencyId) return null;
  if (role !== 'agency_owner' && role !== 'agency_staff' && decoded.type !== 'agency') return null;
  return { agencyId, callCenterId: null, memberUserId, role };
}

// The owner scope for presence/offer lib calls: exactly one of agencyId /
// callCenterId. Spread into every lib call so it is scoped correctly.
function ownerArgs(agent) {
  return agent.callCenterId ? { callCenterId: agent.callCenterId } : { agencyId: agent.agencyId };
}
// team_members scope + timezone table for this owner.
function ownerEntity(agent) {
  return agent.callCenterId
    ? { entityType: 'call_center', entityId: agent.callCenterId, tzTable: 'call_centers' }
    : { entityType: 'agency', entityId: agent.agencyId, tzTable: 'agencies' };
}

// Pull the agent's saved delivery + phone + name + hours from their team_members
// row (owner-scoped). Owners have no member row and default to a browser seat.
async function agentProfile(agent) {
  const { entityType, entityId } = ownerEntity(agent);
  try {
    const { data } = await supabase
      .from('team_members')
      .select('display_name, call_delivery, agent_phone, availability_hours')
      .eq('entity_type', entityType).eq('entity_id', entityId)
      .eq('member_user_id', agent.memberUserId)
      .maybeSingle();
    if (data) return { displayName: data.display_name || null, callDelivery: data.call_delivery || 'browser', agentPhone: data.agent_phone || null, availabilityHours: data.availability_hours || null };
  } catch { /* fall through */ }
  return { displayName: null, callDelivery: 'browser', agentPhone: null, availabilityHours: null };
}

// The owner's timezone, for the working-hours gate. Best-effort; defaults ET.
async function ownerTimezone(agent) {
  const { entityId, tzTable } = ownerEntity(agent);
  try { const { data } = await supabase.from(tzTable).select('timezone').eq('id', entityId).maybeSingle(); if (data && data.timezone) return data.timezone; } catch {}
  return 'America/New_York';
}

// ---- POST /api/cc/agent/heartbeat -----------------------------------------
router.post('/agent/heartbeat', async (req, res) => {
  const agent = resolveAgent(decodeToken(req.headers.authorization));
  if (!agent) return res.status(401).json({ success: false, error: 'Unauthorized' });

  const status = (req.body && req.body.status) === 'away' ? 'away' : 'available';
  const prof = await agentProfile(agent);
  await presence.heartbeat({
    ...ownerArgs(agent),
    memberUserId: agent.memberUserId,
    displayName: prof.displayName,
    callDelivery: prof.callDelivery,
    agentPhone: prof.agentPhone,
    status,
  });

  const open = await offers.listOpenForAgent({ ...ownerArgs(agent), memberUserId: agent.memberUserId });

  const ah = prof.availabilityHours;
  const scheduleEnabled = !!(ah && ah.enabled);
  const override = !!(ah && ah.override);
  let onSchedule = true;
  if (scheduleEnabled && !override) {
    try {
      const tz = await ownerTimezone(agent);
      onSchedule = presence.isAgentOnSchedule(ah, tz);
    } catch (e) { onSchedule = true; }
  }

  res.json({
    success: true,
    channel: channelForAgent(agent.memberUserId),
    status,
    offers: open.map(shapeOffer),
    onSchedule,
    scheduleEnabled,
    override,
  });
});

// ---- POST /api/cc/agent/status --------------------------------------------
router.post('/agent/status', async (req, res) => {
  const agent = resolveAgent(decodeToken(req.headers.authorization));
  if (!agent) return res.status(401).json({ success: false, error: 'Unauthorized' });
  const status = (req.body && req.body.status) === 'away' ? 'away' : 'available';
  await presence.setStatus({ ...ownerArgs(agent), memberUserId: agent.memberUserId, status });
  res.json({ success: true, status });
});

// ---- GET /api/cc/agent/me -------------------------------------------------
router.get('/agent/me', async (req, res) => {
  const agent = resolveAgent(decodeToken(req.query.token || req.headers.authorization));
  if (!agent) return res.status(401).json({ success: false, error: 'Unauthorized' });

  const prof = await agentProfile(agent);
  const ah = prof.availabilityHours;
  const scheduleEnabled = !!(ah && ah.enabled);
  const override = !!(ah && ah.override);

  const timezone = await ownerTimezone(agent);

  let onSchedule = true;
  if (scheduleEnabled && !override) {
    try { onSchedule = presence.isAgentOnSchedule(ah, timezone); } catch (e) { onSchedule = true; }
  }

  let status = 'available';
  try {
    const { data: pres } = await supabase.from('agent_presence')
      .select('status')
      .eq('member_user_id', agent.memberUserId)
      .maybeSingle();
    if (pres && pres.status === 'away') status = 'away';
  } catch (e) {}

  res.json({
    success: true,
    displayName: prof.displayName,
    callDelivery: prof.callDelivery,
    agentPhone: prof.agentPhone,
    availabilityHours: ah || null,
    scheduleEnabled,
    override,
    onSchedule,
    status,
    timezone,
  });
});

// ---- POST /api/cc/agent/override ------------------------------------------
router.post('/agent/override', async (req, res) => {
  const agent = resolveAgent(decodeToken(req.headers.authorization));
  if (!agent) return res.status(401).json({ success: false, error: 'Unauthorized' });
  const override = !!(req.body && req.body.override === true);
  const { entityType, entityId } = ownerEntity(agent);

  try {
    const { data: tm } = await supabase.from('team_members')
      .select('availability_hours')
      .eq('entity_type', entityType).eq('entity_id', entityId)
      .eq('member_user_id', agent.memberUserId)
      .maybeSingle();
    if (!tm) return res.status(404).json({ success: false, error: 'No agent profile to update.' });

    const cur = (tm.availability_hours && typeof tm.availability_hours === 'object') ? tm.availability_hours : {};
    const next = { ...cur, override };
    const { error } = await supabase.from('team_members')
      .update({ availability_hours: next })
      .eq('entity_type', entityType).eq('entity_id', entityId)
      .eq('member_user_id', agent.memberUserId);
    if (error) throw error;

    res.json({ success: true, override });
  } catch (e) {
    console.error('cc-agents: agent/override failed:', e.message);
    res.status(500).json({ success: false, error: 'Could not update your availability.' });
  }
});

// ---- POST /api/cc/agent/delivery ------------------------------------------
router.post('/agent/delivery', async (req, res) => {
  const agent = resolveAgent(decodeToken(req.headers.authorization));
  if (!agent) return res.status(401).json({ success: false, error: 'Unauthorized' });
  const { entityType, entityId } = ownerEntity(agent);

  const callDelivery = (req.body && req.body.callDelivery) === 'phone' ? 'phone' : 'browser';
  const rawPhone = (req.body && typeof req.body.agentPhone === 'string') ? req.body.agentPhone.trim() : '';
  const agentPhone = rawPhone ? rawPhone.replace(/[^\d+]/g, '') : '';
  if (callDelivery === 'phone' && agentPhone.replace(/\D/g, '').length < 10) {
    return res.status(400).json({ success: false, error: 'Enter a valid phone number to take calls on your phone.' });
  }

  try {
    const { data: tm } = await supabase.from('team_members')
      .select('member_user_id')
      .eq('entity_type', entityType).eq('entity_id', entityId)
      .eq('member_user_id', agent.memberUserId)
      .maybeSingle();
    if (!tm) return res.status(404).json({ success: false, error: 'No agent profile to update.' });

    const update = { call_delivery: callDelivery };
    if (agentPhone) update.agent_phone = agentPhone;
    const { error } = await supabase.from('team_members')
      .update(update)
      .eq('entity_type', entityType).eq('entity_id', entityId)
      .eq('member_user_id', agent.memberUserId);
    if (error) throw error;

    res.json({ success: true, callDelivery, agentPhone: agentPhone || null });
  } catch (e) {
    console.error('cc-agents: agent/delivery failed:', e.message);
    res.status(500).json({ success: false, error: 'Could not update your call delivery.' });
  }
});

// ---- GET /api/cc/agent/stream (SSE) ---------------------------------------
router.get('/agent/stream', async (req, res) => {
  const agent = resolveAgent(decodeToken(req.query.token || req.headers.authorization));
  if (!agent) return res.status(401).json({ success: false, error: 'Unauthorized' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  try { res.flushHeaders(); } catch (e) {}
  try { if (res.socket) res.socket.setNoDelay(true); } catch (e) {}
  res.write(`:${' '.repeat(2048)}\n\n`);
  res.write('retry: 3000\n\n');
  if (typeof res.flush === 'function') { try { res.flush(); } catch (e) {} }

  const send = (event, data) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    } catch (e) {}
  };

  send('hello', { agentId: agent.memberUserId, channel: channelForAgent(agent.memberUserId), ts: Date.now() });
  presence.heartbeat({ ...ownerArgs(agent), memberUserId: agent.memberUserId }).catch(() => {});
  offers.listOpenForAgent({ ...ownerArgs(agent), memberUserId: agent.memberUserId })
    .then((open) => { for (const o of open) send('event', { type: 'offer', offer: shapeOffer(o) }); })
    .catch(() => {});

  const unsub = subscribeAgent(agent.memberUserId, (ev) => send('event', ev));
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); if (typeof res.flush === 'function') res.flush(); } catch (e) {}
  }, 15000);

  let closed = false;
  const cleanup = () => { if (closed) return; closed = true; clearInterval(heartbeat); unsub(); try { res.end(); } catch {} };
  req.on('close', cleanup);
  req.on('error', cleanup);
});

// ---- POST /api/cc/offer/:offerId/claim ------------------------------------
router.post('/offer/:offerId/claim', async (req, res) => {
  const agent = resolveAgent(decodeToken(req.headers.authorization));
  if (!agent) return res.status(401).json({ success: false, error: 'Unauthorized' });

  const offer = await offers.getOffer(req.params.offerId);
  if (!offer) return res.status(404).json({ success: false, error: 'That call is no longer available.' });
  // The offer must belong to this agent's owner (agency or call center).
  const ownsOffer = agent.callCenterId ? (offer.call_center_id === agent.callCenterId) : (offer.agency_id === agent.agencyId);
  if (!ownsOffer) return res.status(403).json({ success: false, error: 'Forbidden' });
  if (offer.status !== 'open') {
    return res.json({ success: true, won: false, reason: offer.status === 'claimed' ? 'taken' : offer.status });
  }

  const prof = await agentProfile(agent);
  const claimed = await offers.claimOffer(offer.id, {
    memberUserId: agent.memberUserId,
    displayName: prof.displayName,
    callDelivery: prof.callDelivery,
  });
  if (!claimed) {
    return res.json({ success: true, won: false, reason: 'taken' });
  }

  presence.setBusy({ ...ownerArgs(agent), memberUserId: agent.memberUserId, busy: true, busyClientId: offer.client_id }).catch(() => {});
  presence.incrementSessionCalls({ ...ownerArgs(agent), memberUserId: agent.memberUserId }).catch(() => {});

  const others = (Array.isArray(offer.offered_to) ? offer.offered_to : []).filter((id) => id !== agent.memberUserId);
  if (others.length) broadcastToAgents(others, { type: 'offer_taken', offerId: offer.id, by: prof.displayName || 'A teammate' });

  return res.json({
    success: true,
    won: true,
    delivery: claimed.claimed_delivery || prof.callDelivery || 'browser',
    offer: shapeOffer(claimed),
  });
});

// ---- POST /api/cc/offer/:offerId/decline ----------------------------------
router.post('/offer/:offerId/decline', async (req, res) => {
  const agent = resolveAgent(decodeToken(req.headers.authorization));
  if (!agent) return res.status(401).json({ success: false, error: 'Unauthorized' });
  res.json({ success: true });
});

// ---- GET /api/cc/:agencyId/agents/presence (AGENCY manager bar) -----------
router.get('/:agencyId/agents/presence', requireAgencyAccess('team'), async (req, res) => {
  const agencyId = req.params.agencyId;
  const list = await presence.listForAgency(agencyId);

  let tz = 'America/New_York';
  const hoursByUser = {};
  try { const { data: ag } = await supabase.from('agencies').select('timezone').eq('id', agencyId).single(); if (ag && ag.timezone) tz = ag.timezone; } catch (e) {}
  try {
    const { data: members } = await supabase.from('team_members')
      .select('member_user_id, availability_hours')
      .eq('entity_type', 'agency').eq('entity_id', agencyId);
    for (const m of (members || [])) hoursByUser[m.member_user_id] = m.availability_hours || null;
  } catch (e) {}
  const nowTz = presence.hoursNowInTz(tz);

  const agents = list.map((a) => {
    const ah = hoursByUser[a.memberUserId] || null;
    return {
      ...a,
      scheduleEnabled: !!(ah && ah.enabled),
      override: !!(ah && ah.override),
      onSchedule: presence.isAgentOnSchedule(ah, tz, nowTz),
    };
  });

  res.json({
    success: true,
    online: agents.filter((a) => a.online).length,
    available: agents.filter((a) => a.online && a.status === 'available' && !a.busy && a.onSchedule).length,
    agents,
  });
});

// ---- POST /api/cc/:agencyId/agents/test-offer (AGENCY manager only) --------
router.post('/:agencyId/agents/test-offer', requireAgencyAccess('team'), async (req, res) => {
  const agencyId = req.params.agencyId;
  const clientId = (req.body && req.body.clientId) || null;
  if (!clientId) return res.status(400).json({ success: false, error: 'clientId is required' });

  const { data: client } = await supabase
    .from('clients').select('id, business_name, agency_id').eq('id', clientId).maybeSingle();
  if (!client || client.agency_id !== agencyId) return res.status(404).json({ success: false, error: 'Business not found' });

  const avail = await presence.listAvailableForClient({ agencyId, clientId });
  if (avail.length === 0) {
    return res.json({ success: true, offered: 0, note: 'No available agents are assigned to that business right now.' });
  }

  const offeredTo = avail.map((a) => a.memberUserId);
  const offer = await offers.createOffer({
    agencyId, clientId,
    businessName: client.business_name,
    callerNumber: '+15555550123',
    reason: 'Test escalation',
    summary: 'This is a test escalation pop. No real caller is on the line.',
    collected: { test: true },
    offeredTo,
  });
  if (!offer) return res.status(500).json({ success: false, error: 'Could not create the test offer.' });

  broadcastToAgents(offeredTo, { type: 'offer', offer: { ...shapeOffer(offer), test: true } });
  res.json({ success: true, offered: offeredTo.length });
});

// ---- GET /api/cc/:callCenterId/cc/presence (CALL-CENTER manager bar) -------
// The call-center manager presence bar + agents page roster. Lists the call
// center's agents (team_members entity_type='call_center') with their live
// presence (by member_user_id, which agent_presence is now keyed on). Returns
// 200 with the roster; agents with no recent heartbeat read as offline.
router.get('/:callCenterId/cc/presence', requireCallCenterAccess('dashboard'), async (req, res) => {
  try {
    const callCenterId = req.params.callCenterId;

    const { data: members } = await supabase
      .from('team_members')
      .select('member_user_id, display_name, availability_hours, is_manager, status')
      .eq('entity_type', 'call_center').eq('entity_id', callCenterId);

    const agentRows = (members || []).filter((m) => m.is_manager !== true && m.status !== 'disabled');
    const memberIds = agentRows.map((m) => m.member_user_id);

    let presenceByUser = {};
    if (memberIds.length) {
      try {
        const { data: pres } = await supabase
          .from('agent_presence')
          .select('member_user_id, status, busy, busy_client_id, online_since, last_seen, session_calls')
          .in('member_user_id', memberIds);
        for (const p of (pres || [])) presenceByUser[p.member_user_id] = p;
      } catch { /* presence best-effort */ }
    }

    let tz = 'America/New_York';
    try { const { data: cc } = await supabase.from('call_centers').select('timezone').eq('id', callCenterId).maybeSingle(); if (cc && cc.timezone) tz = cc.timezone; } catch {}
    let nowTz = null;
    try { nowTz = presence.hoursNowInTz(tz); } catch {}

    const agents = agentRows.map((m) => {
      const p = presenceByUser[m.member_user_id] || null;
      const lastSeen = p && p.last_seen ? Date.parse(p.last_seen) : 0;
      const online = !!(p && lastSeen && (Date.now() - lastSeen) < presence.ONLINE_WINDOW_MS);
      let onSchedule = true;
      try { onSchedule = presence.isAgentOnSchedule(m.availability_hours || null, tz, nowTz); } catch { onSchedule = true; }
      return {
        memberUserId: m.member_user_id,
        displayName: m.display_name || null,
        online,
        status: p && p.status === 'away' ? 'away' : 'available',
        busy: !!(p && p.busy),
        busyClientId: (p && p.busy_client_id) || null,
        sessionCalls: (p && p.session_calls) || 0,
        scheduleEnabled: !!(m.availability_hours && m.availability_hours.enabled),
        override: !!(m.availability_hours && m.availability_hours.override),
        onSchedule,
      };
    });

    res.json({
      success: true,
      online: agents.filter((a) => a.online).length,
      available: agents.filter((a) => a.online && a.status === 'available' && !a.busy && a.onSchedule).length,
      agents,
    });
  } catch (e) {
    console.error('cc-agents: cc presence failed:', e.message);
    res.status(500).json({ success: false, error: 'Could not load presence.' });
  }
});

// Shape an offer row for the client: only what the pop needs, no internals.
function shapeOffer(o) {
  if (!o) return null;
  return {
    id: o.id,
    clientId: o.client_id,
    vapiCallId: o.vapi_call_id || null,
    businessName: o.business_name || null,
    callerNumber: o.caller_number || null,
    reason: o.reason || null,
    summary: o.summary || null,
    collected: o.collected || null,
    createdAt: o.created_at || null,
    expiresAt: o.expires_at || null,
    test: o.collected && o.collected.test === true ? true : undefined,
  };
}

module.exports = router;

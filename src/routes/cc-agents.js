// ============================================================================
// src/routes/cc-agents.js
// Mounted at: app.use('/api/cc', require('./routes/cc-agents'))
//
// The agent real-time plane for call-center escalation:
//
//   POST /api/cc/agent/heartbeat        -> presence upsert (online + available)
//   POST /api/cc/agent/status           -> flip available / away
//   GET  /api/cc/agent/stream           -> SSE: live escalation offers for me
//                                          (auth by ?token=, like the monitor)
//   POST /api/cc/offer/:offerId/claim   -> race to take an offered call (atomic)
//   POST /api/cc/offer/:offerId/decline -> dismiss my pop (others keep theirs)
//   GET  /api/cc/:agencyId/agents/presence -> who is online (manager bar)
//   POST /api/cc/:agencyId/agents/test-offer -> fire a demo pop (manager only)
//
// Agent-centric routes resolve the caller from the JWT (agencyId + userId), the
// same local verification the live monitor uses. The manager routes use the
// shared requireAgencyAccess middleware. Nothing here touches a live call path;
// it is the plumbing the escalation hook (Stage 2) drives.
// ============================================================================

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { supabase } = require('../lib/supabase');
const { requireAgencyAccess } = require('./auth');
const presence = require('../lib/agent-presence');
const offers = require('../lib/escalation-offers');
const { channelForAgent, subscribeAgent, broadcastToAgent, broadcastToAgents } = require('../lib/agent-channel');

const JWT_SECRET = process.env.JWT_SECRET;

function decodeToken(raw) {
  if (!raw || !JWT_SECRET) return null;
  const token = String(raw).startsWith('Bearer ') ? String(raw).slice(7) : String(raw);
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

// Every agent-centric route needs a logged-in agency user (owner or staff). The
// agency + agent identity comes from the token, never the body.
function resolveAgent(decoded) {
  if (!decoded) return null;
  const role = decoded.role;
  const agencyId = decoded.agencyId || (decoded.type === 'agency' ? decoded.id : null);
  const memberUserId = decoded.userId || decoded.id || null;
  if (!agencyId || !memberUserId) return null;
  if (role !== 'agency_owner' && role !== 'agency_staff' && decoded.type !== 'agency') return null;
  return { agencyId, memberUserId, role };
}

// Pull the agent's saved delivery + phone + name from team_members (staff only;
// owners have no member row and default to a browser seat).
async function agentProfile(agencyId, memberUserId) {
  try {
    const { data } = await supabase
      .from('team_members')
      .select('display_name, call_delivery, agent_phone, availability_hours')
      .eq('entity_type', 'agency').eq('entity_id', agencyId)
      .eq('member_user_id', memberUserId)
      .maybeSingle();
    if (data) return { displayName: data.display_name || null, callDelivery: data.call_delivery || 'browser', agentPhone: data.agent_phone || null, availabilityHours: data.availability_hours || null };
  } catch { /* fall through */ }
  return { displayName: null, callDelivery: 'browser', agentPhone: null, availabilityHours: null };
}

// ---- POST /api/cc/agent/heartbeat -----------------------------------------
router.post('/agent/heartbeat', async (req, res) => {
  const agent = resolveAgent(decodeToken(req.headers.authorization));
  if (!agent) return res.status(401).json({ success: false, error: 'Unauthorized' });

  const status = (req.body && req.body.status) === 'away' ? 'away' : 'available';
  const prof = await agentProfile(agent.agencyId, agent.memberUserId);
  await presence.heartbeat({
    agencyId: agent.agencyId,
    memberUserId: agent.memberUserId,
    displayName: prof.displayName,
    callDelivery: prof.callDelivery,
    agentPhone: prof.agentPhone,
    status,
  });

  // Catch a (re)connecting agent up on any offer still open for them.
  const open = await offers.listOpenForAgent({ agencyId: agent.agencyId, memberUserId: agent.memberUserId });

  // Tell the agent whether they are within their working hours right now, so the
  // console can explain the quiet. No schedule / override => always on; only
  // pays the agency-timezone lookup when a schedule is actually set.
  const ah = prof.availabilityHours;
  const scheduleEnabled = !!(ah && ah.enabled);
  const override = !!(ah && ah.override);
  let onSchedule = true;
  if (scheduleEnabled && !override) {
    try {
      const { data: ag } = await supabase.from('agencies').select('timezone').eq('id', agent.agencyId).single();
      onSchedule = presence.isAgentOnSchedule(ah, (ag && ag.timezone) || 'America/New_York');
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
  await presence.setStatus({ agencyId: agent.agencyId, memberUserId: agent.memberUserId, status });
  res.json({ success: true, status });
});

// ---- GET /api/cc/agent/me -------------------------------------------------
// Read-only snapshot for the agent's own availability page: their saved working
// hours, whether they are on schedule right now, their override flag, their
// current presence status, and delivery. No writes (so it never fights the
// heartbeat loop that owns presence status).
router.get('/agent/me', async (req, res) => {
  const agent = resolveAgent(decodeToken(req.query.token || req.headers.authorization));
  if (!agent) return res.status(401).json({ success: false, error: 'Unauthorized' });

  const prof = await agentProfile(agent.agencyId, agent.memberUserId);
  const ah = prof.availabilityHours;
  const scheduleEnabled = !!(ah && ah.enabled);
  const override = !!(ah && ah.override);

  let timezone = 'America/New_York';
  try {
    const { data: ag } = await supabase.from('agencies').select('timezone').eq('id', agent.agencyId).single();
    if (ag && ag.timezone) timezone = ag.timezone;
  } catch (e) {}

  let onSchedule = true;
  if (scheduleEnabled && !override) {
    try { onSchedule = presence.isAgentOnSchedule(ah, timezone); } catch (e) { onSchedule = true; }
  }

  let status = 'available';
  try {
    const { data: pres } = await supabase.from('agent_presence')
      .select('status')
      .eq('agency_id', agent.agencyId).eq('member_user_id', agent.memberUserId)
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
// The agent flips their OWN availability override (make myself available now,
// even outside my set hours). The override lives in team_members.availability_hours
// (the same flag a manager can set from the Agents page), so routing and the
// manager presence bar pick it up on the next lookup. We preserve the rest of the
// schedule and only change the override boolean.
router.post('/agent/override', async (req, res) => {
  const agent = resolveAgent(decodeToken(req.headers.authorization));
  if (!agent) return res.status(401).json({ success: false, error: 'Unauthorized' });
  const override = !!(req.body && req.body.override === true);

  try {
    const { data: tm } = await supabase.from('team_members')
      .select('availability_hours')
      .eq('entity_type', 'agency').eq('entity_id', agent.agencyId)
      .eq('member_user_id', agent.memberUserId)
      .maybeSingle();
    if (!tm) return res.status(404).json({ success: false, error: 'No agent profile to update.' });

    const cur = (tm.availability_hours && typeof tm.availability_hours === 'object') ? tm.availability_hours : {};
    const next = { ...cur, override };
    const { error } = await supabase.from('team_members')
      .update({ availability_hours: next })
      .eq('entity_type', 'agency').eq('entity_id', agent.agencyId)
      .eq('member_user_id', agent.memberUserId);
    if (error) throw error;

    res.json({ success: true, override });
  } catch (e) {
    console.error('cc-agents: agent/override failed:', e.message);
    res.status(500).json({ success: false, error: 'Could not update your availability.' });
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
  // Refresh presence on connect and catch up on any live offer.
  presence.heartbeat({ agencyId: agent.agencyId, memberUserId: agent.memberUserId }).catch(() => {});
  offers.listOpenForAgent({ agencyId: agent.agencyId, memberUserId: agent.memberUserId })
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
// Race to take an offered call. The atomic claim means exactly one agent wins;
// losers get { won:false }. On a win we tell the other offered agents the offer
// is taken so their pops clear, and hand the winner the context their take-over
// needs (clientId + callId for a browser jump-in, or a "we are dialing you" note
// for a phone seat).
router.post('/offer/:offerId/claim', async (req, res) => {
  const agent = resolveAgent(decodeToken(req.headers.authorization));
  if (!agent) return res.status(401).json({ success: false, error: 'Unauthorized' });

  const offer = await offers.getOffer(req.params.offerId);
  if (!offer) return res.status(404).json({ success: false, error: 'That call is no longer available.' });
  if (offer.agency_id !== agent.agencyId) return res.status(403).json({ success: false, error: 'Forbidden' });
  if (offer.status !== 'open') {
    return res.json({ success: true, won: false, reason: offer.status === 'claimed' ? 'taken' : offer.status });
  }

  const prof = await agentProfile(agent.agencyId, agent.memberUserId);
  const claimed = await offers.claimOffer(offer.id, {
    memberUserId: agent.memberUserId,
    displayName: prof.displayName,
    callDelivery: prof.callDelivery,
  });
  if (!claimed) {
    return res.json({ success: true, won: false, reason: 'taken' });
  }

  // Mark the winner busy so they are not offered a second call mid-takeover.
  presence.setBusy({ agencyId: agent.agencyId, memberUserId: agent.memberUserId, busy: true, busyClientId: offer.client_id }).catch(() => {});
  // Count this as a call answered this session (for the manager presence hover).
  presence.incrementSessionCalls({ agencyId: agent.agencyId, memberUserId: agent.memberUserId }).catch(() => {});

  // Clear the pop for everyone else who was offered this call.
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
// Just dismiss this agent's own pop. The offer stays open for the others; if all
// decline it simply expires and the call path hands the caller back to the AI.
router.post('/offer/:offerId/decline', async (req, res) => {
  const agent = resolveAgent(decodeToken(req.headers.authorization));
  if (!agent) return res.status(401).json({ success: false, error: 'Unauthorized' });
  res.json({ success: true });
});

// ---- GET /api/cc/:agencyId/agents/presence (manager bar) ------------------
router.get('/:agencyId/agents/presence', requireAgencyAccess('team'), async (req, res) => {
  const agencyId = req.params.agencyId;
  const list = await presence.listForAgency(agencyId);

  // Annotate each agent with their working-hours state (in the agency timezone)
  // so the bar can show who is actually on: an off-hours agent is online but not
  // offered calls. Best-effort; on any failure everyone reads as on-schedule.
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

// ---- POST /api/cc/:agencyId/agents/test-offer (manager only) --------------
// Fire a demo escalation pop at the available agents for a business, so the
// screen-pop can be verified end-to-end before the live call path is wired.
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

// ============================================================================
// src/routes/cc-calls.js
// Mounted at: app.use('/api/agency', require('./routes/cc-calls'))
//
// Call-center call history: the searchable book of record for every call across
// the businesses a call center answers for.
//
//   GET /:agencyId/cc/calls           -> searchable, filterable, paginated list
//   GET /:agencyId/cc/calls/:callId   -> one call's full detail (transcript,
//                                        recording, who handled it, outcome)
//
// Scoped to the viewer exactly like cc-analytics: an owner/manager sees every
// business, an assigned agent sees only the businesses assigned to them. The
// outcome taxonomy and agent attribution match cc-analytics so history and the
// analytics page always agree.
//
// Filtering + pagination happen in the database (correct counts, scales to a
// busy call center). The outcome FILTER values are each a single positive,
// null-safe predicate ("calls that were transferred / booked / spam / an agent
// took over"); the displayed outcome LABEL is the priority taxonomy below.
// ============================================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { requireAgencyAccess } = require('./auth');

// Agent scoping (mirrors cc-analytics): a non-null assigned_client_ids array
// limits an agency_staff viewer to those clients. Null = unrestricted.
async function resolveScope(decoded, agencyId) {
  if (decoded && decoded.role === 'agency_staff') {
    const { data: m } = await supabase
      .from('team_members').select('assigned_client_ids')
      .eq('member_user_id', decoded.userId).eq('entity_type', 'agency').eq('entity_id', agencyId).single();
    if (m && Array.isArray(m.assigned_client_ids)) return m.assigned_client_ids;
  }
  return null;
}
async function scopedClients(req, agencyId) {
  const { data: clients } = await supabase
    .from('clients').select('id, business_name').eq('agency_id', agencyId);
  let list = clients || [];
  const scope = await resolveScope(req.user, agencyId);
  if (Array.isArray(scope)) { const ok = new Set(scope); list = list.filter((c) => ok.has(c.id)); }
  return list;
}

// Outcome taxonomy (priority order), matching cc-analytics + the client detail.
function isSpam(c) { return c.is_spam === true || c.call_status === 'spam'; }
function isTransferred(c) { return c.call_status === 'transferred' || c.transfer_status === 'transferred'; }
function supEvents(c) {
  return c.call_metadata && Array.isArray(c.call_metadata.supervisor_events) ? c.call_metadata.supervisor_events : [];
}
function tookOver(c) { return supEvents(c).some((e) => e && e.action === 'jumped_in'); }
function handlerName(c) {
  const ev = supEvents(c);
  const named = ev.find((e) => e && e.name);
  return named ? named.name : null;
}
function outcomeLabel(c) {
  if (isSpam(c)) return 'Spam';
  if (isTransferred(c)) return 'Transferred';
  if (tookOver(c)) return 'Agent took over';
  if (c.appointment_booked) return 'Booked';
  return 'Handled by AI';
}

// Strip characters that would break a PostgREST or()/ilike filter string.
function sanitizeSearch(q) {
  return String(q || '').replace(/[,()*:"%]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function placeholderName(n) {
  const t = String(n || '').trim().toLowerCase();
  return !t || t === 'unknown' || t === 'unknown caller';
}
function callerDisplay(c) {
  if (!placeholderName(c.customer_name)) return c.customer_name;
  return c.customer_phone || c.caller_phone || null;
}

// Parse a client-supplied date safely; an unparseable value yields null (so a
// bad ?from=/&to= can never throw a 500) rather than Invalid Date.
function safeIso(s) {
  const t = Date.parse(String(s || ''));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

const RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90 };
const LIST_COLS = 'id, created_at, client_id, caller_phone, customer_name, customer_phone, duration_seconds, appointment_booked, call_status, transfer_status, is_spam, sentiment, call_language, call_metadata';
const DETAIL_COLS = 'id, created_at, client_id, caller_phone, customer_name, customer_phone, customer_email, customer_address, service_requested, urgency_level, ai_summary, summary, transcript, recording_url, duration_seconds, call_status, transfer_status, ended_reason, is_spam, spam_reason, call_language, appointment_booked, appointment_time, sentiment, call_metadata';

// ---------------------------------------------------------------------------
// GET /:agencyId/cc/calls  — searchable, filterable, paginated history.
//   q, business(clientId), outcome(booked|transferred|took_over|spam),
//   handledBy(agent name), range(7d|30d|90d|all), from, to, page, limit
// ---------------------------------------------------------------------------
router.get('/:agencyId/cc/calls', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const { agencyId } = req.params;
    const clients = await scopedClients(req, agencyId);
    const nameById = new Map(clients.map((c) => [c.id, c.business_name || 'Business']));
    let clientIds = clients.map((c) => c.id);

    // Optional single-business filter, only if it is in the viewer's scope.
    const business = (req.query.business || '').toString().trim();
    if (business) clientIds = clientIds.filter((id) => id === business);

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));

    if (clientIds.length === 0) {
      return res.json({ success: true, page, limit, total: 0, totalPages: 0, businesses: toBizList(clients), rows: [] });
    }

    let query = supabase
      .from('calls')
      .select(LIST_COLS, { count: 'exact' })
      .in('client_id', clientIds);

    // Date window.
    const range = (req.query.range || '30d').toString();
    const fromIso = safeIso(req.query.from);
    const toIso = safeIso(req.query.to);
    if (fromIso) query = query.gte('created_at', fromIso);
    else if (range !== 'all' && RANGE_DAYS[range]) {
      query = query.gte('created_at', new Date(Date.now() - RANGE_DAYS[range] * 86400000).toISOString());
    }
    if (toIso) query = query.lte('created_at', toIso);

    // Text search across caller + summary fields.
    const q = sanitizeSearch(req.query.q);
    if (q) {
      query = query.or(
        `customer_name.ilike.*${q}*,customer_phone.ilike.*${q}*,caller_phone.ilike.*${q}*,summary.ilike.*${q}*,ai_summary.ilike.*${q}*`
      );
    }

    // Outcome filter - each a single positive, null-safe predicate.
    const outcome = (req.query.outcome || '').toString();
    if (outcome === 'booked') query = query.eq('appointment_booked', true);
    else if (outcome === 'transferred') query = query.or('call_status.eq.transferred,transfer_status.eq.transferred');
    else if (outcome === 'spam') query = query.or('is_spam.is.true,call_status.eq.spam');
    else if (outcome === 'took_over') query = query.contains('call_metadata', { supervisor_events: [{ action: 'jumped_in' }] });

    // Handled-by a specific agent (name as stored on the supervisor events).
    const handledBy = (req.query.handledBy || '').toString().trim();
    if (handledBy) query = query.contains('call_metadata', { supervisor_events: [{ name: handledBy }] });

    query = query
      .order('created_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    const { data, count, error } = await query;
    if (error) { console.error('cc/calls list error:', error.message); return res.status(500).json({ success: false, error: 'Server error' }); }

    const rows = (data || []).map((c) => ({
      id: c.id,
      clientId: c.client_id,
      businessName: nameById.get(c.client_id) || 'Business',
      caller: callerDisplay(c),
      callerPhone: c.customer_phone || c.caller_phone || null,
      outcome: outcomeLabel(c),
      handledBy: handlerName(c),
      tookOver: tookOver(c),
      transferred: isTransferred(c),
      booked: c.appointment_booked === true,
      spam: isSpam(c),
      sentiment: c.sentiment || null,
      language: c.call_language || null,
      durationSeconds: c.duration_seconds || 0,
      at: c.created_at,
    }));

    const total = count || 0;
    res.json({
      success: true,
      page, limit, total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      businesses: toBizList(clients),
      rows,
    });
  } catch (e) {
    console.error('cc/calls list error:', e.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// Businesses the viewer can filter by (for the list's business dropdown).
function toBizList(clients) {
  return clients
    .map((c) => ({ clientId: c.id, businessName: c.business_name || 'Business' }))
    .sort((a, b) => a.businessName.localeCompare(b.businessName));
}

// ---------------------------------------------------------------------------
// GET /:agencyId/cc/calls/:callId  — one call's full detail.
// ---------------------------------------------------------------------------
router.get('/:agencyId/cc/calls/:callId', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const { agencyId, callId } = req.params;

    const { data: call, error } = await supabase
      .from('calls').select(DETAIL_COLS).eq('id', callId).maybeSingle();
    if (error) { console.error('cc/calls detail error:', error.message); return res.status(500).json({ success: false, error: 'Server error' }); }
    if (!call) return res.status(404).json({ success: false, error: 'Call not found' });

    // Enforce the viewer's scope: the call's business must be one they can see.
    const clients = await scopedClients(req, agencyId);
    const okIds = new Set(clients.map((c) => c.id));
    if (!okIds.has(call.client_id)) return res.status(404).json({ success: false, error: 'Call not found' });

    // Business name + HIPAA (hides recording/transcript, same as the client view).
    const { data: client } = await supabase
      .from('clients').select('business_name, hipaa_mode').eq('id', call.client_id).maybeSingle();

    const hipaa = !!(client && client.hipaa_mode === true);
    // Defense in depth: never ship the recording or transcript for a HIPAA
    // business, even if an older record still has them stored.
    if (hipaa) { call.recording_url = null; call.transcript = null; }

    res.json({
      success: true,
      businessName: (client && client.business_name) || 'Business',
      hipaa,
      outcome: outcomeLabel(call),
      call,
    });
  } catch (e) {
    console.error('cc/calls detail error:', e.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

module.exports = router;
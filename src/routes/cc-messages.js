// ============================================================================
// src/routes/cc-messages.js
// Mounted at: app.use('/api/agency', require('./routes/cc-messages'))
//
// Call-center messages & callbacks inbox: the worklist of calls the AI handled
// that still need a human to follow up (not spam, not transferred to a person,
// no appointment booked). Agents clear them - mark done, add a note, or reopen.
//
//   GET  /:agencyId/cc/messages              -> the worklist (open by default)
//   GET  /:agencyId/cc/messages/count        -> open count (nav badge / tile)
//   POST /:agencyId/cc/messages/:callId/resolve  -> mark done (optional note)
//   POST /:agencyId/cc/messages/:callId/reopen   -> back to open
//   POST /:agencyId/cc/messages/:callId/note     -> set/update the note only
//
// "Open" means a follow-up candidate with no done row. That parent-filtered-by-
// child-null query is served by the cc_followup_inbox view, so filtering and
// pagination happen in the database. Scoped to the viewer exactly like the rest
// of /cc: an owner/manager sees every business, an agent only their assigned.
// ============================================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { requireAgencyAccess } = require('./auth');

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

// The display name to stamp on a resolution. Staff: their team_members name;
// owner/impersonation: a name off the token, else a sensible fallback.
async function resolverName(decoded, agencyId) {
  if (decoded && decoded.role === 'agency_staff' && decoded.userId) {
    const { data: m } = await supabase
      .from('team_members').select('display_name')
      .eq('member_user_id', decoded.userId).eq('entity_type', 'agency').eq('entity_id', agencyId).maybeSingle();
    if (m && m.display_name) return m.display_name;
  }
  return (decoded && (decoded.name || [decoded.first_name, decoded.last_name].filter(Boolean).join(' ') || decoded.email)) || 'Manager';
}

function placeholderName(n) {
  const t = String(n || '').trim().toLowerCase();
  return !t || t === 'unknown' || t === 'unknown caller';
}
function sanitizeSearch(q) {
  return String(q || '').replace(/[,()*:"%]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}
function safeIso(s) {
  const t = Date.parse(String(s || ''));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

const RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90 };
const VIEW_COLS = 'id, created_at, client_id, agency_id, caller_phone, customer_name, customer_phone, duration_seconds, ai_summary, summary, service_requested, urgency_level, sentiment, followup_status, followup_note, followup_resolved_by, followup_resolved_at';

// Resolve + scope-check a call for a write. Returns { call } or { error, code }.
async function scopedCall(req, agencyId, callId) {
  const { data: call } = await supabase
    .from('calls').select('id, client_id').eq('id', callId).maybeSingle();
  if (!call) return { error: 'Call not found', code: 404 };
  const clients = await scopedClients(req, agencyId);
  const ok = new Set(clients.map((c) => c.id));
  if (!ok.has(call.client_id)) return { error: 'Call not found', code: 404 };
  return { call };
}

// ---- GET /:agencyId/cc/messages -------------------------------------------
router.get('/:agencyId/cc/messages', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const { agencyId } = req.params;
    const clients = await scopedClients(req, agencyId);
    const nameById = new Map(clients.map((c) => [c.id, c.business_name || 'Business']));
    let clientIds = clients.map((c) => c.id);

    const business = (req.query.business || '').toString().trim();
    if (business) clientIds = clientIds.filter((id) => id === business);

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));

    if (clientIds.length === 0) {
      return res.json({ success: true, page, limit, total: 0, totalPages: 0, openTotal: 0, businesses: toBizList(clients), rows: [] });
    }

    const status = (req.query.status || 'open').toString();
    let q = supabase.from('cc_followup_inbox').select(VIEW_COLS, { count: 'exact' })
      .eq('agency_id', agencyId).in('client_id', clientIds);
    if (status === 'open' || status === 'done') q = q.eq('followup_status', status);

    // Date window (default: all, since a follow-up does not expire by date).
    const range = (req.query.range || 'all').toString();
    const fromIso = safeIso(req.query.from);
    const toIso = safeIso(req.query.to);
    if (fromIso) q = q.gte('created_at', fromIso);
    else if (range !== 'all' && RANGE_DAYS[range]) q = q.gte('created_at', new Date(Date.now() - RANGE_DAYS[range] * 86400000).toISOString());
    if (toIso) q = q.lte('created_at', toIso);

    const search = sanitizeSearch(req.query.q);
    if (search) {
      q = q.or(`customer_name.ilike.*${search}*,customer_phone.ilike.*${search}*,caller_phone.ilike.*${search}*,ai_summary.ilike.*${search}*,summary.ilike.*${search}*,service_requested.ilike.*${search}*`);
    }

    q = q.order('created_at', { ascending: false }).range((page - 1) * limit, page * limit - 1);
    const { data, count, error } = await q;
    if (error) { console.error('cc/messages list error:', error.message); return res.status(500).json({ success: false, error: 'Server error' }); }

    // Open backlog across everything in scope (for the badge), independent of
    // the current filters/paging.
    const { count: openTotal } = await supabase.from('cc_followup_inbox')
      .select('id', { count: 'exact', head: true })
      .eq('agency_id', agencyId).in('client_id', clientIds).eq('followup_status', 'open');

    const rows = (data || []).map((c) => ({
      id: c.id,
      clientId: c.client_id,
      businessName: nameById.get(c.client_id) || 'Business',
      caller: placeholderName(c.customer_name) ? (c.customer_phone || c.caller_phone || null) : c.customer_name,
      callerPhone: c.customer_phone || c.caller_phone || null,
      reason: c.ai_summary || c.summary || c.service_requested || null,
      service: c.service_requested || null,
      urgency: c.urgency_level || null,
      sentiment: c.sentiment || null,
      durationSeconds: c.duration_seconds || 0,
      at: c.created_at,
      status: c.followup_status || 'open',
      note: c.followup_note || null,
      resolvedBy: c.followup_resolved_by || null,
      resolvedAt: c.followup_resolved_at || null,
    }));

    const total = count || 0;
    res.json({
      success: true, page, limit, total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      openTotal: openTotal || 0,
      businesses: toBizList(clients),
      rows,
    });
  } catch (e) {
    console.error('cc/messages list error:', e.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

function toBizList(clients) {
  return clients.map((c) => ({ clientId: c.id, businessName: c.business_name || 'Business' }))
    .sort((a, b) => a.businessName.localeCompare(b.businessName));
}

// ---- GET /:agencyId/cc/messages/count -------------------------------------
router.get('/:agencyId/cc/messages/count', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const { agencyId } = req.params;
    const clients = await scopedClients(req, agencyId);
    const clientIds = clients.map((c) => c.id);
    if (clientIds.length === 0) return res.json({ success: true, open: 0 });
    const { count } = await supabase.from('cc_followup_inbox')
      .select('id', { count: 'exact', head: true })
      .eq('agency_id', agencyId).in('client_id', clientIds).eq('followup_status', 'open');
    res.json({ success: true, open: count || 0 });
  } catch (e) {
    console.error('cc/messages count error:', e.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ---- POST /:agencyId/cc/messages/:callId/resolve --------------------------
router.post('/:agencyId/cc/messages/:callId/resolve', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const { agencyId, callId } = req.params;
    const chk = await scopedCall(req, agencyId, callId);
    if (chk.error) return res.status(chk.code).json({ success: false, error: chk.error });

    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 2000) : null;
    const name = await resolverName(req.user, agencyId);
    const { error } = await supabase.from('call_followups').upsert({
      call_id: callId,
      agency_id: agencyId,
      client_id: chk.call.client_id,
      status: 'done',
      note,
      resolved_by: req.user?.userId || null,
      resolved_by_name: name,
      resolved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'call_id' });
    if (error) { console.error('cc/messages resolve error:', error.message); return res.status(500).json({ success: false, error: 'Could not update' }); }
    res.json({ success: true, status: 'done', resolvedBy: name });
  } catch (e) {
    console.error('cc/messages resolve error:', e.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ---- POST /:agencyId/cc/messages/:callId/reopen ---------------------------
router.post('/:agencyId/cc/messages/:callId/reopen', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const { agencyId, callId } = req.params;
    const chk = await scopedCall(req, agencyId, callId);
    if (chk.error) return res.status(chk.code).json({ success: false, error: chk.error });

    const { error } = await supabase.from('call_followups').upsert({
      call_id: callId,
      agency_id: agencyId,
      client_id: chk.call.client_id,
      status: 'open',
      resolved_by: null,
      resolved_by_name: null,
      resolved_at: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'call_id' });
    if (error) { console.error('cc/messages reopen error:', error.message); return res.status(500).json({ success: false, error: 'Could not update' }); }
    res.json({ success: true, status: 'open' });
  } catch (e) {
    console.error('cc/messages reopen error:', e.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ---- POST /:agencyId/cc/messages/:callId/note -----------------------------
router.post('/:agencyId/cc/messages/:callId/note', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const { agencyId, callId } = req.params;
    const chk = await scopedCall(req, agencyId, callId);
    if (chk.error) return res.status(chk.code).json({ success: false, error: chk.error });

    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 2000) : '';
    // Upsert the note without changing an existing status (default open on first write).
    const { data: existing } = await supabase.from('call_followups').select('status').eq('call_id', callId).maybeSingle();
    const { error } = await supabase.from('call_followups').upsert({
      call_id: callId,
      agency_id: agencyId,
      client_id: chk.call.client_id,
      status: existing?.status || 'open',
      note,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'call_id' });
    if (error) { console.error('cc/messages note error:', error.message); return res.status(500).json({ success: false, error: 'Could not save note' }); }
    res.json({ success: true, note });
  } catch (e) {
    console.error('cc/messages note error:', e.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

module.exports = router;

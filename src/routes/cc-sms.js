// ============================================================================
// src/routes/cc-sms.js
// Mounted at: app.use('/api/agency', require('./routes/cc-sms'))
//
// Call-center TEXTS inbox: two-way SMS across every business the call center
// serves, in one place. The underlying threads live in the same sms_conversations
// / sms_messages tables the reseller client dashboard uses, and outbound sends go
// through the ONE shared send path (routes/sms.js sendClientSms), so transport
// choice, threading, opt-out and logging never drift between surfaces.
//
//   GET  /:agencyId/cc/sms/conversations                      -> inbox list
//   GET  /:agencyId/cc/sms/conversations/:conversationId      -> one thread
//   POST /:agencyId/cc/sms/conversations/:conversationId/send -> reply
//   POST /:agencyId/cc/sms/conversations/:conversationId/read -> mark read
//   POST /:agencyId/cc/sms/conversations/:conversationId/archive -> toggle
//   GET  /:agencyId/cc/sms/unread                             -> badge count
//
// Scoped to the viewer exactly like /cc: an owner/manager sees every business,
// an agent only the businesses assigned to them (team_members.assigned_client_ids).
// ============================================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { requireAgencyAccess } = require('./auth');
const { sendClientSms } = require('./sms');

// Agents are scoped to their assigned businesses; owner/manager get null (all).
async function resolveScope(decoded, agencyId) {
  if (decoded && decoded.role === 'agency_staff') {
    const { data: m } = await supabase
      .from('team_members').select('assigned_client_ids')
      .eq('member_user_id', decoded.userId).eq('entity_type', 'agency').eq('entity_id', agencyId).maybeSingle();
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
function toBizList(clients) {
  return clients.map((c) => ({ clientId: c.id, businessName: c.business_name || 'Business' }))
    .sort((a, b) => a.businessName.localeCompare(b.businessName));
}
function sanitizeSearch(q) {
  return String(q || '').replace(/[,()*:"%]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

// The viewer's user id, for per-user archive state.
function viewerId(req) { return (req.user && (req.user.userId || req.user.id)) || null; }

// Conversation ids THIS viewer has archived. Archive is account-specific for the
// call-center inbox (an agent archiving a thread does NOT archive it for the
// manager), so it lives in sms_conversation_user_state keyed by user, not on the
// shared sms_conversations.is_archived flag.
async function archivedSetForViewer(req) {
  const uid = viewerId(req);
  if (!uid) return new Set();
  try {
    const { data } = await supabase.from('sms_conversation_user_state')
      .select('conversation_id').eq('user_id', uid).eq('archived', true);
    return new Set((data || []).map((r) => r.conversation_id));
  } catch { return new Set(); }
}

// This viewer's display name, stamped on an outbound text so a manager sees which
// agent replied. Agency staff -> their team name; owner -> token name/email.
async function senderName(req, agencyId) {
  const d = req.user || {};
  if (d.role === 'agency_staff' && (d.userId || d.id)) {
    try {
      const { data: m } = await supabase.from('team_members').select('display_name')
        .eq('member_user_id', d.userId || d.id).eq('entity_type', 'agency').eq('entity_id', agencyId).maybeSingle();
      if (m && m.display_name) return m.display_name;
    } catch (e) { /* fall through */ }
  }
  return d.name || [d.first_name, d.last_name].filter(Boolean).join(' ') || d.email || 'Manager';
}

// Resolve + scope-check a conversation for a read/write. Returns { conv, client_id }
// or { error, code }.
async function scopedConversation(req, agencyId, conversationId) {
  const { data: conv } = await supabase
    .from('sms_conversations')
    .select('id, client_id, caller_phone, caller_name, is_archived, unread_count')
    .eq('id', conversationId).maybeSingle();
  if (!conv) return { error: 'Conversation not found', code: 404 };
  const clients = await scopedClients(req, agencyId);
  const ok = new Set(clients.map((c) => c.id));
  if (!ok.has(conv.client_id)) return { error: 'Conversation not found', code: 404 };
  const nameById = new Map(clients.map((c) => [c.id, c.business_name || 'Business']));
  return { conv, businessName: nameById.get(conv.client_id) || 'Business' };
}

function mapRow(c, nameById, archivedSet) {
  const name = (c.caller_name && c.caller_name.toLowerCase() !== 'unknown') ? c.caller_name : null;
  return {
    id: c.id,
    clientId: c.client_id,
    businessName: nameById.get(c.client_id) || 'Business',
    caller: name,
    callerPhone: c.caller_phone || null,
    lastPreview: c.last_message_preview || null,
    lastAt: c.last_message_at || c.created_at,
    lastDirection: c.last_direction || null,
    unread: c.unread_count || 0,
    archived: archivedSet ? archivedSet.has(c.id) : (c.is_archived === true),
  };
}

// ---- GET /:agencyId/cc/sms/conversations ----------------------------------
router.get('/:agencyId/cc/sms/conversations', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const { agencyId } = req.params;
    const clients = await scopedClients(req, agencyId);
    const nameById = new Map(clients.map((c) => [c.id, c.business_name || 'Business']));
    let clientIds = clients.map((c) => c.id);

    const business = (req.query.business || '').toString().trim();
    if (business) clientIds = clientIds.filter((id) => id === business);

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const archived = (req.query.archived === 'true');

    if (clientIds.length === 0) {
      return res.json({ success: true, page, limit, total: 0, totalPages: 0, unreadTotal: 0, businesses: toBizList(clients), rows: [] });
    }

    // Per-user archive: the Archived tab shows only threads THIS viewer archived;
    // the Inbox hides them. Archive state is not shared between accounts.
    const archivedSet = await archivedSetForViewer(req);
    const archivedIds = [...archivedSet];

    if (archived && archivedIds.length === 0) {
      return res.json({ success: true, page, limit, total: 0, totalPages: 0, unreadTotal: 0, businesses: toBizList(clients), rows: [] });
    }

    let q = supabase.from('sms_conversations')
      .select('id, client_id, caller_phone, caller_name, last_message_at, last_message_preview, last_direction, unread_count, is_archived, created_at', { count: 'exact' })
      .in('client_id', clientIds);
    if (archived) q = q.in('id', archivedIds);
    else if (archivedIds.length) q = q.not('id', 'in', `(${archivedIds.join(',')})`);

    const search = sanitizeSearch(req.query.q);
    if (search) q = q.or(`caller_name.ilike.*${search}*,caller_phone.ilike.*${search}*,last_message_preview.ilike.*${search}*`);

    q = q.order('last_message_at', { ascending: false, nullsFirst: false }).range((page - 1) * limit, page * limit - 1);
    const { data, count, error } = await q;
    if (error) { console.error('cc/sms list error:', error.message); return res.status(500).json({ success: false, error: 'Server error' }); }

    // Unread backlog across the full scope (for the nav badge), excluding threads
    // this viewer archived, independent of the current filters/paging.
    const { data: unreadRows } = await supabase.from('sms_conversations')
      .select('id, unread_count')
      .in('client_id', clients.map((c) => c.id)).gt('unread_count', 0);
    const unreadTotal = (unreadRows || []).filter((r) => !archivedSet.has(r.id)).reduce((s, r) => s + (r.unread_count || 0), 0);

    const total = count || 0;
    res.json({
      success: true, page, limit, total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      unreadTotal,
      businesses: toBizList(clients),
      rows: (data || []).map((c) => mapRow(c, nameById, archivedSet)),
    });
  } catch (e) {
    console.error('cc/sms list error:', e.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ---- GET /:agencyId/cc/sms/unread -----------------------------------------
router.get('/:agencyId/cc/sms/unread', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const { agencyId } = req.params;
    const clients = await scopedClients(req, agencyId);
    const clientIds = clients.map((c) => c.id);
    if (clientIds.length === 0) return res.json({ success: true, unread: 0, latest: null });
    const archivedSet = await archivedSetForViewer(req);
    const { data } = await supabase.from('sms_conversations')
      .select('id, client_id, caller_phone, caller_name, last_message_preview, last_message_at, last_direction, unread_count')
      .in('client_id', clientIds).gt('unread_count', 0)
      .order('last_message_at', { ascending: false, nullsFirst: false });
    const rows = (data || []).filter((r) => !archivedSet.has(r.id));
    const unread = rows.reduce((s, r) => s + (r.unread_count || 0), 0);
    // Most recent unread thread whose last message came IN, for the new-text
    // toast. (An outbound-last thread can still be unread if a reply landed and
    // was then replied to, so we filter to inbound for the alert.)
    const nameById = new Map(clients.map((c) => [c.id, c.business_name || 'Business']));
    const li = rows.find((r) => r.last_direction === 'inbound') || null;
    const latest = li ? {
      conversationId: li.id,
      businessName: nameById.get(li.client_id) || 'Business',
      caller: (li.caller_name && li.caller_name.toLowerCase() !== 'unknown') ? li.caller_name : null,
      callerPhone: li.caller_phone || null,
      preview: li.last_message_preview || null,
      at: li.last_message_at || null,
    } : null;
    res.json({ success: true, unread, latest });
  } catch (e) {
    console.error('cc/sms unread error:', e.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ---- GET /:agencyId/cc/sms/conversations/:conversationId ------------------
router.get('/:agencyId/cc/sms/conversations/:conversationId', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const { agencyId, conversationId } = req.params;
    const chk = await scopedConversation(req, agencyId, conversationId);
    if (chk.error) return res.status(chk.code).json({ success: false, error: chk.error });

    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const { data: messages, error } = await supabase
      .from('sms_messages')
      .select('id, direction, content, sender_phone, recipient_phone, status, error_message, sent_at, created_at, sent_by_name')
      .eq('conversation_id', conversationId)
      .order('sent_at', { ascending: false })
      .limit(limit);
    if (error) return res.status(400).json({ success: false, error: error.message });

    // Per-user archive state for this thread (drives the Archive/Unarchive label).
    let archivedForViewer = false;
    const uid = viewerId(req);
    if (uid) {
      const { data: st } = await supabase.from('sms_conversation_user_state')
        .select('archived').eq('conversation_id', conversationId).eq('user_id', uid).maybeSingle();
      archivedForViewer = !!(st && st.archived);
    }

    res.json({
      success: true,
      conversation: {
        id: chk.conv.id,
        clientId: chk.conv.client_id,
        businessName: chk.businessName,
        caller: (chk.conv.caller_name && chk.conv.caller_name.toLowerCase() !== 'unknown') ? chk.conv.caller_name : null,
        callerPhone: chk.conv.caller_phone || null,
        archived: archivedForViewer,
      },
      messages: (messages || []).reverse().map((m) => ({
        id: m.id,
        direction: m.direction,
        content: m.content,
        status: m.status || (m.direction === 'inbound' ? 'received' : 'sent'),
        error: m.error_message || null,
        at: m.sent_at || m.created_at,
        sentBy: m.sent_by_name || null,
      })),
    });
  } catch (e) {
    console.error('cc/sms thread error:', e.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ---- POST /:agencyId/cc/sms/conversations/:conversationId/send ------------
// The agent never passes a raw number: we send to the thread's own caller, from
// the thread's business number, via the shared send path.
router.post('/:agencyId/cc/sms/conversations/:conversationId/send', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const { agencyId, conversationId } = req.params;
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message) return res.status(400).json({ success: false, error: 'Message is required' });

    const chk = await scopedConversation(req, agencyId, conversationId);
    if (chk.error) return res.status(chk.code).json({ success: false, error: chk.error });
    if (!chk.conv.caller_phone) return res.status(400).json({ success: false, error: 'This thread has no caller number to reply to' });

    const who = await senderName(req, agencyId);
    const result = await sendClientSms({ clientId: chk.conv.client_id, to: chk.conv.caller_phone, message, sentBy: { userId: viewerId(req), name: who } });
    if (result.error) return res.status(result.code || 500).json({ success: false, error: result.error, details: result.details });

    res.json({
      success: true,
      message: result.savedMessage ? {
        id: result.savedMessage.id,
        direction: 'outbound',
        content: message,
        status: result.savedMessage.status || 'sent',
        error: null,
        at: result.savedMessage.sent_at || result.savedMessage.created_at || new Date().toISOString(),
        sentBy: who,
      } : null,
    });
  } catch (e) {
    console.error('cc/sms send error:', e.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ---- POST /:agencyId/cc/sms/conversations/:conversationId/read ------------
router.post('/:agencyId/cc/sms/conversations/:conversationId/read', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const { agencyId, conversationId } = req.params;
    const chk = await scopedConversation(req, agencyId, conversationId);
    if (chk.error) return res.status(chk.code).json({ success: false, error: chk.error });
    const { error } = await supabase.from('sms_conversations').update({ unread_count: 0 }).eq('id', conversationId);
    if (error) return res.status(400).json({ success: false, error: error.message });
    res.json({ success: true });
  } catch (e) {
    console.error('cc/sms read error:', e.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ---- POST /:agencyId/cc/sms/conversations/:conversationId/archive ---------
router.post('/:agencyId/cc/sms/conversations/:conversationId/archive', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const { agencyId, conversationId } = req.params;
    const chk = await scopedConversation(req, agencyId, conversationId);
    if (chk.error) return res.status(chk.code).json({ success: false, error: chk.error });
    const archived = req.body?.archived === true;
    const uid = viewerId(req);
    if (!uid) return res.status(400).json({ success: false, error: 'Could not identify the account.' });
    // Account-specific: archiving only affects THIS viewer's inbox, not everyone.
    const { error } = await supabase.from('sms_conversation_user_state')
      .upsert({ conversation_id: conversationId, user_id: uid, archived, updated_at: new Date().toISOString() }, { onConflict: 'conversation_id,user_id' });
    if (error) return res.status(400).json({ success: false, error: error.message });
    res.json({ success: true, archived });
  } catch (e) {
    console.error('cc/sms archive error:', e.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ---- POST /:agencyId/cc/sms/start -----------------------------------------
// Start (or reopen) a conversation by texting a number for a business. Used by
// the Texts "New text" composer, both to a saved contact and to a new number.
// The shared send path finds-or-creates the thread, so sending to an existing
// number just adds to that thread. Returns the conversationId to open.
router.post('/:agencyId/cc/sms/start', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const { agencyId } = req.params;
    const clientId = (req.body?.clientId || '').toString();
    const to = (req.body?.to || '').toString();
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!clientId) return res.status(400).json({ success: false, error: 'Pick a business to text from.' });
    if (!to.trim()) return res.status(400).json({ success: false, error: 'A phone number is required.' });
    if (!message) return res.status(400).json({ success: false, error: 'Write a message to send.' });

    // Scope-check: the chosen business must be in the viewer's scope.
    const clients = await scopedClients(req, agencyId);
    if (!clients.some((c) => c.id === clientId)) return res.status(404).json({ success: false, error: 'Business not found' });

    const who = await senderName(req, agencyId);
    const result = await sendClientSms({ clientId, to, message, sentBy: { userId: viewerId(req), name: who } });
    if (result.error) return res.status(result.code || 500).json({ success: false, error: result.error, details: result.details });

    res.json({
      success: true,
      conversationId: result.conversation ? result.conversation.id : null,
      message: result.savedMessage ? {
        id: result.savedMessage.id,
        direction: 'outbound',
        content: message,
        status: result.savedMessage.status || 'sent',
        error: null,
        at: result.savedMessage.sent_at || result.savedMessage.created_at || new Date().toISOString(),
      } : null,
    });
  } catch (e) {
    console.error('cc/sms start error:', e.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

module.exports = router;

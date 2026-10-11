// ============================================================================
// SUPPORT THREADS - two-way platform <-> agency messaging on support_requests
// ----------------------------------------------------------------------------
// support_requests is the agency -> platform channel (admin Support queue). Its
// `message` column is the agency's original note (the thread seed). Every reply
// after that, from the platform admin OR back from the agency, is a row in
// support_thread_messages, so a request becomes a two-way conversation. This is
// deliberately SEPARATE from agency_support_requests (the client -> agency
// inbox); the two never cross.
//
//   Admin  (requireAdmin):
//     GET  /api/admin/support-requests/:id/thread   seed + messages, marks agency replies read
//     POST /api/admin/support-requests/:id/reply    admin reply, notifies the agency owner
//   Agency (requireAgencyAccess('dashboard')):
//     GET  /api/agency/:agencyId/platform-threads        list + per-thread/total unread
//     GET  /api/agency/:agencyId/platform-threads/:id    seed + messages, marks admin replies read
//     POST /api/agency/:agencyId/platform-threads/:id/reply  agency reply, notifies the platform
//
// Edge cases handled:
//   - Ownership: admin via platform_admin token; agency via requireAgencyAccess
//     AND an agency_id equality on every row touch, so a guessed id from another
//     agency resolves to not-found rather than leaking or writing.
//   - Only agency_id-bound requests are agency-visible; anonymous widget rows
//     (agency_id null) stay admin-only and simply get no in-app delivery.
//   - Validation: body required, trimmed, capped at 4000 chars.
//   - An agency reply to a resolved thread reopens it (status -> open, clears
//     resolved_at) so it resurfaces in the admin queue.
//   - Unread counters are denormalized on support_requests (agency_unread /
//     admin_unread) and reset to 0 when that side opens the thread.
//   - Every notification is best-effort and non-blocking: a send failure, or a
//     missing phone, never fails the reply insert.
//
// Mounted in server.js:
//   app.use('/api/admin',  require('./routes/support-thread').adminRouter);
//   app.use('/api/agency', require('./routes/support-thread').agencyRouter);
//
// Destination: src/routes/support-thread.js (NEW FILE)
// ============================================================================
const express = require('express');
const jwt = require('jsonwebtoken');
const { supabase } = require('../lib/supabase');
const { requireAgencyAccess } = require('./auth');

const MAX_BODY = 4000;
const APP_URL = process.env.APP_URL || 'https://myvoiceaiconnect.com';

function clean(str, max) {
  return String(str == null ? '' : str).trim().slice(0, max);
}

// Local copy of admin.js's requireAdmin (platform_admin JWT) so this router is
// self-contained rather than coupling to admin.js internals.
function requireAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    if (decoded.role !== 'platform_admin') {
      return res.status(403).json({ error: 'Not authorized as platform admin' });
    }
    req.admin = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Lazy notification senders - a missing module must never break a reply.
let sendAndLogSMS = async () => {};
let sendPlatformNotificationSMS = async () => {};
try { ({ sendAndLogSMS } = require('../lib/sms-logger')); } catch (e) { /* SMS disabled */ }
try { ({ sendPlatformNotificationSMS } = require('../lib/notifications')); } catch (e) { /* SMS disabled */ }

// Load a request row (404 if missing). For agency calls, scope by agency_id so
// another agency's id resolves to not-found.
async function loadRequest(id, agencyId) {
  let q = supabase.from('support_requests').select('*').eq('id', id);
  if (agencyId) q = q.eq('agency_id', agencyId);
  const { data } = await q.single();
  return data || null;
}

async function threadMessages(requestId) {
  const { data } = await supabase
    .from('support_thread_messages')
    .select('id, sender, body, created_at')
    .eq('request_id', requestId)
    .order('created_at', { ascending: true });
  return data || [];
}

// Seed (the agency's original request.message) + all replies, as one ordered
// conversation. The seed is synthetic (id "seed-<uuid>"), never a stored row.
function buildThread(request, messages) {
  const seed = request.message
    ? [{ id: `seed-${request.id}`, sender: 'agency', body: request.message, created_at: request.created_at, seed: true }]
    : [];
  return [...seed, ...messages];
}

// Merge EVERY one of an agency's requests (support + feedback) into a single
// chronological conversation: each request's seed (tagged with its kind, and
// the client name when it references a specific client) plus all thread
// messages, sorted by time. One running thread per agency so neither side hunts
// ticket to ticket. New replies attach to the most recent request.
async function buildAgencyThread(agencyId) {
  const { data: requests } = await supabase
    .from('support_requests').select('*')
    .eq('agency_id', agencyId)
    .order('created_at', { ascending: true });
  const reqs = requests || [];
  const ids = reqs.map((r) => r.id);
  let msgs = [];
  if (ids.length) {
    const { data } = await supabase
      .from('support_thread_messages')
      .select('id, request_id, sender, body, created_at')
      .in('request_id', ids)
      .order('created_at', { ascending: true });
    msgs = data || [];
  }
  const clientIds = [...new Set(reqs.map((r) => r.client_id).filter(Boolean))];
  const clientNames = {};
  if (clientIds.length) {
    const { data: clients } = await supabase.from('clients').select('id, business_name').in('id', clientIds);
    (clients || []).forEach((c) => { clientNames[c.id] = c.business_name; });
  }
  const stream = [];
  for (const r of reqs) {
    if (r.message) {
      stream.push({
        id: `seed-${r.id}`, request_id: r.id, sender: 'agency', body: r.message,
        created_at: r.created_at, seed: true, kind: r.kind || 'support',
        client_name: r.client_id ? (clientNames[r.client_id] || null) : null,
      });
    }
  }
  for (const m of msgs) {
    stream.push({ id: m.id, request_id: m.request_id, sender: m.sender, body: m.body, created_at: m.created_at, seed: false });
  }
  stream.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  const latest = reqs.length ? reqs[reqs.length - 1] : null;
  return { thread: stream, latest_request_id: latest ? latest.id : null, request_ids: ids, open: reqs.some((r) => r.status !== 'resolved') };
}

// ---------------------------------------------------------------------------
// ADMIN ROUTER
// ---------------------------------------------------------------------------
const adminRouter = express.Router();

// Merged per-agency conversation for the admin inbox: all of an agency's support
// + feedback as one thread. Opening clears the admin's unread across them all.
adminRouter.get('/agency-threads/:agencyId', requireAdmin, async (req, res) => {
  try {
    const { agencyId } = req.params;
    // agencies has no owner_name column (only clients do) - selecting it errored
    // and 404'd the whole thread. Select only columns that exist.
    const { data: agency } = await supabase.from('agencies').select('id, name, email').eq('id', agencyId).maybeSingle();
    const t = await buildAgencyThread(agencyId);
    if (t.request_ids.length) {
      await supabase.from('support_requests').update({ admin_unread: 0 }).eq('agency_id', agencyId).gt('admin_unread', 0);
      await supabase.from('support_thread_messages').update({ read_by_admin: true }).in('request_id', t.request_ids).eq('sender', 'agency').eq('read_by_admin', false);
    }
    res.json({ agency: agency || { id: agencyId, name: null }, thread: t.thread, latest_request_id: t.latest_request_id, request_ids: t.request_ids, open: t.open });
  } catch (error) {
    console.error('Admin agency-thread load error:', error.message);
    res.status(500).json({ error: 'Failed to load agency thread' });
  }
});

adminRouter.get('/support-requests/:id/thread', requireAdmin, async (req, res) => {
  try {
    const request = await loadRequest(req.params.id, null);
    if (!request) return res.status(404).json({ error: 'Support request not found' });

    const messages = await threadMessages(request.id);

    // Opening clears the admin's unread (agency replies now seen).
    if (request.admin_unread > 0) {
      await supabase.from('support_requests').update({ admin_unread: 0 }).eq('id', request.id);
      await supabase.from('support_thread_messages')
        .update({ read_by_admin: true })
        .eq('request_id', request.id).eq('sender', 'agency');
      request.admin_unread = 0;
    }

    res.json({ request, thread: buildThread(request, messages) });
  } catch (error) {
    console.error('Admin thread load error:', error.message);
    res.status(500).json({ error: 'Failed to load thread' });
  }
});

adminRouter.post('/support-requests/:id/reply', requireAdmin, async (req, res) => {
  try {
    const body = clean(req.body && req.body.body, MAX_BODY);
    if (!body) return res.status(400).json({ error: 'Message is required' });

    const request = await loadRequest(req.params.id, null);
    if (!request) return res.status(404).json({ error: 'Support request not found' });

    const { data: message, error: insErr } = await supabase
      .from('support_thread_messages')
      .insert({ request_id: request.id, sender: 'admin', body, read_by_admin: true, read_by_agency: false })
      .select('id, sender, body, created_at')
      .single();
    if (insErr) throw insErr;

    // Bump the agency's unread and stamp activity. An admin reply does NOT
    // auto-resolve; the admin sets status explicitly via the existing PATCH.
    await supabase.from('support_requests').update({
      agency_unread: (request.agency_unread || 0) + 1,
      last_reply_at: new Date().toISOString(),
      last_sender: 'admin',
    }).eq('id', request.id);

    // Notify the agency owner (best-effort). Meaningful only when the thread is
    // bound to an agency; anonymous widget rows have no dashboard to light up.
    if (request.agency_id) {
      try {
        const { data: agency } = await supabase
          .from('agencies').select('name, phone').eq('id', request.agency_id).single();
        if (agency && agency.phone) {
          await sendAndLogSMS({
            phone: agency.phone,
            agencyId: request.agency_id,
            recipientType: 'agency',
            messageType: 'platform_support_reply',
            message: 'New reply from VoiceAI Connect support. Respond from your dashboard inbox.',
          });
        }
      } catch (e) { console.error('agency reply SMS failed (non-blocking):', e.message); }
    }

    res.json({ success: true, message });
  } catch (error) {
    console.error('Admin reply error:', error.message);
    res.status(500).json({ error: 'Failed to send reply' });
  }
});

// ===========================================================================
// UNIFIED ADMIN INBOX (one iMessage-style inbox for all platform comms)
// One conversation per agency, merging the in-app support thread
// (buildAgencyThread) with that agency's SMS replies to the platform number
// (sms_log), plus the public FAQ-bot prospect chats (widget_chat_log) as
// read-only conversations. A reply routes by channel: in-app (support thread,
// which the agency sees in their dashboard "VoiceAI Connect" conversation) or
// SMS from the platform number. Added to adminRouter (mounted at /api/admin).
// ===========================================================================
const ADMIN_PLATFORM_SMS_NUMBER = process.env.TELNYX_SMS_FROM_NUMBER || '+15054317109';
function adminSmsDir(r) { return (r.message_type === 'agency_reply_inbound' || (r.metadata && r.metadata.direction === 'inbound')) ? 'in' : 'out'; }

adminRouter.get('/inbox', requireAdmin, async (req, res) => {
  try {
    const conversations = [];

    // ---- Agencies: in-app support thread + SMS, merged per agency ----
    const [reqRes, smsRes, fbRes] = await Promise.all([
      supabase.from('support_requests').select('agency_id, admin_unread').not('agency_id', 'is', null).limit(1000),
      supabase.from('sms_log').select('agency_id').eq('message_type', 'agency_reply_inbound').not('agency_id', 'is', null).limit(1000),
      // Feedback (agency_feedback) is folded into each agency's thread below, so a
      // reply goes back to that agency like any other message. Archived excluded.
      supabase.from('agency_feedback').select('id, agency_id, message, status, created_at').not('agency_id', 'is', null).neq('status', 'archived').limit(1000),
    ]);
    const reqRows = reqRes.data || [], smsAgencyRows = smsRes.data || [];
    const fbRows = fbRes.data || [];
    const fbByAgency = new Map();
    for (const r of fbRows) { const g = fbByAgency.get(r.agency_id) || []; g.push(r); fbByAgency.set(r.agency_id, g); }
    const agencyIds = [...new Set([...reqRows.map(r => r.agency_id), ...smsAgencyRows.map(r => r.agency_id), ...fbRows.map(r => r.agency_id)])];

    if (agencyIds.length) {
      const { data: agencies } = await supabase.from('agencies').select('id, name, phone, platform_replies_read_at').in('id', agencyIds);
      const agMap = new Map((agencies || []).map(a => [a.id, a]));
      const unreadByAgency = {};
      for (const r of reqRows) unreadByAgency[r.agency_id] = (unreadByAgency[r.agency_id] || 0) + (r.admin_unread || 0);

      for (const aid of agencyIds) {
        const ag = agMap.get(aid) || {};
        const items = [];
        try {
          const t = await buildAgencyThread(aid);
          for (const m of t.thread) items.push({ id: `inapp-${m.id}`, sender: m.sender === 'admin' ? 'out' : 'in', body: m.body, at: m.created_at, kind: 'inapp' });
        } catch (e) { /* no in-app thread */ }
        const { data: srows } = await supabase.from('sms_log')
          .select('id, message_body, message_type, metadata, created_at')
          .eq('agency_id', aid).eq('recipient_type', 'agency_owner')
          .order('created_at', { ascending: true }).limit(500);
        for (const r of (srows || [])) items.push({ id: `sms-${r.id}`, sender: adminSmsDir(r), body: r.message_body || '', at: r.created_at, kind: 'sms' });
        const fbForAgency = fbByAgency.get(aid) || [];
        for (const r of fbForAgency) items.push({ id: `fb-${r.id}`, sender: 'in', body: r.message || '', at: r.created_at, kind: 'feedback' });
        const fbUnread = fbForAgency.filter(r => r.status !== 'reviewed').length;
        items.sort((a, b) => new Date(a.at) - new Date(b.at));
        if (!items.length) continue;
        const readAt = ag.platform_replies_read_at ? new Date(ag.platform_replies_read_at).getTime() : 0;
        const smsUnread = (srows || []).filter(r => adminSmsDir(r) === 'in' && new Date(r.created_at).getTime() > readAt).length;
        const inbound = items.filter(m => m.sender === 'in');
        const last = items[items.length - 1];
        conversations.push({
          key: `agency-${aid}`, type: 'agency', agencyId: aid,
          name: ag.name || 'Unknown agency', phone: ag.phone || null,
          messages: items, unread: (unreadByAgency[aid] || 0) + smsUnread + fbUnread,
          lastAt: last.at, lastDirection: last.sender, lastPreview: String(last.body || '').slice(0, 120),
          lastInboundKind: inbound.length ? inbound[inbound.length - 1].kind : 'inapp',
          needsReply: last.sender === 'in',
        });
      }
    }

    // ---- FAQ-bot prospect chats (read-only) ----
    try {
      const { data: wrows } = await supabase.from('widget_chat_log')
        .select('session_id, role, content, created_at')
        .order('created_at', { ascending: false }).limit(1500);
      const bySession = new Map();
      for (const row of (wrows || [])) {
        let s = bySession.get(row.session_id);
        if (!s) { s = { messages: [], escalated: false }; bySession.set(row.session_id, s); }
        s.messages.push(row);
        if (row.role === 'escalation') s.escalated = true;
      }
      let faqCount = 0;
      for (const [sid, s] of bySession) {
        if (faqCount++ >= 60) break;
        const msgs = s.messages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
          .map(m => ({ id: `faq-${sid}-${m.created_at}`, sender: m.role === 'user' ? 'in' : 'out', body: m.content || '', at: m.created_at, kind: 'faq' }));
        if (!msgs.length) continue;
        const last = msgs[msgs.length - 1];
        conversations.push({
          key: `faq-${sid}`, type: 'faq', agencyId: null, name: s.escalated ? 'FAQ chat (escalated)' : 'FAQ chat',
          phone: null, messages: msgs, unread: 0, lastAt: last.at, lastDirection: last.sender,
          lastPreview: String(last.body || '').slice(0, 120), readOnly: true, needsReply: false, escalated: s.escalated,
        });
      }
    } catch (e) { console.warn('admin inbox FAQ build failed:', e.message); }

    conversations.sort((a, b) => new Date(b.lastAt || 0) - new Date(a.lastAt || 0));
    res.json({ success: true, conversations });
  } catch (error) {
    console.error('Admin inbox load error:', error.message);
    res.status(500).json({ error: 'Failed to load inbox' });
  }
});

adminRouter.post('/inbox/send', requireAdmin, async (req, res) => {
  try {
    const agencyId = clean(req.body && req.body.agencyId, 64);
    const channel = clean(req.body && req.body.channel, 16);
    const body = clean(req.body && req.body.body, MAX_BODY);
    if (!agencyId) return res.status(400).json({ error: 'agencyId required' });
    if (!body) return res.status(400).json({ error: 'Message is required' });

    const { data: agency } = await supabase.from('agencies').select('id, name, phone').eq('id', agencyId).single();
    if (!agency) return res.status(404).json({ error: 'Agency not found' });

    const { data: latest } = await supabase.from('support_requests')
      .select('id, agency_unread, status').eq('agency_id', agencyId)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();

    // Route: explicit channel wins; otherwise in-app when a thread exists, else SMS.
    const useSms = channel === 'sms' || (!latest && channel !== 'inapp');
    if (useSms) {
      if (!agency.phone) return res.status(400).json({ error: 'No agency phone on file for SMS' });
      const sent = await sendAndLogSMS({ phone: agency.phone, message: body, agencyId, recipientType: 'agency_owner', messageType: 'admin_reply', from: ADMIN_PLATFORM_SMS_NUMBER, metadata: { direction: 'outbound', admin_reply: true } });
      if (!sent) return res.status(502).json({ error: 'SMS could not be sent' });
      return res.json({ success: true, channel: 'sms' });
    }

    let reqId = latest ? latest.id : null;
    if (!reqId) {
      const { data: created, error } = await supabase.from('support_requests')
        .insert({ agency_id: agencyId, user_type: 'agency', message: '', source: 'admin_outreach', status: 'open', last_sender: 'admin', agency_unread: 0 })
        .select('id').single();
      if (error) throw error;
      reqId = created.id;
    }
    const { data: msg, error: insErr } = await supabase.from('support_thread_messages')
      .insert({ request_id: reqId, sender: 'admin', body, read_by_admin: true, read_by_agency: false })
      .select('id').single();
    if (insErr) throw insErr;
    const upd = { agency_unread: (latest ? (latest.agency_unread || 0) : 0) + 1, last_reply_at: new Date().toISOString(), last_sender: 'admin' };
    if (latest && latest.status === 'resolved') upd.status = 'open';
    await supabase.from('support_requests').update(upd).eq('id', reqId);
    try { if (agency.phone) await sendAndLogSMS({ phone: agency.phone, agencyId, recipientType: 'agency', messageType: 'platform_support_reply', message: 'New reply from VoiceAI Connect support. Respond from your dashboard inbox.' }); } catch (e) { /* non-blocking */ }
    return res.json({ success: true, channel: 'inapp', message_id: msg.id });
  } catch (error) {
    console.error('Admin inbox send error:', error.message);
    res.status(500).json({ error: 'Failed to send' });
  }
});

adminRouter.post('/inbox/read', requireAdmin, async (req, res) => {
  try {
    const agencyId = clean(req.body && req.body.agencyId, 64);
    if (!agencyId) return res.json({ success: false });
    await supabase.from('support_requests').update({ admin_unread: 0 }).eq('agency_id', agencyId).gt('admin_unread', 0);
    await supabase.from('agencies').update({ platform_replies_read_at: new Date().toISOString() }).eq('id', agencyId);
    // Opening an agency thread also reviews their feedback (now folded into it).
    await supabase.from('agency_feedback').update({ status: 'reviewed', reviewed_at: new Date().toISOString() }).eq('agency_id', agencyId).neq('status', 'reviewed').neq('status', 'archived');
    res.json({ success: true });
  } catch (error) { res.json({ success: false }); }
});

// ---------------------------------------------------------------------------
// AGENCY ROUTER
// ---------------------------------------------------------------------------
const agencyRouter = express.Router();

// This agency's platform threads (their escalations + any admin-started ones),
// newest activity first, with the unread the dashboard badge needs. Explicitly
// separate from the client -> agency inbox (agency_support_requests).
agencyRouter.get('/:agencyId/platform-threads', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const { agencyId } = req.params;
    const { data, error } = await supabase
      .from('support_requests')
      .select('id, message, status, source, kind, created_at, last_reply_at, last_sender, agency_unread')
      .eq('agency_id', agencyId)
      .order('last_reply_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;

    const threads = data || [];
    const unreadTotal = threads.reduce((n, t) => n + (t.agency_unread || 0), 0);
    res.json({ threads, unread_total: unreadTotal });
  } catch (error) {
    console.error('Agency threads list error:', error.message);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

agencyRouter.get('/:agencyId/platform-threads/:id', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const { agencyId, id } = req.params;
    const request = await loadRequest(id, agencyId);
    if (!request) return res.status(404).json({ error: 'Thread not found' });

    const messages = await threadMessages(request.id);

    // Opening clears the agency's unread (admin replies now seen).
    if (request.agency_unread > 0) {
      await supabase.from('support_requests').update({ agency_unread: 0 }).eq('id', request.id).eq('agency_id', agencyId);
      await supabase.from('support_thread_messages')
        .update({ read_by_agency: true })
        .eq('request_id', request.id).eq('sender', 'admin');
      request.agency_unread = 0;
    }

    res.json({ request, thread: buildThread(request, messages) });
  } catch (error) {
    console.error('Agency thread load error:', error.message);
    res.status(500).json({ error: 'Failed to load thread' });
  }
});

agencyRouter.post('/:agencyId/platform-threads/:id/reply', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const { agencyId, id } = req.params;
    const body = clean(req.body && req.body.body, MAX_BODY);
    if (!body) return res.status(400).json({ error: 'Message is required' });

    const request = await loadRequest(id, agencyId);
    if (!request) return res.status(404).json({ error: 'Thread not found' });

    const { data: message, error: insErr } = await supabase
      .from('support_thread_messages')
      .insert({ request_id: request.id, sender: 'agency', body, read_by_agency: true, read_by_admin: false })
      .select('id, sender, body, created_at')
      .single();
    if (insErr) throw insErr;

    // Bump admin unread, stamp activity, and reopen a resolved thread so it
    // resurfaces in the admin queue.
    const updates = {
      admin_unread: (request.admin_unread || 0) + 1,
      last_reply_at: new Date().toISOString(),
      last_sender: 'agency',
    };
    if (request.status === 'resolved') { updates.status = 'open'; updates.resolved_at = null; }
    await supabase.from('support_requests').update(updates).eq('id', request.id).eq('agency_id', agencyId);

    // Notify the platform owner (best-effort).
    try {
      const { data: agency } = await supabase.from('agencies').select('name').eq('id', agencyId).single();
      const who = (agency && agency.name) || 'An agency';
      await sendPlatformNotificationSMS(`New reply from ${who} in admin messaging. Check your admin dashboard.`);
    } catch (e) { console.error('platform reply SMS failed (non-blocking):', e.message); }

    res.json({ success: true, message });
  } catch (error) {
    console.error('Agency reply error:', error.message);
    res.status(500).json({ error: 'Failed to send reply' });
  }
});

// POST /api/agency/:agencyId/platform-threads - the agency STARTS a new thread
// to the platform (reach out to admin from the inbox, not only reply). Creates a
// support_request that lands in the admin Support queue, flagged unread.
agencyRouter.post('/:agencyId/platform-threads', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const { agencyId } = req.params;
    const body = clean(req.body && req.body.body, MAX_BODY);
    if (!body) return res.status(400).json({ error: 'Message is required' });

    let who = 'An agency';
    try {
      const { data: agency } = await supabase.from('agencies').select('name').eq('id', agencyId).single();
      who = (agency && agency.name) || who;
    } catch (_) { /* name is best-effort */ }

    const { data: request, error } = await supabase
      .from('support_requests')
      .insert({
        agency_id: agencyId,
        user_type: 'agency',
        display_name: who === 'An agency' ? null : who,
        message: body,
        source: 'inbox',
        status: 'open',
        admin_unread: 1,
        last_reply_at: new Date().toISOString(),
        last_sender: 'agency',
      })
      .select('*')
      .single();
    if (error) throw error;

    try { await sendPlatformNotificationSMS(`New message from ${who} in admin messaging. Check your admin dashboard.`); }
    catch (e) { console.error('platform new-thread SMS failed (non-blocking):', e.message); }

    res.json({ success: true, request });
  } catch (error) {
    console.error('Agency platform-thread create error:', error.message);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// The agency's single running conversation with the platform (all their support
// + feedback as one thread). Opening clears the agency's unread.
agencyRouter.get('/:agencyId/platform-thread', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const { agencyId } = req.params;
    const t = await buildAgencyThread(agencyId);
    if (t.request_ids.length) {
      await supabase.from('support_requests').update({ agency_unread: 0 }).eq('agency_id', agencyId).gt('agency_unread', 0);
      await supabase.from('support_thread_messages').update({ read_by_agency: true }).in('request_id', t.request_ids).eq('sender', 'admin').eq('read_by_agency', false);
    }
    res.json({ thread: t.thread, latest_request_id: t.latest_request_id, open: t.open });
  } catch (error) {
    console.error('Agency platform-thread load error:', error.message);
    res.status(500).json({ error: 'Failed to load thread' });
  }
});

module.exports = { adminRouter, agencyRouter };
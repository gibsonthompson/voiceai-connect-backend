// ============================================================================
// AGENCY <-> CLIENT message threads. The one-level-down mirror of
// support-thread.js (admin<->agency). agency_support_requests is the thread
// container (a client or prospect contacting the agency); the client's original
// note is the seed, and every reply after that is an agency_thread_messages row.
//
//   Agency (requireAgencyAccess('dashboard')):
//     GET  /api/agency/:agencyId/support-requests/:id/thread   seed + messages, marks client replies read
//     POST /api/agency/:agencyId/support-requests/:id/reply    agency reply, texts the client (no link)
//   Client (auto-authed by requireClientAccess on /api/client/:clientId):
//     GET  /api/client/:clientId/agency-threads                list + unread
//     GET  /api/client/:clientId/agency-threads/:id            seed + messages, marks agency replies read
//     POST /api/client/:clientId/agency-threads/:id/reply      client reply, texts the agency (no link)
//
// Edge cases mirror the admin<->agency build: ownership pinned on every row
// touch (agency_id for agency calls, client_id for client calls), only
// client-bound requests get in-app delivery, body validated and capped, a reply
// to a resolved thread reopens it, unread counters reset on open, and every
// notification is best-effort so a send failure never fails the reply.
//
// Mounted in server.js:
//   app.use('/api/agency', require('./routes/agency-client-thread').agencyRouter);
//   app.use('/api/client', require('./routes/agency-client-thread').clientRouter); // after the requireClientAccess middleware
//
// Destination: src/routes/agency-client-thread.js (NEW FILE)
// ============================================================================
const express = require('express');
const { supabase } = require('../lib/supabase');
const { requireAgencyAccess } = require('./auth');
const { getPlan } = require('../lib/plans');

const MAX_BODY = 4000;

let sendAndLogSMS = async () => {};
try { ({ sendAndLogSMS } = require('../lib/sms-logger')); } catch (e) { /* SMS disabled */ }

function clean(str, max) {
  return String(str == null ? '' : str).trim().slice(0, max);
}

// Scope the load by whoever is asking: agencyId for agency calls, client_id for
// client calls, so a guessed id from another tenant resolves to not-found.
async function loadRequest(id, { agencyId, clientId }) {
  let q = supabase.from('agency_support_requests').select('*').eq('id', id);
  if (agencyId) q = q.eq('agency_id', agencyId);
  if (clientId) q = q.eq('client_id', clientId);
  const { data } = await q.single();
  return data || null;
}

async function threadMessages(requestId) {
  const { data } = await supabase
    .from('agency_thread_messages')
    .select('id, sender, body, created_at')
    .eq('request_id', requestId)
    .order('created_at', { ascending: true });
  return data || [];
}

// Seed (the client's original request.message) + all replies, one ordered thread.
function buildThread(request, messages) {
  const seed = request.message
    ? [{ id: `seed-${request.id}`, sender: 'client', body: request.message, created_at: request.created_at, seed: true }]
    : [];
  return [...seed, ...messages];
}

// ---------------------------------------------------------------------------
// AGENCY ROUTER
// ---------------------------------------------------------------------------
const agencyRouter = express.Router();

agencyRouter.get('/:agencyId/support-requests/:id/thread', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const request = await loadRequest(req.params.id, { agencyId: req.params.agencyId });
    if (!request) return res.status(404).json({ error: 'Thread not found' });

    const messages = await threadMessages(request.id);

    if (request.agency_unread > 0) {
      await supabase.from('agency_support_requests').update({ agency_unread: 0 }).eq('id', request.id).eq('agency_id', req.params.agencyId);
      await supabase.from('agency_thread_messages').update({ read_by_agency: true }).eq('request_id', request.id).eq('sender', 'client');
      request.agency_unread = 0;
    }

    res.json({ request, thread: buildThread(request, messages) });
  } catch (error) {
    console.error('Agency client-thread load error:', error.message);
    res.status(500).json({ error: 'Failed to load thread' });
  }
});

agencyRouter.post('/:agencyId/support-requests/:id/reply', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const body = clean(req.body && req.body.body, MAX_BODY);
    if (!body) return res.status(400).json({ error: 'Message is required' });

    const request = await loadRequest(req.params.id, { agencyId: req.params.agencyId });
    if (!request) return res.status(404).json({ error: 'Thread not found' });

    const { data: message, error: insErr } = await supabase
      .from('agency_thread_messages')
      .insert({ request_id: request.id, sender: 'agency', body, read_by_agency: true, read_by_client: false })
      .select('id, sender, body, created_at')
      .single();
    if (insErr) throw insErr;

    await supabase.from('agency_support_requests').update({
      client_unread: (request.client_unread || 0) + 1,
      last_reply_at: new Date().toISOString(),
      last_sender: 'agency',
    }).eq('id', request.id).eq('agency_id', req.params.agencyId);

    // Notify the client owner. Only a real client (with a portal) can see the
    // reply in-app; anonymous prospect requests have no client_id and no portal.
    if (request.client_id) {
      try {
        const { data: client } = await supabase.from('clients').select('owner_phone, business_name').eq('id', request.client_id).single();
        const { data: agency } = await supabase.from('agencies').select('name').eq('id', req.params.agencyId).single();
        if (client && client.owner_phone) {
          await sendAndLogSMS({
            phone: client.owner_phone,
            agencyId: req.params.agencyId,
            recipientType: 'client_owner',
            messageType: 'agency_message',
            message: `New message from ${(agency && agency.name) || 'your provider'}. Respond from your dashboard inbox.`,
          });
        }
      } catch (e) { console.error('client notify SMS failed (non-blocking):', e.message); }
    } else if (request.contact && !/@/.test(request.contact) && request.contact.replace(/\D/g, '').length >= 10) {
      // Visitor with a phone contact and no portal: text them the reply itself.
      try {
        await sendAndLogSMS({
          phone: request.contact,
          agencyId: req.params.agencyId,
          recipientType: 'prospect',
          messageType: 'agency_reply',
          message: body,
        });
      } catch (e) { console.error('visitor reply SMS failed (non-blocking):', e.message); }
    }

    res.json({ success: true, message });
  } catch (error) {
    console.error('Agency client-thread reply error:', error.message);
    res.status(500).json({ error: 'Failed to send reply' });
  }
});

// ---------------------------------------------------------------------------
// CLIENT ROUTER  (mounted under /api/client, already behind requireClientAccess)
// ---------------------------------------------------------------------------
const clientRouter = express.Router();

clientRouter.get('/:clientId/agency-threads', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { data, error } = await supabase
      .from('agency_support_requests')
      .select('id, message, status, created_at, last_reply_at, last_sender, client_unread')
      .eq('client_id', clientId)
      .order('last_reply_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;

    const threads = data || [];
    res.json({ threads, unread_total: threads.reduce((n, t) => n + (t.client_unread || 0), 0) });
  } catch (error) {
    console.error('Client agency-threads list error:', error.message);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

clientRouter.get('/:clientId/agency-threads/:id', async (req, res) => {
  try {
    const { clientId, id } = req.params;
    const request = await loadRequest(id, { clientId });
    if (!request) return res.status(404).json({ error: 'Thread not found' });

    const messages = await threadMessages(request.id);

    if (request.client_unread > 0) {
      await supabase.from('agency_support_requests').update({ client_unread: 0 }).eq('id', request.id).eq('client_id', clientId);
      await supabase.from('agency_thread_messages').update({ read_by_client: true }).eq('request_id', request.id).eq('sender', 'agency');
      request.client_unread = 0;
    }

    res.json({ request, thread: buildThread(request, messages) });
  } catch (error) {
    console.error('Client agency-thread load error:', error.message);
    res.status(500).json({ error: 'Failed to load thread' });
  }
});

clientRouter.post('/:clientId/agency-threads/:id/reply', async (req, res) => {
  try {
    const { clientId, id } = req.params;
    const body = clean(req.body && req.body.body, MAX_BODY);
    if (!body) return res.status(400).json({ error: 'Message is required' });

    const request = await loadRequest(id, { clientId });
    if (!request) return res.status(404).json({ error: 'Thread not found' });

    const { data: message, error: insErr } = await supabase
      .from('agency_thread_messages')
      .insert({ request_id: request.id, sender: 'client', body, read_by_client: true, read_by_agency: false })
      .select('id, sender, body, created_at')
      .single();
    if (insErr) throw insErr;

    const updates = {
      agency_unread: (request.agency_unread || 0) + 1,
      last_reply_at: new Date().toISOString(),
      last_sender: 'client',
    };
    if (request.status === 'resolved') updates.status = 'in_progress';
    await supabase.from('agency_support_requests').update(updates).eq('id', request.id).eq('client_id', clientId);

    // Notify the agency.
    try {
      const { data: client } = await supabase.from('clients').select('business_name, agency_id').eq('id', clientId).single();
      if (client && client.agency_id) {
        const { data: agency } = await supabase.from('agencies').select('phone').eq('id', client.agency_id).single();
        if (agency && agency.phone) {
          await sendAndLogSMS({
            phone: agency.phone,
            agencyId: client.agency_id,
            recipientType: 'agency',
            messageType: 'client_reply',
            message: `New reply from ${client.business_name || 'a client'}. Respond from your dashboard inbox.`,
          });
        }
      }
    } catch (e) { console.error('agency notify SMS failed (non-blocking):', e.message); }

    res.json({ success: true, message });
  } catch (error) {
    console.error('Client agency-thread reply error:', error.message);
    res.status(500).json({ error: 'Failed to send reply' });
  }
});

// ---------------------------------------------------------------------------
// UNIFIED PROVIDER INBOX (the iMessage-style "SmartCall Solutions" conversation)
// One timeline that merges (a) the transactional texts the agency sent the owner
// (sms_log, read-only history, shown as received) and (b) every in-app thread
// message, both directions, across all of the client's agency threads. A reply
// goes in-app: it appends to the most recent thread, or starts a new one. The
// carrier texts are notifications the agency system sent; the client does not
// text back on a carrier line here (see the reply handler).
// ---------------------------------------------------------------------------
const AGENCY_SMS_TYPES = ['client_welcome', 'client_subscription_activated', 'client_trial_expired', 'client_payment_failed'];

function last10(p) { const d = String(p || '').replace(/\D/g, ''); return d.length > 10 ? d.slice(-10) : d; }

clientRouter.get('/:clientId/provider-inbox', async (req, res) => {
  try {
    const { clientId } = req.params;

    const { data: client } = await supabase
      .from('clients').select('id, agency_id, owner_phone, business_name, owner_name').eq('id', clientId).single();
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const { data: agency } = client.agency_id
      ? await supabase.from('agencies').select('name, logo_url').eq('id', client.agency_id).single()
      : { data: null };

    // (a) In-app threads + their messages, flattened into one list.
    const { data: requests } = await supabase
      .from('agency_support_requests')
      .select('id, message, created_at, client_unread')
      .eq('client_id', clientId)
      .order('created_at', { ascending: true })
      .limit(100);

    const items = [];
    let unreadTotal = 0;
    let replyTargetId = null;
    let replyTargetAt = 0;
    for (const r of requests || []) {
      unreadTotal += r.client_unread || 0;
      const t = new Date(r.created_at).getTime();
      if (t >= replyTargetAt) { replyTargetAt = t; replyTargetId = r.id; }
      if (r.message) items.push({ id: `seed-${r.id}`, sender: 'client', body: r.message, at: r.created_at, kind: 'thread' });
      const msgs = await threadMessages(r.id);
      for (const m of msgs) items.push({ id: m.id, sender: m.sender, body: m.body, at: m.created_at, kind: 'thread' });
    }

    // (b) Transactional texts the agency sent THIS owner (match by phone, since
    // sms_log is agency-scoped, not client-scoped). Read-only, shown as received.
    if (client.agency_id && client.owner_phone) {
      const { data: smsRows } = await supabase
        .from('sms_log')
        .select('id, recipient_phone, message_body, message_type, created_at')
        .eq('agency_id', client.agency_id)
        .eq('recipient_type', 'client_owner')
        .in('message_type', AGENCY_SMS_TYPES)
        .order('created_at', { ascending: true })
        .limit(500);
      const mine = last10(client.owner_phone);
      for (const s of smsRows || []) {
        if (last10(s.recipient_phone) !== mine) continue;
        items.push({ id: `sms-${s.id}`, sender: 'agency', body: s.message_body || '', at: s.created_at, kind: 'sms' });
      }
    }

    items.sort((a, b) => new Date(a.at) - new Date(b.at));

    // Opening the conversation marks the in-app agency replies read.
    if (unreadTotal > 0) {
      await supabase.from('agency_support_requests').update({ client_unread: 0 }).eq('client_id', clientId);
      for (const r of requests || []) {
        await supabase.from('agency_thread_messages').update({ read_by_client: true }).eq('request_id', r.id).eq('sender', 'agency');
      }
    }

    res.json({
      success: true,
      agency: { name: (agency && agency.name) || 'Your provider', logo_url: (agency && agency.logo_url) || null },
      messages: items,
      unread_total: unreadTotal,
      reply_target_id: replyTargetId,
      has_messages: items.length > 0,
    });
  } catch (error) {
    console.error('Provider-inbox load error:', error.message);
    res.status(500).json({ error: 'Failed to load conversation' });
  }
});

clientRouter.post('/:clientId/provider-inbox/reply', async (req, res) => {
  try {
    const { clientId } = req.params;
    const body = clean(req.body && req.body.body, MAX_BODY);
    if (!body) return res.status(400).json({ error: 'Message is required' });

    const { data: client } = await supabase
      .from('clients').select('id, agency_id, business_name, owner_name, email').eq('id', clientId).single();
    if (!client || !client.agency_id) return res.status(404).json({ error: 'Client not found' });

    // Append to the client's most recent thread, or start a new one if none.
    const { data: latest } = await supabase
      .from('agency_support_requests')
      .select('id, status')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    let message;
    if (latest) {
      const { data: inserted, error: insErr } = await supabase
        .from('agency_thread_messages')
        .insert({ request_id: latest.id, sender: 'client', body, read_by_client: true, read_by_agency: false })
        .select('id, sender, body, created_at')
        .single();
      if (insErr) throw insErr;
      message = inserted;
      const updates = { last_reply_at: new Date().toISOString(), last_sender: 'client' };
      // Bump agency unread by reading current value first (keep the counter honest).
      const { data: cur } = await supabase.from('agency_support_requests').select('agency_unread, status').eq('id', latest.id).single();
      updates.agency_unread = ((cur && cur.agency_unread) || 0) + 1;
      if (cur && cur.status === 'resolved') updates.status = 'in_progress';
      await supabase.from('agency_support_requests').update(updates).eq('id', latest.id).eq('client_id', clientId);
    } else {
      // No thread yet: create one seeded with this message so the agency sees it.
      const { data: created, error: crErr } = await supabase
        .from('agency_support_requests')
        .insert({
          agency_id: client.agency_id,
          client_id: client.id,
          user_type: 'client',
          requester_name: client.owner_name || client.business_name || null,
          contact: client.email || null,
          message: body,
          source: 'client_dashboard',
          status: 'new',
          last_sender: 'client',
          agency_unread: 1,
        })
        .select('id, created_at')
        .single();
      if (crErr) throw crErr;
      message = { id: `seed-${created.id}`, sender: 'client', body, created_at: created.created_at };
    }

    // Notify the agency owner (best-effort, in-app channel heads-up by text).
    try {
      const { data: agency } = await supabase.from('agencies').select('phone').eq('id', client.agency_id).single();
      if (agency && agency.phone) {
        await sendAndLogSMS({
          phone: agency.phone,
          agencyId: client.agency_id,
          recipientType: 'agency',
          messageType: 'client_reply',
          message: `New reply from ${client.business_name || 'a client'}. Respond from your dashboard inbox.`,
        });
      }
    } catch (e) { console.error('agency notify SMS failed (non-blocking):', e.message); }

    res.json({ success: true, message: { id: message.id, sender: 'client', body: message.body || body, at: message.created_at, kind: 'thread' } });
  } catch (error) {
    console.error('Provider-inbox reply error:', error.message);
    res.status(500).json({ error: 'Failed to send reply' });
  }
});

// ===========================================================================
// UNIFIED AGENCY INBOX (the iMessage-style messaging center)
// One list that merges every channel the agency talks on:
//   - platform : the two-way thread with VoiceAI Connect (support_requests)
//   - client   : the in-app thread with each client (agency_support_requests)
//   - prospect : an in-app contact-form request with no client portal
//   - sms      : carrier SMS on the agency demo number (sms_log demo threads)
// GET returns conversations with their messages already merged and ordered;
// send routes a reply/compose to the right channel; read clears unread. These
// live on agencyRouter (mounted at /api/agency) so no new server mount is needed.
// ===========================================================================
const DEMO_SMS_TYPES = ['demo_followup', 'demo_followup_industry', 'demo_followup_custom', 'demo_reply_inbound', 'demo_reply_outbound'];
function inboxLast10(p) { const d = String(p || '').replace(/\D/g, ''); return d.length > 10 ? d.slice(-10) : d; }
function looksLikePhone(s) { return !!s && /\d/.test(s) && String(s).replace(/\D/g, '').length >= 10 && !/@/.test(s); }
function finalizeConvo(c) {
  const n = c.messages.length;
  c.lastAt = n ? c.messages[n - 1].at : null;
  c.lastDirection = n ? c.messages[n - 1].sender : null;
  c.lastPreview = n ? String(c.messages[n - 1].body || '').slice(0, 120) : '';
  c.needsReply = c.lastDirection === 'in';
  return c;
}

agencyRouter.get('/:agencyId/inbox', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const { agencyId } = req.params;
    const conversations = [];

    // 1) PLATFORM (VoiceAI Connect)
    try {
      const { data: preqs } = await supabase
        .from('support_requests').select('id, message, status, created_at, agency_unread')
        .eq('agency_id', agencyId).order('created_at', { ascending: true });
      const pids = (preqs || []).map(r => r.id);
      let pmsgs = [];
      if (pids.length) {
        const { data } = await supabase.from('support_thread_messages').select('id, sender, body, created_at').in('request_id', pids).order('created_at', { ascending: true });
        pmsgs = data || [];
      }
      const items = [];
      for (const r of (preqs || [])) if (r.message) items.push({ id: `pseed-${r.id}`, sender: 'out', body: r.message, at: r.created_at });
      for (const m of pmsgs) items.push({ id: m.id, sender: m.sender === 'admin' ? 'in' : 'out', body: m.body, at: m.created_at });
      items.sort((a, b) => new Date(a.at) - new Date(b.at));
      const latest = (preqs || []).length ? preqs[preqs.length - 1] : null;
      conversations.push(finalizeConvo({ key: 'platform', type: 'platform', name: 'VoiceAI Connect', phone: null, pinned: true, target: latest ? latest.id : null, messages: items, unread: (preqs || []).reduce((n, r) => n + (r.agency_unread || 0), 0) }));
    } catch (e) { console.warn('inbox platform build failed:', e.message); }

    // 2) CLIENTS + PROSPECTS (in-app agency threads)
    try {
      const { data: areqs } = await supabase
        .from('agency_support_requests').select('id, client_id, requester_name, contact, message, status, created_at, agency_unread')
        .eq('agency_id', agencyId).order('created_at', { ascending: true }).limit(500);
      const aids = (areqs || []).map(r => r.id);
      let amsgs = [];
      if (aids.length) { const { data } = await supabase.from('agency_thread_messages').select('id, request_id, sender, body, created_at').in('request_id', aids).order('created_at', { ascending: true }); amsgs = data || []; }
      const msgsByReq = {}; for (const m of amsgs) { (msgsByReq[m.request_id] = msgsByReq[m.request_id] || []).push(m); }
      const cids = [...new Set((areqs || []).map(r => r.client_id).filter(Boolean))];
      const cnames = {}, cphones = {};
      if (cids.length) { const { data: cs } = await supabase.from('clients').select('id, business_name, owner_phone').in('id', cids); (cs || []).forEach(c => { cnames[c.id] = c.business_name; cphones[c.id] = c.owner_phone; }); }
      const clientConvos = {};
      for (const r of (areqs || [])) {
        const items = [];
        if (r.message) items.push({ id: `aseed-${r.id}`, sender: 'in', body: r.message, at: r.created_at });
        for (const m of (msgsByReq[r.id] || [])) items.push({ id: m.id, sender: m.sender === 'agency' ? 'out' : 'in', body: m.body, at: m.created_at });
        if (r.client_id) {
          const k = `client-${r.client_id}`;
          if (!clientConvos[k]) clientConvos[k] = { key: k, type: 'client', name: cnames[r.client_id] || 'Client', phone: cphones[r.client_id] || null, clientId: r.client_id, target: r.client_id, messages: [], unread: 0, _latest: 0 };
          const c = clientConvos[k];
          c.messages.push(...items);
          c.unread += r.agency_unread || 0;
        } else {
          conversations.push(finalizeConvo({ key: `req-${r.id}`, type: 'prospect', name: r.requester_name || r.contact || 'Prospect', phone: looksLikePhone(r.contact) ? r.contact : null, target: r.id, messages: items.sort((a, b) => new Date(a.at) - new Date(b.at)), unread: r.agency_unread || 0 }));
        }
      }
      for (const c of Object.values(clientConvos)) { delete c._latest; c.messages.sort((a, b) => new Date(a.at) - new Date(b.at)); conversations.push(finalizeConvo(c)); }
    } catch (e) { console.warn('inbox client build failed:', e.message); }

    // 3) DEMO-NUMBER SMS threads
    try {
      const { data: rows } = await supabase
        .from('sms_log').select('id, recipient_phone, message_body, message_type, delivery_status, metadata, created_at')
        .eq('agency_id', agencyId).in('message_type', DEMO_SMS_TYPES).order('created_at', { ascending: true }).limit(2000);
      const threads = {};
      for (const r of (rows || [])) {
        const k = inboxLast10(r.recipient_phone); if (!k) continue;
        const inbound = r.message_type === 'demo_reply_inbound' || r.delivery_status === 'received' || (r.metadata && r.metadata.direction === 'inbound');
        if (!threads[k]) threads[k] = { key: `sms-${k}`, type: 'sms', name: null, phone: r.recipient_phone, target: r.recipient_phone, messages: [], unread: 0 };
        threads[k].messages.push({ id: r.id, sender: inbound ? 'in' : 'out', body: r.message_body || '', at: r.created_at });
      }
      const { data: calls } = await supabase.from('demo_calls').select('caller_phone, caller_name, business_name, created_at').eq('agency_id', agencyId).order('created_at', { ascending: false }).limit(500);
      const nameByKey = {}; for (const c of (calls || [])) { const k = inboxLast10(c.caller_phone); if (k && !nameByKey[k]) nameByKey[k] = c.business_name || c.caller_name || null; }
      for (const t of Object.values(threads)) { t.name = nameByKey[inboxLast10(t.phone)] || null; t.messages.sort((a, b) => new Date(a.at) - new Date(b.at)); conversations.push(finalizeConvo(t)); }
    } catch (e) { console.warn('inbox sms build failed:', e.message); }

    conversations.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (new Date(b.lastAt || 0) - new Date(a.lastAt || 0)));
    res.json({ success: true, conversations });
  } catch (error) {
    console.error('Agency inbox load error:', error.message);
    res.status(500).json({ error: 'Failed to load inbox' });
  }
});

agencyRouter.post('/:agencyId/inbox/send', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const { agencyId } = req.params;
    const type = clean(req.body && req.body.type, 24);
    const target = clean(req.body && req.body.target, 300);
    const body = clean(req.body && req.body.body, MAX_BODY);
    if (!body) return res.status(400).json({ error: 'Message is required' });

    if (type === 'sms') {
      if (!looksLikePhone(target)) return res.status(400).json({ error: 'A valid phone number is required' });
      const { data: agency } = await supabase.from('agencies').select('demo_phone_number').eq('id', agencyId).single();
      if (!agency || !agency.demo_phone_number) return res.status(400).json({ error: 'No demo number on this agency yet' });
      const ok = await sendAndLogSMS({ phone: target, message: body, from: agency.demo_phone_number, agencyId, recipientType: 'prospect', messageType: 'demo_reply_outbound', metadata: { direction: 'outbound', demo_number: agency.demo_phone_number } });
      if (!ok) return res.status(502).json({ error: 'Message could not be sent' });
      return res.json({ success: true });
    }

    if (type === 'platform') {
      let requestId = target || null;
      if (!requestId) {
        const { data: created, error } = await supabase.from('support_requests').insert({ agency_id: agencyId, user_type: 'agency', message: body, source: 'inbox', status: 'open', last_sender: 'agency', admin_unread: 1 }).select('id').single();
        if (error) throw error;
        return res.json({ success: true, started: true, request_id: created.id });
      }
      const { data: msg, error: insErr } = await supabase.from('support_thread_messages').insert({ request_id: requestId, sender: 'agency', body, read_by_agency: true, read_by_admin: false }).select('id').single();
      if (insErr) throw insErr;
      const { data: cur } = await supabase.from('support_requests').select('admin_unread, status').eq('id', requestId).eq('agency_id', agencyId).single();
      const upd = { admin_unread: ((cur && cur.admin_unread) || 0) + 1, last_reply_at: new Date().toISOString() };
      if (cur && cur.status === 'resolved') upd.status = 'open';
      await supabase.from('support_requests').update(upd).eq('id', requestId).eq('agency_id', agencyId);
      return res.json({ success: true, message_id: msg.id });
    }

    // client (target = clientId) or prospect (target = agency_support_requests id)
    if (type === 'client') {
      const { data: client } = await supabase.from('clients').select('id, agency_id, business_name').eq('id', target).single();
      if (!client || client.agency_id !== agencyId) return res.status(404).json({ error: 'Client not found' });
      const { data: latest } = await supabase.from('agency_support_requests').select('id, status').eq('client_id', target).eq('agency_id', agencyId).order('created_at', { ascending: false }).limit(1).maybeSingle();
      let reqId = latest ? latest.id : null;
      if (!reqId) {
        const { data: created, error } = await supabase.from('agency_support_requests').insert({ agency_id: agencyId, client_id: target, user_type: 'client', requester_name: client.business_name || null, message: body, source: 'agency_outreach', status: 'new', last_sender: 'agency', client_unread: 1 }).select('id').single();
        if (error) throw error;
        await notifyClientOfAgencyMessage(agencyId, target);
        return res.json({ success: true, started: true, request_id: created.id });
      }
      const { data: msg, error: insErr } = await supabase.from('agency_thread_messages').insert({ request_id: reqId, sender: 'agency', body, read_by_agency: true, read_by_client: false }).select('id').single();
      if (insErr) throw insErr;
      const { data: cur } = await supabase.from('agency_support_requests').select('client_unread, status').eq('id', reqId).single();
      const upd = { client_unread: ((cur && cur.client_unread) || 0) + 1, last_reply_at: new Date().toISOString(), last_sender: 'agency' };
      if (cur && cur.status === 'resolved') upd.status = 'in_progress';
      await supabase.from('agency_support_requests').update(upd).eq('id', reqId).eq('agency_id', agencyId);
      await notifyClientOfAgencyMessage(agencyId, target);
      return res.json({ success: true, message_id: msg.id });
    }

    if (type === 'prospect') {
      const request = await loadRequest(target, { agencyId });
      if (!request) return res.status(404).json({ error: 'Thread not found' });
      const { data: msg, error: insErr } = await supabase.from('agency_thread_messages').insert({ request_id: request.id, sender: 'agency', body, read_by_agency: true, read_by_client: false }).select('id').single();
      if (insErr) throw insErr;
      await supabase.from('agency_support_requests').update({ client_unread: (request.client_unread || 0) + 1, last_reply_at: new Date().toISOString(), last_sender: 'agency' }).eq('id', request.id).eq('agency_id', agencyId);
      // No portal: if the prospect left a phone, text them the reply itself.
      if (looksLikePhone(request.contact)) {
        try { await sendAndLogSMS({ phone: request.contact, agencyId, recipientType: 'prospect', messageType: 'agency_reply', message: body }); }
        catch (e) { console.error('prospect reply SMS failed (non-blocking):', e.message); }
      }
      return res.json({ success: true, message_id: msg.id });
    }

    return res.status(400).json({ error: 'Unknown conversation type' });
  } catch (error) {
    console.error('Agency inbox send error:', error.message);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

agencyRouter.post('/:agencyId/inbox/read', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const { agencyId } = req.params;
    const type = clean(req.body && req.body.type, 24);
    const target = clean(req.body && req.body.target, 300);
    if (type === 'platform') {
      await supabase.from('support_requests').update({ agency_unread: 0 }).eq('agency_id', agencyId).gt('agency_unread', 0);
    } else if (type === 'client') {
      await supabase.from('agency_support_requests').update({ agency_unread: 0 }).eq('agency_id', agencyId).eq('client_id', target);
    } else if (type === 'prospect') {
      await supabase.from('agency_support_requests').update({ agency_unread: 0 }).eq('agency_id', agencyId).eq('id', target);
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Agency inbox read error:', error.message);
    res.json({ success: false });
  }
});

async function notifyClientOfAgencyMessage(agencyId, clientId) {
  try {
    const { data: client } = await supabase.from('clients').select('owner_phone, business_name').eq('id', clientId).single();
    const { data: agency } = await supabase.from('agencies').select('name, demo_phone_number').eq('id', agencyId).single();
    if (client && client.owner_phone) {
      await sendAndLogSMS({
        phone: client.owner_phone,
        from: (agency && agency.demo_phone_number) || null,
        agencyId,
        recipientType: 'client_owner',
        messageType: 'agency_message',
        message: `New message from ${(agency && agency.name) || 'your provider'}. Open your dashboard inbox to reply.`,
      });
    }
  } catch (e) { console.error('client notify SMS failed (non-blocking):', e.message); }
}

// ============================================================================
// GET /:agencyId/inbox/facts?type=client|prospect&target=<id>
// Quick facts about whoever a thread is with, shown in the inbox so the agency
// has context while replying. Client: plan, status/trial, numbers, tenure,
// usage, last call, price. Prospect: who they are, how to reach them, status.
// ============================================================================
agencyRouter.get('/:agencyId/inbox/facts', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const { agencyId } = req.params;
    const { type, target } = req.query;
    if (!target) return res.status(400).json({ error: 'target is required' });

    if (type === 'client') {
      const { data: client } = await supabase
        .from('clients')
        .select('id, agency_id, business_name, owner_name, owner_phone, vapi_phone_number, plan_type, subscription_status, trial_ends_at, created_at, calls_this_month, monthly_call_limit, custom_price_cents, is_test_client')
        .eq('id', target).eq('agency_id', agencyId).single();
      if (!client) return res.status(404).json({ error: 'Client not found' });

      // Latest call time (best-effort).
      let lastCallAt = null;
      try {
        const { data: lc } = await supabase.from('calls').select('created_at').eq('client_id', client.id).order('created_at', { ascending: false }).limit(1);
        if (lc && lc[0]) lastCallAt = lc[0].created_at;
      } catch {}

      // Monthly price: the client's custom override, else their plan's price.
      let plan = null;
      try {
        const { data: agency } = await supabase.from('agencies').select('*').eq('id', agencyId).single();
        plan = client.plan_type ? getPlan(agency, client.plan_type) : null;
      } catch {}
      let priceCents = (client.custom_price_cents != null && Number(client.custom_price_cents) > 0)
        ? Number(client.custom_price_cents)
        : (plan && plan.price_cents != null ? Number(plan.price_cents) : null);

      return res.json({ success: true, type: 'client', facts: {
        businessName: client.business_name || null,
        ownerName: client.owner_name || null,
        plan: plan ? plan.name : (client.plan_type || null),
        status: client.subscription_status || null,
        trialEndsAt: client.trial_ends_at || null,
        aiPhone: client.vapi_phone_number || null,
        ownerPhone: client.owner_phone || null,
        memberSince: client.created_at || null,
        callsThisMonth: client.calls_this_month != null ? client.calls_this_month : null,
        monthlyCallLimit: client.monthly_call_limit != null ? client.monthly_call_limit : null,
        lastCallAt,
        priceCents,
        isTest: !!client.is_test_client,
      }});
    }

    if (type === 'prospect') {
      const { data: reqRow } = await supabase
        .from('agency_support_requests')
        .select('id, requester_name, contact, message, status, created_at, client_id')
        .eq('id', target).eq('agency_id', agencyId).single();
      if (!reqRow) return res.status(404).json({ error: 'Not found' });
      return res.json({ success: true, type: 'prospect', facts: {
        name: reqRow.requester_name || null,
        contact: reqRow.contact || null,
        firstMessage: reqRow.message || null,
        status: reqRow.status || null,
        createdAt: reqRow.created_at || null,
      }});
    }

    return res.json({ success: true, type: type || 'unknown', facts: null });
  } catch (e) {
    console.error('inbox facts error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = { agencyRouter, clientRouter };
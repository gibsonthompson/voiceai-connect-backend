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

module.exports = { agencyRouter, clientRouter };
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

module.exports = { agencyRouter, clientRouter };

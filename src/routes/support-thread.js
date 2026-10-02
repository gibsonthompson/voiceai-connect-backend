// ============================================================================
// SUPPORT THREADS — two-way platform <-> agency messaging on support_requests
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

// Lazy notification senders — a missing module must never break a reply.
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

// ---------------------------------------------------------------------------
// ADMIN ROUTER
// ---------------------------------------------------------------------------
const adminRouter = express.Router();

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
      .select('id, message, status, source, created_at, last_reply_at, last_sender, agency_unread')
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
      await sendPlatformNotificationSMS(`Reply from ${who}:\n\n${body.slice(0, 300)}`);
    } catch (e) { console.error('platform reply SMS failed (non-blocking):', e.message); }

    res.json({ success: true, message });
  } catch (error) {
    console.error('Agency reply error:', error.message);
    res.status(500).json({ error: 'Failed to send reply' });
  }
});

// POST /api/agency/:agencyId/platform-threads — the agency STARTS a new thread
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

    try { await sendPlatformNotificationSMS(`New message from ${who}:\n\n${body.slice(0, 300)}`); }
    catch (e) { console.error('platform new-thread SMS failed (non-blocking):', e.message); }

    res.json({ success: true, request });
  } catch (error) {
    console.error('Agency platform-thread create error:', error.message);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

module.exports = { adminRouter, agencyRouter };
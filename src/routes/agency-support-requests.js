// ============================================================================
// AGENCY SUPPORT REQUESTS (client / prospect -> agency inbox)
// ----------------------------------------------------------------------------
// One-tier-down mirror of the admin support_requests endpoints in routes/
// admin.js: instead of agency -> platform admin, this is client / prospect ->
// the owning agency. Backs the agency dashboard Inbox page.
//
// Mounted in server.js: app.use('/api/agency', require('./routes/agency-support-requests'));
//
// Routes:
//   Agency inbox (owner/staff reads their OWN agency):
//     GET   /api/agency/:agencyId/support-requests          list + filter + counts
//     PATCH /api/agency/:agencyId/support-requests/:id       status + agency_notes
//   Intake (writes a new inbox row):
//     POST  /api/agency/:agencyId/support-requests/from-client   authenticated client
//     POST  /api/agency/support-requests/intake                  public marketing site
//
// On a NEW inbound message (either intake path) the owning agency's owner gets a
// best-effort heads-up SMS to their agency phone, sent via sendAndLogSMS so it
// is agency-aware (routes over the agency's own Twilio for BYOT agencies) and
// logged in the admin SMS Log under its own message type 'inbox_message'. The
// SMS is fully non-blocking: a send failure never fails the insert, and an
// agency with no phone on file is simply skipped. This is the ONLY outbound in
// the feature; the reply itself is still the agency reaching out on their own.
//
// Authorization for the inbox reads/writes uses requireAgencyAccess from
// routes/auth.js (valid token + caller owns :agencyId + Page Access for staff).
// The backend service key bypasses RLS; the new table has deny-by-default RLS
// as defense-in-depth (see migration).
//
// Token note: generateToken (routes/auth.js) mints camelCase agencyId/clientId.
// The client intake reads decoded.clientId (NOT client_id) accordingly.
//
// Destination: src/routes/agency-support-requests.js (NEW FILE)
// ============================================================================
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { supabase, getAgencyBySlug, getAgencyByDomain } = require('../lib/supabase');
const { requireAgencyAccess } = require('./auth');
const { sendAndLogSMS } = require('../lib/sms-logger');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ['new', 'in_progress', 'resolved'];
const MAX_MESSAGE = 4000;

function clean(str, max) {
  return String(str == null ? '' : str).trim().slice(0, max);
}

// Resolve an agency from a marketing-site host. Mirrors getAgencyByHost in
// routes/agency-settings.js: subdomain of myvoiceaiconnect.com first, then a
// verified custom marketing domain.
async function resolveAgencyByHost(host) {
  if (!host) return null;
  let agency = null;
  const sub = String(host).match(/^([^.]+)\.myvoiceaiconnect\.com$/);
  if (sub) agency = await getAgencyBySlug(sub[1]);
  if (!agency) agency = await getAgencyByDomain(host);
  return agency;
}

// Best-effort heads-up to the agency owner on a new inbound message. Never
// throws, no-ops when the agency has no phone on file. Logged as its own
// message type so it is filterable in the admin SMS Log and routes over the
// agency's own Twilio for BYOT agencies (sendAndLogSMS is agency-aware).
async function notifyAgencyOwner(agency, { title, requesterName, contact, message }) {
  try {
    if (!agency || !agency.phone) return;
    const excerpt = clean(message, 280);
    const lines = [`🔔 ${agency.name || 'New message'}`, title];
    if (requesterName) lines.push(`From: ${requesterName}${contact ? ` (${contact})` : ''}`);
    else if (contact) lines.push(`From: ${contact}`);
    if (excerpt) lines.push(`"${excerpt}"`);
    await sendAndLogSMS({
      phone: agency.phone,
      message: lines.join('\n'),
      agencyId: agency.id,
      recipientType: 'agency',
      messageType: 'inbox_message',
      metadata: { requesterName: requesterName || null, contact: contact || null },
    });
  } catch (smsErr) {
    console.error('Inbox owner SMS failed (non-blocking):', smsErr.message);
  }
}

// ============================================================================
// GET /api/agency/:agencyId/support-requests
// ----------------------------------------------------------------------------
// Query: status, source, user_type, search, limit, offset.
// Returns { requests, total, counts } where counts is the whole-inbox status
// breakdown for THIS agency (tab badges), independent of the current filter.
// ============================================================================
router.get('/:agencyId/support-requests', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const { agencyId } = req.params;
    const { status, source, user_type, search, limit = 30, offset = 0 } = req.query;

    let query = supabase
      .from('agency_support_requests')
      .select('*', { count: 'exact' })
      .eq('agency_id', agencyId)
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (status) query = query.eq('status', status);
    if (source) query = query.eq('source', source);
    if (user_type) query = query.eq('user_type', user_type);
    if (search) {
      query = query.or(
        `message.ilike.%${search}%,contact.ilike.%${search}%,requester_name.ilike.%${search}%`
      );
    }

    const { data: requests, error, count } = await query;
    if (error) throw error;

    // Whole-inbox status counts for this agency (tab badges).
    const { data: allRows } = await supabase
      .from('agency_support_requests')
      .select('status')
      .eq('agency_id', agencyId);

    const counts = { new: 0, in_progress: 0, resolved: 0, total: 0 };
    (allRows || []).forEach(r => {
      counts.total += 1;
      if (r.status && counts[r.status] !== undefined) counts[r.status] += 1;
    });

    res.json({ requests: requests || [], total: count || 0, counts });
  } catch (error) {
    console.error('Agency support-requests list error:', error.message);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

// ============================================================================
// PATCH /api/agency/:agencyId/support-requests/:id
// ----------------------------------------------------------------------------
// Body: { status?, agency_notes? }. Scoped to the caller's own agency via the
// agency_id equality on the update, so an agency can never patch another
// agency's row even with a guessed id. Moving to 'resolved' stamps resolved_at;
// moving off it clears it.
// ============================================================================
router.patch('/:agencyId/support-requests/:id', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const { agencyId, id } = req.params;
    const { status, agency_notes } = req.body;

    const updates = {};
    if (status !== undefined) {
      if (!STATUSES.includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      updates.status = status;
      updates.resolved_at = status === 'resolved' ? new Date().toISOString() : null;
    }
    if (agency_notes !== undefined) {
      updates.agency_notes = clean(agency_notes, MAX_MESSAGE);
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    const { data, error } = await supabase
      .from('agency_support_requests')
      .update(updates)
      .eq('id', id)
      .eq('agency_id', agencyId)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Message not found' });

    res.json({ success: true, request: data });
  } catch (error) {
    console.error('Agency support-request update error:', error.message);
    res.status(500).json({ error: 'Failed to update message' });
  }
});

// ============================================================================
// POST /api/agency/:agencyId/support-requests/from-client
// ----------------------------------------------------------------------------
// Authenticated client intake ("Contact your agency" modal). The caller must
// present a client token; the client's OWN agency (from the DB row) is used for
// the insert, and the URL :agencyId must match it. This prevents a client from
// posting into a different agency's inbox. No requireAgencyAccess here because
// the caller is a client, not an agency user.
// ============================================================================
router.post('/:agencyId/support-requests/from-client', async (req, res) => {
  try {
    const { agencyId } = req.params;

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    let decoded;
    try { decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET); }
    catch { return res.status(401).json({ error: 'Invalid or expired token' }); }

    const clientId = decoded.clientId || decoded.client_id || null;
    if (!clientId) return res.status(403).json({ error: 'Not a client account' });

    const { data: client } = await supabase
      .from('clients')
      .select('id, agency_id, email, owner_name, business_name')
      .eq('id', clientId)
      .single();

    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (client.agency_id !== agencyId) {
      return res.status(403).json({ error: 'Client does not belong to this agency' });
    }

    const message = clean(req.body && req.body.message, MAX_MESSAGE);
    if (!message) return res.status(400).json({ error: 'Message is required' });

    const contact = clean(req.body && req.body.contact, 300) || client.email || null;
    const name = clean(req.body && req.body.name, 200) || client.owner_name || client.business_name || null;

    const { error } = await supabase.from('agency_support_requests').insert({
      agency_id: client.agency_id,
      client_id: client.id,
      user_type: 'client',
      requester_name: name,
      contact,
      message,
      source: 'client_dashboard',
      status: 'new',
    });

    if (error) {
      console.error('Client support-request insert failed:', error.message);
      return res.status(500).json({ error: 'Failed to send message' });
    }

    // Heads-up SMS to the agency owner (best-effort). Fetch the agency name +
    // phone; skip silently if there is no phone on file.
    try {
      const { data: agencyRow } = await supabase
        .from('agencies')
        .select('id, name, phone')
        .eq('id', client.agency_id)
        .single();
      await notifyAgencyOwner(agencyRow, {
        title: `New message from ${client.business_name || 'a client'}`,
        requesterName: name,
        contact,
        message,
      });
    } catch (e) { /* non-blocking */ }

    res.json({ success: true, message: 'Your message has been sent.' });
  } catch (error) {
    console.error('Client support-request error:', error.message);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ============================================================================
// POST /api/agency/support-requests/intake  (PUBLIC, unauthenticated)
// ----------------------------------------------------------------------------
// Marketing-site prospect intake. The agency is resolved from an explicit
// agencyId (UUID) when provided, otherwise from the request host (subdomain or
// verified custom domain). Only an active/trial agency accepts messages, so a
// suspended/canceled agency's stale marketing site cannot keep collecting.
//
// The message is composed from the typed message plus an optional chat
// transcript (conversationSummary) so the stored message is never empty (the
// column is NOT NULL). This is the one net-new intake the admin pattern did
// not already have (admin intake is always an authenticated user).
// ============================================================================
router.post('/support-requests/intake', async (req, res) => {
  try {
    const { agencyId, host, name, contact, message, conversationSummary } = req.body || {};

    let agency = null;
    if (agencyId && UUID_RE.test(agencyId)) {
      const { data } = await supabase
        .from('agencies')
        .select('id, status, name, phone')
        .eq('id', agencyId)
        .single();
      if (data) agency = data;
    }
    if (!agency && host) {
      const a = await resolveAgencyByHost(host);
      if (a) agency = { id: a.id, status: a.status, name: a.name, phone: a.phone };
    }
    if (!agency) return res.status(404).json({ error: 'Agency not found' });

    if (agency.status && !['active', 'trial', 'trialing'].includes(agency.status)) {
      return res.status(403).json({ error: 'This site is not accepting messages right now' });
    }

    const nm = clean(name, 200);
    const ct = clean(contact, 300);
    if (!ct) return res.status(400).json({ error: 'Contact info is required' });

    const typed = clean(message, MAX_MESSAGE);
    const transcript = clean(conversationSummary, MAX_MESSAGE);

    let body = typed;
    if (transcript) body = body ? `${body}\n\n--- Chat history ---\n${transcript}` : transcript;
    if (!body) body = '(Contact request - no message provided)';
    body = body.slice(0, MAX_MESSAGE);

    const { error } = await supabase.from('agency_support_requests').insert({
      agency_id: agency.id,
      client_id: null,
      user_type: 'prospect',
      requester_name: nm || null,
      contact: ct,
      message: body,
      source: 'marketing_site',
      status: 'new',
    });

    if (error) {
      console.error('Marketing support-request insert failed:', error.message);
      return res.status(500).json({ error: 'Failed to send message' });
    }

    // Heads-up SMS to the agency owner (best-effort). The typed message is
    // preferred for the excerpt; falls back to the composed body (transcript).
    notifyAgencyOwner(agency, {
      title: 'New website message',
      requesterName: nm,
      contact: ct,
      message: typed || body,
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Marketing support-request error:', error.message);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

module.exports = router;
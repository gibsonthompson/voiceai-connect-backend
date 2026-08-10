// ============================================================================
// ADMIN SUPPORT (create) ROUTES
// Location: src/routes/admin-support.js
//
// Lets a platform admin create a support ticket by hand. It is stored in the
// same support_requests table as the help-widget escalations, so it lists,
// filters, counts, gets status/notes, and deep-links exactly like the rest with
// no special-casing. Admin-authored tickets are stamped source='admin' and do
// NOT trigger the owner-notification SMS (that lives in routes/help.js for real
// inbound escalations, and you should not text yourself when logging a ticket).
//
// The list (GET) and triage (PATCH) endpoints for support_requests live in
// routes/admin.js; this file only adds the POST create endpoint. Mount it
// alongside the others in your server entry, order does not matter since the
// methods differ:
//   const adminSupportRoutes = require('./routes/admin-support');
//   app.use('/api/admin', adminSupportRoutes);
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const jwt = require('jsonwebtoken');

// ----------------------------------------------------------------------------
// ADMIN AUTH (mirrors requireAdmin in routes/admin.js so this file is
// self-contained and can be mounted on its own).
// ----------------------------------------------------------------------------
function requireAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'platform_admin') {
      return res.status(403).json({ error: 'Not authorized as platform admin' });
    }
    req.admin = decoded;
    next();
  } catch (error) {
    console.error('Admin auth error:', error.message);
    return res.status(401).json({ error: 'Invalid token' });
  }
}

const SUPPORT_STATUSES = ['open', 'in_progress', 'resolved'];

// ============================================================================
// POST /api/admin/support-requests
// Body: { message*, agency_id?, client_id?, user_type?, user_email?,
//         display_name?, status? }
// Creates an admin-authored ticket (source='admin'). No SMS is sent. If created
// already resolved, resolved_at is stamped so it matches the PATCH behavior.
// ============================================================================
router.post('/support-requests', requireAdmin, async (req, res) => {
  try {
    const {
      message,
      agency_id = null,
      client_id = null,
      user_type = null,
      user_email = null,
      display_name = null,
      status = 'open',
    } = req.body || {};

    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }
    if (!SUPPORT_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const row = {
      agency_id: agency_id || null,
      client_id: client_id || null,
      user_type: user_type || null,
      user_email: user_email ? String(user_email).trim() : null,
      display_name: display_name ? String(display_name).trim() : null,
      message: String(message).trim(),
      source: 'admin',
      status,
      resolved_at: status === 'resolved' ? new Date().toISOString() : null,
    };

    const { data, error } = await supabase
      .from('support_requests')
      .insert(row)
      .select()
      .single();

    if (error) throw error;

    console.log(`Admin created support ticket ${data.id} (source=admin, status=${status})`);
    res.status(201).json({ success: true, request: data });
  } catch (error) {
    console.error('Admin create support request error:', error.message);
    res.status(500).json({ error: 'Failed to create support request' });
  }
});

module.exports = router;
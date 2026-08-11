// ============================================================================
// ADMIN IMPERSONATION
//   POST /api/admin/clients/:clientId/impersonate   -> log in as a client
//   POST /api/admin/agencies/:agencyId/login-as     -> log in as an agency
//
// Both mint a token shaped exactly like the corresponding REAL login token from
// generateToken() in routes/auth.js, so every downstream route and the client/
// agency dashboard context accept it identically to a normal login. The only
// extra claim is impersonated_by, for audit; nothing reads it for gating.
//
//   client login token:  { userId, email, role: 'client',        agencyId, clientId }
//   agency login token:   { userId, email, role: 'agency_owner',  agencyId, clientId: null }
//
// The frontend opens the matching ingestion page, which stores the token and
// redirects into the dashboard:
//   client -> /client/preview?token=...     (existing page, already ingests it)
//   agency -> /auth/agency-preview?token=... (new page; mirrors /auth/google-success)
//
// The admin's own session lives under a separate admin_token key and is opened
// in a new tab, so the admin tab is never disturbed.
//
// NOTE: the agency route path is /login-as, NOT /impersonate, on purpose: the
// legacy /agencies/:agencyId/impersonate in routes/admin.js is mounted first
// and would shadow a same-path route here. /login-as is distinct and mints the
// correct owner-shaped token (the legacy one minted { id, type:'agency' } with
// no role/agencyId, which the agency context and gated routes do not accept).
//
// Mount ONCE in server.js, in the admin block:
//   app.use('/api/admin', require('./routes/admin-impersonate'));
// This file REPLACES the earlier admin-client-impersonate.js (do not mount both).
//
// CREATED: 2026-08-11
// ============================================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const jwt = require('jsonwebtoken');

// Same admin gate the other admin routers use: a platform_admin token only.
function requireAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'platform_admin') return res.status(403).json({ error: 'Not authorized' });
    req.admin = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ============================================================================
// LOG IN AS CLIENT
// ============================================================================
router.post('/clients/:clientId/impersonate', requireAdmin, async (req, res) => {
  try {
    const { clientId } = req.params;

    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('id, business_name, email, agency_id')
      .eq('id', clientId)
      .single();

    if (clientError || !client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    // Prefer the primary client owner (role 'client'); fall back to any user on
    // this client so a staff-only client can still be opened.
    const { data: clientUsers } = await supabase
      .from('users')
      .select('id, email, role')
      .eq('client_id', clientId);

    const ownerUser =
      (clientUsers || []).find((u) => u.role === 'client') ||
      (clientUsers || [])[0] ||
      null;

    if (!ownerUser) {
      return res.status(404).json({ error: 'No user account exists for this client' });
    }

    const token = jwt.sign(
      {
        userId: ownerUser.id,
        email: ownerUser.email || client.email,
        role: 'client',
        agencyId: client.agency_id,
        clientId: client.id,
        impersonated_by: req.admin.email,
      },
      process.env.JWT_SECRET,
      { expiresIn: '2h' }
    );

    console.log(`👤 Admin ${req.admin.email} logging in as client: ${client.business_name}`);

    res.json({
      success: true,
      token,
      client: { id: client.id, business_name: client.business_name },
      previewUrl: `/client/preview?token=${token}`,
    });
  } catch (error) {
    console.error('Admin client impersonate error:', error);
    res.status(500).json({ error: 'Failed to log in as client' });
  }
});

// ============================================================================
// LOG IN AS AGENCY
// ----------------------------------------------------------------------------
// Mints an agency-owner-shaped token so the agency dashboard treats the session
// as the owner logging in themselves. role is forced to 'agency_owner' so the
// admin gets full agency access; the userId is a real users row so
// /api/auth/verify resolves it and the agency context bootstraps normally.
// ============================================================================
router.post('/agencies/:agencyId/login-as', requireAdmin, async (req, res) => {
  try {
    const { agencyId } = req.params;

    const { data: agency, error: agencyError } = await supabase
      .from('agencies')
      .select('id, name, email')
      .eq('id', agencyId)
      .single();

    if (agencyError || !agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    // Prefer the agency owner; fall back to staff, then any user on the agency.
    const { data: agencyUsers } = await supabase
      .from('users')
      .select('id, email, role')
      .eq('agency_id', agencyId);

    const ownerUser =
      (agencyUsers || []).find((u) => u.role === 'agency_owner') ||
      (agencyUsers || []).find((u) => u.role === 'agency_staff') ||
      (agencyUsers || [])[0] ||
      null;

    if (!ownerUser) {
      return res.status(404).json({ error: 'No user account exists for this agency' });
    }

    const token = jwt.sign(
      {
        userId: ownerUser.id,
        email: ownerUser.email || agency.email,
        role: 'agency_owner',
        agencyId: agency.id,
        clientId: null,
        impersonated_by: req.admin.email,
      },
      process.env.JWT_SECRET,
      { expiresIn: '2h' }
    );

    console.log(`👤 Admin ${req.admin.email} logging in as agency: ${agency.name}`);

    res.json({
      success: true,
      token,
      agency: { id: agency.id, name: agency.name },
      loginUrl: `/auth/agency-preview?token=${token}`,
    });
  } catch (error) {
    console.error('Admin agency login-as error:', error);
    res.status(500).json({ error: 'Failed to log in as agency' });
  }
});

module.exports = router;
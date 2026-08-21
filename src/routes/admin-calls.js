// ============================================================================
// ADMIN CALLS + DEMOS ROUTES
// Location: src/routes/admin-calls.js
//
// Thin wrappers over the Postgres RPC functions in the admin_calls_feed.sql
// migration. All aggregation and joining happen in the database, so these
// handlers just validate params, call the function, and shape the response.
//
// Mount once in your server entry (alongside the existing admin router):
//   const adminCallsRoutes = require('./routes/admin-calls');
//   app.use('/api/admin', adminCallsRoutes);
//
// Requires the RPC functions from admin_calls_feed.sql to be applied first.
//
// UPDATED: 2026-08-20 - Recording playback fix. The call/demo detail RPCs return
//   calls.recording_url verbatim, which points at VAPI's PRIVATE bucket
//   (r2.cloudflarestorage.com) and is NOT browser-playable, so the admin
//   drawer's <audio> element silently failed (403). The client dashboard
//   already resolves this via resolveVapiRecordingUrl (src/lib/vapi-recording.js,
//   which trades the stored URL for a fresh short-lived VAPI signed URL using
//   VAPI_API_KEY). The admin detail handlers never called it. They now resolve
//   recording_url per-request before responding. The resolver never throws and
//   returns the original URL on any failure, so the worst case is exactly the
//   prior behavior. HIPAA calls store no recording, so there is nothing to
//   resolve there.
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const jwt = require('jsonwebtoken');
const { resolveVapiRecordingUrl, isVapiPrivateRecording } = require('../lib/vapi-recording');

// ----------------------------------------------------------------------------
// ADMIN AUTH
// Mirrors requireAdmin in routes/admin.js. Kept local so this route file is
// self-contained and can be mounted on its own. If the auth rule changes in
// admin.js, change it here too.
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

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
const VALID_CALL_FILTERS = ['all', 'attention', 'completed', 'transferred', 'urgent', 'spam', 'failed', 'unknown'];

function clampInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

// Replace a detail payload's stored (private, unplayable) recording URL with a
// fresh VAPI signed URL the browser can actually play. Operates on the
// { call: {...} } shape both detail RPCs return. Safe on any shape: if there is
// no recording, or it is already a public/legacy URL, or resolution fails, the
// payload is returned unchanged (resolveVapiRecordingUrl returns the original
// URL on any problem, so this can never make playback worse than before).
async function withResolvedRecording(data, recordKey = 'call') {
  try {
    const rec = data && data[recordKey];
    const url = rec && rec.recording_url;
    if (url && isVapiPrivateRecording(url)) {
      const playable = await resolveVapiRecordingUrl(url);
      if (playable && playable !== url) {
        // Do not mutate the RPC result object identity in surprising ways; a
        // shallow copy of the inner record is enough and keeps everything else.
        data[recordKey] = { ...rec, recording_url: playable };
      }
    }
  } catch (e) {
    console.warn('Admin recording resolve skipped:', e.message);
  }
  return data;
}

// ============================================================================
// GET /api/admin/calls
// Platform-wide call feed. Query: limit, offset, filter, agency_id, search.
// ============================================================================
router.get('/calls', requireAdmin, async (req, res) => {
  try {
    const limit = clampInt(req.query.limit, 50, 1, 200);
    const offset = clampInt(req.query.offset, 0, 0, 1000000);
    const filter = VALID_CALL_FILTERS.includes(req.query.filter) ? req.query.filter : 'all';
    const agencyId = req.query.agency_id ? String(req.query.agency_id) : null;
    const search = req.query.search ? String(req.query.search).trim() : null;

    const { data, error } = await supabase.rpc('admin_calls_feed', {
      p_limit: limit,
      p_offset: offset,
      p_filter: filter,
      p_agency_id: agencyId,
      p_search: search,
    });

    if (error) throw error;

    const rows = data || [];
    const total = rows.length > 0 ? Number(rows[0].total_count) : 0;
    // total_count is a per-row window value; strip it from the payload.
    const calls = rows.map(({ total_count, ...rest }) => rest);

    res.json({ calls, total, limit, offset, filter });
  } catch (error) {
    console.error('Admin calls feed error:', error.message);
    res.status(500).json({ error: 'Failed to load calls' });
  }
});

// ============================================================================
// GET /api/admin/calls/:id
// Single call with transcript, recording, cost, and linked contact (drawer).
// recording_url is resolved to a playable VAPI signed URL before responding.
// ============================================================================
router.get('/calls/:id', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.rpc('admin_call_detail', { p_call_id: req.params.id });
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Call not found' });
    res.json(await withResolvedRecording(data, 'call'));
  } catch (error) {
    console.error('Admin call detail error:', error.message);
    res.status(500).json({ error: 'Failed to load call' });
  }
});

// ============================================================================
// GET /api/admin/demos
// Platform-wide demo call feed. Query: limit, offset, interest, since.
// For the Overview hot-demos panel: ?interest=high&since=<ISO 24h ago>.
// ============================================================================
router.get('/demos', requireAdmin, async (req, res) => {
  try {
    const limit = clampInt(req.query.limit, 20, 1, 200);
    const offset = clampInt(req.query.offset, 0, 0, 1000000);
    const interest = ['high', 'medium', 'low'].includes(req.query.interest) ? req.query.interest : null;

    let since = null;
    if (req.query.since) {
      const d = new Date(req.query.since);
      if (!Number.isNaN(d.getTime())) since = d.toISOString();
    }

    const { data, error } = await supabase.rpc('admin_demos_feed', {
      p_limit: limit,
      p_offset: offset,
      p_interest: interest,
      p_since: since,
    });

    if (error) throw error;

    const rows = data || [];
    const total = rows.length > 0 ? Number(rows[0].total_count) : 0;
    const demos = rows.map(({ total_count, ...rest }) => rest);

    res.json({ demos, total, limit, offset });
  } catch (error) {
    console.error('Admin demos feed error:', error.message);
    res.status(500).json({ error: 'Failed to load demos' });
  }
});

// ============================================================================
// GET /api/admin/demos/:id
// Single demo call (drawer). recording_url resolved to a playable signed URL.
// ============================================================================
router.get('/demos/:id', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.rpc('admin_demo_detail', { p_demo_id: req.params.id });
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Demo not found' });
    res.json(await withResolvedRecording(data, 'call'));
  } catch (error) {
    console.error('Admin demo detail error:', error.message);
    res.status(500).json({ error: 'Failed to load demo' });
  }
});

module.exports = router;
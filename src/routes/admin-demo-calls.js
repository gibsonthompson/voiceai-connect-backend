// ============================================================================
// ADMIN — CONCIERGE / DEMO LINE CALL LOG
// GET /api/admin/demo-calls          — list platform demo calls (paginated)
// GET /api/admin/demo-calls/:id      — one call with full transcript + recording
//
// Mount in server.js alongside the other admin routers:
//   app.use('/api/admin', require('./routes/admin-demo-calls'));
//
// Self-contained requireAdmin (mirrors routes/admin.js) so it can be mounted on
// its own. platform_demo_calls is populated by vapi-concierge-webhook.js.
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const jwt = require('jsonwebtoken');

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
    console.error('Admin auth error:', error.message);
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ── LIST ────────────────────────────────────────────────────────────────────
router.get('/demo-calls', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const offset = parseInt(req.query.offset) || 0;
    const { transferred } = req.query; // optional filter: 'true' | 'false'

    let query = supabase
      .from('platform_demo_calls')
      .select('id, caller_phone, summary, duration_seconds, transferred, ended_reason, recording_url, created_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (transferred === 'true') query = query.eq('transferred', true);
    if (transferred === 'false') query = query.eq('transferred', false);

    const { data, error, count } = await query;
    if (error) throw error;

    // Lightweight rollup for the header tiles.
    const { count: total } = await supabase
      .from('platform_demo_calls').select('id', { count: 'exact', head: true });
    const { count: transferredCount } = await supabase
      .from('platform_demo_calls').select('id', { count: 'exact', head: true }).eq('transferred', true);

    res.json({
      calls: data || [],
      total: count || 0,
      stats: { total: total || 0, transferred: transferredCount || 0 },
      limit,
      offset,
    });
  } catch (error) {
    console.error('Admin demo-calls list error:', error);
    res.status(500).json({ error: 'Failed to load demo calls' });
  }
});

// ── DETAIL ───────────────────────────────────────────────────────────────────
router.get('/demo-calls/:id', requireAdmin, async (req, res) => {
  try {
    const { data: call, error } = await supabase
      .from('platform_demo_calls')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error || !call) return res.status(404).json({ error: 'Demo call not found' });
    res.json({ call });
  } catch (error) {
    console.error('Admin demo-call detail error:', error);
    res.status(500).json({ error: 'Failed to load demo call' });
  }
});

module.exports = router;
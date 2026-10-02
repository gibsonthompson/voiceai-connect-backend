// ============================================================================
// ADMIN: marketing FAQ-bot conversation visibility. Reads widget_chat_log
// (every /api/help/chat exchange from the public SupportWidget) and returns it
// grouped into sessions, newest first, with escalations flagged. Platform-level
// prospect data, not agency-scoped. Read by app/admin/faq-chats/page.tsx.
//
//   GET /api/admin/widget-chats?limit=50
//
// Mounted in server.js:  app.use('/api/admin', require('./routes/admin-widget-chats'));
// Destination: src/routes/admin-widget-chats.js (NEW FILE)
// ============================================================================
const express = require('express');
const { supabase } = require('../lib/supabase');
const jwt = require('jsonwebtoken');

const router = express.Router();

function requireAdmin(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'platform_admin') return res.status(403).json({ error: 'Not authorized' });
    req.admin = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

router.get('/widget-chats', requireAdmin, async (req, res) => {
  try {
    const sessionLimit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

    // Pull a recent window of rows and group in memory. Cheap at expected volume;
    // the created_at index keeps the fetch fast.
    const { data, error } = await supabase
      .from('widget_chat_log')
      .select('session_id, role, content, created_at')
      .order('created_at', { ascending: false })
      .limit(3000);
    if (error) throw error;

    const bySession = new Map();
    for (const row of data || []) {
      let s = bySession.get(row.session_id);
      if (!s) {
        s = { session_id: row.session_id, messages: [], escalated: false, first_at: row.created_at, last_at: row.created_at };
        bySession.set(row.session_id, s);
      }
      s.messages.push(row);
      if (row.role === 'escalation') s.escalated = true;
      if (row.created_at > s.last_at) s.last_at = row.created_at;
      if (row.created_at < s.first_at) s.first_at = row.created_at;
    }

    const sessions = Array.from(bySession.values())
      .map((s) => ({
        session_id: s.session_id,
        escalated: s.escalated,
        first_at: s.first_at,
        last_at: s.last_at,
        question_count: s.messages.filter((m) => m.role === 'user').length,
        messages: s.messages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
      }))
      .sort((a, b) => new Date(b.last_at) - new Date(a.last_at))
      .slice(0, sessionLimit);

    res.json({
      sessions,
      escalated_count: sessions.filter((s) => s.escalated).length,
      total_sessions: bySession.size,
    });
  } catch (e) {
    console.error('admin widget-chats error:', e.message);
    res.status(500).json({ error: 'Failed to load FAQ chats' });
  }
});

module.exports = router;

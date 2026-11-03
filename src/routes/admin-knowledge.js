// ============================================================================
// ADMIN SUPPORT KNOWLEDGE — edit the master brain the support bots read.
//   GET /api/admin/support-knowledge  -> { doc, videos }
//   PUT /api/admin/support-knowledge   { doc, videos } -> saves, returns saved
// Auth: platform_admin (same gate as routes/admin.js). Stored in
// platform_settings, so edits go live within ~30s with no deploy.
// ============================================================================
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { getSupportKnowledgeRaw, setSupportKnowledge } = require('../lib/support-knowledge');

function requireAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided' });
    const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    if (decoded.role !== 'platform_admin') return res.status(403).json({ error: 'Not authorized as platform admin' });
    req.admin = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

router.get('/support-knowledge', requireAdmin, async (req, res) => {
  try {
    const data = await getSupportKnowledgeRaw();
    res.json(data);
  } catch (e) {
    console.error('admin get support-knowledge:', e.message);
    res.status(500).json({ error: 'Could not load the knowledge base' });
  }
});

router.put('/support-knowledge', requireAdmin, async (req, res) => {
  try {
    const { doc, videos } = req.body || {};
    if (typeof doc !== 'string') return res.status(400).json({ error: 'doc (string) is required' });
    const saved = await setSupportKnowledge(doc, Array.isArray(videos) ? videos : []);
    res.json({ success: true, ...saved });
  } catch (e) {
    console.error('admin put support-knowledge:', e.message);
    res.status(500).json({ error: 'Could not save the knowledge base' });
  }
});

module.exports = router;

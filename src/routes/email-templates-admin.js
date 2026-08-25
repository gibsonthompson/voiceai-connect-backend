// ============================================================================
// EMAIL TEMPLATES (admin) — editable, persisted onboarding email templates.
// Parallels sms-templates-admin.js. The admin email composer loads these and
// can save edits back, so template changes persist across sessions.
//
// Mount in server.js next to the SMS templates admin routes:
//   const emailTemplatesAdminRoutes = require('./routes/email-templates-admin');
//   app.use('/api/admin', emailTemplatesAdminRoutes);
//
// Requires the email_templates table (see migration in the handoff).
// ============================================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const jwt = require('jsonwebtoken');

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

// GET /email-templates — list, ordered for the composer's picker.
router.get('/email-templates', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('email_templates')
      .select('key, name, subject, body, category, sort_order')
      .order('sort_order', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ templates: data || [] });
  } catch (error) {
    console.error('List email templates error:', error);
    res.status(500).json({ error: 'Failed to list email templates' });
  }
});

// PUT /email-templates/:key — persist edits to subject/body/name.
router.put('/email-templates/:key', requireAdmin, async (req, res) => {
  try {
    const { key } = req.params;
    const { subject, body, name } = req.body || {};

    const updates = { updated_at: new Date().toISOString() };
    if (subject !== undefined) updates.subject = subject;
    if (body !== undefined) updates.body = body;
    if (name !== undefined) updates.name = name;

    const { data, error } = await supabase
      .from('email_templates')
      .update(updates)
      .eq('key', key)
      .select('key, name, subject, body, category, sort_order')
      .single();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Template not found' });

    res.json({ success: true, template: data });
  } catch (error) {
    console.error('Update email template error:', error);
    res.status(500).json({ error: 'Failed to update email template' });
  }
});

module.exports = router;
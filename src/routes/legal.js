// src/routes/legal.js
const express = require('express');
const router = express.Router();

// GET /api/legal-template?type=terms|privacy
// Returns the legal template content with agency-specific placeholder replacement
router.get('/template', async (req, res) => {
  try {
    const { type } = req.query;

    if (!type || !['terms', 'privacy'].includes(type)) {
      return res.status(400).json({ error: 'Invalid template type. Must be "terms" or "privacy".' });
    }

    const supabase = req.supabase;

    // Fetch the default template
    const { data: template, error: templateError } = await supabase
      .from('legal_templates')
      .select('template_type, title, content, version, updated_at')
      .eq('template_type', type)
      .single();

    if (templateError || !template) {
      console.error('Error fetching legal template:', templateError);
      return res.status(404).json({ error: 'Template not found.' });
    }

    return res.json({
      template: {
        type: template.template_type,
        title: template.title,
        content: template.content,
        version: template.version,
        updatedAt: template.updated_at,
      },
    });
  } catch (err) {
    console.error('Legal template error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
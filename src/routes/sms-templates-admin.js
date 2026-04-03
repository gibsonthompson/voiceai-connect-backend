// ============================================================================
// SMS TEMPLATES - Admin API Routes
// GET    /api/admin/sms-templates         — list all templates by category
// PUT    /api/admin/sms-templates/:key    — update a template's message
// POST   /api/admin/sms-templates/:key/reset — reset template to default
// POST   /api/admin/sms-templates/reset-all  — reset ALL templates to defaults
//
// Mount in server.js:
//   const smsTemplateRoutes = require('./routes/sms-templates-admin');
//   app.use('/api/admin', smsTemplateRoutes);
// ============================================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { clearTemplateCache } = require('../lib/sms-templates');

// ============================================================================
// LIST ALL TEMPLATES
// GET /api/admin/sms-templates
// ============================================================================
router.get('/sms-templates', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('sms_templates')
      .select('*')
      .order('category', { ascending: true })
      .order('key', { ascending: true });

    if (error) {
      console.error('❌ Failed to fetch SMS templates:', error);
      return res.status(500).json({ error: 'Failed to fetch templates' });
    }

    // Group by category
    const categories = {};
    const categoryOrder = [
      'platform_notifications',
      'agency_lifecycle',
      'agency_trial_warnings',
      'abandoned_cart',
      'onboarding_engagement',
      'client_notifications',
      'external',
    ];

    const categoryLabels = {
      platform_notifications: 'Platform Notifications (To You)',
      agency_lifecycle: 'Agency Lifecycle',
      agency_trial_warnings: 'Agency Trial Warnings (No Card)',
      abandoned_cart: 'Abandoned Cart Recovery',
      onboarding_engagement: 'Onboarding Engagement',
      client_notifications: 'Client Notifications',
      external: 'External (Demo Callers & Password Reset)',
    };

    for (const cat of categoryOrder) {
      categories[cat] = {
        label: categoryLabels[cat] || cat,
        templates: [],
      };
    }

    for (const template of data || []) {
      const cat = template.category;
      if (!categories[cat]) {
        categories[cat] = { label: cat, templates: [] };
      }
      categories[cat].templates.push(template);
    }

    res.json({
      success: true,
      total: (data || []).length,
      categories,
    });
  } catch (error) {
    console.error('❌ SMS templates list error:', error);
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
});

// ============================================================================
// UPDATE A TEMPLATE
// PUT /api/admin/sms-templates/:key
// Body: { message: "new message text" }
// ============================================================================
router.put('/sms-templates/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const { message } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required and must be a string' });
    }

    if (message.trim().length === 0) {
      return res.status(400).json({ error: 'message cannot be empty' });
    }

    const { data, error } = await supabase
      .from('sms_templates')
      .update({
        message: message,
        is_customized: true,
        updated_at: new Date().toISOString(),
      })
      .eq('key', key)
      .select()
      .single();

    if (error) {
      console.error('❌ Failed to update template:', error);
      return res.status(500).json({ error: 'Failed to update template' });
    }

    if (!data) {
      return res.status(404).json({ error: 'Template not found' });
    }

    // Clear cache so next SMS send uses the updated template
    clearTemplateCache();

    console.log(`✅ SMS template updated: ${key}`);

    res.json({
      success: true,
      template: data,
    });
  } catch (error) {
    console.error('❌ SMS template update error:', error);
    res.status(500).json({ error: 'Failed to update template' });
  }
});

// ============================================================================
// RESET A TEMPLATE TO DEFAULT
// POST /api/admin/sms-templates/:key/reset
// ============================================================================
router.post('/sms-templates/:key/reset', async (req, res) => {
  try {
    const { key } = req.params;

    // Get the default_message first
    const { data: template, error: fetchError } = await supabase
      .from('sms_templates')
      .select('default_message')
      .eq('key', key)
      .single();

    if (fetchError || !template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const { data, error } = await supabase
      .from('sms_templates')
      .update({
        message: template.default_message,
        is_customized: false,
        updated_at: new Date().toISOString(),
      })
      .eq('key', key)
      .select()
      .single();

    if (error) {
      console.error('❌ Failed to reset template:', error);
      return res.status(500).json({ error: 'Failed to reset template' });
    }

    clearTemplateCache();

    console.log(`🔄 SMS template reset to default: ${key}`);

    res.json({
      success: true,
      template: data,
    });
  } catch (error) {
    console.error('❌ SMS template reset error:', error);
    res.status(500).json({ error: 'Failed to reset template' });
  }
});

// ============================================================================
// RESET ALL TEMPLATES TO DEFAULTS
// POST /api/admin/sms-templates/reset-all
// ============================================================================
router.post('/sms-templates/reset-all', async (req, res) => {
  try {
    // Use raw SQL to set message = default_message for all rows
    const { error } = await supabase.rpc('reset_all_sms_templates');

    if (error) {
      // Fallback: do it row by row if RPC doesn't exist
      const { data: templates } = await supabase
        .from('sms_templates')
        .select('key, default_message')
        .eq('is_customized', true);

      if (templates && templates.length > 0) {
        for (const t of templates) {
          await supabase
            .from('sms_templates')
            .update({
              message: t.default_message,
              is_customized: false,
              updated_at: new Date().toISOString(),
            })
            .eq('key', t.key);
        }
      }
    }

    clearTemplateCache();
    console.log('🔄 All SMS templates reset to defaults');

    res.json({ success: true, message: 'All templates reset to defaults' });
  } catch (error) {
    console.error('❌ Reset all templates error:', error);
    res.status(500).json({ error: 'Failed to reset templates' });
  }
});

module.exports = router;
// ============================================================================
// OUTREACH ROUTES
// VoiceAI Connect - Templates, Composer, and Outreach History
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { logActivity, ACTION_TYPES } = require('./activity');

// ============================================================================
// TEMPLATE VARIABLES
// ============================================================================
const TEMPLATE_VARIABLES = {
  lead: [
    { key: '{lead_business_name}', label: 'Business Name', description: 'Lead company name' },
    { key: '{lead_contact_name}', label: 'Contact Full Name', description: 'Full name of contact' },
    { key: '{lead_contact_first_name}', label: 'Contact First Name', description: 'First name only' },
    { key: '{lead_industry}', label: 'Industry', description: 'Business industry' },
    { key: '{lead_email}', label: 'Email', description: 'Contact email address' },
    { key: '{lead_phone}', label: 'Phone', description: 'Contact phone number' },
    { key: '{lead_website}', label: 'Website', description: 'Business website' },
    { key: '{lead_source}', label: 'Source', description: 'How you found them' },
  ],
  agency: [
    { key: '{agency_name}', label: 'Agency Name', description: 'Your agency name' },
    { key: '{agency_owner_name}', label: 'Your Name', description: 'Agency owner name' },
    { key: '{agency_email}', label: 'Agency Email', description: 'Your email address' },
    { key: '{agency_phone}', label: 'Agency Phone', description: 'Your phone number' },
    { key: '{agency_website}', label: 'Agency Website', description: 'Your website' },
    { key: '{signup_link}', label: 'Signup Link', description: 'Client signup URL' },
  ],
  dynamic: [
    { key: '{today_date}', label: 'Today\'s Date', description: 'Current date' },
    { key: '{personalized_line}', label: 'AI Personalized Line', description: 'AI-generated opener based on their website' },
  ]
};

// ============================================================================
// GET /api/agency/:agencyId/templates
// List all templates for an agency
// ============================================================================
router.get('/:agencyId/templates', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const { type, sequenceName } = req.query;

    let query = supabase
      .from('outreach_templates')
      .select('*')
      .or(`agency_id.eq.${agencyId},is_default.eq.true`)
      .order('sequence_order', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false });

    if (type) {
      query = query.eq('type', type);
    }
    if (sequenceName) {
      query = query.eq('sequence_name', sequenceName);
    }

    const { data: templates, error } = await query;

    if (error) {
      console.error('Error fetching templates:', error);
      return res.status(400).json({ error: error.message });
    }

    // Get unique sequence names
    const sequences = [...new Set(
      (templates || [])
        .filter(t => t.sequence_name)
        .map(t => t.sequence_name)
    )];

    res.json({ 
      templates: templates || [], 
      sequences,
      variables: TEMPLATE_VARIABLES 
    });
  } catch (error) {
    console.error('Error fetching templates:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// POST /api/agency/:agencyId/templates
// Create a new template
// ============================================================================
router.post('/:agencyId/templates', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const {
      name,
      description,
      type = 'email',
      subject,
      body,
      is_follow_up,
      sequence_name,
      sequence_order,
      delay_days
    } = req.body;

    if (!name || !body) {
      return res.status(400).json({ error: 'Name and body are required' });
    }

    if (type === 'email' && !subject) {
      return res.status(400).json({ error: 'Subject is required for email templates' });
    }

    const { data: template, error } = await supabase
      .from('outreach_templates')
      .insert({
        agency_id: agencyId,
        name,
        description,
        type,
        subject,
        body,
        is_follow_up: is_follow_up || false,
        sequence_name: sequence_name || null,
        sequence_order: sequence_order || null,
        delay_days: delay_days || null,
        is_default: false
      })
      .select()
      .single();

    if (error) {
      console.error('Error creating template:', error);
      return res.status(400).json({ error: error.message });
    }

    console.log(`✅ Template created: ${name}`);
    res.status(201).json({ success: true, template });
  } catch (error) {
    console.error('Error creating template:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// GET /api/agency/:agencyId/templates/:templateId
// Get a single template
// ============================================================================
router.get('/:agencyId/templates/:templateId', async (req, res) => {
  try {
    const { agencyId, templateId } = req.params;

    const { data: template, error } = await supabase
      .from('outreach_templates')
      .select('*')
      .eq('id', templateId)
      .or(`agency_id.eq.${agencyId},is_default.eq.true`)
      .single();

    if (error || !template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    res.json({ template, variables: TEMPLATE_VARIABLES });
  } catch (error) {
    console.error('Error fetching template:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// PUT /api/agency/:agencyId/templates/:templateId
// Update a template
// ============================================================================
router.put('/:agencyId/templates/:templateId', async (req, res) => {
  try {
    const { agencyId, templateId } = req.params;
    const updates = req.body;

    // Can't edit default templates
    const { data: existing } = await supabase
      .from('outreach_templates')
      .select('is_default')
      .eq('id', templateId)
      .single();

    if (existing?.is_default) {
      return res.status(403).json({ error: 'Cannot edit default templates. Duplicate it first.' });
    }

    // Remove fields that shouldn't be updated
    delete updates.id;
    delete updates.agency_id;
    delete updates.is_default;
    delete updates.created_at;

    const { data: template, error } = await supabase
      .from('outreach_templates')
      .update(updates)
      .eq('id', templateId)
      .eq('agency_id', agencyId)
      .select()
      .single();

    if (error) {
      console.error('Error updating template:', error);
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, template });
  } catch (error) {
    console.error('Error updating template:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// DELETE /api/agency/:agencyId/templates/:templateId
// Delete a template
// ============================================================================
router.delete('/:agencyId/templates/:templateId', async (req, res) => {
  try {
    const { agencyId, templateId } = req.params;

    // Can't delete default templates
    const { data: existing } = await supabase
      .from('outreach_templates')
      .select('is_default')
      .eq('id', templateId)
      .single();

    if (existing?.is_default) {
      return res.status(403).json({ error: 'Cannot delete default templates' });
    }

    const { error } = await supabase
      .from('outreach_templates')
      .delete()
      .eq('id', templateId)
      .eq('agency_id', agencyId);

    if (error) {
      console.error('Error deleting template:', error);
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting template:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// POST /api/agency/:agencyId/templates/:templateId/duplicate
// Duplicate a template (including defaults)
// ============================================================================
router.post('/:agencyId/templates/:templateId/duplicate', async (req, res) => {
  try {
    const { agencyId, templateId } = req.params;
    const { name } = req.body;

    // Get original template
    const { data: original, error: fetchError } = await supabase
      .from('outreach_templates')
      .select('*')
      .eq('id', templateId)
      .single();

    if (fetchError || !original) {
      return res.status(404).json({ error: 'Template not found' });
    }

    // Create duplicate
    const { data: template, error } = await supabase
      .from('outreach_templates')
      .insert({
        agency_id: agencyId,
        name: name || `${original.name} (Copy)`,
        description: original.description,
        type: original.type,
        subject: original.subject,
        body: original.body,
        is_follow_up: original.is_follow_up,
        sequence_name: null,  // Don't copy sequence info
        sequence_order: null,
        delay_days: original.delay_days,
        is_default: false
      })
      .select()
      .single();

    if (error) {
      console.error('Error duplicating template:', error);
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json({ success: true, template });
  } catch (error) {
    console.error('Error duplicating template:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// POST /api/agency/:agencyId/outreach/compose
// Compose a message from a template (variable substitution)
// ============================================================================
router.post('/:agencyId/outreach/compose', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const { templateId, leadId, customSubject, customBody } = req.body;

    // Get agency data
    const { data: agency } = await supabase
      .from('agencies')
      .select('*')
      .eq('id', agencyId)
      .single();

    // Get agency owner
    const { data: owner } = await supabase
      .from('users')
      .select('first_name, last_name, email')
      .eq('agency_id', agencyId)
      .eq('role', 'agency_owner')
      .single();

    // Get lead data if provided
    let lead = null;
    if (leadId) {
      const { data } = await supabase
        .from('leads')
        .select('*')
        .eq('id', leadId)
        .eq('agency_id', agencyId)
        .single();
      lead = data;
    }

    // Get template if provided
    let subject = customSubject || '';
    let body = customBody || '';

    if (templateId) {
      const { data: template } = await supabase
        .from('outreach_templates')
        .select('*')
        .eq('id', templateId)
        .single();

      if (template) {
        subject = customSubject || template.subject || '';
        body = customBody || template.body || '';
      }
    }

    // Build replacement map
    const platformDomain = process.env.PLATFORM_DOMAIN || 'myvoiceaiconnect.com';
    const signupLink = agency?.marketing_domain && agency?.domain_verified
      ? `https://${agency.marketing_domain}/signup`
      : `https://${agency?.slug}.${platformDomain}/signup`;

    const replacements = {
      // Lead variables
      '{lead_business_name}': lead?.business_name || '[Business Name]',
      '{lead_contact_name}': lead?.contact_name || '[Contact Name]',
      '{lead_contact_first_name}': lead?.contact_name?.split(' ')[0] || '[First Name]',
      '{lead_industry}': lead?.industry || '[Industry]',
      '{lead_email}': lead?.email || '[Email]',
      '{lead_phone}': lead?.phone || '[Phone]',
      '{lead_website}': lead?.website || '[Website]',
      '{lead_source}': lead?.source || '[Source]',
      
      // Agency variables
      '{agency_name}': agency?.name || '[Agency Name]',
      '{agency_owner_name}': owner ? `${owner.first_name} ${owner.last_name}`.trim() : '[Your Name]',
      '{agency_email}': agency?.email || owner?.email || '[Email]',
      '{agency_phone}': agency?.phone || '[Phone]',
      '{agency_website}': agency?.marketing_domain || `${agency?.slug}.${platformDomain}`,
      '{signup_link}': signupLink,
      
      // Dynamic variables
      '{today_date}': new Date().toLocaleDateString('en-US', { 
        weekday: 'long', 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
      }),
      '{personalized_line}': '[Personalized line - generate with AI]',
    };

    // Perform replacements
    let composedSubject = subject;
    let composedBody = body;

    for (const [variable, value] of Object.entries(replacements)) {
      composedSubject = composedSubject.replace(new RegExp(variable.replace(/[{}]/g, '\\$&'), 'g'), value);
      composedBody = composedBody.replace(new RegExp(variable.replace(/[{}]/g, '\\$&'), 'g'), value);
    }

    res.json({
      subject: composedSubject,
      body: composedBody,
      toAddress: lead?.email || '',
      toPhone: lead?.phone || '',
      variables: replacements
    });
  } catch (error) {
    console.error('Error composing message:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// POST /api/agency/:agencyId/outreach/log
// Log that an outreach was sent (copy-to-clipboard flow)
// ============================================================================
router.post('/:agencyId/outreach/log', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const { leadId, templateId, type, toAddress, subject, body, userId } = req.body;

    if (!type || !toAddress || !body) {
      return res.status(400).json({ error: 'type, toAddress, and body are required' });
    }

    // Log to outreach_emails
    const { data: outreach, error } = await supabase
      .from('outreach_emails')
      .insert({
        agency_id: agencyId,
        lead_id: leadId || null,
        template_id: templateId || null,
        type,
        to_address: toAddress,
        subject: subject || null,
        body,
        status: 'sent'
      })
      .select()
      .single();

    if (error) {
      console.error('Error logging outreach:', error);
      return res.status(400).json({ error: error.message });
    }

    // Log activity
    if (leadId) {
      await logActivity(
        agencyId,
        'lead',
        leadId,
        type === 'email' ? ACTION_TYPES.EMAIL_SENT : ACTION_TYPES.SMS_SENT,
        { 
          subject, 
          to_address: toAddress,
          outreach_id: outreach.id 
        },
        userId
      );
    }

    // Update template use count
    if (templateId) {
      const { data: template } = await supabase
        .from('outreach_templates')
        .select('use_count')
        .eq('id', templateId)
        .single();
      
      if (template) {
        await supabase
          .from('outreach_templates')
          .update({ use_count: (template.use_count || 0) + 1 })
          .eq('id', templateId);
      }
    }

    res.status(201).json({ success: true, outreach });
  } catch (error) {
    console.error('Error logging outreach:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// GET /api/agency/:agencyId/outreach/history
// Get outreach history
// ============================================================================
router.get('/:agencyId/outreach/history', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const { leadId, type, limit = 50, offset = 0 } = req.query;

    let query = supabase
      .from('outreach_emails')
      .select(`
        *,
        lead:leads (id, business_name, contact_name),
        template:outreach_templates (id, name)
      `, { count: 'exact' })
      .eq('agency_id', agencyId)
      .order('sent_at', { ascending: false });

    if (leadId) {
      query = query.eq('lead_id', leadId);
    }
    if (type) {
      query = query.eq('type', type);
    }

    query = query.range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    const { data: history, error, count } = await query;

    if (error) {
      console.error('Error fetching outreach history:', error);
      return res.status(400).json({ error: error.message });
    }

    res.json({ history: history || [], total: count });
  } catch (error) {
    console.error('Error fetching outreach history:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// GET /api/agency/:agencyId/outreach/variables
// Get available template variables
// ============================================================================
router.get('/:agencyId/outreach/variables', async (req, res) => {
  res.json({ variables: TEMPLATE_VARIABLES });
});

// ============================================================================
// POST /api/agency/:agencyId/templates/seed-defaults
// Seed default templates for an agency (if they don't have any)
// ============================================================================
router.post('/:agencyId/templates/seed-defaults', async (req, res) => {
  try {
    const { agencyId } = req.params;
    
    const { seedDefaultTemplatesIfNeeded } = require('../lib/default-templates');
    const result = await seedDefaultTemplatesIfNeeded(agencyId);
    
    if (result.skipped) {
      return res.json({ success: true, message: 'Templates already exist', skipped: true });
    }
    
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    
    res.json({ success: true, message: `Created ${result.count} default templates` });
  } catch (error) {
    console.error('Error seeding templates:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
module.exports.TEMPLATE_VARIABLES = TEMPLATE_VARIABLES;
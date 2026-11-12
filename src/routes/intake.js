// ============================================================================
// Intake routes (agency dashboard)
// VoiceAI Connect
// ----------------------------------------------------------------------------
// Powers the intake dashboard UI: list templates (platform + the agency's own),
// get/save a client's intake config, and list the captured records. All scoped
// to the agency via requireAgencyAccess, and every client lookup is filtered by
// agency_id so one agency can never read or write another's client.
// ============================================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { requireAgencyAccess } = require('./auth');
const { INTAKE_TEMPLATES } = require('../lib/intake-templates');

router.use('/:agencyId/intake', requireAgencyAccess('clients'));
router.use('/:agencyId/clients/:clientId/intake', requireAgencyAccess('clients'));

// Platform templates + this agency's own custom templates (for the picker).
router.get('/:agencyId/intake/templates', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const platform = INTAKE_TEMPLATES.map((t) => ({
      key: t.key, label: t.label, industry: t.industry || null,
      intro: t.intro || '', fields: t.fields || [], source: 'platform',
    }));
    let agencyTemplates = [];
    try {
      const { data } = await supabase
        .from('intake_templates')
        .select('id, name, industry, schema, locked')
        .eq('agency_id', agencyId)
        .order('created_at', { ascending: false });
      agencyTemplates = (data || []).map((t) => ({
        key: `agency:${t.id}`, id: t.id, label: t.name, industry: t.industry || null,
        intro: (t.schema && t.schema.intro) || '', fields: (t.schema && t.schema.fields) || [],
        locked: t.locked === true, source: 'agency',
      }));
    } catch (e) { /* table may not exist yet or be empty */ }
    res.json({ templates: [...platform, ...agencyTemplates] });
  } catch (e) {
    console.error('intake templates error:', e.message);
    res.status(500).json({ error: 'Failed to load templates' });
  }
});

// Get a client's intake config.
router.get('/:agencyId/clients/:clientId/intake', async (req, res) => {
  try {
    const { agencyId, clientId } = req.params;
    const { data: client } = await supabase
      .from('clients')
      .select('id, business_name, intake_enabled, intake_config, intake_template_key, intake_sms_enabled, intake_sms_number, owner_phone')
      .eq('id', clientId).eq('agency_id', agencyId).single();
    if (!client) return res.status(404).json({ error: 'Client not found' });
    res.json({ intake: {
      enabled: client.intake_enabled === true,
      template_key: client.intake_template_key || null,
      config: client.intake_config || null,
      sms_enabled: client.intake_sms_enabled === true,
      sms_number: client.intake_sms_number || null,
      owner_phone: client.owner_phone || null,
      business_name: client.business_name || null,
    } });
  } catch (e) {
    console.error('intake get error:', e.message);
    res.status(500).json({ error: 'Failed to load intake' });
  }
});

// Save a client's intake config.
router.put('/:agencyId/clients/:clientId/intake', async (req, res) => {
  try {
    const { agencyId, clientId } = req.params;
    const { enabled, template_key, config, sms_enabled, sms_number } = req.body || {};
    const upd = {};
    if (enabled !== undefined) upd.intake_enabled = !!enabled;
    if (template_key !== undefined) upd.intake_template_key = template_key || null;
    if (config !== undefined) upd.intake_config = config || null;
    if (sms_enabled !== undefined) upd.intake_sms_enabled = !!sms_enabled;
    if (sms_number !== undefined) upd.intake_sms_number = (sms_number && String(sms_number).trim()) || null;
    if (!Object.keys(upd).length) return res.json({ success: true });
    const { error } = await supabase.from('clients').update(upd).eq('id', clientId).eq('agency_id', agencyId);
    if (error) return res.status(500).json({ error: 'Failed to save' });
    res.json({ success: true });
  } catch (e) {
    console.error('intake save error:', e.message);
    res.status(500).json({ error: 'Failed to save intake' });
  }
});

// List captured intake records for a client (newest first).
router.get('/:agencyId/clients/:clientId/intake/records', async (req, res) => {
  try {
    const { agencyId, clientId } = req.params;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const { data } = await supabase
      .from('intake_records')
      .select('id, call_id, template_key, data, caller_phone, created_at')
      .eq('client_id', clientId).eq('agency_id', agencyId)
      .order('created_at', { ascending: false }).limit(limit);
    res.json({ records: data || [] });
  } catch (e) {
    console.error('intake records error:', e.message);
    res.status(500).json({ error: 'Failed to load records' });
  }
});

module.exports = router;

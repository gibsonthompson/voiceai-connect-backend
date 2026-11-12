// ============================================================================
// Intake routes
// VoiceAI Connect
// ----------------------------------------------------------------------------
// Two routers:
//   agencyRouter (mounted /api/agency) - the agency manages a client's intake,
//     manages its own reusable templates (the white-label upsell), and can LOCK
//     a client's form (white-glove: the client can't edit the fields).
//   clientRouter (mounted /api/client) - the business owner sees their own
//     captured records and, unless the agency locked it, edits their own form.
// Every query is scoped (agency by agency_id, client by its own id) so no tenant
// can read or write another's data.
// ============================================================================

const express = require('express');
const { supabase } = require('../lib/supabase');
const { requireAgencyAccess, requireClientAccess } = require('./auth');
const { INTAKE_TEMPLATES } = require('../lib/intake-templates');

function platformTemplates() {
  return INTAKE_TEMPLATES.map((t) => ({
    key: t.key, label: t.label, industry: t.industry || null,
    intro: t.intro || '', fields: t.fields || [], source: 'platform',
  }));
}

async function agencyTemplates(agencyId) {
  try {
    const { data } = await supabase
      .from('intake_templates')
      .select('id, name, industry, schema, locked')
      .eq('agency_id', agencyId)
      .order('created_at', { ascending: false });
    return (data || []).map((t) => ({
      key: `agency:${t.id}`, id: t.id, label: t.name, industry: t.industry || null,
      intro: (t.schema && t.schema.intro) || '', fields: (t.schema && t.schema.fields) || [],
      locked: t.locked === true, source: 'agency',
    }));
  } catch (e) { return []; }
}

// ============================================================================
// AGENCY ROUTER
// ============================================================================
const agencyRouter = express.Router();
agencyRouter.use('/:agencyId/intake', requireAgencyAccess('clients'));
agencyRouter.use('/:agencyId/clients/:clientId/intake', requireAgencyAccess('clients'));

// Templates the picker shows: platform + this agency's own.
agencyRouter.get('/:agencyId/intake/templates', async (req, res) => {
  try {
    const list = [...platformTemplates(), ...(await agencyTemplates(req.params.agencyId))];
    res.json({ templates: list });
  } catch (e) { res.status(500).json({ error: 'Failed to load templates' }); }
});

// Create a reusable agency template (white-label upsell).
agencyRouter.post('/:agencyId/intake/templates', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const { name, industry, schema } = req.body || {};
    if (!name || !schema || !Array.isArray(schema.fields)) return res.status(400).json({ error: 'name and schema.fields are required' });
    const { data, error } = await supabase.from('intake_templates')
      .insert([{ agency_id: agencyId, name: String(name).trim(), industry: industry || null, schema }])
      .select('id').single();
    if (error) return res.status(500).json({ error: 'Failed to create template' });
    res.json({ success: true, id: data.id, key: `agency:${data.id}` });
  } catch (e) { res.status(500).json({ error: 'Failed to create template' }); }
});

agencyRouter.put('/:agencyId/intake/templates/:id', async (req, res) => {
  try {
    const { agencyId, id } = req.params;
    const { name, industry, schema, locked } = req.body || {};
    const upd = { updated_at: new Date().toISOString() };
    if (name !== undefined) upd.name = String(name).trim();
    if (industry !== undefined) upd.industry = industry || null;
    if (schema !== undefined) upd.schema = schema;
    if (locked !== undefined) upd.locked = !!locked;
    const { error } = await supabase.from('intake_templates').update(upd).eq('id', id).eq('agency_id', agencyId);
    if (error) return res.status(500).json({ error: 'Failed to update template' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed to update template' }); }
});

agencyRouter.delete('/:agencyId/intake/templates/:id', async (req, res) => {
  try {
    const { agencyId, id } = req.params;
    const { error } = await supabase.from('intake_templates').delete().eq('id', id).eq('agency_id', agencyId);
    if (error) return res.status(500).json({ error: 'Failed to delete template' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed to delete template' }); }
});

// A client's intake config.
agencyRouter.get('/:agencyId/clients/:clientId/intake', async (req, res) => {
  try {
    const { agencyId, clientId } = req.params;
    const { data: client } = await supabase.from('clients')
      .select('id, business_name, intake_enabled, intake_config, intake_template_key, intake_sms_enabled, intake_sms_number, intake_locked, owner_phone')
      .eq('id', clientId).eq('agency_id', agencyId).single();
    if (!client) return res.status(404).json({ error: 'Client not found' });
    res.json({ intake: {
      enabled: client.intake_enabled === true,
      template_key: client.intake_template_key || null,
      config: client.intake_config || null,
      sms_enabled: client.intake_sms_enabled === true,
      sms_number: client.intake_sms_number || null,
      locked: client.intake_locked === true,
      owner_phone: client.owner_phone || null,
      business_name: client.business_name || null,
    } });
  } catch (e) { res.status(500).json({ error: 'Failed to load intake' }); }
});

agencyRouter.put('/:agencyId/clients/:clientId/intake', async (req, res) => {
  try {
    const { agencyId, clientId } = req.params;
    const { enabled, template_key, config, sms_enabled, sms_number, locked } = req.body || {};
    const upd = {};
    if (enabled !== undefined) upd.intake_enabled = !!enabled;
    if (template_key !== undefined) upd.intake_template_key = template_key || null;
    if (config !== undefined) upd.intake_config = config || null;
    if (sms_enabled !== undefined) upd.intake_sms_enabled = !!sms_enabled;
    if (sms_number !== undefined) upd.intake_sms_number = (sms_number && String(sms_number).trim()) || null;
    if (locked !== undefined) upd.intake_locked = !!locked;
    if (!Object.keys(upd).length) return res.json({ success: true });
    const { error } = await supabase.from('clients').update(upd).eq('id', clientId).eq('agency_id', agencyId);
    if (error) return res.status(500).json({ error: 'Failed to save' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed to save intake' }); }
});

agencyRouter.get('/:agencyId/clients/:clientId/intake/records', async (req, res) => {
  try {
    const { agencyId, clientId } = req.params;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const { data } = await supabase.from('intake_records')
      .select('id, call_id, template_key, data, caller_phone, created_at')
      .eq('client_id', clientId).eq('agency_id', agencyId)
      .order('created_at', { ascending: false }).limit(limit);
    res.json({ records: data || [] });
  } catch (e) { res.status(500).json({ error: 'Failed to load records' }); }
});

// ============================================================================
// CLIENT ROUTER (business-owner login)
// ============================================================================
const clientRouter = express.Router();

clientRouter.get('/:clientId/intake', requireClientAccess('settings'), async (req, res) => {
  try {
    const { clientId } = req.params;
    const { data: client } = await supabase.from('clients')
      .select('id, business_name, intake_enabled, intake_config, intake_template_key, intake_sms_enabled, intake_sms_number, intake_locked, owner_phone')
      .eq('id', clientId).single();
    if (!client) return res.status(404).json({ error: 'Client not found' });
    res.json({ intake: {
      enabled: client.intake_enabled === true,
      template_key: client.intake_template_key || null,
      config: client.intake_config || null,
      sms_enabled: client.intake_sms_enabled === true,
      sms_number: client.intake_sms_number || null,
      locked: client.intake_locked === true,
      owner_phone: client.owner_phone || null,
      business_name: client.business_name || null,
    } });
  } catch (e) { res.status(500).json({ error: 'Failed to load intake' }); }
});

// Client templates: platform + their agency's. Needs the client's agency_id.
clientRouter.get('/:clientId/intake/templates', requireClientAccess('settings'), async (req, res) => {
  try {
    const { clientId } = req.params;
    const { data: client } = await supabase.from('clients').select('agency_id').eq('id', clientId).single();
    const list = [...platformTemplates(), ...(client ? await agencyTemplates(client.agency_id) : [])];
    res.json({ templates: list });
  } catch (e) { res.status(500).json({ error: 'Failed to load templates' }); }
});

// The client edits their own form, unless the agency locked it. SMS destination
// (where THEIR orders go) is always theirs to set.
clientRouter.put('/:clientId/intake', requireClientAccess('settings'), async (req, res) => {
  try {
    const { clientId } = req.params;
    const { data: client } = await supabase.from('clients').select('intake_locked').eq('id', clientId).single();
    const locked = client && client.intake_locked === true;
    const { enabled, template_key, config, sms_enabled, sms_number } = req.body || {};
    const upd = {};
    if (sms_enabled !== undefined) upd.intake_sms_enabled = !!sms_enabled;
    if (sms_number !== undefined) upd.intake_sms_number = (sms_number && String(sms_number).trim()) || null;
    if (!locked) {
      if (enabled !== undefined) upd.intake_enabled = !!enabled;
      if (template_key !== undefined) upd.intake_template_key = template_key || null;
      if (config !== undefined) upd.intake_config = config || null;
    }
    if (!Object.keys(upd).length) return res.json({ success: true, locked });
    const { error } = await supabase.from('clients').update(upd).eq('id', clientId);
    if (error) return res.status(500).json({ error: 'Failed to save' });
    res.json({ success: true, locked });
  } catch (e) { res.status(500).json({ error: 'Failed to save intake' }); }
});

clientRouter.get('/:clientId/intake/records', requireClientAccess('settings'), async (req, res) => {
  try {
    const { clientId } = req.params;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const { data } = await supabase.from('intake_records')
      .select('id, call_id, template_key, data, caller_phone, created_at')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false }).limit(limit);
    res.json({ records: data || [] });
  } catch (e) { res.status(500).json({ error: 'Failed to load records' }); }
});

module.exports = { agencyRouter, clientRouter };

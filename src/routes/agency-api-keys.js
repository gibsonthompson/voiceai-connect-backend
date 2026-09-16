// agency-api-keys.js, dashboard endpoints for managing API keys.
//
// These are session-authenticated (mounted in server.js behind the same
// requirePermissionIfAuthed('settings') guard as agency settings), NOT via API
// key, you can't create your first key with a key you don't have yet.
//
// The raw key is shown exactly once, at creation. We store only its SHA-256 hash
// and a short display prefix; a lost key is revoked and replaced, never recovered.

const crypto = require('crypto');
const { supabase } = require('../lib/supabase');
const { hasScale, sha256 } = require('../middleware/api-auth');

async function getAgencyPlan(agencyId) {
  const { data } = await supabase
    .from('agencies').select('id, plan_type, subscription_status').eq('id', agencyId).single();
  return data || null;
}

// POST /api/agency/:agencyId/api-keys
async function createApiKey(req, res) {
  try {
    const { agencyId } = req.params;
    const agency = await getAgencyPlan(agencyId);
    if (!agency) return res.status(404).json({ error: 'Agency not found' });
    if (!hasScale(agency)) {
      return res.status(403).json({
        error: 'upgrade_required',
        upgrade_required: true,
        message: 'API access is a Scale plan feature. Upgrade to create API keys.',
        current_plan: agency.plan_type,
      });
    }

    const name = (req.body && typeof req.body.name === 'string' && req.body.name.trim())
      ? req.body.name.trim().slice(0, 80) : 'API key';
    const scope = (req.body && ['read', 'read_write'].includes(req.body.scope))
      ? req.body.scope : 'read_write';

    const raw = 'vac_live_' + crypto.randomBytes(24).toString('hex');
    const keyPrefix = raw.slice(0, 17); // vac_live_ + first 8 hex chars, for display

    const { data, error } = await supabase
      .from('agency_api_keys')
      .insert({ agency_id: agencyId, name, scope, key_prefix: keyPrefix, key_hash: sha256(raw) })
      .select('id, name, scope, key_prefix, created_at')
      .single();
    if (error) return res.status(400).json({ error: error.message });

    // key is returned ONCE and never again.
    return res.status(201).json({ ...data, key: raw });
  } catch (err) {
    console.error('createApiKey error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// GET /api/agency/:agencyId/api-keys
async function listApiKeys(req, res) {
  try {
    const { agencyId } = req.params;
    const { data, error } = await supabase
      .from('agency_api_keys')
      .select('id, name, scope, key_prefix, last_used_at, created_at')
      .eq('agency_id', agencyId)
      .is('revoked_at', null)
      .order('created_at', { ascending: false });
    if (error) return res.status(400).json({ error: error.message });
    return res.json({ keys: data || [] });
  } catch (err) {
    console.error('listApiKeys error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// DELETE /api/agency/:agencyId/api-keys/:keyId
async function revokeApiKey(req, res) {
  try {
    const { agencyId, keyId } = req.params;
    const { data, error } = await supabase
      .from('agency_api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', keyId)
      .eq('agency_id', agencyId)
      .is('revoked_at', null)
      .select('id')
      .single();
    if (error || !data) return res.status(404).json({ error: 'Key not found' });
    return res.json({ success: true });
  } catch (err) {
    console.error('revokeApiKey error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

module.exports = { createApiKey, listApiKeys, revokeApiKey };
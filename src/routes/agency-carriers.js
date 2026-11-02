// ============================================================================
// AGENCY CARRIERS (Bring Your Own Carrier / BYOC) ROUTES
// ----------------------------------------------------------------------------
// Per-agency external SIP carrier profiles. Lets an agency onboard a client
// that keeps its EXISTING phone number on its own / local carrier's SIP trunk,
// instead of buying a Telnyx or Twilio DID.
//
// Mounted at /api/agency (same as byot). Routes live under /:agencyId/carriers.
// Mirrors byot.js conventions exactly:
//   • requireAgencyAccess('settings') guards EVERY route up front (ownership).
//   • A per-route loadAgency sets req.agency.
//   • Carrier auth passwords are ENCRYPTED via lib/encryption (never returned).
//   • No plan gate: the agency uses their own carrier, so it costs us nothing
//     (same reasoning byot.js uses to open BYOT to all plans).
//
// The actual VAPI byo-sip-trunk credential is created lazily on first use
// (getOrCreateSipTrunkCredential in lib/vapi) and its id cached on the carrier
// row; the /test endpoint forces that creation so an agency can verify setup
// before onboarding a client.
//
// CREATED: 2026-11-02
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase, getAgencyById } = require('../lib/supabase');
const { encrypt } = require('../lib/encryption');
const { getOrCreateSipTrunkCredential } = require('../lib/vapi');
const { requireAgencyAccess } = require('./auth');

const VAPI_API_KEY = process.env.VAPI_API_KEY;

// VAPI signaling IPs the carrier must allowlist, surfaced to the UI so the
// agency can hand them to their carrier. Verified against VAPI docs 2026-11-02.
const VAPI_SIGNALING_IPS = {
  us: ['44.229.228.186/32', '44.238.177.138/32'],
  eu: ['63.182.83.170/32'],
};
const VAPI_RTP_RANGE = 'UDP 40000-60000';

// ----------------------------------------------------------------------------
// OWNERSHIP GUARD — every /:agencyId/carriers* route, before anything else.
// ----------------------------------------------------------------------------
router.use('/:agencyId/carriers', requireAgencyAccess('settings'));

// Load req.agency (ownership already proven by the guard above).
async function loadAgency(req, res, next) {
  try {
    const agency = await getAgencyById(req.params.agencyId);
    if (!agency) return res.status(404).json({ error: 'Agency not found' });
    req.agency = agency;
    next();
  } catch (err) {
    console.error('[carriers] loadAgency error:', err.message);
    res.status(500).json({ error: 'Failed to load agency' });
  }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

// Normalize gateway_ips input: accept an array or a comma/space/newline list,
// trim, drop blanks and dedupe. IPs only (VAPI 400s on an FQDN) — we do not buy
// a DNS lookup here, but we reject anything with letters so an obvious hostname
// is caught before it reaches VAPI.
function normalizeGatewayIps(input) {
  let list = [];
  if (Array.isArray(input)) list = input;
  else if (typeof input === 'string') list = input.split(/[\s,]+/);
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const ip = String(raw || '').trim();
    if (!ip) continue;
    if (/[a-zA-Z]/.test(ip)) {
      const err = new Error(`"${ip}" looks like a hostname. VAPI requires IP addresses for SIP gateways.`);
      err.badInput = true;
      throw err;
    }
    if (!seen.has(ip)) { seen.add(ip); out.push(ip); }
  }
  return out;
}

// Public (secret-free) shape of a carrier row for API responses.
function publicCarrier(row, region) {
  const r = region || row.region || 'us';
  return {
    id: row.id,
    name: row.name,
    gateway_ips: row.gateway_ips || [],
    auth_type: row.auth_type || 'ip',
    auth_username: row.auth_username || null,
    has_auth_password: !!row.auth_password_encrypted,
    sip_realm: row.sip_realm || null,
    region: r,
    codec: row.codec || 'g711',
    credential_ready: !!row.vapi_sip_trunk_credential_id,
    verified_at: row.verified_at || null,
    created_at: row.created_at || null,
    // Interconnect details the agency hands to their carrier.
    vapi_signaling_ips: VAPI_SIGNALING_IPS[r] || VAPI_SIGNALING_IPS.us,
    vapi_rtp_range: VAPI_RTP_RANGE,
  };
}

// ============================================================================
// GET /api/agency/:agencyId/carriers  — list carriers (no secrets)
// ============================================================================
router.get('/:agencyId/carriers', loadAgency, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('agency_carriers')
      .select('*')
      .eq('agency_id', req.params.agencyId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json({ carriers: (data || []).map((c) => publicCarrier(c)) });
  } catch (err) {
    console.error('[carriers] list failed:', err.message);
    res.status(500).json({ error: 'Failed to load carriers' });
  }
});

// ============================================================================
// POST /api/agency/:agencyId/carriers  — create a carrier profile
// body: { name, gateway_ips, auth_type, auth_username?, auth_password?, sip_realm?, region?, codec? }
// ============================================================================
router.post('/:agencyId/carriers', loadAgency, async (req, res) => {
  const { agencyId } = req.params;
  const b = req.body || {};
  try {
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'A carrier name is required.' });

    let gateway_ips;
    try { gateway_ips = normalizeGatewayIps(b.gateway_ips); }
    catch (e) { if (e.badInput) return res.status(400).json({ error: e.message }); throw e; }
    if (!gateway_ips.length) return res.status(400).json({ error: 'At least one SIP gateway IP address is required.' });

    const auth_type = b.auth_type === 'credential' ? 'credential' : 'ip';
    const region = String(b.region || 'us').toLowerCase() === 'eu' ? 'eu' : 'us';
    const codec = String(b.codec || 'g711').trim() || 'g711';

    const row = {
      agency_id: agencyId,
      name,
      gateway_ips,
      auth_type,
      region,
      codec,
      auth_username: auth_type === 'credential' ? (String(b.auth_username || '').trim() || null) : null,
      sip_realm: auth_type === 'credential' ? (String(b.sip_realm || '').trim() || null) : null,
      auth_password_encrypted: null,
    };
    if (auth_type === 'credential' && b.auth_password) {
      row.auth_password_encrypted = encrypt(String(b.auth_password));
    }

    const { data, error } = await supabase.from('agency_carriers').insert([row]).select('*').single();
    if (error) throw error;
    res.json({ success: true, carrier: publicCarrier(data) });
  } catch (err) {
    console.error('[carriers] create failed:', err.message);
    res.status(500).json({ error: 'Failed to create carrier' });
  }
});

// ============================================================================
// PATCH /api/agency/:agencyId/carriers/:carrierId  — update a carrier
// Changing gateways/auth/region invalidates the cached VAPI credential so it is
// rebuilt on next use (an interconnect change must not reuse a stale trunk).
// ============================================================================
router.patch('/:agencyId/carriers/:carrierId', loadAgency, async (req, res) => {
  const { agencyId, carrierId } = req.params;
  const b = req.body || {};
  try {
    const { data: existing, error: exErr } = await supabase
      .from('agency_carriers').select('*').eq('id', carrierId).eq('agency_id', agencyId).single();
    if (exErr || !existing) return res.status(404).json({ error: 'Carrier not found' });

    const patch = { updated_at: new Date().toISOString() };
    let interconnectChanged = false;

    if (b.name !== undefined) {
      const name = String(b.name || '').trim();
      if (!name) return res.status(400).json({ error: 'Carrier name cannot be empty.' });
      patch.name = name;
    }
    if (b.gateway_ips !== undefined) {
      let gw;
      try { gw = normalizeGatewayIps(b.gateway_ips); }
      catch (e) { if (e.badInput) return res.status(400).json({ error: e.message }); throw e; }
      if (!gw.length) return res.status(400).json({ error: 'At least one SIP gateway IP address is required.' });
      patch.gateway_ips = gw;
      interconnectChanged = true;
    }
    if (b.region !== undefined) {
      patch.region = String(b.region).toLowerCase() === 'eu' ? 'eu' : 'us';
      interconnectChanged = true;
    }
    if (b.codec !== undefined) patch.codec = String(b.codec || 'g711').trim() || 'g711';
    if (b.auth_type !== undefined) {
      patch.auth_type = b.auth_type === 'credential' ? 'credential' : 'ip';
      interconnectChanged = true;
      if (patch.auth_type === 'ip') {
        patch.auth_username = null;
        patch.sip_realm = null;
        patch.auth_password_encrypted = null;
      }
    }
    if (b.auth_username !== undefined) patch.auth_username = String(b.auth_username || '').trim() || null;
    if (b.sip_realm !== undefined) patch.sip_realm = String(b.sip_realm || '').trim() || null;
    if (b.auth_password) { patch.auth_password_encrypted = encrypt(String(b.auth_password)); interconnectChanged = true; }

    // Rebuild the VAPI credential on next use if the trunk definition changed.
    if (interconnectChanged) patch.vapi_sip_trunk_credential_id = null;

    const { data, error } = await supabase
      .from('agency_carriers').update(patch).eq('id', carrierId).eq('agency_id', agencyId).select('*').single();
    if (error) throw error;
    res.json({ success: true, carrier: publicCarrier(data) });
  } catch (err) {
    console.error('[carriers] update failed:', err.message);
    res.status(500).json({ error: 'Failed to update carrier' });
  }
});

// ============================================================================
// DELETE /api/agency/:agencyId/carriers/:carrierId  — remove a carrier
// Best-effort delete of the VAPI credential. Clients already using this carrier
// keep working (their imported number is independent); the FK is ON DELETE SET
// NULL so their carrier_id simply clears.
// ============================================================================
router.delete('/:agencyId/carriers/:carrierId', loadAgency, async (req, res) => {
  const { agencyId, carrierId } = req.params;
  try {
    const { data: existing } = await supabase
      .from('agency_carriers').select('*').eq('id', carrierId).eq('agency_id', agencyId).single();
    if (!existing) return res.status(404).json({ error: 'Carrier not found' });

    if (existing.vapi_sip_trunk_credential_id && VAPI_API_KEY) {
      const base = existing.region === 'eu' ? 'https://api.eu.vapi.ai' : 'https://api.vapi.ai';
      try {
        await fetch(`${base}/credential/${existing.vapi_sip_trunk_credential_id}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
        });
      } catch (e) { console.warn('[carriers] VAPI credential delete best-effort failed:', e.message); }
    }

    const { error } = await supabase.from('agency_carriers').delete().eq('id', carrierId).eq('agency_id', agencyId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('[carriers] delete failed:', err.message);
    res.status(500).json({ error: 'Failed to delete carrier' });
  }
});

// ============================================================================
// POST /api/agency/:agencyId/carriers/:carrierId/test
// Forces creation of the VAPI byo-sip-trunk credential and caches its id, so the
// agency can verify VAPI accepted the gateway config before onboarding a client.
// Returns the inbound target + the IPs/ports the carrier must allowlist. A real
// inbound call is still the final interconnect test (one per carrier).
// ============================================================================
router.post('/:agencyId/carriers/:carrierId/test', loadAgency, async (req, res) => {
  const { agencyId, carrierId } = req.params;
  try {
    const { decrypt } = require('../lib/encryption');
    const { data: carrier, error } = await supabase
      .from('agency_carriers').select('*').eq('id', carrierId).eq('agency_id', agencyId).single();
    if (error || !carrier) return res.status(404).json({ error: 'Carrier not found' });

    let authPassword = null;
    if (carrier.auth_type === 'credential' && carrier.auth_password_encrypted) {
      try { authPassword = decrypt(carrier.auth_password_encrypted); }
      catch (e) { return res.status(400).json({ success: false, error: 'Stored carrier password could not be decrypted. Re-enter it and save.' }); }
    }

    let credentialId;
    try {
      credentialId = await getOrCreateSipTrunkCredential(carrier, { authPassword });
    } catch (e) {
      return res.status(400).json({ success: false, error: e.message });
    }

    const now = new Date().toISOString();
    await supabase.from('agency_carriers')
      .update({ vapi_sip_trunk_credential_id: credentialId, verified_at: now, updated_at: now })
      .eq('id', carrierId).eq('agency_id', agencyId)
      .then(() => {}, () => {});

    const base = carrier.region === 'eu' ? 'sip.eu.vapi.ai' : 'sip.vapi.ai';
    res.json({
      success: true,
      message: 'VAPI accepted this carrier trunk. Point the carrier at the inbound target below and place one test call.',
      credential_id: credentialId,
      inbound_target_format: `{number}@${credentialId}.${base}`,
      allowlist_signaling_ips: VAPI_SIGNALING_IPS[carrier.region] || VAPI_SIGNALING_IPS.us,
      allowlist_rtp: VAPI_RTP_RANGE,
      verified_at: now,
    });
  } catch (err) {
    console.error('[carriers] test failed:', err.message);
    res.status(500).json({ error: 'Failed to test carrier' });
  }
});

module.exports = router;

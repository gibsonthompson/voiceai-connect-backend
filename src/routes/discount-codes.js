// ============================================================================
// DISCOUNT CODES  (Phase 1: storage + management)
// ----------------------------------------------------------------------------
// Agency-created codes their clients will redeem at checkout. Phase 1 is CRUD +
// management only; the checkout application (a Stripe coupon for percent-off,
// skipping the setup-fee line item for waive_setup, and redemption tracking) is
// Phase 2. Pro/Scale only. Mounted at /api/agency, so the paths below resolve to
// /api/agency/:agencyId/discount-codes.
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase, getAgencyById } = require('../lib/supabase');
const { requireAgencyAccess } = require('./auth');
const { getEffectivePlan } = require('../lib/plan-access');

router.use('/:agencyId/discount-codes', requireAgencyAccess());

// Pro/Scale gate. Uses the effective-plan helper so comped/trial agencies resolve
// the same way they do for every other paid feature.
async function requirePaidPlan(req, res, next) {
  try {
    const agency = await getAgencyById(req.params.agencyId);
    if (!agency) return res.status(404).json({ error: 'Agency not found' });
    const plan = getEffectivePlan(agency);
    if (!['pro', 'professional', 'scale', 'enterprise'].includes(plan)) {
      return res.status(403).json({ error: 'Discount codes are a Pro or Scale feature.', upgrade_required: true });
    }
    next();
  } catch (e) {
    console.error('discount-codes plan gate error:', e.message);
    res.status(500).json({ error: 'Plan check failed' });
  }
}

const normalizeCode = (raw) => String(raw || '').trim().toUpperCase();

function validatePayload(body) {
  const code = normalizeCode(body.code);
  if (!code) return { error: 'Code is required' };
  if (!/^[A-Z0-9_-]{2,40}$/.test(code)) return { error: 'Code must be 2-40 letters, numbers, dashes or underscores' };

  const percentOff = (body.percent_off === '' || body.percent_off == null) ? null : Number(body.percent_off);
  const waiveSetup = body.waive_setup === true;
  if (percentOff != null && (!Number.isFinite(percentOff) || percentOff < 1 || percentOff > 100)) {
    return { error: 'Percent off must be between 1 and 100' };
  }
  if (percentOff == null && !waiveSetup) {
    return { error: 'Set a percent off, waive the setup fee, or both' };
  }

  const duration = ['once', 'forever', 'repeating'].includes(body.duration) ? body.duration : 'forever';
  let durationMonths = null;
  if (duration === 'repeating') {
    durationMonths = Number(body.duration_months);
    if (!Number.isInteger(durationMonths) || durationMonths < 1 || durationMonths > 36) {
      return { error: 'Repeating duration needs a month count between 1 and 36' };
    }
  }

  let maxRedemptions = (body.max_redemptions === '' || body.max_redemptions == null) ? null : Number(body.max_redemptions);
  if (maxRedemptions != null && (!Number.isInteger(maxRedemptions) || maxRedemptions < 1)) {
    return { error: 'Max redemptions must be a positive whole number, or blank for unlimited' };
  }

  let expiresAt = null;
  if (body.expires_at) {
    const d = new Date(body.expires_at);
    if (isNaN(d.getTime())) return { error: 'Invalid expiry date' };
    expiresAt = d.toISOString();
  }

  return { value: { code, percent_off: percentOff, waive_setup: waiveSetup, duration, duration_months: durationMonths, max_redemptions: maxRedemptions, expires_at: expiresAt } };
}

const isDup = (error) => error && (error.code === '23505' || /duplicate|unique/i.test(error.message || ''));

// LIST
router.get('/:agencyId/discount-codes', requirePaidPlan, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('discount_codes')
      .select('*')
      .eq('agency_id', req.params.agencyId)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ codes: data || [] });
  } catch (e) {
    console.error('list discount-codes error:', e.message);
    res.status(500).json({ error: 'Failed to load codes' });
  }
});

// CREATE
router.post('/:agencyId/discount-codes', requirePaidPlan, async (req, res) => {
  try {
    const v = validatePayload(req.body || {});
    if (v.error) return res.status(400).json({ error: v.error });
    const { data, error } = await supabase
      .from('discount_codes')
      .insert({ agency_id: req.params.agencyId, ...v.value })
      .select()
      .single();
    if (error) return res.status(isDup(error) ? 409 : 500).json({ error: isDup(error) ? 'A code with that name already exists' : error.message });
    res.json({ code: data });
  } catch (e) {
    console.error('create discount-code error:', e.message);
    res.status(500).json({ error: 'Failed to create code' });
  }
});

// UPDATE (toggle active, or edit the discount fields)
router.patch('/:agencyId/discount-codes/:id', requirePaidPlan, async (req, res) => {
  try {
    const body = req.body || {};
    const patch = {};
    if (typeof body.active === 'boolean') patch.active = body.active;
    const touchesFields = ['code', 'percent_off', 'waive_setup', 'duration', 'duration_months', 'max_redemptions', 'expires_at'].some((k) => k in body);
    if (touchesFields) {
      const v = validatePayload(body);
      if (v.error) return res.status(400).json({ error: v.error });
      Object.assign(patch, v.value);
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to update' });

    const { data, error } = await supabase
      .from('discount_codes')
      .update(patch)
      .eq('id', req.params.id)
      .eq('agency_id', req.params.agencyId)
      .select()
      .maybeSingle();
    if (error) return res.status(isDup(error) ? 409 : 500).json({ error: isDup(error) ? 'A code with that name already exists' : error.message });
    if (!data) return res.status(404).json({ error: 'Code not found' });
    res.json({ code: data });
  } catch (e) {
    console.error('update discount-code error:', e.message);
    res.status(500).json({ error: 'Failed to update code' });
  }
});

// DELETE
router.delete('/:agencyId/discount-codes/:id', requirePaidPlan, async (req, res) => {
  try {
    const { error } = await supabase
      .from('discount_codes')
      .delete()
      .eq('id', req.params.id)
      .eq('agency_id', req.params.agencyId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) {
    console.error('delete discount-code error:', e.message);
    res.status(500).json({ error: 'Failed to delete code' });
  }
});

// ----------------------------------------------------------------------------
// Shared validator (used by the public validate route below AND the checkout
// flow in stripe-connect.js). Returns { code } when usable, else { error }.
// ----------------------------------------------------------------------------
async function resolveDiscountCode(agencyId, rawCode) {
  const code = normalizeCode(rawCode);
  if (!agencyId || !code) return { error: 'No code' };
  const { data, error } = await supabase
    .from('discount_codes')
    .select('*')
    .eq('agency_id', agencyId)
    .eq('code', code)
    .maybeSingle();
  if (error) return { error: 'Lookup failed' };
  if (!data) return { error: 'That code is not valid' };
  if (!data.active) return { error: 'That code is no longer active' };
  if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) return { error: 'That code has expired' };
  if (data.max_redemptions != null && data.redemption_count >= data.max_redemptions) return { error: 'That code has reached its redemption limit' };
  return { code: data };
}

// PUBLIC validate (no agency auth): the client signup form hits this to show the
// discount before submitting. Not caught by the requireAgencyAccess middleware
// above because the path has no :agencyId segment. agency_id comes in the body.
router.post('/discount-codes/validate', async (req, res) => {
  try {
    const { agency_id, code } = req.body || {};
    if (!agency_id || !code) return res.status(400).json({ valid: false, error: 'Missing code or agency' });
    const r = await resolveDiscountCode(agency_id, code);
    if (r.error) return res.json({ valid: false, error: r.error });
    const c = r.code;
    res.json({ valid: true, discount: { code: c.code, percent_off: c.percent_off, waive_setup: c.waive_setup, duration: c.duration, duration_months: c.duration_months } });
  } catch (e) {
    console.error('validate discount-code error:', e.message);
    res.status(500).json({ valid: false, error: 'Validation failed' });
  }
});

module.exports = router;
module.exports.resolveDiscountCode = resolveDiscountCode;

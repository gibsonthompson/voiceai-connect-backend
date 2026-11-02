// ============================================================================
// src/routes/cc-account.js
// Mounted at: app.use('/api/agency', require('./routes/cc-account'))
//
//   GET /:callCenterId/cc/account  -> the call-center account, shaped like the
//                                     agency object the /cc dashboard context
//                                     expects (is_call_center: true).
//   PUT /:callCenterId/cc/account  -> update the call center's own account +
//                                     branding (Settings / Branding screens).
//
// The frontend account context loads GET for a call-center session in place of
// the agency /settings call, so the /cc screens run on the call-center account.
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { requireCallCenterAccess } = require('./auth');

// Map a call_centers row to the agency-shaped object the dashboard context and
// the Settings/Branding screens consume. is_call_center=true keeps it in /cc.
function toAccount(cc) {
  return {
    id: cc.id,
    name: cc.name,
    slug: cc.slug,
    email: cc.email,
    phone: cc.phone,
    support_email: cc.support_email || null,
    support_phone: cc.support_phone || null,
    logo_url: cc.logo_url,
    app_name: cc.app_name || null,
    app_icon_url: cc.app_icon_url,
    primary_color: cc.primary_color || '#10b981',
    secondary_color: cc.secondary_color || '#059669',
    accent_color: cc.accent_color || '#34d399',
    display_font: cc.display_font || null,
    body_font: cc.body_font || null,
    icon_style: cc.icon_style || null,
    brand_kit: cc.brand_kit || null,
    status: cc.status,
    subscription_status: cc.subscription_status,
    plan_type: cc.plan_type || 'standard',
    trial_ends_at: cc.trial_ends_at || null,
    country: cc.country || null,
    created_at: cc.created_at,
    timezone: cc.timezone || null,
    is_call_center: true,
    cc_growth_addon: false,
    access_plan: null,
    branding_overrides: null,
  };
}

router.get('/:callCenterId/cc/account', requireCallCenterAccess('dashboard'), async (req, res) => {
  try {
    const { data: cc, error } = await supabase
      .from('call_centers').select('*').eq('id', req.params.callCenterId).single();
    if (error || !cc) return res.status(404).json({ success: false, error: 'Call center not found' });
    res.json({ success: true, account: toAccount(cc) });
  } catch (e) {
    console.error('cc-account GET error:', e.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// Editable account + branding fields. Only columns on call_centers are written;
// anything else in the body (e.g. favicon_url, branding_overrides) is ignored.
const EDITABLE = [
  'name', 'phone', 'support_email', 'support_phone', 'timezone',
  'logo_url', 'app_name', 'app_icon_url',
  'primary_color', 'secondary_color', 'accent_color',
  'display_font', 'body_font', 'icon_style', 'brand_kit',
];

router.put('/:callCenterId/cc/account', requireCallCenterAccess('settings'), async (req, res) => {
  try {
    const body = req.body || {};
    const updates = { updated_at: new Date().toISOString() };
    for (const k of EDITABLE) {
      if (Object.prototype.hasOwnProperty.call(body, k)) updates[k] = body[k];
    }
    if (typeof updates.name === 'string' && !updates.name.trim()) {
      return res.status(400).json({ success: false, error: 'Name cannot be empty.' });
    }
    const { data: cc, error } = await supabase
      .from('call_centers').update(updates).eq('id', req.params.callCenterId).select('*').single();
    if (error || !cc) return res.status(500).json({ success: false, error: 'Could not save settings.' });
    res.json({ success: true, account: toAccount(cc) });
  } catch (e) {
    console.error('cc-account PUT error:', e.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

module.exports = router;

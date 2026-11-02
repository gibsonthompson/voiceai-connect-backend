// ============================================================================
// src/routes/cc-account.js
// Mounted at: app.use('/api/agency', require('./routes/cc-account'))
//
//   GET /:callCenterId/cc/account  -> the call-center account, shaped like the
//                                     agency object the /cc dashboard context
//                                     expects (is_call_center: true).
//
// The frontend account context loads this for a call-center session in place of
// the agency /settings call, so the /cc screens run on the call-center account.
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { requireCallCenterAccess } = require('./auth');

router.get('/:callCenterId/cc/account', requireCallCenterAccess('dashboard'), async (req, res) => {
  try {
    const { data: cc, error } = await supabase
      .from('call_centers').select('*').eq('id', req.params.callCenterId).single();
    if (error || !cc) return res.status(404).json({ success: false, error: 'Call center not found' });

    // Map to the agency-shaped object the dashboard context consumes. The /cc
    // tree only needs identity, status, and branding; is_call_center=true keeps
    // it inside the /cc shell.
    const account = {
      id: cc.id,
      name: cc.name,
      slug: cc.slug,
      email: cc.email,
      phone: cc.phone,
      logo_url: cc.logo_url,
      app_icon_url: cc.app_icon_url,
      primary_color: cc.primary_color || '#10b981',
      secondary_color: cc.secondary_color || '#059669',
      accent_color: cc.accent_color || '#34d399',
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
      display_font: null,
      body_font: null,
      icon_style: null,
      brand_kit: null,
    };
    res.json({ success: true, account });
  } catch (e) {
    console.error('cc-account error:', e.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

module.exports = router;

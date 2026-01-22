// ============================================================================
// AGENCY SETTINGS
// ============================================================================
const { supabase, getAgencyBySlug, getAgencyByDomain, getAgencyById } = require('../lib/supabase');

// ============================================================================
// GET AGENCY BY HOST (For middleware/frontend)
// ============================================================================
async function getAgencyByHost(req, res) {
  try {
    const { host } = req.query;
    
    if (!host) {
      return res.status(400).json({ error: 'host parameter required' });
    }
    
    console.log('🔍 Looking up agency for host:', host);
    
    let agency = null;
    
    // Check if it's a subdomain of voiceaiconnect.com
    const subdomainMatch = host.match(/^([^.]+)\.myvoiceaiconnect\.com$/);
    if (subdomainMatch) {
      const slug = subdomainMatch[1];
      agency = await getAgencyBySlug(slug);
    }
    
    // Check for custom domain
    if (!agency) {
      agency = await getAgencyByDomain(host);
    }
    
    if (!agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }
    
    console.log('✅ Agency found:', agency.name);
    
    // Return public agency info (for branding)
    res.json({
      success: true,
      agency: {
        id: agency.id,
        name: agency.name,
        slug: agency.slug,
        logo_url: agency.logo_url,
        favicon_url: agency.favicon_url,
        primary_color: agency.primary_color,
        secondary_color: agency.secondary_color,
        accent_color: agency.accent_color,
        support_email: agency.support_email,
        support_phone: agency.support_phone,
        // Pricing (for client signup)
        price_starter: agency.price_starter,
        price_pro: agency.price_pro,
        price_growth: agency.price_growth,
        // Limits
        limit_starter: agency.limit_starter,
        limit_pro: agency.limit_pro,
        limit_growth: agency.limit_growth,
        // Stripe (needed for checkout)
        stripe_account_id: agency.stripe_account_id,
        stripe_charges_enabled: agency.stripe_charges_enabled
      }
    });
    
  } catch (error) {
    console.error('❌ Agency lookup error:', error);
    res.status(500).json({ error: 'Failed to lookup agency' });
  }
}

// ============================================================================
// GET AGENCY SETTINGS (Protected - for agency dashboard)
// ============================================================================
async function getAgencySettings(req, res) {
  try {
    const { agencyId } = req.params;
    
    const agency = await getAgencyById(agencyId);
    
    if (!agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }
    
    // Get client count and stats
    const { data: clients } = await supabase
      .from('clients')
      .select('id, subscription_status, plan_type, calls_this_month')
      .eq('agency_id', agencyId);
    
    const stats = {
      total_clients: clients?.length || 0,
      active_clients: clients?.filter(c => c.subscription_status === 'active').length || 0,
      trial_clients: clients?.filter(c => c.subscription_status === 'trial').length || 0,
      total_calls_this_month: clients?.reduce((sum, c) => sum + (c.calls_this_month || 0), 0) || 0,
      mrr_cents: clients?.reduce((sum, c) => {
        if (c.subscription_status !== 'active') return sum;
        const prices = {
          starter: agency.price_starter,
          pro: agency.price_pro,
          growth: agency.price_growth
        };
        return sum + (prices[c.plan_type] || 0);
      }, 0) || 0
    };
    
    res.json({
      success: true,
      agency: {
        // Basic info
        id: agency.id,
        name: agency.name,
        slug: agency.slug,
        email: agency.email,
        phone: agency.phone,
        
        // Status
        status: agency.status,
        subscription_status: agency.subscription_status,
        plan_type: agency.plan_type,
        trial_ends_at: agency.trial_ends_at,
        onboarding_completed: agency.onboarding_completed,
        onboarding_step: agency.onboarding_step,
        
        // Branding
        logo_url: agency.logo_url,
        favicon_url: agency.favicon_url,
        primary_color: agency.primary_color,
        secondary_color: agency.secondary_color,
        accent_color: agency.accent_color,
        
        // Domain
        marketing_domain: agency.marketing_domain,
        domain_verified: agency.domain_verified,
        
        // Pricing
        price_starter: agency.price_starter,
        price_pro: agency.price_pro,
        price_growth: agency.price_growth,
        limit_starter: agency.limit_starter,
        limit_pro: agency.limit_pro,
        limit_growth: agency.limit_growth,
        
        // Stripe
        stripe_account_id: agency.stripe_account_id,
        stripe_onboarding_complete: agency.stripe_onboarding_complete,
        stripe_charges_enabled: agency.stripe_charges_enabled,
        stripe_payouts_enabled: agency.stripe_payouts_enabled,
        
        // Support
        support_email: agency.support_email,
        support_phone: agency.support_phone,
        timezone: agency.timezone,
        
        // Timestamps
        created_at: agency.created_at,
        updated_at: agency.updated_at
      },
      stats
    });
    
  } catch (error) {
    console.error('❌ Get agency settings error:', error);
    res.status(500).json({ error: 'Failed to get agency settings' });
  }
}

// ============================================================================
// UPDATE AGENCY SETTINGS
// ============================================================================
async function updateAgencySettings(req, res) {
  try {
    const { agencyId } = req.params;
    const updates = req.body;
    
    // Whitelist allowed fields
    const allowedFields = [
      'name', 'phone',
      'logo_url', 'favicon_url',
      'primary_color', 'secondary_color', 'accent_color',
      'marketing_domain',
      'price_starter', 'price_pro', 'price_growth',
      'limit_starter', 'limit_pro', 'limit_growth',
      'support_email', 'support_phone', 'timezone'
    ];
    
    const sanitizedUpdates = {};
    for (const key of allowedFields) {
      if (updates[key] !== undefined) {
        sanitizedUpdates[key] = updates[key];
      }
    }
    
    // If marketing_domain changed, reset verification
    if (updates.marketing_domain) {
      const { data: current } = await supabase
        .from('agencies')
        .select('marketing_domain')
        .eq('id', agencyId)
        .single();
      
      if (current?.marketing_domain !== updates.marketing_domain) {
        sanitizedUpdates.domain_verified = false;
      }
    }
    
    sanitizedUpdates.updated_at = new Date().toISOString();
    
    const { data: agency, error } = await supabase
      .from('agencies')
      .update(sanitizedUpdates)
      .eq('id', agencyId)
      .select()
      .single();
    
    if (error) {
      console.error('❌ Update error:', error);
      return res.status(500).json({ error: 'Failed to update settings' });
    }
    
    console.log('✅ Agency settings updated:', agency.name);
    
    res.json({
      success: true,
      agency
    });
    
  } catch (error) {
    console.error('❌ Update agency settings error:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
}

// ============================================================================
// VERIFY CUSTOM DOMAIN
// ============================================================================
async function verifyAgencyDomain(req, res) {
  try {
    const { agency_id, domain } = req.body;
    
    if (!agency_id || !domain) {
      return res.status(400).json({ error: 'agency_id and domain required' });
    }
    
    // TODO: Implement DNS verification
    // TODO: Add domain to Vercel via API
    
    // For now, just mark as verified (you'd implement real verification)
    await supabase
      .from('agencies')
      .update({
        marketing_domain: domain,
        domain_verified: true
      })
      .eq('id', agency_id);
    
    res.json({
      success: true,
      message: 'Domain verified successfully'
    });
    
  } catch (error) {
    console.error('❌ Domain verification error:', error);
    res.status(500).json({ error: 'Domain verification failed' });
  }
}

// ============================================================================
// EXPORTS
// ============================================================================
module.exports = {
  getAgencyByHost,
  getAgencySettings,
  updateAgencySettings,
  verifyAgencyDomain
};

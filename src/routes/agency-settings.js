// ============================================================================
// AGENCY SETTINGS
// WITH BYOT STATUS IN SETTINGS RESPONSE
// UPDATED: Added branding_overrides support for UI theme customization
// UPDATED: Added calendar_enabled_plans for Google Calendar plan gating
// Destination: src/routes/agency-settings.js (REPLACE existing)
// ============================================================================
const dns = require('dns').promises;
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
    
    // Check if it's a subdomain of myvoiceaiconnect.com
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
    
    // Return public agency info (for branding + marketing website)
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
        
        // Marketing website content
        company_tagline: agency.company_tagline,
        website_headline: agency.website_headline,
        website_subheadline: agency.website_subheadline,
        marketing_config: agency.marketing_config,
        
        // Theme settings
        website_theme: agency.website_theme,
        logo_background_color: agency.logo_background_color,
        
        // Dashboard branding overrides (nav, bg, card, button colors)
        branding_overrides: agency.branding_overrides || null,
        
        // Plan type (for feature gating)
        plan_type: agency.plan_type,
        
        // Pricing (for client signup + marketing website)
        price_starter: agency.price_starter,
        price_pro: agency.price_pro,
        price_growth: agency.price_growth,
        
        // Limits
        limit_starter: agency.limit_starter,
        limit_pro: agency.limit_pro,
        limit_growth: agency.limit_growth,
        
        // Client plan features (for dynamic plan cards on signup)
        plan_features: agency.plan_features || null,
        
        // Demo phone (auto-provisioned per agency via VAPI)
        demo_phone_number: agency.demo_phone_number || null,
        // Legacy manual override field
        demo_phone: agency.demo_phone || null,
        
        // Currency (for marketing page pricing display)
        currency: agency.currency || 'USD',
        display_currency: agency.display_currency || null,
        
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
        
        // Marketing website content
        company_tagline: agency.company_tagline,
        website_headline: agency.website_headline,
        website_subheadline: agency.website_subheadline,
        marketing_config: agency.marketing_config,
        
        // Theme settings
        website_theme: agency.website_theme,
        logo_background_color: agency.logo_background_color,
        
        // Dashboard branding overrides (nav, bg, card, button colors)
        branding_overrides: agency.branding_overrides || null,
        
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
        
        // Client plan feature gating
        plan_features: agency.plan_features || null,
        
        // Calendar plan gating (which client plans can use Google Calendar)
        calendar_enabled_plans: agency.calendar_enabled_plans || ['pro', 'growth'],
        
        // Demo phone (auto-provisioned per agency via VAPI)
        demo_phone_number: agency.demo_phone_number || null,
        demo_assistant_id: agency.demo_assistant_id || null,
        demo_vapi_phone_id: agency.demo_vapi_phone_id || null,
        
        // Stripe
        stripe_account_id: agency.stripe_account_id,
        stripe_customer_id: agency.stripe_customer_id,
        stripe_subscription_id: agency.stripe_subscription_id,
        stripe_onboarding_complete: agency.stripe_onboarding_complete,
        stripe_charges_enabled: agency.stripe_charges_enabled,
        stripe_payouts_enabled: agency.stripe_payouts_enabled,
        
        // Support
        support_email: agency.support_email,
        support_phone: agency.support_phone,
        timezone: agency.timezone,
        
        // International / BYOT
        country: agency.country || 'US',
        currency: agency.currency || 'USD',
        display_currency: agency.display_currency || null,
        byot_enabled: agency.byot_enabled || false,
        byot_verified_at: agency.byot_verified_at || null,
        twilio_account_sid: agency.twilio_account_sid || null,
        
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
      'marketing_domain', 'domain_verified',
      'price_starter', 'price_pro', 'price_growth',
      'limit_starter', 'limit_pro', 'limit_growth',
      'support_email', 'support_phone', 'timezone',
      // Marketing website content fields
      'company_tagline',
      'website_headline',
      'website_subheadline',
      'marketing_config',
      // Theme settings
      'website_theme',
      'logo_background_color',
      // Dashboard branding overrides (nav, bg, card, button colors)
      'branding_overrides',
      // Client plan feature gating
      'plan_features',
      // Calendar plan gating (which client plans can connect Google Calendar)
      'calendar_enabled_plans',
      // Marketing page currency override
      'display_currency'
    ];
    
    const sanitizedUpdates = {};
    for (const key of allowedFields) {
      if (updates[key] !== undefined) {
        sanitizedUpdates[key] = updates[key];
      }
    }
    
    // Validate branding_overrides structure if provided
    if (sanitizedUpdates.branding_overrides !== undefined) {
      const bo = sanitizedUpdates.branding_overrides;
      // Allow null (reset to defaults)
      if (bo !== null) {
        if (typeof bo !== 'object' || Array.isArray(bo)) {
          return res.status(400).json({ error: 'branding_overrides must be an object or null' });
        }
        const validKeys = [
          'nav_bg', 'nav_text', 'page_bg', 'card_bg', 'card_border',
          'button_text', 'text_primary', 'text_muted'
        ];
        // Strip any invalid keys
        const cleaned = {};
        for (const key of validKeys) {
          if (bo[key] !== undefined && bo[key] !== null) {
            // Validate hex color format
            if (typeof bo[key] === 'string' && /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(bo[key])) {
              cleaned[key] = bo[key];
            }
          }
        }
        // If all values were stripped, store null instead of empty object
        sanitizedUpdates.branding_overrides = Object.keys(cleaned).length > 0 ? cleaned : null;
      }
    }
    
    // Validate display_currency if provided
    if (sanitizedUpdates.display_currency !== undefined) {
      const validCurrencies = [
        null, 'USD', 'GBP', 'EUR', 'CAD', 'AUD', 'NZD', 'JPY', 'CHF',
        'SGD', 'HKD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON',
        'BGN', 'BRL', 'MXN', 'INR', 'THB', 'MYR', 'AED'
      ];
      if (sanitizedUpdates.display_currency !== null && !validCurrencies.includes(sanitizedUpdates.display_currency)) {
        return res.status(400).json({ error: 'Invalid display_currency value' });
      }
    }
    
    // Validate plan_features structure if provided
    if (sanitizedUpdates.plan_features) {
      const pf = sanitizedUpdates.plan_features;
      const validPlans = ['starter', 'pro', 'growth'];
      const validFeatures = [
        'sms_notifications', 'email_summaries', 'custom_greeting',
        'custom_voice', 'knowledge_base', 'business_hours',
        'google_calendar',
        'advanced_analytics', 'priority_support'
      ];
      
      let isValid = true;
      for (const plan of validPlans) {
        if (!pf[plan] || typeof pf[plan] !== 'object') {
          isValid = false;
          break;
        }
        // Only validate known features, allow extra keys to be flexible
        for (const feature of Object.keys(pf[plan])) {
          if (typeof pf[plan][feature] !== 'boolean') {
            isValid = false;
            break;
          }
        }
        if (!isValid) break;
      }
      
      if (!isValid) {
        return res.status(400).json({ error: 'Invalid plan_features structure' });
      }
    }
    
    // Validate calendar_enabled_plans if provided
    if (sanitizedUpdates.calendar_enabled_plans !== undefined) {
      const cep = sanitizedUpdates.calendar_enabled_plans;
      if (!Array.isArray(cep)) {
        return res.status(400).json({ error: 'calendar_enabled_plans must be an array' });
      }
      const validPlans = ['starter', 'pro', 'growth'];
      const allValid = cep.every(plan => validPlans.includes(plan));
      if (!allValid) {
        return res.status(400).json({ error: 'calendar_enabled_plans contains invalid plan names' });
      }
    }
    
    // If marketing_domain changed, reset verification
    if (updates.marketing_domain !== undefined) {
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
// VERIFY CUSTOM DOMAIN (DNS Check)
// ============================================================================
async function verifyAgencyDomain(req, res) {
  try {
    const { agencyId } = req.params;
    
    const { data: agency, error } = await supabase
      .from('agencies')
      .select('marketing_domain')
      .eq('id', agencyId)
      .single();
    
    if (error || !agency?.marketing_domain) {
      return res.status(404).json({ 
        verified: false, 
        error: 'No custom domain configured' 
      });
    }
    
    const domain = agency.marketing_domain;
    const platformDomain = process.env.PLATFORM_DOMAIN || 'myvoiceaiconnect.com';
    const expectedCname = `cname.${platformDomain}`;
    
    console.log(`🔍 Verifying domain: ${domain}, expecting CNAME to: ${expectedCname}`);
    
    try {
      const records = await dns.resolveCname(domain);
      console.log(`📋 CNAME records found:`, records);
      
      const verified = records.some(record => 
        record.toLowerCase() === expectedCname.toLowerCase() ||
        record.toLowerCase().endsWith(`.${platformDomain.toLowerCase()}`) ||
        record.toLowerCase().includes('vercel')
      );
      
      if (verified) {
        await supabase
          .from('agencies')
          .update({ domain_verified: true, updated_at: new Date().toISOString() })
          .eq('id', agencyId);
        
        console.log(`✅ Domain verified: ${domain}`);
        
        return res.json({ 
          verified: true, 
          message: 'Domain verified successfully',
          cname_found: records[0]
        });
      } else {
        return res.json({ 
          verified: false, 
          message: `CNAME found but points to "${records[0]}", expected "${expectedCname}"`,
          cname_found: records[0],
          expected: expectedCname
        });
      }
    } catch (dnsError) {
      console.log(`⚠️ DNS lookup error for ${domain}:`, dnsError.code);
      
      try {
        const aRecords = await dns.resolve4(domain);
        console.log(`📋 A records found:`, aRecords);
        
        const vercelIps = ['76.76.21.21', '76.76.21.22', '76.76.21.93'];
        const hasVercelIp = aRecords.some(ip => vercelIps.includes(ip) || ip.startsWith('76.76.'));
        
        if (hasVercelIp) {
          await supabase
            .from('agencies')
            .update({ domain_verified: true, updated_at: new Date().toISOString() })
            .eq('id', agencyId);
          
          console.log(`✅ Domain verified via A record: ${domain}`);
          
          return res.json({
            verified: true,
            message: 'Domain verified via A record',
            a_record: aRecords[0]
          });
        }
      } catch (aError) {
        // No A records either
      }
      
      return res.json({ 
        verified: false, 
        message: 'DNS records not found. Changes can take up to 48 hours to propagate.',
        expected_cname: expectedCname,
        dns_error: dnsError.code
      });
    }
  } catch (error) {
    console.error('❌ Domain verification error:', error);
    return res.status(500).json({ 
      verified: false, 
      error: 'Failed to verify domain' 
    });
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
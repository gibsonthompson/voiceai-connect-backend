// ============================================================================
// AGENCY SETTINGS
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
        
        // Pricing (for client signup + marketing website)
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
        
        // Marketing website content
        company_tagline: agency.company_tagline,
        website_headline: agency.website_headline,
        website_subheadline: agency.website_subheadline,
        marketing_config: agency.marketing_config,
        
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
      'marketing_domain', 'domain_verified',
      'price_starter', 'price_pro', 'price_growth',
      'limit_starter', 'limit_pro', 'limit_growth',
      'support_email', 'support_phone', 'timezone',
      // Marketing website content fields
      'company_tagline',
      'website_headline',
      'website_subheadline',
      'marketing_config'
    ];
    
    const sanitizedUpdates = {};
    for (const key of allowedFields) {
      if (updates[key] !== undefined) {
        sanitizedUpdates[key] = updates[key];
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
    
    // Get agency's custom domain
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
      // Look up CNAME records
      const records = await dns.resolveCname(domain);
      console.log(`📋 CNAME records found:`, records);
      
      // Check if any CNAME points to our expected value
      const verified = records.some(record => 
        record.toLowerCase() === expectedCname.toLowerCase() ||
        record.toLowerCase().endsWith(`.${platformDomain.toLowerCase()}`) ||
        record.toLowerCase().includes('vercel')
      );
      
      if (verified) {
        // Update database to mark as verified
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
      // CNAME not found or DNS error
      console.log(`⚠️ DNS lookup error for ${domain}:`, dnsError.code);
      
      // Try A record as fallback (some setups use A records)
      try {
        const aRecords = await dns.resolve4(domain);
        console.log(`📋 A records found:`, aRecords);
        
        // Vercel IP ranges (approximate)
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
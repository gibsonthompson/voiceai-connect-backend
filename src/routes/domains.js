// ============================================================================
// DOMAIN MANAGEMENT ROUTES
// VoiceAI Connect - Automated Vercel Domain Provisioning
// ============================================================================
const express = require('express');
const router = express.Router();

let supabase;
try {
  const supabaseModule = require('../lib/supabase');
  supabase = supabaseModule.supabase;
  console.log('✅ Domain routes: Supabase loaded');
} catch (err) {
  console.error('❌ Domain routes: Failed to load supabase:', err.message);
}

// Log when this file is loaded
console.log('📁 Domain routes file loaded');

// ============================================================================
// EXPLICIT OPTIONS HANDLERS (for CORS preflight)
// ============================================================================

// Simple test endpoint to verify routes are loaded
router.get('/test', (req, res) => {
  res.json({ 
    ok: true, 
    message: 'Domain routes are loaded and working',
    timestamp: new Date().toISOString(),
    supabaseLoaded: !!supabase,
    hasVercelToken: !!process.env.VERCEL_API_TOKEN,
    hasProjectId: !!process.env.VERCEL_PROJECT_ID,
  });
});

router.options('/:agencyId/domain', (req, res) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.sendStatus(200);
});

router.options('/:agencyId/domain/status', (req, res) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.sendStatus(200);
});

router.options('/:agencyId/domain/verify', (req, res) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.sendStatus(200);
});

router.options('/dns-config', (req, res) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.sendStatus(200);
});

// ============================================================================
// CONFIGURATION
// ============================================================================
const VERCEL_API = 'https://api.vercel.com';
const VERCEL_TOKEN = process.env.VERCEL_API_TOKEN || process.env.VERCEL_TOKEN;
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID; // Optional, for team accounts

// Default DNS Configuration (fallback only - prefer fetching from Vercel)
const DEFAULT_DNS_CONFIG = {
  aRecord: '76.76.21.21',
  cnameRecord: 'cname.vercel-dns.com',
};

console.log('📡 Domain routes loaded with config:', {
  hasVercelToken: !!VERCEL_TOKEN,
  tokenPrefix: VERCEL_TOKEN ? VERCEL_TOKEN.substring(0, 10) + '...' : 'none',
  hasProjectId: !!VERCEL_PROJECT_ID,
  projectId: VERCEL_PROJECT_ID || 'not set',
  hasTeamId: !!VERCEL_TEAM_ID,
});

// ============================================================================
// HELPER: Make Vercel API Request
// ============================================================================
async function vercelRequest(method, endpoint, body = null) {
  // Build URL with team parameter if present
  const separator = endpoint.includes('?') ? '&' : '?';
  const teamParam = VERCEL_TEAM_ID ? `${separator}teamId=${VERCEL_TEAM_ID}` : '';
  const url = `${VERCEL_API}${endpoint}${teamParam}`;
  
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${VERCEL_TOKEN}`,
      'Content-Type': 'application/json',
    },
  };
  
  if (body) {
    options.body = JSON.stringify(body);
  }
  
  console.log(`🔗 Vercel API: ${method} ${url}`);
  
  const response = await fetch(url, options);
  const data = await response.json();
  
  console.log(`📥 Vercel API Response (${response.status}):`, JSON.stringify(data, null, 2));
  
  if (!response.ok) {
    console.error(`❌ Vercel API Error:`, data);
    throw new Error(data.error?.message || data.error?.code || `Vercel API error: ${response.status}`);
  }
  
  return data;
}

// ============================================================================
// HELPER: Fetch Project-Specific DNS Values from Vercel
// CRITICAL: Using generic 76.76.21.21 causes SSL certificate issues!
// The /v6/domains/{domain}/config endpoint returns project-specific values
// ============================================================================
async function fetchVercelDnsConfig(domain) {
  if (!VERCEL_TOKEN) {
    console.log('⚠️ No Vercel token, using default DNS values');
    return DEFAULT_DNS_CONFIG;
  }

  try {
    // The /v6/domains/{domain}/config endpoint returns:
    // - recommendedIPv4: [{ rank: 1, value: ["216.198.79.1"] }]
    // - recommendedCNAME: [{ rank: 1, value: "52f2ec7ccc7d7f3b.vercel-dns-017.com" }]
    const teamParam = VERCEL_TEAM_ID ? `?teamId=${VERCEL_TEAM_ID}` : '';
    const configUrl = `${VERCEL_API}/v6/domains/${domain}/config${teamParam}`;
    
    console.log(`🔍 Fetching DNS config from: ${configUrl}`);
    
    const response = await fetch(configUrl, {
      headers: { 'Authorization': `Bearer ${VERCEL_TOKEN}` }
    });

    const data = await response.json();
    console.log('📋 Vercel DNS config response:', JSON.stringify(data, null, 2));

    if (!response.ok) {
      console.log(`⚠️ Config endpoint returned ${response.status}: ${data.error?.message || 'Unknown error'}`);
      return DEFAULT_DNS_CONFIG;
    }

    // Extract the rank=1 (preferred) values
    let aRecord = DEFAULT_DNS_CONFIG.aRecord;
    let cnameRecord = DEFAULT_DNS_CONFIG.cnameRecord;

    // recommendedIPv4 format: [{ rank: 1, value: ["216.198.79.1"] }]
    if (data.recommendedIPv4 && Array.isArray(data.recommendedIPv4)) {
      const preferred = data.recommendedIPv4.find(r => r.rank === 1);
      if (preferred?.value?.[0]) {
        aRecord = preferred.value[0];
        console.log(`✅ Found project-specific A record: ${aRecord}`);
      }
    }

    // recommendedCNAME format: [{ rank: 1, value: "52f2ec7ccc7d7f3b.vercel-dns-017.com" }]
    if (data.recommendedCNAME && Array.isArray(data.recommendedCNAME)) {
      const preferred = data.recommendedCNAME.find(r => r.rank === 1);
      if (preferred?.value) {
        cnameRecord = preferred.value;
        console.log(`✅ Found project-specific CNAME: ${cnameRecord}`);
      }
    }

    return { 
      aRecord, 
      cnameRecord, 
      misconfigured: data.misconfigured,
      source: aRecord !== DEFAULT_DNS_CONFIG.aRecord ? 'vercel-api' : 'fallback'
    };

  } catch (error) {
    console.error('❌ Failed to fetch Vercel DNS config:', error);
    return DEFAULT_DNS_CONFIG;
  }
}

// ============================================================================
// GET /dns-config
// Get DNS configuration for UI display
// If domain is provided, fetches project-specific values from Vercel
// ============================================================================
router.get('/dns-config', async (req, res) => {
  const { domain } = req.query;
  console.log('📋 DNS config requested', domain ? `for domain: ${domain}` : '(no domain)');
  
  let config = { ...DEFAULT_DNS_CONFIG, source: 'fallback' };
  
  // If a domain is provided, try to get project-specific values
  if (domain && VERCEL_TOKEN) {
    const vercelConfig = await fetchVercelDnsConfig(domain);
    config = {
      aRecord: vercelConfig.aRecord,
      cnameRecord: vercelConfig.cnameRecord,
      source: vercelConfig.source || (vercelConfig.aRecord !== DEFAULT_DNS_CONFIG.aRecord ? 'vercel-api' : 'fallback'),
      misconfigured: vercelConfig.misconfigured,
    };
  }
  
  console.log(`📤 Returning DNS config: A=${config.aRecord}, CNAME=${config.cnameRecord}, source=${config.source}`);
  
  res.json({
    a_record: config.aRecord,
    cname_record: config.cnameRecord,
    source: config.source,
    misconfigured: config.misconfigured,
    instructions: {
      apex: `Point your A record (@) to ${config.aRecord}`,
      www: `Point your CNAME (www) to ${config.cnameRecord}`
    }
  });
});

// ============================================================================
// POST /:agencyId/domain
// Add a custom domain to an agency (and provision on Vercel)
// ============================================================================
router.post('/:agencyId/domain', async (req, res) => {
  const { agencyId } = req.params;
  console.log(`\n🌐 ===== ADD DOMAIN REQUEST =====`);
  console.log(`   Agency ID: ${agencyId}`);
  console.log(`   Body:`, req.body);
  console.log(`   Vercel Config: token=${!!VERCEL_TOKEN}, projectId=${VERCEL_PROJECT_ID || 'not set'}`);
  
  try {
    const { domain } = req.body;
    
    if (!domain) {
      console.log(`   ❌ No domain provided`);
      return res.status(400).json({ error: 'Domain is required' });
    }
    
    // Normalize domain (lowercase, no protocol, no trailing slash, no www)
    let normalizedDomain = domain
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/$/, '')
      .trim();
    
    console.log(`   📝 Normalized domain: ${normalizedDomain}`);
    
    // Validate domain format
    const domainRegex = /^[a-z0-9]+([\-\.]{1}[a-z0-9]+)*\.[a-z]{2,}$/;
    if (!domainRegex.test(normalizedDomain)) {
      console.log(`   ❌ Invalid domain format`);
      return res.status(400).json({ error: 'Invalid domain format' });
    }
    
    // Check if domain is already used by another agency
    const { data: existing, error: checkError } = await supabase
      .from('agencies')
      .select('id, name')
      .eq('marketing_domain', normalizedDomain)
      .neq('id', agencyId)
      .maybeSingle();
    
    if (checkError) {
      console.log(`   ❌ Database check error:`, checkError);
    }
    
    if (existing) {
      console.log(`   ❌ Domain already in use by agency: ${existing.name}`);
      return res.status(400).json({ 
        error: 'Domain is already in use by another agency' 
      });
    }
    
    // Step 1: Add BOTH apex and www domains to Vercel project
    let vercelApexResponse = null;
    let vercelWwwResponse = null;
    let vercelError = null;
    
    if (VERCEL_TOKEN && VERCEL_PROJECT_ID) {
      console.log(`   🔄 Adding to Vercel project: ${VERCEL_PROJECT_ID}`);
      
      // Add apex domain (example.com)
      try {
        vercelApexResponse = await vercelRequest(
          'POST',
          `/v10/projects/${VERCEL_PROJECT_ID}/domains`,
          { name: normalizedDomain }
        );
        console.log(`   ✅ Apex domain added to Vercel: ${vercelApexResponse.name}`);
      } catch (err) {
        if (err.message.includes('already') || err.message.includes('exists') || err.message.includes('DOMAIN_ALREADY_EXISTS')) {
          console.log(`   ℹ️ Apex domain already exists on Vercel, continuing...`);
        } else {
          vercelError = err.message;
          console.log(`   ⚠️ Vercel apex domain error (non-fatal):`, err.message);
        }
      }
      
      // Add www subdomain (www.example.com)
      try {
        vercelWwwResponse = await vercelRequest(
          'POST',
          `/v10/projects/${VERCEL_PROJECT_ID}/domains`,
          { name: `www.${normalizedDomain}` }
        );
        console.log(`   ✅ WWW domain added to Vercel: ${vercelWwwResponse.name}`);
      } catch (err) {
        if (err.message.includes('already') || err.message.includes('exists') || err.message.includes('DOMAIN_ALREADY_EXISTS')) {
          console.log(`   ℹ️ WWW domain already exists on Vercel, continuing...`);
        } else {
          console.log(`   ⚠️ Vercel www domain error (non-fatal):`, err.message);
        }
      }
    } else {
      console.log(`   ⚠️ Vercel credentials not configured!`);
      console.log(`      VERCEL_TOKEN: ${VERCEL_TOKEN ? 'SET' : 'MISSING'}`);
      console.log(`      VERCEL_PROJECT_ID: ${VERCEL_PROJECT_ID || 'MISSING'}`);
    }
    
    // Step 2: Fetch PROJECT-SPECIFIC DNS values from Vercel
    // CRITICAL: This must happen AFTER adding the domain to Vercel
    console.log(`   🔍 Fetching project-specific DNS values...`);
    const dnsConfig = await fetchVercelDnsConfig(normalizedDomain);
    console.log(`   📋 DNS Config: A=${dnsConfig.aRecord}, CNAME=${dnsConfig.cnameRecord}, source=${dnsConfig.source || 'unknown'}`);
    
    // Step 3: Update agency in database
    console.log(`   💾 Updating database...`);
    const { data: agency, error: dbError } = await supabase
      .from('agencies')
      .update({
        marketing_domain: normalizedDomain,
        domain_verified: false,
        updated_at: new Date().toISOString()
      })
      .eq('id', agencyId)
      .select()
      .single();
    
    if (dbError) {
      console.log(`   ❌ Database error:`, dbError);
      return res.status(500).json({ error: 'Failed to save domain: ' + dbError.message });
    }
    
    if (!agency) {
      console.log(`   ❌ Agency not found`);
      return res.status(404).json({ error: 'Agency not found' });
    }
    
    // Build DNS instructions with PROJECT-SPECIFIC values
    const dnsInstructions = {
      primary: {
        type: 'A',
        name: '@',
        value: dnsConfig.aRecord,
        description: 'Points your root domain to our servers'
      },
      secondary: {
        type: 'CNAME',
        name: 'www',
        value: dnsConfig.cnameRecord,
        description: 'Redirects www to your root domain'
      }
    };
    
    console.log(`   ✅ Domain configured successfully: ${normalizedDomain}`);
    console.log(`   📋 DNS Instructions: A=${dnsConfig.aRecord}, CNAME=${dnsConfig.cnameRecord}`);
    
    res.json({
      success: true,
      domain: normalizedDomain,
      vercel_added: !!(vercelApexResponse || vercelWwwResponse),
      vercel_error: vercelError,
      dns_instructions: dnsInstructions,
      dns_config: {
        a_record: dnsConfig.aRecord,
        cname_record: dnsConfig.cnameRecord,
        source: dnsConfig.source || (dnsConfig.aRecord !== DEFAULT_DNS_CONFIG.aRecord ? 'vercel-api' : 'fallback')
      },
      verification: vercelApexResponse?.verification || null
    });
    
  } catch (error) {
    console.error(`   ❌ Unexpected error:`, error);
    res.status(500).json({ error: 'Failed to add domain: ' + error.message });
  }
});

// ============================================================================
// GET /:agencyId/domain/status
// Check domain configuration status (from Vercel)
// ============================================================================
router.get('/:agencyId/domain/status', async (req, res) => {
  const { agencyId } = req.params;
  console.log(`\n🔍 ===== DOMAIN STATUS REQUEST =====`);
  console.log(`   Agency ID: ${agencyId}`);
  
  try {
    // Get agency's domain
    const { data: agency, error } = await supabase
      .from('agencies')
      .select('marketing_domain, domain_verified')
      .eq('id', agencyId)
      .single();
    
    if (error || !agency?.marketing_domain) {
      return res.json({ 
        configured: false,
        message: 'No custom domain configured'
      });
    }
    
    const domain = agency.marketing_domain;
    console.log(`   Domain: ${domain}`);
    
    // Check status from Vercel
    let vercelStatus = null;
    if (VERCEL_TOKEN && VERCEL_PROJECT_ID) {
      try {
        vercelStatus = await vercelRequest(
          'GET',
          `/v9/projects/${VERCEL_PROJECT_ID}/domains/${domain}`
        );
        console.log(`   Vercel status:`, vercelStatus?.verified);
      } catch (err) {
        console.log(`   ⚠️ Could not fetch Vercel status:`, err.message);
      }
    }
    
    // Fetch project-specific DNS values
    const dnsConfig = await fetchVercelDnsConfig(domain);
    
    res.json({
      configured: true,
      domain,
      verified: agency.domain_verified,
      vercel_verified: vercelStatus?.verified || false,
      vercel_status: vercelStatus,
      dns_instructions: {
        a_record: {
          type: 'A',
          name: '@',
          value: dnsConfig.aRecord
        },
        cname_record: {
          type: 'CNAME',
          name: 'www',
          value: dnsConfig.cnameRecord
        }
      }
    });
    
  } catch (error) {
    console.error(`   ❌ Error:`, error);
    res.status(500).json({ error: 'Failed to check domain status' });
  }
});

// ============================================================================
// POST /:agencyId/domain/verify
// Verify domain configuration (checks DNS + Vercel)
// ============================================================================
router.post('/:agencyId/domain/verify', async (req, res) => {
  const { agencyId } = req.params;
  console.log(`\n✅ ===== VERIFY DOMAIN REQUEST =====`);
  console.log(`   Agency ID: ${agencyId}`);
  
  try {
    // Get agency's domain
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
    console.log(`   Verifying domain: ${domain}`);
    
    // Fetch the expected DNS values from Vercel
    const dnsConfig = await fetchVercelDnsConfig(domain);
    console.log(`   Expected A record: ${dnsConfig.aRecord}`);
    console.log(`   Expected CNAME: ${dnsConfig.cnameRecord}`);
    
    // Step 1: Try to verify on Vercel
    let vercelVerified = false;
    if (VERCEL_TOKEN && VERCEL_PROJECT_ID) {
      try {
        const vercelResult = await vercelRequest(
          'POST',
          `/v9/projects/${VERCEL_PROJECT_ID}/domains/${domain}/verify`
        );
        vercelVerified = vercelResult.verified === true;
        console.log(`   📋 Vercel verification:`, vercelVerified);
      } catch (err) {
        console.log(`   ⚠️ Vercel verification failed:`, err.message);
      }
    }
    
    // Step 2: Do our own DNS check as backup
    const dns = require('dns').promises;
    let dnsVerified = false;
    let dnsDetails = {};
    
    try {
      // Check for A record (apex domains)
      const aRecords = await dns.resolve4(domain);
      dnsDetails.a_records = aRecords;
      console.log(`   A records found:`, aRecords);
      // Check if it matches the expected project-specific IP
      if (aRecords.includes(dnsConfig.aRecord)) {
        dnsVerified = true;
        console.log(`   ✅ A record matches expected value`);
      } else {
        console.log(`   ⚠️ A record doesn't match. Expected: ${dnsConfig.aRecord}, Found: ${aRecords.join(', ')}`);
      }
    } catch (e) {
      console.log(`   No A record found for apex domain`);
    }
    
    if (!dnsVerified) {
      try {
        const cnameRecords = await dns.resolveCname(domain);
        dnsDetails.cname_records = cnameRecords;
        console.log(`   CNAME records found:`, cnameRecords);
        if (cnameRecords.some(r => r.toLowerCase().includes('vercel'))) {
          dnsVerified = true;
        }
      } catch (e) {
        console.log(`   No CNAME record found for apex domain`);
      }
    }
    
    // Consider verified if either Vercel or DNS check passes
    const isVerified = vercelVerified || dnsVerified;
    
    // Update database
    if (isVerified) {
      await supabase
        .from('agencies')
        .update({ 
          domain_verified: true,
          updated_at: new Date().toISOString()
        })
        .eq('id', agencyId);
      
      console.log(`   ✅ Domain verified: ${domain}`);
    } else {
      console.log(`   ⏳ Domain not yet verified`);
    }
    
    res.json({
      verified: isVerified,
      vercel_verified: vercelVerified,
      dns_verified: dnsVerified,
      dns_details: dnsDetails,
      expected_a_record: dnsConfig.aRecord,
      expected_cname: dnsConfig.cnameRecord,
      message: isVerified 
        ? 'Domain verified successfully!'
        : `DNS records not found. Please set your A record to ${dnsConfig.aRecord} and CNAME (www) to ${dnsConfig.cnameRecord}. Allow up to 48 hours for propagation.`
    });
    
  } catch (error) {
    console.error(`   ❌ Error:`, error);
    res.status(500).json({ 
      verified: false,
      error: 'Verification failed: ' + error.message
    });
  }
});

// ============================================================================
// DELETE /:agencyId/domain
// Remove custom domain from agency (and Vercel)
// ============================================================================
router.delete('/:agencyId/domain', async (req, res) => {
  const { agencyId } = req.params;
  console.log(`\n🗑️ ===== REMOVE DOMAIN REQUEST =====`);
  console.log(`   Agency ID: ${agencyId}`);
  
  try {
    // Get current domain
    const { data: agency, error } = await supabase
      .from('agencies')
      .select('marketing_domain')
      .eq('id', agencyId)
      .single();
    
    if (error || !agency?.marketing_domain) {
      return res.status(404).json({ error: 'No domain to remove' });
    }
    
    const domain = agency.marketing_domain;
    console.log(`   Removing domain: ${domain}`);
    
    // Step 1: Remove BOTH apex and www from Vercel
    if (VERCEL_TOKEN && VERCEL_PROJECT_ID) {
      // Remove apex
      try {
        await vercelRequest(
          'DELETE',
          `/v9/projects/${VERCEL_PROJECT_ID}/domains/${domain}`
        );
        console.log(`   ✅ Apex domain removed from Vercel`);
      } catch (err) {
        console.log(`   ⚠️ Could not remove apex from Vercel:`, err.message);
      }
      
      // Remove www
      try {
        await vercelRequest(
          'DELETE',
          `/v9/projects/${VERCEL_PROJECT_ID}/domains/www.${domain}`
        );
        console.log(`   ✅ WWW domain removed from Vercel`);
      } catch (err) {
        console.log(`   ⚠️ Could not remove www from Vercel:`, err.message);
      }
    }
    
    // Step 2: Update database
    const { error: dbError } = await supabase
      .from('agencies')
      .update({
        marketing_domain: null,
        domain_verified: false,
        updated_at: new Date().toISOString()
      })
      .eq('id', agencyId);
    
    if (dbError) {
      return res.status(500).json({ error: 'Failed to remove domain' });
    }
    
    console.log(`   ✅ Domain removed: ${domain}`);
    res.json({ success: true, removed_domain: domain });
    
  } catch (error) {
    console.error(`   ❌ Error:`, error);
    res.status(500).json({ error: 'Failed to remove domain: ' + error.message });
  }
});

module.exports = router;
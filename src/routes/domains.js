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
    supabaseLoaded: !!supabase
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
  hasProjectId: !!VERCEL_PROJECT_ID,
  hasTeamId: !!VERCEL_TEAM_ID,
});

// ============================================================================
// HELPER: Make Vercel API Request
// ============================================================================
async function vercelRequest(method, endpoint, body = null) {
  const teamParam = VERCEL_TEAM_ID ? `?teamId=${VERCEL_TEAM_ID}` : '';
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
  
  console.log(`🔗 Vercel API: ${method} ${endpoint}`);
  
  const response = await fetch(url, options);
  const data = await response.json();
  
  if (!response.ok) {
    console.error(`❌ Vercel API Error:`, data);
    throw new Error(data.error?.message || data.error?.code || 'Vercel API error');
  }
  
  return data;
}

// ============================================================================
// HELPER: Fetch Project-Specific DNS Values from Vercel
// This is CRITICAL - using generic 76.76.21.21 causes SSL issues!
// ============================================================================
async function fetchVercelDnsConfig(domain) {
  if (!VERCEL_TOKEN) {
    console.log('⚠️ No Vercel token, using default DNS values');
    return DEFAULT_DNS_CONFIG;
  }

  try {
    // The /v6/domains/{domain}/config endpoint returns project-specific DNS values
    const teamParam = VERCEL_TEAM_ID ? `?teamId=${VERCEL_TEAM_ID}` : '';
    const configUrl = `${VERCEL_API}/v6/domains/${domain}/config${teamParam}`;
    
    console.log(`🔍 Fetching DNS config from: ${configUrl}`);
    
    const response = await fetch(configUrl, {
      headers: { 'Authorization': `Bearer ${VERCEL_TOKEN}` }
    });

    if (!response.ok) {
      console.log(`⚠️ Config endpoint returned ${response.status}, using defaults`);
      return DEFAULT_DNS_CONFIG;
    }

    const data = await response.json();
    console.log('📋 Vercel DNS config response:', JSON.stringify(data, null, 2));

    // Extract the rank=1 (preferred) values
    // recommendedIPv4 format: [{ rank: 1, value: ["216.198.79.1"] }]
    // recommendedCNAME format: [{ rank: 1, value: "52f2ec7ccc7d7f3b.vercel-dns-017.com" }]
    
    let aRecord = DEFAULT_DNS_CONFIG.aRecord;
    let cnameRecord = DEFAULT_DNS_CONFIG.cnameRecord;

    if (data.recommendedIPv4 && Array.isArray(data.recommendedIPv4)) {
      const preferred = data.recommendedIPv4.find(r => r.rank === 1);
      if (preferred?.value?.[0]) {
        aRecord = preferred.value[0];
        console.log(`✅ Found project-specific A record: ${aRecord}`);
      }
    }

    if (data.recommendedCNAME && Array.isArray(data.recommendedCNAME)) {
      const preferred = data.recommendedCNAME.find(r => r.rank === 1);
      if (preferred?.value) {
        cnameRecord = preferred.value;
        console.log(`✅ Found project-specific CNAME: ${cnameRecord}`);
      }
    }

    return { aRecord, cnameRecord, misconfigured: data.misconfigured };

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
  
  let config = DEFAULT_DNS_CONFIG;
  
  // If a domain is provided, try to get project-specific values
  if (domain && VERCEL_TOKEN) {
    config = await fetchVercelDnsConfig(domain);
  }
  
  res.json({
    a_record: config.aRecord,
    cname_record: config.cnameRecord,
    source: config.aRecord === DEFAULT_DNS_CONFIG.aRecord ? 'fallback' : 'vercel-api',
    instructions: {
      apex: `Point your A record (@) to ${config.aRecord}`,
      subdomain: `Point your CNAME to ${config.cnameRecord}`
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
    
    // Step 1: Add domain to Vercel project (if configured)
    let vercelResponse = null;
    let vercelError = null;
    
    if (VERCEL_TOKEN && VERCEL_PROJECT_ID) {
      console.log(`   🔄 Adding to Vercel project: ${VERCEL_PROJECT_ID}`);
      try {
        vercelResponse = await vercelRequest(
          'POST',
          `/v10/projects/${VERCEL_PROJECT_ID}/domains`,
          { name: normalizedDomain }
        );
        console.log(`   ✅ Domain added to Vercel:`, vercelResponse.name);
      } catch (err) {
        // Domain might already exist on Vercel - that's OK
        if (err.message.includes('already') || err.message.includes('exists')) {
          console.log(`   ℹ️ Domain already exists on Vercel, continuing...`);
        } else {
          vercelError = err.message;
          console.log(`   ⚠️ Vercel error (non-fatal):`, err.message);
        }
      }
    } else {
      console.log(`   ⚠️ Vercel credentials not configured, skipping API call`);
    }
    
    // Step 2: Fetch PROJECT-SPECIFIC DNS values from Vercel
    // This is critical - using generic 76.76.21.21 causes SSL certificate issues!
    console.log(`   🔍 Fetching project-specific DNS values...`);
    const dnsConfig = await fetchVercelDnsConfig(normalizedDomain);
    console.log(`   📋 DNS Config: A=${dnsConfig.aRecord}, CNAME=${dnsConfig.cnameRecord}`);
    
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
      vercel_added: !!vercelResponse,
      vercel_error: vercelError,
      dns_instructions: dnsInstructions,
      dns_config: {
        a_record: dnsConfig.aRecord,
        cname_record: dnsConfig.cnameRecord,
        source: dnsConfig.aRecord === DEFAULT_DNS_CONFIG.aRecord ? 'fallback' : 'vercel-api'
      },
      verification: vercelResponse?.verification || null
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
      console.log(`   No A record found`);
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
        console.log(`   No CNAME record found`);
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
      message: isVerified 
        ? 'Domain verified successfully!'
        : `DNS records not found. Please set your A record to ${dnsConfig.aRecord} and allow up to 48 hours for propagation.`
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
    
    // Step 1: Remove from Vercel
    if (VERCEL_TOKEN && VERCEL_PROJECT_ID) {
      try {
        await vercelRequest(
          'DELETE',
          `/v9/projects/${VERCEL_PROJECT_ID}/domains/${domain}`
        );
        console.log(`   ✅ Domain removed from Vercel`);
      } catch (err) {
        console.log(`   ⚠️ Could not remove from Vercel:`, err.message);
        // Continue anyway - might not exist on Vercel
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
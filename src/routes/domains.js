// ============================================================================
// DOMAIN MANAGEMENT ROUTES
// VoiceAI Connect - Automated Vercel Domain Provisioning
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');

// ============================================================================
// CONFIGURATION
// ============================================================================
const VERCEL_API = 'https://api.vercel.com';
const VERCEL_TOKEN = process.env.VERCEL_API_TOKEN || process.env.VERCEL_TOKEN;
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID; // Optional, for team accounts

// DNS Configuration - customize these for your setup
const DNS_CONFIG = {
  aRecord: process.env.DNS_A_RECORD || '76.76.21.21',
  cnameRecord: process.env.DNS_CNAME_RECORD || 'cname.vercel-dns.com',
};

console.log('📡 Domain routes loaded with config:', {
  hasVercelToken: !!VERCEL_TOKEN,
  hasProjectId: !!VERCEL_PROJECT_ID,
  hasTeamId: !!VERCEL_TEAM_ID,
  aRecord: DNS_CONFIG.aRecord,
  cnameRecord: DNS_CONFIG.cnameRecord
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
// GET /dns-config
// Get current DNS configuration (for UI display) - PUBLIC
// ============================================================================
router.get('/dns-config', (req, res) => {
  console.log('📋 DNS config requested');
  res.json({
    a_record: DNS_CONFIG.aRecord,
    cname_record: DNS_CONFIG.cnameRecord,
    instructions: {
      apex: `Point your A record (@) to ${DNS_CONFIG.aRecord}`,
      subdomain: `Point your CNAME to ${DNS_CONFIG.cnameRecord}`
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
    
    // Step 2: Update agency in database
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
    
    // Build DNS instructions
    const dnsInstructions = {
      primary: {
        type: 'A',
        name: '@',
        value: DNS_CONFIG.aRecord,
        description: 'Points your root domain to our servers'
      },
      secondary: {
        type: 'CNAME',
        name: 'www',
        value: DNS_CONFIG.cnameRecord,
        description: 'Redirects www to your root domain'
      }
    };
    
    console.log(`   ✅ Domain configured successfully: ${normalizedDomain}`);
    
    res.json({
      success: true,
      domain: normalizedDomain,
      vercel_added: !!vercelResponse,
      vercel_error: vercelError,
      dns_instructions: dnsInstructions,
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
          value: DNS_CONFIG.aRecord
        },
        cname_record: {
          type: 'CNAME',
          name: 'www',
          value: DNS_CONFIG.cnameRecord
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
      if (aRecords.includes(DNS_CONFIG.aRecord)) {
        dnsVerified = true;
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
      message: isVerified 
        ? 'Domain verified successfully!'
        : 'DNS records not found. Please check your configuration and allow up to 48 hours for propagation.'
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
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
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID; // Optional, for team accounts

// DNS Configuration - customize these for your setup
const DNS_CONFIG = {
  aRecord: process.env.DNS_A_RECORD || '216.198.79.1',
  cnameRecord: process.env.DNS_CNAME_RECORD || 'cname.vercel-dns.com',
};

// ============================================================================
// HELPER: Make Vercel API Request
// ============================================================================
async function vercelRequest(method, endpoint, body = null) {
  const url = `${VERCEL_API}${endpoint}${VERCEL_TEAM_ID ? `?teamId=${VERCEL_TEAM_ID}` : ''}`;
  
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
    throw new Error(data.error?.message || 'Vercel API error');
  }
  
  return data;
}

// ============================================================================
// POST /api/agency/:agencyId/domain
// Add a custom domain to an agency (and provision on Vercel)
// ============================================================================
router.post('/:agencyId/domain', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const { domain } = req.body;
    
    if (!domain) {
      return res.status(400).json({ error: 'Domain is required' });
    }
    
    // Normalize domain (lowercase, no protocol, no trailing slash)
    const normalizedDomain = domain
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '')
      .trim();
    
    console.log(`🌐 Adding domain "${normalizedDomain}" for agency ${agencyId}`);
    
    // Check if domain is already used by another agency
    const { data: existing } = await supabase
      .from('agencies')
      .select('id, name')
      .eq('marketing_domain', normalizedDomain)
      .neq('id', agencyId)
      .single();
    
    if (existing) {
      return res.status(400).json({ 
        error: 'Domain is already in use by another agency' 
      });
    }
    
    // Step 1: Add domain to Vercel project
    let vercelResponse = null;
    let vercelError = null;
    
    if (VERCEL_TOKEN && VERCEL_PROJECT_ID) {
      try {
        vercelResponse = await vercelRequest(
          'POST',
          `/v10/projects/${VERCEL_PROJECT_ID}/domains`,
          { name: normalizedDomain }
        );
        console.log(`✅ Domain added to Vercel:`, vercelResponse);
      } catch (err) {
        // Domain might already exist on Vercel - that's OK
        if (err.message.includes('already exists')) {
          console.log(`ℹ️ Domain already exists on Vercel, continuing...`);
        } else {
          vercelError = err.message;
          console.error(`⚠️ Vercel error (non-fatal):`, err.message);
        }
      }
    } else {
      console.log(`⚠️ Vercel credentials not configured, skipping API call`);
    }
    
    // Step 2: Update agency in database
    const { data: agency, error: dbError } = await supabase
      .from('agencies')
      .update({
        marketing_domain: normalizedDomain,
        domain_verified: false,
        domain_vercel_added: !!vercelResponse,
        updated_at: new Date().toISOString()
      })
      .eq('id', agencyId)
      .select()
      .single();
    
    if (dbError) {
      console.error(`❌ Database error:`, dbError);
      return res.status(500).json({ error: 'Failed to save domain' });
    }
    
    // Build DNS instructions
    const isApexDomain = !normalizedDomain.startsWith('www.');
    const dnsInstructions = isApexDomain ? {
      primary: {
        type: 'A',
        name: '@',
        value: DNS_CONFIG.aRecord,
        description: 'Points your root domain to our servers'
      },
      optional: {
        type: 'CNAME',
        name: 'www',
        value: DNS_CONFIG.cnameRecord,
        description: 'Redirects www to your root domain'
      }
    } : {
      primary: {
        type: 'CNAME',
        name: normalizedDomain.split('.')[0], // e.g., 'www' from 'www.example.com'
        value: DNS_CONFIG.cnameRecord,
        description: 'Points your subdomain to our servers'
      }
    };
    
    console.log(`✅ Domain configured for agency: ${normalizedDomain}`);
    
    res.json({
      success: true,
      domain: normalizedDomain,
      vercel_added: !!vercelResponse,
      vercel_error: vercelError,
      dns_instructions: dnsInstructions,
      verification: vercelResponse?.verification || null
    });
    
  } catch (error) {
    console.error('❌ Add domain error:', error);
    res.status(500).json({ error: 'Failed to add domain' });
  }
});

// ============================================================================
// GET /api/agency/:agencyId/domain/status
// Check domain configuration status (from Vercel)
// ============================================================================
router.get('/:agencyId/domain/status', async (req, res) => {
  try {
    const { agencyId } = req.params;
    
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
    
    // Check status from Vercel
    let vercelStatus = null;
    if (VERCEL_TOKEN && VERCEL_PROJECT_ID) {
      try {
        vercelStatus = await vercelRequest(
          'GET',
          `/v9/projects/${VERCEL_PROJECT_ID}/domains/${domain}`
        );
      } catch (err) {
        console.log(`⚠️ Could not fetch Vercel status:`, err.message);
      }
    }
    
    // Build DNS instructions
    const isApexDomain = !domain.startsWith('www.');
    
    res.json({
      configured: true,
      domain,
      verified: agency.domain_verified,
      vercel_verified: vercelStatus?.verified || false,
      vercel_status: vercelStatus,
      dns_instructions: {
        a_record: isApexDomain ? {
          type: 'A',
          name: '@',
          value: DNS_CONFIG.aRecord
        } : null,
        cname_record: {
          type: 'CNAME',
          name: isApexDomain ? 'www' : domain.split('.')[0],
          value: DNS_CONFIG.cnameRecord
        }
      }
    });
    
  } catch (error) {
    console.error('❌ Domain status error:', error);
    res.status(500).json({ error: 'Failed to check domain status' });
  }
});

// ============================================================================
// POST /api/agency/:agencyId/domain/verify
// Verify domain configuration (checks DNS + Vercel)
// ============================================================================
router.post('/:agencyId/domain/verify', async (req, res) => {
  try {
    const { agencyId } = req.params;
    
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
    console.log(`🔍 Verifying domain: ${domain}`);
    
    // Step 1: Try to verify on Vercel
    let vercelVerified = false;
    if (VERCEL_TOKEN && VERCEL_PROJECT_ID) {
      try {
        const vercelResult = await vercelRequest(
          'POST',
          `/v9/projects/${VERCEL_PROJECT_ID}/domains/${domain}/verify`
        );
        vercelVerified = vercelResult.verified === true;
        console.log(`📋 Vercel verification result:`, vercelResult);
      } catch (err) {
        console.log(`⚠️ Vercel verification failed:`, err.message);
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
      if (aRecords.includes(DNS_CONFIG.aRecord)) {
        dnsVerified = true;
      }
    } catch (e) {
      // No A record, try CNAME
    }
    
    if (!dnsVerified) {
      try {
        const cnameRecords = await dns.resolveCname(domain);
        dnsDetails.cname_records = cnameRecords;
        if (cnameRecords.some(r => r.toLowerCase().includes('vercel'))) {
          dnsVerified = true;
        }
      } catch (e) {
        // No CNAME either
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
      
      console.log(`✅ Domain verified: ${domain}`);
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
    console.error('❌ Domain verify error:', error);
    res.status(500).json({ 
      verified: false,
      error: 'Verification failed'
    });
  }
});

// ============================================================================
// DELETE /api/agency/:agencyId/domain
// Remove custom domain from agency (and Vercel)
// ============================================================================
router.delete('/:agencyId/domain', async (req, res) => {
  try {
    const { agencyId } = req.params;
    
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
    console.log(`🗑️ Removing domain: ${domain}`);
    
    // Step 1: Remove from Vercel
    if (VERCEL_TOKEN && VERCEL_PROJECT_ID) {
      try {
        await vercelRequest(
          'DELETE',
          `/v9/projects/${VERCEL_PROJECT_ID}/domains/${domain}`
        );
        console.log(`✅ Domain removed from Vercel`);
      } catch (err) {
        console.log(`⚠️ Could not remove from Vercel:`, err.message);
        // Continue anyway - might not exist on Vercel
      }
    }
    
    // Step 2: Update database
    const { error: dbError } = await supabase
      .from('agencies')
      .update({
        marketing_domain: null,
        domain_verified: false,
        domain_vercel_added: false,
        updated_at: new Date().toISOString()
      })
      .eq('id', agencyId);
    
    if (dbError) {
      return res.status(500).json({ error: 'Failed to remove domain' });
    }
    
    console.log(`✅ Domain removed: ${domain}`);
    res.json({ success: true, removed_domain: domain });
    
  } catch (error) {
    console.error('❌ Remove domain error:', error);
    res.status(500).json({ error: 'Failed to remove domain' });
  }
});

// ============================================================================
// GET /api/domain/dns-config
// Get current DNS configuration (for UI display)
// ============================================================================
router.get('/dns-config', (req, res) => {
  res.json({
    a_record: DNS_CONFIG.aRecord,
    cname_record: DNS_CONFIG.cnameRecord,
    instructions: {
      apex: `Point your A record (@) to ${DNS_CONFIG.aRecord}`,
      subdomain: `Point your CNAME to ${DNS_CONFIG.cnameRecord}`
    }
  });
});

module.exports = router;
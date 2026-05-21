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

console.log('📁 Domain routes file loaded');

// ============================================================================
// CONFIGURATION
// ============================================================================
const VERCEL_API = 'https://api.vercel.com';
const VERCEL_TOKEN = process.env.VERCEL_API_TOKEN || process.env.VERCEL_TOKEN;
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID;

const DEFAULT_DNS_CONFIG = {
  aRecord: '216.198.79.1',
  cnameRecord: 'cname.vercel-dns.com',
};

// Subdomains of hosting platforms can never be verified because the agency
// doesn't control the root domain's DNS (where _vercel TXT goes).
const BLOCKED_DOMAIN_SUFFIXES = [
  '.lovable.app', '.vercel.app', '.netlify.app', '.herokuapp.com',
  '.github.io', '.pages.dev', '.fly.dev', '.railway.app',
  '.render.com', '.onrender.com', '.surge.sh', '.web.app',
  '.firebaseapp.com', '.amplifyapp.com', '.replit.app', '.repl.co',
  '.glitch.me', '.stackblitz.io', '.codesandbox.io',
];

console.log('📡 Domain routes loaded with config:', {
  hasVercelToken: !!VERCEL_TOKEN,
  tokenPrefix: VERCEL_TOKEN ? VERCEL_TOKEN.substring(0, 10) + '...' : 'none',
  hasProjectId: !!VERCEL_PROJECT_ID,
  projectId: VERCEL_PROJECT_ID || 'not set',
  hasTeamId: !!VERCEL_TEAM_ID,
});

// ============================================================================
// CORS OPTIONS HANDLERS
// ============================================================================
router.options('/:agencyId/domain', (req, res) => { res.header('Access-Control-Allow-Origin', req.headers.origin || '*'); res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS'); res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization'); res.header('Access-Control-Allow-Credentials', 'true'); res.sendStatus(200); });
router.options('/:agencyId/domain/status', (req, res) => { res.header('Access-Control-Allow-Origin', req.headers.origin || '*'); res.header('Access-Control-Allow-Methods', 'GET, OPTIONS'); res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization'); res.header('Access-Control-Allow-Credentials', 'true'); res.sendStatus(200); });
router.options('/:agencyId/domain/verify', (req, res) => { res.header('Access-Control-Allow-Origin', req.headers.origin || '*'); res.header('Access-Control-Allow-Methods', 'POST, OPTIONS'); res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization'); res.header('Access-Control-Allow-Credentials', 'true'); res.sendStatus(200); });
router.options('/dns-config', (req, res) => { res.header('Access-Control-Allow-Origin', req.headers.origin || '*'); res.header('Access-Control-Allow-Methods', 'GET, OPTIONS'); res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization'); res.header('Access-Control-Allow-Credentials', 'true'); res.sendStatus(200); });

// ============================================================================
// HELPER: Vercel API Request — preserves full response data on errors
// ============================================================================
class VercelApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'VercelApiError';
    this.status = status;
    this.data = data; // Full Vercel response body — includes verification records
  }
}

async function vercelRequest(method, endpoint, body = null) {
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
  if (body) options.body = JSON.stringify(body);

  console.log(`🔗 Vercel API: ${method} ${url}`);
  const response = await fetch(url, options);
  const data = await response.json();
  console.log(`📥 Vercel API Response (${response.status}):`, JSON.stringify(data, null, 2));

  if (!response.ok) {
    throw new VercelApiError(
      data.error?.message || data.error?.code || `Vercel API error: ${response.status}`,
      response.status,
      data
    );
  }

  return data;
}

// ============================================================================
// HELPER: Extract verification records from Vercel response
// Vercel returns these in different shapes depending on the endpoint/error.
// ============================================================================
function extractVerificationRecords(data) {
  if (!data) return [];
  const records = [];

  // Shape 1: Top-level verification array (from successful POST or GET)
  //   verification: [{ type: "TXT", domain: "_vercel.example.com", value: "vc-domain-verify=...", reason: "..." }]
  if (Array.isArray(data.verification)) {
    for (const v of data.verification) {
      records.push({ type: v.type || 'TXT', name: v.domain || '', value: v.value || '', reason: v.reason || '' });
    }
  }

  // Shape 2: Nested under error (from 409 conflict)
  //   error: { ..., verification: [...] }
  if (data.error && Array.isArray(data.error.verification)) {
    for (const v of data.error.verification) {
      records.push({ type: v.type || 'TXT', name: v.domain || '', value: v.value || '', reason: v.reason || '' });
    }
  }

  return records;
}

// ============================================================================
// HELPER: Fetch Project-Specific DNS Values from Vercel
// ============================================================================
async function fetchVercelDnsConfig(domain) {
  if (!VERCEL_TOKEN) {
    console.log('⚠️ No Vercel token, using default DNS values');
    return DEFAULT_DNS_CONFIG;
  }
  try {
    const teamParam = VERCEL_TEAM_ID ? `?teamId=${VERCEL_TEAM_ID}` : '';
    const configUrl = `${VERCEL_API}/v6/domains/${domain}/config${teamParam}`;
    console.log(`🔍 Fetching DNS config from: ${configUrl}`);
    const response = await fetch(configUrl, { headers: { 'Authorization': `Bearer ${VERCEL_TOKEN}` } });
    const data = await response.json();
    console.log('📋 Vercel DNS config response:', JSON.stringify(data, null, 2));
    if (!response.ok) {
      console.log(`⚠️ Config endpoint returned ${response.status}: ${data.error?.message || 'Unknown error'}`);
      return DEFAULT_DNS_CONFIG;
    }
    let aRecord = DEFAULT_DNS_CONFIG.aRecord;
    let cnameRecord = DEFAULT_DNS_CONFIG.cnameRecord;
    if (data.recommendedIPv4 && Array.isArray(data.recommendedIPv4)) {
      const preferred = data.recommendedIPv4.find(r => r.rank === 1);
      if (preferred?.value?.[0]) { aRecord = preferred.value[0]; console.log(`✅ Found project-specific A record: ${aRecord}`); }
    }
    if (data.recommendedCNAME && Array.isArray(data.recommendedCNAME)) {
      const preferred = data.recommendedCNAME.find(r => r.rank === 1);
      if (preferred?.value) { cnameRecord = preferred.value; console.log(`✅ Found project-specific CNAME: ${cnameRecord}`); }
    }
    return { aRecord, cnameRecord, misconfigured: data.misconfigured, source: aRecord !== DEFAULT_DNS_CONFIG.aRecord ? 'vercel-api' : 'fallback' };
  } catch (error) {
    console.error('❌ Failed to fetch Vercel DNS config:', error);
    return DEFAULT_DNS_CONFIG;
  }
}

// ============================================================================
// GET /test
// ============================================================================
router.get('/test', (req, res) => {
  res.json({ ok: true, message: 'Domain routes are loaded and working', timestamp: new Date().toISOString(), supabaseLoaded: !!supabase, hasVercelToken: !!VERCEL_TOKEN, hasProjectId: !!VERCEL_PROJECT_ID });
});

// ============================================================================
// GET /dns-config
// ============================================================================
router.get('/dns-config', async (req, res) => {
  const { domain } = req.query;
  console.log('📋 DNS config requested', domain ? `for domain: ${domain}` : '(no domain)');
  let config = { ...DEFAULT_DNS_CONFIG, source: 'fallback' };
  if (domain && VERCEL_TOKEN) {
    const vercelConfig = await fetchVercelDnsConfig(domain);
    config = { aRecord: vercelConfig.aRecord, cnameRecord: vercelConfig.cnameRecord, source: vercelConfig.source || (vercelConfig.aRecord !== DEFAULT_DNS_CONFIG.aRecord ? 'vercel-api' : 'fallback'), misconfigured: vercelConfig.misconfigured };
  }
  console.log(`📤 Returning DNS config: A=${config.aRecord}, CNAME=${config.cnameRecord}, source=${config.source}`);
  res.json({ a_record: config.aRecord, cname_record: config.cnameRecord, source: config.source, misconfigured: config.misconfigured, instructions: { apex: `Point your A record (@) to ${config.aRecord}`, www: `Point your CNAME (www) to ${config.cnameRecord}` } });
});

// ============================================================================
// POST /:agencyId/domain — Add custom domain
// Now captures and returns Vercel verification records (TXT) when needed.
// ============================================================================
router.post('/:agencyId/domain', async (req, res) => {
  const { agencyId } = req.params;
  console.log(`\n🌐 ===== ADD DOMAIN REQUEST =====`);
  console.log(`   Agency ID: ${agencyId}`);
  console.log(`   Body:`, req.body);

  try {
    const { domain } = req.body;
    if (!domain) return res.status(400).json({ error: 'Domain is required' });

    // Normalize
    let normalizedDomain = domain.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '').trim();
    console.log(`   📝 Normalized domain: ${normalizedDomain}`);

    // Validate format
    const domainRegex = /^[a-z0-9]+([\-\.]{1}[a-z0-9]+)*\.[a-z]{2,}$/;
    if (!domainRegex.test(normalizedDomain)) {
      return res.status(400).json({ error: 'Invalid domain format' });
    }

    // Block platform subdomains — these can never be verified
    const blockedSuffix = BLOCKED_DOMAIN_SUFFIXES.find(suffix => normalizedDomain.endsWith(suffix));
    if (blockedSuffix) {
      return res.status(400).json({
        error: `Platform subdomains (${blockedSuffix}) cannot be used as custom domains. You need a domain you own — for example, youragency.com. You can purchase one from GoDaddy, Namecheap, or Google Domains.`,
      });
    }

    // Check if already used by another agency
    const { data: existing } = await supabase
      .from('agencies')
      .select('id, name')
      .eq('marketing_domain', normalizedDomain)
      .neq('id', agencyId)
      .maybeSingle();
    if (existing) {
      return res.status(400).json({ error: 'Domain is already in use by another agency' });
    }

    // ── Add to Vercel + capture verification records ──────────────────
    let vercelApexResponse = null;
    let vercelWwwResponse = null;
    let vercelError = null;
    let verificationRecords = [];

    if (VERCEL_TOKEN && VERCEL_PROJECT_ID) {
      console.log(`   🔄 Adding to Vercel project: ${VERCEL_PROJECT_ID}`);

      // Add apex domain
      try {
        vercelApexResponse = await vercelRequest('POST', `/v10/projects/${VERCEL_PROJECT_ID}/domains`, { name: normalizedDomain });
        console.log(`   ✅ Apex domain added to Vercel`);
        // Successful add may still require verification (domain on another account)
        const records = extractVerificationRecords(vercelApexResponse);
        if (records.length > 0) verificationRecords = records;
      } catch (err) {
        if (err.message.includes('already') || err.message.includes('exists') || err.message.includes('DOMAIN_ALREADY_EXISTS') || err.status === 409) {
          console.log(`   ℹ️ Apex domain conflict — checking for verification records`);
          // Extract verification records from the error response
          const records = extractVerificationRecords(err.data);
          if (records.length > 0) {
            verificationRecords = records;
            console.log(`   📋 Found ${records.length} verification record(s):`, records);
          }
        } else {
          vercelError = err.message;
          console.log(`   ⚠️ Vercel apex domain error:`, err.message);
        }
      }

      // Add www subdomain
      try {
        vercelWwwResponse = await vercelRequest('POST', `/v10/projects/${VERCEL_PROJECT_ID}/domains`, { name: `www.${normalizedDomain}` });
        console.log(`   ✅ WWW domain added to Vercel`);
        // Also check for verification records on www
        const wwwRecords = extractVerificationRecords(vercelWwwResponse);
        if (wwwRecords.length > 0 && verificationRecords.length === 0) {
          verificationRecords = wwwRecords;
        }
      } catch (err) {
        if (err.message.includes('already') || err.message.includes('exists') || err.message.includes('DOMAIN_ALREADY_EXISTS') || err.status === 409) {
          console.log(`   ℹ️ WWW domain conflict — continuing`);
          // Extract verification if we don't have any yet
          if (verificationRecords.length === 0) {
            const records = extractVerificationRecords(err.data);
            if (records.length > 0) verificationRecords = records;
          }
        } else {
          console.log(`   ⚠️ Vercel www domain error (non-fatal):`, err.message);
        }
      }
    } else {
      console.log(`   ⚠️ Vercel credentials not configured`);
    }

    // ── Fetch project-specific DNS values ─────────────────────────────
    console.log(`   🔍 Fetching project-specific DNS values...`);
    const dnsConfig = await fetchVercelDnsConfig(normalizedDomain);
    console.log(`   📋 DNS Config: A=${dnsConfig.aRecord}, CNAME=${dnsConfig.cnameRecord}`);

    // ── Update database ───────────────────────────────────────────────
    const { data: agency, error: dbError } = await supabase
      .from('agencies')
      .update({
        marketing_domain: normalizedDomain,
        domain_verified: false,
        updated_at: new Date().toISOString(),
      })
      .eq('id', agencyId)
      .select()
      .single();

    if (dbError) return res.status(500).json({ error: 'Failed to save domain: ' + dbError.message });
    if (!agency) return res.status(404).json({ error: 'Agency not found' });

    const needsVerification = verificationRecords.length > 0;
    console.log(`   ✅ Domain configured: ${normalizedDomain}${needsVerification ? ' (TXT verification required)' : ''}`);

    res.json({
      success: true,
      domain: normalizedDomain,
      vercel_added: !!(vercelApexResponse || vercelWwwResponse),
      vercel_error: vercelError,
      // ── Verification records for the frontend ───────────────────────
      verification_needed: needsVerification,
      verification_records: verificationRecords,
      // ── DNS instructions ────────────────────────────────────────────
      dns_instructions: {
        primary: { type: 'A', name: '@', value: dnsConfig.aRecord, description: 'Points your root domain to our servers' },
        secondary: { type: 'CNAME', name: 'www', value: dnsConfig.cnameRecord, description: 'Redirects www to your root domain' },
      },
      dns_config: {
        a_record: dnsConfig.aRecord,
        cname_record: dnsConfig.cnameRecord,
        source: dnsConfig.source || 'fallback',
      },
    });

  } catch (error) {
    console.error(`   ❌ Unexpected error:`, error);
    res.status(500).json({ error: 'Failed to add domain: ' + error.message });
  }
});

// ============================================================================
// GET /:agencyId/domain/status — now includes verification records
// ============================================================================
router.get('/:agencyId/domain/status', async (req, res) => {
  const { agencyId } = req.params;
  console.log(`\n🔍 ===== DOMAIN STATUS REQUEST =====`);

  try {
    const { data: agency, error } = await supabase
      .from('agencies')
      .select('marketing_domain, domain_verified')
      .eq('id', agencyId)
      .single();

    if (error || !agency?.marketing_domain) {
      return res.json({ configured: false, message: 'No custom domain configured' });
    }

    const domain = agency.marketing_domain;
    console.log(`   Domain: ${domain}`);

    let vercelStatus = null;
    let verificationRecords = [];

    if (VERCEL_TOKEN && VERCEL_PROJECT_ID) {
      try {
        vercelStatus = await vercelRequest('GET', `/v9/projects/${VERCEL_PROJECT_ID}/domains/${domain}`);
        console.log(`   Vercel verified: ${vercelStatus?.verified}`);
        // Extract any pending verification records
        const records = extractVerificationRecords(vercelStatus);
        if (records.length > 0) verificationRecords = records;
      } catch (err) {
        console.log(`   ⚠️ Could not fetch Vercel status:`, err.message);
        // Even errors can contain verification records
        if (err.data) {
          const records = extractVerificationRecords(err.data);
          if (records.length > 0) verificationRecords = records;
        }
      }
    }

    const dnsConfig = await fetchVercelDnsConfig(domain);

    res.json({
      configured: true,
      domain,
      verified: agency.domain_verified,
      vercel_verified: vercelStatus?.verified || false,
      verification_needed: verificationRecords.length > 0,
      verification_records: verificationRecords,
      dns_instructions: {
        a_record: { type: 'A', name: '@', value: dnsConfig.aRecord },
        cname_record: { type: 'CNAME', name: 'www', value: dnsConfig.cnameRecord },
      },
    });

  } catch (error) {
    console.error(`   ❌ Error:`, error);
    res.status(500).json({ error: 'Failed to check domain status' });
  }
});

// ============================================================================
// POST /:agencyId/domain/verify
// ============================================================================
router.post('/:agencyId/domain/verify', async (req, res) => {
  const { agencyId } = req.params;
  console.log(`\n✅ ===== VERIFY DOMAIN REQUEST =====`);

  try {
    const { data: agency, error } = await supabase
      .from('agencies')
      .select('marketing_domain')
      .eq('id', agencyId)
      .single();

    if (error || !agency?.marketing_domain) {
      return res.status(404).json({ verified: false, error: 'No custom domain configured' });
    }

    const domain = agency.marketing_domain;
    console.log(`   Verifying domain: ${domain}`);

    const dnsConfig = await fetchVercelDnsConfig(domain);
    console.log(`   Expected A record: ${dnsConfig.aRecord}`);

    // Step 1: Vercel verification
    let vercelVerified = false;
    let verificationRecords = [];
    if (VERCEL_TOKEN && VERCEL_PROJECT_ID) {
      try {
        const vercelResult = await vercelRequest('POST', `/v9/projects/${VERCEL_PROJECT_ID}/domains/${domain}/verify`);
        vercelVerified = vercelResult.verified === true;
        console.log(`   📋 Vercel verification: ${vercelVerified}`);
        // If still not verified, extract any pending verification records
        if (!vercelVerified) {
          const records = extractVerificationRecords(vercelResult);
          if (records.length > 0) verificationRecords = records;
        }
      } catch (err) {
        console.log(`   ⚠️ Vercel verification failed:`, err.message);
        // Extract verification records from error
        if (err.data) {
          const records = extractVerificationRecords(err.data);
          if (records.length > 0) verificationRecords = records;
        }
      }
    }

    // Step 2: Our own DNS check as backup
    const dns = require('dns').promises;
    let dnsVerified = false;
    let dnsDetails = {};

    try {
      const aRecords = await dns.resolve4(domain);
      dnsDetails.a_records = aRecords;
      console.log(`   A records found:`, aRecords);
      if (aRecords.includes(dnsConfig.aRecord)) {
        dnsVerified = true;
        console.log(`   ✅ A record matches expected value`);
      } else {
        console.log(`   ⚠️ A record mismatch. Expected: ${dnsConfig.aRecord}, Found: ${aRecords.join(', ')}`);
      }
    } catch (e) {
      console.log(`   No A record found`);
    }

    if (!dnsVerified) {
      try {
        const cnameRecords = await dns.resolveCname(domain);
        dnsDetails.cname_records = cnameRecords;
        console.log(`   CNAME records found:`, cnameRecords);
        if (cnameRecords.some(r => r.toLowerCase().includes('vercel'))) dnsVerified = true;
      } catch (e) { console.log(`   No CNAME record found`); }
    }

    const isVerified = vercelVerified || dnsVerified;

    if (isVerified) {
      await supabase.from('agencies').update({ domain_verified: true, updated_at: new Date().toISOString() }).eq('id', agencyId);
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
      // Include verification records if still pending
      verification_needed: verificationRecords.length > 0,
      verification_records: verificationRecords,
      message: isVerified
        ? 'Domain verified successfully!'
        : verificationRecords.length > 0
          ? `This domain requires ownership verification. Add the TXT record shown below, then try verifying again.`
          : `DNS records not found. Please set your A record to ${dnsConfig.aRecord} and CNAME (www) to ${dnsConfig.cnameRecord}. Allow up to 48 hours for propagation.`,
    });

  } catch (error) {
    console.error(`   ❌ Error:`, error);
    res.status(500).json({ verified: false, error: 'Verification failed: ' + error.message });
  }
});

// ============================================================================
// DELETE /:agencyId/domain
// ============================================================================
router.delete('/:agencyId/domain', async (req, res) => {
  const { agencyId } = req.params;
  console.log(`\n🗑️ ===== REMOVE DOMAIN REQUEST =====`);

  try {
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

    if (VERCEL_TOKEN && VERCEL_PROJECT_ID) {
      try { await vercelRequest('DELETE', `/v9/projects/${VERCEL_PROJECT_ID}/domains/${domain}`); console.log(`   ✅ Apex removed from Vercel`); } catch (err) { console.log(`   ⚠️ Could not remove apex:`, err.message); }
      try { await vercelRequest('DELETE', `/v9/projects/${VERCEL_PROJECT_ID}/domains/www.${domain}`); console.log(`   ✅ WWW removed from Vercel`); } catch (err) { console.log(`   ⚠️ Could not remove www:`, err.message); }
    }

    const { error: dbError } = await supabase
      .from('agencies')
      .update({ marketing_domain: null, domain_verified: false, updated_at: new Date().toISOString() })
      .eq('id', agencyId);

    if (dbError) return res.status(500).json({ error: 'Failed to remove domain' });

    console.log(`   ✅ Domain removed: ${domain}`);
    res.json({ success: true, removed_domain: domain });

  } catch (error) {
    console.error(`   ❌ Error:`, error);
    res.status(500).json({ error: 'Failed to remove domain: ' + error.message });
  }
});

module.exports = router;
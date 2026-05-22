// ============================================================================
// DOMAIN MANAGEMENT ROUTES
// VoiceAI Connect - Automated Vercel Domain Provisioning
// UPDATED: fetchVercelDnsConfig passes projectIdOrName for per-project CNAME
// UPDATED: 2026-05-22 — Subdomain support: detect apex vs subdomain, only add
//   www for apex, show correct DNS instructions (CNAME-only for subdomains).
//   Verify endpoint no longer bypasses TXT ownership check when DNS resolves.
//   Platform domains blocked.
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
  '.myvoiceaiconnect.com', '.callbirdai.com',
  '.lovable.app', '.vercel.app', '.netlify.app', '.herokuapp.com',
  '.github.io', '.pages.dev', '.fly.dev', '.railway.app',
  '.render.com', '.onrender.com', '.surge.sh', '.web.app',
  '.firebaseapp.com', '.amplifyapp.com', '.replit.app', '.repl.co',
  '.glitch.me', '.stackblitz.io', '.codesandbox.io',
];

// Exact platform domains that should never be added as custom domains
const BLOCKED_EXACT_DOMAINS = [
  'myvoiceaiconnect.com', 'callbirdai.com',
];

// Multi-part TLDs where the "apex" has 3+ parts (e.g. example.co.uk)
const MULTI_PART_TLDS = [
  '.co.uk', '.org.uk', '.me.uk', '.net.uk', '.ac.uk',
  '.com.au', '.net.au', '.org.au', '.co.nz', '.net.nz',
  '.co.za', '.com.br', '.net.br', '.co.in', '.com.in',
  '.co.jp', '.com.mx', '.com.ar', '.com.co', '.co.kr',
  '.com.sg', '.com.hk', '.com.tw', '.co.th', '.com.ph',
  '.co.il', '.com.tr', '.com.ua', '.com.eg', '.co.ke',
  '.com.ng', '.co.id', '.com.my', '.com.pk', '.com.bd',
  '.com.vn', '.com.pe', '.com.ec', '.com.gt', '.com.do',
  '.com.uy', '.com.py', '.com.bo', '.com.ve', '.com.sv',
  '.com.ni', '.com.hn', '.com.cr', '.com.pa', '.com.cu',
];

console.log('📡 Domain routes loaded with config:', {
  hasVercelToken: !!VERCEL_TOKEN,
  tokenPrefix: VERCEL_TOKEN ? VERCEL_TOKEN.substring(0, 10) + '...' : 'none',
  hasProjectId: !!VERCEL_PROJECT_ID,
  projectId: VERCEL_PROJECT_ID || 'not set',
  hasTeamId: !!VERCEL_TEAM_ID,
});

// ============================================================================
// HELPER: Detect if a domain is an apex (root) domain vs a subdomain
// Handles multi-part TLDs like .co.uk
// ============================================================================
function isApexDomain(domain) {
  // Check multi-part TLDs first
  for (const tld of MULTI_PART_TLDS) {
    if (domain.endsWith(tld)) {
      // e.g. "example.co.uk" → remove ".co.uk" → "example" → no dots → apex
      // e.g. "app.example.co.uk" → remove ".co.uk" → "app.example" → has dot → subdomain
      const withoutTld = domain.slice(0, -tld.length);
      return !withoutTld.includes('.');
    }
  }
  // Standard TLD: apex = exactly 2 parts (example.com)
  return domain.split('.').length === 2;
}

// Extract subdomain prefix for DNS instructions
// "ai.revop.xyz" → "ai"
// "app.demo.revop.xyz" → "app.demo"
function getSubdomainPrefix(domain) {
  for (const tld of MULTI_PART_TLDS) {
    if (domain.endsWith(tld)) {
      const withoutTld = domain.slice(0, -tld.length);
      const parts = withoutTld.split('.');
      // Remove the last part (the registrable domain name)
      parts.pop();
      return parts.join('.');
    }
  }
  // Standard TLD: everything before the last two parts
  const parts = domain.split('.');
  return parts.slice(0, -2).join('.');
}

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
    this.data = data;
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
// ============================================================================
function extractVerificationRecords(data) {
  if (!data) return [];
  const records = [];

  if (Array.isArray(data.verification)) {
    for (const v of data.verification) {
      records.push({ type: v.type || 'TXT', name: v.domain || '', value: v.value || '', reason: v.reason || '' });
    }
  }

  if (data.error && Array.isArray(data.error.verification)) {
    for (const v of data.error.verification) {
      records.push({ type: v.type || 'TXT', name: v.domain || '', value: v.value || '', reason: v.reason || '' });
    }
  }

  return records;
}

// ============================================================================
// HELPER: Fetch Project-Specific DNS Values from Vercel
// FIXED: Now passes projectIdOrName so Vercel returns per-project CNAME
// ============================================================================
async function fetchVercelDnsConfig(domain) {
  if (!VERCEL_TOKEN) {
    console.log('⚠️ No Vercel token, using default DNS values');
    return DEFAULT_DNS_CONFIG;
  }
  try {
    const params = new URLSearchParams();
    if (VERCEL_TEAM_ID) params.set('teamId', VERCEL_TEAM_ID);
    if (VERCEL_PROJECT_ID) params.set('projectIdOrName', VERCEL_PROJECT_ID);
    const configUrl = `${VERCEL_API}/v6/domains/${domain}/config?${params.toString()}`;

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
    return {
      aRecord,
      cnameRecord,
      misconfigured: data.misconfigured,
      configuredBy: data.configuredBy || null,
      source: (aRecord !== DEFAULT_DNS_CONFIG.aRecord || cnameRecord !== DEFAULT_DNS_CONFIG.cnameRecord) ? 'vercel-api' : 'fallback',
    };
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
    config = { aRecord: vercelConfig.aRecord, cnameRecord: vercelConfig.cnameRecord, source: vercelConfig.source || 'fallback', misconfigured: vercelConfig.misconfigured, configuredBy: vercelConfig.configuredBy };
  }

  const apex = domain ? isApexDomain(domain) : true;
  const subPrefix = domain && !apex ? getSubdomainPrefix(domain) : null;

  console.log(`📤 Returning DNS config: A=${config.aRecord}, CNAME=${config.cnameRecord}, source=${config.source}, apex=${apex}`);
  res.json({
    a_record: config.aRecord,
    cname_record: config.cnameRecord,
    source: config.source,
    misconfigured: config.misconfigured,
    configured_by: config.configuredBy,
    is_subdomain: !apex,
    subdomain_prefix: subPrefix,
    instructions: apex
      ? { apex: `Point your A record (@) to ${config.aRecord}`, www: `Point your CNAME (www) to ${config.cnameRecord}` }
      : { cname: `Point your CNAME (${subPrefix}) to ${config.cnameRecord}` },
  });
});

// ============================================================================
// POST /:agencyId/domain — Add custom domain
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

    // Block exact platform domains
    if (BLOCKED_EXACT_DOMAINS.includes(normalizedDomain)) {
      return res.status(400).json({ error: 'This is a platform domain and cannot be used as a custom domain.' });
    }

    // Block platform subdomains
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

    // ── Detect apex vs subdomain ──────────────────────────────────────
    const apex = isApexDomain(normalizedDomain);
    const subPrefix = !apex ? getSubdomainPrefix(normalizedDomain) : null;
    console.log(`   📋 Domain type: ${apex ? 'apex' : `subdomain (prefix: ${subPrefix})`}`);

    // ── Add to Vercel + capture verification records ──────────────────
    let vercelPrimaryResponse = null;
    let vercelWwwResponse = null;
    let vercelError = null;
    let verificationRecords = [];

    if (VERCEL_TOKEN && VERCEL_PROJECT_ID) {
      console.log(`   🔄 Adding to Vercel project: ${VERCEL_PROJECT_ID}`);

      // Add primary domain (apex or subdomain)
      try {
        vercelPrimaryResponse = await vercelRequest('POST', `/v10/projects/${VERCEL_PROJECT_ID}/domains`, { name: normalizedDomain });
        console.log(`   ✅ Primary domain added to Vercel`);
        const records = extractVerificationRecords(vercelPrimaryResponse);
        if (records.length > 0) verificationRecords = records;
      } catch (err) {
        if (err.message.includes('already') || err.message.includes('exists') || err.message.includes('DOMAIN_ALREADY_EXISTS') || err.status === 409) {
          console.log(`   ℹ️ Primary domain conflict — checking for verification records`);
          const records = extractVerificationRecords(err.data);
          if (records.length > 0) {
            verificationRecords = records;
            console.log(`   📋 Found ${records.length} verification record(s):`, records);
          }
        } else {
          vercelError = err.message;
          console.log(`   ⚠️ Vercel primary domain error:`, err.message);
        }
      }

      // Only add www variant for apex domains
      if (apex) {
        try {
          vercelWwwResponse = await vercelRequest('POST', `/v10/projects/${VERCEL_PROJECT_ID}/domains`, { name: `www.${normalizedDomain}` });
          console.log(`   ✅ WWW domain added to Vercel`);
          const wwwRecords = extractVerificationRecords(vercelWwwResponse);
          if (wwwRecords.length > 0 && verificationRecords.length === 0) {
            verificationRecords = wwwRecords;
          }
        } catch (err) {
          if (err.message.includes('already') || err.message.includes('exists') || err.message.includes('DOMAIN_ALREADY_EXISTS') || err.status === 409) {
            console.log(`   ℹ️ WWW domain conflict — continuing`);
            if (verificationRecords.length === 0) {
              const records = extractVerificationRecords(err.data);
              if (records.length > 0) verificationRecords = records;
            }
          } else {
            console.log(`   ⚠️ Vercel www domain error (non-fatal):`, err.message);
          }
        }
      } else {
        console.log(`   ℹ️ Subdomain detected — skipping www.${normalizedDomain}`);
      }
    } else {
      console.log(`   ⚠️ Vercel credentials not configured`);
    }

    // ── Fetch project-specific DNS values ─────────────────────────────
    console.log(`   🔍 Fetching project-specific DNS values...`);
    const dnsConfig = await fetchVercelDnsConfig(normalizedDomain);
    console.log(`   📋 DNS Config: A=${dnsConfig.aRecord}, CNAME=${dnsConfig.cnameRecord}, source=${dnsConfig.source}`);

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

    // ── Build DNS instructions based on domain type ───────────────────
    const dnsInstructions = apex
      ? {
          primary: { type: 'A', name: '@', value: dnsConfig.aRecord, description: 'Points your root domain to our servers' },
          secondary: { type: 'CNAME', name: 'www', value: dnsConfig.cnameRecord, description: 'Redirects www to your root domain' },
        }
      : {
          primary: { type: 'CNAME', name: subPrefix, value: dnsConfig.cnameRecord, description: `Points ${normalizedDomain} to our servers` },
        };

    res.json({
      success: true,
      domain: normalizedDomain,
      is_subdomain: !apex,
      subdomain_prefix: subPrefix,
      vercel_added: !!(vercelPrimaryResponse || vercelWwwResponse),
      vercel_error: vercelError,
      verification_needed: needsVerification,
      verification_records: verificationRecords,
      dns_instructions: dnsInstructions,
      dns_config: {
        a_record: dnsConfig.aRecord,
        cname_record: dnsConfig.cnameRecord,
        source: dnsConfig.source || 'fallback',
        misconfigured: dnsConfig.misconfigured,
        is_subdomain: !apex,
        subdomain_prefix: subPrefix,
      },
    });

  } catch (error) {
    console.error(`   ❌ Unexpected error:`, error);
    res.status(500).json({ error: 'Failed to add domain: ' + error.message });
  }
});

// ============================================================================
// GET /:agencyId/domain/status
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
    const apex = isApexDomain(domain);
    const subPrefix = !apex ? getSubdomainPrefix(domain) : null;
    console.log(`   Domain: ${domain} (${apex ? 'apex' : `subdomain, prefix: ${subPrefix}`})`);

    let vercelStatus = null;
    let verificationRecords = [];

    if (VERCEL_TOKEN && VERCEL_PROJECT_ID) {
      try {
        vercelStatus = await vercelRequest('GET', `/v9/projects/${VERCEL_PROJECT_ID}/domains/${domain}`);
        console.log(`   Vercel verified: ${vercelStatus?.verified}`);
        const records = extractVerificationRecords(vercelStatus);
        if (records.length > 0) verificationRecords = records;
      } catch (err) {
        console.log(`   ⚠️ Could not fetch Vercel status:`, err.message);
        if (err.data) {
          const records = extractVerificationRecords(err.data);
          if (records.length > 0) verificationRecords = records;
        }
      }
    }

    const dnsConfig = await fetchVercelDnsConfig(domain);

    const dnsInstructions = apex
      ? {
          a_record: { type: 'A', name: '@', value: dnsConfig.aRecord },
          cname_record: { type: 'CNAME', name: 'www', value: dnsConfig.cnameRecord },
        }
      : {
          cname_record: { type: 'CNAME', name: subPrefix, value: dnsConfig.cnameRecord },
        };

    res.json({
      configured: true,
      domain,
      is_subdomain: !apex,
      subdomain_prefix: subPrefix,
      verified: agency.domain_verified,
      vercel_verified: vercelStatus?.verified || false,
      verification_needed: verificationRecords.length > 0,
      verification_records: verificationRecords,
      misconfigured: dnsConfig.misconfigured || false,
      dns_instructions: dnsInstructions,
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
    const apex = isApexDomain(domain);
    const subPrefix = !apex ? getSubdomainPrefix(domain) : null;
    console.log(`   Verifying domain: ${domain} (${apex ? 'apex' : 'subdomain'})`);

    const dnsConfig = await fetchVercelDnsConfig(domain);
    console.log(`   Expected: ${apex ? `A=${dnsConfig.aRecord}` : `CNAME=${dnsConfig.cnameRecord}`}`);

    // Step 1: Vercel verification
    let vercelVerified = false;
    let verificationRecords = [];
    if (VERCEL_TOKEN && VERCEL_PROJECT_ID) {
      try {
        const vercelResult = await vercelRequest('POST', `/v9/projects/${VERCEL_PROJECT_ID}/domains/${domain}/verify`);
        vercelVerified = vercelResult.verified === true;
        console.log(`   📋 Vercel verification: ${vercelVerified}`);
        if (!vercelVerified) {
          const records = extractVerificationRecords(vercelResult);
          if (records.length > 0) verificationRecords = records;
        }
      } catch (err) {
        console.log(`   ⚠️ Vercel verification failed:`, err.message);
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

    if (apex) {
      // Apex: check A record
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
    }

    // Check CNAME (for subdomains this is the primary check, for apex it's backup)
    if (!dnsVerified) {
      try {
        const cnameRecords = await dns.resolveCname(domain);
        dnsDetails.cname_records = cnameRecords;
        console.log(`   CNAME records found:`, cnameRecords);
        if (cnameRecords.some(r => r.toLowerCase().includes('vercel'))) {
          dnsVerified = true;
          console.log(`   ✅ CNAME points to Vercel`);
        }
      } catch (e) { console.log(`   No CNAME record found`); }
    }

    // CRITICAL FIX: Do not mark as verified if Vercel requires TXT ownership
    // verification, even if DNS records point correctly to Vercel.
    const isVerified = vercelVerified || (dnsVerified && verificationRecords.length === 0);

    if (isVerified) {
      await supabase.from('agencies').update({ domain_verified: true, updated_at: new Date().toISOString() }).eq('id', agencyId);
      console.log(`   ✅ Domain verified: ${domain}`);
    } else {
      console.log(`   ⏳ Domain not yet verified${verificationRecords.length > 0 ? ' (TXT ownership verification pending)' : ''}`);
    }

    res.json({
      verified: isVerified,
      vercel_verified: vercelVerified,
      dns_verified: dnsVerified,
      dns_details: dnsDetails,
      is_subdomain: !apex,
      subdomain_prefix: subPrefix,
      expected_a_record: apex ? dnsConfig.aRecord : null,
      expected_cname: dnsConfig.cnameRecord,
      verification_needed: verificationRecords.length > 0,
      verification_records: verificationRecords,
      message: isVerified
        ? 'Domain verified successfully!'
        : verificationRecords.length > 0
          ? `This domain requires ownership verification. Add the TXT record shown below at your domain registrar, then try verifying again.`
          : apex
            ? `DNS records not found. Please set your A record to ${dnsConfig.aRecord} and CNAME (www) to ${dnsConfig.cnameRecord}. Allow up to 48 hours for propagation.`
            : `DNS record not found. Please set a CNAME record for "${subPrefix}" pointing to ${dnsConfig.cnameRecord}. Allow up to 48 hours for propagation.`,
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
    const apex = isApexDomain(domain);
    console.log(`   Removing domain: ${domain} (${apex ? 'apex' : 'subdomain'})`);

    if (VERCEL_TOKEN && VERCEL_PROJECT_ID) {
      // Always remove the primary domain
      try { await vercelRequest('DELETE', `/v9/projects/${VERCEL_PROJECT_ID}/domains/${domain}`); console.log(`   ✅ Primary domain removed from Vercel`); } catch (err) { console.log(`   ⚠️ Could not remove primary:`, err.message); }
      // Only remove www for apex domains
      if (apex) {
        try { await vercelRequest('DELETE', `/v9/projects/${VERCEL_PROJECT_ID}/domains/www.${domain}`); console.log(`   ✅ WWW removed from Vercel`); } catch (err) { console.log(`   ⚠️ Could not remove www:`, err.message); }
      }
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
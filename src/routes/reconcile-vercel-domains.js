// ============================================================================
// RECONCILE VERCEL DOMAINS - Cron Handler
// ----------------------------------------------------------------------------
// Backstop for orphaned custom domains on the Vercel project. When an agency
// changes or removes a custom domain, the DELETE route tries to detach the old
// one from Vercel, but that call is non-fatal: if it fails, the DB moves on and
// the old domain stays attached to the project, still serving/redirecting, and
// nothing else catches it. That is the "new domain verified but the original
// still shows" bug. This sweep lists every domain on the Vercel project and
// detaches any CUSTOM domain that no longer matches any agency's
// marketing_domain.
//
// SAFETY (this endpoint deletes Vercel domains, so it is deliberately paranoid):
//   - Platform domains are NEVER touched: anything ending in
//     .myvoiceaiconnect.com (all agency slug subdomains + the app itself) or
//     .vercel.app, the apex platform domains, and anything in the
//     VERCEL_PROTECTED_DOMAINS env list.
//   - It only ever detaches a CUSTOM domain that NO agency references.
//   - If zero agency domains load but the project has custom domains, it aborts
//     (treats it as a data-load failure rather than nuking everything).
//   - apply mode refuses to detach more than VERCEL_RECONCILE_MAX (default 50)
//     in one run.
//   - Dry-run by default; you must pass ?apply=true to detach.
//
// POST /api/cron/reconcile-vercel-domains            → dry run (lists orphans)
// POST /api/cron/reconcile-vercel-domains?apply=true → actually detach
// Auth: same x-cron-secret header as the other cron routes.
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');

const VERCEL_API = 'https://api.vercel.com';
const VERCEL_TOKEN = process.env.VERCEL_API_TOKEN || process.env.VERCEL_TOKEN;
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID;

// Suffixes that are ALWAYS platform-owned and never detached.
const PROTECTED_SUFFIXES = ['.myvoiceaiconnect.com', '.vercel.app'];
// Exact platform domains never detached, plus anything the operator adds via env.
const PROTECTED_EXACT = new Set(
  ['myvoiceaiconnect.com', 'www.myvoiceaiconnect.com']
    .concat((process.env.VERCEL_PROTECTED_DOMAINS || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean))
);

async function vercelRequest(method, endpoint, body = null) {
  const separator = endpoint.includes('?') ? '&' : '?';
  const teamParam = VERCEL_TEAM_ID ? `${separator}teamId=${VERCEL_TEAM_ID}` : '';
  const options = { method, headers: { 'Authorization': `Bearer ${VERCEL_TOKEN}`, 'Content-Type': 'application/json' } };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(`${VERCEL_API}${endpoint}${teamParam}`, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error?.message || data.error?.code || `Vercel API ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return data;
}

function isProtected(name) {
  const n = (name || '').toLowerCase();
  if (!n) return true; // never touch a blank
  if (PROTECTED_EXACT.has(n)) return true;
  return PROTECTED_SUFFIXES.some(suffix => n.endsWith(suffix));
}

router.post('/reconcile-vercel-domains', async (req, res) => {
  const cronSecret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!VERCEL_TOKEN || !VERCEL_PROJECT_ID) {
    return res.status(500).json({ error: 'Vercel credentials not configured' });
  }

  const dryRun = req.query.apply !== 'true';
  const MAX_DETACH = parseInt(process.env.VERCEL_RECONCILE_MAX || '50', 10);

  try {
    // 1. Every custom domain any agency currently uses (+ www variants) = keep set.
    //    Pending (unverified) domains are still in marketing_domain, so they are
    //    correctly kept and never detached mid-setup.
    const { data: agencies, error } = await supabase
      .from('agencies')
      .select('marketing_domain')
      .not('marketing_domain', 'is', null);
    if (error) return res.status(500).json({ error: error.message });

    const keep = new Set();
    for (const a of agencies || []) {
      const d = (a.marketing_domain || '').toLowerCase().trim();
      if (d) { keep.add(d); keep.add(`www.${d}`); }
    }

    // 2. List every domain on the Vercel project (paginated).
    let vercelDomains = [];
    let until = null;
    for (let page = 0; page < 25; page++) {
      const q = `/v9/projects/${VERCEL_PROJECT_ID}/domains?limit=100${until ? `&until=${until}` : ''}`;
      const data = await vercelRequest('GET', q);
      const batch = data.domains || [];
      vercelDomains = vercelDomains.concat(batch);
      const next = data.pagination && data.pagination.next;
      if (!next || batch.length === 0) break;
      until = next;
    }

    const customNames = vercelDomains
      .map(d => (d.name || '').toLowerCase())
      .filter(name => name && !isProtected(name));

    // SAFETY: zero agency domains loaded but the project has custom domains ==
    // almost certainly a data-load problem. Refuse rather than mass-detach.
    if (keep.size === 0 && customNames.length > 0) {
      return res.status(409).json({
        error: 'Aborting: no agency domains loaded but the project has custom domains. Refusing to detach (likely a data-load issue).',
        vercelDomainCount: vercelDomains.length,
        customDomainCount: customNames.length,
      });
    }

    // 3. Orphans = custom project domains no agency references.
    const orphans = customNames.filter(name => !keep.has(name));

    // SAFETY: cap how many we detach in one apply run.
    if (!dryRun && orphans.length > MAX_DETACH) {
      return res.status(409).json({
        error: `Refusing to detach ${orphans.length} domains in one run (cap ${MAX_DETACH}). Review the dry run first, or raise VERCEL_RECONCILE_MAX.`,
        orphansFound: orphans.length,
        sample: orphans.slice(0, 20),
      });
    }

    const results = [];
    for (const name of orphans) {
      if (dryRun) { results.push({ domain: name, action: 'would_detach' }); continue; }
      try {
        await vercelRequest('DELETE', `/v9/projects/${VERCEL_PROJECT_ID}/domains/${name}`);
        console.log(`🧹 Detached orphaned Vercel domain: ${name}`);
        results.push({ domain: name, action: 'detached' });
      } catch (e) {
        console.error(`❌ Failed to detach ${name}:`, e.message);
        results.push({ domain: name, action: 'error', error: e.message });
      }
    }

    return res.json({
      success: true,
      dryRun,
      vercelDomainCount: vercelDomains.length,
      agencyDomainCount: keep.size,
      orphansFound: orphans.length,
      detached: results.filter(r => r.action === 'detached').length,
      results,
    });
  } catch (e) {
    console.error('❌ reconcile-vercel-domains error:', e);
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;
#!/usr/bin/env node
/**
 * CLAIMS / PRICING AUDIT  (credential-free, sitemap-based)
 *
 * The generation gate only validates NEW posts. This sweeps posts that are
 * ALREADY published and live, looking for the things that gate would catch:
 * off-list or banned pricing, and CallBird artifacts leaking into the
 * white-label VoiceAI Connect brand. Runs against the live site over HTTP,
 * so it needs no database or API keys.
 *
 *   node claims-audit.mjs                (human report)
 *   node claims-audit.mjs --json         (machine output)
 *
 * Fill validPrices once you confirm current pricing to activate off-list flags.
 */

const SITE = 'https://www.myvoiceaiconnect.com';
const SITEMAP = `${SITE}/sitemap.xml`;

const CONFIG = {
  validPrices: [],                 // e.g. ['$99','$299','$499'] -> then off-list prices get flagged
  bannedPrices: [],                // VAC-specific prices that must never appear (NOT $49: legit in blog context)
  priceRange: [20, 600],           // only monthly-looking $ amounts in this band are judged
  callbirdArtifacts: [             // true white-label leaks only (A2P/SOC2 are generic, not leaks)
    'callbirdai.com', 'callbird', '(505) 594-5806', '505-594-5806', '+15055945806',
  ],
};

async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'claims-audit/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function stripToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

function priceContext(text, priceStr, idx) {
  const start = Math.max(0, idx - 45);
  const end = Math.min(text.length, idx + priceStr.length + 45);
  return ('...' + text.slice(start, end) + '...').replace(/\s+/g, ' ');
}

async function collectPostUrls() {
  const xml = await get(SITEMAP);
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim());
  // blog posts only
  return [...new Set(locs.filter(u => /\/blog\/[a-z0-9-]+$/i.test(u)))];
}

async function auditPost(url) {
  const html = await get(url);
  const text = stripToText(html);
  const lower = text.toLowerCase();
  const htmlLower = html.toLowerCase();

  // distinct $ amounts in the monthly band
  const rawPrices = text.match(/\$\d[\d,]*/g) || [];
  const bandPrices = [...new Set(rawPrices)].filter(p => {
    const n = parseInt(p.replace(/[$,]/g, ''), 10);
    return n >= CONFIG.priceRange[0] && n <= CONFIG.priceRange[1];
  });

  const flags = [];
  // banned
  for (const b of CONFIG.bannedPrices) {
    if (bandPrices.includes(b)) {
      const idx = text.indexOf(b);
      flags.push({ level: 'ERROR', kind: 'banned_price', detail: b, ctx: priceContext(text, b, idx) });
    }
  }
  // off-list (only if allowlist configured)
  if (CONFIG.validPrices.length) {
    for (const p of bandPrices) {
      if (!CONFIG.validPrices.includes(p) && !CONFIG.bannedPrices.includes(p)) {
        const idx = text.indexOf(p);
        flags.push({ level: 'ERROR', kind: 'off_list_price', detail: p, ctx: priceContext(text, p, idx) });
      }
    }
  }
  // CallBird artifacts (white-label leak)
  for (const a of CONFIG.callbirdArtifacts) {
    if (lower.includes(a) || htmlLower.includes(a)) {
      flags.push({ level: 'ERROR', kind: 'callbird_leak', detail: a });
    }
  }

  return { url, slug: url.split('/blog/')[1], bandPrices, flags };
}

async function main() {
  const jsonOut = process.argv.includes('--json');
  const urls = await collectPostUrls();
  if (!jsonOut) console.error(`Scanning ${urls.length} live blog posts...\n`);

  const results = [];
  for (const url of urls) {
    try { results.push(await auditPost(url)); }
    catch (e) { results.push({ url, error: e.message, bandPrices: [], flags: [] }); }
  }

  // global price distribution
  const dist = {};
  for (const r of results) for (const p of r.bandPrices) dist[p] = (dist[p] || 0) + 1;

  if (jsonOut) { console.log(JSON.stringify({ results, distribution: dist }, null, 2)); return; }

  const flagged = results.filter(r => r.flags.length);
  console.log('=== PRICE DISTRIBUTION (how many posts mention each $ amount) ===');
  for (const [p, c] of Object.entries(dist).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${p.padEnd(8)} ${c} post(s)`);
  }
  console.log(`\n=== FLAGGED POSTS (${flagged.length} of ${results.length}) ===`);
  for (const r of flagged) {
    console.log(`\n${r.slug}`);
    for (const f of r.flags) console.log(`  [${f.level}] ${f.kind}: ${f.detail}${f.ctx ? `  ${f.ctx}` : ''}`);
  }
  const errs = results.filter(r => r.error);
  if (errs.length) { console.log(`\n=== FETCH ERRORS (${errs.length}) ===`); errs.forEach(r => console.log(`  ${r.url}: ${r.error}`)); }
  console.log(`\nDone. ${flagged.length} flagged, ${results.length - flagged.length - errs.length} clean, ${errs.length} errors.`);
  if (!CONFIG.validPrices.length) console.log('Note: validPrices empty -> only $49 and CallBird leaks flagged. Set validPrices to catch off-list prices.');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });

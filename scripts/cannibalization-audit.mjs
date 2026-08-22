#!/usr/bin/env node
//
// Cannibalization + duplicate-content audit for VoiceAI Connect.
//
// Reads your PUBLIC sitemap (no credentials, no dependencies, nothing to
// install) to get every indexable URL, then reports where landing pages and
// blog posts compete for the same search intent. Because it reads the live
// sitemap, it covers static AND dynamically generated blog posts.
//
// Run:
//   node scripts/cannibalization-audit.mjs
//   node scripts/cannibalization-audit.mjs https://www.myvoiceaiconnect.com/sitemap.xml
//   node scripts/cannibalization-audit.mjs --json      (also writes cannibalization.json)
//
// Requires Node 18+ (uses global fetch). No env vars.

const SITE = 'https://www.myvoiceaiconnect.com';
const SITEMAP_URL = process.argv.find((a) => a.startsWith('http')) || `${SITE}/sitemap.xml`;
const OVERLAP_THRESHOLD = 0.40; // IDF-weighted Jaccard; >= this = competing intent
const WANT_JSON = process.argv.includes('--json');

// Landing / money pages: the primary query each is meant to win. This enriches
// the landing page's intent signature and marks it as the commercial target.
// Any sitemap URL not listed here and not under /blog/ is ignored.
const LANDING_KEYWORDS = {
  '/platform': 'white label ai receptionist platform for agencies',
  '/how-it-works': 'how the ai receptionist agency platform works',
  '/faq': 'ai receptionist agency faq',
  '/ai-receptionist-agency-pricing': 'ai receptionist agency pricing',
  '/ai-receptionist-answering-service-reseller': 'ai answering service reseller program',
  '/best-white-label-ai-receptionist-platforms': 'best white label ai receptionist platforms',
  '/gohighlevel-ai-receptionist': 'gohighlevel ai receptionist alternative',
  '/how-much-can-you-make-ai-receptionist-reseller': 'how much can you make reselling ai receptionists',
  '/how-to-start-ai-receptionist-agency': 'how to start an ai receptionist agency',
  '/voiceai-connect-vs-bland-ai': 'voiceai connect vs bland ai',
  '/voiceai-connect-vs-synthflow': 'voiceai connect vs synthflow',
  '/what-is-white-label-ai-receptionist': 'what is a white label ai receptionist',
  '/white-label-ai-receptionist-marketing-agencies': 'white label ai receptionist for marketing agencies',
  '/white-label-vs-build-your-own': 'white label vs build your own ai receptionist',
};

// ----------------------------------------------------------------------------
// Fetch + parse sitemap (handles a plain urlset or a sitemap index)
// ----------------------------------------------------------------------------
async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'cannibalization-audit' } });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.text();
}

function extractLocs(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].trim());
}

async function collectUrls(sitemapUrl) {
  const xml = await fetchText(sitemapUrl);
  if (/<sitemapindex/i.test(xml)) {
    const children = extractLocs(xml);
    const all = [];
    for (const child of children) {
      try { all.push(...extractLocs(await fetchText(child))); }
      catch (e) { console.warn(`  (skipped child sitemap ${child}: ${e.message})`); }
    }
    return all;
  }
  return extractLocs(xml);
}

// ----------------------------------------------------------------------------
// Classify each URL into landing / blog / (ignored)
// ----------------------------------------------------------------------------
function classify(rawUrl) {
  let path;
  try { path = new URL(rawUrl).pathname.replace(/\/+$/, '') || '/'; }
  catch { return null; }

  if (Object.prototype.hasOwnProperty.call(LANDING_KEYWORDS, path)) {
    return { url: SITE + path, slug: path.split('/').filter(Boolean).pop() || path, type: 'landing',
      signature: path.replace(/\//g, ' ') + ' ' + LANDING_KEYWORDS[path] };
  }
  const blog = path.match(/^\/blog\/([^/]+)$/);
  if (blog) {
    const slug = blog[1];
    return { url: `${SITE}/blog/${slug}`, slug, type: 'blog', signature: slug.replace(/-/g, ' ') };
  }
  return null; // homepage, signup, legal, category pages, etc.
}

// ----------------------------------------------------------------------------
// Text similarity (IDF-weighted so shared rare tokens matter, common ones do not)
// ----------------------------------------------------------------------------
const STOP = new Set(['the','a','an','to','for','and','of','or','vs','your','you','how','what','is','are','can','do','in','on','with','from']);

function tokenize(str) {
  const set = new Set();
  for (const w of String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')) {
    if (w && !STOP.has(w)) set.add(w);
  }
  return set;
}
function buildIdf(corpus) {
  const df = new Map();
  for (const it of corpus) for (const t of it.tokens) df.set(t, (df.get(t) || 0) + 1);
  const N = corpus.length, idf = new Map();
  for (const [t, d] of df) idf.set(t, Math.log((N + 1) / (d + 0.5)));
  return idf;
}
function weightedSim(a, b, idf) {
  if (!a.size || !b.size) return 0;
  let inter = 0, union = 0; const seen = new Set();
  for (const t of a) { const w = idf.get(t) || 0; union += w; if (b.has(t)) inter += w; seen.add(t); }
  for (const t of b) if (!seen.has(t)) union += idf.get(t) || 0;
  return union > 0 ? inter / union : 0;
}

// ----------------------------------------------------------------------------
// Cluster (single-linkage union-find) + collect ranked pairs
// ----------------------------------------------------------------------------
function analyze(corpus, idf) {
  const parent = corpus.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

  const pairs = [];
  for (let i = 0; i < corpus.length; i++) {
    for (let j = i + 1; j < corpus.length; j++) {
      const sim = weightedSim(corpus[i].tokens, corpus[j].tokens, idf);
      const slugCollision = corpus[i].slug === corpus[j].slug;
      if (slugCollision || sim >= OVERLAP_THRESHOLD) {
        union(i, j);
        pairs.push({ a: corpus[i], b: corpus[j], sim: Number(sim.toFixed(2)), slugCollision });
      }
    }
  }
  const groups = new Map();
  for (let i = 0; i < corpus.length; i++) { const r = find(i); (groups.get(r) || groups.set(r, []).get(r)).push(i); }
  const clusters = [...groups.values()].filter((g) => g.length > 1)
    .map((g) => g.map((i) => corpus[i])).sort((a, b) => b.length - a.length);
  pairs.sort((x, y) => y.sim - x.sim);
  return { clusters, pairs };
}

const typeRank = (t) => (t === 'landing' ? 0 : 1);
function pickCanonical(members) {
  const landing = members.find((m) => m.type === 'landing');
  return landing || members[0];
}

// ----------------------------------------------------------------------------
async function main() {
  console.log('VoiceAI Connect cannibalization audit');
  console.log('=====================================');
  console.log(`Sitemap: ${SITEMAP_URL}`);

  const rawUrls = await collectUrls(SITEMAP_URL);
  const seen = new Set();
  const corpus = [];
  for (const raw of rawUrls) {
    const item = classify(raw);
    if (item && !seen.has(item.url)) { seen.add(item.url); corpus.push(item); }
  }
  for (const it of corpus) it.tokens = tokenize(it.signature);

  const nLanding = corpus.filter((c) => c.type === 'landing').length;
  const nBlog = corpus.filter((c) => c.type === 'blog').length;
  console.log(`URLs in sitemap:    ${rawUrls.length}`);
  console.log(`Landing pages:      ${nLanding}`);
  console.log(`Blog posts:         ${nBlog}`);
  console.log(`Total audited:      ${corpus.length}`);
  console.log('');

  // Exact slug collisions (landing vs blog at the same slug).
  const bySlug = new Map();
  for (const it of corpus) (bySlug.get(it.slug) || bySlug.set(it.slug, []).get(it.slug)).push(it);
  const collisions = [...bySlug.values()].filter((g) => g.length > 1);
  console.log(`## Exact slug collisions: ${collisions.length}`);
  for (const g of collisions) {
    console.log(`  ! ${g[0].slug}`);
    for (const m of g.sort((a, b) => typeRank(a.type) - typeRank(b.type))) console.log(`      [${m.type}] ${m.url}`);
  }
  console.log('');

  const idf = buildIdf(corpus);
  const { clusters, pairs } = analyze(corpus, idf);

  const topPairs = pairs.filter((p) => !p.slugCollision).slice(0, 20);
  console.log(`## Closest page pairs (top ${topPairs.length} by weighted overlap)`);
  for (const pr of topPairs) console.log(`  ${pr.sim}  ${pr.a.url.replace(SITE, '')}  <>  ${pr.b.url.replace(SITE, '')}`);
  console.log('');

  console.log(`## Competing-intent clusters (overlap >= ${OVERLAP_THRESHOLD}): ${clusters.length}`);
  console.log('');
  const jsonClusters = [];
  clusters.forEach((members, n) => {
    const sorted = [...members].sort((a, b) => typeRank(a.type) - typeRank(b.type));
    const canonical = pickCanonical(sorted);
    console.log(`Cluster ${n + 1}  (${members.length} pages)`);
    for (const m of sorted) console.log(`  ${m === canonical ? 'KEEP  ' : 'review'} [${m.type}] ${m.url}`);
    console.log(`  suggested canonical: ${canonical.url}`);
    console.log('');
    jsonClusters.push({ canonical: canonical.url, members: sorted.map((m) => ({ url: m.url, type: m.type })) });
  });

  if (WANT_JSON) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync('cannibalization.json', JSON.stringify({
      generatedAt: new Date().toISOString(),
      sitemap: SITEMAP_URL,
      totals: { landing: nLanding, blog: nBlog },
      collisions: collisions.map((g) => ({ slug: g[0].slug, urls: g.map((m) => m.url) })),
      closestPairs: topPairs.map((p) => ({ sim: p.sim, a: p.a.url, b: p.b.url })),
      clusters: jsonClusters,
    }, null, 2));
    console.log('Wrote cannibalization.json');
  }

  console.log('Note: clusters are single-linkage families (loosely related pages');
  console.log('can chain together); the closest-pairs list is the precise view.');
  console.log('Confirm winners against Search Console before you 301 or canonicalize.');
}

main().catch((err) => { console.error('Audit failed:', err.message); process.exit(1); });

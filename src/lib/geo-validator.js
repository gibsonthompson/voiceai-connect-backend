//
// Pre-publish GEO validator for the blog farm.
//
// Mechanically checks a generated post against the GEO content spec and returns
// a report with a pass/fail verdict and exactly which levers are missing. Run it
// right before publish, alongside the cannibalization guard: if it fails, hold
// the draft or regenerate. It cannot judge tone or truth (that is the
// generation prompt's job), but it enforces the structural levers the Princeton
// study found actually move AI citations: statistics, quotations, inline
// citations, a self-contained answer block, real depth, and no keyword stuffing.
//
// ESM, no dependencies (works in Node 18+). CommonJS: swap `export` for
// `module.exports`.
//
// Usage:
//   import { validatePost } from './geo-validator.mjs';
//   const report = validatePost({ title, html, meta: { author, publishDate, primaryKeyword } });
//   if (!report.pass) { hold(draft, report.blockers); }   // else publish

const SITE_HOST = 'myvoiceaiconnect.com';

// Thresholds (tune to taste).
const MIN_WORDS = 700;
const MIN_STATS_WARN = 2;
const MIN_H2 = 3;
const LEAD_MIN = 25;   // words in the opening answer block
const LEAD_MAX = 80;
const KW_DENSITY_MAX = 0.035; // 3.5% -> stuffing

function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function words(text) {
  return text ? text.split(/\s+/).filter(Boolean) : [];
}

function firstParagraph(html) {
  const m = String(html || '').match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  if (m) return stripTags(m[1]);
  // no <p> tags (plain text / markdown) -> first non-heading line
  const text = stripTags(html);
  return text.split(/(?<=[.!?])\s/)[0] || text.slice(0, 400);
}

function countStats(text) {
  const patterns = [
    /\b\d{1,3}(?:\.\d+)?\s?%/g,               // 41%, 3.2 %
    /\$\s?\d[\d,]*(?:\.\d+)?/g,                 // $3,000
    /\b\d[\d,]{2,}(?:\.\d+)?\b/g,               // 900,000 / 10000
    /\b\d+(?:\.\d+)?\s?(?:x|times|percent|million|billion|thousand|k|hours?|minutes?|seconds?|days?)\b/gi,
  ];
  const hits = new Set();
  for (const re of patterns) { const m = text.match(re); if (m) m.forEach((h) => hits.add(h.trim().toLowerCase())); }
  return hits.size;
}

function countQuotes(html) {
  const text = stripTags(html);
  let n = 0;
  if (/<blockquote/i.test(html)) n += (html.match(/<blockquote/gi) || []).length;
  // straight or curly quotes wrapping 15+ chars
  const q = text.match(/["\u201C][^"\u201C\u201D]{15,}["\u201D]/g);
  if (q) n += q.length;
  return n;
}

function countExternalCitations(html) {
  const links = [...String(html || '').matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  const ext = links.filter((h) => {
    if (!/^https?:\/\//i.test(h)) return false;
    try { return !new URL(h).host.includes(SITE_HOST); } catch { return false; }
  });
  return new Set(ext).size;
}

function countH2(html) {
  return (String(html || '').match(/<h2[\s>]/gi) || []).length
      || (String(html || '').match(/^##\s/gm) || []).length; // markdown fallback
}

function keywordDensity(text, keyword) {
  if (!keyword) return 0;
  const w = words(text);
  if (!w.length) return 0;
  const kw = keyword.toLowerCase().trim();
  const body = text.toLowerCase();
  let count = 0, i = 0;
  while ((i = body.indexOf(kw, i)) !== -1) { count++; i += kw.length; }
  // approximate density by keyword-instances * keyword-wordlength / total words
  return (count * kw.split(/\s+/).length) / w.length;
}

function validatePost(post, opts = {}) {
  const html = post.html || post.html_content || post.content || '';
  const meta = post.meta || post;
  const text = stripTags(html);
  const wc = words(text).length;
  const lead = words(firstParagraph(html)).length;
  const stats = countStats(text);
  const quotes = countQuotes(html);
  const citations = countExternalCitations(html);
  const h2 = countH2(html);
  const primaryKeyword = meta.primaryKeyword || meta.primary_keyword || opts.primaryKeyword;
  const density = keywordDensity(text, primaryKeyword);
  const hasAuthor = Boolean(meta.author && (meta.author.name || typeof meta.author === 'string'));
  const hasDate = Boolean(meta.publishDate || meta.publish_date || meta.publishedAt);

  const check = (id, label, ok, severity, detail) => ({ id, label, pass: ok, severity, detail });

  const checks = [
    check('depth', 'Not thin', wc >= MIN_WORDS, 'block', `${wc} words (min ${MIN_WORDS})`),
    check('statistics', 'Has statistics', stats >= 1, 'block', `${stats} numeric stat(s)`),
    check('citations', 'Cites external sources', citations >= 2, 'block', `${citations} external link(s) (min 2)`),
    check('no_stuffing', 'No keyword stuffing', density <= KW_DENSITY_MAX, 'block', primaryKeyword ? `${(density * 100).toFixed(1)}% density` : 'no primary keyword provided'),
    check('stats_depth', 'Enough statistics', stats >= MIN_STATS_WARN, 'warn', `${stats} of ${MIN_STATS_WARN} recommended`),
    check('quotation', 'Has a direct quotation', quotes >= 1, 'warn', `${quotes} quote(s)`),
    check('lead_answer', 'Front-loaded answer block', lead >= LEAD_MIN && lead <= LEAD_MAX, 'warn', `opening block ${lead} words (target 40-60)`),
    check('structure', 'Enough H2 sections', h2 >= MIN_H2, 'warn', `${h2} H2(s) (min ${MIN_H2})`),
    check('author', 'Named author', hasAuthor, 'warn', hasAuthor ? 'present' : 'missing'),
    check('date', 'Publish date', hasDate, 'warn', hasDate ? 'present' : 'missing'),
  ];

  const blockers = checks.filter((c) => !c.pass && c.severity === 'block');
  const warnings = checks.filter((c) => !c.pass && c.severity === 'warn');
  const passedCount = checks.filter((c) => c.pass).length;

  return {
    pass: blockers.length === 0,
    score: Math.round((passedCount / checks.length) * 100),
    blockers,
    warnings,
    checks,
    metrics: { words: wc, lead, stats, quotes, citations, h2, density: Number(density.toFixed(3)) },
  };
}

module.exports = { validatePost };

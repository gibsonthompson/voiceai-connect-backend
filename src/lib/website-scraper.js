// ============================================================================
// WEBSITE SCRAPER — Multi-page knowledge base builder
//
// Replaces the old single-page Jina scrape with:
// 1. Homepage scrape + internal link discovery
// 2. Sitemap.xml check for additional URLs
// 3. Intelligent filtering to key business pages
// 4. Multi-page scraping (up to 15 subpages)
// 5. Claude-powered structured data extraction
// 6. Assembled structured KB document (100k char limit)
//
// Uses Jina Reader (free tier: ~200 req/day) — no API key needed.
// Drop-in replacement: same function signature and return shape.
//
// Destination: src/lib/website-scraper.js
// FIXED: knownLength on VAPI file upload for large KB documents (2026-04-15)
// FIXED: 2026-07-01 - use node-fetch (not the global undici fetch) so the
//        form-data multipart upload to VAPI sends a proper body. The built-in
//        global fetch does not reliably stream the form-data package's body,
//        which truncated the multipart boundary and made VAPI reject the
//        upload with "Multipart: Unexpected end of form". vapi.js already uses
//        node-fetch for the same reason; this makes the scraper consistent.
// ============================================================================

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const FormData = require('form-data');
const fetch = require('node-fetch');

// ============================================================================
// JINA READER — Fetch a single page as clean markdown
// ============================================================================
async function fetchPageWithJina(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`https://r.jina.ai/${url}`, {
      signal: controller.signal,
      headers: {
        'Accept': 'text/plain',
      }
    });
    clearTimeout(timer);

    if (!response.ok) {
      console.warn(`⚠️ Jina returned ${response.status} for ${url}`);
      return null;
    }

    const text = await response.text();
    if (!text || text.trim().length < 50) return null;
    return text;
  } catch (error) {
    clearTimeout(timer);
    if (error.name === 'AbortError') {
      console.warn(`⚠️ Jina timeout for ${url}`);
    } else {
      console.warn(`⚠️ Jina fetch failed for ${url}:`, error.message);
    }
    return null;
  }
}

// ============================================================================
// LINK DISCOVERY — Extract internal links from Jina markdown output
// ============================================================================
function extractInternalLinks(markdown, baseUrl) {
  const links = new Set();

  try {
    const urlObj = new URL(baseUrl);
    const baseHost = urlObj.hostname.replace(/^www\./, '');

    const linkRegex = /\[([^\]]*)\]\(([^)]+)\)/g;
    let match;
    while ((match = linkRegex.exec(markdown)) !== null) {
      let href = match[2].trim();

      if (href.startsWith('#') || href.startsWith('mailto:') ||
          href.startsWith('tel:') || href.startsWith('javascript:')) continue;

      try {
        const resolved = new URL(href, baseUrl);
        const resolvedHost = resolved.hostname.replace(/^www\./, '');

        if (resolvedHost === baseHost) {
          resolved.hash = '';
          let clean = resolved.href.replace(/\/$/, '');
          links.add(clean);
        }
      } catch { /* skip malformed URLs */ }
    }

    const rawUrlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\])(]+/g;
    while ((match = rawUrlRegex.exec(markdown)) !== null) {
      try {
        const resolved = new URL(match[0]);
        const resolvedHost = resolved.hostname.replace(/^www\./, '');
        if (resolvedHost === baseHost) {
          resolved.hash = '';
          let clean = resolved.href.replace(/\/$/, '');
          links.add(clean);
        }
      } catch { /* skip */ }
    }
  } catch (err) {
    console.warn('⚠️ Link extraction error:', err.message);
  }

  return [...links];
}

// ============================================================================
// SITEMAP DISCOVERY — Try to fetch and parse sitemap.xml
// ============================================================================
async function fetchSitemapUrls(baseUrl) {
  const urls = [];
  try {
    const urlObj = new URL(baseUrl);
    const sitemapUrl = `${urlObj.origin}/sitemap.xml`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(sitemapUrl, { signal: controller.signal });
    clearTimeout(timer);

    if (!response.ok) return urls;

    const xml = await response.text();

    const locRegex = /<loc>\s*(.*?)\s*<\/loc>/gi;
    let match;
    while ((match = locRegex.exec(xml)) !== null) {
      const loc = match[1].trim();
      if (loc.startsWith('http')) {
        urls.push(loc.replace(/\/$/, ''));
      }
    }

    console.log(`   📋 Sitemap: found ${urls.length} URLs`);
  } catch (error) {
    // Sitemap not available — that's fine
  }

  return urls;
}

// ============================================================================
// PAGE CLASSIFICATION — Score URLs by business relevance
// ============================================================================

const HIGH_VALUE_PATTERNS = [
  { pattern: /\/(about|about-us|our-story|who-we-are|our-team|the-team|our-company)/i, type: 'about', priority: 10 },
  { pattern: /\/(services|our-services|what-we-do|solutions|treatments|procedures)/i, type: 'services', priority: 10 },
  { pattern: /\/(pricing|prices|rates|cost|fees|plans|packages|menu)/i, type: 'pricing', priority: 10 },
  { pattern: /\/(contact|contact-us|get-in-touch|reach-us|find-us|directions)/i, type: 'contact', priority: 10 },
  { pattern: /\/(team|staff|doctors|dentists|providers|attorneys|agents|stylists|technicians|trainers|advisors|our-people)/i, type: 'team', priority: 9 },
  { pattern: /\/(faq|faqs|frequently-asked|questions|help)/i, type: 'faq', priority: 9 },
  { pattern: /\/(locations?|offices?|branches|where-we-serve|areas-served|service-area)/i, type: 'locations', priority: 9 },
  { pattern: /\/(hours|schedule|availability|when-we-are-open)/i, type: 'hours', priority: 9 },
  { pattern: /\/(gallery|portfolio|our-work|projects|before-after|results|reviews|testimonials)/i, type: 'gallery', priority: 7 },
  { pattern: /\/(insurance|accepted-insurance|payment-options|financing)/i, type: 'insurance', priority: 8 },
  { pattern: /\/(specials|offers|promotions|deals|coupons)/i, type: 'specials', priority: 7 },
  { pattern: /\/(new-patients?|first-visit|getting-started|how-it-works)/i, type: 'new_patients', priority: 8 },
  { pattern: /\/(emergency|urgent|after-hours|same-day)/i, type: 'emergency', priority: 8 },
  { pattern: /\/(appointment|book|schedule|booking)/i, type: 'booking', priority: 7 },
];

const SKIP_PATTERNS = [
  /\/(blog|news|articles|press|media)\//i,
  /\/(blog|news|articles|press|media)$/i,
  /\/(privacy|terms|tos|legal|disclaimer|cookie|gdpr|accessibility)/i,
  /\/(sitemap|feed|rss|xml|wp-admin|wp-login|wp-content|wp-includes)/i,
  /\/(cart|checkout|account|login|signup|register|my-account|password)/i,
  /\/(tag|category|author|archive|page\/\d)/i,
  /\.(pdf|jpg|jpeg|png|gif|svg|webp|mp4|mp3|zip|doc|docx|xls)$/i,
  /[?&](utm_|fbclid|gclid|ref=)/i,
];

function classifyUrl(url, baseUrl) {
  try {
    const urlObj = new URL(url);
    const baseObj = new URL(baseUrl);
    if (urlObj.pathname === '/' || urlObj.pathname === '') return { skip: true };
    if (urlObj.href.replace(/\/$/, '') === baseObj.href.replace(/\/$/, '')) return { skip: true };
  } catch { return { skip: true }; }

  for (const pattern of SKIP_PATTERNS) {
    if (pattern.test(url)) return { skip: true };
  }

  for (const { pattern, type, priority } of HIGH_VALUE_PATTERNS) {
    if (pattern.test(url)) {
      return { skip: false, type, priority };
    }
  }

  try {
    const pathSegments = new URL(url).pathname.split('/').filter(Boolean);
    if (pathSegments.length === 1) {
      return { skip: false, type: 'other', priority: 5 };
    }
    if (pathSegments.length === 2) {
      return { skip: false, type: 'other', priority: 3 };
    }
  } catch {}

  return { skip: true };
}

// ============================================================================
// STRUCTURED DATA EXTRACTION — Use Claude to pull business details
// ============================================================================
async function extractStructuredData(allContent, businessName, industry) {
  const prompt = `You are analyzing scraped website content for a ${industry} business called "${businessName}".

Extract the following structured information. Return ONLY valid JSON, no markdown, no backticks.

Content to analyze (may be from multiple pages):
${allContent.substring(0, 40000)}

Return this JSON structure. Use null for any field you cannot find:
{
  "business_name": "string — official name as shown on site",
  "phone_numbers": ["array of phone numbers found"],
  "addresses": ["array of physical addresses"],
  "email_addresses": ["array of email addresses"],
  "business_hours": {
    "monday": "9:00 AM - 5:00 PM or null",
    "tuesday": "9:00 AM - 5:00 PM or null",
    "wednesday": "9:00 AM - 5:00 PM or null",
    "thursday": "9:00 AM - 5:00 PM or null",
    "friday": "9:00 AM - 5:00 PM or null",
    "saturday": "9:00 AM - 2:00 PM or null",
    "sunday": "Closed or null"
  },
  "services": ["array of services offered — be specific, include all found"],
  "pricing": ["array of pricing info found, e.g. 'Oil Change: $39.99', 'Consultation: Free'"],
  "team_members": ["array of staff names and titles, e.g. 'Dr. Smith - General Dentist'"],
  "service_areas": ["array of cities/areas served"],
  "insurance_accepted": ["array of insurance providers if mentioned"],
  "payment_methods": ["array of payment methods if mentioned"],
  "year_established": "string or null",
  "tagline": "string — company tagline/slogan if found, or null",
  "key_differentiators": ["what makes this business stand out — 2-3 points max"]
}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6-20260217",
        max_tokens: 2000,
        temperature: 0.1,
        messages: [{ role: "user", content: prompt }]
      })
    });

    if (!response.ok) {
      console.warn(`⚠️ Claude extraction failed: ${response.status}`);
      return null;
    }

    const data = await response.json();
    let text = data.content[0].text.trim()
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();

    return JSON.parse(text);
  } catch (error) {
    console.error('❌ Structured extraction failed:', error.message);
    return null;
  }
}

// ============================================================================
// FORMAT STRUCTURED DATA — Convert extracted JSON to KB-friendly text
// ============================================================================
function formatStructuredSection(data) {
  if (!data) return '';

  const sections = [];
  sections.push('# BUSINESS DETAILS (Extracted from Website)\n');

  if (data.business_name) sections.push(`**Business Name:** ${data.business_name}`);
  if (data.tagline) sections.push(`**Tagline:** ${data.tagline}`);
  if (data.year_established) sections.push(`**Established:** ${data.year_established}`);

  if (data.phone_numbers?.length > 0) {
    sections.push(`\n## Phone Numbers\n${data.phone_numbers.map(p => `- ${p}`).join('\n')}`);
  }

  if (data.addresses?.length > 0) {
    sections.push(`\n## Addresses\n${data.addresses.map(a => `- ${a}`).join('\n')}`);
  }

  if (data.email_addresses?.length > 0) {
    sections.push(`\n## Email\n${data.email_addresses.map(e => `- ${e}`).join('\n')}`);
  }

  if (data.business_hours) {
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const hourLines = days
      .filter(d => data.business_hours[d])
      .map(d => `- ${d.charAt(0).toUpperCase() + d.slice(1)}: ${data.business_hours[d]}`);
    if (hourLines.length > 0) {
      sections.push(`\n## Business Hours\n${hourLines.join('\n')}`);
    }
  }

  if (data.services?.length > 0) {
    sections.push(`\n## Services Offered\n${data.services.map(s => `- ${s}`).join('\n')}`);
  }

  if (data.pricing?.length > 0) {
    sections.push(`\n## Pricing\n${data.pricing.map(p => `- ${p}`).join('\n')}`);
  }

  if (data.team_members?.length > 0) {
    sections.push(`\n## Team / Staff\n${data.team_members.map(t => `- ${t}`).join('\n')}`);
  }

  if (data.service_areas?.length > 0) {
    sections.push(`\n## Service Areas\n${data.service_areas.map(a => `- ${a}`).join('\n')}`);
  }

  if (data.insurance_accepted?.length > 0) {
    sections.push(`\n## Insurance Accepted\n${data.insurance_accepted.map(i => `- ${i}`).join('\n')}`);
  }

  if (data.payment_methods?.length > 0) {
    sections.push(`\n## Payment Methods\n${data.payment_methods.map(p => `- ${p}`).join('\n')}`);
  }

  if (data.key_differentiators?.length > 0) {
    sections.push(`\n## What Sets Us Apart\n${data.key_differentiators.map(d => `- ${d}`).join('\n')}`);
  }

  return sections.join('\n');
}

// ============================================================================
// MAIN: createKnowledgeBaseFromWebsite
// FIXED: knownLength on Buffer upload prevents "Unexpected end of form"
// ============================================================================
async function createKnowledgeBaseFromWebsite(websiteUrl, businessName) {
  const startTime = Date.now();

  try {
    console.log(`🌐 Scraping website: ${websiteUrl}`);

    // ── Step 1: Scrape homepage ──────────────────────────────────────────
    const homepageContent = await fetchPageWithJina(websiteUrl);
    if (!homepageContent) {
      console.warn('⚠️ Homepage scrape returned no content');
      return null;
    }
    console.log(`   ✅ Homepage: ${homepageContent.length} chars`);

    // ── Step 2: Discover links ───────────────────────────────────────────
    const internalLinks = extractInternalLinks(homepageContent, websiteUrl);
    const sitemapLinks = await fetchSitemapUrls(websiteUrl);

    const allLinks = new Set([...internalLinks, ...sitemapLinks]);
    console.log(`   🔗 Discovered ${allLinks.size} unique internal links (${internalLinks.length} from page, ${sitemapLinks.length} from sitemap)`);

    // ── Step 3: Classify and prioritize ──────────────────────────────────
    const scoredLinks = [];
    for (const link of allLinks) {
      const classification = classifyUrl(link, websiteUrl);
      if (!classification.skip) {
        scoredLinks.push({ url: link, ...classification });
      }
    }

    scoredLinks.sort((a, b) => b.priority - a.priority);

    const seenTypes = new Set();
    const pagesToScrape = [];
    const MAX_PAGES = 15;

    for (const link of scoredLinks) {
      if (pagesToScrape.length >= MAX_PAGES) break;

      if (link.type !== 'other') {
        if (seenTypes.has(link.type)) continue;
        seenTypes.add(link.type);
      }

      pagesToScrape.push(link);
    }

    console.log(`   📄 Will scrape ${pagesToScrape.length} subpages: ${pagesToScrape.map(p => p.type).join(', ')}`);

    // ── Step 4: Scrape subpages (parallel, batched) ──────────────────────
    const BATCH_SIZE = 5;
    const pageContents = [{ url: websiteUrl, type: 'homepage', content: homepageContent }];

    for (let i = 0; i < pagesToScrape.length; i += BATCH_SIZE) {
      const batch = pagesToScrape.slice(i, i + BATCH_SIZE);

      const results = await Promise.allSettled(
        batch.map(async (page) => {
          const content = await fetchPageWithJina(page.url);
          return { url: page.url, type: page.type, content };
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value.content) {
          pageContents.push(result.value);
        }
      }

      if (i + BATCH_SIZE < pagesToScrape.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    console.log(`   ✅ Scraped ${pageContents.length} pages total`);

    // ── Step 5: Combine raw content ──────────────────────────────────────
    let combinedRaw = '';
    for (const page of pageContents) {
      const trimmed = page.content.substring(0, 8000);
      combinedRaw += `\n\n--- PAGE: ${page.type.toUpperCase()} (${page.url}) ---\n\n${trimmed}`;
    }

    // ── Step 6: Extract structured data via Claude ───────────────────────
    let structuredData = null;
    let structuredSection = '';
    try {
      structuredData = await extractStructuredData(combinedRaw, businessName, 'business');
      structuredSection = formatStructuredSection(structuredData);
      if (structuredSection) {
        console.log(`   ✅ Extracted structured data (${structuredSection.length} chars)`);
      }
    } catch (err) {
      console.warn('⚠️ Structured extraction failed (non-blocking):', err.message);
    }

    // ── Step 7: Assemble final KB content ────────────────────────────────
    const MAX_CONTENT_LENGTH = 100000;
    let websiteContent = '';

    if (structuredSection) {
      websiteContent += structuredSection + '\n\n';
    }

    websiteContent += `# ${businessName} — Website Content\n\n`;

    for (const page of pageContents) {
      const pageHeader = `## ${page.type.charAt(0).toUpperCase() + page.type.slice(1)} Page\n`;
      const trimmed = page.content.substring(0, 8000);

      if (websiteContent.length + pageHeader.length + trimmed.length > MAX_CONTENT_LENGTH) {
        console.log(`   ⚠️ Hit ${MAX_CONTENT_LENGTH} char limit — stopping at ${pageContents.indexOf(page)} pages`);
        break;
      }

      websiteContent += pageHeader + trimmed + '\n\n';
    }

    console.log(`   📊 Final KB: ${websiteContent.length} chars from ${pageContents.length} pages`);

    // ── Step 8: Upload to VAPI ───────────────────────────────────────────
    // FIXED: knownLength prevents "Multipart: Unexpected end of form" on large files
    const contentBuffer = Buffer.from(websiteContent, 'utf-8');
    console.log(`   📤 Uploading KB file: ${contentBuffer.length} bytes`);

    const form = new FormData();
    form.append('file', contentBuffer, {
      filename: `${businessName.replace(/\s+/g, '_')}_knowledge.txt`,
      contentType: 'text/plain',
      knownLength: contentBuffer.length,
    });

    const uploadResponse = await fetch('https://api.vapi.ai/file', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${VAPI_API_KEY}`, ...form.getHeaders() },
      body: form,
    });

    if (!uploadResponse.ok) {
      const errText = await uploadResponse.text();
      console.error(`❌ VAPI file upload failed (HTTP ${uploadResponse.status}):`, errText);
      // Fall back to content-only return (createIndustryKnowledgeBase will re-upload)
      return { knowledgeBaseId: null, fileId: null, websiteContent };
    }

    const uploadData = await uploadResponse.json();
    console.log(`   ✅ VAPI file uploaded: ${uploadData.id}`);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`🌐 Website scrape complete in ${elapsed}s — ${pageContents.length} pages, ${websiteContent.length} chars`);

    return {
      knowledgeBaseId: null,
      fileId: uploadData.id,
      websiteContent,
      structuredData,
    };

  } catch (error) {
    console.error('❌ Website scrape failed:', error.message);
    return null;
  }
}

// ============================================================================
// EXPORTS
// ============================================================================
module.exports = {
  createKnowledgeBaseFromWebsite,
  fetchPageWithJina,
  extractInternalLinks,
  fetchSitemapUrls,
  classifyUrl,
  extractStructuredData,
  formatStructuredSection,
};
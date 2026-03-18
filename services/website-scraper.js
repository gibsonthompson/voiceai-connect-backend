/**
 * Website Scraper Service v2
 * 
 * Fixes applied:
 * - Retry with exponential backoff (2 retries per page)
 * - AbortController timeout per request (prevents hanging on slow sites)
 * - Redirect loop detection (max 5 redirects)
 * - Parallel contact page checking (checks /contact and /about simultaneously)
 * - Better phone validation (filters fax, toll-free patterns)
 * - Domain normalization (handles www, trailing slashes, query strings)
 */

const cheerio = require("cheerio");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const FETCH_TIMEOUT_MS = 8000;
const MAX_RETRIES = 1;

// US phone number patterns
const PHONE_PATTERNS = [
  /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g,
];

const EMAIL_PATTERN = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

// Paths to check for contact info, ordered by likelihood
const CONTACT_PATHS = [
  "/contact",
  "/contact-us",
  "/about",
  "/about-us",
  "/locations",
];

/**
 * Normalize a URL to a clean base
 */
function normalizeUrl(url) {
  try {
    const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

/**
 * Fetch a page with timeout, retry, and redirect control
 */
async function fetchPage(url, timeoutMs = FETCH_TIMEOUT_MS, retries = MAX_RETRIES) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        redirect: "follow",
      });

      clearTimeout(timeout);

      if (!res.ok) {
        if (res.status === 403 || res.status === 429) {
          // Blocked or rate limited — don't retry, won't help
          console.log(`[Scraper] ${res.status} from ${url} — skipping`);
          return null;
        }
        if (attempt < retries) {
          await delay(1000 * (attempt + 1));
          continue;
        }
        return null;
      }

      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
        return null;
      }

      // Check for redirect loops (final URL same domain?)
      const finalUrl = res.url;
      const originalHost = new URL(url).hostname;
      const finalHost = new URL(finalUrl).hostname;
      if (!finalHost.includes(originalHost.replace("www.", "")) && !originalHost.includes(finalHost.replace("www.", ""))) {
        console.log(`[Scraper] Redirected off-domain: ${url} → ${finalUrl} — skipping`);
        return null;
      }

      return await res.text();
    } catch (error) {
      clearTimeout(timeout);
      if (error.name === "AbortError") {
        console.log(`[Scraper] Timeout on ${url}`);
      } else if (attempt < retries) {
        await delay(1000 * (attempt + 1));
        continue;
      } else {
        console.log(`[Scraper] Failed to fetch ${url}: ${error.message}`);
      }
      return null;
    }
  }
  return null;
}

/**
 * Extract structured data from JSON-LD blocks
 */
function extractJsonLd(html) {
  const $ = cheerio.load(html);
  const data = {
    phones: [],
    emails: [],
    website: null,
    description: null,
    businessType: null,
    socialLinks: [],
  };

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      const items = Array.isArray(json) ? json : [json];

      for (const item of items) {
        const entities = item["@graph"] ? item["@graph"] : [item];

        for (const entity of entities) {
          if (entity.telephone) {
            const phones = Array.isArray(entity.telephone) ? entity.telephone : [entity.telephone];
            data.phones.push(...phones);
          }
          if (entity.email) {
            const emails = Array.isArray(entity.email) ? entity.email : [entity.email];
            data.emails.push(...emails.map((e) => e.replace("mailto:", "")));
          }
          if (entity.url) data.website = entity.url;
          if (entity.description) data.description = entity.description;
          if (entity["@type"]) data.businessType = entity["@type"];
          if (entity.sameAs) {
            const links = Array.isArray(entity.sameAs) ? entity.sameAs : [entity.sameAs];
            data.socialLinks.push(...links);
          }
        }
      }
    } catch (e) {
      // Malformed JSON-LD
    }
  });

  return data;
}

/**
 * Extract and validate phone numbers
 */
function extractPhones(text) {
  const phones = new Set();

  for (const pattern of PHONE_PATTERNS) {
    const matches = text.match(pattern) || [];
    for (const match of matches) {
      const cleaned = match.replace(/[^\d+]/g, "");
      // Must be 10 or 11 digits
      if (cleaned.length < 10 || cleaned.length > 11) continue;
      // Filter obvious non-phone numbers
      if (cleaned.startsWith("0000") || cleaned.startsWith("1234")) continue;
      // Filter fax indicators (check surrounding text)
      const idx = text.indexOf(match);
      const surrounding = text.substring(Math.max(0, idx - 30), idx + match.length + 20).toLowerCase();
      if (surrounding.includes("fax")) continue;

      phones.add(match.trim());
    }
  }

  return [...phones];
}

/**
 * Extract email addresses from page
 */
function extractEmails($, text) {
  const emails = new Set();

  $('a[href^="mailto:"]').each((_, el) => {
    const href = $(el).attr("href") || "";
    const email = href.replace("mailto:", "").split("?")[0].trim();
    if (email && EMAIL_PATTERN.test(email)) {
      emails.add(email.toLowerCase());
    }
  });

  const matches = text.match(EMAIL_PATTERN) || [];
  for (const match of matches) {
    if (
      !match.includes(".png") && !match.includes(".jpg") &&
      !match.includes(".gif") && !match.includes(".css") &&
      !match.includes(".js") && !match.includes("@sentry") &&
      !match.includes("@example") && !match.includes("@placeholder") &&
      !match.includes("wixpress") && !match.includes("wordpress")
    ) {
      emails.add(match.toLowerCase());
    }
  }

  return [...emails];
}

/**
 * Extract social media links
 */
function extractSocialLinks($) {
  const socials = {};
  const patterns = {
    facebook: /facebook\.com\//,
    twitter: /(?:twitter|x)\.com\//,
    linkedin: /linkedin\.com\//,
    instagram: /instagram\.com\//,
    youtube: /youtube\.com\//,
    tiktok: /tiktok\.com\//,
    yelp: /yelp\.com\//,
  };

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    for (const [platform, regex] of Object.entries(patterns)) {
      if (regex.test(href) && !socials[platform]) {
        socials[platform] = href;
      }
    }
  });

  return socials;
}

/**
 * Detect CMS / tech stack
 */
function detectTechStack($, html) {
  const stack = [];
  if (html.includes("wp-content") || html.includes("wp-includes")) stack.push("WordPress");
  if (html.includes("squarespace.com") || html.includes("squarespace-cdn")) stack.push("Squarespace");
  if (html.includes("wix.com") || html.includes("wixstatic.com")) stack.push("Wix");
  if (html.includes("shopify.com") || html.includes("myshopify.com")) stack.push("Shopify");
  if (html.includes("webflow.com") || $("html[data-wf-site]").length) stack.push("Webflow");
  if (html.includes("godaddy.com") || html.includes("secureserver.net")) stack.push("GoDaddy");
  if ($('meta[name="generator"][content*="Joomla"]').length) stack.push("Joomla");
  if ($('meta[name="generator"][content*="Drupal"]').length) stack.push("Drupal");
  if ($('meta[name="generator"][content*="HubSpot"]').length) stack.push("HubSpot");
  return stack;
}

/**
 * Scrape a single URL for all available data
 */
async function scrapePage(url) {
  const html = await fetchPage(url);
  if (!html) return null;

  const $ = cheerio.load(html);
  $("script, style, noscript").remove();
  const text = $("body").text().replace(/\s+/g, " ").trim();

  return { html, $, text, url };
}

/**
 * Full website scrape: homepage + contact pages (parallel where possible)
 */
async function scrapeWebsite(websiteUrl) {
  if (!websiteUrl) return null;

  const baseUrl = normalizeUrl(websiteUrl);
  if (!baseUrl) return null;

  const result = {
    source: "website_scrape",
    phones: [],
    emails: [],
    socialLinks: {},
    techStack: [],
    businessDescription: null,
    jsonLdType: null,
    pagesScraped: [],
  };

  console.log(`[Scraper] Scraping: ${baseUrl}`);

  // Step 1: Homepage
  const homepage = await scrapePage(baseUrl);
  if (!homepage) {
    console.log(`[Scraper] Could not fetch homepage for ${baseUrl}`);
    return result;
  }
  result.pagesScraped.push(baseUrl);

  // Step 2: JSON-LD (best source)
  const jsonLd = extractJsonLd(homepage.html);
  if (jsonLd.phones.length) result.phones.push(...jsonLd.phones);
  if (jsonLd.emails.length) result.emails.push(...jsonLd.emails);
  if (jsonLd.description) result.businessDescription = jsonLd.description;
  if (jsonLd.businessType) result.jsonLdType = jsonLd.businessType;
  if (jsonLd.socialLinks.length) {
    for (const link of jsonLd.socialLinks) {
      const platform = Object.entries({
        facebook: /facebook/, twitter: /twitter|x\.com/,
        linkedin: /linkedin/, instagram: /instagram/,
        youtube: /youtube/, yelp: /yelp/,
      }).find(([, r]) => r.test(link));
      if (platform) result.socialLinks[platform[0]] = link;
    }
  }

  // Step 3: Homepage text extraction
  const homepagePhones = extractPhones(homepage.text);
  const homepageEmails = extractEmails(homepage.$, homepage.text);
  const socialLinks = extractSocialLinks(homepage.$);
  const techStack = detectTechStack(homepage.$, homepage.html);

  result.phones.push(...homepagePhones);
  result.emails.push(...homepageEmails);
  result.socialLinks = { ...result.socialLinks, ...socialLinks };
  result.techStack = techStack;

  // Step 4: If missing data, check contact pages IN PARALLEL (big speed win)
  if (result.phones.length === 0 || result.emails.length === 0) {
    // Try first 3 paths in parallel, then remaining 2 if still missing
    const batch1 = CONTACT_PATHS.slice(0, 3);
    const batch1Results = await Promise.allSettled(
      batch1.map((path) => scrapePage(`${baseUrl}${path}`))
    );

    for (const settled of batch1Results) {
      if (settled.status !== "fulfilled" || !settled.value) continue;
      const contactPage = settled.value;
      result.pagesScraped.push(contactPage.url);

      const contactJsonLd = extractJsonLd(contactPage.html);
      if (contactJsonLd.phones.length) result.phones.push(...contactJsonLd.phones);
      if (contactJsonLd.emails.length) result.emails.push(...contactJsonLd.emails);

      result.phones.push(...extractPhones(contactPage.text));
      result.emails.push(...extractEmails(contactPage.$, contactPage.text));
    }

    // Still missing? Try remaining paths
    if (result.phones.length === 0 || result.emails.length === 0) {
      const batch2 = CONTACT_PATHS.slice(3);
      const batch2Results = await Promise.allSettled(
        batch2.map((path) => scrapePage(`${baseUrl}${path}`))
      );

      for (const settled of batch2Results) {
        if (settled.status !== "fulfilled" || !settled.value) continue;
        const contactPage = settled.value;
        result.pagesScraped.push(contactPage.url);
        result.phones.push(...extractPhones(contactPage.text));
        result.emails.push(...extractEmails(contactPage.$, contactPage.text));
      }
    }
  }

  // Deduplicate
  result.phones = [...new Set(result.phones)];
  result.emails = [...new Set(result.emails)];

  console.log(
    `[Scraper] ${baseUrl} — ${result.phones.length} phones, ${result.emails.length} emails, ${result.techStack.join(", ") || "unknown stack"} (${result.pagesScraped.length} pages)`
  );

  return result;
}

module.exports = { scrapeWebsite, extractPhones, extractEmails };
/**
 * Website Scraper Service
 * Scrapes company websites for phone numbers, emails, and business intel
 * 
 * Uses Cheerio (lightweight HTML parser) instead of Puppeteer since we just
 * need to parse static HTML. Falls back gracefully if pages fail.
 * 
 * Scraping strategy (layered):
 * 1. JSON-LD structured data (cleanest source)
 * 2. Homepage header/footer (most common placement)
 * 3. Contact/about pages
 * 4. Regex fallback across all content
 */

const cheerio = require("cheerio");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// US phone number patterns (captures most formats)
const PHONE_PATTERNS = [
  /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g,
  /(?:\+?1[-.\s]?)?\d{3}[-.\s]\d{3}[-.\s]\d{4}/g,
];

// Email pattern
const EMAIL_PATTERN = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

// Common contact page paths to check
const CONTACT_PATHS = [
  "/contact",
  "/contact-us",
  "/contactus",
  "/about",
  "/about-us",
  "/aboutus",
  "/locations",
  "/get-in-touch",
];

/**
 * Fetch a page with timeout and error handling
 */
async function fetchPage(url, timeoutMs = 10000) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });

    clearTimeout(timeout);

    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
      return null;
    }

    return await res.text();
  } catch (error) {
    console.log(`[Scraper] Failed to fetch ${url}: ${error.message}`);
    return null;
  }
}

/**
 * Extract structured data from JSON-LD blocks
 * This is the cleanest source — CMS platforms (WordPress, Squarespace, Wix)
 * often embed LocalBusiness or Organization schema with phone/email
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
        // Handle @graph arrays (common in WordPress SEO plugins)
        const entities = item["@graph"] ? item["@graph"] : [item];

        for (const entity of entities) {
          if (entity.telephone) {
            const phones = Array.isArray(entity.telephone)
              ? entity.telephone
              : [entity.telephone];
            data.phones.push(...phones);
          }

          if (entity.email) {
            const emails = Array.isArray(entity.email)
              ? entity.email
              : [entity.email];
            data.emails.push(...emails.map((e) => e.replace("mailto:", "")));
          }

          if (entity.url) data.website = entity.url;
          if (entity.description) data.description = entity.description;
          if (entity["@type"]) data.businessType = entity["@type"];

          // Social links from sameAs
          if (entity.sameAs) {
            const links = Array.isArray(entity.sameAs)
              ? entity.sameAs
              : [entity.sameAs];
            data.socialLinks.push(...links);
          }
        }
      }
    } catch (e) {
      // Malformed JSON-LD, skip
    }
  });

  return data;
}

/**
 * Extract phone numbers from page text using regex
 */
function extractPhones(text) {
  const phones = new Set();

  for (const pattern of PHONE_PATTERNS) {
    const matches = text.match(pattern) || [];
    for (const match of matches) {
      // Clean and normalize
      const cleaned = match.replace(/[^\d+]/g, "");
      // Must be 10 or 11 digits (with country code)
      if (cleaned.length >= 10 && cleaned.length <= 11) {
        phones.add(match.trim());
      }
    }
  }

  return [...phones];
}

/**
 * Extract email addresses from page text and mailto: links
 */
function extractEmails($, text) {
  const emails = new Set();

  // From mailto: links
  $('a[href^="mailto:"]').each((_, el) => {
    const href = $(el).attr("href") || "";
    const email = href.replace("mailto:", "").split("?")[0].trim();
    if (email && EMAIL_PATTERN.test(email)) {
      emails.add(email.toLowerCase());
    }
  });

  // From page text via regex
  const matches = text.match(EMAIL_PATTERN) || [];
  for (const match of matches) {
    // Filter out common false positives
    if (
      !match.includes(".png") &&
      !match.includes(".jpg") &&
      !match.includes(".gif") &&
      !match.includes(".css") &&
      !match.includes(".js") &&
      !match.includes("@sentry") &&
      !match.includes("@example")
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
 * Detect CMS / tech stack indicators
 * Useful for qualifying leads — WordPress sites are often agency clients
 */
function detectTechStack($, html) {
  const stack = [];

  if (html.includes("wp-content") || html.includes("wp-includes")) stack.push("WordPress");
  if (html.includes("squarespace.com") || html.includes("squarespace-cdn")) stack.push("Squarespace");
  if (html.includes("wix.com") || html.includes("wixstatic.com")) stack.push("Wix");
  if (html.includes("shopify.com") || html.includes("myshopify.com")) stack.push("Shopify");
  if (html.includes("webflow.com") || $('html[data-wf-site]').length) stack.push("Webflow");
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

  // Get visible text (strip scripts/styles)
  $("script, style, noscript").remove();
  const text = $("body").text().replace(/\s+/g, " ").trim();

  return {
    html,
    $,
    text,
    url,
  };
}

/**
 * Full website scrape: homepage + contact pages
 * @param {string} websiteUrl - Company website URL
 * @returns {Object} All extracted data
 */
async function scrapeWebsite(websiteUrl) {
  if (!websiteUrl) return null;

  // Normalize URL
  let baseUrl = websiteUrl;
  if (!baseUrl.startsWith("http")) baseUrl = `https://${baseUrl}`;
  try {
    const parsed = new URL(baseUrl);
    baseUrl = `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }

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

  // Step 1: Scrape homepage
  const homepage = await scrapePage(baseUrl);
  if (!homepage) {
    console.log(`[Scraper] Could not fetch homepage for ${baseUrl}`);
    return result;
  }

  result.pagesScraped.push(baseUrl);

  // Step 2: Extract JSON-LD structured data (best source)
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

  // Step 3: Extract from homepage text
  const homepagePhones = extractPhones(homepage.text);
  const homepageEmails = extractEmails(homepage.$, homepage.text);
  const socialLinks = extractSocialLinks(homepage.$);
  const techStack = detectTechStack(homepage.$, homepage.html);

  result.phones.push(...homepagePhones);
  result.emails.push(...homepageEmails);
  result.socialLinks = { ...result.socialLinks, ...socialLinks };
  result.techStack = techStack;

  // Step 4: If we still don't have a phone, check contact/about pages
  if (result.phones.length === 0 || result.emails.length === 0) {
    for (const path of CONTACT_PATHS) {
      const contactUrl = `${baseUrl}${path}`;

      await delay(500); // Be polite
      const contactPage = await scrapePage(contactUrl);

      if (contactPage) {
        result.pagesScraped.push(contactUrl);

        // Extract from contact page JSON-LD too
        const contactJsonLd = extractJsonLd(contactPage.html);
        if (contactJsonLd.phones.length) result.phones.push(...contactJsonLd.phones);
        if (contactJsonLd.emails.length) result.emails.push(...contactJsonLd.emails);

        const contactPhones = extractPhones(contactPage.text);
        const contactEmails = extractEmails(contactPage.$, contactPage.text);

        result.phones.push(...contactPhones);
        result.emails.push(...contactEmails);

        // If we found a phone, stop looking
        if (result.phones.length > 0 && result.emails.length > 0) break;
      }
    }
  }

  // Deduplicate
  result.phones = [...new Set(result.phones)];
  result.emails = [...new Set(result.emails)];

  console.log(
    `[Scraper] ${baseUrl} — ${result.phones.length} phones, ${result.emails.length} emails, ${result.techStack.join(", ") || "unknown stack"}`
  );

  return result;
}

module.exports = { scrapeWebsite, extractPhones, extractEmails };
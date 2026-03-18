/**
 * Indeed Scraper Service
 * Scrapes Indeed search results for company/job data using Puppeteer
 * 
 * Runs headless Chrome to load Indeed pages and extract job cards.
 * Indeed renders client-side so we need a real browser context.
 */

const puppeteer = require("puppeteer");

const INDEED_BASE = "https://www.indeed.com";

// Delay helper to pace requests
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Build Indeed search URL from params
 */
function buildSearchUrl({ keywords, location, page = 0 }) {
  const params = new URLSearchParams();
  if (keywords) params.set("q", keywords);
  if (location) params.set("l", location);
  if (page > 0) params.set("start", (page * 10).toString());
  return `${INDEED_BASE}/jobs?${params.toString()}`;
}

/**
 * Scrape a single page of Indeed search results
 * Returns array of job objects
 */
async function scrapeIndeedPage(page, url) {
  console.log(`[Indeed] Navigating to: ${url}`);
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

  // Wait for job cards to render
  await page.waitForSelector('[class*="job_seen_beacon"], [class*="resultContent"], .job_seen_beacon, .tapItem', {
    timeout: 15000,
  }).catch(() => {
    console.log("[Indeed] Job card selector not found, trying fallback...");
  });

  // Give Indeed's JS a moment to finish rendering
  await delay(2000);

  // Extract job data from the rendered DOM
  const jobs = await page.evaluate(() => {
    const results = [];
    // Indeed uses various selectors depending on layout version
    const cards = document.querySelectorAll(
      '[class*="job_seen_beacon"], .tapItem, [data-jk]'
    );

    cards.forEach((card) => {
      try {
        // Job title
        const titleEl =
          card.querySelector('[class*="jobTitle"] a, h2 a, .jcs-JobTitle') ||
          card.querySelector("a[data-jk]");
        const title = titleEl?.innerText?.trim() || "";
        const jobUrl = titleEl?.href || "";

        // Company name
        const companyEl = card.querySelector(
          '[data-testid="company-name"], [class*="companyName"], .company, [class*="company"]'
        );
        const companyName = companyEl?.innerText?.trim() || "";

        // Company page link (if available)
        const companyLink = card.querySelector(
          '[data-testid="company-name"] a, [class*="companyName"] a'
        );
        const companyUrl = companyLink?.href || "";

        // Location
        const locationEl = card.querySelector(
          '[data-testid="text-location"], [class*="companyLocation"], .companyLocation'
        );
        const location = locationEl?.innerText?.trim() || "";

        // Salary (if shown)
        const salaryEl = card.querySelector(
          '[class*="salary"], [class*="salaryText"], .salary-snippet-container'
        );
        const salary = salaryEl?.innerText?.trim() || "";

        // Job snippet/summary
        const snippetEl = card.querySelector(
          '.job-snippet, [class*="job-snippet"], .underShelfFooter, [class*="heading6"]'
        );
        const snippet = snippetEl?.innerText?.trim() || "";

        // Job ID from data attribute
        const jobId =
          card.getAttribute("data-jk") ||
          titleEl?.getAttribute("data-jk") ||
          "";

        if (companyName && title) {
          results.push({
            jobId,
            title,
            companyName,
            companyUrl,
            location,
            salary,
            snippet,
            jobUrl,
          });
        }
      } catch (e) {
        // Skip malformed cards
      }
    });

    return results;
  });

  console.log(`[Indeed] Found ${jobs.length} jobs on page`);
  return jobs;
}

/**
 * Check if Indeed company page has a website link
 */
async function getCompanyWebsiteFromIndeed(page, companyUrl) {
  if (!companyUrl || !companyUrl.includes("/cmp/")) return null;

  try {
    await page.goto(companyUrl, { waitUntil: "networkidle2", timeout: 15000 });
    await delay(1000);

    const website = await page.evaluate(() => {
      // Indeed company pages sometimes show a website link
      const linkEl = document.querySelector(
        'a[href*="http"][data-testid="companyInfo-website"], a[aria-label*="website"], [class*="website"] a'
      );
      return linkEl?.href || null;
    });

    return website;
  } catch (e) {
    console.log(`[Indeed] Could not fetch company page: ${e.message}`);
    return null;
  }
}

/**
 * Main scraping function
 * @param {Object} params - Search parameters
 * @param {string} params.keywords - Search keywords
 * @param {string} params.location - Location
 * @param {number} params.maxPages - Max pages to scrape (default 1)
 * @returns {Array} Deduplicated job results
 */
async function scrapeIndeed({ keywords, location, maxPages = 1 }) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--disable-gpu",
        "--window-size=1920,1080",
      ],
    });

    const page = await browser.newPage();

    // Set a realistic user agent
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    await page.setViewport({ width: 1920, height: 1080 });

    // Block unnecessary resources to speed up loading
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (["image", "media", "font"].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    let allJobs = [];

    for (let i = 0; i < maxPages; i++) {
      const url = buildSearchUrl({ keywords, location, page: i });
      const jobs = await scrapeIndeedPage(page, url);
      allJobs = allJobs.concat(jobs);

      if (jobs.length === 0) break; // No more results
      if (i < maxPages - 1) await delay(2000 + Math.random() * 2000); // Random delay between pages
    }

    // Deduplicate by company name (keep first occurrence / most complete)
    const seen = new Map();
    const dedupedJobs = [];

    for (const job of allJobs) {
      const key = job.companyName.toLowerCase().trim();
      if (!seen.has(key)) {
        seen.set(key, true);
        dedupedJobs.push(job);
      } else {
        // If this duplicate has more data, keep it instead
        const existingIdx = dedupedJobs.findIndex(
          (j) => j.companyName.toLowerCase().trim() === key
        );
        if (existingIdx !== -1) {
          const existing = dedupedJobs[existingIdx];
          if (!existing.companyUrl && job.companyUrl) {
            dedupedJobs[existingIdx] = { ...existing, companyUrl: job.companyUrl };
          }
        }
      }
    }

    console.log(
      `[Indeed] Total: ${allJobs.length} jobs, ${dedupedJobs.length} unique companies`
    );
    return dedupedJobs;
  } catch (error) {
    console.error("[Indeed] Scrape failed:", error.message);
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { scrapeIndeed, buildSearchUrl };
/**
 * Indeed Scraper Service v2
 * 
 * Fixes applied:
 * - User agent rotation (pool of 8 realistic UAs)
 * - CAPTCHA / block detection with clear error messaging
 * - Multi-layer selector strategy with text-content fallback
 * - Page result validation (detects when Indeed returns garbage)
 * - Browser-level timeout kill (prevents zombie Chrome processes)
 * - Configurable pagination with smarter delay scaling
 * - Indeed page count detection (stops early if no more pages)
 */

const puppeteer = require("puppeteer");

const INDEED_BASE = "https://www.indeed.com";
const BROWSER_TIMEOUT_MS = 120000; // Kill browser after 2 min no matter what
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Rotate user agents to reduce fingerprinting
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
];

function getRandomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function buildSearchUrl({ keywords, location, page = 0 }) {
  const params = new URLSearchParams();
  if (keywords) params.set("q", keywords);
  if (location) params.set("l", location);
  if (page > 0) params.set("start", (page * 10).toString());
  return `${INDEED_BASE}/jobs?${params.toString()}`;
}

/**
 * Detect if Indeed is blocking us (CAPTCHA, redirect, empty shell)
 */
async function detectBlock(page) {
  const blocked = await page.evaluate(() => {
    const html = document.documentElement.innerHTML.toLowerCase();
    // CAPTCHA indicators
    if (html.includes("captcha") || html.includes("unusual traffic") || html.includes("verify you are human")) {
      return "captcha";
    }
    // Anti-bot page
    if (html.includes("automated access") || html.includes("bot detection") || html.includes("access denied")) {
      return "blocked";
    }
    // Redirect to homepage or error
    if (document.title.includes("Error") || document.title === "Indeed") {
      const jobCards = document.querySelectorAll('[class*="job"], [data-jk], .tapItem, .resultContent');
      if (jobCards.length === 0) return "empty_redirect";
    }
    return null;
  });
  return blocked;
}

/**
 * Multi-strategy job card extraction
 * Strategy 1: Data attribute selectors (most stable)
 * Strategy 2: Class-based selectors (common but changes)
 * Strategy 3: Structural fallback (walks DOM structure)
 */
async function extractJobs(page) {
  return await page.evaluate(() => {
    const results = [];

    // ── Strategy 1: data-testid and data-jk attributes (most stable) ──
    const strategy1Cards = document.querySelectorAll('[data-jk]');
    if (strategy1Cards.length > 0) {
      strategy1Cards.forEach((card) => {
        try {
          // Walk up to the job card container if needed
          const container = card.closest('[class*="job_seen_beacon"], [class*="result"], .tapItem') || card;

          const titleEl = container.querySelector('h2 a, [class*="jobTitle"] a, a[data-jk]');
          const title = titleEl?.innerText?.trim() || "";
          const jobUrl = titleEl?.href || "";

          const companyEl = container.querySelector('[data-testid="company-name"], [class*="companyName"], [class*="company_name"]');
          const companyName = companyEl?.innerText?.trim() || "";

          const companyLink = companyEl?.querySelector("a") || container.querySelector('[data-testid="company-name"] a');
          const companyUrl = companyLink?.href || "";

          const locationEl = container.querySelector('[data-testid="text-location"], [class*="companyLocation"], [class*="company_location"]');
          const location = locationEl?.innerText?.trim() || "";

          const salaryEl = container.querySelector('[class*="salary"], [data-testid*="salary"], [class*="salaryText"]');
          const salary = salaryEl?.innerText?.trim() || "";

          const snippetEl = container.querySelector('[class*="job-snippet"], .underShelfFooter, [class*="heading6"], ul');
          const snippet = snippetEl?.innerText?.trim() || "";

          const jobId = card.getAttribute("data-jk") || titleEl?.getAttribute("data-jk") || "";

          if (companyName && title) {
            results.push({ jobId, title, companyName, companyUrl, location, salary, snippet, jobUrl, strategy: 1 });
          }
        } catch (e) {}
      });
    }

    // ── Strategy 2: Class-based selectors ──
    if (results.length === 0) {
      const strategy2Cards = document.querySelectorAll('[class*="job_seen_beacon"], .tapItem, [class*="resultContent"]');
      strategy2Cards.forEach((card) => {
        try {
          const titleEl = card.querySelector("h2 a, a[id^='job_'], [class*='Title'] a");
          const title = titleEl?.innerText?.trim() || "";
          const jobUrl = titleEl?.href || "";

          const companyEl = card.querySelector("span[class*='company'], div[class*='company'], [class*='companyName']");
          const companyName = companyEl?.innerText?.trim() || "";

          const locationEl = card.querySelector("div[class*='location'], [class*='companyLocation']");
          const location = locationEl?.innerText?.trim() || "";

          const salaryEl = card.querySelector("[class*='salary']");
          const salary = salaryEl?.innerText?.trim() || "";

          const snippetEl = card.querySelector("[class*='snippet'], ul, [class*='heading6']");
          const snippet = snippetEl?.innerText?.trim() || "";

          if (companyName && title) {
            results.push({ jobId: "", title, companyName, companyUrl: "", location, salary, snippet, jobUrl, strategy: 2 });
          }
        } catch (e) {}
      });
    }

    // ── Strategy 3: Structural fallback (h2 + nearby company text) ──
    if (results.length === 0) {
      const allH2s = document.querySelectorAll("h2");
      allH2s.forEach((h2) => {
        try {
          const link = h2.querySelector("a");
          if (!link) return;
          const title = link.innerText?.trim();
          if (!title || title.length < 3) return;
          const jobUrl = link.href || "";

          // Walk siblings/parent for company info
          const parent = h2.closest("div[class]") || h2.parentElement;
          if (!parent) return;

          // Find the first span/div after the title that looks like a company name
          const siblings = parent.querySelectorAll("span, div");
          let companyName = "";
          let location = "";

          for (const sib of siblings) {
            const text = sib.innerText?.trim();
            if (!text || text === title) continue;
            if (text.length > 2 && text.length < 80 && !companyName) {
              companyName = text;
            } else if (companyName && !location && (text.includes(",") || text.match(/[A-Z]{2}/))) {
              location = text;
              break;
            }
          }

          if (companyName && title) {
            results.push({ jobId: "", title, companyName, companyUrl: "", location, salary: "", snippet: "", jobUrl, strategy: 3 });
          }
        } catch (e) {}
      });
    }

    return results;
  });
}

/**
 * Scrape a single page of Indeed search results
 */
async function scrapeIndeedPage(page, url) {
  console.log(`[Indeed] Navigating to: ${url}`);

  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
  } catch (navError) {
    // Timeout is common — page may still have loaded enough
    console.log(`[Indeed] Navigation timeout (may still have data): ${navError.message}`);
  }

  // Check for blocks
  const blockType = await detectBlock(page);
  if (blockType) {
    console.warn(`[Indeed] ⚠️ Detected block: ${blockType}`);
    if (blockType === "captcha") {
      throw new Error("Indeed is showing a CAPTCHA. Try again in 30 minutes or reduce search frequency.");
    }
    if (blockType === "blocked") {
      throw new Error("Indeed has blocked this IP. Wait 1 hour before trying again.");
    }
    // empty_redirect — might just be no results, continue
  }

  // Wait for content to render
  await page.waitForSelector('[data-jk], [class*="job_seen_beacon"], .tapItem, h2 a', {
    timeout: 10000,
  }).catch(() => {
    console.log("[Indeed] No job selectors found after wait");
  });

  await delay(1500 + Math.random() * 1000);

  // Extract with multi-strategy approach
  const jobs = await extractJobs(page);

  // Validate results — check for garbage data
  const validJobs = jobs.filter((job) => {
    if (!job.companyName || job.companyName.length < 2) return false;
    if (!job.title || job.title.length < 2) return false;
    // Filter out Indeed's own UI text that might get picked up
    if (job.companyName.toLowerCase().includes("indeed")) return false;
    if (job.title.toLowerCase() === "jobs" || job.title.toLowerCase() === "search") return false;
    return true;
  });

  console.log(`[Indeed] Found ${validJobs.length} valid jobs (strategy: ${validJobs[0]?.strategy || "none"})`);
  return validJobs;
}

/**
 * Detect if there's a next page available
 */
async function hasNextPage(page) {
  return await page.evaluate(() => {
    const nextBtn = document.querySelector(
      'a[data-testid="pagination-page-next"], a[aria-label="Next Page"], nav[aria-label*="pagination"] a:last-child'
    );
    return !!nextBtn && !nextBtn.hasAttribute("disabled");
  });
}

/**
 * Main scraping function
 */
async function scrapeIndeed({ keywords, location, maxPages = 1 }) {
  let browser;
  let browserKillTimer;

  try {
    browser = await puppeteer.launch({
      headless: "new",
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--disable-gpu",
        "--window-size=1920,1080",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--single-process", // Reduces memory on small droplets
      ],
    });

    // Hard timeout — kill browser no matter what after BROWSER_TIMEOUT_MS
    browserKillTimer = setTimeout(async () => {
      console.warn("[Indeed] ⚠️ Browser timeout — force killing");
      try { await browser.close(); } catch {}
    }, BROWSER_TIMEOUT_MS);

    const page = await browser.newPage();
    await page.setUserAgent(getRandomUA());
    await page.setViewport({ width: 1920, height: 1080 });

    // Set realistic headers
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    });

    // Block heavy resources
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      const url = req.url();
      if (
        ["image", "media", "font", "stylesheet"].includes(type) ||
        url.includes("google-analytics") ||
        url.includes("googletag") ||
        url.includes("facebook") ||
        url.includes("doubleclick")
      ) {
        req.abort();
      } else {
        req.continue();
      }
    });

    let allJobs = [];
    let consecutiveEmpty = 0;

    for (let i = 0; i < maxPages; i++) {
      const url = buildSearchUrl({ keywords, location, page: i });
      const jobs = await scrapeIndeedPage(page, url);
      allJobs = allJobs.concat(jobs);

      // Stop conditions
      if (jobs.length === 0) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= 2) {
          console.log("[Indeed] 2 consecutive empty pages — stopping pagination");
          break;
        }
      } else {
        consecutiveEmpty = 0;
      }

      // Check if Indeed has a next page
      if (i < maxPages - 1) {
        const nextExists = await hasNextPage(page);
        if (!nextExists) {
          console.log("[Indeed] No next page button found — stopping pagination");
          break;
        }
        // Scale delays with page number (Indeed gets more suspicious on later pages)
        const baseDelay = 3000 + i * 1000;
        await delay(baseDelay + Math.random() * 2000);
      }
    }

    // Deduplicate by company name — keep the entry with the most data
    const seen = new Map();
    const dedupedJobs = [];

    for (const job of allJobs) {
      const key = job.companyName.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!seen.has(key)) {
        seen.set(key, dedupedJobs.length);
        dedupedJobs.push(job);
      } else {
        const existingIdx = seen.get(key);
        const existing = dedupedJobs[existingIdx];
        // Replace if this one has more fields filled
        const existingScore = [existing.companyUrl, existing.salary, existing.snippet, existing.location].filter(Boolean).length;
        const newScore = [job.companyUrl, job.salary, job.snippet, job.location].filter(Boolean).length;
        if (newScore > existingScore) {
          dedupedJobs[existingIdx] = job;
        }
      }
    }

    console.log(`[Indeed] Total: ${allJobs.length} jobs, ${dedupedJobs.length} unique companies`);
    return dedupedJobs;
  } catch (error) {
    console.error("[Indeed] Scrape failed:", error.message);
    throw error;
  } finally {
    if (browserKillTimer) clearTimeout(browserKillTimer);
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

module.exports = { scrapeIndeed, buildSearchUrl };
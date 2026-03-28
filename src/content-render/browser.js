/**
 * Chrome Browser Singleton
 * 
 * Launches Chrome once, reuses for all renders.
 * Auto-closes after 90s of inactivity to free memory.
 * Limits concurrent renders to 2 to prevent OOM on 1GB RAM.
 */

const puppeteer = require('puppeteer-core');

let browser = null;
let closeTimer = null;
let activeRenders = 0;
const MAX_CONCURRENT = 2;
const IDLE_TIMEOUT = 90000; // 90 seconds

// Queue for pending renders when at capacity
const queue = [];

function resetCloseTimer() {
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = setTimeout(async () => {
    if (browser && activeRenders === 0) {
      console.log('[content-render] Closing idle Chrome');
      try { await browser.close(); } catch {}
      browser = null;
    }
  }, IDLE_TIMEOUT);
}

async function getBrowser() {
  if (browser && browser.isConnected()) {
    resetCloseTimer();
    return browser;
  }

  console.log('[content-render] Launching Chrome');
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',       // Use /tmp instead of /dev/shm (prevents OOM on low RAM)
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--hide-scrollbars',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-first-run',
      '--single-process',              // Reduces memory by ~30% on single-core
      '--font-render-hinting=none',    // Consistent font rendering
    ],
    headless: 'new',
    defaultViewport: null, // We set viewport per page
  });

  browser.on('disconnected', () => {
    console.log('[content-render] Chrome disconnected');
    browser = null;
  });

  resetCloseTimer();
  return browser;
}

/**
 * Acquire a render slot. Resolves when a slot is available.
 * This prevents more than MAX_CONCURRENT renders at once.
 */
function acquireSlot() {
  return new Promise((resolve) => {
    if (activeRenders < MAX_CONCURRENT) {
      activeRenders++;
      resolve();
    } else {
      queue.push(resolve);
    }
  });
}

function releaseSlot() {
  activeRenders--;
  if (queue.length > 0 && activeRenders < MAX_CONCURRENT) {
    activeRenders++;
    const next = queue.shift();
    next();
  }
  resetCloseTimer();
}

/**
 * Render HTML to PNG buffer.
 * Manages page lifecycle, font loading, and screenshot.
 * 
 * @param {string} html - Complete HTML document
 * @returns {Promise<Buffer>} PNG buffer
 */
async function renderHTML(html) {
  await acquireSlot();
  let page = null;

  try {
    const b = await getBrowser();
    page = await b.newPage();

    await page.setViewport({ width: 1080, height: 1350, deviceScaleFactor: 1 });

    // Block unnecessary resources to speed up render
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      // Allow fonts and stylesheets, block everything else that's not the page itself
      if (['image', 'media', 'websocket'].includes(type)) {
        // Allow data: URLs (our base64 photos) but block external images
        if (req.url().startsWith('data:')) {
          req.continue();
        } else {
          req.abort();
        }
      } else {
        req.continue();
      }
    });

    await page.setContent(html, {
      waitUntil: 'networkidle0',
      timeout: 12000,
    });

    // Wait for fonts to actually render
    await page.evaluate(() => document.fonts.ready);

    // Additional wait for font rasterization
    await new Promise(r => setTimeout(r, 400));

    // Screenshot the .post element specifically
    const element = await page.$('.post');
    if (!element) {
      throw new Error('No .post element found in HTML');
    }

    const buffer = await element.screenshot({
      type: 'png',
      encoding: 'binary',
    });

    return buffer;
  } finally {
    if (page) {
      try { await page.close(); } catch {}
    }
    releaseSlot();
  }
}

/**
 * Force close the browser (for graceful shutdown).
 */
async function closeBrowser() {
  if (closeTimer) clearTimeout(closeTimer);
  if (browser) {
    try { await browser.close(); } catch {}
    browser = null;
  }
}

module.exports = { renderHTML, closeBrowser };

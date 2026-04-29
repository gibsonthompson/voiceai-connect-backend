/**
 * Standalone template renderer for local design iteration.
 *
 * Usage:
 *   node scripts/render-template.js <templateId> [contentJsonFile] [outputPng]
 *
 * Defaults:
 *   contentJsonFile -> ./scripts/sample-content.json (or built-in fallback)
 *   outputPng       -> /tmp/render.png
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { render } = require('../src/content-render/callbird-templates');

const CHROME_PATH = process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const FALLBACK_CONTENT = {
  headline: "62% Won't Leave a Voicemail",
  subtext: "They just call the next business.",
  highlight_words: ['62%'],
  cta_line1: 'Every missed call is revenue walking out.',
  cta_line2: 'Stop losing jobs to voicemail',
  items: ['24/7|Every call answered', '2s|Average pickup', '40%|More booked'],
};

const BUSINESS = {
  name: 'CallBird AI',
  slug: 'callbird',
  primary_color: '#122092',
  accent_color: '#F6B828',
};

async function main() {
  const [, , templateId, contentFile, outputPath] = process.argv;
  if (!templateId) {
    console.error('Usage: node scripts/render-template.js <templateId> [contentJsonFile] [outputPng]');
    process.exit(1);
  }

  let content = FALLBACK_CONTENT;
  if (contentFile && fs.existsSync(contentFile)) {
    content = JSON.parse(fs.readFileSync(contentFile, 'utf8'));
  }

  const out = outputPath || '/tmp/render.png';

  const html = render(templateId, content, BUSINESS);
  fs.writeFileSync('/tmp/render.html', html);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none'],
    headless: 'new',
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1350, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15000 });
    try {
      await page.evaluate(() => document.fonts.ready);
    } catch {}
    await new Promise(r => setTimeout(r, 1500));

    const el = await page.$('.post');
    if (!el) throw new Error('No .post element found');

    const buf = await el.screenshot({ type: 'png' });
    fs.writeFileSync(out, buf);
    console.log(`Rendered: ${out} (${buf.length} bytes)`);
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

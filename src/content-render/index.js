/**
 * Content Render Service
 * 
 * Express router that renders HTML templates to PNG via Puppeteer.
 * Now also saves PNGs to disk and returns public URLs for Meta API publishing.
 * 
 * Mount on your VoiceAI Connect Express server:
 *   const contentRender = require('./content-render');
 *   app.use('/api/content-render', contentRender);
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { renderHTML } = require('./browser');
const { renderTemplate } = require('./html-templates');

const router = express.Router();

// Renders directory — served statically by server.js
const RENDERS_DIR = process.env.RENDERS_DIR || '/workspace/renders';

// ── Auth middleware ───────────────────────────────────────────────
router.use((req, res, next) => {
  const key = req.headers['x-render-key'];
  const expected = process.env.RENDER_SERVICE_KEY;
  if (!expected) return next();
  if (key !== expected) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// ── Health check ─────────────────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'content-render' });
});

// ── Render single post ───────────────────────────────────────────
router.post('/render', async (req, res) => {
  const start = Date.now();

  try {
    const { content, business, templateId, photoDataUrl, platform } = req.body;

    if (!content || !business) {
      return res.status(400).json({ error: 'content and business are required' });
    }

    const options = { platform: platform || 'instagram' };

    // Build HTML from template
    const html = renderTemplate(
      templateId || content.template || 'full_graphic',
      content,
      business,
      photoDataUrl || null,
      options
    );

    // Render to PNG
    const dimensions = platform === 'linkedin' ? { width: 1200, height: 628 } : null;
    const buffer = await renderHTML(html, dimensions);

    // Return as base64 (backward compatible)
    const base64 = buffer.toString('base64');

    // Also save to disk and generate public URL
    let url = null;
    try {
      const slug = (business.slug || 'default').replace(/[^a-z0-9-]/gi, '');
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
      const dir = path.join(RENDERS_DIR, slug);

      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(path.join(dir, filename), buffer);

      const baseUrl = process.env.PUBLIC_URL || `https://urchin-app-bqb4i.ondigitalocean.app`;
      url = `${baseUrl}/renders/${slug}/${filename}`;

      console.log(`[content-render] Saved to disk: ${url}`);
    } catch (fileErr) {
      console.error(`[content-render] File save failed (non-fatal): ${fileErr.message}`);
      // Non-fatal — base64 still works
    }

    console.log(`[content-render] Rendered ${templateId || content.template} in ${Date.now() - start}ms`);

    res.json({
      image: `data:image/png;base64,${base64}`,
      url, // Public URL for Meta API — null if file save failed
      renderTime: Date.now() - start,
    });
  } catch (error) {
    console.error('[content-render] Error:', error.message);
    res.status(500).json({ error: error.message || 'Render failed' });
  }
});

// ── Render batch (all 12 at once) ────────────────────────────────
router.post('/render-batch', async (req, res) => {
  const start = Date.now();

  try {
    const { items, business, photos } = req.body;

    if (!items || !business) {
      return res.status(400).json({ error: 'items and business are required' });
    }

    const results = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      if (!item || !item.result) {
        results.push({ index: i, success: false, error: 'No content' });
        continue;
      }

      try {
        let photoDataUrl = null;
        const pidx = item.result.photo_index;
        if (pidx >= 0 && photos && photos[pidx]) {
          photoDataUrl = photos[pidx];
        } else if (
          (item.result.template === 'photo_hero' || item.result.template === 'process_steps') &&
          photos && photos.length > 0
        ) {
          photoDataUrl = photos[i % photos.length];
        }

        const html = renderTemplate(
          item.result.template || 'full_graphic',
          item.result,
          business,
          photoDataUrl
        );

        const buffer = await renderHTML(html);
        const base64 = buffer.toString('base64');

        results.push({
          index: i,
          success: true,
          image: `data:image/png;base64,${base64}`,
        });

        console.log(`[content-render] Batch item ${i + 1}/${items.length} done (${Date.now() - start}ms total)`);
      } catch (error) {
        console.error(`[content-render] Batch item ${i} failed:`, error.message);
        results.push({ index: i, success: false, error: error.message });
      }
    }

    console.log(`[content-render] Batch complete: ${results.filter(r => r.success).length}/${items.length} in ${Date.now() - start}ms`);

    res.json({ results, totalTime: Date.now() - start });
  } catch (error) {
    console.error('[content-render] Batch error:', error.message);
    res.status(500).json({ error: error.message || 'Batch render failed' });
  }
});

module.exports = router;
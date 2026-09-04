// ============================================================================
// Leads import helpers. Mount at /api/leads (alongside the existing leads route):
//   app.use('/api/leads', require('./routes/leads-import'));
// ----------------------------------------------------------------------------
// POST /api/leads/google-sheet-csv
// Fetches a shared Google Sheet's first tab as CSV server-side (the browser
// can't, CORS). The sheet must be shared "Anyone with the link can view".
// Only ever fetches docs.google.com export URLs built from the sheet id, so
// there's no open-redirect / SSRF surface.
// ============================================================================
const express = require('express');
const router = express.Router();

router.post('/google-sheet-csv', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'missing_url', message: 'Missing Google Sheets link.' });
    }
    const idMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!idMatch) {
      return res.status(400).json({ error: 'bad_link', message: "That doesn't look like a Google Sheets link." });
    }
    const sheetId = idMatch[1];
    const gidMatch = url.match(/[#&?]gid=([0-9]+)/);
    const gid = gidMatch ? gidMatch[1] : '0';
    const exportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;

    const resp = await fetch(exportUrl, { redirect: 'follow' });
    if (!resp.ok) {
      return res.status(400).json({
        error: 'sheet_unreachable',
        message: 'Could not read that Google Sheet. Make sure it is shared as "Anyone with the link can view".',
      });
    }
    const csv = await resp.text();
    // Private sheets return Google's HTML sign-in page instead of CSV.
    if (/^\s*<(!doctype|html)/i.test(csv)) {
      return res.status(400).json({
        error: 'sheet_private',
        message: 'That sheet looks private. Share it as "Anyone with the link can view" and try again.',
      });
    }
    if (csv.length > 2 * 1024 * 1024) {
      return res.status(400).json({ error: 'too_large', message: 'That sheet is too large to import.' });
    }
    return res.json({ csv });
  } catch (err) {
    console.error('google-sheet-csv error:', err.message);
    return res.status(500).json({ error: 'fetch_failed', message: 'Could not fetch that Google Sheet.' });
  }
});

module.exports = router;
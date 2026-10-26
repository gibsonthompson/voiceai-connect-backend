// ============================================================================
// FINANCE EMAIL CRON  (destination: src/routes/finance-email-cron.js)
// ----------------------------------------------------------------------------
// Polls the bank-alert email inbox and ingests new transactions. Schedule it
// from Vercel cron (every ~10-15 min) hitting this endpoint with x-cron-secret.
//
//   POST /api/cron/finance-email-poll   (header x-cron-secret: CRON_SECRET)
//
// Dry/manual run from a browser or curl works the same; it is idempotent.
// ============================================================================

'use strict';

const express = require('express');
const router = express.Router();

function requireSecret(req, res, next) {
  if (process.env.CRON_SECRET && (req.headers['x-cron-secret'] || req.query.secret) !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

async function run(req, res) {
  try {
    const { pollAndIngest } = require('../lib/finance-email');
    const result = await pollAndIngest();
    return res.status(result.ok ? 200 : 500).json(result);
  } catch (e) {
    console.error('❌ finance email poll failed:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

router.post('/finance-email-poll', requireSecret, run);
router.get('/finance-email-poll', requireSecret, run);

module.exports = router;

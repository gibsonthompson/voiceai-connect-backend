// ============================================================================
// FRONTEND ERROR REPORT ENDPOINT
// POST /api/admin/error-report
//
// Receives error reports from the Next.js frontend (error boundary, global
// error handler) and sends SMS alerts via the error monitor.
//
// No auth required — errors can happen before/during login.
// Rate limited by error-monitor.js (10/hr max, 30min dedup).
//
// Mount: app.use('/api/admin', require('./routes/error-report'));
// CREATED: 2026-05-10
// ============================================================================
const express = require('express');
const router = express.Router();
const { alertError } = require('../lib/error-monitor');

router.post('/error-report', async (req, res) => {
  try {
    const { message, stack, url, component, userAgent, timestamp } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'message required' });
    }

    const error = new Error(message);
    if (stack) error.stack = stack;

    await alertError('FRONTEND', error, {
      url: url || 'unknown',
      component: component || 'unknown',
    });

    res.json({ received: true });
  } catch (err) {
    console.error('Error report endpoint failed:', err);
    res.status(500).json({ error: 'Failed to process error report' });
  }
});

module.exports = router;

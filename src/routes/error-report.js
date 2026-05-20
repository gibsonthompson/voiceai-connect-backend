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
// UPDATED: 2026-05-20 — Filter out browser extension errors that aren't ours.
//   Browser extensions (MetaMask, Grammarly, password managers, ad blockers,
//   translation tools, crypto wallets) inject scripts that modify the DOM or
//   access APIs like window.ethereum, causing React hydration errors and
//   other crashes that have nothing to do with our code. These were triggering
//   SMS alerts at 5-6AM for errors we can't fix.
//
// Mount: app.use('/api/admin', require('./routes/error-report'));
// CREATED: 2026-05-10
// ============================================================================
const express = require('express');
const router = express.Router();
const { alertError } = require('../lib/error-monitor');

// ============================================================================
// BROWSER EXTENSION / THIRD-PARTY ERROR FILTERS
// These patterns match errors caused by browser extensions, crypto wallets,
// translation tools, and other injected scripts — NOT our code.
// ============================================================================
const IGNORED_ERROR_PATTERNS = [
  // Crypto wallet extensions (MetaMask, Coinbase Wallet, Phantom, etc.)
  /window\.ethereum/i,
  /ethereum/i,
  /metamask/i,
  /coinbase/i,
  /phantom/i,
  /solana/i,
  /web3/i,

  // Grammarly
  /grammarly/i,
  /grammarly-desktop/i,
  /data-grammarly/i,

  // Password managers (LastPass, 1Password, Bitwarden, Dashlane)
  /lastpass/i,
  /1password/i,
  /bitwarden/i,
  /dashlane/i,
  /kaspersky/i,

  // Ad blockers / privacy extensions
  /adblock/i,
  /ublock/i,
  /ghostery/i,
  /privacy.badger/i,

  // Translation extensions
  /translate/i,
  /google.translate/i,
  /deepl/i,

  // Generic browser extension injection patterns
  /chrome-extension:\/\//i,
  /moz-extension:\/\//i,
  /safari-extension:\/\//i,

  // Third-party script injection (common in injected toolbars, etc.)
  /^Script error\.?$/i,
];

// React hydration errors caused by DOM manipulation from extensions
// (password managers injecting fields, Grammarly adding spans, etc.)
const IGNORED_HYDRATION_PATTERNS = [
  // React removeChild — extension modified DOM between server render and hydration
  /Cannot read properties of null \(reading 'removeChild'\)/i,
  /null is not an object \(evaluating '.*removeChild'\)/i,
  /null is not an object \(evaluating '\(n=n\.stateNode\)\.parentNode\.removeChild'\)/i,

  // React hydration text mismatch (#418) — extension injected text nodes
  /Minified React error #418/i,
  /react\.dev\/errors\/418/i,

  // React hydration element mismatch (#425)
  /Minified React error #425/i,
  /react\.dev\/errors\/425/i,
];

/**
 * Check if an error report is from a browser extension or third-party script
 * rather than our own code.
 */
function isExtensionError(message, stack, component, url) {
  const fullText = [message, stack, component, url].filter(Boolean).join(' ');

  // Check explicit extension patterns
  for (const pattern of IGNORED_ERROR_PATTERNS) {
    if (pattern.test(fullText)) return true;
  }

  // Check hydration patterns — these are almost always caused by extensions
  // modifying the DOM between SSR and client hydration. We still want to
  // know about hydration errors on specific pages for debugging, so we log
  // them but don't alert.
  for (const pattern of IGNORED_HYDRATION_PATTERNS) {
    if (pattern.test(message || '')) return true;
  }

  // "Script error." with no details = cross-origin script (extension or ad)
  if (/^Script error\.?$/i.test(message) && (!stack || stack.trim() === '')) {
    return true;
  }

  return false;
}

router.post('/error-report', async (req, res) => {
  try {
    const { message, stack, url, component, userAgent, timestamp } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'message required' });
    }

    // Filter out browser extension / third-party errors
    if (isExtensionError(message, stack, component, url)) {
      // Still log for visibility, but don't trigger SMS alerts
      console.log(`🔇 Extension/hydration error suppressed: ${(message || '').substring(0, 80)}`);
      return res.json({ received: true, filtered: true });
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
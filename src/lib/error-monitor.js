// ============================================================================
// ERROR MONITOR — SMS Alerts for Backend Errors
// Location: src/lib/error-monitor.js
// Created: 2026-05-10
//
// Sends SMS to platform owner on any server error. Rate-limited to prevent
// floods from error loops. Deduplicates by error message signature.
//
// Usage:
//   const { alertError } = require('./error-monitor');
//   alertError('stripe-webhook', error, { agencyId, plan });
//
// Also exports Express middleware and process-level handlers.
// ============================================================================
const { sendTelnyxSMS, formatPhoneDisplay } = require('./notifications');

const PLATFORM_OWNER_PHONE = process.env.PLATFORM_OWNER_PHONE || '+16783161454';

// ============================================================================
// RATE LIMITING — prevent SMS floods from error loops
// ============================================================================
const MAX_ALERTS_PER_HOUR = 10;
const DEDUP_WINDOW_MS = 30 * 60 * 1000; // 30 min — same error won't re-alert for 30 min
const SUMMARY_INTERVAL_MS = 60 * 60 * 1000; // 1 hour — send suppressed count

const _alertHistory = []; // timestamps of sent alerts
const _errorSignatures = new Map(); // signature → { lastSent, count }
let _suppressedCount = 0;
let _summaryTimer = null;

function getErrorSignature(context, error) {
  const msg = (error?.message || String(error)).slice(0, 100);
  return `${context}:${msg}`;
}

function canSendAlert(signature) {
  const now = Date.now();

  // Clean old history
  while (_alertHistory.length > 0 && now - _alertHistory[0] > 3600000) {
    _alertHistory.shift();
  }

  // Check hourly cap
  if (_alertHistory.length >= MAX_ALERTS_PER_HOUR) {
    _suppressedCount++;
    startSummaryTimer();
    return false;
  }

  // Check dedup
  const existing = _errorSignatures.get(signature);
  if (existing && now - existing.lastSent < DEDUP_WINDOW_MS) {
    existing.count++;
    _suppressedCount++;
    startSummaryTimer();
    return false;
  }

  return true;
}

function recordAlert(signature) {
  const now = Date.now();
  _alertHistory.push(now);
  _errorSignatures.set(signature, { lastSent: now, count: 1 });

  // Clean old signatures
  for (const [key, val] of _errorSignatures) {
    if (now - val.lastSent > DEDUP_WINDOW_MS * 2) {
      _errorSignatures.delete(key);
    }
  }
}

function startSummaryTimer() {
  if (_summaryTimer) return;
  _summaryTimer = setTimeout(async () => {
    if (_suppressedCount > 0) {
      const msg = `⚠️ Error Monitor Summary\n\n${_suppressedCount} error alert${_suppressedCount > 1 ? 's' : ''} suppressed in the last hour (rate limit / dedup).\n\nCheck DigitalOcean logs for details.`;
      try {
        await sendTelnyxSMS(PLATFORM_OWNER_PHONE, msg);
      } catch {}
      _suppressedCount = 0;
    }
    _summaryTimer = null;
  }, SUMMARY_INTERVAL_MS);
}

// ============================================================================
// MAIN ALERT FUNCTION
// ============================================================================
async function alertError(context, error, metadata = {}) {
  const signature = getErrorSignature(context, error);

  // Always log to console
  console.error(`🚨 [${context}] ${error?.message || error}`, metadata);

  if (!canSendAlert(signature)) {
    console.log(`   ⏭ Alert suppressed (rate limit / dedup): ${signature.slice(0, 60)}`);
    return false;
  }

  recordAlert(signature);

  try {
    const errorMsg = error?.message || String(error);
    const stack = error?.stack?.split('\n').slice(1, 3).join('\n') || '';

    const lines = [];
    lines.push(`🚨 Backend Error`);
    lines.push(`━━━━━━━━━━━━━━━━━━`);
    lines.push(`📍 ${context}`);
    lines.push(`❌ ${errorMsg.slice(0, 200)}`);

    if (stack) {
      const cleanStack = stack.replace(/\s+at\s+/g, '→ ').trim().slice(0, 150);
      lines.push(`📋 ${cleanStack}`);
    }

    // Add metadata
    const metaKeys = Object.keys(metadata);
    if (metaKeys.length > 0) {
      lines.push(`━━━━━━━━━━━━━━━━━━`);
      for (const key of metaKeys.slice(0, 4)) {
        const val = String(metadata[key]).slice(0, 60);
        lines.push(`${key}: ${val}`);
      }
    }

    lines.push(`━━━━━━━━━━━━━━━━━━`);
    lines.push(`${new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true })} ET`);

    await sendTelnyxSMS(PLATFORM_OWNER_PHONE, lines.join('\n'));
    console.log(`   📱 Error alert SMS sent for: ${context}`);
    return true;
  } catch (smsErr) {
    console.error(`   ❌ Error alert SMS failed:`, smsErr.message);
    return false;
  }
}

// ============================================================================
// EXPRESS ERROR MIDDLEWARE — catches unhandled route errors
// Add AFTER all routes in server.js:
//   app.use(expressErrorHandler);
// ============================================================================
function expressErrorHandler(err, req, res, next) {
  const context = `${req.method} ${req.originalUrl || req.url}`;

  alertError(context, err, {
    method: req.method,
    url: req.originalUrl || req.url,
    ip: req.ip || req.headers['x-forwarded-for'],
    body: req.body ? JSON.stringify(req.body).slice(0, 100) : undefined,
  });

  // Don't expose internal errors to client
  if (!res.headersSent) {
    res.status(500).json({
      error: 'Internal server error',
      message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong',
    });
  }
}

// ============================================================================
// PROCESS-LEVEL HANDLERS — catches crashes that bypass Express
// Call once at server startup:
//   setupProcessErrorHandlers();
// ============================================================================
function setupProcessErrorHandlers() {
  process.on('uncaughtException', async (err) => {
    console.error('💀 UNCAUGHT EXCEPTION:', err);
    await alertError('UNCAUGHT_EXCEPTION', err);
    // Give SMS time to send before crash
    setTimeout(() => process.exit(1), 3000);
  });

  process.on('unhandledRejection', async (reason, promise) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    console.error('💀 UNHANDLED REJECTION:', err);
    await alertError('UNHANDLED_REJECTION', err);
    // Don't exit — unhandled rejections are recoverable
  });

  process.on('SIGTERM', async () => {
    console.log('🛑 SIGTERM received — shutting down gracefully');
    // No SMS for graceful shutdown — this is normal on DO
    process.exit(0);
  });

  console.log('✅ Process error handlers installed');
}

// ============================================================================
// EXPORTS
// ============================================================================
module.exports = {
  alertError,
  expressErrorHandler,
  setupProcessErrorHandlers,
};

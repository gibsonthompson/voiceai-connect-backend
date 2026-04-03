// ============================================================================
// SMS TEMPLATE LOADER
// Fetches editable SMS templates from sms_templates table.
// Falls back gracefully if DB is unavailable or template missing.
// 
// Usage:
//   const msg = await getSmsTemplate('abandoned_cart_1', { name: 'Acme', recovery_link: '...' });
//   if (msg) sendTelnyxSMS(phone, msg);
//
// Cache: 5 minutes in-memory to avoid DB hit on every SMS in a cron batch.
// Call clearTemplateCache() after admin edits to force reload.
// ============================================================================

const { supabase } = require('./supabase');

// In-memory cache
let _cache = {};
let _cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ============================================================================
// LOAD ALL TEMPLATES FROM DB (cached)
// ============================================================================
async function loadTemplates() {
  const now = Date.now();
  if (now - _cacheTime < CACHE_TTL && Object.keys(_cache).length > 0) {
    return _cache;
  }

  try {
    const { data, error } = await supabase
      .from('sms_templates')
      .select('key, message');

    if (error || !data) {
      console.warn('⚠️ Failed to load SMS templates from DB:', error?.message || 'no data');
      return _cache; // Return stale cache if available, empty object otherwise
    }

    _cache = {};
    data.forEach(t => { _cache[t.key] = t.message; });
    _cacheTime = now;

    return _cache;
  } catch (err) {
    console.warn('⚠️ SMS template DB error:', err.message);
    return _cache;
  }
}

// ============================================================================
// GET A SINGLE TEMPLATE WITH VARIABLE SUBSTITUTION
// Returns the message string with {variables} replaced, or null if not found.
// ============================================================================
async function getSmsTemplate(key, variables = {}) {
  const templates = await loadTemplates();
  let message = templates[key] || null;

  if (!message) {
    // Template not in DB — caller should use hardcoded fallback
    return null;
  }

  // Replace {variable} placeholders
  for (const [k, v] of Object.entries(variables)) {
    message = message.replace(new RegExp(`\\{${k}\\}`, 'g'), v != null ? String(v) : '');
  }

  return message;
}

// ============================================================================
// CLEAR CACHE (call after admin edits a template)
// ============================================================================
function clearTemplateCache() {
  _cache = {};
  _cacheTime = 0;
}

module.exports = { getSmsTemplate, clearTemplateCache, loadTemplates };
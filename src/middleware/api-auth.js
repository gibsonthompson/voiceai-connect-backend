// api-auth.js, authentication, tenant isolation, rate limiting, and response
// conventions for the agency-facing REST API (/api/v1). Every /v1 request passes
// through apiKeyAuth first, which resolves the API key to exactly one agency and
// attaches it as req.agency. Every downstream query MUST scope by req.agency.id;
// that single rule is what keeps one agency from ever seeing another's data.
//
// Keys are Scale-only (a trial counts as Scale, matching the ai-templates and
// custom-industries gates). The raw key is never stored, only its SHA-256 hash.
//
// Rate limiting and last-used tracking are in-memory per process. That is correct
// for a single/low-instance DigitalOcean deployment; if we scale horizontally,
// swap the two Maps for Redis (same note as the signup rate limiter).

const crypto = require('crypto');
const { supabase } = require('../lib/supabase');

const RATE_LIMIT = 120;            // requests per window, per key
const RATE_WINDOW_MS = 60 * 1000;  // 1 minute
const LAST_USED_THROTTLE_MS = 60 * 1000;

const rateBuckets = new Map();     // keyId -> { count, resetAt }
const lastUsedTouch = new Map();   // keyId -> epoch ms of last DB write

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// A trial counts as Scale, matching hasScale() in custom-industries.js.
function hasScale(agency) {
  const isTrialing = ['trialing', 'trial'].includes(agency && agency.subscription_status);
  const effectivePlan = isTrialing ? 'scale' : String((agency && agency.plan_type) || '').toLowerCase();
  return effectivePlan === 'scale';
}

// One consistent error envelope everywhere: { error: { type, message } }.
function fail(res, status, type, message) {
  return res.status(status).json({ error: { type, message } });
}

function parsePagination(req) {
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit)) limit = 25;
  limit = Math.max(1, Math.min(100, limit));
  const cursor = typeof req.query.cursor === 'string' && req.query.cursor ? req.query.cursor : null;
  return { limit, cursor };
}

// rows was fetched with limit+1; if we got the extra row there is another page.
// Cursor is the created_at of the last returned row (created_at DESC ordering).
function sendList(res, rows, limit, mapFn, cursorField) {
  const field = cursorField || 'created_at';
  const hasMore = Array.isArray(rows) && rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : (rows || []);
  const data = page.map(mapFn);
  const nextCursor = hasMore && page.length ? page[page.length - 1][field] : null;
  return res.json({ data, has_more: hasMore, next_cursor: nextCursor });
}

// Public API shapes. These are an allowlist on purpose: DB rows carry internal
// columns (vapi_* ids, visible_password, provider metadata) that must never leave
// through the API. Add a field here to expose it, never return a raw row.
function toPublicClient(c) {
  if (!c) return null;
  return {
    id: c.id,
    business_name: c.business_name,
    email: c.email,
    owner_name: c.owner_name,
    owner_phone: c.owner_phone,
    notification_phone: c.notification_phone,
    industry: c.industry,
    status: c.status,
    subscription_status: c.subscription_status,
    plan_type: c.plan_type,
    is_test_client: c.is_test_client,
    business_city: c.business_city,
    business_state: c.business_state,
    country: c.country,
    business_website: c.business_website,
    phone_number: c.phone_number,          // the provisioned AI number
    forwarding_confirmed: c.forwarding_confirmed,
    created_at: c.created_at,
  };
}

function toPublicCall(c) {
  if (!c) return null;
  return {
    id: c.id,
    client_id: c.client_id,
    caller_phone: c.caller_phone,
    customer_name: c.customer_name,
    customer_phone: c.customer_phone,
    customer_email: c.customer_email,
    customer_address: c.customer_address,
    service_requested: c.service_requested,
    call_status: c.call_status,          // completed | transferred | spam
    urgency_level: c.urgency_level,      // routine | medium | high | emergency | spam
    sentiment: c.sentiment,
    appointment_booked: c.appointment_booked,
    appointment_time: c.appointment_time,
    duration_seconds: c.duration_seconds,
    started_at: c.started_at,
    ended_at: c.ended_at,
    ai_summary: c.ai_summary,
    summary: c.summary,
    transcript: c.transcript,
    recording_url: c.recording_url,      // resolved on single-call fetch
    ended_reason: c.ended_reason,
    transfer_status: c.transfer_status,
    is_spam: c.is_spam,
    spam_reason: c.spam_reason,
    call_language: c.call_language,
    created_at: c.created_at,
  };
}

async function apiKeyAuth(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    const token = (m ? m[1] : (req.headers['x-api-key'] || '')).trim();

    if (!token) {
      return fail(res, 401, 'authentication_error', 'Missing API key. Send it as "Authorization: Bearer <key>".');
    }

    const { data: keyRow, error: keyErr } = await supabase
      .from('agency_api_keys')
      .select('id, agency_id, scope, revoked_at')
      .eq('key_hash', sha256(token))
      .is('revoked_at', null)
      .single();

    if (keyErr || !keyRow) {
      return fail(res, 401, 'authentication_error', 'Invalid or revoked API key.');
    }

    const { data: agency, error: agencyErr } = await supabase
      .from('agencies')
      .select('id, name, slug, plan_type, subscription_status, status')
      .eq('id', keyRow.agency_id)
      .single();

    if (agencyErr || !agency) {
      return fail(res, 401, 'authentication_error', 'The agency for this key no longer exists.');
    }
    if (agency.status === 'suspended') {
      return fail(res, 403, 'account_suspended', 'This agency account is suspended. Contact support to restore API access.');
    }
    if (!hasScale(agency)) {
      return res.status(403).json({
        error: {
          type: 'upgrade_required',
          message: 'The API is available on the Scale plan. Upgrade to enable API access.',
        },
        upgrade_required: true,
        current_plan: agency.plan_type,
      });
    }

    // Per-key rate limit.
    const now = Date.now();
    let bucket = rateBuckets.get(keyRow.id);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
      rateBuckets.set(keyRow.id, bucket);
    }
    bucket.count += 1;
    res.set('X-RateLimit-Limit', String(RATE_LIMIT));
    res.set('X-RateLimit-Remaining', String(Math.max(0, RATE_LIMIT - bucket.count)));
    res.set('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > RATE_LIMIT) {
      res.set('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return fail(res, 429, 'rate_limit_exceeded', 'Too many requests. Slow down and retry after the window resets.');
    }

    // Throttled last-used write (best effort, never blocks the request).
    const lastTouch = lastUsedTouch.get(keyRow.id) || 0;
    if (now - lastTouch > LAST_USED_THROTTLE_MS) {
      lastUsedTouch.set(keyRow.id, now);
      supabase.from('agency_api_keys')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', keyRow.id)
        .then(() => {}, () => {});
    }

    req.agency = agency;
    req.apiKey = { id: keyRow.id, scope: keyRow.scope };
    next();
  } catch (err) {
    console.error('apiKeyAuth error:', err);
    return fail(res, 500, 'api_error', 'Internal error authenticating the request.');
  }
}

function requireScope(needed) {
  return (req, res, next) => {
    const scope = (req.apiKey && req.apiKey.scope) || 'read';
    if (needed === 'read_write' && scope !== 'read_write') {
      return fail(res, 403, 'insufficient_scope', 'This API key is read-only. Use a read_write key for this operation.');
    }
    next();
  };
}

module.exports = {
  apiKeyAuth, requireScope, hasScale, fail,
  parsePagination, sendList, toPublicClient, toPublicCall, sha256,
};
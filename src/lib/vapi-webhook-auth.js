// ============================================================================
// VAPI WEBHOOK AUTHENTICITY  (shared by /webhook/vapi and /webhook/vapi-support)
// ----------------------------------------------------------------------------
// Both VAPI webhooks drive live calls (assistant-request / tool-calls return
// JSON that steers the call) and write records + outbound SMS, so an
// unauthenticated POST is a real hole: assistant-config + transfer-number
// exfiltration, forged calls that inflate usage/billing or exhaust the call
// cap, SMS relay to an attacker-chosen number, and client/business enumeration
// on the support line. VAPI authenticates its Server URL with an opt-in shared
// secret that it sends as either `Authorization: Bearer <secret>` (the modern,
// recommended credential) or the legacy `X-Vapi-Secret: <secret>` header. We
// accept either so it works regardless of which credential type is configured.
//
// FAIL-OPEN WHEN UNCONFIGURED: if VAPI_WEBHOOK_SECRET is not set we do NOT
// reject, because these are live-call webhooks and rejecting before VAPI is set
// up to send the secret would break every client's phone. Rollout order:
//   1. Add a Custom Credential in the VAPI dashboard (Bearer Token, or the
//      legacy X-Vapi-Secret) at org level so it covers every assistant. VAPI
//      then starts sending the header; this code ignores it while the env var
//      is unset, so nothing changes yet.
//   2. Make a test call and confirm it still connects.
//   3. Set VAPI_WEBHOOK_SECRET in the backend env to that same value and
//      redeploy. Verification is now live with no call-breaking window: real
//      VAPI traffic already carries the header, forgeries do not.
// Once the env var IS set, a request with a missing or wrong secret gets 401.
// ============================================================================
const crypto = require('crypto');

// Pull the presented secret from either the modern Bearer header or the legacy
// one. An empty X-Vapi-Secret (a known VAPI misconfig symptom) is falsy here and
// is therefore treated as missing.
function extractVapiSecret(req) {
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const legacy = req.headers['x-vapi-secret'];
  if (legacy) return String(legacy).trim();
  return null;
}

// Constant-time compare. Both sides are hashed to a fixed 32 bytes first so
// timingSafeEqual never throws on a length mismatch and no length is leaked.
function secretsMatch(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

let _warnedUnverified = false;

// Returns { ok: true } to proceed, { ok: true, unconfigured: true } when no
// secret is set (fail-open, warns once), or { ok: false, reason } to reject.
function verifyVapiWebhook(req) {
  const expected = process.env.VAPI_WEBHOOK_SECRET;
  if (!expected) {
    if (!_warnedUnverified) {
      _warnedUnverified = true;
      console.warn('⚠️ VAPI_WEBHOOK_SECRET not set - VAPI webhooks are UNVERIFIED. Add a Custom Credential in VAPI and set this env var to secure them.');
    }
    return { ok: true, unconfigured: true };
  }
  const presented = extractVapiSecret(req);
  if (!presented) return { ok: false, reason: 'missing secret' };
  if (!secretsMatch(presented, expected)) return { ok: false, reason: 'bad secret' };
  return { ok: true };
}

module.exports = { verifyVapiWebhook };
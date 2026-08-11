// ============================================================================
// VAPI RECORDING RESOLVER
// Location: src/lib/vapi-recording.js
// Created: 2026-08-11
//
// As of Aug 2026 VAPI made call-recording storage access-controlled. The
// recordingUrl VAPI sends on the end-of-call report (which we store in
// calls.recording_url) points at VAPI's PRIVATE bucket and is no longer
// directly downloadable, so a browser <audio> pointed at it fails with an
// authorization error and the player shows "Unable to load recording."
//
// VAPI's supported path: call an authenticated per-call endpoint with your
// private API key; it responds 302 with a short-lived signed URL that plays.
// Endpoints: GET https://api.vapi.ai/call/{id}/mono-recording (and stereo-,
// customer-, assistant-recording, etc). Docs:
// https://docs.vapi.ai/assistants/retrieve-call-artifacts
//
// resolveVapiRecordingUrl() pulls the VAPI call id out of the stored URL's
// filename, asks VAPI for a fresh signed URL server-side (the private key never
// leaves the backend), and returns that playable URL. It never throws: on any
// problem it returns the original URL, so behavior is no worse than today.
//
// No new secrets: it uses the VAPI_API_KEY already in the backend environment.
// The signed URL VAPI returns is short lived, so this resolves on each request
// rather than caching the result.
// ============================================================================
const fetch = require('node-fetch');

const VAPI_API_BASE = 'https://api.vapi.ai';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// A private VAPI storage URL is not browser-playable and must be resolved.
// Legacy public URLs (older recordings, voice previews) are left untouched.
function isVapiPrivateRecording(url) {
  if (!url || typeof url !== 'string') return false;
  return url.includes('r2.cloudflarestorage.com') || url.includes('/hipaa-recordings/');
}

// The stored object key is `<vapiCallId>-<timestamp>-<artifactId>-mono.wav`,
// so the first UUID in the filename is the VAPI call id.
function extractVapiCallId(url) {
  try {
    const path = new URL(url).pathname;
    const file = path.split('/').pop() || '';
    const m = file.match(UUID_RE);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

// Resolve a stored (private) recording URL to a fresh, playable signed URL.
// variant is the VAPI artifact endpoint suffix; mono-recording is the single
// combined track a dashboard player wants.
async function resolveVapiRecordingUrl(recordingUrl, { variant = 'mono-recording', timeoutMs = 8000 } = {}) {
  if (!recordingUrl) return recordingUrl;
  if (!isVapiPrivateRecording(recordingUrl)) return recordingUrl;

  const apiKey = process.env.VAPI_API_KEY;
  if (!apiKey) {
    console.warn('⚠️ VAPI recording resolve skipped: VAPI_API_KEY not set. Returning stored (unplayable) URL.');
    return recordingUrl;
  }

  const callId = extractVapiCallId(recordingUrl);
  if (!callId) {
    console.warn('⚠️ VAPI recording resolve: could not extract call id from URL. Returning stored URL.');
    return recordingUrl;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // redirect:'manual' so we capture the 302 Location (the signed URL) instead
    // of streaming the audio bytes through this backend.
    const resp = await fetch(`${VAPI_API_BASE}/call/${callId}/${variant}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      redirect: 'manual',
      signal: ctrl.signal,
    });

    const location = resp.headers.get('location');
    if (REDIRECT_STATUSES.has(resp.status) && location) {
      return location;
    }
    console.warn(`⚠️ VAPI recording resolve: unexpected status ${resp.status} for call ${callId}. Returning stored URL.`);
    return recordingUrl;
  } catch (err) {
    console.warn('⚠️ VAPI recording resolve failed, returning stored URL:', err.message);
    return recordingUrl;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { resolveVapiRecordingUrl, isVapiPrivateRecording, extractVapiCallId };
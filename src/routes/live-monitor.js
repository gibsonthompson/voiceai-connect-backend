// ============================================================================
// src/routes/live-monitor.js
// Mounted at: app.use('/api/client', liveMonitorRoutes)
//
// Powers the live call demo + monitor page. Three endpoints:
//
//   GET  /api/client/:id/live/info     -> small payload the page needs to boot
//                                         (business name, assistant id for the
//                                         web demo, white-label branding).
//   GET  /api/client/:id/live/stream   -> Server-Sent Events. Streams the live
//                                         transcript, call status, and tool
//                                         activity for this client's current
//                                         call. Auth by ?token= because the
//                                         browser EventSource cannot send
//                                         headers.
//   POST /api/client/:id/live/control  -> takeover. Proxies say / mute /
//                                         unmute / end / transfer to the call's
//                                         VAPI controlUrl. Never exposes that
//                                         URL to the browser.
//
// Auth is a local JWT check (same token the dashboard already uses). Access is
// granted to super_admin, the owning agency (owner or staff), or the client
// itself. The SSE feed is read-only; control is the only state change and it is
// gated the same way.
// ============================================================================

const express = require('express');
const router = express.Router();
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { supabase } = require('../lib/supabase');
const {
  subscribe,
  snapshot,
  getCallInfo,
  setMonitorUrls,
  publishToClient,
} = require('../lib/live-monitor-bus');
const { fetchMonitorUrls } = require('../lib/vapi-call-monitor');
const { channelFor, broadcastLiveEvent } = require('../lib/live-broadcast');
const {
  createWebrtcConnection,
  updateWebrtcConnection,
  createTelephonyCredential,
  mintCredentialToken,
  deleteTelephonyCredential,
} = require('../lib/telnyx-voice');
// The voice router exposes the barge controls (and session helpers) on .barge,
// so all call/session logic lives in one file (routes/telnyx-voice.js).
const voiceRouter = require('./telnyx-voice');

const JWT_SECRET = process.env.JWT_SECRET;

// How long a minted WebRTC credential lives before Telnyx auto-expires it. Long
// enough to cover a lengthy takeover; we also delete it explicitly on jump-out.
const WEBRTC_CREDENTIAL_TTL_SECS = parseInt(process.env.WEBRTC_CREDENTIAL_TTL_SECS || '', 10) || (3 * 3600);

// SIP URI calling preference applied to the WebRTC credential connection so a
// call dialed to a registered credential's sip:username@sip.telnyx.com is
// ACCEPTED. Telnyx defaults this to 'disabled', which refuses the dial with a
// 403 (the exact failure seen on the first live barge). The barge dial
// originates from our own Call Control connection (same Telnyx account), so
// 'internal' is the tight/correct value; 'unrestricted' is the guaranteed one
// if Telnyx does not classify the Call Control origination as on-net. Default
// 'unrestricted' so the call connects, overridable with TELNYX_WEBRTC_SIP_URI_CALLING.
const WEBRTC_SIP_URI_PREF = process.env.TELNYX_WEBRTC_SIP_URI_CALLING || 'unrestricted';

// Resolve (and lazily create) the single platform Credential Connection that
// parents every per-agent telephony credential. Cached in platform_settings so
// it is created once and shared across instances.
let _webrtcConnId = null;
let _webrtcCallingEnsured = false;

// Ensure SIP URI calling is enabled on the connection. Runs once per process
// (idempotent on Telnyx), so even a connection created before this fix gets the
// setting applied on the next jump-in without any manual surgery.
async function ensureWebrtcCalling(connId) {
  if (_webrtcCallingEnsured || !connId) return;
  const r = await updateWebrtcConnection(connId, { sip_uri_calling_preference: WEBRTC_SIP_URI_PREF });
  if (r) {
    _webrtcCallingEnsured = true;
    console.log(`live-monitor: 🎧 barge WebRTC connection ${connId} sip_uri_calling_preference=${WEBRTC_SIP_URI_PREF}`);
  } else {
    console.warn(`live-monitor: 🎧 barge could NOT set sip_uri_calling_preference=${WEBRTC_SIP_URI_PREF} on ${connId} (dial may still 403)`);
  }
}

async function getWebrtcConnectionId() {
  if (_webrtcConnId) { await ensureWebrtcCalling(_webrtcConnId); return _webrtcConnId; }
  try {
    const { data } = await supabase
      .from('platform_settings')
      .select('value')
      .eq('key', 'telnyx_webrtc_connection_id')
      .maybeSingle();
    if (data && data.value) { _webrtcConnId = data.value; await ensureWebrtcCalling(_webrtcConnId); return _webrtcConnId; }
  } catch (e) { /* fall through to create */ }

  const conn = await createWebrtcConnection('voiceai-connect-webrtc');
  if (!conn || !conn.id) { console.error('live-monitor: 🎧 barge could not create WebRTC credential connection (check TELNYX_API_KEY + account WebRTC access)'); return null; }
  _webrtcConnId = conn.id;
  console.log(`live-monitor: 🎧 barge created WebRTC credential connection ${conn.id} (first run; cached in platform_settings)`);
  try {
    await supabase.from('platform_settings')
      .upsert({ key: 'telnyx_webrtc_connection_id', value: conn.id }, { onConflict: 'key' });
  } catch (e) { console.warn('live-monitor: could not persist webrtc connection id:', e.message); }
  await ensureWebrtcCalling(_webrtcConnId);
  return _webrtcConnId;
}

// Resolve the own-the-call session for a live VAPI call id, scoped to this
// client so one client can never drive another's call.
async function resolveBargeSession(callId, clientId) {
  if (!callId) return null;
  try {
    const s = await voiceRouter.barge.getSessionByVapiCallId(callId);
    if (s && s.client_id === clientId) return s;
  } catch (e) {}
  return null;
}

function decodeToken(raw) {
  if (!raw || !JWT_SECRET) return null;
  const token = String(raw).startsWith('Bearer ') ? String(raw).slice(7) : String(raw);
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

// Resolve the client and confirm the token is allowed to watch/control it.
async function authorizeClient(clientId, tokenRaw) {
  const decoded = decodeToken(tokenRaw);
  if (!decoded) return { ok: false, code: 401 };

  const { data: client } = await supabase
    .from('clients')
    .select('id, agency_id, business_name, vapi_assistant_id, industry, voice_routing')
    .eq('id', clientId)
    .single();

  if (!client) return { ok: false, code: 404 };

  const role = decoded.role;
  const allowed =
    role === 'super_admin' ||
    ((role === 'agency_owner' || role === 'agency_staff') && decoded.agencyId && decoded.agencyId === client.agency_id) ||
    (role === 'client_staff' && decoded.clientId && decoded.clientId === client.id);

  if (!allowed) return { ok: false, code: 403 };
  return { ok: true, client, decoded };
}

function errText(code) {
  if (code === 403) return 'Forbidden';
  if (code === 404) return 'Client not found';
  return 'Unauthorized';
}

// ---- GET /api/client/:id/live/info ----------------------------------------
router.get('/:id/live/info', async (req, res) => {
  const auth = await authorizeClient(req.params.id, req.headers.authorization || req.query.token);
  if (!auth.ok) return res.status(auth.code).json({ success: false, error: errText(auth.code) });

  // Branding comes from the agency, fetched separately and best-effort so a
  // branding hiccup (or a missing column) can never 404 the whole page.
  let a = {};
  try {
    if (auth.client.agency_id) {
      const { data: ag } = await supabase
        .from('agencies')
        .select('name, logo_url, primary_color, accent_color')
        .eq('id', auth.client.agency_id)
        .single();
      if (ag) a = ag;
    }
  } catch (e) { /* branding is optional */ }

  res.json({
    success: true,
    client: {
      id: auth.client.id,
      business_name: auth.client.business_name,
      // The web demo places a browser call straight to this assistant.
      assistant_id: auth.client.vapi_assistant_id || null,
      industry: auth.client.industry || null,
    },
    // White-label: the page shows the agency's brand, never the platform's.
    branding: {
      agency_name: a.name || null,
      logo_url: a.logo_url || null,
      primary_color: a.primary_color || null,
      accent_color: a.accent_color || null,
    },
    // So the page can warn instead of silently failing the web demo.
    web_demo_available: !!auth.client.vapi_assistant_id,
    // Browser human-barge ("jump in and talk") only works on own-the-call
    // (telnyx_cc) numbers, where we own the caller leg and can bridge a browser
    // endpoint to it. The UI shows/hides the jump-in control on this flag.
    barge_supported: auth.client.voice_routing === 'telnyx_cc',
    // Supabase Realtime channel this viewer subscribes to for live events. The
    // name is an unguessable keyed HMAC of the client id, issued only here (to
    // an authorized viewer); the webhook broadcasts to the same name.
    realtime_channel: channelFor(auth.client.id),
  });
});

// ---- GET /api/client/:id/live/stream (SSE) --------------------------------
router.get('/:id/live/stream', async (req, res) => {
  const auth = await authorizeClient(req.params.id, req.query.token || req.headers.authorization);
  if (!auth.ok) return res.status(auth.code).json({ success: false, error: errText(auth.code) });
  const clientId = auth.client.id;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Tell nginx / proxies not to buffer the stream.
    'X-Accel-Buffering': 'no',
  });
  // Real-time delivery: push headers now, turn off Nagle so small events are not
  // held for coalescing, and flush after every write. The padding comment forces
  // any proxy that buffers a small amount to release the stream immediately.
  try { res.flushHeaders(); } catch (e) {}
  try { if (res.socket) res.socket.setNoDelay(true); } catch (e) {}
  res.write(`:${' '.repeat(2048)}\n\n`);
  res.write('retry: 3000\n\n');
  if (typeof res.flush === 'function') { try { res.flush(); } catch (e) {} }

  const send = (event, data) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    } catch (e) {}
  };

  send('hello', { clientId, business: auth.client.business_name, ts: Date.now() });
  // Catch a late-joining viewer up on the call already in progress.
  for (const ev of snapshot(clientId)) send('event', ev);

  const unsub = subscribe(clientId, (ev) => send('event', ev));
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); if (typeof res.flush === 'function') res.flush(); } catch (e) {}
  }, 15000);

  let closed = false;
  const cleanup = () => { if (closed) return; closed = true; clearInterval(heartbeat); unsub(); try { res.end(); } catch {} };
  req.on('close', cleanup);
  req.on('error', cleanup);
});

// ---- POST /api/client/:id/live/control (takeover) -------------------------
router.post('/:id/live/control', async (req, res) => {
  const auth = await authorizeClient(req.params.id, req.headers.authorization);
  if (!auth.ok) return res.status(auth.code).json({ success: false, error: errText(auth.code) });

  const { callId, action, text, number } = req.body || {};
  if (!callId || !action) return res.status(400).json({ success: false, error: 'callId and action are required' });

  const info = getCallInfo(callId);
  if (!info || info.clientId !== auth.client.id) {
    return res.status(404).json({ success: false, error: 'No live call to control' });
  }

  // Use the cached controlUrl, or fall back to asking VAPI for the call so
  // takeover works even if the webhook events did not carry the monitor URLs.
  let controlUrl = info.controlUrl;
  if (!controlUrl) {
    const urls = await fetchMonitorUrls(callId);
    if (urls.controlUrl) { setMonitorUrls(callId, urls.controlUrl, urls.listenUrl); controlUrl = urls.controlUrl; }
  }
  if (!controlUrl) {
    return res.status(409).json({ success: false, error: 'The control channel is not ready yet, try again in a second' });
  }

  let payload;
  switch (action) {
    case 'say':
      if (!String(text || '').trim()) return res.status(400).json({ success: false, error: 'text is required to speak' });
      payload = { type: 'say', content: String(text).slice(0, 500) };
      break;
    case 'mute':
      payload = { type: 'control', control: 'mute-assistant' };
      break;
    case 'unmute':
      payload = { type: 'control', control: 'unmute-assistant' };
      break;
    case 'end':
      payload = { type: 'end-call' };
      break;
    case 'transfer':
      if (!String(number || '').trim()) return res.status(400).json({ success: false, error: 'number is required to transfer' });
      payload = {
        type: 'transfer',
        destination: { type: 'number', number: String(number).trim() },
        content: String(text || 'Transferring your call now.').slice(0, 300),
      };
      break;
    default:
      return res.status(400).json({ success: false, error: `Unknown action: ${action}` });
  }

  try {
    const r = await axios.post(controlUrl, payload, {
      headers: { 'content-type': 'application/json' },
      timeout: 8000,
    });
    // Reflect the takeover into the monitor so every viewer sees what the
    // human just did.
    broadcastLiveEvent(auth.client.id, { callId, type: 'takeover', action, text: text || null });
    return res.json({ success: true, result: r.data ?? null });
  } catch (e) {
    return res.status(502).json({
      success: false,
      error: 'Control request failed',
      detail: (e && e.response && e.response.data) || (e && e.message) || 'unknown',
    });
  }
});

// ---- POST /api/client/:id/live/webrtc-token -------------------------------
// Step 1 of a browser human-barge. Mint a short-lived Telnyx WebRTC credential
// + login token so the agent's browser can register as an audio endpoint. The
// credential's sip_username is stored on the call session (server-side) so the
// follow-up jump-in dials exactly this endpoint and a client can never inject a
// different one. The token is returned once and never logged.
router.post('/:id/live/webrtc-token', async (req, res) => {
  const auth = await authorizeClient(req.params.id, req.headers.authorization);
  if (!auth.ok) return res.status(auth.code).json({ success: false, error: errText(auth.code) });

  if (auth.client.voice_routing !== 'telnyx_cc') {
    return res.status(409).json({ success: false, error: 'Live jump-in is available on own-the-call numbers only.' });
  }

  const { callId } = req.body || {};
  if (!callId) return res.status(400).json({ success: false, error: 'callId is required' });

  const session = await resolveBargeSession(callId, auth.client.id);
  if (!session) {
    return res.status(404).json({ success: false, error: 'No live own-the-call session to join.' });
  }

  const connectionId = await getWebrtcConnectionId();
  if (!connectionId) {
    return res.status(503).json({ success: false, error: 'Browser audio is not configured yet. Try again shortly.' });
  }

  const cred = await createTelephonyCredential(connectionId, {
    name: `va-${auth.client.id}-${Date.now().toString(36)}`,
    expiresInSecs: WEBRTC_CREDENTIAL_TTL_SECS,
  });
  if (!cred || !cred.id || !cred.sip_username) {
    return res.status(502).json({ success: false, error: 'Could not set up browser audio. Try again.' });
  }

  const token = await mintCredentialToken(cred.id);
  if (!token) {
    await deleteTelephonyCredential(cred.id);
    return res.status(502).json({ success: false, error: 'Could not set up browser audio. Try again.' });
  }

  console.log(`live-monitor: 🎧 barge token minted session=${session.id} sip_username=${cred.sip_username} connection=${connectionId}`);

  // Stash the endpoint on the session so jump-in dials exactly this credential.
  try {
    await voiceRouter.barge.updateSession(session.id, {
      telnyx_agent_sip_username: cred.sip_username,
      telnyx_agent_credential_id: cred.id,
    });
  } catch (e) {
    await deleteTelephonyCredential(cred.id);
    return res.status(500).json({ success: false, error: 'Could not prepare the call for jump-in.' });
  }

  return res.json({
    success: true,
    login_token: token,
    sip_username: cred.sip_username,
    sessionId: session.id,
    ttl_seconds: WEBRTC_CREDENTIAL_TTL_SECS,
  });
});

// ---- POST /api/client/:id/live/jump-in ------------------------------------
// Step 2: the browser is registered (TelnyxRTC connected) and ready to receive
// audio. Dial that endpoint and swap the AI out for the human. The endpoint to
// dial is read from the session (set by webrtc-token), never from the client.
// (phase 2) seat the supervisor in the conference. The browser registers first
// (webrtc-token + TelnyxRTC), then this promotes the call to a conference and
// dials the browser in as a muted monitor for real-time listen.
router.post('/:id/live/listen-start', async (req, res) => {
  const auth = await authorizeClient(req.params.id, req.headers.authorization);
  if (!auth.ok) return res.status(auth.code).json({ success: false, error: errText(auth.code) });

  const { callId, agentName } = req.body || {};
  if (!callId) return res.status(400).json({ success: false, error: 'callId is required' });

  const session = await resolveBargeSession(callId, auth.client.id);
  if (!session) return res.status(404).json({ success: false, error: 'No live own-the-call session to join.' });
  if (!session.telnyx_agent_sip_username) {
    return res.status(409).json({ success: false, error: 'Browser audio is not ready. Reconnect and try again.' });
  }

  console.log(`live-monitor: 🎧 listen-start requested client=${auth.client.id} call=${callId} session=${session.id}`);
  const result = await voiceRouter.barge.startSupervisorListen({
    sessionId: session.id,
    sipUsername: session.telnyx_agent_sip_username,
    credentialId: session.telnyx_agent_credential_id,
    agentName: typeof agentName === 'string' ? agentName : null,
  });
  if (!result.ok) {
    console.warn(`live-monitor: 🎧 listen-start refused session=${session.id}: ${result.error}`);
    return res.status(result.code || 409).json({ success: false, error: result.error || 'Could not open live audio.' });
  }
  return res.json({ success: true });
});

// (phase 2) stop listening: leave the conference seat. The call continues.
router.post('/:id/live/listen-stop', async (req, res) => {
  const auth = await authorizeClient(req.params.id, req.headers.authorization);
  if (!auth.ok) return res.status(auth.code).json({ success: false, error: errText(auth.code) });

  const { callId } = req.body || {};
  if (!callId) return res.status(400).json({ success: false, error: 'callId is required' });

  const session = await resolveBargeSession(callId, auth.client.id);
  if (!session) return res.json({ success: true });

  try { await voiceRouter.barge.supervisorLeaveSeat(session.id); }
  catch (e) { console.error('live-monitor: listen-stop failed:', e.message); }
  broadcastLiveEvent(auth.client.id, { callId, type: 'takeover', action: 'listen_stop' });
  return res.json({ success: true });
});

// ---- POST /api/client/:id/live/jump-in ------------------------------------
// (phase 2) flip the seated supervisor from listening to talking: drop the AI
// and let the human take the caller. Requires an active listen seat.
router.post('/:id/live/jump-in', async (req, res) => {
  const auth = await authorizeClient(req.params.id, req.headers.authorization);
  if (!auth.ok) return res.status(auth.code).json({ success: false, error: errText(auth.code) });

  const { callId } = req.body || {};
  if (!callId) return res.status(400).json({ success: false, error: 'callId is required' });

  const session = await resolveBargeSession(callId, auth.client.id);
  if (!session) return res.status(404).json({ success: false, error: 'No live own-the-call session to join.' });

  console.log(`live-monitor: 🎧 jump-in requested client=${auth.client.id} call=${callId} session=${session.id}`);
  const result = await voiceRouter.barge.supervisorJumpIn(session.id);
  if (!result.ok) {
    console.warn(`live-monitor: 🎧 jump-in refused session=${session.id}: ${result.error}`);
    return res.status(result.code || 409).json({ success: false, error: result.error || 'Could not join the call.' });
  }
  broadcastLiveEvent(auth.client.id, { callId, type: 'takeover', action: 'jump_in' });
  return res.json({ success: true });
});

// ---- POST /api/client/:id/live/jump-out -----------------------------------
// (phase 2) the human stops talking. mode 'end_call' ends the call; anything
// else hands the caller back to the AI and keeps the seat listening.
router.post('/:id/live/jump-out', async (req, res) => {
  const auth = await authorizeClient(req.params.id, req.headers.authorization);
  if (!auth.ok) return res.status(auth.code).json({ success: false, error: errText(auth.code) });

  const { callId, mode } = req.body || {};
  if (!callId) return res.status(400).json({ success: false, error: 'callId is required' });

  const session = await resolveBargeSession(callId, auth.client.id);
  if (!session) return res.status(404).json({ success: false, error: 'No live session.' });

  let result = { ok: true, mode: mode === 'end_call' ? 'end_call' : 'return_ai' };
  try {
    result = await voiceRouter.barge.supervisorJumpOut(session.id, mode);
  } catch (e) {
    console.error('live-monitor: jump-out failed:', e.message);
    return res.status(500).json({ success: false, error: 'Could not leave the call.' });
  }
  broadcastLiveEvent(auth.client.id, { callId, type: 'takeover', action: 'jump_out', mode: result.mode });
  return res.json({ success: true, mode: result.mode });
});

module.exports = router;
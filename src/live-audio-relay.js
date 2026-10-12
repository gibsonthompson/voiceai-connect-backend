// ============================================================================
// src/live-audio-relay.js
//
// Live audio relay for the call monitor. Lets an authorized agency/supervisor
// HEAR a real phone call in progress, not just read the transcript.
//
// How it works:
//   browser  --(wss)-->  this backend  --(wss)-->  VAPI call monitor.listenUrl
//
// The browser opens a WebSocket to /api/live/audio?client=..&call=..&token=..
// We authorize it (same JWT + client-ownership check as the SSE monitor), look
// up that call's VAPI listenUrl (captured by the webhook into the monitor bus),
// dial it, and pipe the raw binary audio straight through to the browser. VAPI's
// listenUrl is never exposed to the browser, and access is gated server-side so
// a listener can be cut off.
//
// The audio is raw headerless PCM (signed 16-bit little-endian, mono). VAPI does
// not announce the sample rate and it varies by telephony path, so we pass the
// bytes through untouched and let the browser pick the playback rate. Keeping
// the relay format-agnostic is deliberate: it never has to be "right" about the
// rate, so it keeps working if VAPI changes it.
//
// Attached to the existing HTTP server in server.js via attach(server). Pure
// addition: it only handles upgrades on its own path and touches nothing else.
// ============================================================================

const { WebSocketServer, WebSocket } = require('ws');
const urlLib = require('url');
const jwt = require('jsonwebtoken');
const { supabase } = require('./lib/supabase');
const bus = require('./lib/live-monitor-bus');
const { fetchMonitorUrls } = require('./lib/vapi-call-monitor');

const JWT_SECRET = process.env.JWT_SECRET;
const WS_PATH = '/api/live/audio';
const WS_EVENTS_PATH = '/api/live/events';
const MAX_LISTEN_MS = 30 * 60 * 1000; // hard cap on a single listen session

function decodeToken(token) {
  if (!token || !JWT_SECRET) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

// Client-ownership check for the events stream (no specific call required): same
// rule as the SSE monitor and the audio relay, minus the call-info requirement,
// so a viewer can connect and wait for the next call.
async function authorizeClientOnly(clientId, token) {
  const decoded = decodeToken(token);
  if (!decoded || !clientId) return null;
  const { data: client } = await supabase
    .from('clients')
    .select('id, agency_id')
    .eq('id', clientId)
    .single();
  if (!client) return null;
  const role = decoded.role;
  const ok =
    role === 'super_admin' ||
    ((role === 'agency_owner' || role === 'agency_staff') && decoded.agencyId && decoded.agencyId === client.agency_id) ||
    (role === 'client_staff' && decoded.clientId && decoded.clientId === client.id);
  return ok ? client : null;
}

// Same access rule as routes/live-monitor.js: super_admin, the owning agency, or
// the client itself. Also requires the call to be known and to have a listenUrl.
async function authorize(clientId, callId, token) {
  const decoded = decodeToken(token);
  if (!decoded || !clientId || !callId) return null;

  const info = bus.getCallInfo(callId);
  // listenUrl may not be cached yet; the connection handler fetches it as a
  // fallback. Here we only require that the call is known and owned.
  if (!info || info.clientId !== clientId) return null;

  const { data: client } = await supabase
    .from('clients')
    .select('id, agency_id')
    .eq('id', clientId)
    .single();
  if (!client) return null;

  const role = decoded.role;
  const ok =
    role === 'super_admin' ||
    ((role === 'agency_owner' || role === 'agency_staff') && decoded.agencyId && decoded.agencyId === client.agency_id) ||
    (role === 'client_staff' && decoded.clientId && decoded.clientId === client.id);

  return ok ? info : null;
}

function safeSend(ws, obj) {
  try { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); } catch {}
}

function attach(server) {
  const wss = new WebSocketServer({ noServer: true });
  const eventsWss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try { pathname = urlLib.parse(req.url).pathname || ''; } catch { pathname = ''; }
    // Route the two live-monitor WebSocket paths; close anything else.
    if (pathname === WS_PATH) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else if (pathname === WS_EVENTS_PATH) {
      eventsWss.handleUpgrade(req, socket, head, (ws) => eventsWss.emit('connection', ws, req));
    } else {
      try { socket.destroy(); } catch {}
    }
  });

  // ---- Live events push: transcript / status / activity over a direct WS ----
  // The SSE monitor works, but DigitalOcean's proxy buffers the SSE stream, so
  // events arrive late. A WebSocket upgrade is passed through frame by frame
  // (that's how the audio relay already works), so this delivers the same live
  // events the SSE route does, in real time. The browser prefers whichever
  // arrives first and de-dupes by id, so this simply wins the race. Single
  // instance, so the in-memory bus reaches every viewer.
  eventsWss.on('connection', async (browser, req) => {
    let query = {};
    try { query = urlLib.parse(req.url, true).query || {}; } catch {}
    const clientId = String(query.client || '');
    const token = String(query.token || '');

    const client = await authorizeClientOnly(clientId, token);
    if (!client) {
      safeSend(browser, { type: 'error', error: 'Not authorized' });
      try { browser.close(); } catch {}
      return;
    }

    safeSend(browser, { type: 'hello', clientId, ts: Date.now() });
    // Catch a late-joining viewer up on the call already in progress.
    try { for (const ev of bus.snapshot(clientId)) safeSend(browser, ev); } catch {}

    const unsub = bus.subscribe(clientId, (ev) => safeSend(browser, ev));
    const heartbeat = setInterval(() => { try { if (browser.readyState === browser.OPEN) browser.ping(); } catch {} }, 15000);

    let closed = false;
    const cleanup = () => { if (closed) return; closed = true; clearInterval(heartbeat); try { unsub(); } catch {} try { browser.close(); } catch {} };
    browser.on('close', cleanup);
    browser.on('error', cleanup);
  });

  wss.on('connection', async (browser, req) => {
    let query = {};
    try { query = urlLib.parse(req.url, true).query || {}; } catch {}
    const clientId = String(query.client || '');
    const callId = String(query.call || '');
    const token = String(query.token || '');

    const info = await authorize(clientId, callId, token);
    if (!info) {
      safeSend(browser, { type: 'error', error: 'Not authorized or no live audio for this call' });
      try { browser.close(); } catch {}
      return;
    }

    // Resolve the listen stream URL: cached from the webhook, or fetched from
    // VAPI as a fallback so audio works even if events did not carry it.
    let listenUrl = info.listenUrl;
    if (!listenUrl) {
      const urls = await fetchMonitorUrls(callId);
      if (urls.listenUrl) { bus.setMonitorUrls(callId, urls.controlUrl, urls.listenUrl); listenUrl = urls.listenUrl; }
    }
    if (!listenUrl) {
      safeSend(browser, { type: 'error', error: 'No live audio available for this call yet' });
      try { browser.close(); } catch {}
      return;
    }

    let upstream;
    try {
      upstream = new WebSocket(listenUrl);
    } catch (e) {
      safeSend(browser, { type: 'error', error: 'Could not open the listen stream' });
      try { browser.close(); } catch {}
      return;
    }

    const killTimer = setTimeout(() => {
      try { browser.close(); } catch {}
      try { upstream.close(); } catch {}
    }, MAX_LISTEN_MS);

    const shutdown = () => {
      clearTimeout(killTimer);
      try { upstream.close(); } catch {}
      try { browser.close(); } catch {}
    };

    upstream.on('open', () => safeSend(browser, { type: 'ready', callId }));
    upstream.on('message', (data, isBinary) => {
      if (browser.readyState !== browser.OPEN) return;
      // Pass the raw PCM frames straight through. Ignore upstream text metadata;
      // the transcript already reaches the browser over the SSE monitor.
      if (isBinary) { try { browser.send(data); } catch {} }
    });
    upstream.on('close', shutdown);
    upstream.on('error', () => { safeSend(browser, { type: 'error', error: 'Listen stream error' }); shutdown(); });

    browser.on('close', shutdown);
    browser.on('error', shutdown);
  });

  console.log(`🎧 Live audio relay attached at ${WS_PATH}; events relay at ${WS_EVENTS_PATH}`);
}

module.exports = { attach };
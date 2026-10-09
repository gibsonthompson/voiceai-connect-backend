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

const JWT_SECRET = process.env.JWT_SECRET;
const WS_PATH = '/api/live/audio';
const MAX_LISTEN_MS = 30 * 60 * 1000; // hard cap on a single listen session

function decodeToken(token) {
  if (!token || !JWT_SECRET) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

// Same access rule as routes/live-monitor.js: super_admin, the owning agency, or
// the client itself. Also requires the call to be known and to have a listenUrl.
async function authorize(clientId, callId, token) {
  const decoded = decodeToken(token);
  if (!decoded || !clientId || !callId) return null;

  const info = bus.getCallInfo(callId);
  if (!info || info.clientId !== clientId || !info.listenUrl) return null;

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

  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try { pathname = urlLib.parse(req.url).pathname || ''; } catch { pathname = ''; }
    // Only claim our own path. Nothing else in this app uses WebSocket upgrades;
    // any other upgrade is unexpected, so close it rather than leave it hanging.
    if (pathname !== WS_PATH) { try { socket.destroy(); } catch {} return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
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

    let upstream;
    try {
      upstream = new WebSocket(info.listenUrl);
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

  console.log(`🎧 Live audio relay attached at ${WS_PATH}`);
}

module.exports = { attach };

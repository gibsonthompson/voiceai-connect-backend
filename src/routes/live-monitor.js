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

const JWT_SECRET = process.env.JWT_SECRET;

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
    .select('id, agency_id, business_name, vapi_assistant_id, industry')
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
  res.write('retry: 3000\n\n');

  const send = (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
  };

  send('hello', { clientId, business: auth.client.business_name, ts: Date.now() });
  // Catch a late-joining viewer up on the call already in progress.
  for (const ev of snapshot(clientId)) send('event', ev);

  const unsub = subscribe(clientId, (ev) => send('event', ev));
  const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);

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
    publishToClient(auth.client.id, { callId, type: 'takeover', action, text: text || null });
    return res.json({ success: true, result: r.data ?? null });
  } catch (e) {
    return res.status(502).json({
      success: false,
      error: 'Control request failed',
      detail: (e && e.response && e.response.data) || (e && e.message) || 'unknown',
    });
  }
});

module.exports = router;

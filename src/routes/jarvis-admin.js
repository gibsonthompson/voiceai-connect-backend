// ============================================================================
// JARVIS ADMIN / PROVISIONING  (destination: src/routes/jarvis-admin.js)
// ----------------------------------------------------------------------------
// Layer 1 of the Secretary AI / Jarvis phone line. One-time, idempotent
// provisioning of the dedicated number Gibson calls, plus small status/repin
// helpers. Reuses the platform's existing number-buy path (provisionPhoneNumber)
// and points the number at the Jarvis webhook in VAPI's dynamic
// assistant-request mode (assistantId null, serverUrl set), the same shape the
// receptionist/demo lines use.
//
// The number id + E.164 are stored in platform_settings (VAC's DB) under the
// key 'jarvis_config', so re-running provision never buys a second number.
//
// SECURITY: these routes can spend money (buy a number) and reconfigure
// telephony, so every route requires the x-cron-secret header to match
// CRON_SECRET, matching how the other operational/cron endpoints here are gated.
//
// Nothing here touches HQ's database or the receptionist. Mount in server.js:
//   app.use('/api/jarvis', require('./routes/jarvis-admin'));
// ============================================================================

'use strict';

const express = require('express');
const router = express.Router();

const { provisionPhoneNumber, getPlatformSetting, setPlatformSetting } = require('../lib/vapi');

// Same resolution vapi.js uses, so the serverUrl host matches the other
// webhooks exactly.
const BACKEND_URL = process.env.BACKEND_URL || 'https://api.voiceaiconnect.com';
const JARVIS_SERVER_URL = `${BACKEND_URL}/webhook/vapi-jarvis`;
const SETTINGS_KEY = 'jarvis_config';

// North Georgia first (Gainesville / metro Atlanta), then the rest of GA, so the
// line has a local number. provisionPhoneNumber does its own inventory search
// per code; we walk codes until one lands.
const GA_AREA_CODES = ['770', '470', '678', '404', '762', '706', '912', '229', '478'];

function requireSecret(req, res, next) {
  const secret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// PATCH the VAPI phone number to fire assistant-request at the Jarvis webhook on
// every call (assistantId null forces dynamic mode). provisionPhoneNumber pins
// new numbers at the receptionist webhook by default, so this re-points ours.
async function pointNumberAtJarvis(vapiPhoneId) {
  const res = await fetch(`https://api.vapi.ai/phone-number/${vapiPhoneId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${process.env.VAPI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      assistantId: null,
      serverUrl: JARVIS_SERVER_URL,
      serverUrlSecret: process.env.VAPI_WEBHOOK_SECRET,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Failed to point number at Jarvis webhook (HTTP ${res.status}): ${t.slice(0, 300)}`);
  }
  return true;
}

// GET /api/jarvis/status - current provisioning state, no side effects.
router.get('/status', requireSecret, async (req, res) => {
  try {
    const cfg = await getPlatformSetting(SETTINGS_KEY);
    res.json({ provisioned: !!(cfg && cfg.vapiPhoneId), serverUrl: JARVIS_SERVER_URL, config: cfg || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/jarvis/provision - idempotent. Buys the number once, points it at
// the Jarvis webhook, stores config. Re-running returns the existing number.
// Body/query: { areaCode? } preferred area code, { force? } to buy a NEW number
// even if one exists (does NOT release the old one; use only deliberately).
router.post('/provision', requireSecret, async (req, res) => {
  try {
    const force = req.query.force === '1' || req.body?.force === true;
    const existing = await getPlatformSetting(SETTINGS_KEY);

    if (existing && existing.vapiPhoneId && !force) {
      // Idempotent: already provisioned. Make sure it still points at Jarvis
      // (cheap, safe re-PATCH), then return it. Never buys a second number.
      try { await pointNumberAtJarvis(existing.vapiPhoneId); } catch (e) {
        console.warn('⚠️ Jarvis re-point during idempotent provision failed:', e.message);
      }
      return res.json({ ok: true, alreadyProvisioned: true, config: existing });
    }

    const preferred = (req.query.areaCode || req.body?.areaCode || '').toString().replace(/\D/g, '');
    const codes = [];
    if (preferred) codes.push(preferred);
    for (const c of GA_AREA_CODES) if (!codes.includes(c)) codes.push(c);

    let phone = null;
    const tried = [];
    for (const code of codes) {
      tried.push(code);
      try {
        phone = await provisionPhoneNumber(code);
        console.log(`✅ Jarvis number provisioned: ${phone.number} (area ${code})`);
        break;
      } catch (err) {
        console.log(`   ❌ Jarvis area ${code}: ${err.message}`);
        if (err.isAccountLevel) {
          // Telnyx/VAPI account-level problem, no point trying more codes.
          return res.status(502).json({ error: 'Account-level provisioning error', detail: err.message });
        }
      }
    }

    if (!phone) {
      return res.status(502).json({ error: `No number available (tried ${tried.join(', ')})` });
    }

    await pointNumberAtJarvis(phone.id);

    const config = {
      number: phone.number,
      vapiPhoneId: phone.id,
      serverUrl: JARVIS_SERVER_URL,
      provisionedAt: new Date().toISOString(),
    };
    await setPlatformSetting(SETTINGS_KEY, config);

    console.log(`🎉 Jarvis line ready: ${phone.number} -> ${JARVIS_SERVER_URL}`);
    res.json({ ok: true, alreadyProvisioned: false, config });
  } catch (e) {
    console.error('❌ Jarvis provision failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/jarvis/repin - re-point the stored number at the Jarvis webhook
// without buying anything. Use after changing BACKEND_URL or the webhook path.
router.post('/repin', requireSecret, async (req, res) => {
  try {
    const cfg = await getPlatformSetting(SETTINGS_KEY);
    if (!cfg || !cfg.vapiPhoneId) return res.status(404).json({ error: 'No Jarvis number provisioned yet' });
    await pointNumberAtJarvis(cfg.vapiPhoneId);
    const updated = { ...cfg, serverUrl: JARVIS_SERVER_URL, repinnedAt: new Date().toISOString() };
    await setPlatformSetting(SETTINGS_KEY, updated);
    res.json({ ok: true, config: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

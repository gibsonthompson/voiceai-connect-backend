// ============================================================================
// JARVIS ADMIN / PROVISIONING  (destination: src/routes/jarvis-admin.js)
// ----------------------------------------------------------------------------
// Layer 1 of the Secretary AI / Jarvis phone line: provisioning of the dedicated
// number Gibson calls, plus status / repin / ensure helpers and a boot-time
// self-heal.
//
// WHY THIS IS HARDENED (2026-10-09): the line broke repeatedly because the
// Jarvis number's VAPI routing drifted (a cleanup sweep wiped it, a re-provision
// pinned it at the receptionist webhook, or jarvis_config pointed at an old /
// released number). Fixes here:
//   1. resolveJarvisPhoneId() finds the number from VAPI by last-10 digits, so
//      it never depends on a stale jarvis_config row (same precedence the
//      briefing cron uses, kept in sync on purpose).
//   2. pointNumberAtJarvis() pins the VERIFIED-correct shape: TOP-LEVEL
//      serverUrl + serverUrlSecret, and server:null to clear any stale nested
//      server field that mutes the line to voicemail.
//   3. POST /api/jarvis/ensure: one call that resolves the real number, pins it,
//      writes jarvis_config (so the number-cleanup allowlist protects it), and
//      reports every other number still pointed at the Jarvis webhook so the
//      duplicates can be released with the existing reconcile endpoints.
//   4. Boot self-heal: on every deploy the Jarvis number is re-pinned, so a
//      drifted config auto-corrects. Disable with JARVIS_SELF_HEAL=0.
//
// Releasing the duplicates is NOT done here (that stays with the audited
// reconcile endpoints that protect the allowlist): after /ensure locks in the
// canonical number, run POST /api/cron/reconcile-vapi and
// POST /api/cron/reconcile-telnyx (dry-run, then ?apply=true).
//
// SECURITY: these routes can spend money (buy a number) and reconfigure
// telephony, so every route requires x-cron-secret == CRON_SECRET. Nothing here
// touches HQ's database or the receptionist.
//
// Mount in server.js:  app.use('/api/jarvis', require('./routes/jarvis-admin'));
// ============================================================================

'use strict';

const express = require('express');
const router = express.Router();

const { provisionPhoneNumber, getPlatformSetting, setPlatformSetting } = require('../lib/vapi');

// Same resolution vapi.js uses, so the serverUrl host matches the other webhooks.
const BACKEND_URL = process.env.BACKEND_URL || 'https://api.voiceaiconnect.com';
const JARVIS_SERVER_URL = `${BACKEND_URL}/webhook/vapi-jarvis`;
const SETTINGS_KEY = 'jarvis_config';

// Last 10 digits of the canonical Jarvis number. Matched against VAPI's own list
// so a changed/re-bought number is still found. Mirrors jarvis-briefing.js.
const JARVIS_NUMBER_LAST10 = process.env.JARVIS_NUMBER_LAST10 || '4708210165';

// North Georgia first, then the rest of GA, so the line has a local number.
const GA_AREA_CODES = ['770', '470', '678', '404', '762', '706', '912', '229', '478'];

const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
const urlOf = (p) => (p && (p.serverUrl || (p.server && p.server.url))) || '';
const pointsAtJarvis = (p) => urlOf(p).includes('/webhook/vapi-jarvis');

function requireSecret(req, res, next) {
  const secret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// List every phone number on the VAPI account.
async function listVapiNumbers() {
  const res = await fetch('https://api.vapi.ai/phone-number?limit=1000', {
    headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`VAPI list phone-numbers HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : (data.results || data.data || []);
}

// Resolve the canonical Jarvis VAPI phone id. Precedence, identical to the
// briefing cron: explicit env override, then VAPI's own list matched by last-10,
// then the stored jarvis_config. Returns { id, number } or null.
async function resolveJarvisNumber(vapiList) {
  const list = vapiList || await listVapiNumbers().catch(() => []);

  if (process.env.JARVIS_VAPI_PHONE_ID) {
    const byEnv = list.find((p) => p.id === process.env.JARVIS_VAPI_PHONE_ID);
    return { id: process.env.JARVIS_VAPI_PHONE_ID, number: byEnv ? byEnv.number : null };
  }
  const byDigits = list.find((p) => last10(p.number) === JARVIS_NUMBER_LAST10);
  if (byDigits && byDigits.id) return { id: byDigits.id, number: byDigits.number };

  const cfg = await getPlatformSetting(SETTINGS_KEY).catch(() => null);
  if (cfg && cfg.vapiPhoneId) {
    const byCfg = list.find((p) => p.id === cfg.vapiPhoneId);
    return { id: cfg.vapiPhoneId, number: (byCfg && byCfg.number) || cfg.number || null };
  }
  return null;
}

// PATCH the VAPI phone number into dynamic assistant-request mode pointed at the
// Jarvis webhook. TOP-LEVEL serverUrl is the shape that actually routes on this
// account; server:null clears any stale nested server field that would otherwise
// mute the line to voicemail with no webhook POST.
async function pointNumberAtJarvis(vapiPhoneId) {
  const res = await fetch(`https://api.vapi.ai/phone-number/${vapiPhoneId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${process.env.VAPI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      assistantId: null,
      server: null,
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

// Resolve -> pin -> persist jarvis_config -> report duplicates. The one call that
// makes the line answer and keeps the cleanup allowlist protecting it.
async function ensureJarvis() {
  const list = await listVapiNumbers();
  const canonical = await resolveJarvisNumber(list);
  if (!canonical || !canonical.id) {
    return {
      ok: false,
      error: 'No Jarvis number found on VAPI (set JARVIS_VAPI_PHONE_ID, or provision one).',
      jarvisPinned: list.filter(pointsAtJarvis).map((p) => ({ id: p.id, number: p.number, serverUrl: urlOf(p) })),
    };
  }

  await pointNumberAtJarvis(canonical.id);

  const existing = await getPlatformSetting(SETTINGS_KEY).catch(() => null);
  const config = {
    ...(existing || {}),
    number: canonical.number || (existing && existing.number) || null,
    vapiPhoneId: canonical.id,
    serverUrl: JARVIS_SERVER_URL,
    ensuredAt: new Date().toISOString(),
  };
  await setPlatformSetting(SETTINGS_KEY, config);

  // Everything else still pointed at the Jarvis webhook is a duplicate to release.
  const duplicates = list
    .filter((p) => p.id !== canonical.id && (pointsAtJarvis(p) || last10(p.number) === JARVIS_NUMBER_LAST10))
    .map((p) => ({ id: p.id, number: p.number, serverUrl: urlOf(p) }));

  return { ok: true, canonical: { id: canonical.id, number: canonical.number }, serverUrl: JARVIS_SERVER_URL, duplicates };
}

// Boot self-heal: re-pin the Jarvis number on every deploy so drift auto-fixes.
// Non-blocking and never crashes startup. Disable with JARVIS_SELF_HEAL=0.
if (process.env.JARVIS_SELF_HEAL !== '0') {
  setTimeout(() => {
    ensureJarvis()
      .then((r) => {
        if (r.ok) console.log(`🩺 Jarvis self-heal: pinned ${r.canonical.number || r.canonical.id} -> ${JARVIS_SERVER_URL}${r.duplicates.length ? ` (${r.duplicates.length} duplicate(s) to release)` : ''}`);
        else console.warn('🩺 Jarvis self-heal skipped:', r.error);
      })
      .catch((e) => console.warn('🩺 Jarvis self-heal failed:', e.message));
  }, 4000);
}

// GET /api/jarvis/status - current state + every number pointed at the Jarvis
// webhook (so duplicates are visible), no side effects.
router.get('/status', requireSecret, async (req, res) => {
  try {
    const cfg = await getPlatformSetting(SETTINGS_KEY);
    let jarvisPinned = [];
    try {
      const list = await listVapiNumbers();
      jarvisPinned = list
        .filter((p) => pointsAtJarvis(p) || last10(p.number) === JARVIS_NUMBER_LAST10)
        .map((p) => ({ id: p.id, number: p.number, serverUrl: urlOf(p) }));
    } catch (e) {
      jarvisPinned = [{ error: e.message }];
    }
    res.json({ provisioned: !!(cfg && cfg.vapiPhoneId), serverUrl: JARVIS_SERVER_URL, config: cfg || null, jarvisPinned });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/jarvis/ensure - resolve the real Jarvis number, pin it correctly,
// persist jarvis_config, and report duplicates. Use this to fix the line.
router.post('/ensure', requireSecret, async (req, res) => {
  try {
    const result = await ensureJarvis();
    res.status(result.ok ? 200 : 502).json(result);
  } catch (e) {
    console.error('❌ Jarvis ensure failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/jarvis/provision - idempotent. Buys the number once, points it at the
// Jarvis webhook, stores config. Re-running returns the existing number.
// Body/query: { areaCode? } preferred area code, { force? } to buy a NEW number
// even if one exists (does NOT release the old one; use only deliberately).
router.post('/provision', requireSecret, async (req, res) => {
  try {
    const force = req.query.force === '1' || req.body?.force === true;
    const existing = await getPlatformSetting(SETTINGS_KEY);

    if (existing && existing.vapiPhoneId && !force) {
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

// POST /api/jarvis/repin - re-point the Jarvis number at the webhook without
// buying anything. Resolves from VAPI (no longer 404s on an empty config).
router.post('/repin', requireSecret, async (req, res) => {
  try {
    const canonical = await resolveJarvisNumber();
    if (!canonical || !canonical.id) {
      return res.status(404).json({ error: 'No Jarvis number found on VAPI or in config' });
    }
    await pointNumberAtJarvis(canonical.id);
    const cfg = await getPlatformSetting(SETTINGS_KEY).catch(() => null);
    const updated = {
      ...(cfg || {}),
      number: canonical.number || (cfg && cfg.number) || null,
      vapiPhoneId: canonical.id,
      serverUrl: JARVIS_SERVER_URL,
      repinnedAt: new Date().toISOString(),
    };
    await setPlatformSetting(SETTINGS_KEY, updated);
    res.json({ ok: true, config: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
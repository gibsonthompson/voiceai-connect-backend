// ============================================================================
// scripts/fix-vapi-sip-door-secret.js
// One-shot fix: add the webhook secret to the shared VAPI SIP door that every
// telnyx_cc call rings into. Without it, VAPI's assistant-request to
// /webhook/vapi arrives with no secret and the backend rejects it ("missing
// secret"), so the AI never gets its config and the caller hears nothing.
//
// Run once in the DigitalOcean console (env already present):
//   node scripts/fix-vapi-sip-door-secret.js
//
// It reads the door's VAPI phone-number id from platform_settings
// (vapi_sip_phone_id), or finds it by its SIP uri / name, then PATCHes it with
// the same serverUrl + serverUrlSecret shape your live numbers already use. The
// next inbound call picks it up immediately. VAPI_WEBHOOK_SECRET must be set.
// ============================================================================

const path = require('path');
const { supabase } = require(path.join(__dirname, '..', 'src', 'lib', 'supabase'));

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const SECRET = process.env.VAPI_WEBHOOK_SECRET;
const BACKEND_URL = process.env.BACKEND_URL || 'https://urchin-app-bqb4i.ondigitalocean.app';

async function getSetting(key) {
  const { data } = await supabase.from('platform_settings').select('value').eq('key', key).maybeSingle();
  return (data && data.value) || null;
}

async function main() {
  if (!VAPI_API_KEY) { console.error('VAPI_API_KEY not set'); process.exit(1); }
  if (!SECRET) { console.error('VAPI_WEBHOOK_SECRET not set. Set it in the app env first, then rerun.'); process.exit(1); }

  let phoneId = await getSetting('vapi_sip_phone_id');
  const sipUri = await getSetting('vapi_sip_uri');

  // Fallback: locate the door in VAPI by its SIP uri or its name.
  if (!phoneId) {
    const r = await fetch('https://api.vapi.ai/phone-number?limit=1000', {
      headers: { Authorization: `Bearer ${VAPI_API_KEY}` },
    });
    const list = r.ok ? await r.json() : [];
    const match = (Array.isArray(list) ? list : []).find(
      (n) => (sipUri && n.sipUri === sipUri) || String(n.name || '').includes('Whisper Shared SIP')
    );
    phoneId = match && match.id;
    if (phoneId) {
      await supabase.from('platform_settings').upsert({ key: 'vapi_sip_phone_id', value: phoneId }).then(() => {}, () => {});
    }
  }

  if (!phoneId) { console.error('Could not find the shared VAPI SIP door phone id (checked platform_settings and VAPI).'); process.exit(1); }

  const res = await fetch(`https://api.vapi.ai/phone-number/${phoneId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${VAPI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      serverUrl: `${BACKEND_URL}/webhook/vapi`,
      serverUrlSecret: SECRET,
    }),
  });

  if (!res.ok) {
    console.error(`PATCH failed (HTTP ${res.status}): ${(await res.text().catch(() => '')).slice(0, 300)}`);
    process.exit(1);
  }

  console.log(`Shared VAPI SIP door ${phoneId} now carries the webhook secret. Place a test call to confirm the AI answers.`);
  process.exit(0);
}

main().catch((e) => { console.error('fix failed:', e.message); process.exit(1); });

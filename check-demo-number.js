// ============================================================================
// CHECK DEMO NUMBER (READ ONLY)
// ----------------------------------------------------------------------------
// Answers one question: does the CallBird demo number still exist on VAPI, on
// Telnyx, on both, or on neither. Deletes nothing, changes nothing, and never
// prints a credential. Run from the DigitalOcean app console (the env is
// loaded there; a local machine without a .env will just report MISSING keys).
//
//   node check-demo-number.js
//
// Values come from the agencies row for CallBird:
//   demo_phone_number   +15055945806
//   demo_vapi_phone_id  aa0545e9-bdba-4f5c-be03-c5b8595c8b2f
// ============================================================================
require('dotenv').config();

const PHONE_E164 = '+15055945806';
const VAPI_PHONE_ID = 'aa0545e9-bdba-4f5c-be03-c5b8595c8b2f';

// Try the likely env var names so a naming mismatch does not look like a
// failed lookup. The NAME is printed, never the value.
const VAPI_KEY_NAMES = ['VAPI_API_KEY', 'VAPI_PRIVATE_KEY', 'VAPI_KEY'];
const TELNYX_KEY_NAMES = ['TELNYX_API_KEY', 'TELNYX_API_KEY_V2', 'TELNYX_KEY', 'TELNYX_SECRET'];

function resolveKey(names) {
  for (const n of names) {
    const v = process.env[n];
    if (v && String(v).trim().length > 0) return { name: n, value: String(v).trim() };
  }
  return { name: null, value: null };
}

async function main() {
  const vapiKey = resolveKey(VAPI_KEY_NAMES);
  const telnyxKey = resolveKey(TELNYX_KEY_NAMES);

  console.log('=== CREDENTIAL CHECK (names only, values never printed) ===');
  console.log(`VAPI key:   ${vapiKey.name ? 'PRESENT as ' + vapiKey.name : 'MISSING (tried ' + VAPI_KEY_NAMES.join(', ') + ')'}`);
  console.log(`Telnyx key: ${telnyxKey.name ? 'PRESENT as ' + telnyxKey.name : 'MISSING (tried ' + TELNYX_KEY_NAMES.join(', ') + ')'}`);
  if (!vapiKey.value && !telnyxKey.value) {
    console.log('\nNeither key is loaded in this environment. You are probably not on the');
    console.log('DigitalOcean console. Run it there, or use the two dashboards instead.');
    return;
  }
  console.log('');

  let vapiState = 'unknown';
  let telnyxState = 'unknown';

  // ── VAPI ────────────────────────────────────────────────────────────────
  console.log('=== VAPI ===');
  if (!vapiKey.value) {
    console.log('Skipped, no VAPI key in this environment.');
  } else {
    try {
      const res = await fetch(`https://api.vapi.ai/phone-number/${VAPI_PHONE_ID}`, {
        headers: { Authorization: `Bearer ${vapiKey.value}` },
      });
      console.log(`HTTP ${res.status}`);
      if (res.status === 404) {
        vapiState = 'gone';
        console.log('The VAPI phone object no longer exists. It was deleted.');
      } else if (res.status === 401 || res.status === 403) {
        console.log('Auth rejected. The key loaded under ' + vapiKey.name + ' is not valid for this call.');
      } else if (res.ok) {
        vapiState = 'alive';
        const body = await res.json();
        console.log('The VAPI phone object still exists. Key fields:');
        console.log(`  number:      ${body.number || '(none)'}`);
        console.log(`  provider:    ${body.provider || '(none)'}`);
        console.log(`  assistantId: ${body.assistantId === null ? 'null  (correct, dynamic demo will fire)' : String(body.assistantId) + '  (WRONG, a static assistant is pinned and assistant-request will not fire)'}`);
        console.log(`  serverUrl:   ${body.serverUrl || '(none)  (WRONG, assistant-request has nowhere to go)'}`);
      } else {
        const t = await res.text().catch(() => '');
        console.log('Unexpected response: ' + t.slice(0, 200));
      }
    } catch (err) {
      console.log('Request failed: ' + err.message);
    }
  }
  console.log('');

  // ── TELNYX ──────────────────────────────────────────────────────────────
  console.log('=== TELNYX ===');
  if (!telnyxKey.value) {
    console.log('Skipped, no Telnyx key in this environment.');
  } else {
    try {
      const url = `https://api.telnyx.com/v2/phone_numbers?filter[phone_number]=${encodeURIComponent(PHONE_E164)}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${telnyxKey.value}` } });
      console.log(`HTTP ${res.status}`);
      if (res.status === 401 || res.status === 403) {
        console.log('Auth rejected. The key loaded under ' + telnyxKey.name + ' is not valid for this call.');
      } else if (res.ok) {
        const body = await res.json();
        const rows = Array.isArray(body.data) ? body.data : [];
        if (rows.length === 0) {
          telnyxState = 'gone';
          console.log('Not on your Telnyx account. The rental was released.');
        } else {
          telnyxState = 'alive';
          console.log(`Still on your Telnyx account (${rows.length} match). You are still paying for it.`);
          rows.forEach(r => {
            console.log(`  phone_number:    ${r.phone_number}`);
            console.log(`  status:          ${r.status || '(none)'}`);
            console.log(`  connection_id:   ${r.connection_id || '(none)  (no voice routing attached)'}`);
          });
        }
      } else {
        const t = await res.text().catch(() => '');
        console.log('Unexpected response: ' + t.slice(0, 200));
      }
    } catch (err) {
      console.log('Request failed: ' + err.message);
    }
  }

  // ── VERDICT ─────────────────────────────────────────────────────────────
  console.log('\n=== VERDICT ===');
  if (vapiState === 'gone' && telnyxState === 'alive') {
    console.log('You still own the number on Telnyx, but the VAPI object was deleted.');
    console.log('You have been paying for a dead line. Re-import it into VAPI instead');
    console.log('of buying a new one, and you keep the number on the CallBird site.');
  } else if (vapiState === 'gone' && telnyxState === 'gone') {
    console.log('Gone from both. Provision a new demo number.');
  } else if (vapiState === 'alive' && telnyxState === 'alive') {
    console.log('Both sides exist, so this is a routing or config break, not a deletion.');
    console.log('Check assistantId, serverUrl, and the Telnyx connection_id printed above.');
  } else if (vapiState === 'alive' && telnyxState === 'gone') {
    console.log('Orphaned VAPI object pointing at a number you no longer own.');
    console.log('Delete the VAPI object, then provision a new demo number.');
  } else {
    console.log('Incomplete. See the sections above for which lookup did not run.');
  }
}

main().catch(err => {
  console.error('Script error:', err.message);
  process.exit(1);
});
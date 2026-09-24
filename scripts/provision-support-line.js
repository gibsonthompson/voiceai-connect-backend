/**
 * Support line tool. Three subcommands:
 *
 *   node scripts/provision-support-line.js import <+1XXXXXXXXXX> [assistantId]
 *       Import a Telnyx number you ALREADY own into VAPI and attach the support
 *       assistant. Waits until the number is active on Telnyx, then imports and
 *       retries transient errors against the SAME number. Orders nothing. This is
 *       the reliable path and the one to use for cleanup.
 *
 *   node scripts/provision-support-line.js release <+1XXXXXXXXXX>
 *       Release a stranded Telnyx number so it stops billing.
 *
 *   node scripts/provision-support-line.js provision
 *       Full flow: create the assistant + KB, order a new number, import it. Only
 *       for a brand-new line when you have no number to reuse.
 *
 * Reuses src/lib/vapi.js. Uses the app's existing env: VAPI_API_KEY, BACKEND_URL,
 * VAPI_WEBHOOK_SECRET, TELNYX_API_KEY, TELNYX_MESSAGING_PROFILE_ID.
 */

const fs = require('fs');
const path = require('path');

const {
  createQueryTool,
  createIndustryKnowledgeBase,
  provisionLocalPhone,
  assignNumberForSMS,
  getPlatformSetting,
  setPlatformSetting,
  sanitizeAssistantName,
  releaseTelnyxNumber,
  fullyReleaseNumber,
} = require('../src/lib/vapi');

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const BACKEND_URL = process.env.BACKEND_URL || process.env.PUBLIC_BACKEND_URL;
const SUPPORT_NAME = 'AI Receptionist Support';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SUPPORT_FIRST_MESSAGE =
  "Thanks for calling support. I can help you set up and troubleshoot your AI receptionist. What are you trying to do?";

const SUPPORT_SYSTEM_PROMPT = `You are the support line for an AI receptionist product. Callers are business owners who use the AI receptionist for their own business and are calling with questions about how to use it (for example "how do I change my greeting", "why aren't my calls forwarding", "how do I read my call transcripts").

How to help:
- For any how-to or troubleshooting question, FIRST call the search_knowledge_base tool and base your answer on what it returns. Do not guess.
- Explain things in plain, friendly, non-technical language, and walk the caller through steps one at a time.
- You cannot make changes to the caller's account, and you do NOT transfer calls to a person.
- Never invent prices, features, or policies that are not in the knowledge base. If you are unsure, take a message instead of guessing.

When you cannot fully resolve the caller's issue by explaining it (something is broken that settings can't fix, a billing or number problem, they want a human, or the answer isn't in the knowledge base), follow this escalation:
1. Tell them you'll pass it to the team, who will follow up.
2. Collect their name, their business name, a callback number, and a one-sentence description of the issue.
3. Read it back, thank them, and let them know someone will get back to them.
The team is automatically texted a summary after every call, so nothing is lost.

Keep calls warm, efficient, and focused on getting the caller unstuck.`;

async function createSupportAssistant(queryToolId) {
  const assistantConfig = {
    name: sanitizeAssistantName(SUPPORT_NAME),
    transcriber: { provider: 'deepgram', model: 'nova-2', language: 'multi' },
    model: {
      provider: 'openai',
      model: 'gpt-4o',
      temperature: 0.4,
      messages: [{ role: 'system', content: SUPPORT_SYSTEM_PROMPT }],
      ...(queryToolId && { toolIds: [queryToolId] }),
      tools: [{ type: 'endCall' }],
    },
    voice: { provider: '11labs', model: 'eleven_flash_v2_5', voiceId: 'burt' },
    firstMessage: SUPPORT_FIRST_MESSAGE,
    recordingEnabled: true,
    serverMessages: ['end-of-call-report', 'transcript', 'status-update'],
    serverUrl: `${BACKEND_URL}/webhook/vapi-support`,
    serverUrlSecret: process.env.VAPI_WEBHOOK_SECRET,
  };
  const res = await fetch('https://api.vapi.ai/assistant', {
    method: 'POST',
    headers: { Authorization: `Bearer ${VAPI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(assistantConfig),
  });
  if (!res.ok) throw new Error(`Assistant create failed (HTTP ${res.status}): ${await res.text()}`);
  const assistant = await res.json();
  console.log(`✅ Support assistant created: ${assistant.id}`);
  return assistant;
}

// Reuse an existing support assistant (arg / env / stored), or build one once.
async function ensureAssistant(explicitId) {
  let assistantId = explicitId || process.env.SUPPORT_ASSISTANT_ID || (await getPlatformSetting('support_assistant_id'));
  if (assistantId) {
    console.log(`♻️  Reusing support assistant: ${assistantId}`);
    await setPlatformSetting('support_assistant_id', assistantId);
    return assistantId;
  }
  const kbContent = fs.readFileSync(path.join(__dirname, 'support-kb.md'), 'utf-8');
  const kb = await createIndustryKnowledgeBase(SUPPORT_NAME, 'support', null, kbContent);
  if (!kb || !kb.fileId) throw new Error('KB upload failed');
  console.log(`✅ Support KB uploaded: ${kb.fileId}`);
  await setPlatformSetting('support_kb_file_id', kb.fileId);
  const toolId = await createQueryTool(kb.fileId, SUPPORT_NAME);
  if (!toolId) throw new Error('Failed to create the KB query tool');
  await setPlatformSetting('support_query_tool_id', toolId);
  const assistant = await createSupportAssistant(toolId);
  await setPlatformSetting('support_assistant_id', assistant.id);
  return assistant.id;
}

async function getVapiTelnyxCredentialId() {
  const res = await fetch('https://api.vapi.ai/credential', {
    headers: { Authorization: `Bearer ${VAPI_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Could not list VAPI credentials (HTTP ${res.status})`);
  const creds = await res.json();
  const telnyx = (Array.isArray(creds) ? creds : []).find((c) => c.provider === 'telnyx');
  if (!telnyx) throw new Error('No Telnyx credential in VAPI (add your Telnyx key under VAPI dashboard, Provider Keys)');
  return telnyx.id;
}

// Poll Telnyx until the number reports active. The 502 on import happens when
// VAPI tries to configure a number Telnyx has not finished activating.
async function waitForTelnyxActive(number, maxSeconds = 150) {
  const deadline = Date.now() + maxSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`https://api.telnyx.com/v2/phone_numbers?filter[phone_number]=${encodeURIComponent(number)}`, {
        headers: { Authorization: `Bearer ${TELNYX_API_KEY}` },
      });
      if (res.ok) {
        const data = await res.json();
        const rec = data.data && data.data[0];
        if (rec && rec.status === 'active') { console.log(`   ✅ ${number} active on Telnyx`); return true; }
        console.log(`   ⏳ ${number} status: ${rec ? rec.status : 'not found yet'}...`);
      }
    } catch (e) {
      console.log(`   ⏳ Telnyx status check retrying (${e.message})...`);
    }
    await sleep(8000);
  }
  console.warn(`   ⚠️  ${number} not confirmed active after ${maxSeconds}s; importing anyway.`);
  return false;
}

async function attachAssistant(phoneId, assistantId) {
  const patch = await fetch(`https://api.vapi.ai/phone-number/${phoneId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${VAPI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ assistantId, name: SUPPORT_NAME }),
  });
  if (!patch.ok) throw new Error(`Failed to attach assistant to ${phoneId} (HTTP ${patch.status}): ${await patch.text()}`);
  console.log(`✅ Attached support assistant ${assistantId} to ${phoneId}`);
}

// Get the number into VAPI, attached to the support assistant. Retries transient
// errors against the SAME number (never orders another). If VAPI already has the
// number (Telnyx auto-import), attach the assistant to that existing object.
async function importExistingNumber(number, assistantId) {
  await waitForTelnyxActive(number);
  const credentialId = await getVapiTelnyxCredentialId();
  let last = '';
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await fetch('https://api.vapi.ai/phone-number', {
      method: 'POST',
      headers: { Authorization: `Bearer ${VAPI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'telnyx', number, credentialId, name: SUPPORT_NAME }),
    });
    const body = await res.text();
    if (res.ok) {
      const phone = JSON.parse(body);
      console.log(`✅ Imported ${number} into VAPI: ${phone.id}`);
      await attachAssistant(phone.id, assistantId);
      return phone;
    }
    // VAPI already has this number (auto-imported): attach to the existing object.
    const existing = body.match(/Existing Phone Number ([0-9a-fA-F-]{36})/);
    if (existing) {
      const phoneId = existing[1];
      console.log(`ℹ️  ${number} already in VAPI as ${phoneId}; attaching assistant instead of re-importing.`);
      await attachAssistant(phoneId, assistantId);
      return { id: phoneId };
    }
    last = `HTTP ${res.status}: ${body}`;
    const transient = res.status >= 500 || body.includes('502') || body.includes('Update Telnyx Number');
    if (transient && attempt < 6) {
      console.log(`   ⏳ Transient import error (attempt ${attempt}/6), waiting 12s and retrying same number...`);
      await sleep(12000);
      continue;
    }
    throw new Error(`Import failed: ${last}`);
  }
  throw new Error(`Import still failing after retries: ${last}`);
}

async function searchAvailable(areaCode) {
  const params = [
    'filter[country_code]=US',
    `filter[national_destination_code]=${areaCode}`,
    'filter[features][]=sms',
    'filter[features][]=voice',
    'filter[limit]=30',
  ];
  const res = await fetch(`https://api.telnyx.com/v2/available_phone_numbers?${params.join('&')}`, {
    headers: { Authorization: `Bearer ${TELNYX_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Telnyx search failed (HTTP ${res.status}): ${await res.text()}`);
  const data = await res.json();
  const nums = (data.data || []).map((n) => n.phone_number).filter(Boolean);
  // Skip patterns that look bad on a business support line.
  return nums.filter((n) => !n.includes('666') && !n.includes('0000'));
}

async function orderTelnyxNumber(number) {
  const res = await fetch('https://api.telnyx.com/v2/number_orders', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone_numbers: [{ phone_number: number }] }),
  });
  if (!res.ok) throw new Error(`Telnyx order failed for ${number} (HTTP ${res.status}): ${await res.text()}`);
  const data = await res.json();
  console.log(`🛒 Ordered ${number} (order ${data.data && data.data.id}, status ${data.data && data.data.status})`);
  return data;
}

async function main() {
  if (!VAPI_API_KEY) throw new Error('VAPI_API_KEY not set');
  if (!BACKEND_URL) throw new Error('BACKEND_URL (public backend URL) not set');
  const cmd = process.argv[2];

  if (cmd === 'release') {
    const num = process.argv[3];
    if (!num) throw new Error('Usage: release <+1XXXXXXXXXX>');
    console.log(`🗑️  Releasing ${num}...`);
    await releaseTelnyxNumber(num);
    console.log('✅ Release requested.');
    return;
  }

  if (cmd === 'refresh') {
    // Force the live number onto a freshly-built assistant with the CURRENT config.
    // Use when the line answers with a stale assistant (wrong greeting, wrong
    // webhook). Ignores the stored assistant id and replaces it. KB/tool reused.
    const num = process.argv[3] || (await getPlatformSetting('support_line_number'));
    if (!num) throw new Error('Usage: refresh <+1XXXXXXXXXX>');
    let toolId = process.env.SUPPORT_QUERY_TOOL_ID || (await getPlatformSetting('support_query_tool_id'));
    if (!toolId) {
      const kbContent = fs.readFileSync(path.join(__dirname, 'support-kb.md'), 'utf-8');
      const kb = await createIndustryKnowledgeBase(SUPPORT_NAME, 'support', null, kbContent);
      if (!kb || !kb.fileId) throw new Error('KB upload failed');
      await setPlatformSetting('support_kb_file_id', kb.fileId);
      toolId = await createQueryTool(kb.fileId, SUPPORT_NAME);
      if (!toolId) throw new Error('Failed to create the KB query tool');
      await setPlatformSetting('support_query_tool_id', toolId);
    }
    const assistant = await createSupportAssistant(toolId);
    await setPlatformSetting('support_assistant_id', assistant.id);
    let phoneId = await getPlatformSetting('support_phone_id');
    if (phoneId) {
      await attachAssistant(phoneId, assistant.id);
    } else {
      const phone = await importExistingNumber(num, assistant.id);
      if (phone && phone.id) await setPlatformSetting('support_phone_id', phone.id);
    }
    console.log(`\n🎉 Support line refreshed: ${num} -> NEW assistant ${assistant.id}`);
    return;
  }

  if (cmd === 'import') {
    const num = process.argv[3];
    if (!num) throw new Error('Usage: import <+1XXXXXXXXXX> [assistantId]');
    if (!TELNYX_API_KEY) throw new Error('TELNYX_API_KEY not set');
    const assistantId = await ensureAssistant(process.argv[4]);
    const phone = await importExistingNumber(num, assistantId);
    try { await assignNumberForSMS(num); } catch (e) { console.warn(`   ⚠️  SMS assign on ${num}: ${e.message}`); }
    await setPlatformSetting('support_line_number', num);
    if (phone.id) await setPlatformSetting('support_phone_id', phone.id);
    console.log(`\n🎉 Support line ready: ${num} -> assistant ${assistantId}`);
    return;
  }

  if (cmd === 'search') {
    const areaCode = process.argv[3];
    if (!areaCode) throw new Error('Usage: search <areaCode>   e.g. search 404');
    if (!TELNYX_API_KEY) throw new Error('TELNYX_API_KEY not set');
    const nums = await searchAvailable(areaCode);
    if (nums.length === 0) { console.log(`No clean numbers found in ${areaCode}. Try another area code.`); return; }
    console.log(`Available in ${areaCode} (666 / 0000 filtered out):\n`);
    nums.slice(0, 20).forEach((n) => console.log(`   ${n}`));
    console.log(`\nPick one, then:  node scripts/provision-support-line.js buy <number>`);
    return;
  }

  if (cmd === 'buy') {
    const num = process.argv[3];
    if (!num) throw new Error('Usage: buy <+1XXXXXXXXXX> [assistantId]');
    if (!TELNYX_API_KEY) throw new Error('TELNYX_API_KEY not set');
    const assistantId = await ensureAssistant(process.argv[4]);
    await orderTelnyxNumber(num);
    const phone = await importExistingNumber(num, assistantId);
    try { await assignNumberForSMS(num); } catch (e) { console.warn(`   ⚠️  SMS assign on ${num}: ${e.message}`); }
    await setPlatformSetting('support_line_number', num);
    if (phone.id) await setPlatformSetting('support_phone_id', phone.id);
    console.log(`\n🎉 Support line ready: ${num} -> assistant ${assistantId}`);
    return;
  }

  if (cmd === 'fully-release') {
    const num = process.argv[3];
    const vapiPhoneId = process.argv[4];
    if (!num) throw new Error('Usage: fully-release <+1XXXXXXXXXX> [vapiPhoneId]');
    console.log(`🗑️  Fully releasing ${num}${vapiPhoneId ? ` (VAPI ${vapiPhoneId})` : ''}...`);
    await fullyReleaseNumber(vapiPhoneId, num);
    console.log('✅ Done.');
    return;
  }

  // default: full provision (orders a number). Prefer `import`/`buy` when you have one.
  const existing = await getPlatformSetting('support_line_number');
  if (existing && !process.argv.includes('--force')) {
    console.log(`⚠️  Support line already set: ${existing}. Re-run with --force to reprovision.`);
    return;
  }
  const assistantId = await ensureAssistant();
  const phone = await provisionLocalPhone(process.env.SUPPORT_LINE_CITY || 'Atlanta', process.env.SUPPORT_LINE_STATE || 'GA', assistantId, SUPPORT_NAME, null, {});
  const number = phone.number || phone.phoneNumber;
  console.log(`✅ Support number provisioned: ${number}`);
  try { await assignNumberForSMS(number); } catch (e) { console.warn(`   ⚠️  SMS assign on ${number}: ${e.message}`); }
  await setPlatformSetting('support_line_number', number);
  if (phone.id || phone.phoneId) await setPlatformSetting('support_phone_id', phone.id || phone.phoneId);
  console.log(`\n🎉 Support line ready: ${number} -> assistant ${assistantId}`);
}

main().catch((err) => {
  console.error('❌ Failed:', err.message);
  process.exit(1);
});
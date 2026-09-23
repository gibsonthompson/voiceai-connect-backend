/**
 * Provision the platform AI support line (one-time, idempotent).
 *
 * What it does, reusing the existing provisioning stack in src/lib/vapi.js:
 *   1. Uploads the support knowledge base (support-kb.md) to VAPI as a file.
 *   2. Wraps that file in a VAPI query tool the assistant can search.
 *   3. Creates a dedicated support assistant (support prompt + the KB tool),
 *      pointed at the same /webhook/vapi endpoint clients use, so the end-of-call
 *      report fires and the webhook can text you.
 *   4. Buys a Telnyx number, imports it into VAPI, attaches the support
 *      assistant, and enables SMS (messaging profile + 10DLC).
 *   5. Stores the number, assistant id, tool id and file id in platform_settings
 *      so the webhook can recognise a support call and the app can show the number.
 *
 * Run once from the backend host (has the same env as the app):
 *   node scripts/provision-support-line.js
 * Re-running is safe: it stops if a support line already exists unless you pass
 *   node scripts/provision-support-line.js --force
 *
 * Requires env already used by the app: VAPI_API_KEY, BACKEND_URL (public URL of
 * the backend), VAPI_WEBHOOK_SECRET, TELNYX_API_KEY, TELNYX_MESSAGING_PROFILE_ID.
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
} = require('../src/lib/vapi');

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const BACKEND_URL = process.env.BACKEND_URL || process.env.PUBLIC_BACKEND_URL;

// Where to source the support number's area (the line is platform-wide, so this
// only affects the number's area code, not who it serves).
const SUPPORT_CITY = process.env.SUPPORT_LINE_CITY || 'Atlanta';
const SUPPORT_STATE = process.env.SUPPORT_LINE_STATE || 'GA';
const SUPPORT_NAME = 'AI Receptionist Support';

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
    startSpeakingPlan: {
      waitSeconds: 0.4,
      smartEndpointingPlan: { provider: 'vapi' },
      transcriptionEndpointingPlan: { onPunctuationSeconds: 0.2, onNoPunctuationSeconds: 1.0, onNumberSeconds: 0.4 },
    },
    stopSpeakingPlan: { numWords: 2, voiceSeconds: 0.2, backoffSeconds: 1.0 },
    firstMessage: SUPPORT_FIRST_MESSAGE,
    recordingEnabled: true,
    serverMessages: ['end-of-call-report', 'transcript', 'status-update'],
    serverUrl: `${BACKEND_URL}/webhook/vapi`,
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

async function main() {
  const force = process.argv.includes('--force');

  if (!VAPI_API_KEY) throw new Error('VAPI_API_KEY not set');
  if (!BACKEND_URL) throw new Error('BACKEND_URL (public backend URL) not set');

  const existing = await getPlatformSetting('support_line_number');
  if (existing && !force) {
    console.log(`⚠️  A support line already exists: ${existing}`);
    console.log('   Re-run with --force to provision a new one (the old number keeps billing until released).');
    return;
  }

  // 1 + 2. Knowledge base -> VAPI file -> query tool
  const kbPath = path.join(__dirname, 'support-kb.md');
  const kbContent = fs.readFileSync(kbPath, 'utf-8');
  // Reuse vapi.js's proven uploader (node-fetch + knownLength). Passing the KB as
  // customIndustryDoc uploads it as-is, regardless of the industry key.
  const kb = await createIndustryKnowledgeBase(SUPPORT_NAME, 'support', null, kbContent);
  if (!kb || !kb.fileId) throw new Error('KB upload failed');
  const fileId = kb.fileId;
  console.log(`✅ Support KB uploaded: ${fileId}`);
  const queryToolId = await createQueryTool(fileId, SUPPORT_NAME);
  if (!queryToolId) throw new Error('Failed to create the support KB query tool');

  // 3. Support assistant
  const assistant = await createSupportAssistant(queryToolId);

  // 4. Buy Telnyx number, import to VAPI, attach the assistant (provisionLocalPhone
  //    takes the assistantId and handles the Telnyx purchase + VAPI import).
  const phone = await provisionLocalPhone(SUPPORT_CITY, SUPPORT_STATE, assistant.id, SUPPORT_NAME, null, {});
  const number = phone.number || phone.phoneNumber;
  console.log(`✅ Support number provisioned: ${number}`);

  // Enable two-way SMS on the number (messaging profile + 10DLC). Non-fatal.
  try {
    await assignNumberForSMS(number);
  } catch (e) {
    console.warn(`⚠️  SMS assignment on ${number} did not complete: ${e.message} (run the assign-sms backfill later)`);
  }

  // 5. Persist so the webhook can recognise support calls and the app can show it.
  await setPlatformSetting('support_line_number', number);
  await setPlatformSetting('support_assistant_id', assistant.id);
  await setPlatformSetting('support_query_tool_id', queryToolId);
  await setPlatformSetting('support_kb_file_id', fileId);
  if (phone.id || phone.phoneId) await setPlatformSetting('support_phone_id', phone.id || phone.phoneId);

  console.log('\n🎉 Support line ready:');
  console.log(`   Number:        ${number}`);
  console.log(`   Assistant id:  ${assistant.id}`);
  console.log(`   KB file id:    ${fileId}`);
  console.log('\nNext: the /webhook/vapi handler texts you on end-of-call when the');
  console.log('assistant id matches support_assistant_id, and the UI reads');
  console.log('support_line_number in place of the old hardcoded number.');
}

main().catch((err) => {
  console.error('❌ Provisioning failed:', err.message);
  process.exit(1);
});
// ============================================================================
// PUBLIC DEMO — the "describe your business, then talk to its receptionist"
// demo for the marketing site hero. PUBLIC (no auth): anyone on
// myvoiceaiconnect.com can try it, so it is rate-limited and never creates or
// provisions anything.
// ----------------------------------------------------------------------------
// POST /api/public/demo-receptionist { query }
//   -> { business_name, industry, greeting, assistant }
//
// `assistant` is an INLINE, TRANSIENT VAPI assistant config. The browser starts
// a web call with it directly (vapi.start(assistant)) using the public key, so
// there is no persisted assistant, no phone number, and nothing to clean up. The
// only cost is the web-call minutes, which the browser caps (4 min) and this
// route rate-limits per IP.
//
// Mount in server.js:  app.use('/api/public', require('./routes/public-demo'));
// Destination: src/routes/public-demo.js
// ============================================================================
const express = require('express');
const router = express.Router();

// Serves the shared master knowledge base so the marketing support bot (which
// runs in the frontend) reads the same single source as the dashboard bot.
const { SUPPORT_KNOWLEDGE } = require('../lib/support-knowledge');
router.get('/support-knowledge', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ knowledge: SUPPORT_KNOWLEDGE });
});

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1';
const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL || 'nova-3';
const ELEVEN_MODEL = process.env.ELEVENLABS_TTS_MODEL || 'eleven_v4_turbo';

// A good default voice (ElevenLabs "Hope", a leading conversational voice).
const DEFAULT_VOICE_ID = 'zGjIP4SZlMnY9m93k97r';

// ── Per-IP rate limit (in-memory; same shape as the voice-preview limiter) ───
const _rate = new Map(); // ip -> [timestamps]
const _RATE_MAX = 12;     // demos per window
const _RATE_WINDOW = 10 * 60 * 1000; // 10 minutes
function rateLimited(ip) {
  const now = Date.now();
  const recent = (_rate.get(ip) || []).filter((t) => now - t < _RATE_WINDOW);
  recent.push(now);
  _rate.set(ip, recent);
  return recent.length > _RATE_MAX;
}

// ── URL extraction (mirrors ai-lab) ──────────────────────────────────────────
function extractUrl(text) {
  if (!text) return null;
  const noEmails = String(text).replace(/\b[\w.+-]+@[\w.-]+\.\w+\b/g, ' ');
  const m =
    noEmails.match(/\bhttps?:\/\/[^\s<>()]+/i) ||
    noEmails.match(/\b(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+\.(?:com|net|org|co|io|us|biz|info|dev|app|shop|store)\b[^\s<>()]*/i) ||
    noEmails.match(/\b(?:www\.)?[a-z0-9-]+\.(?:com|net|org|co|io|us|biz|info|dev|app|shop|store)\b[^\s<>()]*/i);
  if (!m) return null;
  let url = m[0].replace(/[.,)]+$/, '');
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  return url;
}

function parseJsonLoose(text) {
  if (!text) return null;
  let t = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

async function readHomepage(url, timeoutMs) {
  if (!url) return null;
  try {
    const { fetchPageWithJina } = require('../lib/website-scraper');
    const page = await fetchPageWithJina(url, timeoutMs || 10000);
    if (!page) return null;
    return String(page).replace(/\s+/g, ' ').trim().slice(0, 6000);
  } catch (e) { console.warn('public-demo: homepage read failed:', e.message); return null; }
}

async function callAnthropic(prompt, maxTokens, timeoutMs) {
  if (!ANTHROPIC_API_KEY) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 12000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: maxTokens || 700, temperature: 0.2, messages: [{ role: 'user', content: prompt }] }),
    });
    clearTimeout(timer);
    if (!res.ok) { console.warn(`public-demo anthropic HTTP ${res.status}`); return null; }
    const data = await res.json();
    return (data.content && data.content[0] && data.content[0].text) || '';
  } catch (e) { clearTimeout(timer); console.warn('public-demo anthropic failed:', e.message); return null; }
}

function buildExtractPrompt(query, siteText) {
  const siteBlock = siteText ? `\nText read from the business's website (primary source):\n"""${String(siteText).slice(0, 6000)}"""\n` : '';
  return `A visitor wants to hear what an AI phone receptionist would sound like for their business. They typed:

"""${String(query).slice(0, 500)}"""
${siteBlock}
Produce what the receptionist needs to sound real for this specific business.

Rules:
- "business_name": the real business name if you can tell, else a sensible short name from what they typed.
- "industry": a short human label (e.g. "Dental office", "HVAC company", "Law firm").
- "city": the city if present, else null.
- "greeting": the exact first sentence the receptionist answers the phone with. Warm, natural, under 18 words, first person, names the business. No quotes.
- "facts": 4 to 8 short bullet facts a receptionist would need (services offered, hours if known, location, booking/pricing approach, what makes them different). Use the website if provided; otherwise infer what is typically true for this kind of business and keep it generic. Never invent specific prices or phone numbers.

Respond with ONLY strict minified JSON:
{"business_name":"","industry":"","city":null,"greeting":"","facts":[""]}`;
}

function cleanStr(v) { if (v === null || v === undefined) return null; const s = String(v).trim(); if (!s || /^(null|none|n\/a)$/i.test(s)) return null; return s; }

// Build the inline, transient VAPI assistant config the browser calls with.
function buildAssistant({ businessName, industry, greeting, facts }) {
  const factLines = Array.isArray(facts) && facts.length
    ? facts.map((f) => `- ${f}`).join('\n')
    : '- A local business. Be helpful and take a message if you are unsure.';
  const systemPrompt = `# Role
You are the AI phone receptionist for ${businessName}${industry ? `, a ${industry.toLowerCase()}` : ''}. This is a short live demo call, so show how a great receptionist sounds.

# What you know about ${businessName}
${factLines}

# How to answer
- Talk like a warm, competent receptionist on a real phone call, not a script. Use contractions.
- Keep every turn to one or two sentences. Ask one thing at a time.
- Help with what a caller would actually ask: what they do, hours, booking an appointment, taking a message, directions.
- If you do not know a specific detail, say you'll take a message and have someone follow up. Never make up prices, addresses, or phone numbers.
- Occasional natural acknowledgments ("got it", "one sec") are good. Do not mention that you are a demo unless asked.`;

  return {
    name: `${businessName} (demo)`.slice(0, 60),
    firstMessage: greeting || `Thanks for calling ${businessName}, how can I help you today?`,
    transcriber: { provider: 'deepgram', model: DEEPGRAM_MODEL, language: 'multi' },
    model: {
      provider: 'openai',
      model: OPENAI_MODEL,
      temperature: 0.7,
      messages: [{ role: 'system', content: systemPrompt }],
    },
    voice: { provider: '11labs', model: ELEVEN_MODEL, voiceId: DEFAULT_VOICE_ID, stability: 0.4, similarityBoost: 0.75, useSpeakerBoost: true },
    startSpeakingPlan: { waitSeconds: 0.4, smartEndpointingPlan: { provider: 'vapi' } },
    stopSpeakingPlan: { numWords: 2, voiceSeconds: 0.2, backoffSeconds: 1.0 },
    // Hard server-side ceiling as a backstop to the browser's 4-minute cap.
    maxDurationSeconds: 300,
  };
}

// ── POST /api/public/demo-receptionist ───────────────────────────────────────
router.post('/demo-receptionist', async (req, res) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
    if (rateLimited(ip)) return res.status(429).json({ error: 'A lot of demos from your network right now. Give it a minute and try again.' });

    const query = String((req.body && req.body.query) || '').trim();
    if (!query) return res.status(400).json({ error: 'Describe your business, or paste your website.' });
    if (query.length > 500) return res.status(400).json({ error: 'Keep it to a sentence or two.' });

    const url = extractUrl(query);
    const siteText = url ? await readHomepage(url, 10000) : null;

    let data = parseJsonLoose(await callAnthropic(buildExtractPrompt(query, siteText), 700, 12000));
    if (!data || !cleanStr(data.business_name)) {
      // Minimal fallback so the demo still works if the LLM is unavailable.
      const guessName = (query.replace(/https?:\/\/\S+/i, '').trim().split(/[.,\n]/)[0] || 'your business').slice(0, 60);
      data = { business_name: guessName, industry: '', city: null, greeting: `Thanks for calling ${guessName}, how can I help you today?`, facts: [] };
    }

    const businessName = cleanStr(data.business_name) || 'your business';
    const industry = cleanStr(data.industry) || '';
    const city = cleanStr(data.city) || null;
    const greeting = cleanStr(data.greeting) || `Thanks for calling ${businessName}, how can I help you today?`;
    const facts = Array.isArray(data.facts) ? data.facts.map((f) => cleanStr(f)).filter(Boolean).slice(0, 8) : [];

    const assistant = buildAssistant({ businessName, industry, greeting, facts });
    return res.json({ success: true, business_name: businessName, industry, city, greeting, read_website: !!siteText, website_url: url || null, facts, assistant });
  } catch (e) {
    console.error('public-demo error:', e.message);
    return res.status(500).json({ error: 'Could not build the demo right now. Try again in a moment.' });
  }
});

module.exports = router;

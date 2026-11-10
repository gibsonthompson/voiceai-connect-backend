// ============================================================================
// Personalized opener line for cold outreach ({personalized_line}).
// Reads a lead's website once and writes a single, specific opening sentence so
// the first email reads as hand-written. Cost control lives in the caller: this
// only runs for a lead that is actually being emailed and has a website, and the
// result is cached on the lead so it is generated exactly once.
//
// The PROMPT below is a working placeholder. Swap PERSONALIZED_LINE_SYSTEM with
// the tuned prompt from the outreach-voice chat; nothing else needs to change.
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');
const cheerio = require('cheerio');

const MODEL = process.env.PERSONALIZED_LINE_MODEL || 'claude-sonnet-4-6';
const FETCH_TIMEOUT_MS = 7000;
const MAX_INPUT_CHARS = 2500;
const MAX_LINE_CHARS = 220;

// --- PLACEHOLDER PROMPT (swap with the tuned version) -----------------------
const PERSONALIZED_LINE_SYSTEM = `You write ONE short opening sentence for a cold email sent from an AI-receptionist agency to a local business owner. You are given text pulled from the business's own website.

Rules:
- Exactly one sentence, under 25 words. Plain, human, specific.
- Reference something REAL and concrete from their site: a specific service, their specialty, or the area/city they serve.
- Make it an observation, not a compliment. Never say "I love", "I came across your website", or praise the website itself.
- The email's next line is about missed calls, so do NOT mention phones, calls, voicemail, or receptionists yourself.
- No em dash, no emojis, no hashtags, no "guru". Sound like a real person who glanced at their business for a few seconds.
- If the text is too thin to say anything specific and true, reply with exactly: NONE

Output only the sentence (or NONE). No quotes, no preamble.`;

function normalizeUrl(url) {
  const u = (url || '').trim();
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  return `https://${u}`;
}

async function fetchHomepageText(websiteUrl) {
  const url = normalizeUrl(websiteUrl);
  if (!url) return '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VoiceAIConnectBot/1.0)' },
    });
    if (!res.ok) return '';
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/html') && !ct.includes('text/plain')) return '';
    const html = await res.text();
    const $ = cheerio.load(html);
    $('script, style, noscript, svg').remove();
    const title = $('title').text().trim();
    const metaDesc = $('meta[name="description"]').attr('content') || '';
    const body = $('body').text().replace(/\s+/g, ' ').trim();
    const combined = [title, metaDesc, body].filter(Boolean).join('. ');
    return combined.slice(0, MAX_INPUT_CHARS);
  } catch (e) {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

function cleanLine(raw) {
  let s = (raw || '').trim();
  if (!s) return null;
  if (/^none$/i.test(s)) return null;
  // Strip wrapping quotes and collapse whitespace/newlines to one line.
  s = s.replace(/^["'\s]+|["'\s]+$/g, '').replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/—/g, ', '); // collapse any em dash the model emits into a comma
  if (!s) return null;
  if (s.length > MAX_LINE_CHARS) s = s.slice(0, MAX_LINE_CHARS).trim();
  return s;
}

// Generate the opener. Returns a cleaned single-line string, or null if there is
// nothing good to say (no key, no site content, model declined, or an error).
// extraInstructions: optional agency-specific guidance appended to the prompt
// (their own angle, tone, or anything they want the opener to keep in mind).
async function generatePersonalizedLine({ website, businessName, industry, city, extraInstructions }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !website) return null;

  const text = await fetchHomepageText(website);
  if (!text || text.length < 40) return null;

  try {
    const client = new Anthropic({ apiKey });
    let system = PERSONALIZED_LINE_SYSTEM;
    const extra = (extraInstructions || '').trim();
    if (extra) {
      system += `\n\nAdditional guidance from the agency (follow it, but keep every rule above):\n${extra.slice(0, 600)}`;
    }
    const context = [
      businessName ? `Business name: ${businessName}` : '',
      industry ? `Industry: ${industry}` : '',
      city ? `Area: ${city}` : '',
      '',
      'Website text:',
      text,
    ].filter((l) => l !== undefined).join('\n');

    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 100,
      system,
      messages: [{ role: 'user', content: context }],
    });
    const out = Array.isArray(resp?.content)
      ? resp.content.map((b) => (b && b.type === 'text' ? b.text : '')).join(' ')
      : '';
    return cleanLine(out);
  } catch (e) {
    console.error('[personalized-line] generation failed:', e.message);
    return null;
  }
}

module.exports = { generatePersonalizedLine };

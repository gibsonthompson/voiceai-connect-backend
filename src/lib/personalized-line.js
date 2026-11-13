// ============================================================================
// Personalized opener line for cold outreach ({personalized_line}).
// Writes a single opening sentence so the first email reads as hand-written.
//
// FRAMING (important): the opener's job is NOT to state a trivia fact about the
// business ("open since 2008, so what?"). It is to name the ONE signal that best
// shows this business has real customer demand or money actively flowing in, and
// frame it so that demand is the point. The next line of the email is about the
// money they lose when an incoming customer can't get through, so the opener
// primes the reader to feel they have real inbound worth capturing. The fact
// (years, rating, reviews, area, specialty) is just the evidence; the money
// meaning is the message.
//
// Inputs are a lead's own website text PLUS the demand signals already available
// from their Google listing (rating, review count, categories, recent reviews).
// Generated once per lead and cached by the caller, so the one Google Places
// lookup here is paid at most once per lead.
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');
const cheerio = require('cheerio');
const { getPlaceRichDetails } = require('../../services/google-maps-source');

const MODEL = process.env.PERSONALIZED_LINE_MODEL || 'claude-sonnet-4-6';
const FETCH_TIMEOUT_MS = 7000;
const MAX_INPUT_CHARS = 2500;
const MAX_LINE_CHARS = 220;

// Reviews that mention not being able to reach the business are the PITCH's
// ammunition, not the opener's (the opener must never mention phones). We filter
// them out of the review snippets fed to the opener so it stays on demand, not
// pain. Kept in sync with the copy in src/routes/leads.js.
const MISSED_CALL_RE = /(never (answer|called back|got back|returned|pick(ed)? up)|no one (answered|picked up|ever answered)|couldn'?t (reach|get (a hold|ahold)|get through)|can'?t (reach|get (a hold|ahold))|didn'?t (answer|call back|pick up|return)|no (answer|response)|straight to voicemail|went to voicemail|left (a )?(voicemail|message)|unresponsive|hard to reach|(doesn'?t|don'?t|won'?t) answer|phone (just )?rings|never return(ed)? (my|the) call)/i;

// --- PROMPT: demand/money framing -------------------------------------------
const PERSONALIZED_LINE_SYSTEM = `You write ONE short opening sentence for a cold email from an AI-receptionist agency to the owner of a local service business. You are given signals about their business, pulled from their website and their Google listing.

Your job is NOT to state a fact about them. It is to name the ONE signal that best shows this business has real customer demand or money actively flowing in, and write your sentence so that demand is the point. The next line of the email is about the money they lose every time an incoming customer cannot get through, so your sentence should make the reader feel they already have real inbound worth capturing.

Turn the fact into its money meaning:
- NOT "You have been open since 2008" but "Sixteen years in Marietta means you are the name people call first."
- NOT "You are rated 4.9 stars" but "A 4.9 across over 400 reviews means you are the default pick in the area."
- NOT "You do water damage restoration" but "Water damage is all emergency work, and those jobs go to whoever gets there first."

Pick the strongest demand or money signal available, for example:
- A strong reputation or rating (people are told to call them first)
- Years established in a specific area (a known name that pulls steady inbound)
- A wide service area or more than one location (volume of new-customer demand)
- The urgency of their trade (emergency / same-day work, where the job goes to whoever responds first)
- Signs they are busy or growing (hiring, expanding, booked out)
- A specialty people specifically seek them out for

Rules:
- Exactly one sentence, under 25 words. Plain, human, specific, confident.
- Use a REAL, concrete detail from the signals given (service, area, rating, review count, years, specialty). Never invent a number or a fact you were not given. When a review count is given as an approximate like "over 500", use it exactly that way, never a precise figure.
- It is an observation about their demand, never a compliment. Never say "I love", "I came across your website", or praise the website itself.
- Do NOT mention phones, calls, voicemail, missed calls, answering, or receptionists yourself. The next line does that.
- No em dash, no emojis, no hashtags, no "guru". Sound like a real person who sized up their business in a few seconds.
- If the signals are too thin to say anything specific and true about their demand, reply with exactly: NONE

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

// Demand signals from the lead's Google listing. Best-effort: any failure (no
// key, no place id, API error) just returns null and the opener falls back to
// the website text alone.
async function fetchPlaceSignals(placeId) {
  if (!placeId || !process.env.GOOGLE_PLACES_API_KEY) return null;
  try {
    const d = await getPlaceRichDetails(placeId);
    if (!d) return null;
    const rating = typeof d.rating === 'number' ? d.rating : null;
    const reviewCount = typeof d.user_ratings_total === 'number' ? d.user_ratings_total : null;
    const categories = Array.isArray(d.types)
      ? d.types.filter((t) => !['point_of_interest', 'establishment'].includes(t)).slice(0, 4).map((t) => t.replace(/_/g, ' '))
      : [];
    const reviews = Array.isArray(d.reviews) ? d.reviews : [];
    // Most recent reviews, dropping any that are about not reaching the business
    // (that is the pitch's job), so the opener only ever sees praise/demand.
    const snippets = reviews
      .slice()
      .sort((a, b) => (b.time || 0) - (a.time || 0))
      .filter((r) => r && r.text && !MISSED_CALL_RE.test(r.text))
      .slice(0, 2)
      .map((r) => (r.text || '').replace(/\s+/g, ' ').trim().slice(0, 200))
      .filter(Boolean);
    const weekday = d.opening_hours && Array.isArray(d.opening_hours.weekday_text) ? d.opening_hours.weekday_text : [];
    const open247 = weekday.length > 0 && weekday.every((l) => /open 24 hours/i.test(l));
    if (rating == null && reviewCount == null && categories.length === 0 && snippets.length === 0) return null;
    return { rating, reviewCount, categories, snippets, open247 };
  } catch (e) {
    return null;
  }
}

// Round a raw review count to an approximate "over N" phrase so the opener
// never cites a precise, oddly specific number (e.g. 546). Buckets widen as the
// count grows. Tiny counts (<25) stay exact, since "over 10" reads worse than
// the real number. Returns null for no/zero reviews.
function roundedReviews(n) {
  if (typeof n !== 'number' || !isFinite(n) || n < 1) return null;
  if (n < 25) return `${n}`;
  let floor;
  if (n < 100) floor = Math.floor(n / 25) * 25;
  else if (n < 500) floor = Math.floor(n / 50) * 50;
  else if (n < 1000) floor = Math.floor(n / 100) * 100;
  else if (n < 5000) floor = Math.floor(n / 500) * 500;
  else floor = Math.floor(n / 1000) * 1000;
  return `over ${floor.toLocaleString('en-US')}`;
}

function buildSignalsBlock(s) {
  if (!s) return '';
  const lines = [];
  const rc = roundedReviews(s.reviewCount);
  if (s.rating != null && rc) lines.push(`Google rating: ${s.rating} stars across ${rc} reviews`);
  else if (s.rating != null) lines.push(`Google rating: ${s.rating} stars`);
  else if (rc) lines.push(`Google reviews: ${rc}`);
  if (s.categories && s.categories.length) lines.push(`Categories: ${s.categories.join(', ')}`);
  if (s.open247) lines.push(`Hours: open 24 hours`);
  if (s.snippets && s.snippets.length) lines.push(`Recent customer reviews:\n- ${s.snippets.join('\n- ')}`);
  return lines.length ? `Google listing signals:\n${lines.join('\n')}` : '';
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
// nothing good to say (no key, no usable signals, model declined, or an error).
// extraInstructions: optional agency-specific guidance appended to the prompt.
async function generatePersonalizedLine({ website, businessName, industry, city, placeId, extraInstructions }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  // Gather the two sources in parallel; either can be empty.
  const [text, signals] = await Promise.all([
    website ? fetchHomepageText(website) : Promise.resolve(''),
    fetchPlaceSignals(placeId),
  ]);
  const signalsBlock = buildSignalsBlock(signals);
  const hasText = !!text && text.length >= 40;
  if (!hasText && !signalsBlock) return null;

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
      signalsBlock ? `\n${signalsBlock}` : '',
      hasText ? `\nWebsite text:\n${text}` : '',
    ].filter(Boolean).join('\n');

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

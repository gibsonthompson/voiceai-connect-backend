// ============================================================================
// AI LAB — conversational receptionist builder (the "describe your receptionist"
// flow). This route is the BRAIN behind the AI Lab prompt bar and the guided
// conversation that follows it.
// ----------------------------------------------------------------------------
// The flow is: the owner (or, later, a public visitor) describes the business or
// pastes its website. We read the site, identify the industry, and pull out the
// business name, city, services, hours and FAQs so the draft starts personalized.
// The conversation then confirms and fills the rest (hours, services, knowledge,
// voice, greeting). NOTHING is created live during the conversation. Only the
// final commit (/build) creates the assistant, folds everything into the
// knowledge base, and provisions a phone number. Provisioning a number is the
// LAST step, on purpose: the whole conversation is free and reversible, the
// number (a real Telnyx line, a real cost) is only ever bought once, at go-live.
//
// Endpoints (all under /api/agency/:agencyId/ai-lab, agency-authenticated):
//   POST /match            { query }                 -> routing decision (legacy)
//   POST /intake           { query }                 -> full extracted package
//   POST /suggest-greeting { business_name, industry, sub_vertical } -> greeting
//   POST /build            { industry, business_name, city, website_url,
//                            sub_vertical, hours, services, faqs,
//                            additional_info, voice_id, greeting, ai_tone }
//                          -> creates the live client + number (the commit)
//
// Design notes:
//   - LLM semantic routing, NOT keyword matching. Keyword matcher kept only as a
//     graceful fallback when the Anthropic call is unavailable.
//   - When a website is present we READ it (homepage) at match/intake time so the
//     match is grounded in real content, and the full multi-page scrape runs at
//     commit to build the knowledge base.
//   - The assistant is dynamic: voice, greeting, hours, services and prompt are
//     assembled from the client row at call time, so the commit just writes those
//     columns (and the client_services rows) and the receptionist reflects them.
//
// Mount in server.js:  app.use('/api/agency', require('./routes/ai-lab'));
// Destination: src/routes/ai-lab.js
// ============================================================================
const express = require('express');
const router = express.Router();
const { requireAgencyAccess } = require('./auth');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Auth: matching calls the Anthropic API, so it must be an authenticated agency
// (same guard the custom-industry generator uses) to avoid an abuse vector.
router.use('/:agencyId/ai-lab', requireAgencyAccess());

// ── Industry catalog (canonical values mirror lib/industries.ts) ─────────────
// `kw` are matching hints: natural-language synonyms a caller/owner might type.
// They feed BOTH the LLM prompt and the keyword fallback.
const CATALOG = [
  { value: 'home_services', label: 'Home Services', description: 'General home services and contractors', kw: ['home services', 'handyman', 'contractor', 'general contractor', 'remodeling', 'renovation'] },
  { value: 'hvac', label: 'HVAC / Heating & Cooling', description: 'Heating, cooling, and air quality', kw: ['hvac', 'ac', 'a/c', 'air conditioning', 'heating', 'cooling', 'furnace', 'heat pump', 'air quality'] },
  { value: 'plumbing', label: 'Plumbing', description: 'Leaks, drains, water heaters', kw: ['plumbing', 'plumber', 'drain', 'leak', 'water heater', 'sewer', 'pipe'] },
  { value: 'electrical', label: 'Electrical', description: 'Wiring, panels, outlets', kw: ['electrical', 'electrician', 'wiring', 'panel', 'outlet', 'breaker'] },
  { value: 'roofing', label: 'Roofing', description: 'Leaks, storm damage, replacement', kw: ['roofing', 'roofer', 'roof', 'shingle', 'storm damage', 'gutter'] },
  { value: 'waterproofing', label: 'Waterproofing & Foundation Repair', description: 'Waterproofing, foundation, mold', kw: ['waterproofing', 'foundation', 'foundation repair', 'basement', 'crawl space', 'mold', 'mold remediation'] },
  { value: 'pest_control', label: 'Pest Control', description: 'Extermination and prevention', kw: ['pest control', 'pest', 'exterminator', 'termite', 'rodent', 'bed bug', 'mosquito', 'wildlife'] },
  { value: 'landscaping', label: 'Landscaping & Lawn Care', description: 'Lawn care, cleanups, design', kw: ['landscaping', 'landscaper', 'lawn care', 'lawn', 'mowing', 'tree service', 'irrigation', 'snow removal'] },
  { value: 'junk_removal', label: 'Junk Removal & Dumpster Rental', description: 'Junk hauling and dumpsters', kw: ['junk removal', 'junk', 'hauling', 'dumpster', 'dumpster rental', 'demolition', 'cleanout'] },
  { value: 'septic', label: 'Septic & Well', description: 'Septic, drain fields, well pumps', kw: ['septic', 'septic tank', 'drain field', 'well', 'well pump', 'water system'] },
  { value: 'automotive', label: 'Automotive', description: 'Auto repair, dealerships, detailing', kw: ['automotive', 'auto repair', 'mechanic', 'car repair', 'tire', 'dealership', 'detailing', 'body shop', 'collision', 'oil change'] },
  { value: 'medical', label: 'Medical', description: 'Clinics, practices, specialists', kw: ['medical', 'clinic', 'doctor', 'physician', 'practice', 'urgent care', 'chiropractor', 'dermatology', 'pediatric', 'health'] },
  { value: 'dental', label: 'Dental & Orthodontics', description: 'Dental and orthodontic offices', kw: ['dental', 'dentist', 'orthodontist', 'orthodontics', 'braces', 'teeth', 'oral surgeon', 'endodontist', 'invisalign'] },
  { value: 'legal', label: 'Legal', description: 'Law firms and attorneys', kw: ['legal', 'law firm', 'lawyer', 'attorney', 'paralegal', 'personal injury', 'family law', 'criminal defense', 'estate'] },
  { value: 'financial', label: 'Financial Services', description: 'Accounting, tax, advisors', kw: ['financial', 'accounting', 'accountant', 'cpa', 'bookkeeping', 'tax', 'financial advisor', 'wealth', 'insurance agency'] },
  { value: 'real_estate', label: 'Real Estate', description: 'Agents, brokers, property management', kw: ['real estate', 'realtor', 'real estate agent', 'broker', 'property management', 'mortgage', 'leasing'] },
  { value: 'professional_services', label: 'Professional Services', description: 'Consulting and other services', kw: ['professional services', 'consulting', 'consultant', 'agency', 'marketing agency', 'it services', 'notary'] },
  { value: 'salon_spa', label: 'Salon & Spa', description: 'Salons, barbershops, day spas', kw: ['salon', 'hair salon', 'hair', 'haircut', 'barber', 'barbershop', 'nail', 'nail salon', 'nail bar', 'nails', 'spa', 'day spa', 'med spa', 'medspa', 'lashes', 'waxing', 'esthetician', 'beauty', 'tanning', 'massage'] },
  { value: 'fitness', label: 'Fitness & Recreation', description: 'Gyms, studios, personal training', kw: ['fitness', 'gym', 'studio', 'personal training', 'personal trainer', 'yoga', 'pilates', 'crossfit', 'martial arts', 'dance'] },
  { value: 'restaurants', label: 'Restaurant & Food Service', description: 'Restaurants, catering, food service', kw: ['restaurant', 'cafe', 'coffee shop', 'catering', 'food', 'bakery', 'bar', 'pizzeria', 'food truck', 'diner'] },
  { value: 'retail', label: 'Retail', description: 'Shops, boutiques, e-commerce', kw: ['retail', 'shop', 'store', 'boutique', 'ecommerce', 'e-commerce', 'dispensary', 'florist', 'jewelry'] },
];

const CATALOG_BY_VALUE = CATALOG.reduce((m, c) => { m[c.value] = c; return m; }, {});
const VALID_VALUES = new Set(CATALOG.map((c) => c.value));

function catalogPublic(value) {
  const c = CATALOG_BY_VALUE[value];
  return c ? { value: c.value, label: c.label, description: c.description } : null;
}

// Standard hours a draft starts with until the owner edits them in the flow.
const DEFAULT_HOURS = {
  monday: { open: '9:00 AM', close: '5:00 PM', closed: false },
  tuesday: { open: '9:00 AM', close: '5:00 PM', closed: false },
  wednesday: { open: '9:00 AM', close: '5:00 PM', closed: false },
  thursday: { open: '9:00 AM', close: '5:00 PM', closed: false },
  friday: { open: '9:00 AM', close: '5:00 PM', closed: false },
  saturday: { open: '9:00 AM', close: '5:00 PM', closed: true },
  sunday: { open: '9:00 AM', close: '5:00 PM', closed: true },
};

const DAY_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

// Accept a client-sent hours object only if it has the right shape; otherwise
// fall back to defaults so a malformed payload never corrupts the row.
function sanitizeHours(h) {
  if (!h || typeof h !== 'object') return { ...DEFAULT_HOURS };
  const out = {};
  for (const day of DAY_KEYS) {
    const d = h[day];
    if (d && typeof d === 'object') {
      out[day] = {
        open: typeof d.open === 'string' ? d.open.slice(0, 12) : '9:00 AM',
        close: typeof d.close === 'string' ? d.close.slice(0, 12) : '5:00 PM',
        closed: !!d.closed,
      };
    } else {
      out[day] = { ...DEFAULT_HOURS[day] };
    }
  }
  return out;
}

// ── URL / domain extraction ──────────────────────────────────────────────────
// Pull a website out of the query so the draft can be enriched by the scraper.
// Matches explicit URLs and bare domains (atlantaroofing.com) but ignores
// email addresses.
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

// Read a homepage for grounding. Best-effort and time-boxed; returns trimmed
// text (or null). Shared by /match (short) and /intake (longer).
async function readHomepage(url, maxChars, timeoutMs) {
  if (!url) return null;
  try {
    const { fetchPageWithJina } = require('../lib/website-scraper');
    const page = await fetchPageWithJina(url, timeoutMs || 9000);
    if (!page) return null;
    return String(page).replace(/\s+/g, ' ').trim().slice(0, maxChars || 2000);
  } catch (e) {
    console.warn('ai-lab: homepage read failed (continuing):', e.message);
    return null;
  }
}

// ── Keyword fallback classifier (used when the LLM is unavailable) ────────────
function classifyByKeyword(query) {
  const q = ' ' + String(query || '').toLowerCase().replace(/[^a-z0-9\s/&.-]/g, ' ').replace(/\s+/g, ' ') + ' ';
  let best = null;
  let bestScore = 0;
  for (const c of CATALOG) {
    let score = 0;
    for (const kw of c.kw) {
      if (q.includes(' ' + kw + ' ') || q.includes(' ' + kw + 's ')) {
        score = Math.max(score, kw.length); // prefer the most specific phrase
      }
    }
    if (score > bestScore) { bestScore = score; best = c.value; }
  }
  return best ? { industry: best, confidence: bestScore >= 5 ? 'high' : 'medium' } : { industry: null, confidence: 'low' };
}

// ── LLM classifier (match, legacy) ───────────────────────────────────────────
function buildClassifierPrompt(query, siteText) {
  const list = CATALOG
    .map((c) => `- ${c.value} (${c.label}): ${c.description}. e.g. ${c.kw.slice(0, 6).join(', ')}`)
    .join('\n');
  const siteBlock = siteText
    ? `\nThe request includes a website. Here is text read from that site. Use it as the PRIMARY signal for the business type, name, and city:\n"""${String(siteText).slice(0, 2000)}"""\n`
    : '';
  return `An agency owner is setting up an AI phone receptionist and typed this request:

"""${String(query).slice(0, 500)}"""
${siteBlock}
Match it to the single best-fitting receptionist template from this list, or decide none fits.

TEMPLATES:
${list}

Rules:
- Map a specific business to its parent template: "orthodontist" -> dental, "AC repair" -> hvac, "nail bar" -> salon_spa, "personal injury lawyer" -> legal.
- If the business type does NOT reasonably fit any template, set "industry" to null (a custom template will be generated).
- Only set "needs_clarification" to true when you genuinely cannot tell what kind of business it is (e.g. "make me money", "a receptionist"). Then give one short "clarifying_question".
- Extract the business name, the city/location, and any website, if present. When website text is provided above, prefer it as the source of the business name, city, and what the business actually does. Set "sub_vertical" to the specific business type in 1-3 words (e.g. "nail salon", "orthodontics", "personal injury law").
- "confidence": "high" when the type is explicit and clearly one template; "medium" when plausible but could be custom or a neighboring template; "low" for a weak guess.

Respond with ONLY strict minified JSON, no prose, in exactly this shape:
{"industry": "<one value from the list or null>", "confidence": "high|medium|low", "sub_vertical": "<string or null>", "business_name": "<string or null>", "city": "<string or null>", "website_url": "<string or null>", "needs_clarification": false, "clarifying_question": "<string or null>"}`;
}

// ── LLM extractor (intake, rich) ─────────────────────────────────────────────
// Same routing as the classifier, but also pulls services and FAQs out of the
// site/text so the conversation starts pre-filled instead of blank.
function buildIntakePrompt(query, siteText) {
  const list = CATALOG
    .map((c) => `- ${c.value} (${c.label}): ${c.description}`)
    .join('\n');
  const siteBlock = siteText
    ? `\nThe request includes a website. Here is text read from that site. Use it as the PRIMARY source for everything below:\n"""${String(siteText).slice(0, 6000)}"""\n`
    : '';
  return `An agency owner is creating an AI phone receptionist for a business and typed:

"""${String(query).slice(0, 500)}"""
${siteBlock}
Identify the business and extract what a receptionist would need to know.

TEMPLATES:
${list}

Rules:
- Pick the single best-fitting template value, or null if none fits (a custom one will be generated).
- Map specific businesses to the parent template ("orthodontist" -> dental, "nail bar" -> salon_spa).
- Only set "needs_clarification" true when you truly cannot tell what the business is. Then give one short "clarifying_question".
- "sub_vertical": the specific business type in 1-3 words.
- "services": up to 8 real services the business offers, each a short name and a one-line description. Use the website if provided; otherwise infer the 3-5 most typical services for this kind of business and mark them as typical by leaving description generic. Never invent specific prices.
- "faqs": up to 6 question/answer pairs a caller would actually ask (hours, location, booking, pricing approach, emergencies). Only include answers you can support from the site or that are safe, generic truths; leave "a" empty if unknown.
- Extract business_name, city, website_url when present.

Respond with ONLY strict minified JSON, no prose, exactly:
{"industry":"<value or null>","confidence":"high|medium|low","sub_vertical":"<string or null>","business_name":"<string or null>","city":"<string or null>","website_url":"<string or null>","services":[{"name":"","description":""}],"faqs":[{"q":"","a":""}],"needs_clarification":false,"clarifying_question":"<string or null>"}`;
}

function parseJsonLoose(text) {
  if (!text) return null;
  let t = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

async function callAnthropic(prompt, maxTokens, timeoutMs) {
  if (!ANTHROPIC_API_KEY) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 9000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: maxTokens || 400,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    clearTimeout(timer);
    if (!res.ok) { console.warn(`ai-lab anthropic: HTTP ${res.status}`); return null; }
    const data = await res.json();
    return (data.content && data.content[0] && data.content[0].text) || '';
  } catch (e) {
    clearTimeout(timer);
    console.warn('ai-lab anthropic failed:', e.message);
    return null;
  }
}

async function classifyWithLLM(query, siteText, timeoutMs = 9000) {
  const text = await callAnthropic(buildClassifierPrompt(query, siteText), 400, timeoutMs);
  return parseJsonLoose(text);
}

async function extractIntakeWithLLM(query, siteText, timeoutMs = 12000) {
  const text = await callAnthropic(buildIntakePrompt(query, siteText), 1200, timeoutMs);
  return parseJsonLoose(text);
}

// ── Normalizers ──────────────────────────────────────────────────────────────
function cleanStr(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || /^(null|none|n\/a|unknown)$/i.test(s)) return null;
  return s;
}

function normalizeServices(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const s of arr) {
    const name = cleanStr(s && s.name);
    if (!name) continue;
    out.push({ name: name.slice(0, 100), description: (cleanStr(s && s.description) || '').slice(0, 300) });
    if (out.length >= 10) break;
  }
  return out;
}

function normalizeFaqs(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const f of arr) {
    const q = cleanStr(f && f.q);
    if (!q) continue;
    out.push({ q: q.slice(0, 200), a: (cleanStr(f && f.a) || '').slice(0, 600) });
    if (out.length >= 8) break;
  }
  return out;
}

// ── Turn a raw classification into a routing decision ────────────────────────
function decideRouting(raw, query) {
  const urlFromText = extractUrl(query);

  let industry = raw && typeof raw.industry === 'string' ? raw.industry.toLowerCase().trim() : null;
  if (!VALID_VALUES.has(industry)) industry = null;

  const confidence = ['high', 'medium', 'low'].includes(raw && raw.confidence) ? raw.confidence : (industry ? 'medium' : 'low');
  const subVertical = cleanStr(raw && raw.sub_vertical);
  const businessName = cleanStr(raw && raw.business_name);
  const city = cleanStr(raw && raw.city);
  const websiteUrl = cleanStr(raw && raw.website_url) || urlFromText || null;
  const needsClarification = !!(raw && raw.needs_clarification) && !industry;

  const suggestedCustom = {
    label: (subVertical || businessName || query || '').toString().slice(0, 60).trim() || 'Custom Business',
    description: businessName || subVertical
      ? `AI receptionist for ${subVertical ? 'a ' + subVertical : 'the business'}${businessName ? ' (' + businessName + ')' : ''}.`
      : `AI receptionist for: ${String(query).slice(0, 200)}`,
  };

  let mode;
  if (needsClarification) mode = 'clarify';
  else if (industry && confidence === 'high') mode = 'matched';
  else if (industry) mode = 'disambiguate';
  else mode = 'custom';

  const candidates = industry ? [catalogPublic(industry)] : [];

  return {
    mode,
    industry: industry ? catalogPublic(industry) : null,
    candidates,
    confidence,
    sub_vertical: subVertical,
    business_name: businessName,
    city,
    website_url: websiteUrl,
    clarifying_question: needsClarification ? (cleanStr(raw && raw.clarifying_question) || 'What kind of business is this receptionist for?') : null,
    suggested_custom: mode === 'custom' || mode === 'disambiguate' ? suggestedCustom : null,
    query: String(query),
  };
}

// Fold the confirmed services, FAQs and extra notes into one markdown block that
// is appended to the website knowledge so the receptionist actually knows them.
function buildExtraKnowledgeText({ services, faqs, additionalInfo, hours, city }) {
  const parts = [];
  if (city) parts.push(`# Location\nThe business serves ${city}.`);
  if (Array.isArray(services) && services.length) {
    parts.push('# Services\n' + services.map((s) => `- ${s.name}${s.description ? ': ' + s.description : ''}`).join('\n'));
  }
  if (Array.isArray(faqs) && faqs.length) {
    const qa = faqs.filter((f) => f && f.q && f.a).map((f) => `Q: ${f.q}\nA: ${f.a}`);
    if (qa.length) parts.push('# Frequently Asked Questions\n' + qa.join('\n\n'));
  }
  if (additionalInfo && String(additionalInfo).trim()) {
    parts.push('# Additional Information\n' + String(additionalInfo).trim());
  }
  return parts.join('\n\n').trim();
}

// ── POST /:agencyId/ai-lab/match (legacy routing-only) ───────────────────────
router.post('/:agencyId/ai-lab/match', async (req, res) => {
  try {
    const query = String((req.body && req.body.query) || '').trim();
    if (!query) return res.status(400).json({ error: 'Describe the business, e.g. "an AI receptionist for a dental office".' });
    if (query.length > 500) return res.status(400).json({ error: 'That is a bit long, keep it to a sentence or two.' });

    const urlInQuery = extractUrl(query);
    const siteText = urlInQuery ? await readHomepage(urlInQuery, 2000, 8000) : null;

    let raw = await classifyWithLLM(query, siteText);
    let source = siteText ? 'llm+site' : 'llm';
    if (!raw) {
      const kw = classifyByKeyword(siteText ? `${query} ${siteText}` : query);
      raw = { industry: kw.industry, confidence: kw.confidence, sub_vertical: null, business_name: null, city: null, website_url: urlInQuery || null, needs_clarification: false, clarifying_question: null };
      source = siteText ? 'keyword+site' : 'keyword';
    }

    const decision = decideRouting(raw, query);
    decision.source = source;
    return res.json(decision);
  } catch (e) {
    console.error('ai-lab match error:', e.message);
    return res.status(500).json({ error: 'Could not analyze that right now. Try again, or pick an industry below.' });
  }
});

// ── POST /:agencyId/ai-lab/intake (rich, kicks off the conversation) ─────────
router.post('/:agencyId/ai-lab/intake', async (req, res) => {
  try {
    const query = String((req.body && req.body.query) || '').trim();
    if (!query) return res.status(400).json({ error: 'Describe the business, or paste its website.' });
    if (query.length > 500) return res.status(400).json({ error: 'That is a bit long, keep it to a sentence or two.' });

    const urlInQuery = extractUrl(query);
    const siteText = urlInQuery ? await readHomepage(urlInQuery, 6000, 11000) : null;

    let raw = await extractIntakeWithLLM(query, siteText);
    let source = siteText ? 'llm+site' : 'llm';
    if (!raw) {
      // Fallback: keyword routing only, no service/FAQ extraction.
      const kw = classifyByKeyword(siteText ? `${query} ${siteText}` : query);
      raw = { industry: kw.industry, confidence: kw.confidence, sub_vertical: null, business_name: null, city: null, website_url: urlInQuery || null, services: [], faqs: [], needs_clarification: false, clarifying_question: null };
      source = siteText ? 'keyword+site' : 'keyword';
    }

    const decision = decideRouting(raw, query);
    decision.source = source;
    decision.read_website = !!siteText;
    decision.services = normalizeServices(raw.services);
    decision.faqs = normalizeFaqs(raw.faqs);
    return res.json(decision);
  } catch (e) {
    console.error('ai-lab intake error:', e.message);
    return res.status(500).json({ error: 'Could not read that right now. Try again, or pick an industry below.' });
  }
});

// ── POST /:agencyId/ai-lab/suggest-greeting ──────────────────────────────────
router.post('/:agencyId/ai-lab/suggest-greeting', async (req, res) => {
  try {
    const b = req.body || {};
    const name = cleanStr(b.business_name) || 'the business';
    const sub = cleanStr(b.sub_vertical) || cleanStr(b.industry) || 'business';
    const prompt = `Write a single warm, natural phone greeting an AI receptionist would open with for "${name}", a ${sub}. One sentence, under 20 words, no quotes, first person ("Thanks for calling ${name}, how can I help?"). Return ONLY the greeting line.`;
    const text = await callAnthropic(prompt, 120, 8000);
    let greeting = cleanStr(text);
    if (greeting) greeting = greeting.replace(/^["']|["']$/g, '').split('\n')[0].slice(0, 160);
    if (!greeting) greeting = `Thanks for calling ${name}, how can I help you today?`;
    return res.json({ greeting });
  } catch (e) {
    console.error('ai-lab suggest-greeting error:', e.message);
    return res.status(500).json({ error: 'Could not draft a greeting.' });
  }
});

// ── POST /:agencyId/ai-lab/build (THE COMMIT) ────────────────────────────────
// Turn the collected package into a real receptionist: an assistant grounded by
// the full website scrape plus the confirmed services/FAQs, then provision a
// number (the only place a number is bought) and create the client. The FIRST
// build for an agency with no test client becomes its TEST client; later builds
// are regular clients.
router.post('/:agencyId/ai-lab/build', async (req, res) => {
  const { agencyId } = req.params;
  const body = req.body || {};
  const industry = String(body.industry || '').trim();
  const businessNameIn = String(body.business_name || '').trim();
  const city = String(body.city || '').trim();
  const websiteUrl = String(body.website_url || '').trim();
  const subVertical = String(body.sub_vertical || '').trim();

  // Full package (all optional; absent falls back to sensible defaults).
  const hours = sanitizeHours(body.hours);
  const services = normalizeServices(body.services);
  const faqs = normalizeFaqs(body.faqs);
  const additionalInfo = cleanStr(body.additional_info);
  const voiceId = cleanStr(body.voice_id);
  const greeting = cleanStr(body.greeting);
  const aiTone = cleanStr(body.ai_tone);

  try {
    const { supabase, getAgencyById } = require('../lib/supabase');
    const agency = await getAgencyById(agencyId);
    if (!agency) return res.status(404).json({ error: 'Agency not found' });

    const customKeys = Array.isArray(agency.custom_industries)
      ? agency.custom_industries.map((c) => c && c.key).filter(Boolean) : [];
    if (!industry || (!VALID_VALUES.has(industry) && !customKeys.includes(industry))) {
      return res.status(400).json({ error: 'Unknown industry for this agency.' });
    }

    const isTest = !agency.test_client_id;

    // Buying a number is the paid action; the whole conversation up to here was
    // free. Gate it at the commit (unless this is a demo agency that uses
    // placeholder numbers).
    const planType = String(agency.plan_type || '').toLowerCase();
    const demoSkip = agency.skip_number_provisioning === true;
    if (!demoSkip && planType === 'free') {
      return res.status(403).json({
        error: 'upgrade_required', upgrade_required: true, feature: 'ai_lab_build', current_plan: 'free',
        title: 'Going live assigns a phone number',
        message: 'Going live buys a real phone number so you can call the receptionist and hear it. Start your free trial to go live.',
        cta: 'Start your free trial', upgrade_url: '/agency/settings?tab=billing',
      });
    }

    const titleCase = (s) => s.replace(/\b\w/g, (m) => m.toUpperCase());
    const businessName = businessNameIn
      || (isTest ? `${agency.name} - Test Business` : (subVertical ? titleCase(subVertical) : 'New Receptionist'));
    const agencyCountry = (agency.country || 'US').toUpperCase();

    // 1) Knowledge base: scrape the full site (if any), then fold in the
    //    confirmed services, FAQs and notes so the receptionist knows them even
    //    when they are not on the website.
    let kbData = null;
    if (websiteUrl) {
      try {
        const { createKnowledgeBaseFromWebsite } = require('../lib/website-scraper');
        kbData = await createKnowledgeBaseFromWebsite(websiteUrl, businessName);
      } catch (e) { console.warn('ai-lab build: scrape failed (continuing):', e.message); }
    }
    const extra = buildExtraKnowledgeText({ services, faqs, additionalInfo, hours, city });
    if (extra) {
      if (!kbData) kbData = { websiteContent: '' };
      kbData.websiteContent = `${kbData.websiteContent || ''}\n\n${extra}`.trim();
    }

    // 2) Assistant. createIndustryAssistant resolves built-in AND custom industry
    //    keys and folds in the knowledge base (website + our extra block).
    const { createIndustryAssistant } = require('../lib/vapi');
    const assistant = await createIndustryAssistant(businessName, industry, kbData, agency.phone || null, null, agencyId);

    // 3) Provision the number (the last step). Demo agencies get a placeholder.
    //    Non-fatal: a receptionist with no number is still created and the number
    //    can be assigned later.
    let phoneNumber = null, vapiPhoneId = null, provisioningMethod = null;
    try {
      const { provisionPhoneForClient } = require('./client-signup');
      const r = await provisionPhoneForClient(
        agency,
        { businessCity: city, businessState: '', businessName, phone: agency.phone || '', country: agencyCountry },
        assistant.id, 'vapi_direct', planType || 'starter'
      );
      phoneNumber = r.number || null; vapiPhoneId = r.vapiPhoneId || null; provisioningMethod = r.provisioningMethod || null;
    } catch (e) { console.warn('ai-lab build: number provisioning failed (continuing):', e.message); }

    // 4) Create the client with the full package applied. The assistant is
    //    dynamic, so voice/greeting/hours are read from these columns at call
    //    time; services live in client_services (written next).
    const { data: client, error: insErr } = await supabase.from('clients').insert({
      agency_id: agencyId,
      business_name: businessName,
      business_city: city || null,
      country: agencyCountry,
      phone_number: phoneNumber,
      owner_name: agency.name,
      owner_phone: agency.phone || '+10000000000',
      email: agency.email,
      industry,
      business_website: websiteUrl || null,
      website_url: websiteUrl || null,
      knowledge_base_id: kbData?.knowledgeBaseId || null,
      knowledge_base_content: kbData?.content || null,
      vapi_assistant_id: assistant.id,
      vapi_phone_number: phoneNumber,
      vapi_phone_id: vapiPhoneId,
      provisioning_method: provisioningMethod || 'platform',
      business_hours: hours,
      voice_id: voiceId || null,
      greeting_message: greeting || null,
      ai_tone: aiTone || null,
      status: 'active',
      subscription_status: 'active',
      plan_type: isTest ? 'growth' : 'starter',
      is_test_client: isTest,
      calls_this_month: 0,
    }).select('id, business_name, phone_number, is_test_client, industry').single();
    if (insErr) { console.error('ai-lab build: client insert failed:', insErr.message); return res.status(500).json({ error: 'Could not create the receptionist.' }); }

    // 5) Services -> client_services (non-fatal; the KB already carries them too).
    if (services.length) {
      try {
        const rows = services.map((s) => ({ client_id: client.id, name: s.name, description: s.description || null, is_active: true }));
        const { error: svcErr } = await supabase.from('client_services').insert(rows);
        if (svcErr) console.warn('ai-lab build: services insert failed (continuing):', svcErr.message);
      } catch (e) { console.warn('ai-lab build: services insert threw (continuing):', e.message); }
    }

    if (isTest) await supabase.from('agencies').update({ test_client_id: client.id }).eq('id', agencyId);

    console.log(`🧪 AI Lab build for ${agency.name}: ${businessName} (${industry}, ${isTest ? 'test' : 'client'}) -> ${phoneNumber || 'no number'} [${services.length} services, ${faqs.length} faqs]`);
    return res.json({ success: true, client_id: client.id, is_test: client.is_test_client, business_name: client.business_name, phone_number: client.phone_number, industry: client.industry });
  } catch (e) {
    console.error('ai-lab build error:', e.message);
    return res.status(500).json({ error: 'Could not build the receptionist right now.' });
  }
});

module.exports = router;
// Exported for unit tests (no network).
module.exports._internal = { CATALOG, extractUrl, classifyByKeyword, decideRouting, parseJsonLoose, normalizeServices, normalizeFaqs, sanitizeHours, buildExtraKnowledgeText };

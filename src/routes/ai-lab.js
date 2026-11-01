// ============================================================================
// AI LAB — intent matching for the "describe your receptionist" search bar
// ----------------------------------------------------------------------------
// The first screen of AI Lab is a single prompt bar ("create an AI receptionist
// for a salon"). This route is the BRAIN behind it: it takes that free text and
// decides which of our built-in industry templates it maps to, or that it needs
// a custom (AI-generated) industry, and it extracts the business name / city /
// website along the way so the generated receptionist starts personalized.
//
// Design (see the AI Lab design notes):
//   - LLM semantic routing, NOT keyword matching: "nail bar" -> salon_spa,
//     "AC repair" -> hvac, "orthodontist" -> dental. A small keyword matcher is
//     kept ONLY as a graceful fallback when the Anthropic call is unavailable.
//   - Route on confidence, never silently mis-match:
//       high   -> matched  (go straight to the template)
//       medium -> disambiguate (let the user confirm the match vs custom)
//       none   -> custom   (feed the existing custom-industry generator)
//       vague  -> clarify  (ask ONE short question)
//   - Extract business_name / city / website_url so the draft is personalized.
//
// The CATALOG below mirrors the frontend's lib/industries.ts (canonical values)
// plus extra natural-language synonyms to sharpen matching. Keep the `value`s in
// sync with lib/industries.ts and the backend INDUSTRY_KNOWLEDGE_BASES keys.
//
// POST /api/agency/:agencyId/ai-lab/match   { query }
//   -> { mode, industry, candidates, confidence, sub_vertical, business_name,
//        city, website_url, clarifying_question, suggested_custom, query, source }
//
// Destination: src/routes/ai-lab.js
// Mount in server.js:  app.use('/api/agency', require('./routes/ai-lab'));
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

// ── Keyword fallback classifier (used when the LLM is unavailable) ────────────
// Scores each industry by how many of its synonyms appear in the query, longest
// phrase wins ties. Deterministic and dependency-free, so it is also what the
// unit tests exercise.
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

// ── LLM classifier (primary) ─────────────────────────────────────────────────
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

function parseJsonLoose(text) {
  if (!text) return null;
  let t = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

async function classifyWithLLM(query, siteText, timeoutMs = 9000) {
  if (!ANTHROPIC_API_KEY) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
        max_tokens: 400,
        temperature: 0,
        messages: [{ role: 'user', content: buildClassifierPrompt(query, siteText) }],
      }),
    });
    clearTimeout(timer);
    if (!res.ok) { console.warn(`ai-lab classify: HTTP ${res.status}`); return null; }
    const data = await res.json();
    const text = (data.content && data.content[0] && data.content[0].text) || '';
    return parseJsonLoose(text);
  } catch (e) {
    clearTimeout(timer);
    console.warn('ai-lab classify failed:', e.message);
    return null;
  }
}

// ── Turn a raw classification into a routing decision ────────────────────────
function decideRouting(raw, query) {
  const urlFromText = extractUrl(query);
  const clean = (v) => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    if (!s || /^(null|none|n\/a|unknown)$/i.test(s)) return null;
    return s;
  };

  // Validate the industry against the real catalog (the LLM is instructed to
  // use our values, but never trust it blindly).
  let industry = raw && typeof raw.industry === 'string' ? raw.industry.toLowerCase().trim() : null;
  if (!VALID_VALUES.has(industry)) industry = null;

  const confidence = ['high', 'medium', 'low'].includes(raw && raw.confidence) ? raw.confidence : (industry ? 'medium' : 'low');
  const subVertical = clean(raw && raw.sub_vertical);
  const businessName = clean(raw && raw.business_name);
  const city = clean(raw && raw.city);
  const websiteUrl = clean(raw && raw.website_url) || urlFromText || null;
  const needsClarification = !!(raw && raw.needs_clarification) && !industry;

  // Suggested payload for the existing custom-industry generator.
  const suggestedCustom = {
    label: (subVertical || businessName || query || '').toString().slice(0, 60).trim() || 'Custom Business',
    description: businessName || subVertical
      ? `AI receptionist for ${subVertical ? 'a ' + subVertical : 'the business'}${businessName ? ' (' + businessName + ')' : ''}.`
      : `AI receptionist for: ${String(query).slice(0, 200)}`,
  };

  let mode;
  if (needsClarification) mode = 'clarify';
  else if (industry && confidence === 'high') mode = 'matched';
  else if (industry) mode = 'disambiguate';   // medium / low but we have a guess
  else mode = 'custom';

  // Candidates for the disambiguate step: the guessed template plus the option
  // to generate a custom one for the specific sub-vertical.
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
    clarifying_question: needsClarification ? (clean(raw && raw.clarifying_question) || 'What kind of business is this receptionist for?') : null,
    suggested_custom: mode === 'custom' || mode === 'disambiguate' ? suggestedCustom : null,
    query: String(query),
  };
}

// ── POST /:agencyId/ai-lab/match ─────────────────────────────────────────────
router.post('/:agencyId/ai-lab/match', async (req, res) => {
  try {
    const query = String((req.body && req.body.query) || '').trim();
    if (!query) return res.status(400).json({ error: 'Describe the business, e.g. "an AI receptionist for a dental office".' });
    if (query.length > 500) return res.status(400).json({ error: 'That is a bit long, keep it to a sentence or two.' });

    // If the request includes a website, read its homepage so the classifier can
    // identify the business from real content (and pull its name/city), not just
    // from the words typed. Best-effort and time-boxed; a miss just falls back to
    // the text. This is what makes pasting a bare link actually work.
    const urlInQuery = extractUrl(query);
    let siteText = null;
    if (urlInQuery) {
      try {
        const { fetchPageWithJina } = require('../lib/website-scraper');
        const page = await fetchPageWithJina(urlInQuery, 8000);
        if (page) siteText = String(page).replace(/\s+/g, ' ').trim().slice(0, 2000);
      } catch (e) { console.warn('ai-lab match: homepage read failed (continuing):', e.message); }
    }

    // Primary: LLM semantic routing (grounded by the site text when we have it).
    // Fallback: keyword matcher, run over the query plus any site text, so the
    // bar still works if the Anthropic call is down or unconfigured.
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

// ── POST /:agencyId/ai-lab/build ─────────────────────────────────────────────
// Turn a matched (or custom) industry into a real receptionist SKELETON: an
// assistant (optionally grounded by a website scrape) plus an assigned number,
// stored as a client. The FIRST build for an agency with no test client yet
// becomes its TEST client; after that, builds are regular clients.
router.post('/:agencyId/ai-lab/build', async (req, res) => {
  const { agencyId } = req.params;
  const body = req.body || {};
  const industry = String(body.industry || '').trim();
  const businessNameIn = String(body.business_name || '').trim();
  const city = String(body.city || '').trim();
  const websiteUrl = String(body.website_url || '').trim();
  const subVertical = String(body.sub_vertical || '').trim();

  try {
    const { supabase, getAgencyById } = require('../lib/supabase');
    const agency = await getAgencyById(agencyId);
    if (!agency) return res.status(404).json({ error: 'Agency not found' });

    // Validate the industry: a built-in template value OR one of the agency's
    // own custom industry keys.
    const customKeys = Array.isArray(agency.custom_industries)
      ? agency.custom_industries.map((c) => c && c.key).filter(Boolean) : [];
    if (!industry || (!VALID_VALUES.has(industry) && !customKeys.includes(industry))) {
      return res.status(400).json({ error: 'Unknown industry for this agency.' });
    }

    // First build (no test client yet) is the TEST client; later builds are real.
    const isTest = !agency.test_client_id;

    // Assigning a number buys a real Telnyx line unless this is a demo agency.
    // A real purchase is a paid-plan action (the trial grants it).
    const planType = String(agency.plan_type || '').toLowerCase();
    const demoSkip = agency.skip_number_provisioning === true;
    if (!demoSkip && planType === 'free') {
      return res.status(403).json({
        error: 'upgrade_required', upgrade_required: true, feature: 'ai_lab_build', current_plan: 'free',
        title: 'Building a live receptionist is a paid feature',
        message: 'Building a receptionist assigns a real phone number so you can call it and hear it. Start your free trial to build it.',
        cta: 'Start your free trial', upgrade_url: '/agency/settings?tab=billing',
      });
    }

    const titleCase = (s) => s.replace(/\b\w/g, (m) => m.toUpperCase());
    const businessName = businessNameIn
      || (isTest ? `${agency.name} - Test Business` : (subVertical ? titleCase(subVertical) : 'New Receptionist'));
    const agencyCountry = (agency.country || 'US').toUpperCase();

    // 1) Optional website scrape to ground the knowledge base in the real site.
    let kbData = null;
    if (websiteUrl) {
      try {
        const { createKnowledgeBaseFromWebsite } = require('../lib/website-scraper');
        kbData = await createKnowledgeBaseFromWebsite(websiteUrl, businessName);
      } catch (e) { console.warn('ai-lab build: scrape failed (continuing):', e.message); }
    }

    // 2) Assistant skeleton. createIndustryAssistant resolves built-in AND custom
    //    industry keys, and folds in the scraped KB when present.
    const { createIndustryAssistant } = require('../lib/vapi');
    const assistant = await createIndustryAssistant(businessName, industry, kbData, agency.phone || null, null, agencyId);

    // 3) Assign a number through the demo-aware provisioner (placeholder for a
    //    demo agency, a real number otherwise). Non-fatal: a skeleton with no
    //    number is still useful and the number can be assigned later.
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

    // 4) Create the client skeleton (mirrors the proven test-client insert;
    //    NOT NULL columns like pricing_mode/voice_routing fall to DB defaults).
    const DEFAULT_HOURS = {
      monday: { open: '9:00 AM', close: '5:00 PM', closed: false }, tuesday: { open: '9:00 AM', close: '5:00 PM', closed: false },
      wednesday: { open: '9:00 AM', close: '5:00 PM', closed: false }, thursday: { open: '9:00 AM', close: '5:00 PM', closed: false },
      friday: { open: '9:00 AM', close: '5:00 PM', closed: false }, saturday: { open: '9:00 AM', close: '5:00 PM', closed: true },
      sunday: { open: '9:00 AM', close: '5:00 PM', closed: true },
    };
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
      vapi_assistant_id: assistant.id,
      vapi_phone_number: phoneNumber,
      vapi_phone_id: vapiPhoneId,
      provisioning_method: provisioningMethod || 'platform',
      business_hours: DEFAULT_HOURS,
      status: 'active',
      subscription_status: 'active',
      plan_type: isTest ? 'growth' : 'starter',
      is_test_client: isTest,
      calls_this_month: 0,
    }).select('id, business_name, phone_number, is_test_client, industry').single();
    if (insErr) { console.error('ai-lab build: client insert failed:', insErr.message); return res.status(500).json({ error: 'Could not create the receptionist.' }); }

    if (isTest) await supabase.from('agencies').update({ test_client_id: client.id }).eq('id', agencyId);

    console.log(`🧪 AI Lab build for ${agency.name}: ${businessName} (${industry}, ${isTest ? 'test' : 'client'}) -> ${phoneNumber || 'no number'}`);
    return res.json({ success: true, client_id: client.id, is_test: client.is_test_client, business_name: client.business_name, phone_number: client.phone_number, industry: client.industry });
  } catch (e) {
    console.error('ai-lab build error:', e.message);
    return res.status(500).json({ error: 'Could not build the receptionist right now.' });
  }
});

module.exports = router;
// Exported for unit tests (no network).
module.exports._internal = { CATALOG, extractUrl, classifyByKeyword, decideRouting, parseJsonLoose };

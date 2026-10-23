// ============================================================================
// BANK SMS PARSER  (destination: src/lib/bank-sms-parser.js)
// ----------------------------------------------------------------------------
// Turns a raw bank/card alert text message into one structured transaction, and
// reasons out its category and whether it is a personal or a business expense
// (and which business). One Anthropic call, no DB, no secrets stored.
//
// Banks have no API, so Gibson points each account's SMS alerts at a Telnyx
// number he owns. Those texts land on /webhook/telnyx-sms and are handed here.
// Formats vary wildly by bank (Wells Fargo, Discover, Chase, Capital One, ...),
// so instead of brittle regex we let Claude read the text and return strict JSON.
//
// Returns { isTransaction:false } for anything that is not a spend/deposit alert
// (OTP codes, marketing, balance-only pings, fraud questions), so the caller can
// drop it. Never throws: on any error it returns { isTransaction:false, error }.
//
// Env: ANTHROPIC_API_KEY. Optional FINANCE_PARSE_MODEL (defaults to a current
// Claude model). Low volume (one call per alert), so model cost is negligible.
// ============================================================================

'use strict';

const MODEL = process.env.FINANCE_PARSE_MODEL || 'claude-sonnet-4-6';

const PERSONAL_CATEGORIES = [
  'Groceries', 'Dining', 'Gas', 'Transportation', 'Shopping', 'Utilities',
  'Housing', 'Insurance', 'Health', 'Entertainment', 'Subscriptions',
  'Travel', 'Fees', 'Transfer', 'Income', 'Other',
];
const BUSINESS_CATEGORIES = [
  'Software', 'Telephony', 'AI & Compute', 'Hosting', 'Advertising',
  'Contractors', 'Office', 'Payments', 'Fees', 'Transfer', 'Income', 'Other',
];

const BUSINESS_MERCHANT_HINTS = [
  'Telnyx', 'Vapi', 'Anthropic', 'OpenAI', 'Vercel', 'Supabase', 'Stripe',
  'Twilio', 'AWS', 'Amazon Web Services', 'Cloudflare', 'GitHub', 'Google Cloud',
  'DigitalOcean', 'ElevenLabs', 'Deepgram', 'Namecheap', 'Porkbun',
];

function buildSystemPrompt(ctx) {
  const today = ctx.today || '';
  const businesses = (ctx.businesses && ctx.businesses.length)
    ? ctx.businesses.join(', ')
    : 'VoiceAI Connect, ScopeBook, Southern Peach, Splash Restoration, GTC, Blog Farm, JB Lawn';
  return `You read a single bank or credit-card text alert and return ONE transaction as strict JSON. Today is ${today}.

Return ONLY a JSON object, no prose, no code fences.

If the text is NOT a real money-movement alert (it is a one-time passcode, a marketing message, a low-balance warning with no transaction, a fraud yes/no question, a card-activation notice, etc.), return exactly: {"isTransaction": false}

Otherwise return:
{
  "isTransaction": true,
  "direction": "out" | "in",            // out = money left the account (purchase, withdrawal, payment, fee). in = money came in (deposit, payroll, refund, transfer in).
  "amount": number,                      // positive dollars, no $ or commas, e.g. 45.23
  "merchant": string,                    // clean, human name. "WAL-MART #1234 LAWRENCEVILLE" -> "Walmart". For deposits use the source if given (e.g. "Payroll", "Zelle from John"), else "Deposit".
  "account": string,                     // the bank/card and last 4 if present, e.g. "Wells Fargo ...1234" or "Discover". "" if unknown.
  "postedDate": string | null,           // "YYYY-MM-DD". Resolve relative/partial dates against today. null if none stated.
  "type": "personal" | "business",
  "business": string,                    // if type is business, the single best match from this list: ${businesses}. Otherwise "".
  "category": string,                    // for personal pick ONE of: ${PERSONAL_CATEGORIES.join(', ')}. For business pick ONE of: ${BUSINESS_CATEGORIES.join(', ')}.
  "confidence": number,                  // 0 to 1, your confidence in the category + type.
  "note": string                         // "" unless something is genuinely useful (e.g. "recurring", "foreign transaction").
}

Reasoning rules:
- Categorize by what the merchant sells: Walmart/Kroger/Publix/Aldi -> Groceries. Shell/Chevron/QuikTrip/RaceTrac -> Gas. McDonald's/Chipotle/DoorDash/restaurants -> Dining. Netflix/Spotify/gym -> Subscriptions. Uber/Lyft/Delta -> Transportation or Travel. Amazon/Target/Best Buy -> Shopping.
- These merchants are almost always a BUSINESS cost, usually for VoiceAI Connect: ${BUSINESS_MERCHANT_HINTS.join(', ')}. Telnyx/Twilio -> Telephony. Vapi/Anthropic/OpenAI/ElevenLabs/Deepgram -> AI & Compute. Vercel/Supabase/AWS/Cloudflare/DigitalOcean/Google Cloud -> Hosting. GitHub/software tools -> Software. Stripe -> Payments.
- When a merchant is ambiguous between personal and business, default to personal unless it clearly matches a business (SaaS, infrastructure, ads, contractors).
- A deposit, direct deposit, payroll, refund, Zelle/Venmo in, or transfer in is direction "in". For personal income use category "Income"; for business income use "Income".
- Never invent an amount. If you cannot find a dollar amount, return {"isTransaction": false}.`;
}

function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end < 0 || end < start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch (e) { return null; }
}

async function parseBankSms(text, ctx = {}) {
  if (!process.env.ANTHROPIC_API_KEY) return { isTransaction: false, error: 'no ANTHROPIC_API_KEY' };
  const body = String(text || '').trim();
  if (!body) return { isTransaction: false, error: 'empty' };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        temperature: 0,
        system: buildSystemPrompt(ctx),
        messages: [{ role: 'user', content: body }],
      }),
    });
    if (!res.ok) {
      console.warn('⚠️ bank-sms parse HTTP', res.status);
      return { isTransaction: false, error: `http ${res.status}` };
    }
    const data = await res.json();
    const out = (Array.isArray(data.content) ? data.content : [])
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text).join('').trim();
    const parsed = extractJson(out);
    if (!parsed || parsed.isTransaction !== true) return { isTransaction: false };
    const amount = Math.abs(Number(parsed.amount));
    if (!amount || !isFinite(amount)) return { isTransaction: false };
    const type = /bus/i.test(String(parsed.type)) ? 'business' : 'personal';
    const allowed = type === 'business' ? BUSINESS_CATEGORIES : PERSONAL_CATEGORIES;
    let category = String(parsed.category || 'Other').trim();
    if (!allowed.some((c) => c.toLowerCase() === category.toLowerCase())) category = 'Other';
    else category = allowed.find((c) => c.toLowerCase() === category.toLowerCase());
    return {
      isTransaction: true,
      direction: parsed.direction === 'in' ? 'in' : 'out',
      amount,
      merchant: String(parsed.merchant || '').trim().slice(0, 80) || 'Unknown',
      account: String(parsed.account || '').trim().slice(0, 60),
      postedDate: /^\d{4}-\d{2}-\d{2}$/.test(parsed.postedDate || '') ? parsed.postedDate : null,
      type,
      business: type === 'business' ? String(parsed.business || '').trim().slice(0, 60) : '',
      category,
      confidence: (parsed.confidence != null && isFinite(Number(parsed.confidence))) ? Number(parsed.confidence) : null,
      note: String(parsed.note || '').trim().slice(0, 120),
    };
  } catch (e) {
    console.warn('⚠️ bank-sms parse error:', e.message);
    return { isTransaction: false, error: e.message };
  } finally {
    clearTimeout(t);
  }
}

module.exports = { parseBankSms, PERSONAL_CATEGORIES, BUSINESS_CATEGORIES };

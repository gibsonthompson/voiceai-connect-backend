// Flutterwave client billing routes. Slice 2: the first charge, a hosted checkout
// that captures a reusable card token used for recurring billing (tokenized
// charges). Multi-tenant: each agency's own (decrypted) Flutterwave key is used;
// the platform takes no cut, so the full charge settles to the agency.
//
// Flutterwave differs from Paystack in two ways that matter here:
//   - amounts are in MAJOR units (no subunit conversion), and
//   - the browser returns via redirect_url with ?status, tx_ref & transaction_id;
//     we verify by transaction_id and read the reusable token from data.card.token.

const jwt = require('jsonwebtoken');
const { supabase } = require('../lib/supabase');
const { decrypt } = require('../lib/encryption');
const { getPlan } = require('../lib/plans');
const flutterwave = require('../lib/flutterwave');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const FRONTEND_URL = process.env.FRONTEND_URL || '';
const BACKEND_URL = process.env.BACKEND_URL || process.env.PUBLIC_BACKEND_URL || '';

function decodeToken(req) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return {};
    return jwt.verify(token, JWT_SECRET) || {};
  } catch { return {}; }
}

// POST /api/client/flutterwave/init  { client_id }
// Starts the client's first Flutterwave charge and returns a hosted checkout URL.
// The amount is the client's plan price in the agency's Flutterwave currency.
async function initFlutterwaveCharge(req, res) {
  try {
    const decoded = decodeToken(req);
    const clientId = (req.body && req.body.client_id) || decoded.clientId;
    if (!clientId) return res.status(400).json({ error: 'client_id required' });

    const { data: client } = await supabase
      .from('clients')
      .select('*, agencies!clients_agency_id_fkey(*)')
      .eq('id', clientId)
      .single();
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const agency = client.agencies;
    if (!agency) return res.status(404).json({ error: 'Agency not found' });

    const isSuperAdmin = decoded.role === 'super_admin';
    const isOwnClient = decoded.clientId && decoded.clientId === client.id;
    const isManagingAgency = decoded.agencyId && decoded.agencyId === client.agency_id;
    if (!isSuperAdmin && !isOwnClient && !isManagingAgency) return res.status(403).json({ error: 'Forbidden' });

    if (!agency.flutterwave_connected || !agency.flutterwave_secret_key_encrypted) {
      return res.status(400).json({ error: 'This provider is not set up with Flutterwave.' });
    }
    if (!client.email) return res.status(400).json({ error: 'This client has no email on file.' });

    const currency = agency.flutterwave_currency || 'NGN';
    // Honor a plan chosen at checkout (e.g. the upgrade screen), else the
    // client's current plan. Persisted below so the recurring charge and the
    // dashboard reflect the plan they actually paid for.
    const requestedPlan = req.body && req.body.plan;
    const planType = (requestedPlan && getPlan(agency, requestedPlan)) ? requestedPlan : client.plan_type;
    const plan = getPlan(agency, planType);
    const priceCents = plan && Number.isInteger(plan.price_cents) ? plan.price_cents : 0;
    if (!priceCents || priceCents <= 0) return res.status(400).json({ error: 'No price is set for this plan.' });

    let secretKey;
    try { secretKey = decrypt(agency.flutterwave_secret_key_encrypted); }
    catch { return res.status(500).json({ error: 'Could not read the provider Flutterwave credentials.' }); }

    const reference = `flw_${client.id}_${Date.now()}`;
    const init = await flutterwave.initializePayment(secretKey, {
      txRef: reference,
      amount: priceCents / 100,        // Flutterwave amounts are in MAJOR units
      currency,
      redirectUrl: `${BACKEND_URL}/api/client/flutterwave/callback`,
      email: client.email,
      name: client.business_name || client.name || undefined,
      meta: { client_id: client.id, agency_id: agency.id, type: 'first_charge', plan: planType },
    });

    await supabase.from('clients').update({ flutterwave_last_reference: reference, plan_type: planType }).eq('id', client.id);
    return res.json({ success: true, authorization_url: init && init.link, reference });
  } catch (e) {
    console.error('\u274c initFlutterwaveCharge error:', e.message);
    return res.status(500).json({ error: e.message || 'Failed to start Flutterwave checkout.' });
  }
}

// GET /api/client/flutterwave/callback?status=...&tx_ref=...&transaction_id=...
// Flutterwave redirects the client's browser here after payment. Verify by the
// transaction id, store the saved card token for recurring billing, bounce back.
async function flutterwaveCallback(req, res) {
  const done = (ok) => res.redirect(`${FRONTEND_URL}/client/settings?billing=${ok ? 'flutterwave_success' : 'flutterwave_failed'}`);
  try {
    const txRef = req.query.tx_ref;
    const transactionId = req.query.transaction_id;
    const status = req.query.status;
    // Flutterwave sends status=successful|cancelled|failed. Bail early on an
    // explicit non-success; otherwise fall through and confirm via the API.
    if (!txRef || !transactionId) return done(false);
    if (status && status !== 'successful' && status !== 'completed') return done(false);

    const { data: client } = await supabase
      .from('clients')
      .select('*, agencies!clients_agency_id_fkey(*)')
      .eq('flutterwave_last_reference', txRef)
      .single();
    if (!client || !client.agencies || !client.agencies.flutterwave_secret_key_encrypted) return done(false);
    const agency = client.agencies;

    let secretKey;
    try { secretKey = decrypt(agency.flutterwave_secret_key_encrypted); } catch { return done(false); }

    const tx = await flutterwave.verifyTransaction(secretKey, transactionId);
    const token = tx && tx.card && tx.card.token;
    if (!tx || tx.status !== 'successful' || !token) return done(false);

    const next = new Date();
    next.setMonth(next.getMonth() + 1);
    await supabase.from('clients').update({
      billing_mode: 'flutterwave',
      flutterwave_card_token: token,
      flutterwave_email: (tx.customer && tx.customer.email) || client.email,
      flutterwave_status: 'active',
      flutterwave_next_charge_at: next.toISOString(),
      subscription_status: 'active',
    }).eq('id', client.id);

    return done(true);
  } catch (e) {
    console.error('\u274c flutterwaveCallback error:', e.message);
    return done(false);
  }
}

// Map a settlement currency to the ISO country Flutterwave expects on a
// tokenized charge. Falls back to NG.
function currencyToCountry(currency) {
  const map = { NGN: 'NG', GHS: 'GH', KES: 'KE', ZAR: 'ZA', UGX: 'UG', TZS: 'TZ', USD: 'US', XAF: 'CM', XOF: 'CI', RWF: 'RW', ZMW: 'ZM' };
  return map[currency] || 'NG';
}

// Charge one client's saved card token for their monthly plan price. Advances the
// next charge date on success; runs dunning on failure. amount is in MAJOR units.
// NOTE: automated (hands-off) charging needs NOAUTH subsequent charges enabled on
// the agency's Flutterwave account; without it Flutterwave returns a pending/3DS
// result, which we treat as a failure (so it flows into dunning).
async function chargeClientOnce(client) {
  const agency = client.agencies;
  if (!agency || !agency.flutterwave_secret_key_encrypted || !client.flutterwave_card_token) return { skipped: true };
  let secretKey;
  try { secretKey = decrypt(agency.flutterwave_secret_key_encrypted); } catch { return { error: 'decrypt' }; }
  const currency = agency.flutterwave_currency || 'NGN';
  const plan = getPlan(agency, client.plan_type);
  const priceCents = plan && Number.isInteger(plan.price_cents) ? plan.price_cents : 0;
  if (!priceCents || priceCents <= 0) return { skipped: true };
  // Deterministic per-attempt reference: same client, same due date, same retry
  // number always produce the same tx_ref, so overlapping runs are rejected by
  // Flutterwave as a duplicate instead of double-charging. A genuine retry has a
  // later due date (and higher retry count), so it gets a fresh reference.
  const dueDate = client.flutterwave_next_charge_at ? new Date(client.flutterwave_next_charge_at) : new Date();
  const period = dueDate.toISOString().slice(0, 10).replace(/-/g, '');
  const reference = `flwr_${client.id}_${period}_r${client.flutterwave_retry_count || 0}`;
  try {
    const tx = await flutterwave.tokenizedCharge(secretKey, {
      token: client.flutterwave_card_token,
      amount: priceCents / 100,       // Flutterwave amounts are in MAJOR units
      currency,
      country: currencyToCountry(currency),
      email: client.flutterwave_email || client.email,
      txRef: reference,
      narration: `${(plan && plan.name) || 'Subscription'} - monthly`,
    });
    if (tx && tx.status === 'successful') {
      const next = new Date();
      next.setMonth(next.getMonth() + 1);
      await supabase.from('clients').update({
        flutterwave_status: 'active',
        subscription_status: 'active',
        flutterwave_next_charge_at: next.toISOString(),
        flutterwave_last_reference: reference,
        flutterwave_retry_count: 0,
      }).eq('id', client.id);
      return { charged: true };
    }
    return await handleChargeFailure(client, (tx && tx.processor_response) || (tx && tx.status) || 'declined');
  } catch (e) {
    const dup = /duplicate|already exist/i.test(e.message || '');
    if (dup) {
      console.warn(`\u23e9 Flutterwave recurring skipped duplicate charge for client ${client.id} (ref ${reference})`);
      return { skipped: true, duplicate: true };
    }
    return await handleChargeFailure(client, e.message);
  }
}

// Dunning: retry a failed charge a few times (every 3 days), then give up and mark
// the client past_due so the UI/agency can act.
async function handleChargeFailure(client, reason) {
  const MAX_RETRIES = 3;
  const retries = (client.flutterwave_retry_count || 0) + 1;
  if (retries >= MAX_RETRIES) {
    await supabase.from('clients').update({
      flutterwave_status: 'canceled',
      subscription_status: 'past_due',
      flutterwave_retry_count: retries,
    }).eq('id', client.id);
    console.warn(`\u26a0\ufe0f Flutterwave recurring gave up on client ${client.id} after ${retries} tries: ${reason}`);
    return { failed: true, gaveUp: true, reason };
  }
  const retryAt = new Date();
  retryAt.setDate(retryAt.getDate() + 3);
  await supabase.from('clients').update({
    flutterwave_status: 'past_due',
    subscription_status: 'past_due',
    flutterwave_next_charge_at: retryAt.toISOString(),
    flutterwave_retry_count: retries,
  }).eq('id', client.id);
  return { failed: true, retryAt: retryAt.toISOString(), reason };
}

// Find all Flutterwave clients due for a charge and bill them. Bounded per run.
async function runFlutterwaveRecurring(limit = 50) {
  const nowIso = new Date().toISOString();
  const { data: due } = await supabase
    .from('clients')
    .select('*, agencies!clients_agency_id_fkey(*)')
    .eq('billing_mode', 'flutterwave')
    .in('flutterwave_status', ['active', 'past_due'])
    .lte('flutterwave_next_charge_at', nowIso)
    .limit(limit);
  const results = { due: (due || []).length, charged: 0, failed: 0, skipped: 0, expired: 0 };
  for (const client of (due || [])) {
    const r = await chargeClientOnce(client);
    if (r.charged) results.charged++;
    else if (r.failed) results.failed++;
    else results.skipped++;
  }

  // Expire period-end cancels whose paid-through date has passed. 'canceling' is
  // set by a client self-cancel (slice 4) and kept out of the charge query above,
  // so those clients are never billed again but keep access until now. It is
  // distinct from the dunning 'canceled', so a failed-payment client is never
  // swept here.
  const { data: expiring } = await supabase
    .from('clients')
    .select('id')
    .eq('billing_mode', 'flutterwave')
    .eq('flutterwave_status', 'canceling')
    .lte('flutterwave_next_charge_at', nowIso)
    .limit(limit);
  for (const c of (expiring || [])) {
    await supabase.from('clients').update({
      flutterwave_status: 'canceled',
      subscription_status: 'expired',
      flutterwave_next_charge_at: null,
    }).eq('id', c.id);
    results.expired++;
  }

  return results;
}

// POST /api/cron/flutterwave-recurring  (hit by an external scheduler)
async function flutterwaveRecurringCron(req, res) {
  try {
    // Fail closed: refuse rather than run an open, unauthenticated charge endpoint.
    const secret = process.env.CRON_SECRET;
    if (!secret) {
      console.error('\u274c flutterwaveRecurringCron blocked: CRON_SECRET is not set on the backend');
      return res.status(503).json({ error: 'Cron secret not configured' });
    }
    const provided = req.headers['x-cron-secret'] || (req.query && req.query.secret);
    if (provided !== secret) return res.status(403).json({ error: 'Forbidden' });
    const results = await runFlutterwaveRecurring(Number(req.query && req.query.limit) || 50);
    return res.json({ success: true, ...results });
  } catch (e) {
    console.error('\u274c flutterwaveRecurringCron error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

// POST /webhook/flutterwave  (raw body). Flutterwave sends the static secret hash
// (set by the agency in their dashboard) in the verif-hash header. We resolve the
// agency from the transaction's tx_ref, compare the hash, then back up the
// first-charge token capture. Recurring is driven by our own cron.
async function handleFlutterwaveWebhook(req, res) {
  try {
    const signature = req.headers['verif-hash'];
    const rawBody = req.body; // Buffer (express.raw)
    let event;
    try { event = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody)); } catch { return res.sendStatus(400); }
    const data = event && event.data;
    const txRef = data && data.tx_ref;
    if (!txRef) return res.sendStatus(200);

    const { data: client } = await supabase
      .from('clients')
      .select('id, flutterwave_card_token, agencies!clients_agency_id_fkey(id, flutterwave_webhook_hash_encrypted)')
      .eq('flutterwave_last_reference', txRef)
      .single();
    if (!client || !client.agencies || !client.agencies.flutterwave_webhook_hash_encrypted) return res.sendStatus(200);

    let storedHash;
    try { storedHash = decrypt(client.agencies.flutterwave_webhook_hash_encrypted); } catch { return res.sendStatus(200); }
    if (!flutterwave.verifyWebhookHash(storedHash, signature)) return res.sendStatus(401);

    const token = data.card && data.card.token;
    if (event.event === 'charge.completed' && data.status === 'successful' && token && !client.flutterwave_card_token) {
      const next = new Date();
      next.setMonth(next.getMonth() + 1);
      await supabase.from('clients').update({
        billing_mode: 'flutterwave',
        flutterwave_card_token: token,
        flutterwave_email: (data.customer && data.customer.email) || null,
        flutterwave_status: 'active',
        subscription_status: 'active',
        flutterwave_next_charge_at: next.toISOString(),
      }).eq('id', client.id);
    }
    return res.sendStatus(200);
  } catch (e) {
    console.error('\u274c handleFlutterwaveWebhook error:', e.message);
    return res.sendStatus(200);
  }
}

module.exports = { initFlutterwaveCharge, flutterwaveCallback, runFlutterwaveRecurring, flutterwaveRecurringCron, handleFlutterwaveWebhook };
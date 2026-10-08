// Paystack client billing routes. Slice 2: the first charge, which captures a
// reusable card authorization used for recurring billing (charge_authorization).
// Multi-tenant: each agency's own (decrypted) Paystack key is used; the platform
// takes no cut, so the full charge settles to the agency.

const jwt = require('jsonwebtoken');
const { supabase } = require('../lib/supabase');
const { decrypt } = require('../lib/encryption');
const { getPlan } = require('../lib/plans');
const { computeOverageCents } = require('../lib/overage-billing');
const paystack = require('../lib/paystack');

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

// POST /api/client/paystack/init  { client_id }
// Starts the client's first Paystack charge and returns a checkout URL. The
// charge amount is the client's plan price in the agency's Paystack currency.
async function initPaystackCharge(req, res) {
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

    if (!agency.paystack_connected || !agency.paystack_secret_key_encrypted) {
      return res.status(400).json({ error: 'This provider is not set up with Paystack.' });
    }
    if (!client.email) return res.status(400).json({ error: 'This client has no email on file.' });

    const currency = agency.paystack_currency || 'NGN';
    // Honor a plan chosen at checkout (e.g. the upgrade screen), else the
    // client's current plan. Persisted below so the recurring charge and the
    // dashboard reflect the plan they actually paid for.
    const requestedPlan = req.body && req.body.plan;
    const planType = (requestedPlan && getPlan(agency, requestedPlan)) ? requestedPlan : client.plan_type;
    const plan = getPlan(agency, planType);
    const priceCents = plan && Number.isInteger(plan.price_cents) ? plan.price_cents : 0;
    if (!priceCents || priceCents <= 0) return res.status(400).json({ error: 'No price is set for this plan.' });

    let secretKey;
    try { secretKey = decrypt(agency.paystack_secret_key_encrypted); }
    catch { return res.status(500).json({ error: 'Could not read the provider Paystack credentials.' }); }

    const reference = `ps_${client.id}_${Date.now()}`;
    const init = await paystack.initializeTransaction(secretKey, {
      email: client.email,
      amount: priceCents / 100,        // lib converts to subunit
      currency,
      reference,
      callbackUrl: `${BACKEND_URL}/api/client/paystack/callback`,
      metadata: { client_id: client.id, agency_id: agency.id, type: 'first_charge', plan: planType },
    });

    await supabase.from('clients').update({ paystack_last_reference: reference, plan_type: planType }).eq('id', client.id);
    return res.json({ success: true, authorization_url: init && init.authorization_url, reference });
  } catch (e) {
    console.error('\u274c initPaystackCharge error:', e.message);
    return res.status(500).json({ error: e.message || 'Failed to start Paystack checkout.' });
  }
}

// GET /api/client/paystack/callback?reference=...
// Paystack redirects the client's browser here after payment. Verify the charge,
// store the saved card authorization for recurring billing, bounce to the client.
async function paystackCallback(req, res) {
  const done = (ok) => res.redirect(`${FRONTEND_URL}/client/settings?billing=${ok ? 'paystack_success' : 'paystack_failed'}`);
  try {
    const reference = req.query.reference || req.query.trxref;
    if (!reference) return done(false);

    const { data: client } = await supabase
      .from('clients')
      .select('*, agencies!clients_agency_id_fkey(*)')
      .eq('paystack_last_reference', reference)
      .single();
    if (!client || !client.agencies || !client.agencies.paystack_secret_key_encrypted) return done(false);
    const agency = client.agencies;

    let secretKey;
    try { secretKey = decrypt(agency.paystack_secret_key_encrypted); } catch { return done(false); }

    const tx = await paystack.verifyTransaction(secretKey, reference);
    if (!tx || tx.status !== 'success' || !tx.authorization || !tx.authorization.authorization_code) return done(false);

    const next = new Date();
    next.setMonth(next.getMonth() + 1);
    await supabase.from('clients').update({
      billing_mode: 'paystack',
      paystack_authorization_code: tx.authorization.authorization_code,
      paystack_customer_code: (tx.customer && tx.customer.customer_code) || null,
      paystack_email: (tx.customer && tx.customer.email) || client.email,
      paystack_status: 'active',
      paystack_next_charge_at: next.toISOString(),
      subscription_status: 'active',
    }).eq('id', client.id);

    return done(true);
  } catch (e) {
    console.error('\u274c paystackCallback error:', e.message);
    return done(false);
  }
}

// Charge one client's saved authorization for their monthly plan price. Advances
// the next charge date on success; runs dunning on failure.
async function chargeClientOnce(client) {
  const agency = client.agencies;
  if (!agency || !agency.paystack_secret_key_encrypted || !client.paystack_authorization_code) return { skipped: true };
  let secretKey;
  try { secretKey = decrypt(agency.paystack_secret_key_encrypted); } catch { return { error: 'decrypt' }; }
  const currency = agency.paystack_currency || 'NGN';
  const plan = getPlan(agency, client.plan_type);
  const priceCents = plan && Number.isInteger(plan.price_cents) ? plan.price_cents : 0;
  if (!priceCents || priceCents <= 0) return { skipped: true };
  // Deterministic per-attempt reference: the same client, same due date and same
  // retry number always produce the same reference. If two recurring runs ever
  // overlap, Paystack rejects the second as a duplicate instead of double-charging.
  // A genuine retry has a later due date (and a higher retry count), so it still
  // gets a fresh reference.
  const dueDate = client.paystack_next_charge_at ? new Date(client.paystack_next_charge_at) : new Date();
  const period = dueDate.toISOString().slice(0, 10).replace(/-/g, '');
  const reference = `psr_${client.id}_${period}_r${client.paystack_retry_count || 0}`;
  // Per-minute overage for the month that just closed (0 unless the agency bills
  // per minute and the client went over the plan's included minutes). Added to
  // the base plan price; a tally error returns 0 so the base charge still runs.
  const overageCents = await computeOverageCents(client, agency, dueDate.toISOString());
  const totalCents = priceCents + overageCents;
  try {
    const tx = await paystack.chargeAuthorization(secretKey, {
      email: client.paystack_email || client.email,
      amount: totalCents / 100,
      authorizationCode: client.paystack_authorization_code,
      currency,
      reference,
      metadata: { client_id: client.id, agency_id: agency.id, type: 'recurring', plan: client.plan_type, overage_cents: overageCents },
    });
    if (tx && tx.status === 'success') {
      const next = new Date();
      next.setMonth(next.getMonth() + 1);
      await supabase.from('clients').update({
        paystack_status: 'active',
        subscription_status: 'active',
        paystack_next_charge_at: next.toISOString(),
        paystack_last_reference: reference,
        paystack_retry_count: 0,
      }).eq('id', client.id);
      return { charged: true };
    }
    return await handleChargeFailure(client, (tx && tx.gateway_response) || 'declined');
  } catch (e) {
    // A duplicate-reference rejection means another overlapping run already owns
    // this exact charge attempt. Treat it as a no-op, never a payment failure, so
    // we don't run dunning on a client the other run is charging.
    const dup = /duplicate/i.test(e.message || '') || (e.paystack && e.paystack.code === 'duplicate_reference');
    if (dup) {
      console.warn(`\u23e9 Paystack recurring skipped duplicate charge for client ${client.id} (ref ${reference})`);
      return { skipped: true, duplicate: true };
    }
    return await handleChargeFailure(client, e.message);
  }
}

// Dunning: retry a failed charge a few times (every 3 days), then give up and mark
// the client past_due so the UI/agency can act.
async function handleChargeFailure(client, reason) {
  const MAX_RETRIES = 3;
  const retries = (client.paystack_retry_count || 0) + 1;
  if (retries >= MAX_RETRIES) {
    await supabase.from('clients').update({
      paystack_status: 'canceled',
      subscription_status: 'past_due',
      paystack_retry_count: retries,
    }).eq('id', client.id);
    console.warn(`\u26a0\ufe0f Paystack recurring gave up on client ${client.id} after ${retries} tries: ${reason}`);
    return { failed: true, gaveUp: true, reason };
  }
  const retryAt = new Date();
  retryAt.setDate(retryAt.getDate() + 3);
  await supabase.from('clients').update({
    paystack_status: 'past_due',
    subscription_status: 'past_due',
    paystack_next_charge_at: retryAt.toISOString(),
    paystack_retry_count: retries,
  }).eq('id', client.id);
  return { failed: true, retryAt: retryAt.toISOString(), reason };
}

// Find all Paystack clients due for a charge and bill them. Bounded per run.
async function runPaystackRecurring(limit = 50) {
  const nowIso = new Date().toISOString();
  const { data: due } = await supabase
    .from('clients')
    .select('*, agencies!clients_agency_id_fkey(*)')
    .eq('billing_mode', 'paystack')
    .in('paystack_status', ['active', 'past_due'])
    .lte('paystack_next_charge_at', nowIso)
    .limit(limit);
  const results = { due: (due || []).length, charged: 0, failed: 0, skipped: 0, expired: 0 };
  for (const client of (due || [])) {
    const r = await chargeClientOnce(client);
    if (r.charged) results.charged++;
    else if (r.failed) results.failed++;
    else results.skipped++;
  }

  // Expire period-end cancels whose paid-through date has passed. A client
  // self-cancel sets paystack_status to 'canceling' (kept out of the charge
  // query above), so they are never billed again but keep access until now.
  // 'canceling' is distinct from the dunning 'canceled' set by handleChargeFailure,
  // so a failed-payment client is never swept here.
  const { data: expiring } = await supabase
    .from('clients')
    .select('id')
    .eq('billing_mode', 'paystack')
    .eq('paystack_status', 'canceling')
    .lte('paystack_next_charge_at', nowIso)
    .limit(limit);
  for (const c of (expiring || [])) {
    await supabase.from('clients').update({
      paystack_status: 'canceled',
      subscription_status: 'expired',
      paystack_next_charge_at: null,
    }).eq('id', c.id);
    results.expired++;
  }

  return results;
}

// POST /api/cron/paystack-recurring  (hit by an external scheduler)
async function paystackRecurringCron(req, res) {
  try {
    // Fail closed: if no secret is configured, refuse rather than run an open,
    // unauthenticated charge endpoint. Set CRON_SECRET on the backend (and match
    // it in the Vercel cron route) to enable recurring billing.
    const secret = process.env.CRON_SECRET;
    if (!secret) {
      console.error('\u274c paystackRecurringCron blocked: CRON_SECRET is not set on the backend');
      return res.status(503).json({ error: 'Cron secret not configured' });
    }
    const provided = req.headers['x-cron-secret'] || (req.query && req.query.secret);
    if (provided !== secret) return res.status(403).json({ error: 'Forbidden' });
    const results = await runPaystackRecurring(Number(req.query && req.query.limit) || 50);
    return res.json({ success: true, ...results });
  } catch (e) {
    console.error('\u274c paystackRecurringCron error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

// POST /webhook/paystack  (raw body). Each agency points their Paystack webhook
// here; events are signed with that agency's secret key, so we resolve the agency
// from metadata, then verify. Recurring is driven by our own cron, so this mainly
// backs up the first-charge capture and lets us react to async events later.
async function handlePaystackWebhook(req, res) {
  try {
    const signature = req.headers['x-paystack-signature'];
    const rawBody = req.body; // Buffer (express.raw)
    let event;
    try { event = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody)); } catch { return res.sendStatus(400); }
    const data = event && event.data;
    const agencyId = data && data.metadata && data.metadata.agency_id;
    const clientId = data && data.metadata && data.metadata.client_id;
    if (!agencyId) return res.sendStatus(200);
    const { data: agency } = await supabase.from('agencies').select('id, paystack_secret_key_encrypted').eq('id', agencyId).single();
    if (!agency || !agency.paystack_secret_key_encrypted) return res.sendStatus(200);
    let secretKey;
    try { secretKey = decrypt(agency.paystack_secret_key_encrypted); } catch { return res.sendStatus(200); }
    if (!paystack.verifyWebhookSignature(secretKey, rawBody, signature)) return res.sendStatus(401);

    if (event.event === 'charge.success' && clientId && data.authorization && data.authorization.authorization_code) {
      const { data: client } = await supabase.from('clients').select('paystack_authorization_code').eq('id', clientId).single();
      if (client && !client.paystack_authorization_code) {
        const next = new Date();
        next.setMonth(next.getMonth() + 1);
        await supabase.from('clients').update({
          billing_mode: 'paystack',
          paystack_authorization_code: data.authorization.authorization_code,
          paystack_customer_code: (data.customer && data.customer.customer_code) || null,
          paystack_email: (data.customer && data.customer.email) || null,
          paystack_status: 'active',
          subscription_status: 'active',
          paystack_next_charge_at: next.toISOString(),
        }).eq('id', clientId);
      }
    }
    return res.sendStatus(200);
  } catch (e) {
    console.error('\u274c handlePaystackWebhook error:', e.message);
    return res.sendStatus(200);
  }
}

module.exports = { initPaystackCharge, paystackCallback, runPaystackRecurring, paystackRecurringCron, handlePaystackWebhook };
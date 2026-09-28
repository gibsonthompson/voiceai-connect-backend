// Flutterwave API wrapper for VoiceAI Connect.
//
// Multi-tenant by design: every function takes the AGENCY's own Flutterwave
// secret key (decrypted by the caller via lib/encryption), so the platform never
// needs its own Flutterwave account. The platform takes no cut, so each charge
// settles fully to the agency's Flutterwave account.
//
// Recurring billing uses card Tokenization: charge the customer once via the
// hosted checkout to capture a reusable card token, then charge that token on a
// schedule. The platform owns the billing cycle (plan changes, cancel, dunning)
// exactly as it does on the Stripe and Paystack paths.
//
// TWO IMPORTANT DIFFERENCES FROM PAYSTACK:
//   1. Amounts are in MAJOR currency units (149 = 149 NGN), NOT the subunit, so
//      callers pass the plain amount and there is no x100 conversion here.
//   2. Webhooks are verified against a static "secret hash" the agency sets in
//      their Flutterwave dashboard and sends back in the verif-hash header, NOT
//      an HMAC of the body.
//
// NOTE ON RECURRING: automated (hands-off) tokenized charges require the agency's
// Flutterwave account to have NOAUTH subsequent charges enabled (a support
// request to Flutterwave). Without it, Flutterwave applies 3DS to subsequent
// charges and they need customer interaction.

const FLW_BASE = 'https://api.flutterwave.com/v3';

async function flutterwaveRequest(secretKey, method, path, body) {
  if (!secretKey) throw new Error('Flutterwave secret key is required');
  const res = await fetch(`${FLW_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok || (data && data.status === 'error')) {
    const msg = (data && data.message) || `Flutterwave ${method} ${path} failed (HTTP ${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.flutterwave = data;
    throw err;
  }
  return data ? data.data : null;
}

// Validate a secret key by fetching balances. Used when an agency connects
// Flutterwave, to confirm the key works before we store it. Throws if invalid.
async function verifyKey(secretKey) {
  const data = await flutterwaveRequest(secretKey, 'GET', '/balances');
  return { ok: true, balances: data };
}

// First charge: create a hosted Standard checkout the client completes (card
// only, so the card can be tokenized). Returns the payment object; use .link as
// the checkout URL. amount is in MAJOR units.
async function initializePayment(secretKey, { txRef, amount, currency, redirectUrl, email, name, meta }) {
  return flutterwaveRequest(secretKey, 'POST', '/payments', {
    tx_ref: txRef,
    amount,
    currency,
    redirect_url: redirectUrl,
    payment_options: 'card',
    customer: { email, ...(name ? { name } : {}) },
    ...(meta ? { meta } : {}),
  });
}

// Verify a transaction by its Flutterwave transaction id (from the redirect
// transaction_id param or data.id). The returned object contains status,
// amount, currency, customer, and card.token (the reusable token to store).
async function verifyTransaction(secretKey, transactionId) {
  return flutterwaveRequest(secretKey, 'GET', `/transactions/${encodeURIComponent(transactionId)}/verify`);
}

// Recurring charge: bill a saved card token. amount is in MAJOR units. country
// is the 2-letter code (derive from currency). See the NOAUTH note above.
async function tokenizedCharge(secretKey, { token, amount, currency, country, email, txRef, narration, firstName }) {
  return flutterwaveRequest(secretKey, 'POST', '/tokenized-charges', {
    token,
    amount,
    currency,
    ...(country ? { country } : {}),
    email,
    tx_ref: txRef,
    ...(narration ? { narration } : {}),
    ...(firstName ? { first_name: firstName } : {}),
  });
}

// Flutterwave webhooks carry the static "secret hash" (set in the agency's
// Flutterwave dashboard) in the verif-hash header. Compare it to the stored
// hash with a timing-safe check. This is NOT an HMAC of the body.
function verifyWebhookHash(storedHash, signature) {
  if (!storedHash || !signature) return false;
  const crypto = require('crypto');
  const a = Buffer.from(String(storedHash));
  const b = Buffer.from(String(signature));
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

module.exports = {
  FLW_BASE,
  verifyKey,
  initializePayment,
  verifyTransaction,
  tokenizedCharge,
  verifyWebhookHash,
};
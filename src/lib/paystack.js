// Paystack API wrapper for VoiceAI Connect.
//
// Multi-tenant by design: every function takes the AGENCY's own Paystack secret
// key (decrypted by the caller via lib/encryption), so the platform never needs
// its own Paystack account. No subaccounts / splits are used: the platform takes
// no cut of client billing (confirmed: no application_fee on the Stripe path
// either), so each charge settles fully to the agency's Paystack account.
//
// Recurring billing uses Charge Authorization (store the card token from a first
// 2FA charge, then charge it on a schedule), not native Paystack Subscriptions,
// because the platform owns the billing cycle (plan changes, proration, cancel,
// dunning) exactly as it does on the Stripe path.

const crypto = require('crypto');

const PAYSTACK_BASE = 'https://api.paystack.co';

// Paystack amounts are in the currency's subunit. All supported currencies
// (NGN kobo, GHS pesewas, ZAR/KES cents, XOF) use a 100x subunit.
function toSubunit(majorAmount) {
  return Math.round(Number(majorAmount) * 100);
}

async function paystackRequest(secretKey, method, path, body) {
  if (!secretKey) throw new Error('Paystack secret key is required');
  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok || (data && data.status === false)) {
    const msg = (data && data.message) || `Paystack ${method} ${path} failed (HTTP ${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.paystack = data;
    throw err;
  }
  return data ? data.data : null;
}

// Validate a secret key by fetching the account balance. Used when an agency
// connects Paystack, to confirm the key works (and is a secret key) before we
// store it. Throws if the key is invalid.
async function verifyKey(secretKey) {
  const data = await paystackRequest(secretKey, 'GET', '/balance');
  return { ok: true, balances: data };
}

// First charge: creates a hosted checkout the client completes (card + the 2FA
// the first charge legally requires). After completion, verifyTransaction (or the
// charge.success webhook) returns the `authorization` we store for recurring use.
async function initializeTransaction(secretKey, { email, amount, currency, reference, callbackUrl, metadata, channels }) {
  return paystackRequest(secretKey, 'POST', '/transaction/initialize', {
    email,
    amount: toSubunit(amount),
    currency,
    ...(reference ? { reference } : {}),
    ...(callbackUrl ? { callback_url: callbackUrl } : {}),
    ...(metadata ? { metadata } : {}),
    ...(channels ? { channels } : {}),
  });
}

// Verify a transaction by reference. After the first charge, the returned object
// contains `authorization` (the saved card, including authorization_code) plus
// `customer`. Store authorization.authorization_code and the exact email used.
async function verifyTransaction(secretKey, reference) {
  return paystackRequest(secretKey, 'GET', `/transaction/verify/${encodeURIComponent(reference)}`);
}

// Recurring charge: bill a saved authorization (the stored card). Only the email
// used to create the authorization can charge it, so always pass the stored
// paystack_email, not the client's current email.
async function chargeAuthorization(secretKey, { email, amount, authorizationCode, currency, reference, metadata }) {
  return paystackRequest(secretKey, 'POST', '/transaction/charge_authorization', {
    email,
    amount: toSubunit(amount),
    authorization_code: authorizationCode,
    currency,
    ...(reference ? { reference } : {}),
    ...(metadata ? { metadata } : {}),
  });
}

// Paystack signs webhook payloads with HMAC-SHA512 of the raw request body using
// the secret key. Compare against the x-paystack-signature header. Multi-tenant:
// the signature is per-agency (their key), so the webhook handler resolves the
// agency (e.g. by the reference/metadata) before calling this. rawBody must be
// the raw bytes/string, not the parsed JSON.
function verifyWebhookSignature(secretKey, rawBody, signature) {
  if (!secretKey || !signature) return false;
  const hash = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(String(signature)));
  } catch {
    return false;
  }
}

module.exports = {
  PAYSTACK_BASE,
  toSubunit,
  verifyKey,
  initializeTransaction,
  verifyTransaction,
  chargeAuthorization,
  verifyWebhookSignature,
};
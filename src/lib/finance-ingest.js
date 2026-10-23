// ============================================================================
// FINANCE INGEST  (destination: src/lib/finance-ingest.js)
// ----------------------------------------------------------------------------
// One entry point for turning a bank-alert SMS into an HQ transaction row.
// Called from the /webhook/telnyx-sms handler for texts sent to Gibson's
// dedicated finance number. Self-contained so the SMS webhook change stays a
// single isolated branch and the receptionist path is never touched.
//
//   bank alert text -> parseBankSms (Claude) -> buildTxn -> HQ Supabase upsert
//
// Idempotent: the row id is derived from the Telnyx message id, so a retried
// webhook upserts the same row instead of creating a duplicate charge.
// Best-effort: never throws; returns a small result object the caller can log.
// ============================================================================

'use strict';

const { parseBankSms } = require('./bank-sms-parser');
const { buildTxn, SEEDED_VENTURES } = require('./hq-items');
const hq = require('./hq-supabase');

function etToday() {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const get = (t) => (parts.find((p) => p.type === t) || {}).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch (e) {
    return new Date().toISOString().slice(0, 10);
  }
}

function idFromMessage(telnyxMessageId, text) {
  if (telnyxMessageId) return 'txn_' + String(telnyxMessageId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 40);
  let h = 0;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return 'txn_' + Date.now().toString(36) + h.toString(36);
}

// Optional map of alert sender -> friendly bank/account name, so a bare short
// code ("24273") shows as "Chase" and terse alerts get the right account.
// Set env HQ_BANK_SENDERS as JSON, e.g. {"24273":"Chase","434340":"Wells Fargo"}.
// Keys are matched against the raw sender with and without a leading '+'.
function bankSenderMap() {
  try { return JSON.parse(process.env.HQ_BANK_SENDERS || '{}') || {}; } catch (e) { return {}; }
}
function lookupSenderBank(from) {
  if (!from) return '';
  const map = bankSenderMap();
  const raw = String(from);
  return map[raw] || map[raw.replace(/^\+/, '')] || map[raw.replace(/\D/g, '')] || '';
}

async function ingestBankSms({ text, from, to, telnyxMessageId } = {}) {
  const sender = from ? String(from).trim() : '';
  const senderBank = lookupSenderBank(sender);
  const parsed = await parseBankSms(text, { today: etToday(), businesses: SEEDED_VENTURES, sender, senderBank });
  if (!parsed || !parsed.isTransaction) {
    console.log('💸 finance: not a transaction alert, ignored', parsed && parsed.error ? `(${parsed.error})` : '', sender ? `[from ${sender}]` : '');
    return { ok: true, skipped: true, reason: 'not-a-transaction' };
  }

  // Account label: what the parser read from the text, else the mapped bank name.
  const account = parsed.account || senderBank || '';

  const row = buildTxn({
    id: idFromMessage(telnyxMessageId, text),
    amount: parsed.amount,
    direction: parsed.direction,
    merchant: parsed.merchant,
    category: parsed.category,
    account: account,
    sender: sender,
    business: parsed.business,
    type: parsed.type,
    postedDate: parsed.postedDate,
    note: parsed.note,
    raw: String(text || '').slice(0, 320),
    source: 'sms',
    confidence: parsed.confidence,
  });

  const result = await hq.upsertItems(row);
  if (!result.ok) {
    console.error('❌ finance: HQ write failed:', result.error);
    return { ok: false, reason: result.error };
  }
  const d = row.data;
  console.log(`💸 finance: ${d.direction === 'in' ? '+' : '-'}$${d.amount} ${d.merchant} [${d.type}/${d.category}${d.business ? '/' + d.business : ''}]`);
  return { ok: true, txn: d };
}

module.exports = { ingestBankSms, etToday };

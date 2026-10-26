// ============================================================================
// FINANCE EMAIL POLLER  (destination: src/lib/finance-email.js)
// ----------------------------------------------------------------------------
// The email counterpart to the bank-alert SMS path, for banks that refuse to
// text a VoIP/Telnyx number (Wells Fargo among them) but will EMAIL the same
// transaction alerts. Polls a Gmail (or any IMAP) inbox over IMAP with an App
// Password (no OAuth, no Google app review), finds new bank-alert emails, and
// runs each through the exact same parser as the SMS path.
//
//   bank alert email -> IMAP fetch -> parse subject+body -> ingestBankText -> HQ
//
// Idempotent on the email Message-ID, so re-polling never double-writes. A
// cursor in platform_settings ('finance_email_cursor') marks how far we have
// read, so each poll only looks at new mail.
//
// Env:
//   FINANCE_EMAIL_USER     (required)  the mailbox address, e.g. you@gmail.com
//   FINANCE_EMAIL_PASS     (required)  a Gmail APP PASSWORD (needs 2-Step on)
//   FINANCE_EMAIL_HOST     (optional)  default imap.gmail.com
//   FINANCE_EMAIL_PORT     (optional)  default 993 (TLS)
//   FINANCE_EMAIL_SENDERS  (optional)  comma list of alert sender addresses or
//                                      domains to treat as banks. Default covers
//                                      the common US banks; add yours if missing.
//   FINANCE_EMAIL_LOOKBACK_DAYS (optional) default 3
// ============================================================================

'use strict';

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const finance = require('./finance-ingest');
const { getPlatformSetting, setPlatformSetting } = require('./vapi');

const CURSOR_KEY = 'finance_email_cursor';
const OVERLAP_MS = 60 * 60 * 1000; // re-scan the last hour each poll; id-dedup makes it safe

// Default bank alert senders (matched as substrings of the From address, so a
// bare domain covers all of a bank's alert sub-addresses). Override/extend with
// FINANCE_EMAIL_SENDERS.
const DEFAULT_SENDERS = [
  'wellsfargo.com', 'discover.com', 'chase.com', 'capitalone.com', 'bankofamerica.com',
  'americanexpress.com', 'aexp.com', 'usbank.com', 'citibank.com', 'citi.com',
  'alliant', 'ally.com', 'navyfederal.org', 'pnc.com', 'truist.com',
].map((s) => s.toLowerCase());

function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCharCode(Number(n)); } catch (e) { return ' '; } })
    .replace(/\s+/g, ' ')
    .trim();
}

function msgIdToTxnId(messageId, uid) {
  const base = messageId || ('uid' + uid);
  return 'txne_' + String(base).replace(/[^a-zA-Z0-9]/g, '').slice(0, 48);
}

async function readCursor() {
  try {
    const v = await getPlatformSetting(CURSOR_KEY);
    const n = Number(v && v.ts != null ? v.ts : v);
    return isFinite(n) && n > 0 ? n : 0;
  } catch (e) { return 0; }
}

// Poll the inbox once and ingest any new bank-alert emails.
async function pollAndIngest() {
  const user = process.env.FINANCE_EMAIL_USER;
  const pass = process.env.FINANCE_EMAIL_PASS;
  if (!user || !pass) return { ok: false, error: 'FINANCE_EMAIL_USER / FINANCE_EMAIL_PASS not set' };

  const host = process.env.FINANCE_EMAIL_HOST || 'imap.gmail.com';
  const port = Number(process.env.FINANCE_EMAIL_PORT || 993);
  const lookbackDays = Number(process.env.FINANCE_EMAIL_LOOKBACK_DAYS || 3);
  const senders = (process.env.FINANCE_EMAIL_SENDERS
    ? process.env.FINANCE_EMAIL_SENDERS.split(',')
    : DEFAULT_SENDERS).map((s) => String(s).trim().toLowerCase()).filter(Boolean);

  const cursor = await readCursor();
  const windowStart = Math.max(cursor - OVERLAP_MS, Date.now() - lookbackDays * 864e5);
  const sinceDate = new Date(windowStart);

  const client = new ImapFlow({ host, port, secure: true, auth: { user, pass }, logger: false });
  let scanned = 0, matched = 0, written = 0, skipped = 0, newest = cursor;

  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ since: sinceDate }, { uid: true });
      if (uids && uids.length) {
        for await (const msg of client.fetch(uids, { uid: true, envelope: true, internalDate: true, source: true }, { uid: true })) {
          scanned++;
          const internalMs = msg.internalDate ? new Date(msg.internalDate).getTime() : Date.now();
          if (internalMs > newest) newest = internalMs;
          if (internalMs <= cursor) continue; // already processed in a prior poll

          const fromAddr = (msg.envelope && msg.envelope.from && msg.envelope.from[0] && msg.envelope.from[0].address || '').toLowerCase();
          if (senders.length && !senders.some((s) => fromAddr.includes(s))) continue; // not a configured bank sender

          matched++;
          let parsedMail;
          try { parsedMail = await simpleParser(msg.source); } catch (e) { continue; }
          const subject = parsedMail.subject || '';
          const body = parsedMail.text || (parsedMail.html ? htmlToText(parsedMail.html) : '');
          const text = (subject + '\n' + body).trim().slice(0, 2500);
          const id = msgIdToTxnId(parsedMail.messageId, msg.uid);

          const r = await finance.ingestBankText({ text, sender: fromAddr, id, source: 'email' });
          if (r && r.ok && r.txn) written++; else skipped++;
        }
      }
    } finally { lock.release(); }
  } finally {
    try { await client.logout(); } catch (e) { /* ignore */ }
  }

  if (newest > cursor) {
    try { await setPlatformSetting(CURSOR_KEY, String(newest)); } catch (e) { /* non-fatal */ }
  }
  console.log(`📧 finance email poll: scanned ${scanned}, bank ${matched}, written ${written}, skipped ${skipped}`);
  return { ok: true, scanned, matched, written, skipped, cursor: newest };
}

module.exports = { pollAndIngest };

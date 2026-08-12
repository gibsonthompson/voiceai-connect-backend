// ============================================================================
// REPORT EMAIL SENDER (Brevo)
// Location: src/lib/report-email.js
// Created: 2026-08-04
// Migrated 2026-08-12: Resend -> Brevo. This was the LAST Resend reference on
// the platform; with it gone, VoiceAI Connect sends all email through Brevo.
// ----------------------------------------------------------------------------
// Thin, dependency-free email sender built on Brevo's transactional REST API
// (api.brevo.com/v3/smtp/email), the same provider notifications.js uses. It is
// fully OPTIONAL: if BREVO_API_KEY is not set it no-ops and returns
// { sent:false, skipped }, so nothing that calls it breaks. It ALSO no-ops
// until REPORT_EMAIL_FROM is set, so the monthly usage report stays dark until
// you point it at an authenticated sender. To turn it on, set:
//   BREVO_API_KEY       your Brevo API key (already set; notifications.js uses it)
//   REPORT_EMAIL_FROM   a from-address on the Brevo-authenticated domain, e.g.
//                       "VoiceAI Connect <notifications@myvoiceaiconnect.com>"
//                       or a bare "reports@myvoiceaiconnect.com". Brevo rewrites
//                       or fails unauthenticated senders, so the domain (DKIM)
//                       must be authenticated in Brevo first.
//
// Uses global fetch (Node 18+), the same egress path the rest of the backend
// uses, plus a hard timeout so a stalled connection fails fast. The signature
// and return contract are unchanged from the Resend version
// ({ sent, skipped, error, id }), so usage-reporter.js needs no changes.
// ============================================================================

// Parse a "Name <email>" (or bare "email") from-string into Brevo's sender
// object shape. Kept local so this file stays dependency-free.
function parseSender(fromString) {
  const match = String(fromString).match(/^(.+?)\s*<(.+?)>$/);
  if (match) return { name: match[1].trim(), email: match[2].trim() };
  return { email: String(fromString).trim() };
}

async function sendReportEmail({ to, subject, html, replyTo }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) return { sent: false, skipped: 'no_email_provider' };
  if (!to) return { sent: false, skipped: 'no_recipient' };

  const from = process.env.REPORT_EMAIL_FROM;
  if (!from) return { sent: false, skipped: 'no_from_address' };

  const recipients = (Array.isArray(to) ? to : [to]).map((email) => ({ email }));

  const payload = {
    sender: parseSender(from),
    to: recipients,
    subject: subject || 'Usage statement',
    htmlContent: html || '',
  };
  if (replyTo) payload.replyTo = parseSender(replyTo);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return { sent: false, error: `Brevo ${resp.status}: ${body.slice(0, 200)}` };
    }

    const data = await resp.json().catch(() => ({}));
    return { sent: true, id: data.messageId || null };
  } catch (err) {
    if (err.name === 'AbortError') return { sent: false, error: 'email send timed out' };
    return { sent: false, error: err.message };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { sendReportEmail };
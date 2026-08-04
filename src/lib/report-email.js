// ============================================================================
// REPORT EMAIL SENDER (Resend)
// Location: src/lib/report-email.js
// Created: 2026-08-04
// ----------------------------------------------------------------------------
// Thin, dependency-free email sender built on Resend's REST API (free tier:
// generous monthly volume, simple HTTP, no SDK). It is fully OPTIONAL: if
// RESEND_API_KEY is not set it no-ops and returns { sent:false, skipped }, so
// nothing that calls it breaks while email is unwired. Wire it later by adding:
//   RESEND_API_KEY      your Resend key
//   REPORT_EMAIL_FROM   a from-address on a Resend-VERIFIED domain
//                       (e.g. reports@yourdomain.com). Resend rejects sends
//                       from unverified domains, so this must be verified first.
//
// Uses global fetch (Node 18+), the same egress path the rest of the backend
// uses, plus a hard timeout so a stalled connection fails fast.
// ============================================================================

async function sendReportEmail({ to, subject, html, replyTo }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { sent: false, skipped: 'no_email_provider' };
  if (!to) return { sent: false, skipped: 'no_recipient' };

  const from = process.env.REPORT_EMAIL_FROM;
  if (!from) return { sent: false, skipped: 'no_from_address' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: Array.isArray(to) ? to : [to],
        subject: subject || 'Usage statement',
        html: html || '',
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return { sent: false, error: `Resend ${resp.status}: ${body.slice(0, 200)}` };
    }

    const data = await resp.json().catch(() => ({}));
    return { sent: true, id: data.id || null };
  } catch (err) {
    if (err.name === 'AbortError') return { sent: false, error: 'email send timed out' };
    return { sent: false, error: err.message };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { sendReportEmail };
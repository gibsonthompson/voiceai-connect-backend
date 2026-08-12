// ============================================================================
// SHARED BRANDED EMAIL LAYOUT - VoiceAI Connect (PLATFORM to AGENCY only)
// Location: src/lib/email-layout.js
// ----------------------------------------------------------------------------
// One place that renders the VoiceAI Connect brand wrapper (dark header with the
// real logo, light body, footer) so every platform-to-agency email looks the
// same and on-brand. Used by the agency password-reset email and the agency
// welcome email, and is the intended home for the four Stripe billing emails
// when those get rebuilt.
//
// DO NOT use this for client-facing email. Clients must be agency-branded
// (white-label); a VoiceAI-branded email to a client leaks the platform brand.
// Client touchpoints are agency-branded SMS.
//
// Dependency-free (string builder only). Table-based, inline styles, so it
// renders consistently across Gmail / Outlook / Apple Mail.
// ============================================================================

const BRAND_NAME = 'VoiceAI Connect';
const LOGO_URL = 'https://www.myvoiceaiconnect.com/icon-512x512.png';
const SUPPORT_EMAIL = 'support@myvoiceaiconnect.com';
const MARKETING_URL = 'https://myvoiceaiconnect.com';

// renderBrandedEmail({ preheader, heading, bodyHtml, cta })
//   preheader : short hidden inbox-preview text. optional.
//   heading   : plain text H1 at the top of the body. required.
//   bodyHtml  : trusted HTML the caller builds for the message body. required.
//   cta       : { label, url } optional primary button (near-black, on brand).
function renderBrandedEmail({ preheader = '', heading = '', bodyHtml = '', cta = null } = {}) {
  const ctaBlock = (cta && cta.url && cta.label)
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 4px;">
         <tr><td style="border-radius:8px;background:#0b0b0c;">
           <a href="${cta.url}" style="display:inline-block;padding:14px 30px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">${cta.label}</a>
         </td></tr>
       </table>`
    : '';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"></head>
<body style="margin:0;padding:0;background:#eef2f7;">
<span style="display:none!important;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden;mso-hide:all;">${preheader}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f7;">
  <tr><td align="center" style="padding:28px 12px 44px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e2e8f0;">
      <tr><td style="background:#0b0b0c;padding:22px 28px;">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td style="vertical-align:middle;"><span style="display:inline-block;width:34px;height:34px;background:#ffffff;border-radius:8px;text-align:center;line-height:34px;"><img src="${LOGO_URL}" width="24" height="24" alt="${BRAND_NAME}" style="width:24px;height:24px;vertical-align:middle;border:0;"></span></td>
          <td style="vertical-align:middle;padding-left:12px;font-family:Arial,Helvetica,sans-serif;font-size:17px;font-weight:700;color:#ffffff;letter-spacing:.2px;">${BRAND_NAME}</td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:34px 32px 8px;font-family:Arial,Helvetica,sans-serif;">
        <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#0f172a;">${heading}</h1>
        <div style="font-size:15px;line-height:1.6;color:#334155;">${bodyHtml}</div>
        ${ctaBlock}
      </td></tr>
      <tr><td style="padding:24px 32px 32px;"><hr style="border:none;border-top:1px solid #eef2f7;margin:0 0 18px;">
        <p style="margin:0 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.6;color:#64748b;">Need help? Email <a href="mailto:${SUPPORT_EMAIL}" style="color:#0f172a;">${SUPPORT_EMAIL}</a>.</p>
        <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:#94a3b8;">&copy; 2026 ${BRAND_NAME} &middot; <a href="${MARKETING_URL}" style="color:#94a3b8;">myvoiceaiconnect.com</a></p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

module.exports = { renderBrandedEmail, BRAND_NAME, LOGO_URL, SUPPORT_EMAIL, MARKETING_URL };
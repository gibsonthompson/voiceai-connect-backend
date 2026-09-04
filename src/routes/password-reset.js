// ============================================================================
// PASSWORD RESET ROUTES - VoiceAI Connect
// ----------------------------------------------------------------------------
// 6-digit code flow. The verify step (POST /reset-password) is unchanged; only
// the DELIVERY channel of the code differs by user type:
//   - AGENCY users  -> code delivered by EMAIL (branded VoiceAI Connect email).
//                      Email is universal and reaches UK agencies, where the US
//                      Telnyx SMS number does not deliver. Agencies are the
//                      platform's own customer, so platform branding is correct.
//   - CLIENT users  -> code delivered by SMS. A VoiceAI-branded email to a
//                      client would break white-label, so clients stay on SMS.
//                      The send routes through sendAndLogSMS WITH the client's
//                      agency, so a non-US BYOT agency sends from its OWN Twilio
//                      (the raw US Telnyx number does not deliver to UK/
//                      international handsets). US clients fall through to
//                      platform Telnyx inside sendAndLogSMS.
//
// Also closes a silent-lockout hole: previously, a user with no phone on file
// got a fake "code sent" success and nothing was sent. Agencies now always have
// email, so they can always reset.
//
// UPDATED: 2026-08-12 - Agency reset by branded email (email-layout); client
//          reset SMS routed through the agency (BYOT Twilio for non-US).
// Destination: src/routes/password-reset.js (FULL REPLACEMENT)
// ============================================================================
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { supabase, getUsersByEmail } = require('../lib/supabase');
const { sendEmail } = require('../lib/notifications');
const { sendAndLogSMS } = require('../lib/sms-logger');
const { getSmsTemplate } = require('../lib/sms-templates');
const { renderBrandedEmail, BRAND_NAME } = require('../lib/email-layout');

// Random 0.5-1.0s delay so a missing account and a real one take the same time
// (anti user-enumeration).
function antiEnumDelay() {
  return new Promise((r) => setTimeout(r, 500 + Math.random() * 500));
}

function maskEmail(email) {
  const [user, domain] = String(email).split('@');
  if (!domain) return '***';
  const shown = user ? user[0] : '';
  return `${shown}***@${domain}`;
}

// Normalize a phone to comparable digits: strip formatting, drop a US country code.
function phoneDigits(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  return (d.length === 11 && d.startsWith('1')) ? d.slice(1) : d;
}

// Find a client user by the owner phone entered on the client reset page.
// Prefilter by the last 4 digits (contiguous regardless of formatting), then
// exact-match on normalized digits so "(555) 123-4567" and "+15551234567" match.
async function findClientUserByPhone(rawPhone) {
  const digits = phoneDigits(rawPhone);
  if (digits.length < 7) return null;
  const last4 = digits.slice(-4);
  const { data: candidates } = await supabase
    .from('clients')
    .select('id, owner_phone, agency_id')
    .not('owner_phone', 'is', null)
    .ilike('owner_phone', `%${last4}`);
  const client = (candidates || []).find(
    (c) => phoneDigits(c.owner_phone).slice(-10) === digits.slice(-10)
  );
  if (!client) return null;
  const { data: users } = await supabase
    .from('users')
    .select('id, email, client_id, role')
    .eq('client_id', client.id)
    .eq('role', 'client')
    .limit(1);
  const user = users && users[0];
  if (!user) return null;
  return { user, client };
}

// Build the agency password-reset email body (the shared layout wraps it).
function buildResetEmailHtml(code) {
  const bodyHtml =
    `<p style="margin:0 0 18px;">Use this code to reset your ${BRAND_NAME} password. It expires in 15 minutes.</p>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:2px 0 20px;">` +
    `<div style="display:inline-block;padding:16px 24px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;font-family:'Courier New',Courier,monospace;font-size:34px;font-weight:700;letter-spacing:10px;color:#0f172a;">${code}</div>` +
    `</td></tr></table>` +
    `<p style="margin:0;color:#64748b;font-size:13px;line-height:1.6;">If you didn't request this, you can safely ignore this email. Your password will not change until a new one is set with this code.</p>`;

  return renderBrandedEmail({
    preheader: 'Your password reset code (expires in 15 minutes).',
    heading: 'Reset your password',
    bodyHtml,
  });
}

// ============================================================================
// POST /api/auth/forgot-password
// ============================================================================
router.post('/forgot-password', async (req, res) => {
  try {
    const scope = req.body.scope === 'client' ? 'client' : req.body.scope === 'agency' ? 'agency' : null;

    let user = null;
    let userType = 'client';
    let phone = null;
    let clientAgencyId = null;
    let recordEmail = null; // stored on the token row for reference/audit

    if (scope === 'client') {
      // CLIENT: identify by PHONE. The client reset page collects a phone number
      // because the code is texted (white-label). Asking a client for their email
      // and then texting them made no sense.
      const rawPhone = req.body.phone;
      const neutral = () => res.json({
        success: true,
        message: 'If an account exists with this number, a verification code has been sent.',
      });
      if (!rawPhone) return res.status(400).json({ error: 'Phone number is required' });
      const found = await findClientUserByPhone(rawPhone);
      if (!found || !found.client.owner_phone) {
        await antiEnumDelay();
        return neutral();
      }
      user = found.user;
      userType = 'client';
      phone = found.client.owner_phone;
      clientAgencyId = found.client.agency_id || null;
      recordEmail = found.user.email || null;
    } else {
      // AGENCY (or unscoped): identify by EMAIL; the code is emailed.
      const { email } = req.body;
      const neutral = () => res.json({
        success: true,
        message: 'If an account exists with this email, a verification code has been sent.',
      });
      if (!email) return res.status(400).json({ error: 'Email is required' });
      const normalizedEmail = email.toLowerCase().trim();
      recordEmail = normalizedEmail;
      // Scope-safe: an email may have BOTH an agency and a client account. Never
      // .single() here, that throws on a shared email.
      const _candidates = await getUsersByEmail(normalizedEmail);
      user = scope === 'agency'
        ? (_candidates.find((u) => ['agency_owner', 'agency_staff', 'super_admin'].includes(u.role)) || null)
        : (_candidates[0] || null);
      if (!user) {
        await antiEnumDelay();
        return neutral();
      }
      if (user.agency_id && ['agency_owner', 'agency_staff', 'super_admin'].includes(user.role)) {
        userType = 'agency';
      } else if (user.client_id && user.role === 'client') {
        // Legacy: an email-scoped request that resolves to a client still texts
        // the client's owner_phone (white-label).
        userType = 'client';
        const { data: client } = await supabase
          .from('clients').select('owner_phone, agency_id').eq('id', user.client_id).single();
        phone = client?.owner_phone;
        clientAgencyId = client?.agency_id || null;
        if (!phone) { await antiEnumDelay(); return neutral(); }
      } else {
        userType = 'client';
        if (!phone) { await antiEnumDelay(); return neutral(); }
      }
    }

    // Generate + store the code (hashed) alongside the reset token.
    const code = crypto.randomInt(100000, 999999).toString();
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    const resetToken = crypto.randomBytes(32).toString('hex');

    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + 15);

    // Invalidate existing unused tokens, then insert the new one.
    await supabase
      .from('password_reset_tokens')
      .update({ used: true })
      .eq('user_id', user.id)
      .eq('used', false);

    const { error: insertError } = await supabase
      .from('password_reset_tokens')
      .insert({
        user_id: user.id,
        email: recordEmail,
        token: resetToken,
        expires_at: expiresAt.toISOString(),
        used: false,
      });

    if (insertError) {
      console.error('❌ Failed to store reset token:', insertError);
      return res.status(500).json({ error: 'Failed to process request' });
    }

    await supabase
      .from('password_reset_tokens')
      .update({ token: `${resetToken}|${codeHash}` })
      .eq('token', resetToken)
      .eq('user_id', user.id);

    // ---- AGENCY: deliver the code by branded email --------------------------
    if (userType === 'agency') {
      const emailResult = await sendEmail({
        from: `${BRAND_NAME} <support@myvoiceaiconnect.com>`,
        to: recordEmail,
        subject: 'Your VoiceAI Connect password reset code',
        html: buildResetEmailHtml(code),
      });

      if (!emailResult || emailResult.success !== true) {
        console.error('❌ Failed to send reset email to:', recordEmail);
        await supabase
          .from('password_reset_tokens')
          .update({ used: true })
          .eq('user_id', user.id)
          .eq('used', false);
        return res.status(500).json({ error: 'Failed to send verification code. Please try again.' });
      }

      console.log(`✅ Password reset code emailed to ${maskEmail(recordEmail)}`);
      return res.json({
        success: true,
        message: 'Verification code sent to your email',
        maskedEmail: maskEmail(recordEmail),
        resetToken,
        userType,
      });
    }

    // ---- CLIENT: deliver the code by SMS (white-label safe) ------------------
    // Route through sendAndLogSMS WITH the client's agency, so a non-US BYOT
    // agency sends the code from its OWN Twilio. US clients fall through to
    // platform Telnyx inside sendAndLogSMS.
    const templateMsg = await getSmsTemplate('password_reset_code', { code });
    const smsMessage = templateMsg || `Your verification code is: ${code}\n\nThis code expires in 15 minutes. Do not share it with anyone.`;

    let smsSent = false;
    try {
      smsSent = (await sendAndLogSMS({
        phone,
        message: smsMessage,
        agencyId: clientAgencyId,
        recipientType: 'client_owner',
        messageType: 'client_password_reset',
        metadata: { clientId: user.client_id },
      })) === true;
    } catch (e) {
      console.error('❌ Client reset SMS send threw:', e.message);
      smsSent = false;
    }

    if (!smsSent) {
      console.error('❌ Failed to send SMS to:', phone);
      await supabase
        .from('password_reset_tokens')
        .update({ used: true })
        .eq('user_id', user.id)
        .eq('used', false);
      return res.status(500).json({ error: 'Failed to send verification code. Please try again.' });
    }

    const lastFour = phone.replace(/\D/g, '').slice(-4);
    const masked = `(***) ***-${lastFour}`;
    console.log(`✅ Password reset code SMS sent to ${masked}`);

    return res.json({
      success: true,
      message: 'Verification code sent',
      maskedPhone: masked,
      resetToken,
      userType,
    });
  } catch (error) {
    console.error('❌ Forgot password error:', error);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// ============================================================================
// POST /api/auth/reset-password  (unchanged)
// ============================================================================
router.post('/reset-password', async (req, res) => {
  try {
    const { code, password, resetToken } = req.body;

    if (!code || !password || !resetToken) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const codeHash = crypto.createHash('sha256').update(String(code).trim()).digest('hex');

    // Look up the request by its reset token (unique per request) rather than the
    // identifier, so this serves both the agency (email) and client (phone) flows
    // without knowing which was used. token column = `${resetToken}|${codeHash}`.
    const { data: tokenRecord, error: tokenError } = await supabase
      .from('password_reset_tokens')
      .select('*')
      .like('token', `${resetToken}|%`)
      .eq('used', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (tokenError || !tokenRecord) {
      return res.status(400).json({ error: 'Invalid or expired reset request. Please try again.' });
    }

    if (new Date(tokenRecord.expires_at) < new Date()) {
      await supabase.from('password_reset_tokens').update({ used: true }).eq('id', tokenRecord.id);
      return res.status(400).json({ error: 'Verification code has expired. Please request a new one.' });
    }

    const [storedResetToken, storedCodeHash] = (tokenRecord.token || '').split('|');

    if (storedResetToken !== resetToken) {
      return res.status(400).json({ error: 'Invalid reset request. Please try again.' });
    }

    if (storedCodeHash !== codeHash) {
      return res.status(400).json({ error: 'Incorrect verification code. Please try again.' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const { error: updateError } = await supabase
      .from('users')
      .update({ password_hash: passwordHash })
      .eq('id', tokenRecord.user_id);

    if (updateError) {
      console.error('❌ Password update error:', updateError);
      return res.status(500).json({ error: 'Failed to update password' });
    }

    await supabase.from('password_reset_tokens').update({ used: true }).eq('id', tokenRecord.id);

    console.log(`✅ Password reset successful for user: ${tokenRecord.user_id}`);

    res.json({
      success: true,
      message: 'Password has been reset successfully. You can now sign in.',
    });
  } catch (error) {
    console.error('❌ Reset password error:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

module.exports = router;
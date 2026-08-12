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
const { supabase, getUserByEmail } = require('../lib/supabase');
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
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const user = await getUserByEmail(normalizedEmail);

    // Neutral response used whenever we will not (or cannot) send, so the caller
    // cannot tell whether the account exists.
    const neutral = () => res.json({
      success: true,
      message: 'If an account exists with this email, a verification code has been sent.',
    });

    if (!user) {
      await antiEnumDelay();
      return neutral();
    }

    // Resolve the delivery channel by user type.
    let userType = 'client';
    let phone = null;
    let clientAgencyId = null;

    if (user.agency_id && ['agency_owner', 'agency_staff', 'super_admin'].includes(user.role)) {
      userType = 'agency';
      // Agency reset goes to EMAIL. No phone needed.
    } else if (user.client_id && user.role === 'client') {
      userType = 'client';
      const { data: client } = await supabase
        .from('clients').select('owner_phone, agency_id').eq('id', user.client_id).single();
      phone = client?.owner_phone;
      clientAgencyId = client?.agency_id || null;
    } else {
      // Unknown role shape. Treat as client and require a phone.
      userType = 'client';
    }

    // Clients still reset by SMS (white-label). No phone -> neutral, no send.
    if (userType === 'client' && !phone) {
      console.log(`⚠️ No phone on file for client reset: ${normalizedEmail} (role: ${user.role})`);
      await antiEnumDelay();
      return neutral();
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
        email: normalizedEmail,
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
        to: normalizedEmail,
        subject: 'Your VoiceAI Connect password reset code',
        html: buildResetEmailHtml(code),
      });

      if (!emailResult || emailResult.success !== true) {
        console.error('❌ Failed to send reset email to:', normalizedEmail);
        await supabase
          .from('password_reset_tokens')
          .update({ used: true })
          .eq('user_id', user.id)
          .eq('used', false);
        return res.status(500).json({ error: 'Failed to send verification code. Please try again.' });
      }

      console.log(`✅ Password reset code emailed to ${maskEmail(normalizedEmail)}`);
      return res.json({
        success: true,
        message: 'Verification code sent to your email',
        maskedEmail: maskEmail(normalizedEmail),
        resetToken,
        userType,
      });
    }

    // ---- CLIENT: deliver the code by SMS (white-label safe) ------------------
    // Route through sendAndLogSMS WITH the client's agency, so a non-US BYOT
    // agency sends the code from its OWN Twilio. The raw US Telnyx number does
    // not deliver to UK/international handsets, which locked out those clients.
    // US clients still fall through to platform Telnyx inside sendAndLogSMS.
    const templateMsg = await getSmsTemplate('password_reset_code', { code });
    const smsMessage = templateMsg || `Your verification code is: ${code}\n\nThis code expires in 15 minutes. Do not share it with anyone.`;

    // sendAndLogSMS returns a boolean (true = sent), handles its own errors, and
    // logs every attempt to sms_log. It routes to the agency's own Twilio for a
    // non-US BYOT agency and to platform Telnyx otherwise.
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
    console.log(`✅ Password reset code SMS sent to ${masked} for ${normalizedEmail}`);

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
    const { email, code, password, resetToken } = req.body;

    if (!email || !code || !password || !resetToken) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const codeHash = crypto.createHash('sha256').update(code.trim()).digest('hex');

    const { data: tokenRecord, error: tokenError } = await supabase
      .from('password_reset_tokens')
      .select('*')
      .eq('email', normalizedEmail)
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

    console.log(`✅ Password reset successful for: ${normalizedEmail}`);

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
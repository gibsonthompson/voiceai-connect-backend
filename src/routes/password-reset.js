// ============================================================================
// PASSWORD RESET ROUTES - VoiceAI Connect
// SMS-based 6-digit code flow (no email dependency)
// UPDATED: Verification code SMS wired to getSmsTemplate()
// ============================================================================
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { supabase, getUserByEmail } = require('../lib/supabase');
const { sendTelnyxSMS, formatPhoneDisplay } = require('../lib/notifications');
const { getSmsTemplate } = require('../lib/sms-templates');

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

    if (!user) {
      await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
      return res.json({
        success: true,
        message: 'If an account exists with this email, a verification code has been sent.',
      });
    }

    let phone = null;
    let userType = 'client';

    if (user.agency_id && ['agency_owner', 'agency_staff', 'super_admin'].includes(user.role)) {
      userType = 'agency';
      const { data: agency } = await supabase
        .from('agencies').select('phone').eq('id', user.agency_id).single();
      phone = agency?.phone;
    } else if (user.client_id && user.role === 'client') {
      userType = 'client';
      const { data: client } = await supabase
        .from('clients').select('owner_phone').eq('id', user.client_id).single();
      phone = client?.owner_phone;
    }

    if (!phone) {
      console.log(`⚠️ No phone number found for user: ${normalizedEmail} (role: ${user.role})`);
      await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
      return res.json({
        success: true,
        message: 'If an account exists with this email, a verification code has been sent.',
      });
    }

    // Generate 6-digit code
    const code = crypto.randomInt(100000, 999999).toString();
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    const resetToken = crypto.randomBytes(32).toString('hex');

    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + 15);

    // Invalidate existing unused tokens
    await supabase
      .from('password_reset_tokens')
      .update({ used: true })
      .eq('user_id', user.id)
      .eq('used', false);

    // Store the code (hashed) and reset token
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

    // Store code hash alongside reset token
    await supabase
      .from('password_reset_tokens')
      .update({ token: `${resetToken}|${codeHash}` })
      .eq('token', resetToken)
      .eq('user_id', user.id);

    // Send SMS (TEMPLATE WIRED)
    const templateMsg = await getSmsTemplate('password_reset_code', { code });
    const smsMessage = templateMsg || `Your verification code is: ${code}\n\nThis code expires in 15 minutes. Do not share it with anyone.`;
    const smsSent = await sendTelnyxSMS(phone, smsMessage);

    if (!smsSent) {
      console.error('❌ Failed to send SMS to:', phone);
      await supabase
        .from('password_reset_tokens')
        .update({ used: true })
        .eq('user_id', user.id)
        .eq('used', false);

      return res.status(500).json({ error: 'Failed to send verification code. Please try again.' });
    }

    const phoneDigits = phone.replace(/\D/g, '');
    const lastFour = phoneDigits.slice(-4);
    const masked = `(***) ***-${lastFour}`;

    console.log(`✅ Password reset code sent to ${masked} for ${normalizedEmail}`);

    res.json({
      success: true,
      message: 'Verification code sent',
      maskedPhone: masked,
      resetToken: resetToken,
      userType: userType,
    });
  } catch (error) {
    console.error('❌ Forgot password error:', error);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// ============================================================================
// POST /api/auth/reset-password
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
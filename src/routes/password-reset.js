// ============================================================================
// PASSWORD RESET ROUTES - VoiceAI Connect
// SMS-based 6-digit code flow (no email dependency)
// ============================================================================
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { supabase, getUserByEmail } = require('../lib/supabase');
const { sendTelnyxSMS, formatPhoneDisplay } = require('../lib/notifications');

// ============================================================================
// POST /api/auth/forgot-password
// Looks up user by email → finds their phone → sends 6-digit SMS code
// ============================================================================
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Find user in users table
    const user = await getUserByEmail(normalizedEmail);

    if (!user) {
      // Don't reveal whether account exists — but still return success shape
      // Add a small delay to prevent timing attacks
      await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
      return res.json({
        success: true,
        message: 'If an account exists with this email, a verification code has been sent.',
      });
    }

    // Determine phone number based on user role
    let phone = null;
    let userType = 'client';

    if (user.agency_id && ['agency_owner', 'agency_staff', 'super_admin'].includes(user.role)) {
      // Agency user — get phone from agencies table
      userType = 'agency';
      const { data: agency } = await supabase
        .from('agencies')
        .select('phone')
        .eq('id', user.agency_id)
        .single();

      phone = agency?.phone;
    } else if (user.client_id && user.role === 'client') {
      // Client user — get phone from clients table
      userType = 'client';
      const { data: client } = await supabase
        .from('clients')
        .select('owner_phone')
        .eq('id', user.client_id)
        .single();

      phone = client?.owner_phone;
    }

    if (!phone) {
      console.log(`⚠️ No phone number found for user: ${normalizedEmail} (role: ${user.role})`);
      // Same response as "no account" to prevent enumeration
      await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
      return res.json({
        success: true,
        message: 'If an account exists with this email, a verification code has been sent.',
      });
    }

    // Generate 6-digit code
    const code = crypto.randomInt(100000, 999999).toString();
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');

    // Generate a reset token for the verification step
    const resetToken = crypto.randomBytes(32).toString('hex');

    // Expires in 15 minutes
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + 15);

    // Invalidate any existing unused tokens for this user
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

    // Store the code hash in a separate column or use a convention
    // We'll store code_hash as a prefixed token: "sms:HASH" 
    // Actually, let's update the row we just created with the code hash
    // We'll use a simple approach: store code hash in a metadata pattern
    // Since password_reset_tokens doesn't have a code column, we'll store it differently:
    // token = resetToken, and we'll create a second entry for the code verification
    // 
    // Simpler approach: store the hashed code as part of the token field
    // Format: "resetToken|codeHash"
    await supabase
      .from('password_reset_tokens')
      .update({ token: `${resetToken}|${codeHash}` })
      .eq('token', resetToken)
      .eq('user_id', user.id);

    // Send SMS
    const smsMessage = `Your verification code is: ${code}\n\nThis code expires in 15 minutes. Do not share it with anyone.`;
    const smsSent = await sendTelnyxSMS(phone, smsMessage);

    if (!smsSent) {
      console.error('❌ Failed to send SMS to:', phone);
      // Clean up the token since SMS failed
      await supabase
        .from('password_reset_tokens')
        .update({ used: true })
        .eq('user_id', user.id)
        .eq('used', false);

      return res.status(500).json({ error: 'Failed to send verification code. Please try again.' });
    }

    // Mask phone for frontend display (e.g., "***-***-1234")
    const phoneDigits = phone.replace(/\D/g, '');
    const lastFour = phoneDigits.slice(-4);
    const masked = `(***) ***-${lastFour}`;

    console.log(`✅ Password reset code sent to ${masked} for ${normalizedEmail}`);

    res.json({
      success: true,
      message: 'Verification code sent',
      maskedPhone: masked,
      resetToken: resetToken, // Frontend needs this to submit the reset
      userType: userType,
    });
  } catch (error) {
    console.error('❌ Forgot password error:', error);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// ============================================================================
// POST /api/auth/reset-password
// Verifies 6-digit code + resets password
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

    // Find the token record
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

    // Check expiry
    if (new Date(tokenRecord.expires_at) < new Date()) {
      // Mark as used
      await supabase
        .from('password_reset_tokens')
        .update({ used: true })
        .eq('id', tokenRecord.id);

      return res.status(400).json({ error: 'Verification code has expired. Please request a new one.' });
    }

    // Verify the token and code
    // Token format: "resetToken|codeHash"
    const [storedResetToken, storedCodeHash] = (tokenRecord.token || '').split('|');

    if (storedResetToken !== resetToken) {
      return res.status(400).json({ error: 'Invalid reset request. Please try again.' });
    }

    if (storedCodeHash !== codeHash) {
      return res.status(400).json({ error: 'Incorrect verification code. Please try again.' });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Update user password
    const { error: updateError } = await supabase
      .from('users')
      .update({ password_hash: passwordHash })
      .eq('id', tokenRecord.user_id);

    if (updateError) {
      console.error('❌ Password update error:', updateError);
      return res.status(500).json({ error: 'Failed to update password' });
    }

    // Mark token as used
    await supabase
      .from('password_reset_tokens')
      .update({ used: true })
      .eq('id', tokenRecord.id);

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
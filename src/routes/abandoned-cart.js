// ============================================================================
// ABANDONED CART SMS - Cron Handler
// Sends up to 5 nudge SMS to agencies who signed up but never subscribed.
// UPDATED: Uses getSmsTemplate() for editable messages + password-aware recovery links
// ============================================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { sendTelnyxSMS, formatPhoneE164 } = require('../lib/notifications');
const { createPasswordToken } = require('./agency-signup');
const { getSmsTemplate } = require('../lib/sms-templates');

// ============================================================================
// TIMING THRESHOLDS (minutes after signup)
// ============================================================================
const STEP_THRESHOLDS = { 1: 30, 2: 60, 3: 1440, 4: 4320, 5: 10080 };

// ============================================================================
// GET RECOVERY LINK — set-password for passwordless, login for password-set
// ============================================================================
async function getRecoveryLink(agency) {
  const platformUrl = 'https://myvoiceaiconnect.com';
  const loginUrl = `${platformUrl}/agency/login`;

  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, password_hash')
      .eq('agency_id', agency.id)
      .eq('role', 'agency_owner')
      .single();

    if (error || !user) {
      console.log(`⚠️ No owner user found for agency ${agency.name} — using login link`);
      return loginUrl;
    }

    if (user.password_hash) return loginUrl;

    const token = await createPasswordToken(user.id, user.email);
    const returnTo = encodeURIComponent(`/onboarding?agency=${agency.id}`);
    console.log(`🔑 Generated fresh set-password token for ${agency.name} (no password set)`);
    return `${platformUrl}/auth/set-password?token=${token}&returnTo=${returnTo}`;
  } catch (err) {
    console.error(`⚠️ Error checking password for ${agency.name}:`, err.message);
    return loginUrl;
  }
}

// ============================================================================
// HARDCODED FALLBACKS (used only if DB template is missing)
// ============================================================================
function getFallbackMessage(step, name, recoveryLink) {
  switch (step) {
    case 1: return `Hey ${name}! 👋\n\nLooks like you didn't finish setting up your VoiceAI Connect account. Your white-label AI receptionist platform is waiting for you.\n\nPick up where you left off:\n${recoveryLink}\n\nTakes less than 5 minutes to finish!`;
    case 2: return `Hi ${name},\n\nJust a quick reminder — your VoiceAI Connect setup is almost done.\n\nHere's what you're about to unlock:\n✅ Your own branded AI receptionist platform\n✅ Resell to unlimited businesses\n✅ Clients pay YOU directly via Stripe\n✅ 14-day free trial, no risk\n\nFinish setup: ${recoveryLink}`;
    case 3: return `Hey ${name},\n\nAgencies on VoiceAI Connect are already signing up clients and earning recurring revenue.\n\nEvery day without your AI receptionist platform is missed revenue from businesses that need 24/7 phone coverage.\n\nYour 14-day free trial is ready:\n${recoveryLink}\n\nNo credit card needed to start.`;
    case 4: return `${name}, quick question — was there something holding you back from finishing your VoiceAI Connect setup?\n\nIf you ran into any issues, reply to this text and we'll help you get set up personally.\n\nYour account is still waiting:\n${recoveryLink}`;
    case 5: return `Hi ${name},\n\nThis is our last reminder about your VoiceAI Connect account.\n\nIf now isn't the right time, no worries at all. Your account will be here whenever you're ready.\n\nWhen you're ready to launch your AI receptionist agency:\n${recoveryLink}\n\nWe're here if you have any questions. 🙏`;
    default: return null;
  }
}

// ============================================================================
// DETERMINE NEXT STEP
// ============================================================================
function getNextStep(agency) {
  const currentStep = agency.abandoned_cart_step || 0;
  const nextStep = currentStep + 1;
  if (nextStep > 5) return null;
  const signupTime = new Date(agency.created_at).getTime();
  const minutesSinceSignup = (Date.now() - signupTime) / (1000 * 60);
  if (minutesSinceSignup < STEP_THRESHOLDS[nextStep]) return null;
  if (agency.abandoned_cart_last_sent_at) {
    const minutesSinceLastSent = (Date.now() - new Date(agency.abandoned_cart_last_sent_at).getTime()) / (1000 * 60);
    if (minutesSinceLastSent < 15) return null;
  }
  return nextStep;
}

// ============================================================================
// CRON ENDPOINT — POST /api/cron/abandoned-cart
// ============================================================================
router.post('/abandoned-cart', async (req, res) => {
  const cronSecret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('🛒 Running abandoned cart SMS check...');

    const { data: agencies, error } = await supabase
      .from('agencies')
      .select('id, name, email, phone, created_at, abandoned_cart_step, abandoned_cart_last_sent_at')
      .eq('subscription_status', 'pending')
      .lt('abandoned_cart_step', 5)
      .not('phone', 'is', null)
      .order('created_at', { ascending: true });

    if (error) { console.error('❌ Abandoned cart query error:', error); return res.status(500).json({ error: 'Database query failed' }); }
    if (!agencies || agencies.length === 0) { console.log('✅ No abandoned carts to process'); return res.json({ success: true, processed: 0, sent: 0 }); }

    console.log(`📋 Found ${agencies.length} pending agencies to check`);
    let sent = 0, skipped = 0;
    const results = [];

    for (const agency of agencies) {
      const nextStep = getNextStep(agency);
      if (!nextStep) { skipped++; continue; }

      const formattedPhone = formatPhoneE164(agency.phone);
      if (!formattedPhone) { console.log(`⚠️ Invalid phone for ${agency.name}: ${agency.phone}`); skipped++; continue; }

      const recoveryLink = await getRecoveryLink(agency);
      const name = agency.name || 'there';

      // Try DB template first, fall back to hardcoded
      const templateMsg = await getSmsTemplate(`abandoned_cart_${nextStep}`, { name, recovery_link: recoveryLink });
      const message = templateMsg || getFallbackMessage(nextStep, name, recoveryLink);
      if (!message) { skipped++; continue; }

      console.log(`📱 Sending abandoned cart step ${nextStep} to ${agency.name} (${formattedPhone})`);
      const smsSent = await sendTelnyxSMS(formattedPhone, message);

      if (smsSent) {
        await supabase.from('agencies').update({ abandoned_cart_step: nextStep, abandoned_cart_last_sent_at: new Date().toISOString() }).eq('id', agency.id);
        sent++;
        results.push({ agency: agency.name, step: nextStep, phone: formattedPhone, status: 'sent', linkType: recoveryLink.includes('set-password') ? 'set-password' : 'login' });
        console.log(`✅ Step ${nextStep} sent to ${agency.name}`);
      } else {
        results.push({ agency: agency.name, step: nextStep, phone: formattedPhone, status: 'failed' });
        console.log(`❌ Failed to send step ${nextStep} to ${agency.name}`);
      }
    }

    console.log(`🛒 Abandoned cart complete: ${sent} sent, ${skipped} skipped out of ${agencies.length}`);
    res.json({ success: true, processed: agencies.length, sent, skipped, results });
  } catch (error) {
    console.error('❌ Abandoned cart cron error:', error);
    res.status(500).json({ error: 'Cron job failed', message: error.message });
  }
});

// ============================================================================
// TEST ENDPOINT — POST /api/cron/abandoned-cart/test/:agencyId
// ============================================================================
router.post('/abandoned-cart/test/:agencyId', async (req, res) => {
  const cronSecret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { agencyId } = req.params;
    const { step } = req.body;
    const { data: agency, error } = await supabase.from('agencies').select('*').eq('id', agencyId).single();
    if (error || !agency) return res.status(404).json({ error: 'Agency not found' });

    const targetStep = step || (agency.abandoned_cart_step || 0) + 1;
    if (targetStep > 5) return res.json({ success: false, message: 'All 5 messages already sent' });

    const formattedPhone = formatPhoneE164(agency.phone);
    if (!formattedPhone) return res.json({ success: false, message: `Invalid phone: ${agency.phone}` });

    const recoveryLink = await getRecoveryLink(agency);
    const name = agency.name || 'there';
    const templateMsg = await getSmsTemplate(`abandoned_cart_${targetStep}`, { name, recovery_link: recoveryLink });
    const message = templateMsg || getFallbackMessage(targetStep, name, recoveryLink);

    console.log(`🧪 Test sending step ${targetStep} to ${agency.name}`);
    const smsSent = await sendTelnyxSMS(formattedPhone, message);

    if (smsSent) {
      await supabase.from('agencies').update({ abandoned_cart_step: targetStep, abandoned_cart_last_sent_at: new Date().toISOString() }).eq('id', agencyId);
    }

    res.json({ success: smsSent, agency: agency.name, step: targetStep, phone: formattedPhone, linkType: recoveryLink.includes('set-password') ? 'set-password' : 'login', message: smsSent ? `Step ${targetStep} sent` : 'SMS failed' });
  } catch (error) {
    console.error('❌ Test abandoned cart error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
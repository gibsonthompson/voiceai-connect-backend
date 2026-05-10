// ============================================================================
// ABANDONED CART SMS - Cron Handler
// Sends up to 5 nudge SMS to agencies who signed up but never subscribed.
// UPDATED: 2026-05-09 — Uses sendAndLogSMS for full SMS logging,
//          updated messages to remove old pricing references,
//          "start free" instead of "14-day free trial"
// ============================================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { formatPhoneE164 } = require('../lib/notifications');
const { sendAndLogSMS } = require('../lib/sms-logger');
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
// UPDATED: 2026-05-09 — Removed "white-label", "14-day free trial" references
// ============================================================================
function getFallbackMessage(step, name, recoveryLink) {
  switch (step) {
    case 1:
      return `Hey ${name}! 👋\n\nYou started setting up your AI receptionist agency on VoiceAI Connect — nice.\n\nPick up where you left off, it takes about 2 minutes to finish:\n${recoveryLink}`;
    case 2:
      return `${name}, quick question — what type of businesses are you planning to sell AI receptionists to?\n\nWe ask because agencies targeting home services, medical, and legal are seeing the fastest traction right now.\n\nFinish your setup and start free — no credit card needed:\n${recoveryLink}`;
    case 3:
      return `Hey ${name},\n\nThe average VoiceAI Connect agency charges their clients $149/mo per AI receptionist.\n\n10 clients = $1,490/mo in recurring revenue. And you keep 100% — we never take a cut.\n\nStart free, no credit card needed:\n${recoveryLink}`;
    case 4:
      return `${name}, quick question — was there something holding you back from finishing your VoiceAI Connect setup?\n\nIf you ran into any issues, reply to this text and we'll help you get set up personally.\n\nYour account is still waiting:\n${recoveryLink}`;
    case 5:
      return `Hi ${name},\n\nThis is our last reminder about your VoiceAI Connect account.\n\nIf now isn't the right time, no worries at all. Your account will be here whenever you're ready.\n\nWhen you're ready to launch your AI receptionist agency:\n${recoveryLink}\n\nWe're here if you have any questions. 🙏`;
    default:
      return null;
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

      const smsSent = await sendAndLogSMS({
        phone: agency.phone,
        message,
        agencyId: agency.id,
        recipientType: 'agency_owner',
        messageType: `abandoned_cart_${nextStep}`,
        metadata: {
          step: nextStep,
          linkType: recoveryLink.includes('set-password') ? 'set-password' : 'login',
        },
      });

      if (smsSent) {
        await supabase.from('agencies').update({
          abandoned_cart_step: nextStep,
          abandoned_cart_last_sent_at: new Date().toISOString(),
        }).eq('id', agency.id);
        sent++;
        results.push({ agency: agency.name, step: nextStep, status: 'sent', linkType: recoveryLink.includes('set-password') ? 'set-password' : 'login' });
        console.log(`✅ Step ${nextStep} sent to ${agency.name}`);
      } else {
        results.push({ agency: agency.name, step: nextStep, status: 'failed' });
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

    const smsSent = await sendAndLogSMS({
      phone: agency.phone,
      message,
      agencyId: agency.id,
      recipientType: 'agency_owner',
      messageType: `abandoned_cart_${targetStep}`,
      metadata: { step: targetStep, test: true },
    });

    if (smsSent) {
      await supabase.from('agencies').update({
        abandoned_cart_step: targetStep,
        abandoned_cart_last_sent_at: new Date().toISOString(),
      }).eq('id', agencyId);
    }

    res.json({
      success: smsSent,
      agency: agency.name,
      step: targetStep,
      phone: formattedPhone,
      linkType: recoveryLink.includes('set-password') ? 'set-password' : 'login',
      message: smsSent ? `Step ${targetStep} sent` : 'SMS failed',
    });
  } catch (error) {
    console.error('❌ Test abandoned cart error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
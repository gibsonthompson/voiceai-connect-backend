// ============================================================================
// ABANDONED CART SMS - Cron Handler
// Sends up to 5 nudge SMS to agencies who signed up but never subscribed.
//
// UPDATED: Now checks if agency owner has a password set. If not, generates
// a fresh set-password token and links to /auth/set-password instead of
// /agency/login. This eliminates the dead end where passwordless agencies
// land on a login page they can't use.
//
// Sequence:
//   Step 1: 30 minutes after signup
//   Step 2: 1 hour after signup
//   Step 3: 24 hours after signup
//   Step 4: 72 hours after signup
//   Step 5: 1 week after signup
//
// Endpoint: POST /api/cron/abandoned-cart
// Called by cron-job.org every 30 minutes
// ============================================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { sendTelnyxSMS, formatPhoneE164 } = require('../lib/notifications');
const { createPasswordToken } = require('./agency-signup');

// ============================================================================
// TIMING THRESHOLDS (minutes after signup)
// ============================================================================
const STEP_THRESHOLDS = {
  1: 30,         // 30 minutes
  2: 60,         // 1 hour
  3: 1440,       // 24 hours
  4: 4320,       // 72 hours (3 days)
  5: 10080       // 1 week (7 days)
};

// ============================================================================
// GET RECOVERY LINK FOR AGENCY
// If user has no password → generate fresh set-password token → /auth/set-password
// If user has password → /agency/login (normal login)
// ============================================================================
async function getRecoveryLink(agency) {
  const platformUrl = 'https://myvoiceaiconnect.com';
  const loginUrl = `${platformUrl}/agency/login`;

  try {
    // Look up the agency owner user
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

    // If they already have a password, link to login
    if (user.password_hash) {
      return loginUrl;
    }

    // No password — generate a fresh set-password token
    const token = await createPasswordToken(user.id, user.email);
    const returnTo = encodeURIComponent(`/onboarding?agency=${agency.id}`);
    const setPasswordUrl = `${platformUrl}/auth/set-password?token=${token}&returnTo=${returnTo}`;

    console.log(`🔑 Generated fresh set-password token for ${agency.name} (no password set)`);
    return setPasswordUrl;

  } catch (err) {
    console.error(`⚠️ Error checking password for ${agency.name}:`, err.message);
    return loginUrl; // Fallback to login link
  }
}

// ============================================================================
// MESSAGE TEMPLATES
// Each step has a different message with escalating approach
// Link is dynamic — set-password for passwordless, login for password-set
// ============================================================================
function getAbandonedCartMessage(step, agency, recoveryLink) {
  const name = agency.name || 'there';

  switch (step) {
    case 1:
      // 30 min — Casual reminder
      return (
        `Hey ${name}! 👋\n\n` +
        `Looks like you didn't finish setting up your VoiceAI Connect account. ` +
        `Your white-label AI receptionist platform is waiting for you.\n\n` +
        `Pick up where you left off:\n` +
        `${recoveryLink}\n\n` +
        `Takes less than 5 minutes to finish!`
      );

    case 2:
      // 1 hour — Value prop
      return (
        `Hi ${name},\n\n` +
        `Just a quick reminder — your VoiceAI Connect setup is almost done.\n\n` +
        `Here's what you're about to unlock:\n` +
        `✅ Your own branded AI receptionist platform\n` +
        `✅ Resell to unlimited businesses\n` +
        `✅ Clients pay YOU directly via Stripe\n` +
        `✅ 14-day free trial, no risk\n\n` +
        `Finish setup: ${recoveryLink}`
      );

    case 3:
      // 24 hours — Social proof / what you're missing
      return (
        `Hey ${name},\n\n` +
        `Agencies on VoiceAI Connect are already signing up clients and earning recurring revenue.\n\n` +
        `Every day without your AI receptionist platform is missed revenue from businesses ` +
        `that need 24/7 phone coverage.\n\n` +
        `Your 14-day free trial is ready:\n` +
        `${recoveryLink}\n\n` +
        `No credit card needed to start.`
      );

    case 4:
      // 72 hours — Urgency
      return (
        `${name}, quick question — was there something holding you back from finishing your VoiceAI Connect setup?\n\n` +
        `If you ran into any issues, reply to this text and we'll help you get set up personally.\n\n` +
        `Your account is still waiting:\n` +
        `${recoveryLink}`
      );

    case 5:
      // 1 week — Soft final
      return (
        `Hi ${name},\n\n` +
        `This is our last reminder about your VoiceAI Connect account.\n\n` +
        `If now isn't the right time, no worries at all. Your account will be here whenever you're ready.\n\n` +
        `When you're ready to launch your AI receptionist agency:\n` +
        `${recoveryLink}\n\n` +
        `We're here if you have any questions. 🙏`
      );

    default:
      return null;
  }
}

// ============================================================================
// DETERMINE NEXT STEP FOR AN AGENCY
// Returns the next step number they should receive, or null if not eligible
// ============================================================================
function getNextStep(agency) {
  const currentStep = agency.abandoned_cart_step || 0;
  const nextStep = currentStep + 1;

  // Already sent all 5
  if (nextStep > 5) return null;

  // Check if enough time has passed since signup
  const signupTime = new Date(agency.created_at).getTime();
  const now = Date.now();
  const minutesSinceSignup = (now - signupTime) / (1000 * 60);

  const threshold = STEP_THRESHOLDS[nextStep];
  if (minutesSinceSignup < threshold) return null;

  // Also enforce minimum gap between messages (15 min)
  if (agency.abandoned_cart_last_sent_at) {
    const lastSent = new Date(agency.abandoned_cart_last_sent_at).getTime();
    const minutesSinceLastSent = (now - lastSent) / (1000 * 60);
    if (minutesSinceLastSent < 15) return null;
  }

  return nextStep;
}

// ============================================================================
// CRON ENDPOINT
// POST /api/cron/abandoned-cart
// ============================================================================
router.post('/abandoned-cart', async (req, res) => {
  // Optional cron secret auth
  const cronSecret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('🛒 Running abandoned cart SMS check...');

    // Fetch agencies that:
    // 1. Have subscription_status = 'pending' (never paid)
    // 2. Have abandoned_cart_step < 5 (haven't received all messages)
    // 3. Have a phone number
    const { data: agencies, error } = await supabase
      .from('agencies')
      .select('id, name, email, phone, created_at, abandoned_cart_step, abandoned_cart_last_sent_at')
      .eq('subscription_status', 'pending')
      .lt('abandoned_cart_step', 5)
      .not('phone', 'is', null)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('❌ Abandoned cart query error:', error);
      return res.status(500).json({ error: 'Database query failed' });
    }

    if (!agencies || agencies.length === 0) {
      console.log('✅ No abandoned carts to process');
      return res.json({ success: true, processed: 0, sent: 0 });
    }

    console.log(`📋 Found ${agencies.length} pending agencies to check`);

    let sent = 0;
    let skipped = 0;
    const results = [];

    for (const agency of agencies) {
      const nextStep = getNextStep(agency);

      if (!nextStep) {
        skipped++;
        continue;
      }

      // Format phone
      const formattedPhone = formatPhoneE164(agency.phone);
      if (!formattedPhone) {
        console.log(`⚠️ Invalid phone for ${agency.name}: ${agency.phone}`);
        skipped++;
        continue;
      }

      // Get the right recovery link (set-password vs login)
      const recoveryLink = await getRecoveryLink(agency);

      // Get message for this step
      const message = getAbandonedCartMessage(nextStep, agency, recoveryLink);
      if (!message) {
        skipped++;
        continue;
      }

      // Send SMS
      console.log(`📱 Sending abandoned cart step ${nextStep} to ${agency.name} (${formattedPhone})`);
      const smsSent = await sendTelnyxSMS(formattedPhone, message);

      if (smsSent) {
        // Update tracking
        await supabase
          .from('agencies')
          .update({
            abandoned_cart_step: nextStep,
            abandoned_cart_last_sent_at: new Date().toISOString()
          })
          .eq('id', agency.id);

        sent++;
        results.push({
          agency: agency.name,
          step: nextStep,
          phone: formattedPhone,
          status: 'sent',
          linkType: recoveryLink.includes('set-password') ? 'set-password' : 'login'
        });

        console.log(`✅ Step ${nextStep} sent to ${agency.name} (${recoveryLink.includes('set-password') ? 'set-password link' : 'login link'})`);
      } else {
        results.push({
          agency: agency.name,
          step: nextStep,
          phone: formattedPhone,
          status: 'failed'
        });

        console.log(`❌ Failed to send step ${nextStep} to ${agency.name}`);
      }
    }

    console.log(`🛒 Abandoned cart complete: ${sent} sent, ${skipped} skipped out of ${agencies.length}`);

    res.json({
      success: true,
      processed: agencies.length,
      sent,
      skipped,
      results
    });

  } catch (error) {
    console.error('❌ Abandoned cart cron error:', error);
    res.status(500).json({ error: 'Cron job failed', message: error.message });
  }
});

// ============================================================================
// MANUAL TRIGGER FOR SINGLE AGENCY (for testing)
// POST /api/cron/abandoned-cart/test/:agencyId
// ============================================================================
router.post('/abandoned-cart/test/:agencyId', async (req, res) => {
  const cronSecret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { agencyId } = req.params;
    const { step } = req.body; // Optionally force a specific step

    const { data: agency, error } = await supabase
      .from('agencies')
      .select('id, name, email, phone, created_at, subscription_status, abandoned_cart_step, abandoned_cart_last_sent_at')
      .eq('id', agencyId)
      .single();

    if (error || !agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    const targetStep = step || (agency.abandoned_cart_step || 0) + 1;

    if (targetStep > 5) {
      return res.json({ success: false, message: 'All 5 messages already sent' });
    }

    const formattedPhone = formatPhoneE164(agency.phone);
    if (!formattedPhone) {
      return res.json({ success: false, message: `Invalid phone: ${agency.phone}` });
    }

    const recoveryLink = await getRecoveryLink(agency);
    const message = getAbandonedCartMessage(targetStep, agency, recoveryLink);

    console.log(`🧪 Test sending step ${targetStep} to ${agency.name}`);

    const smsSent = await sendTelnyxSMS(formattedPhone, message);

    if (smsSent) {
      await supabase
        .from('agencies')
        .update({
          abandoned_cart_step: targetStep,
          abandoned_cart_last_sent_at: new Date().toISOString()
        })
        .eq('id', agencyId);
    }

    res.json({
      success: smsSent,
      agency: agency.name,
      step: targetStep,
      phone: formattedPhone,
      linkType: recoveryLink.includes('set-password') ? 'set-password' : 'login',
      recoveryLink,
      message: smsSent ? `Step ${targetStep} sent` : 'SMS failed'
    });

  } catch (error) {
    console.error('❌ Test abandoned cart error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
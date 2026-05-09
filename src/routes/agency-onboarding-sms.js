// ============================================================================
// AGENCY ONBOARDING ENGAGEMENT SMS - Cron Handler
// 9-step conditional drip for agencies that ABANDONED onboarding.
// UPDATED: Only targets agencies with onboarding_completed = false.
//          Agencies that finished onboarding are in the dashboard and
//          don't need text nudges — the dashboard guides them instead.
//          Trial expiry warnings are handled by warnExpiringAgencyTrials.
// ============================================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { sendTelnyxSMS, formatPhoneE164 } = require('../lib/notifications');
const { getSmsTemplate } = require('../lib/sms-templates');

// ============================================================================
// TIMING: Hours after signup for each step
// ============================================================================
const STEP_HOURS = { 1: 2, 2: 6, 3: 24, 4: 48, 5: 72, 6: 120, 7: 168, 8: 240, 9: 312 };

// ============================================================================
// BUILD URLS FOR AGENCY
// ============================================================================
function getAgencyUrls(agency) {
  const platformDomain = process.env.PLATFORM_DOMAIN || 'myvoiceaiconnect.com';
  const platformUrl = `https://${platformDomain}`;

  let baseUrl;
  if (agency.marketing_domain && agency.domain_verified) baseUrl = `https://${agency.marketing_domain}`;
  else if (agency.slug) baseUrl = `https://${agency.slug}.${platformDomain}`;
  else baseUrl = platformUrl;

  return {
    settingsUrl: `${platformUrl}/agency/settings`,
    clientsUrl: `${platformUrl}/agency/clients`,
    loginUrl: `${platformUrl}/agency/login`,
    signupUrl: `${baseUrl}/signup`,
    dashboardUrl: `${platformUrl}/agency/dashboard`,
  };
}

// ============================================================================
// CHECK ELIGIBILITY & CONDITIONS FOR EACH STEP
// Returns { eligible: bool, step: number } or null
// ============================================================================
async function getNextEligibleStep(agency) {
  const currentStep = agency.onboarding_sms_step || 0;
  const nextStep = currentStep + 1;
  if (nextStep > 9) return null;

  // Check timing
  const signupTime = new Date(agency.created_at).getTime();
  const hoursSinceSignup = (Date.now() - signupTime) / (1000 * 60 * 60);
  if (hoursSinceSignup < STEP_HOURS[nextStep]) return null;

  // Min 2 hour gap between messages
  if (agency.onboarding_sms_last_sent_at) {
    const hoursSinceLastSent = (Date.now() - new Date(agency.onboarding_sms_last_sent_at).getTime()) / (1000 * 60 * 60);
    if (hoursSinceLastSent < 2) return null;
  }

  // Step-specific conditions (skip if already done)
  switch (nextStep) {
    case 1: // Logo nudge — skip if already has logo
      if (agency.logo_url) return getNextEligibleStep({ ...agency, onboarding_sms_step: nextStep });
      break;
    case 2: // Stripe Connect — skip if already connected
      if (agency.stripe_charges_enabled) return getNextEligibleStep({ ...agency, onboarding_sms_step: nextStep });
      break;
    case 4: // Stripe reminder — skip if connected
      if (agency.stripe_charges_enabled) return getNextEligibleStep({ ...agency, onboarding_sms_step: nextStep });
      break;
  }

  return { eligible: true, step: nextStep };
}

// ============================================================================
// GET MESSAGE FOR STEP — Template first, fallback to hardcoded
// ============================================================================
async function getStepMessage(step, agency, urls) {
  const name = agency.name || 'there';

  switch (step) {
    case 1: {
      const msg = await getSmsTemplate('onboarding_sms_1', { name, settings_url: urls.settingsUrl });
      return msg || `Hey ${name}, quick win for your agency 🎨\n\nUpload your logo and set your brand colors — it takes 30 seconds and everything your clients see will be YOUR brand, not ours.\n\n${urls.settingsUrl}?tab=profile`;
    }
    case 2: {
      const msg = await getSmsTemplate('onboarding_sms_2', { name, settings_url: urls.settingsUrl });
      return msg || `${name}, one important setup step left: connect Stripe so you can collect payments from your clients.\n\nIt takes about 2 minutes and you'll be ready to start earning recurring revenue.\n\n${urls.settingsUrl}?tab=payments`;
    }
    case 3: {
      const msg = await getSmsTemplate('onboarding_sms_3', { dashboard_url: urls.dashboardUrl });
      return msg || `Pro tip: you already have a test client with a live AI receptionist in your dashboard.\n\nCall the test number to hear exactly what your clients will experience — then share your signup link to start landing real clients.\n\n${urls.dashboardUrl}`;
    }
    case 4: {
      const msg = await getSmsTemplate('onboarding_sms_4', { name, settings_url: urls.settingsUrl });
      return msg || `Hey ${name}, just a heads up — your agency isn't set up to accept payments yet.\n\nWithout Stripe connected, clients who try to subscribe won't be able to pay you.\n\nConnect now (takes 2 min):\n${urls.settingsUrl}?tab=payments`;
    }
    case 5: {
      const msg = await getSmsTemplate('onboarding_sms_5', { name, signup_url: urls.signupUrl });
      return msg || `${name}, your client signup page is live:\n${urls.signupUrl}\n\nShare it in your outreach, add it to your website, or DM it directly to a prospect.\n\nEvery business that signs up gets their own AI receptionist — and pays YOU monthly.`;
    }
    case 6: {
      const { data: clients } = await supabase.from('clients').select('id').eq('agency_id', agency.id).eq('is_test_client', false).limit(1);
      const clientCount = clients?.length || 0;
      const missing = [];
      if (!agency.logo_url) missing.push('• Upload your logo');
      if (!agency.stripe_charges_enabled) missing.push('• Connect Stripe');
      if (clientCount === 0) missing.push('• Land your first client');

      if (missing.length === 0) {
        const msg = await getSmsTemplate('onboarding_sms_6_complete', { name, signup_url: urls.signupUrl });
        return msg || `${name}, your agency is fully set up! 💪\n\nBranding ✅\nStripe ✅\nClients ✅\n\nTime to scale. Share your signup link with more prospects:\n${urls.signupUrl}`;
      } else {
        const missingItems = missing.join('\n');
        const msg = await getSmsTemplate('onboarding_sms_6_progress', { name, missing_items: missingItems, login_url: urls.loginUrl });
        return msg || `${name}, you're making progress! Here's what's left to get your agency 100% ready:\n\n${missingItems}\n\nLog in: ${urls.loginUrl}`;
      }
    }
    case 7: {
      const msg = await getSmsTemplate('onboarding_sms_7', { name, signup_url: urls.signupUrl });
      return msg || `${name}, you're halfway through your free trial.\n\nAgencies that land their first client in week 1 are far more likely to build real recurring revenue.\n\nYour signup page is ready for prospects:\n${urls.signupUrl}\n\nNeed help? Call or text (678) 316-1454`;
    }
    case 8: {
      const trialEndsAt = agency.trial_ends_at ? new Date(agency.trial_ends_at) : null;
      let daysMsg = '4 days left';
      if (trialEndsAt) {
        const daysLeft = Math.max(0, Math.ceil((trialEndsAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
        daysMsg = `${daysLeft} day${daysLeft !== 1 ? 's' : ''} left`;
      }
      const msg = await getSmsTemplate('onboarding_sms_8', { name, days_msg: daysMsg, settings_url: urls.settingsUrl });
      return msg || `${name}, ${daysMsg} on your trial.\n\nEverything you've built — your branding, clients, AI assistants — stays active when you subscribe.\n\nLock in your plan:\n${urls.settingsUrl}?tab=billing`;
    }
    case 9: {
      const trialEndsAt = agency.trial_ends_at ? new Date(agency.trial_ends_at) : null;
      let expiryMsg = 'your VoiceAI Connect trial ends tomorrow';
      if (trialEndsAt) {
        const daysLeft = Math.max(0, Math.ceil((trialEndsAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
        expiryMsg = daysLeft <= 1 ? 'your VoiceAI Connect trial ends tomorrow' : `your VoiceAI Connect trial ends in ${daysLeft} days`;
      }
      const msg = await getSmsTemplate('onboarding_sms_9', { name, expiry_msg: expiryMsg, settings_url: urls.settingsUrl });
      return msg || `${name}, ${expiryMsg}.\n\nAfter that, your agency dashboard and all client AI receptionists will be paused.\n\nSubscribe to keep everything running:\n${urls.settingsUrl}?tab=billing`;
    }
    default:
      return null;
  }
}

// ============================================================================
// CRON ENDPOINT — POST /api/cron/agency-onboarding-sms
// ============================================================================
router.post('/agency-onboarding-sms', async (req, res) => {
  const cronSecret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('📨 Running onboarding engagement SMS check...');

    // ========================================================================
    // KEY FIX: Only target agencies that HAVEN'T completed onboarding.
    // Once onboarding_completed = true, the agency is in the dashboard and
    // gets guided by inline prompts instead of text messages.
    // Trial expiry warnings are handled separately by warnExpiringAgencyTrials.
    // ========================================================================
    const { data: agencies, error } = await supabase
      .from('agencies')
      .select('*')
      .in('subscription_status', ['pending', 'trialing', 'trial'])
      .eq('onboarding_completed', false)
      .lt('onboarding_sms_step', 9)
      .not('phone', 'is', null)
      .order('created_at', { ascending: true });

    if (error) { console.error('❌ Onboarding SMS query error:', error); return res.status(500).json({ error: 'Database query failed' }); }
    if (!agencies || agencies.length === 0) { console.log('✅ No onboarding SMS to process'); return res.json({ success: true, processed: 0, sent: 0 }); }

    console.log(`📋 Found ${agencies.length} agencies to check for onboarding SMS`);
    let sent = 0, skipped = 0;
    const results = [];

    for (const agency of agencies) {
      // Skip agencies still in abandoned cart sequence
      if (agency.subscription_status === 'pending' && (agency.abandoned_cart_step || 0) < 5) {
        skipped++;
        continue;
      }

      const result = await getNextEligibleStep(agency);
      if (!result) { skipped++; continue; }

      const { step } = result;
      const formattedPhone = formatPhoneE164(agency.phone);
      if (!formattedPhone) { console.log(`⚠️ Invalid phone for ${agency.name}`); skipped++; continue; }

      const urls = getAgencyUrls(agency);
      const message = await getStepMessage(step, agency, urls);
      if (!message) { skipped++; continue; }

      console.log(`📱 Sending onboarding step ${step} to ${agency.name} (${formattedPhone})`);
      const smsSent = await sendTelnyxSMS(formattedPhone, message);

      if (smsSent) {
        await supabase.from('agencies').update({ onboarding_sms_step: step, onboarding_sms_last_sent_at: new Date().toISOString() }).eq('id', agency.id);
        sent++;
        results.push({ agency: agency.name, step, status: 'sent' });
        console.log(`✅ Onboarding step ${step} sent to ${agency.name}`);
      } else {
        results.push({ agency: agency.name, step, status: 'failed' });
        console.log(`❌ Failed onboarding step ${step} for ${agency.name}`);
      }
    }

    console.log(`📨 Onboarding SMS complete: ${sent} sent, ${skipped} skipped out of ${agencies.length}`);
    res.json({ success: true, processed: agencies.length, sent, skipped, results });
  } catch (error) {
    console.error('❌ Onboarding SMS cron error:', error);
    res.status(500).json({ error: 'Cron job failed', message: error.message });
  }
});

module.exports = router;
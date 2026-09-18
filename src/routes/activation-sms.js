// ============================================================================
// ACTIVATION SMS - Post-Onboarding Engagement Sequence
//
// 9-step conditional drip for agencies that COMPLETED onboarding and are
// now in the dashboard. Each step fires only if the agency hasn't already
// done the action - completed steps are skipped silently.
//
// CREATED: 2026-05-09
// UPDATED: 2026-05-14 - Fixed phone formatting for international agencies,
//          added E.164 validation, advance step on permanent send failures
// ============================================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { formatPhoneE164 } = require('../lib/notifications');
const { sendAndLogSMS } = require('../lib/sms-logger');
const { getSmsTemplate } = require('../lib/sms-templates');

// ============================================================================
// TIMING: Minutes after onboarding_completed_at for each step
// ============================================================================
const STEP_MINUTES = {
  1: 10, 2: 120, 3: 360, 4: 1440, 5: 2880,
  6: 4320, 7: 7200, 8: 10080, 9: 14400,
};

// ============================================================================
// E.164 VALIDATION
// ============================================================================
function isValidE164(phone) {
  if (!phone || !phone.startsWith('+')) return false;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return false;
  if (digits.startsWith('1') && digits.length !== 11) return false;
  return true;
}

// ============================================================================
// BUILD URLS FOR AGENCY
// ============================================================================
function getAgencyUrls(agency) {
  const platformDomain = process.env.PLATFORM_DOMAIN || 'myvoiceaiconnect.com';
  const platformUrl = `https://${platformDomain}`;

  let signupUrl;
  if (agency.marketing_domain && agency.domain_verified) {
    signupUrl = `https://${agency.marketing_domain}/signup`;
  } else if (agency.slug) {
    signupUrl = `https://${agency.slug}.${platformDomain}/signup`;
  } else {
    signupUrl = `${platformUrl}/signup?ref=${agency.slug || 'demo'}`;
  }

  return {
    settingsUrl: `${platformUrl}/agency/settings`,
    dashboardUrl: `${platformUrl}/agency/dashboard`,
    clientsUrl: `${platformUrl}/agency/clients`,
    loginUrl: `${platformUrl}/agency/login`,
    signupUrl,
  };
}

// ============================================================================
// GET AGENCY STATS (for conditional checks)
// ============================================================================
async function getAgencyStats(agencyId) {
  const { data: clients } = await supabase
    .from('clients')
    .select('id, is_test_client')
    .eq('agency_id', agencyId);

  const realClients = (clients || []).filter(c => !c.is_test_client);
  const testClient = (clients || []).find(c => c.is_test_client);

  return {
    realClientCount: realClients.length,
    hasTestClient: !!testClient,
  };
}

// ============================================================================
// CHECK DASHBOARD CHECKLIST COMPLETION
// ============================================================================
function getChecklistStatus(agency, stats) {
  const DEFAULT_PRICES = { starter: 4900, pro: 9900, growth: 14900 };
  return {
    hasLogo: !!agency.logo_url,
    hasColors: !!(agency.primary_color && agency.primary_color !== '#10b981'),
    hasPricing: !!(
      (agency.price_starter ?? DEFAULT_PRICES.starter) !== DEFAULT_PRICES.starter ||
      (agency.price_pro ?? DEFAULT_PRICES.pro) !== DEFAULT_PRICES.pro ||
      (agency.price_growth ?? DEFAULT_PRICES.growth) !== DEFAULT_PRICES.growth
    ),
    hasStripe: !!agency.stripe_account_id,
    hasStripeCharges: !!agency.stripe_charges_enabled,
    hasClient: stats.realClientCount > 0,
  };
}

// ============================================================================
// CHECK ELIGIBILITY & GET NEXT STEP
// ============================================================================
async function getNextEligibleStep(agency) {
  const currentStep = agency.activation_sms_step || 0;
  const nextStep = currentStep + 1;
  if (nextStep > 9) return null;

  const completedAt = agency.onboarding_completed_at || agency.created_at;
  const minutesSinceCompleted = (Date.now() - new Date(completedAt).getTime()) / (1000 * 60);
  if (minutesSinceCompleted < STEP_MINUTES[nextStep]) return null;

  if (agency.activation_sms_last_sent_at) {
    const minutesSinceLastSent = (Date.now() - new Date(agency.activation_sms_last_sent_at).getTime()) / (1000 * 60);
    if (minutesSinceLastSent < 120) return null;
  }

  const stats = await getAgencyStats(agency.id);
  const checklist = getChecklistStatus(agency, stats);

  switch (nextStep) {
    case 1: break;
    case 2:
      if (checklist.hasLogo && checklist.hasColors) return getNextEligibleStep({ ...agency, activation_sms_step: nextStep });
      break;
    case 3: break;
    case 4:
      if (checklist.hasStripeCharges) return getNextEligibleStep({ ...agency, activation_sms_step: nextStep });
      break;
    case 5:
      if (checklist.hasClient) return getNextEligibleStep({ ...agency, activation_sms_step: nextStep });
      break;
    case 6:
      if (checklist.hasStripeCharges) return getNextEligibleStep({ ...agency, activation_sms_step: nextStep });
      break;
    case 7: break;
    case 8:
      if (agency.plan_type !== 'free' && agency.plan_type !== 'starter') return getNextEligibleStep({ ...agency, activation_sms_step: nextStep });
      break;
    case 9:
      if (checklist.hasClient) return getNextEligibleStep({ ...agency, activation_sms_step: nextStep });
      break;
  }

  return { step: nextStep };
}

// ============================================================================
// GET MESSAGE FOR STEP
// ============================================================================
async function getStepMessage(step, agency, urls) {
  const name = agency.name || 'there';

  switch (step) {
    case 1: {
      const demoPhone = agency.demo_phone_number || null;
      const msg = await getSmsTemplate('activation_sms_1', { name, demo_phone: demoPhone, dashboard_url: urls.dashboardUrl });
      if (msg) return msg;
      if (demoPhone) return `${name}, it's Gibson, founder of VoiceAI Connect. You're live! Call your demo AI and hear exactly what you're selling: ${demoPhone}. Reply to this number anytime with questions or feedback.`;
      return `${name}, it's Gibson, founder of VoiceAI Connect. You're live! The test client in your dashboard is a real, working AI receptionist, give it a call. Reply to this number anytime with questions or feedback.`;
    }
    case 2: {
      const needsLogo = !agency.logo_url;
      const needsColors = !(agency.primary_color && agency.primary_color !== '#10b981');
      const msg = await getSmsTemplate('activation_sms_2', { name, settings_url: urls.settingsUrl });
      if (msg) return msg;
      if (needsLogo && needsColors) return `${name}, add your logo in Settings and the whole platform, your site, dashboard, and client emails, turns into your brand instead of ours. That's the white-label piece clients actually notice.`;
      if (needsLogo) return `${name}, your colors are set. Add your logo in Settings and the white-label look is done, clients see your brand top to bottom.`;
      return `${name}, your logo's up and looking sharp. Set your brand colors in Settings so everything matches your agency.`;
    }
    case 3: {
      const msg = await getSmsTemplate('activation_sms_3', { name, clients_url: urls.clientsUrl });
      return msg || `${name}, there's a test client in your dashboard with a live AI and a real number. Call it, does it sound like a real person to you? Curious what you think.`;
    }
    case 4: {
      const stripeStarted = !!agency.stripe_account_id;
      const msg = await getSmsTemplate('activation_sms_4', { name, settings_url: urls.settingsUrl });
      if (msg) return msg;
      if (stripeStarted) return `${name}, your Stripe connection is half-finished, so right now a client who signs up can't actually pay you. Finish it in Settings, under Payments. Let me know if you need anything.`;
      return `${name}, one thing to set up before you land a client: connect Stripe in Settings, under Payments. It's how clients pay you, and the money lands straight in your own account. Let me know if you need a hand.`;
    }
    case 5: {
      const msg = await getSmsTemplate('activation_sms_5', { name, signup_url: urls.signupUrl });
      return msg || `${name}, your client signup page is ready to send. Not sure who to send it to? The Leads tab pulls real local businesses in your area from Google Maps, so you've always got a list to work from. Grab your link in the dashboard and send it to a few this week. Let me know if you need anything.`;
    }
    case 6: {
      const stripeStarted6 = !!agency.stripe_account_id;
      const msg = await getSmsTemplate('activation_sms_6', { name, settings_url: urls.settingsUrl });
      if (msg) return msg;
      if (stripeStarted6) return `${name}, your Stripe setup is still unfinished, which means you can't get paid yet even if a client signs up today. It's waiting in Settings, under Payments. Let me know if something's blocking you and I'll help.`;
      return `${name}, heads up, your agency still can't accept payments, so a client who signs up today couldn't actually pay you. Connecting Stripe in Settings, under Payments, fixes it. Let me know if you need a hand.`;
    }
    case 7: {
      const stats7 = await getAgencyStats(agency.id);
      const cl = getChecklistStatus(agency, stats7);
      const missing = [];
      if (!cl.hasLogo) missing.push('Upload your logo');
      if (!cl.hasColors) missing.push('Set your brand colors');
      if (!cl.hasPricing) missing.push('Configure client pricing');
      if (!cl.hasStripe) missing.push('Connect Stripe');
      if (!cl.hasClient) missing.push('Add your first client');
      const done = 5 - missing.length;
      if (missing.length === 0) {
        const msg = await getSmsTemplate('activation_sms_7_complete', { name, signup_url: urls.signupUrl });
        return msg || `${name}, you're fully set up: logo, colors, pricing, Stripe, first client. Now it's about volume. The Leads tab pulls local businesses from Google Maps with outreach templates built in, work a batch each week and point them at your demo line. Let me know if you want a hand with your pitch.`;
      } else {
        const checklist = missing.map(m => `- ${m}`).join('\n');
        const msg = await getSmsTemplate('activation_sms_7_progress', { name, checklist, done, total: 5, login_url: urls.loginUrl });
        return msg || `${name}, you're ${done}/5 set up. Still left:\n${checklist}\nKnock these out and you're ready to start pulling leads. Let me know if any of them are giving you trouble.`;
      }
    }
    case 8: {
      const msg = await getSmsTemplate('activation_sms_8', { name, settings_url: urls.settingsUrl });
      return msg || `${name}, on the Free plan your clients still see our name. Pro ($99/mo) makes it fully yours: your site, your domain, your brand. Worth it once you've landed a client. Questions?`;
    }
    case 9: {
      const demoPhone9 = agency.demo_phone_number || null;
      const msg = await getSmsTemplate('activation_sms_9', { name, demo_phone: demoPhone9, signup_url: urls.signupUrl });
      if (msg) return msg;
      if (demoPhone9) {
        return `${name}, everything's built, all that's left is client #1. The move that lands them: get a local business to call your demo line and hear the AI answer as their own receptionist. That 30-second call sells it better than anything you could say. Give a few your demo number this week:\n${demoPhone9}`;
      }
      return `${name}, everything's built, all that's left is client #1. The move that lands them: let a local business actually hear the AI answer as their own receptionist, it sells itself. Send a few your signup link so they can hear it free for a week:\n${urls.signupUrl}`;
    }
    default: return null;
  }
}

// ============================================================================
// CRON ENDPOINT - POST /api/cron/activation-sms
// ============================================================================
router.post('/activation-sms', async (req, res) => {
  const cronSecret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('🚀 Running activation SMS check...');

    const { data: agencies, error } = await supabase
      .from('agencies')
      .select('*')
      .eq('onboarding_completed', true)
      .in('subscription_status', ['trialing', 'trial', 'active', 'free', 'pending'])
      .lt('activation_sms_step', 9)
      .not('phone', 'is', null)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('❌ Activation SMS query error:', error);
      return res.status(500).json({ error: 'Database query failed' });
    }

    if (!agencies || agencies.length === 0) {
      console.log('✅ No activation SMS to process');
      return res.json({ success: true, processed: 0, sent: 0 });
    }

    console.log(`📋 Found ${agencies.length} agencies to check for activation SMS`);
    let sent = 0, skipped = 0;
    const results = [];

    for (const agency of agencies) {
      if (agency.subscription_status === 'pending' && (agency.abandoned_cart_step || 0) < 5) { skipped++; continue; }
      if (agency.status === 'suspended') { skipped++; continue; }

      const result = await getNextEligibleStep(agency);
      if (!result) { skipped++; continue; }

      const { step } = result;

      // Format phone with agency's country
      const formattedPhone = formatPhoneE164(agency.phone, agency.country || 'US');

      // Validate before attempting send
      if (!formattedPhone || !isValidE164(formattedPhone)) {
        console.log(`⚠️ Invalid phone for ${agency.name}: ${agency.phone} → ${formattedPhone} (country: ${agency.country || 'US'}) - marking complete`);
        await supabase.from('agencies').update({
          activation_sms_step: 9,
          activation_sms_last_sent_at: new Date().toISOString(),
        }).eq('id', agency.id);
        results.push({ agency: agency.name, step, status: 'invalid_phone' });
        skipped++;
        continue;
      }

      const urls = getAgencyUrls(agency);
      const message = await getStepMessage(step, agency, urls);
      if (!message) { skipped++; continue; }

      console.log(`📱 Sending activation step ${step} to ${agency.name} (${formattedPhone})`);

      const smsSent = await sendAndLogSMS({
        phone: formattedPhone,
        message,
        agencyId: agency.id,
        recipientType: 'agency_owner',
        messageType: `activation_sms_${step}`,
        metadata: { step, plan: agency.plan_type, country: agency.country || 'US' },
      });

      if (smsSent) {
        await supabase.from('agencies').update({
          activation_sms_step: step,
          activation_sms_last_sent_at: new Date().toISOString(),
        }).eq('id', agency.id);
        sent++;
        results.push({ agency: agency.name, step, status: 'sent' });
        console.log(`✅ Activation step ${step} sent to ${agency.name}`);
      } else {
        // Advance step on failure to prevent infinite retry
        await supabase.from('agencies').update({
          activation_sms_step: step,
          activation_sms_last_sent_at: new Date().toISOString(),
        }).eq('id', agency.id);
        results.push({ agency: agency.name, step, status: 'failed_advanced' });
        console.log(`❌ Failed activation step ${step} for ${agency.name} - advancing step`);
      }
    }

    console.log(`🚀 Activation SMS complete: ${sent} sent, ${skipped} skipped out of ${agencies.length}`);
    res.json({ success: true, processed: agencies.length, sent, skipped, results });
  } catch (error) {
    console.error('❌ Activation SMS cron error:', error);
    res.status(500).json({ error: 'Cron job failed', message: error.message });
  }
});

module.exports = router;
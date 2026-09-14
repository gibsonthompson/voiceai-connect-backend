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
      if (demoPhone) return `${name}, it's Gibson, founder of VoiceAI Connect. You're live! Call your demo AI and hear what you're selling: ${demoPhone}. What industry are you going after first?`;
      return `${name}, it's Gibson, founder of VoiceAI Connect. You're live! Your test client in the dashboard is a real working AI receptionist. What industry are you going after first?`;
    }
    case 2: {
      const needsLogo = !agency.logo_url;
      const needsColors = !(agency.primary_color && agency.primary_color !== '#10b981');
      const msg = await getSmsTemplate('activation_sms_2', { name, settings_url: urls.settingsUrl });
      if (msg) return msg;
      if (needsLogo && needsColors) return `${name}, quick 30-sec win: add your logo and brand colors in Settings so clients see your brand, not ours. Want a hand picking colors that fit?`;
      if (needsLogo) return `${name}, your colors look good. Add your logo in Settings to finish the look. Need a hand?`;
      return `${name}, your logo's up. Set your brand colors in Settings to match your agency, 10 seconds.`;
    }
    case 3: {
      const msg = await getSmsTemplate('activation_sms_3', { name, clients_url: urls.clientsUrl });
      return msg || `${name}, there's a test client in your dashboard with a live AI and a real number. Call it, does it sound like a real person to you? Curious what you think.`;
    }
    case 4: {
      const stripeStarted = !!agency.stripe_account_id;
      const msg = await getSmsTemplate('activation_sms_4', { name, settings_url: urls.settingsUrl });
      if (msg) return msg;
      if (stripeStarted) return `${name}, you started Stripe but didn't finish, so clients can't pay you yet. 2-min wrap-up in Settings, under Payments. Want me to walk you through it?`;
      return `${name}, connect Stripe in Settings, under Payments, so you can actually get paid. 2 min. Without it, a client who signs up can't pay you. Stuck on anything?`;
    }
    case 5: {
      const msg = await getSmsTemplate('activation_sms_5', { name, signup_url: urls.signupUrl });
      return msg || `${name}, your client signup page is ready. Grab the link in your dashboard and send it to one business this week. Who's first on your list?`;
    }
    case 6: {
      const stripeStarted6 = !!agency.stripe_account_id;
      const msg = await getSmsTemplate('activation_sms_6', { name, settings_url: urls.settingsUrl });
      if (msg) return msg;
      if (stripeStarted6) return `${name}, your Stripe setup's still unfinished, so clients can't pay you yet. 2 min to wrap up in Settings, under Payments. Stuck?`;
      return `${name}, heads up, your agency still can't accept payments, so a client who signs up can't pay you. 2-min fix in Settings, under Payments. Need a hand?`;
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
        return msg || `${name}, you're fully set up: logo, colors, pricing, Stripe, first client. Now it's a numbers game. How many prospects can you reach this week?`;
      } else {
        const checklist = missing.map(m => `- ${m}`).join('\n');
        const msg = await getSmsTemplate('activation_sms_7_progress', { name, checklist, done, total: 5, login_url: urls.loginUrl });
        return msg || `${name}, you're ${done}/5 set up. Still left:\n${checklist}\nWhich one's tripping you up? Reply and I'll help.`;
      }
    }
    case 8: {
      const msg = await getSmsTemplate('activation_sms_8', { name, settings_url: urls.settingsUrl });
      return msg || `${name}, on the Free plan your clients still see our name. Pro ($99/mo) makes it fully yours: your site, your domain, your brand. Worth it once you've landed a client. Questions?`;
    }
    case 9: {
      const msg = await getSmsTemplate('activation_sms_9', { name, signup_url: urls.signupUrl });
      return msg || `${name}, everything's built, you just need client #1. Agencies who land one in the first two weeks are the ones who stick. Want the outreach approach that's working right now? Reply YES.`;
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
// ============================================================================
// ACTIVATION SMS — Post-Onboarding Engagement Sequence
//
// 9-step conditional drip for agencies that COMPLETED onboarding and are
// now in the dashboard. Each step fires only if the agency hasn't already
// done the action — completed steps are skipped silently.
//
// CREATED: 2026-05-09
// UPDATED: 2026-05-14 — Fixed phone formatting for international agencies,
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
      if (demoPhone) {
        return `Welcome to VoiceAI Connect, ${name}! Your agency is live. 🎉\n\nYou have a demo AI receptionist ready — call it now to hear what your prospects will experience:\n📞 ${demoPhone}\n\nThis is YOUR sales tool. Share this number with anyone considering AI for their business.\n\n${urls.dashboardUrl}`;
      } else {
        return `Welcome to VoiceAI Connect, ${name}! Your agency is live. 🎉\n\nHead to your dashboard to explore your test client, set up your branding, and start landing clients.\n\n${urls.dashboardUrl}`;
      }
    }
    case 2: {
      const needsLogo = !agency.logo_url;
      const needsColors = !(agency.primary_color && agency.primary_color !== '#10b981');
      const msg = await getSmsTemplate('activation_sms_2', { name, settings_url: urls.settingsUrl });
      if (msg) return msg;
      if (needsLogo && needsColors) return `Quick win for ${name} 🎨\n\nUpload your logo and set your brand colors — takes 30 seconds. Everything your clients see will be YOUR brand, not ours.\n\n${urls.settingsUrl}?tab=profile`;
      if (needsLogo) return `${name}, your brand colors look great — now add your logo to complete the look. Your clients will see YOUR brand everywhere.\n\n${urls.settingsUrl}?tab=profile`;
      return `${name}, you've got your logo uploaded — now set your brand colors to match your agency's identity. Takes 10 seconds.\n\n${urls.settingsUrl}?tab=profile`;
    }
    case 3: {
      const msg = await getSmsTemplate('activation_sms_3', { name, clients_url: urls.clientsUrl });
      return msg || `${name}, your dashboard has a test client with a live AI receptionist and a real phone number.\n\n1. Call the test number to hear the AI in action\n2. Log in as the test client from your Clients page to see their dashboard\n\nThis is exactly what your clients will experience.\n\n${urls.clientsUrl}`;
    }
    case 4: {
      const stripeStarted = !!agency.stripe_account_id;
      const msg = await getSmsTemplate('activation_sms_4', { name, settings_url: urls.settingsUrl });
      if (msg) return msg;
      if (stripeStarted) return `${name}, looks like you started connecting Stripe but it's not finished yet. Until it's complete, clients who sign up won't be able to pay you.\n\nFinish setup (takes 2 min):\n${urls.settingsUrl}?tab=payments`;
      return `${name}, one important step: connect Stripe so you can collect payments from your clients.\n\nWithout it, clients who sign up can't pay you. Takes 2 minutes:\n${urls.settingsUrl}?tab=payments`;
    }
    case 5: {
      const msg = await getSmsTemplate('activation_sms_5', { name, signup_url: urls.signupUrl });
      return msg || `${name}, your client signup page is live:\n${urls.signupUrl}\n\nShare it in your outreach, add it to your website, or DM it directly to a prospect.\n\nEvery business that signs up gets their own AI receptionist — and pays YOU monthly.`;
    }
    case 6: {
      const stripeStarted6 = !!agency.stripe_account_id;
      const msg = await getSmsTemplate('activation_sms_6', { name, settings_url: urls.settingsUrl });
      if (msg) return msg;
      if (stripeStarted6) return `Hey ${name}, your Stripe Connect setup still isn't complete — which means clients can't pay you yet.\n\nIt usually takes 2 minutes to finish. Don't leave money on the table:\n${urls.settingsUrl}?tab=payments`;
      return `Hey ${name}, heads up — your agency still isn't set up to accept payments.\n\nClients who try to subscribe won't be able to pay you.\n\nConnect Stripe now (2 min):\n${urls.settingsUrl}?tab=payments`;
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
        return msg || `${name}, your agency is fully set up! 💪\n\n✅ Logo\n✅ Brand Colors\n✅ Pricing\n✅ Stripe\n✅ First Client\n\nTime to scale. Share your signup link with more prospects:\n${urls.signupUrl}`;
      } else {
        const checklist = missing.map(m => `• ${m}`).join('\n');
        const msg = await getSmsTemplate('activation_sms_7_progress', { name, checklist, done, total: 5, login_url: urls.loginUrl });
        return msg || `${name}, you're ${done}/5 on your setup checklist. Here's what's left:\n\n${checklist}\n\nLog in: ${urls.loginUrl}`;
      }
    }
    case 8: {
      const msg = await getSmsTemplate('activation_sms_8', { name, settings_url: urls.settingsUrl });
      return msg || `${name}, you're on the Free plan — which means your clients see VoiceAI Connect branding instead of yours.\n\nUpgrade to Pro ($99/mo) to get full white-label, your own marketing website, and custom domain. Your clients will never know we exist.\n\n${urls.settingsUrl}?tab=billing`;
    }
    case 9: {
      const msg = await getSmsTemplate('activation_sms_9', { name, signup_url: urls.signupUrl });
      return msg || `${name}, your AI receptionist platform is built and waiting.\n\nAgencies that land their first client in the first two weeks are far more likely to build real recurring revenue.\n\nYour signup page:\n${urls.signupUrl}\n\nNeed help with outreach? Reply to this text.`;
    }
    default: return null;
  }
}

// ============================================================================
// CRON ENDPOINT — POST /api/cron/activation-sms
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
        console.log(`⚠️ Invalid phone for ${agency.name}: ${agency.phone} → ${formattedPhone} (country: ${agency.country || 'US'}) — marking complete`);
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
        console.log(`❌ Failed activation step ${step} for ${agency.name} — advancing step`);
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
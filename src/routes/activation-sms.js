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
// Step 5 is the Marketing Kit nudge (added 2026-10). Steps 6-10 are the old
// 5-9, shifted down by one. Existing agencies' counters were bumped +1 where
// activation_sms_step >= 5 in the same deploy (see migration SQL).
const STEP_MINUTES = {
  1: 10, 2: 120, 3: 360, 4: 1440, 5: 2160,
  6: 2880, 7: 4320, 8: 7200, 9: 10080, 10: 14400,
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
  if (nextStep > 10) return null;

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
    case 1: break;                                 // welcome + demo
    case 2:                                         // branding
      if (checklist.hasLogo && checklist.hasColors) return getNextEligibleStep({ ...agency, activation_sms_step: nextStep });
      break;
    case 3: break;                                 // test client
    case 4:                                         // connect Stripe
      if (checklist.hasStripeCharges) return getNextEligibleStep({ ...agency, activation_sms_step: nextStep });
      break;
    case 5: break;                                 // Marketing Kit (always send)
    case 6:                                         // signup page / first outreach
      if (checklist.hasClient) return getNextEligibleStep({ ...agency, activation_sms_step: nextStep });
      break;
    case 7:                                         // Stripe reminder
      if (checklist.hasStripeCharges) return getNextEligibleStep({ ...agency, activation_sms_step: nextStep });
      break;
    case 8: break;                                 // checklist status
    case 9:                                         // Free -> Pro upsell
      if (agency.plan_type !== 'free' && agency.plan_type !== 'starter') return getNextEligibleStep({ ...agency, activation_sms_step: nextStep });
      break;
    case 10:                                        // final push
      if (checklist.hasClient) return getNextEligibleStep({ ...agency, activation_sms_step: nextStep });
      break;
  }

  return { step: nextStep };
}

// ============================================================================
// GET MESSAGE FOR STEP
// ============================================================================
// Step number -> message. The template KEYS are unchanged from before (so the
// sms_templates rows keep their keys); only the step NUMBER that triggers each
// shifted when the Marketing Kit step was inserted at 5. Copy: no links, no
// em-dashes, no emojis, founder voice (rewrite approved 2026-09, applied
// 2026-10). Links were removed for A2P deliverability; agencies are already in
// the dashboard PWA and the signup link lives on their marketing site.
async function getStepMessage(step, agency, urls) {
  const name = agency.name || 'there';

  switch (step) {
    case 1: {
      const demoPhone = agency.demo_phone_number || null;
      const msg = await getSmsTemplate('activation_sms_1', { name, demo_phone: demoPhone, dashboard_url: urls.dashboardUrl });
      if (msg) return msg;
      if (demoPhone) return `Hey ${name}, it's Gibson, the founder of VoiceAI Connect. Your agency is live.\n\nFastest way to get what you're selling: call your demo receptionist and hear it yourself. It's ${demoPhone}.\n\nThat number is your sales tool. Give it to anyone on the fence about AI for their business. Reply here if you get stuck on anything.`;
      return `Hey ${name}, it's Gibson, the founder of VoiceAI Connect. Your agency is live.\n\nOpen your dashboard and take a look at your test client. It's a real working AI receptionist, so you can see exactly what your clients get. Reply here if you have any questions.`;
    }
    case 2: {
      const needsLogo = !agency.logo_url;
      const needsColors = !(agency.primary_color && agency.primary_color !== '#10b981');
      const msg = await getSmsTemplate('activation_sms_2', { name, settings_url: urls.settingsUrl });
      if (msg) return msg;
      if (needsLogo && needsColors) return `Hey ${name}, before you show this to anyone, make it yours. Add your logo and brand colors in Settings and everything your clients see becomes your brand instead of ours. Right now it's still showing ours.`;
      if (needsLogo) return `${name}, your colors look good. Add your logo in Settings and the look is done, your clients will see your brand everywhere.`;
      return `${name}, your logo's up. Set your brand colors in Settings so everything matches your agency.`;
    }
    case 3: {
      const msg = await getSmsTemplate('activation_sms_3', { name, clients_url: urls.clientsUrl });
      return msg || `${name}, you've got a test client in your dashboard with a live AI receptionist and a real number.\n\nTwo things worth doing: call that number to hear the AI, and open the test client from your Clients page to see the dashboard they'll get. It's exactly what your clients experience.`;
    }
    case 4: {
      const stripeStarted = !!agency.stripe_account_id;
      const msg = await getSmsTemplate('activation_sms_4', { name, settings_url: urls.settingsUrl });
      if (msg) return msg;
      if (stripeStarted) return `${name}, looks like you started connecting Stripe but didn't finish. Until it's done, anyone who signs up can't actually pay you. It's a 2-minute finish in Settings, under Payments.`;
      return `${name}, one important step before you land a client: connect Stripe in Settings, under Payments, so you can get paid. Without it, a client who signs up can't pay you. Takes about 2 minutes.`;
    }
    case 5: {
      const msg = await getSmsTemplate('activation_sms_marketing_kit', { name });
      return msg || `${name}, you don't have to make any sales material yourself. Your Outreach tab has a Marketing Kit: branded QR codes, a one-page flyer, and a leave-behind you can hand a local business, plus cold-call and text scripts. It's all there when you're ready to reach out.`;
    }
    case 6: {
      const msg = await getSmsTemplate('activation_sms_5', { name, signup_url: urls.signupUrl });
      return msg || `${name}, your signup page and demo line are already live on your marketing site. The fastest way to land client #1: get one local business to call your demo and hear the AI answer as their own receptionist. That call does the selling.`;
    }
    case 7: {
      const stripeStarted7 = !!agency.stripe_account_id;
      const msg = await getSmsTemplate('activation_sms_6', { name, settings_url: urls.settingsUrl });
      if (msg) return msg;
      if (stripeStarted7) return `Hey ${name}, your Stripe setup still isn't finished, so clients can't pay you yet. It's usually a 2-minute wrap-up in Settings, under Payments.`;
      return `Hey ${name}, heads up, your agency still can't accept payments. A client who tries to subscribe won't be able to pay you. Connect Stripe in Settings, under Payments. About 2 minutes.`;
    }
    case 8: {
      const stats8 = await getAgencyStats(agency.id);
      const cl = getChecklistStatus(agency, stats8);
      const missing = [];
      if (!cl.hasLogo) missing.push('Upload your logo');
      if (!cl.hasColors) missing.push('Set your brand colors');
      if (!cl.hasPricing) missing.push('Configure client pricing');
      if (!cl.hasStripe) missing.push('Connect Stripe');
      if (!cl.hasClient) missing.push('Add your first client');
      const done = 5 - missing.length;
      if (missing.length === 0) {
        const msg = await getSmsTemplate('activation_sms_7_complete', { name, signup_url: urls.signupUrl });
        return msg || `${name}, your agency is fully set up. Logo, colors, pricing, Stripe, and your first client, all done.\n\nNow it's about volume. Keep getting your signup link in front of prospects.`;
      } else {
        const checklist = missing.map(m => `- ${m}`).join('\n');
        const msg = await getSmsTemplate('activation_sms_7_progress', { name, checklist, done, total: 5, login_url: urls.loginUrl });
        return msg || `${name}, you're ${done} of 5 on your setup checklist. Here's what's left:\n\n${checklist}\n\nYou can knock these out from your dashboard. Reply here if anything's unclear.`;
      }
    }
    case 9: {
      const msg = await getSmsTemplate('activation_sms_8', { name, settings_url: urls.settingsUrl });
      return msg || `${name}, you're on the Free plan, which means your clients still see VoiceAI Connect's name instead of yours.\n\nPro is $99/mo and gives you full white-label, your own marketing site, and a custom domain. Your clients never know we exist. You can upgrade from Settings, under Billing, whenever you're ready.`;
    }
    case 10: {
      const msg = await getSmsTemplate('activation_sms_9', { name, signup_url: urls.signupUrl });
      return msg || `${name}, your platform is built and just waiting on a first client.\n\nThe agencies that land one in the first couple weeks are the ones that actually build recurring revenue from this. Your signup page is ready in your dashboard.\n\nWant help with outreach? Just reply to this text, I read these.`;
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
      .lt('activation_sms_step', 10)
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
          activation_sms_step: 10,
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
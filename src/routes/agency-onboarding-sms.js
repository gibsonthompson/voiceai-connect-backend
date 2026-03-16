// ============================================================================
// AGENCY ONBOARDING ENGAGEMENT SMS - Cron Handler
// Conditional nudge sequence based on what the agency has/hasn't done.
//
// Unlike abandoned cart (which fires linearly), each step here has a
// CONDITION. If the agency already completed the action, the step is
// silently skipped (no SMS, step incremented) so the next cron run
// picks up the next relevant nudge.
//
// Step 1:  2 hours   — Upload logo/branding     (skip if logo_url set)
// Step 2:  6 hours   — Connect Stripe            (skip if stripe_charges_enabled)
// Step 3:  24 hours  — Add a test client          (skip if client_count > 0)
// Step 4:  48 hours  — Stripe Connect reminder    (skip if stripe_charges_enabled)
// Step 5:  Day 3     — Share your signup link      (skip if client_count >= 2)
// Step 6:  Day 5     — Progress check (dynamic)   (skip if everything done)
// Step 7:  Day 7     — Midpoint momentum           (skip if has paying client)
// Step 8:  Day 10    — Urgency / trial ending      (skip if subscribed)
// Step 9:  Day 13    — Final nudge                  (skip if subscribed)
//
// Endpoint: POST /api/cron/agency-onboarding-sms
// Called by cron-job.org every hour
// ============================================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { sendTelnyxSMS, formatPhoneE164 } = require('../lib/notifications');

// ============================================================================
// TIMING THRESHOLDS (minutes after signup)
// ============================================================================
const STEP_THRESHOLDS = {
  1: 120,        // 2 hours
  2: 360,        // 6 hours
  3: 1440,       // 24 hours (1 day)
  4: 2880,       // 48 hours (2 days)
  5: 4320,       // 72 hours (3 days)
  6: 7200,       // 120 hours (5 days)
  7: 10080,      // 168 hours (7 days)
  8: 14400,      // 240 hours (10 days)
  9: 18720       // 312 hours (13 days)
};

// ============================================================================
// CONDITION CHECKS
// Returns true if the agency has ALREADY completed the action
// (meaning: skip this step, don't send the nudge)
// ============================================================================
function isStepAlreadyDone(step, agency, clientCount) {
  switch (step) {
    case 1: // Branding — skip if logo uploaded
      return !!agency.logo_url;

    case 2: // Stripe Connect — skip if charges enabled
      return !!agency.stripe_charges_enabled;

    case 3: // Add test client — skip if has any clients
      return clientCount > 0;

    case 4: // Stripe Connect reminder — skip if charges enabled
      return !!agency.stripe_charges_enabled;

    case 5: // Share signup link — skip if 2+ clients
      return clientCount >= 2;

    case 6: // Progress check — skip if branding + Stripe + clients all done
      return !!agency.logo_url && !!agency.stripe_charges_enabled && clientCount > 0;

    case 7: // Midpoint — skip if they have a paying/active client
      // We can't easily check paying client status here without another query,
      // so we just check if they have 2+ clients (good enough proxy)
      return clientCount >= 2;

    case 8: // Urgency — skip if subscribed (not pending/trialing)
      return agency.subscription_status === 'active';

    case 9: // Final — skip if subscribed
      return agency.subscription_status === 'active';

    default:
      return false;
  }
}

// ============================================================================
// MESSAGE TEMPLATES
// ============================================================================
function getOnboardingMessage(step, agency, clientCount) {
  const name = agency.name || 'there';
  const platformUrl = 'https://myvoiceaiconnect.com';
  const loginUrl = `${platformUrl}/agency/login`;
  const settingsUrl = `${platformUrl}/agency/settings`;

  // Build the agency's client signup URL
  let signupUrl;
  if (agency.marketing_domain && agency.domain_verified) {
    signupUrl = `https://${agency.marketing_domain}/signup`;
  } else if (agency.slug) {
    signupUrl = `https://${agency.slug}.myvoiceaiconnect.com/signup`;
  } else {
    signupUrl = `${platformUrl}/signup`;
  }

  switch (step) {
    case 1: // 2 hours — Branding nudge
      return (
        `Hey ${name}, quick win for your agency 🎨\n\n` +
        `Upload your logo and set your brand colors — it takes 30 seconds and everything your clients see will be YOUR brand, not ours.\n\n` +
        `${settingsUrl}?tab=profile`
      );

    case 2: // 6 hours — Stripe Connect
      return (
        `${name}, one important setup step left: connect Stripe so you can collect payments from your clients.\n\n` +
        `It takes about 2 minutes and you'll be ready to start earning recurring revenue.\n\n` +
        `${settingsUrl}?tab=payments`
      );

    case 3: // 24 hours — Add a test client
      return (
        `Pro tip: add yourself as a test client to see exactly what your customers will experience.\n\n` +
        `You'll have a live AI receptionist answering calls for a real business in under 2 minutes — that's the same setup your clients get.\n\n` +
        `${platformUrl}/agency/clients`
      );

    case 4: // 48 hours — Stripe Connect reminder
      return (
        `Hey ${name}, just a heads up — your agency isn't set up to accept payments yet.\n\n` +
        `Without Stripe connected, clients who try to subscribe won't be able to pay you.\n\n` +
        `Connect now (takes 2 min):\n` +
        `${settingsUrl}?tab=payments`
      );

    case 5: // Day 3 — Share your signup link
      return (
        `${name}, your client signup page is live:\n` +
        `${signupUrl}\n\n` +
        `Share it in your outreach, add it to your website, or DM it directly to a prospect.\n\n` +
        `Every business that signs up gets their own AI receptionist — and pays YOU monthly.`
      );

    case 6: { // Day 5 — Progress check (dynamic)
      const missing = [];
      if (!agency.logo_url) missing.push('Upload your logo');
      if (!agency.stripe_charges_enabled) missing.push('Connect Stripe');
      if (clientCount === 0) missing.push('Add your first client');

      if (missing.length === 0) {
        return (
          `${name}, your agency is fully set up! 💪\n\n` +
          `Branding ✅\nStripe ✅\nClients ✅\n\n` +
          `Time to scale. Share your signup link with more prospects:\n` +
          `${signupUrl}`
        );
      }

      return (
        `${name}, you're making progress! Here's what's left to get your agency 100% ready:\n\n` +
        missing.map(item => `→ ${item}`).join('\n') +
        `\n\nLog in: ${loginUrl}`
      );
    }

    case 7: // Day 7 — Midpoint momentum
      return (
        `${name}, you're halfway through your free trial.\n\n` +
        `Agencies that land their first client in week 1 are far more likely to build real recurring revenue.\n\n` +
        `Your signup page is ready for prospects:\n` +
        `${signupUrl}\n\n` +
        `Need help? Call or text (678) 316-1454`
      );

    case 8: { // Day 10 — Urgency
      let daysMsg = 'a few days left';
      if (agency.trial_ends_at) {
        const daysLeft = Math.max(0, Math.ceil((new Date(agency.trial_ends_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
        daysMsg = daysLeft === 1 ? '1 day left' : `${daysLeft} days left`;
      }
      return (
        `${name}, ${daysMsg} on your trial.\n\n` +
        `Everything you've built — your branding, clients, AI assistants — stays active when you subscribe.\n\n` +
        `Lock in your plan:\n` +
        `${settingsUrl}?tab=billing`
      );
    }

    case 9: { // Day 13 — Final
      let expiryMsg = 'your VoiceAI Connect trial ends soon';
      if (agency.trial_ends_at) {
        const daysLeft = Math.max(0, Math.ceil((new Date(agency.trial_ends_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
        if (daysLeft <= 1) expiryMsg = 'your VoiceAI Connect trial ends tomorrow';
        else expiryMsg = `your VoiceAI Connect trial ends in ${daysLeft} days`;
      }
      return (
        `${name}, ${expiryMsg}.\n\n` +
        `After that, your agency dashboard and all client AI receptionists will be paused.\n\n` +
        `Subscribe to keep everything running:\n` +
        `${settingsUrl}?tab=billing`
      );
    }

    default:
      return null;
  }
}

// ============================================================================
// DETERMINE NEXT STEP FOR AN AGENCY
// Returns { step, skip } or null if not eligible
// - skip=true means the condition is already met, increment without sending
// - skip=false means send the message
// ============================================================================
function getNextStep(agency, clientCount) {
  const currentStep = agency.onboarding_sms_step || 0;
  const nextStep = currentStep + 1;

  // All 9 steps sent
  if (nextStep > 9) return null;

  // Check time threshold
  const signupTime = new Date(agency.created_at).getTime();
  const now = Date.now();
  const minutesSinceSignup = (now - signupTime) / (1000 * 60);

  const threshold = STEP_THRESHOLDS[nextStep];
  if (minutesSinceSignup < threshold) return null;

  // Enforce minimum gap between sends (30 min for this sequence)
  if (agency.onboarding_sms_last_sent_at) {
    const lastSent = new Date(agency.onboarding_sms_last_sent_at).getTime();
    const minutesSinceLastSent = (now - lastSent) / (1000 * 60);
    if (minutesSinceLastSent < 30) return null;
  }

  // Check condition
  const alreadyDone = isStepAlreadyDone(nextStep, agency, clientCount);

  return { step: nextStep, skip: alreadyDone };
}

// ============================================================================
// CRON ENDPOINT
// POST /api/cron/agency-onboarding-sms
// ============================================================================
router.post('/agency-onboarding-sms', async (req, res) => {
  const cronSecret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('📬 Running agency onboarding engagement SMS check...');

    // Fetch agencies that:
    // 1. Are in trial or pending (not yet paying, not canceled)
    // 2. Haven't received all 9 steps
    // 3. Have a phone number
    // 4. Have completed at least onboarding step 1 (so we have their real name/phone)
    const { data: agencies, error } = await supabase
      .from('agencies')
      .select('id, name, slug, email, phone, logo_url, stripe_charges_enabled, ' +
              'stripe_account_id, marketing_domain, domain_verified, country, ' +
              'subscription_status, onboarding_completed, onboarding_step, ' +
              'trial_ends_at, created_at, onboarding_sms_step, onboarding_sms_last_sent_at')
      .in('subscription_status', ['pending', 'trialing', 'trial'])
      .lt('onboarding_sms_step', 9)
      .not('phone', 'is', null)
      .gte('onboarding_step', 2) // Past step 1 = we have their real name/phone
      .order('created_at', { ascending: true });

    if (error) {
      console.error('❌ Onboarding SMS query error:', error);
      return res.status(500).json({ error: 'Database query failed' });
    }

    if (!agencies || agencies.length === 0) {
      console.log('✅ No agencies to nudge');
      return res.json({ success: true, processed: 0, sent: 0, skipped: 0 });
    }

    console.log(`📋 Found ${agencies.length} agencies to check`);

    // Batch fetch client counts for all these agencies
    const agencyIds = agencies.map(a => a.id);
    const { data: clientCounts, error: countError } = await supabase
      .rpc('get_client_counts_by_agency', { agency_ids: agencyIds });

    // Fallback: if RPC doesn't exist, query manually
    let clientCountMap = {};
    if (countError || !clientCounts) {
      console.log('⚠️ RPC not available, fetching client counts individually...');
      for (const agency of agencies) {
        const { count } = await supabase
          .from('clients')
          .select('id', { count: 'exact', head: true })
          .eq('agency_id', agency.id);
        clientCountMap[agency.id] = count || 0;
      }
    } else {
      clientCounts.forEach(row => {
        clientCountMap[row.agency_id] = row.client_count;
      });
    }

    let sent = 0;
    let skipped = 0;
    let skippedDone = 0;
    const results = [];

    for (const agency of agencies) {
      const clientCount = clientCountMap[agency.id] || 0;
      const result = getNextStep(agency, clientCount);

      if (!result) {
        skipped++;
        continue;
      }

      const { step, skip } = result;

      // If condition already met, silently skip (increment step, no SMS)
      if (skip) {
        await supabase
          .from('agencies')
          .update({ onboarding_sms_step: step })
          .eq('id', agency.id);

        skippedDone++;
        results.push({
          agency: agency.name,
          step,
          status: 'skipped_done',
          reason: 'Action already completed'
        });
        continue;
      }

      // Format phone
      const formattedPhone = formatPhoneE164(agency.phone, agency.country || 'US');
      if (!formattedPhone) {
        console.log(`⚠️ Invalid phone for ${agency.name}: ${agency.phone}`);
        skipped++;
        continue;
      }

      // Get message
      const message = getOnboardingMessage(step, agency, clientCount);
      if (!message) {
        skipped++;
        continue;
      }

      // Send SMS
      console.log(`📱 Sending onboarding step ${step} to ${agency.name} (${formattedPhone})`);
      const smsSent = await sendTelnyxSMS(formattedPhone, message);

      if (smsSent) {
        await supabase
          .from('agencies')
          .update({
            onboarding_sms_step: step,
            onboarding_sms_last_sent_at: new Date().toISOString()
          })
          .eq('id', agency.id);

        sent++;
        results.push({
          agency: agency.name,
          step,
          status: 'sent'
        });
        console.log(`✅ Step ${step} sent to ${agency.name}`);
      } else {
        results.push({
          agency: agency.name,
          step,
          status: 'failed'
        });
        console.log(`❌ Failed to send step ${step} to ${agency.name}`);
      }
    }

    console.log(`📬 Onboarding SMS complete: ${sent} sent, ${skippedDone} skipped (done), ${skipped} not ready`);

    res.json({
      success: true,
      processed: agencies.length,
      sent,
      skipped_done: skippedDone,
      skipped_not_ready: skipped,
      results
    });

  } catch (error) {
    console.error('❌ Onboarding SMS cron error:', error);
    res.status(500).json({ error: 'Cron job failed', message: error.message });
  }
});

// ============================================================================
// MANUAL TEST ENDPOINT
// POST /api/cron/agency-onboarding-sms/test/:agencyId
// Body: { step: 3 } (optional — force a specific step)
// ============================================================================
router.post('/agency-onboarding-sms/test/:agencyId', async (req, res) => {
  const cronSecret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { agencyId } = req.params;
    const { step: forceStep } = req.body;

    const { data: agency, error } = await supabase
      .from('agencies')
      .select('*')
      .eq('id', agencyId)
      .single();

    if (error || !agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    // Get client count
    const { count: clientCount } = await supabase
      .from('clients')
      .select('id', { count: 'exact', head: true })
      .eq('agency_id', agencyId);

    const targetStep = forceStep || (agency.onboarding_sms_step || 0) + 1;

    if (targetStep > 9) {
      return res.json({ success: false, message: 'All 9 steps already sent' });
    }

    const formattedPhone = formatPhoneE164(agency.phone, agency.country || 'US');
    if (!formattedPhone) {
      return res.json({ success: false, message: `Invalid phone: ${agency.phone}` });
    }

    const conditionMet = isStepAlreadyDone(targetStep, agency, clientCount || 0);
    const message = getOnboardingMessage(targetStep, agency, clientCount || 0);

    console.log(`🧪 Test: step ${targetStep} for ${agency.name} | condition_met: ${conditionMet}`);

    if (!message) {
      return res.json({ success: false, message: 'No message for this step' });
    }

    const smsSent = await sendTelnyxSMS(formattedPhone, message);

    if (smsSent) {
      await supabase
        .from('agencies')
        .update({
          onboarding_sms_step: targetStep,
          onboarding_sms_last_sent_at: new Date().toISOString()
        })
        .eq('id', agencyId);
    }

    res.json({
      success: smsSent,
      agency: agency.name,
      step: targetStep,
      condition_already_met: conditionMet,
      would_skip_in_cron: conditionMet,
      phone: formattedPhone,
      message_preview: message.substring(0, 100) + '...',
      client_count: clientCount || 0
    });

  } catch (error) {
    console.error('❌ Test onboarding SMS error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
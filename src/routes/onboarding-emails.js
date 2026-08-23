// ============================================================================
// ONBOARDING EMAIL SEQUENCE (cron)
// ----------------------------------------------------------------------------
// A short, checklist-gated EMAIL sequence that reaches new agencies after they
// sign up and nudges them toward their first live client. It runs alongside the
// existing activation SMS sequence (activation-sms.js) but stays deliberately
// short (3 emails over ~6 days) so agencies are not double-blasted across
// channels. Every step is skipped once the agency has done the thing it asks
// for, and the whole sequence stops the moment the agency onboards a real
// client (that is the goal, so there is nothing left to nudge).
//
// Drive it exactly like the other cron jobs: an external scheduler POSTs to
//   POST /api/cron/onboarding-emails
// with the x-cron-secret header. Hourly is fine; the timing gates below decide
// who is actually due.
//
// REQUIRES two columns on agencies (run the migration before scheduling this,
// or the query below will error and nothing will send):
//   onboarding_email_step          integer NOT NULL DEFAULT 0
//   onboarding_email_last_sent_at  timestamptz
//
//   ALTER TABLE agencies
//     ADD COLUMN IF NOT EXISTS onboarding_email_step integer NOT NULL DEFAULT 0,
//     ADD COLUMN IF NOT EXISTS onboarding_email_last_sent_at timestamptz;
//
// Register in server.js next to the other cron routers:
//   const onboardingEmailRoutes = require('./routes/onboarding-emails');
//   app.use('/api/cron', onboardingEmailRoutes);
// ============================================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { sendEmail } = require('../lib/notifications');
const { renderBrandedEmail } = require('../lib/email-layout');

const FROM = 'VoiceAI Connect <onboarding@myvoiceaiconnect.com>';

// Minutes after created_at before each step is allowed to send.
// 1: ~1 day, 2: ~3 days, 3: ~6 days.
const STEP_MINUTES = { 1: 1440, 2: 4320, 3: 8640 };

// Minimum gap between any two emails to the same agency.
const MIN_MINUTES_BETWEEN = 1440;

// Do not touch signups older than this when the job first goes live, so the
// back catalog never gets a surprise blast. Only genuinely recent signups are
// in the sequence window.
const MAX_AGE_DAYS = 21;

// ============================================================================
// URLS
// ============================================================================
function getAgencyUrls(agency) {
  const platformDomain = process.env.PLATFORM_DOMAIN || 'myvoiceaiconnect.com';
  const platformUrl = `https://${platformDomain}`;
  return {
    dashboardUrl: `${platformUrl}/agency/dashboard`,
    settingsUrl: `${platformUrl}/agency/settings`,
    clientsUrl: `${platformUrl}/agency/clients`,
    loginUrl: `${platformUrl}/agency/login`,
  };
}

// ============================================================================
// AGENCY STATS + CHECKLIST (same rules as the activation SMS sequence)
// ============================================================================
async function getAgencyStats(agencyId) {
  const { data: clients } = await supabase
    .from('clients')
    .select('id, is_test_client')
    .eq('agency_id', agencyId);
  const realClients = (clients || []).filter(c => !c.is_test_client);
  return { realClientCount: realClients.length };
}

function getChecklistStatus(agency, stats) {
  const DEFAULT_PRICES = { starter: 4900, pro: 9900, growth: 14900 };
  return {
    hasPricing: !!(
      (agency.price_starter ?? DEFAULT_PRICES.starter) !== DEFAULT_PRICES.starter ||
      (agency.price_pro ?? DEFAULT_PRICES.pro) !== DEFAULT_PRICES.pro ||
      (agency.price_growth ?? DEFAULT_PRICES.growth) !== DEFAULT_PRICES.growth
    ),
    hasStripeCharges: !!agency.stripe_charges_enabled,
    hasClient: stats.realClientCount > 0,
  };
}

// ============================================================================
// NEXT ELIGIBLE STEP
// Returns { step } when an email is due, or null when nothing is due yet.
// hasClient (activation) is handled by the caller, which stops the sequence.
// ============================================================================
function getNextEligibleStep(agency, checklist) {
  const currentStep = agency.onboarding_email_step || 0;
  const nextStep = currentStep + 1;
  if (nextStep > 3) return null;

  const anchor = agency.created_at;
  const minutesSinceSignup = (Date.now() - new Date(anchor).getTime()) / 60000;
  if (minutesSinceSignup < STEP_MINUTES[nextStep]) return null;

  if (agency.onboarding_email_last_sent_at) {
    const minutesSinceLast = (Date.now() - new Date(agency.onboarding_email_last_sent_at).getTime()) / 60000;
    if (minutesSinceLast < MIN_MINUTES_BETWEEN) return null;
  }

  // Step 2 is the billing-setup nudge. If they already set pricing and Stripe
  // can charge, the nudge is moot, so advance past it.
  if (nextStep === 2 && checklist.hasPricing && checklist.hasStripeCharges) {
    return getNextEligibleStep({ ...agency, onboarding_email_step: nextStep }, checklist);
  }

  return { step: nextStep };
}

// ============================================================================
// EMAIL CONTENT
// ============================================================================
function getStepEmail(step, agency, urls) {
  const name = agency.name || 'there';

  if (step === 1) {
    const bodyHtml =
      `<p style="margin:0 0 16px;">Hi ${name}, your agency is set up. Here is the single move that gets you paid the fastest.</p>` +
      `<p style="margin:0 0 16px;">Pick one prospect this week and have them call your demo receptionist. They hear the AI answer as their business, handle a real question, and the value sells itself. You do not have to pitch it.</p>` +
      `<p style="margin:0 0 16px;">You do not need a finished website or a full client list to do this. You need one phone call.</p>`;
    return {
      subject: 'The fastest path to your first client',
      preheader: 'One phone call is all it takes to prove the value.',
      heading: 'Put your demo receptionist to work',
      bodyHtml,
      cta: { label: 'Open your dashboard', url: urls.dashboardUrl },
    };
  }

  if (step === 2) {
    const bodyHtml =
      `<p style="margin:0 0 16px;">Hi ${name}, when your first client says yes, you want billing ready so you are not scrambling.</p>` +
      `<p style="margin:0 0 8px;font-weight:700;color:#0f172a;">Two things make that happen:</p>` +
      `<ol style="margin:0 0 16px;padding-left:20px;color:#334155;">` +
      `<li style="margin:0 0 6px;">Set your client pricing in the dashboard. This is what your clients pay you.</li>` +
      `<li style="margin:0;">Connect Stripe so those payments land straight in your account.</li>` +
      `</ol>` +
      `<p style="margin:0;">Ten minutes now saves you a stalled deal later.</p>`;
    return {
      subject: 'Get ready to charge your first client',
      preheader: 'Set pricing and connect Stripe before the first yes.',
      heading: 'Get ready to charge',
      bodyHtml,
      cta: { label: 'Set pricing and connect Stripe', url: urls.settingsUrl },
    };
  }

  // step === 3
  const bodyHtml =
    `<p style="margin:0 0 16px;">Hi ${name}, if you have not onboarded a client yet, you are not behind. You are one conversation away.</p>` +
    `<p style="margin:0 0 16px;">The agencies that get traction all do the same first thing: they let a prospect hear the AI answer a real call. Everything else follows from that one demo.</p>` +
    `<p style="margin:0;">Reply to this email with the kind of client you are going after and we will tell you exactly how to set the demo up for them.</p>`;
  return {
    subject: 'Still no clients live? Here is the one move',
    preheader: 'You are one conversation away from your first client.',
    heading: 'One move to your first client',
    bodyHtml,
    cta: { label: 'Add your first client', url: urls.clientsUrl },
  };
}

// ============================================================================
// CRON HANDLER
// ============================================================================
router.post('/onboarding-emails', async (req, res) => {
  const cronSecret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('📧 Running onboarding email check...');

    const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 86400000).toISOString();

    const { data: agencies, error } = await supabase
      .from('agencies')
      .select('*')
      .in('subscription_status', ['trialing', 'trial', 'active', 'free', 'pending'])
      .lt('onboarding_email_step', 3)
      .not('email', 'is', null)
      .gte('created_at', cutoff)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('❌ Onboarding email query error:', error);
      return res.status(500).json({ error: 'Database query failed' });
    }

    if (!agencies || agencies.length === 0) {
      console.log('✅ No onboarding emails to process');
      return res.json({ success: true, processed: 0, sent: 0 });
    }

    console.log(`📋 Found ${agencies.length} agencies to check for onboarding email`);
    let sent = 0, skipped = 0;
    const results = [];

    for (const agency of agencies) {
      if (agency.status === 'suspended') { skipped++; continue; }
      // Still mid abandoned-cart flow: let that sequence run first.
      if (agency.subscription_status === 'pending' && (agency.abandoned_cart_step || 0) < 5) { skipped++; continue; }

      const stats = await getAgencyStats(agency.id);
      const checklist = getChecklistStatus(agency, stats);

      // Activated. The goal is met, so stop the sequence for good.
      if (checklist.hasClient) {
        await supabase.from('agencies')
          .update({ onboarding_email_step: 3, onboarding_email_last_sent_at: new Date().toISOString() })
          .eq('id', agency.id);
        results.push({ agency: agency.name, status: 'activated_stopped' });
        skipped++;
        continue;
      }

      const next = getNextEligibleStep(agency, checklist);
      if (!next) { skipped++; continue; }
      const { step } = next;

      const urls = getAgencyUrls(agency);
      const email = getStepEmail(step, agency, urls);
      if (!email) { skipped++; continue; }

      console.log(`📧 Sending onboarding email step ${step} to ${agency.name} (${agency.email})`);

      const result = await sendEmail({
        from: FROM,
        to: agency.email,
        subject: email.subject,
        html: renderBrandedEmail({
          preheader: email.preheader,
          heading: email.heading,
          bodyHtml: email.bodyHtml,
          cta: email.cta,
        }),
      });

      // Advance the step whether the send succeeded or failed, so a broken
      // address never gets retried in a loop (mirrors the SMS sequence).
      await supabase.from('agencies')
        .update({ onboarding_email_step: step, onboarding_email_last_sent_at: new Date().toISOString() })
        .eq('id', agency.id);

      if (result && result.success) {
        sent++;
        results.push({ agency: agency.name, step, status: 'sent' });
        console.log(`✅ Onboarding email step ${step} sent to ${agency.name}`);
      } else {
        results.push({ agency: agency.name, step, status: 'failed_advanced' });
        console.log(`❌ Failed onboarding email step ${step} for ${agency.name} , advancing step`);
      }
    }

    console.log(`📧 Onboarding email complete: ${sent} sent, ${skipped} skipped out of ${agencies.length}`);
    res.json({ success: true, processed: agencies.length, sent, skipped, results });
  } catch (error) {
    console.error('❌ Onboarding email cron error:', error);
    res.status(500).json({ error: 'Cron job failed', message: error.message });
  }
});

module.exports = router;
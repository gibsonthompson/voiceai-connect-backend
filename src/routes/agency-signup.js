// ============================================================================
// AGENCY SIGNUP & ONBOARDING
// UPDATED: Removed premature signup notification SMS (fired with temp name).
// UPDATED: 2026-07-27. Moved the admin activation SMS OUT of onboarding step 1
//          entirely. It now fires only at real activation, with the plan: free
//          via the start-trial route (POST /api/agency/:id/notify-activated),
//          paid via handleAgencyCheckoutCompleted in stripe-platform.js.
// UPDATED: 2026-05-07 - Default plan_type changed to 'free', signup status
//          changed to 'active' (free tier requires no payment to start).
// UPDATED: 2026-05-09 - Set onboarding_completed_at timestamp when onboarding
//          finishes, used by activation SMS sequence for timing.
// UPDATED: 2026-05-10 - Default prices changed to $99/$149/$299, starter plan
//          features updated (email summaries, caller recognition, business
//          hours, after-hours mode now included).
// UPDATED: 2026-05-14 - REVERTED signup status back to pending/pending_payment.
//          The May 7 change to active at signup broke ALL automated SMS
//          sequences (abandoned cart, onboarding engagement) because those
//          crons filter for subscription_status='pending'. Activation now
//          happens in /api/agency/start-trial after onboarding completes,
//          which correctly sets active + onboarding_completed=true.
// UPDATED: 2026-08-07 - Added two_way_sms to DEFAULT_PLAN_FEATURES (Lane 2).
//          It gates whether a client on a given plan tier gets two-way text
//          messaging. Seeded off for starter, on for pro/growth (mirrors
//          google_calendar). For a non-US BYOT agency this flag, ANDed with a
//          saved mobile bundle, is what drives provisioning a text-capable
//          mobile number at client signup. US two-way texting is unaffected.
// UPDATED: 2026-08-17 - Signup dedupe hardening. Two agencies signed up back to
//          back with the same phone and a one-character-different email
//          (chadab15@gmail.com vs the typo chadab15@gmai.com). The old email
//          check was an exact lower(trim) match, so the typo slipped through,
//          and phone was never checked at all. Now:
//            (1) EMAIL is matched on a gmail-aware NORMALIZED form (dots and
//                +tags stripped, googlemail unified to gmail) so alias farming
//                collapses to one account. Backed by a DB unique index on the
//                generated normalized_email column (see the migration), so the
//                database is the real backstop, not app code. A 23505 on insert
//                is caught and returned as a clean 409.
//            (2) PHONE is a SOFT check (no DB unique constraint, by design: the
//                platform's own number has dozens of test rows and some real
//                businesses legitimately share a line). A signup is blocked when
//                the same digits already belong to an agency that is active or
//                trial, or a pending_payment created in the last 24h (the true
//                back-to-back case). Long-dead suspended rows and old abandoned
//                pending rows never burn a number. An env allowlist
//                (SIGNUP_PHONE_ALLOWLIST, seeded with the platform number) lets
//                internal testing bypass the check.
//          Both new checks fail OPEN if their generated columns are missing, so
//          deploying this before the migration cannot break signups; the
//          existing exact-email unique constraint still applies as a floor.
// ============================================================================
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { supabase } = require('../lib/supabase');
const { sendAgencyWelcomeEmail, sendAgencyWelcomeSMS } = require('../lib/notifications');
const { seedDefaultTemplatesIfNeeded } = require('../lib/default-templates');

// ============================================================================
// DEDUPE NORMALIZATION
// ----------------------------------------------------------------------------
// normalizeEmail MUST mirror the SQL generated column agencies.normalized_email
// exactly, or the app pre-check and the DB unique index could disagree. Both
// use the FIRST '@' to split, lowercase+trim, and for gmail/googlemail strip
// the +tag then strip dots in the local part and unify the domain to gmail.com.
// ============================================================================
function normalizeEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.indexOf('@');
  if (at < 0) return e;
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    const cleanedLocal = local.replace(/\+.*$/, '').replace(/\./g, '');
    return `${cleanedLocal}@gmail.com`;
  }
  return e;
}

// Digits only, mirroring the SQL normalized_phone column. Empty -> null.
function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length ? digits : null;
}

// Phone numbers allowed to bypass the soft duplicate check (internal testing).
// Seeded with the platform's own number so signup testing never trips. Add more
// via SIGNUP_PHONE_ALLOWLIST (comma-separated), any formatting is stripped.
const PHONE_ALLOWLIST = new Set(
  (process.env.SIGNUP_PHONE_ALLOWLIST || '6783161454')
    .split(',')
    .map((s) => s.replace(/\D/g, ''))
    .filter(Boolean)
);

// ============================================================================
// SLUG GENERATION
// ============================================================================
function generateSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 30);
}

async function ensureUniqueSlug(baseSlug, excludeAgencyId = null) {
  let slug = baseSlug;
  let counter = 1;

  while (true) {
    let query = supabase
      .from('agencies')
      .select('id')
      .eq('slug', slug);

    if (excludeAgencyId) {
      query = query.neq('id', excludeAgencyId);
    }

    const { data } = await query.single();

    if (!data) break;

    slug = `${baseSlug}-${counter}`;
    counter++;
  }

  return slug;
}

// ============================================================================
// PASSWORD TOKEN
// ============================================================================
function generatePasswordToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function createPasswordToken(userId, email) {
  const token = generatePasswordToken();
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + 24);

  await supabase.from('password_reset_tokens').insert({
    user_id: userId,
    email: email,
    token: token,
    expires_at: expiresAt.toISOString(),
    used: false
  });

  return token;
}

// ============================================================================
// COUNTRY -> CURRENCY MAPPING
// ============================================================================
const COUNTRY_CURRENCY_MAP = {
  US: 'USD', CA: 'CAD', MX: 'MXN', GB: 'GBP',
  AT: 'EUR', BE: 'EUR', BG: 'BGN', HR: 'EUR', CY: 'EUR', CZ: 'CZK',
  DK: 'DKK', EE: 'EUR', FI: 'EUR', FR: 'EUR', DE: 'EUR', GR: 'EUR',
  HU: 'HUF', IE: 'EUR', IT: 'EUR', LV: 'EUR', LT: 'EUR', LU: 'EUR',
  MT: 'EUR', NL: 'EUR', NO: 'NOK', PL: 'PLN', PT: 'EUR', RO: 'RON',
  SK: 'EUR', SI: 'EUR', ES: 'EUR', SE: 'SEK', CH: 'CHF',
  AU: 'AUD', NZ: 'NZD', JP: 'JPY', SG: 'SGD', HK: 'HKD',
  MY: 'MYR', TH: 'THB', IN: 'INR', AE: 'AED', BR: 'BRL',
};

function getCurrencyForCountry(countryCode) {
  return COUNTRY_CURRENCY_MAP[countryCode] || 'USD';
}

// ============================================================================
// DEFAULT PLAN FEATURES - seeded on every new agency
// ----------------------------------------------------------------------------
// two_way_sms gates two-way text messaging for a client on this plan tier. It
// is off for starter, on for pro/growth (same shape as google_calendar). For a
// non-US BYOT agency, this flag ANDed with a saved Mobile Bundle SID is what
// drives provisioning a text-capable MOBILE number at client signup. This copy
// must stay in sync with the frontend DEFAULT_PLAN_FEATURES in the agency
// settings pricing tab, which renders the toggle.
// ============================================================================
const DEFAULT_PLAN_FEATURES = {
  starter: {
    sms_notifications: true,
    two_way_sms: false,
    email_summaries: true,
    custom_greeting: false,
    custom_voice: false,
    knowledge_base: false,
    business_hours: true,
    google_calendar: false,
    advanced_analytics: false,
    priority_support: false,
    caller_recognition: true,
    spam_detection: true,
    call_transfer: false,
    transfer_fallback: false,
    after_hours_mode: true,
  },
  pro: {
    sms_notifications: true,
    two_way_sms: true,
    email_summaries: true,
    custom_greeting: true,
    custom_voice: false,
    knowledge_base: true,
    business_hours: true,
    google_calendar: true,
    advanced_analytics: true,
    priority_support: false,
    caller_recognition: true,
    spam_detection: true,
    call_transfer: true,
    transfer_fallback: true,
    after_hours_mode: true,
  },
  growth: {
    sms_notifications: true,
    two_way_sms: true,
    email_summaries: true,
    custom_greeting: true,
    custom_voice: true,
    knowledge_base: true,
    business_hours: true,
    google_calendar: true,
    advanced_analytics: true,
    priority_support: true,
    caller_recognition: true,
    spam_detection: true,
    call_transfer: true,
    transfer_fallback: true,
    after_hours_mode: true,
  },
};

// ============================================================================
// VALIDATE AGENCY SIGNUP
// ============================================================================
function validateAgencySignup(body) {
  const errors = [];

  if (!body.email || !body.email.includes('@')) {
    errors.push('Valid email is required');
  }
  if (!body.firstName || body.firstName.trim().length < 1) {
    errors.push('First name is required');
  }

  return errors;
}

// ============================================================================
// DUPLICATE CHECKS
// ----------------------------------------------------------------------------
// emailAlreadyTaken: matches on the normalized_email generated column so gmail
// aliases collapse to one account. Falls back to an exact lower(trim) match on
// the raw email column if the normalized column does not exist yet (handler
// deployed before the migration). The DB unique index is the real backstop; a
// racing insert that beats this check is caught as a 23505 at insert time.
async function emailAlreadyTaken(rawEmail) {
  const normalized = normalizeEmail(rawEmail);
  try {
    const { data, error } = await supabase
      .from('agencies')
      .select('id')
      .eq('normalized_email', normalized)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (data) return true;
  } catch (e) {
    // normalized_email column missing (pre-migration) or transient error: fall
    // back to the exact-email check, which the existing unique constraint also
    // enforces. Fail closed on a genuine match, open on infra error.
    console.warn('Normalized email check unavailable, falling back to exact match:', e.message);
    const { data } = await supabase
      .from('agencies')
      .select('id')
      .eq('email', String(rawEmail || '').trim().toLowerCase())
      .limit(1)
      .maybeSingle();
    if (data) return true;
  }
  return false;
}

// phoneAlreadyInUse: SOFT check. Blocks only when the same digits belong to an
// agency that is committed (active/trial) or a very recent pending_payment (the
// genuine back-to-back duplicate). Old abandoned pending rows and dead suspended
// rows never burn a number. Allowlisted numbers bypass entirely. Fails OPEN on
// any error (a soft guard must never break signups): a missing normalized_phone
// column or infra hiccup simply skips the check.
async function phoneAlreadyInUse(rawPhone) {
  const normalized = normalizePhone(rawPhone);
  if (!normalized) return false;
  if (PHONE_ALLOWLIST.has(normalized)) return false;

  try {
    const cutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('agencies')
      .select('id, status, created_at')
      .eq('normalized_phone', normalized)
      .in('status', ['active', 'trial', 'pending_payment'])
      .limit(50);
    if (error) throw error;

    return (data || []).some((a) =>
      a.status === 'active' ||
      a.status === 'trial' ||
      (a.status === 'pending_payment' && a.created_at && a.created_at > cutoffIso)
    );
  } catch (e) {
    console.warn('Phone dedupe check skipped (non-blocking):', e.message);
    return false;
  }
}

// ============================================================================
// REFERRAL SOURCE LABELS
// ============================================================================
const REFERRAL_SOURCE_LABELS = {
  'google_search': 'Google Search',
  'ai_recommendation': 'AI (ChatGPT/Claude/Perplexity)',
  'linkedin': 'LinkedIn',
  'twitter': 'Twitter/X',
  'facebook_instagram': 'Facebook/Instagram',
  'youtube': 'YouTube',
  'podcast': 'Podcast',
  'friend_colleague': 'Friend/Colleague',
  'blog_article': 'Blog/Article',
  'other': 'Other',
};

function getReferralSourceLabel(source) {
  return REFERRAL_SOURCE_LABELS[source] || source || 'Not specified';
}

// ============================================================================
// REFERRAL ATTRIBUTION HELPER
// ============================================================================
async function attributeReferral(agencyId, referralCode) {
  try {
    if (!referralCode) return { success: false, reason: 'No referral code provided' };

    const cleanCode = referralCode.toLowerCase().trim();

    const { data: referrer } = await supabase
      .from('agencies')
      .select('id, referral_code')
      .eq('referral_code', cleanCode)
      .single();

    if (!referrer) {
      return { success: false, reason: 'Invalid referral code' };
    }

    if (referrer.id === agencyId) {
      return { success: false, reason: 'Cannot use own referral code' };
    }

    const { error } = await supabase
      .from('agencies')
      .update({ referred_by: cleanCode })
      .eq('id', agencyId);

    if (error) {
      console.error('Error attributing referral:', error);
      return { success: false, reason: error.message };
    }

    console.log(`🤝 Referral attributed: ${agencyId} referred by ${cleanCode}`);
    return { success: true, referrerCode: cleanCode };

  } catch (error) {
    console.error('Error attributing referral:', error);
    return { success: false, reason: error.message };
  }
}

// ============================================================================
// AGENCY SIGNUP HANDLER
// ============================================================================
async function handleAgencySignup(req, res) {
  try {
    console.log('📝 Agency Signup Request');

    const validationErrors = validateAgencySignup(req.body);
    if (validationErrors.length > 0) {
      return res.status(400).json({
        error: 'Validation failed',
        errors: validationErrors
      });
    }

    const {
      email,
      firstName,
      lastName,
      referralCode,
      name: agencyName,
      phone,
      country
    } = req.body;

    // Check for duplicate email (gmail-aware normalized match; DB unique index
    // is the hard backstop).
    if (await emailAlreadyTaken(email)) {
      return res.status(409).json({
        error: 'Account already exists',
        message: 'An agency with this email already exists. Please log in.'
      });
    }

    // Check for duplicate phone (soft: committed or very-recent accounts only,
    // allowlist bypass, fail-open).
    if (await phoneAlreadyInUse(phone)) {
      return res.status(409).json({
        error: 'phone_exists',
        message: 'An account with this phone number already exists. Please log in, or contact support if you need another workspace.'
      });
    }

    const tempName = agencyName || `${firstName}'s Agency`;
    const baseSlug = generateSlug(tempName);
    const slug = await ensureUniqueSlug(baseSlug);

    // Resolve country and currency
    const resolvedCountry = country || 'US';
    const resolvedCurrency = getCurrencyForCountry(resolvedCountry);

    console.log(`🏢 Creating agency for: ${firstName} ${lastName || ''} (${email}) [${resolvedCountry}/${resolvedCurrency}]`);

    // Create agency record
    // NOTE: Status starts as pending. Activation happens in /api/agency/start-trial
    // after onboarding completes (handles both free and paid plans).
    // This is critical: abandoned cart and onboarding engagement SMS crons
    // filter for subscription_status='pending' to find agencies that need nudging.
    const { data: agency, error: agencyError } = await supabase
      .from('agencies')
      .insert({
        name: tempName,
        slug: slug,
        email: email.toLowerCase(),
        phone: phone || null,
        country: resolvedCountry,
        currency: resolvedCurrency,
        status: 'pending_payment',
        subscription_status: 'pending',
        plan_type: 'free',
        onboarding_step: 1,
        onboarding_completed: false,
        primary_color: '#10b981',
        secondary_color: '#059669',
        accent_color: '#34d399',
        price_starter: 9900,
        price_pro: 14900,
        price_growth: 29900,
        limit_starter: 50,
        limit_pro: 150,
        limit_growth: 500,
        plan_features: DEFAULT_PLAN_FEATURES,
        referral_code: slug
      })
      .select()
      .single();

    if (agencyError) {
      // 23505 = unique violation. This fires when a duplicate raced past the
      // pre-check above and hit the DB unique index (raw email, or the new
      // normalized_email index). Surface it as a clean 409, not a 500.
      if (agencyError.code === '23505') {
        console.warn('Duplicate agency insert blocked by DB constraint:', agencyError.message);
        return res.status(409).json({
          error: 'Account already exists',
          message: 'An agency with this email already exists. Please log in.'
        });
      }
      console.error('❌ Agency creation error:', agencyError);
      throw agencyError;
    }

    console.log(`✅ Agency created: ${agency.id}`);

    // Attribute referral if code provided
    if (referralCode) {
      const result = await attributeReferral(agency.id, referralCode);
      if (result.success) {
        console.log(`🤝 Referral attributed: referred by ${result.referrerCode}`);
      } else {
        console.log(`⚠️ Referral attribution failed: ${result.reason}`);
      }
    }

    // Seed default outreach templates
    const templateResult = await seedDefaultTemplatesIfNeeded(agency.id);
    if (templateResult.success && !templateResult.skipped) {
      console.log(`✅ Default templates seeded: ${templateResult.count} templates`);
    }

    // Create user record
    const { data: user, error: userError } = await supabase
      .from('users')
      .insert({
        agency_id: agency.id,
        email: email.toLowerCase(),
        first_name: firstName,
        last_name: lastName || null,
        role: 'agency_owner',
        password_hash: null
      })
      .select()
      .single();

    if (userError) {
      console.error('❌ User creation error:', userError);
      throw userError;
    }

    console.log(`✅ Agency user created: ${user.id}`);

    // Generate password token
    const token = await createPasswordToken(user.id, email.toLowerCase());

    // Send welcome email (non-blocking)
    try {
      await sendAgencyWelcomeEmail(agency, token);
    } catch (emailError) {
      console.warn('⚠️ Welcome email failed (non-blocking):', emailError.message);
    }

    // REMOVED: sendAgencySignupNotificationSMS here.
    // It was firing with temp name ("firstName's Agency") causing a duplicate SMS.
    // The real notification now only fires in handleAgencyOnboarding step 1,
    // after the agency sets their actual name and phone number.

    // Welcome SMS to agency owner (non-blocking)
    console.log('📱 Sending welcome SMS to agency owner...');
    try {
      await sendAgencyWelcomeSMS(agency, token);
    } catch (smsError) {
      console.warn('⚠️ Agency welcome SMS failed (non-blocking):', smsError.message);
    }

    console.log('🎉 Agency signup complete:', email);

    res.status(200).json({
      success: true,
      agencyId: agency.id,
      token: token,
      message: 'Account created! Complete setup to get started.',
      agency: {
        id: agency.id,
        name: agency.name,
        slug: agency.slug,
      }
    });

  } catch (error) {
    console.error('❌ Agency signup error:', error);
    res.status(500).json({
      error: 'Signup failed',
      message: 'Something went wrong. Please try again.'
    });
  }
}

// ============================================================================
// AGENCY ONBOARDING HANDLER
// ============================================================================
// STEP MAP (aligned with trimmed frontend onboarding page):
//   1 = Agency Details (name, phone, referral source)
//   2 = Password (handled client-side via /auth/set-password, not this handler)
//
// Legacy steps 2-6 still handled for backwards compatibility:
//   2 = Pricing (prices + call limits)
//   3 = Logo upload
//   4 = Brand colors + theme
//   5 = Password step
//   6 = Complete
// ============================================================================
async function handleAgencyOnboarding(req, res) {
  try {
    const { agency_id, step, data } = req.body;

    if (!agency_id || !step) {
      return res.status(400).json({ error: 'agency_id and step required' });
    }

    const { data: agency, error } = await supabase
      .from('agencies')
      .select('*')
      .eq('id', agency_id)
      .single();

    if (error || !agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    console.log(`📝 Onboarding step ${step} for: ${agency.name}`);

    let updateData = {
      onboarding_step: step + 1,
      updated_at: new Date().toISOString()
    };

    switch (step) {
      case 1: // Agency Details
        if (data.name && data.name.trim()) {
          updateData.name = data.name.trim();

          const baseSlug = generateSlug(data.name);
          const uniqueSlug = await ensureUniqueSlug(baseSlug, agency_id);
          updateData.slug = uniqueSlug;
          updateData.referral_code = uniqueSlug;

          console.log(`📛 Agency name set: ${data.name} (slug: ${uniqueSlug})`);
        }
        if (data.phone !== undefined) {
          updateData.phone = data.phone || null;
        }
        if (data.referral_source !== undefined) {
          updateData.referral_source = data.referral_source || null;
          console.log(`📊 Referral source: ${getReferralSourceLabel(data.referral_source)}`);
        }
        // Country now captured at onboarding (was previously only set as a
        // Stripe Connect side effect, which left non-US agencies with no
        // country until they connected Stripe, breaking SMS routing). Keep
        // currency in sync so paid pricing renders in the right currency.
        if (data.country) {
          const resolvedCountry = String(data.country).toUpperCase();
          updateData.country = resolvedCountry;
          updateData.currency = getCurrencyForCountry(resolvedCountry);
          console.log(`🌍 Country set: ${resolvedCountry} (currency: ${updateData.currency})`);
        }
        break;

      case 2: // Pricing
        if (data.price_starter !== undefined) updateData.price_starter = data.price_starter;
        if (data.price_pro !== undefined) updateData.price_pro = data.price_pro;
        if (data.price_growth !== undefined) updateData.price_growth = data.price_growth;
        if (data.limit_starter !== undefined) updateData.limit_starter = data.limit_starter;
        if (data.limit_pro !== undefined) updateData.limit_pro = data.limit_pro;
        if (data.limit_growth !== undefined) updateData.limit_growth = data.limit_growth;
        break;

      case 3: // Logo upload
        if (data.logo_url !== undefined) {
          updateData.logo_url = data.logo_url || null;
        }
        if (data.logo_background_color !== undefined) {
          updateData.logo_background_color = data.logo_background_color || null;
        }
        break;

      case 4: // Brand colors + theme
        if (data.primary_color) updateData.primary_color = data.primary_color;
        if (data.secondary_color) updateData.secondary_color = data.secondary_color;
        if (data.accent_color) updateData.accent_color = data.accent_color;
        if (data.website_theme && (data.website_theme === 'light' || data.website_theme === 'dark')) {
          updateData.website_theme = data.website_theme;
          console.log(`🎨 Theme set from logo: ${data.website_theme}`);
        }
        if (data.logo_background_color !== undefined) {
          updateData.logo_background_color = data.logo_background_color || null;
        }
        break;

      case 5: // Password step
        updateData.onboarding_completed = true;
        updateData.onboarding_completed_at = new Date().toISOString();
        break;

      case 6: // Complete
        updateData.onboarding_completed = true;
        updateData.onboarding_completed_at = new Date().toISOString();
        break;
    }

    await supabase
      .from('agencies')
      .update(updateData)
      .eq('id', agency_id);

    // NOTE: The admin "agency activated" SMS is NOT sent here anymore. Saving a
    // name + phone in onboarding step 1 is not activation, it is just an early
    // step toward it (plan, password, and card still come after). Firing here
    // produced a premature "signup" text before the agency committed. The
    // notification now fires only at real activation, with the chosen plan:
    //   Free -> app/api/agency/start-trial POSTs /api/agency/:id/notify-activated
    //   Paid -> handleAgencyCheckoutCompleted in routes/stripe-platform.js

    res.json({
      success: true,
      step: step,
      next_step: step < 6 ? step + 1 : null,
      completed: step >= 6
    });

  } catch (error) {
    console.error('❌ Onboarding error:', error);
    res.status(500).json({ error: 'Onboarding step failed' });
  }
}

// ============================================================================
// EXPORTS
// ============================================================================
module.exports = {
  handleAgencySignup,
  handleAgencyOnboarding,
  attributeReferral,
  createPasswordToken,
  getReferralSourceLabel,
  getCurrencyForCountry,
  normalizeEmail,
  normalizePhone,
};
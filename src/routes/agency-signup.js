// ============================================================================
// AGENCY SIGNUP & ONBOARDING
// ============================================================================
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { supabase } = require('../lib/supabase');
const { sendAgencyWelcomeEmail, sendAgencySignupNotificationSMS, sendAgencyWelcomeSMS } = require('../lib/notifications');
const { seedDefaultTemplatesIfNeeded } = require('../lib/default-templates');

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
// COUNTRY → CURRENCY MAPPING
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
// DEFAULT PLAN FEATURES — seeded on every new agency
// ============================================================================
const DEFAULT_PLAN_FEATURES = {
  starter: {
    sms_notifications: true,
    email_summaries: false,
    custom_greeting: false,
    custom_voice: false,
    knowledge_base: false,
    business_hours: false,
    google_calendar: false,
    advanced_analytics: false,
    priority_support: false,
    // AI Tools
    caller_recognition: false,
    spam_detection: true,
    call_transfer: false,
    transfer_fallback: false,
    after_hours_mode: false,
  },
  pro: {
    sms_notifications: true,
    email_summaries: true,
    custom_greeting: true,
    custom_voice: false,
    knowledge_base: true,
    business_hours: true,
    google_calendar: true,
    advanced_analytics: true,
    priority_support: false,
    // AI Tools
    caller_recognition: true,
    spam_detection: true,
    call_transfer: true,
    transfer_fallback: true,
    after_hours_mode: true,
  },
  growth: {
    sms_notifications: true,
    email_summaries: true,
    custom_greeting: true,
    custom_voice: true,
    knowledge_base: true,
    business_hours: true,
    google_calendar: true,
    advanced_analytics: true,
    priority_support: true,
    // AI Tools
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
    
    // Check for duplicate email
    const { data: existing } = await supabase
      .from('agencies')
      .select('id')
      .eq('email', email.toLowerCase())
      .single();
    
    if (existing) {
      return res.status(409).json({ 
        error: 'Account already exists',
        message: 'An agency with this email already exists. Please log in.'
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
        plan_type: 'starter',
        onboarding_step: 1,
        onboarding_completed: false,
        primary_color: '#10b981',
        secondary_color: '#059669',
        accent_color: '#34d399',
        price_starter: 4900,
        price_pro: 9900,
        price_growth: 14900,
        limit_starter: 50,
        limit_pro: 150,
        limit_growth: 500,
        plan_features: DEFAULT_PLAN_FEATURES,
        referral_code: slug
      })
      .select()
      .single();
    
    if (agencyError) {
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
    
    // Notify platform owner (non-blocking)
    console.log('📱 Notifying platform owner of new agency signup...');
    try {
      await sendAgencySignupNotificationSMS(agency);
    } catch (smsError) {
      console.warn('⚠️ Agency signup SMS notification failed (non-blocking):', smsError.message);
    }
    
    // Welcome SMS to agency owner (non-blocking)
    // UPDATED: Pass password token so SMS links to /auth/set-password instead of /agency/login
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
// STEP MAP (aligned with frontend onboarding page):
//   1 = Agency Details (name, phone, referral source)
//   2 = Pricing (prices + call limits)
//   3 = Logo upload (base64 data URL saved directly to logo_url)
//   4 = Brand colors (primary, secondary, accent) + theme from logo bg detection
//   5 = Password (handled client-side via /auth/set-password, not this handler)
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
        // Accept logo background color detected by frontend
        if (data.logo_background_color !== undefined) {
          updateData.logo_background_color = data.logo_background_color || null;
        }
        break;
        
      case 4: // Brand colors + theme
        if (data.primary_color) updateData.primary_color = data.primary_color;
        if (data.secondary_color) updateData.secondary_color = data.secondary_color;
        if (data.accent_color) updateData.accent_color = data.accent_color;
        // Accept website_theme auto-detected from logo background
        if (data.website_theme && (data.website_theme === 'light' || data.website_theme === 'dark')) {
          updateData.website_theme = data.website_theme;
          console.log(`🎨 Theme set from logo: ${data.website_theme}`);
        }
        // Also accept logo_background_color here (in case sent with colors step)
        if (data.logo_background_color !== undefined) {
          updateData.logo_background_color = data.logo_background_color || null;
        }
        break;
        
      case 5: // Password step
        updateData.onboarding_completed = true;
        break;
        
      case 6: // Complete
        updateData.onboarding_completed = true;
        break;
    }
    
    await supabase
      .from('agencies')
      .update(updateData)
      .eq('id', agency_id);
    
    // If step 1 completed, send updated SMS
    if (step === 1 && data.name) {
      try {
        const { data: updatedAgency } = await supabase
          .from('agencies')
          .select('*')
          .eq('id', agency_id)
          .single();
        
        if (updatedAgency) {
          await sendAgencySignupNotificationSMS(updatedAgency);
        }
      } catch (smsError) {
        console.warn('⚠️ Updated agency SMS notification failed (non-blocking):', smsError.message);
      }
    }
    
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
  getCurrencyForCountry
};
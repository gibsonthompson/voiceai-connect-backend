// ============================================================================
// AGENCY SIGNUP & ONBOARDING
// ============================================================================
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { supabase } = require('../lib/supabase');
const { sendAgencyWelcomeEmail, sendAgencySignupNotificationSMS } = require('../lib/notifications');
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
    
    // Exclude current agency when updating slug
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
// VALIDATE AGENCY SIGNUP (SIMPLIFIED - just email and firstName required)
// ============================================================================
function validateAgencySignup(body) {
  const errors = [];
  
  // Name and phone are now optional - collected in onboarding step 1
  if (!body.email || !body.email.includes('@')) {
    errors.push('Valid email is required');
  }
  if (!body.firstName || body.firstName.trim().length < 1) {
    errors.push('First name is required');
  }
  
  return errors;
}

// ============================================================================
// REFERRAL SOURCE LABELS (for SMS/display)
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

    // Verify referral code exists and isn't self-referral
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

    // Update the new agency with referred_by
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
// AGENCY SIGNUP HANDLER (SIMPLIFIED)
// Only requires: email, firstName, lastName
// Agency name and phone collected in onboarding step 1
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
      // Optional - if provided, skip onboarding step 1
      name: agencyName,
      phone 
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
    
    // Generate temp agency name from user's first name (updated in onboarding step 1)
    const tempName = agencyName || `${firstName}'s Agency`;
    const baseSlug = generateSlug(tempName);
    const slug = await ensureUniqueSlug(baseSlug);
    
    console.log(`🏢 Creating agency for: ${firstName} ${lastName || ''} (${email})`);
    
    // Create agency record
    const { data: agency, error: agencyError } = await supabase
      .from('agencies')
      .insert({
        name: tempName,
        slug: slug,
        email: email.toLowerCase(),
        phone: phone || null,
        status: 'pending_payment',
        subscription_status: 'pending',
        plan_type: 'starter',
        onboarding_step: 1, // Start at step 1 (agency details)
        onboarding_completed: false,
        // Default branding
        primary_color: '#10b981',
        secondary_color: '#059669',
        accent_color: '#34d399',
        // Default pricing
        price_starter: 4900,
        price_pro: 9900,
        price_growth: 14900,
        // Default limits
        limit_starter: 50,
        limit_pro: 150,
        limit_growth: 500,
        // Referral code defaults to slug
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
    
    // Create user record WITHOUT password (will be set via set-password page after onboarding)
    const { data: user, error: userError } = await supabase
      .from('users')
      .insert({
        agency_id: agency.id,
        email: email.toLowerCase(),
        first_name: firstName,
        last_name: lastName || null,
        role: 'agency_owner',
        password_hash: null  // No password at signup
      })
      .select()
      .single();
    
    if (userError) {
      console.error('❌ User creation error:', userError);
      throw userError;
    }
    
    console.log(`✅ Agency user created: ${user.id}`);
    
    // Generate password token for set-password flow (used after onboarding)
    const token = await createPasswordToken(user.id, email.toLowerCase());
    
    // Send welcome email (optional - skip if not configured)
    try {
      await sendAgencyWelcomeEmail(agency, token);
    } catch (emailError) {
      console.warn('⚠️ Welcome email failed (non-blocking):', emailError.message);
    }
    
    // ============================================
    // NOTIFY PLATFORM OWNER OF NEW AGENCY SIGNUP
    // ============================================
    console.log('📱 Notifying platform owner of new agency signup...');
    try {
      await sendAgencySignupNotificationSMS(agency);
    } catch (smsError) {
      console.warn('⚠️ Agency signup SMS notification failed (non-blocking):', smsError.message);
    }
    
    console.log('🎉 Agency signup complete:', email);
    
    res.status(200).json({
      success: true,
      agencyId: agency.id,
      token: token,  // Return token - frontend stores for use after onboarding
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
// AGENCY ONBOARDING HANDLER (UPDATED - 7 steps with agency details as step 1)
// Step 1: Agency name + phone + referral source
// Step 2: Logo upload
// Step 3: Brand colors
// Step 4: Pricing
// Step 5: Stripe Connect
// Step 6: Set Password
// Step 7: Complete
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
      case 1: // Agency Details (includes referral source)
        if (data.name && data.name.trim()) {
          updateData.name = data.name.trim();
          
          // Generate new slug from agency name
          const baseSlug = generateSlug(data.name);
          const uniqueSlug = await ensureUniqueSlug(baseSlug, agency_id);
          updateData.slug = uniqueSlug;
          updateData.referral_code = uniqueSlug; // Update referral code too
          
          console.log(`📛 Agency name set: ${data.name} (slug: ${uniqueSlug})`);
        }
        if (data.phone !== undefined) {
          updateData.phone = data.phone || null;
        }
        // Save referral source
        if (data.referral_source !== undefined) {
          updateData.referral_source = data.referral_source || null;
          console.log(`📊 Referral source: ${getReferralSourceLabel(data.referral_source)}`);
        }
        break;
        
      case 2: // Logo upload
        if (data.logo_url !== undefined) {
          updateData.logo_url = data.logo_url || null;
        }
        break;
        
      case 3: // Brand colors
        if (data.primary_color) updateData.primary_color = data.primary_color;
        if (data.secondary_color) updateData.secondary_color = data.secondary_color;
        if (data.accent_color) updateData.accent_color = data.accent_color;
        break;
        
      case 4: // Pricing
        if (data.price_starter !== undefined) updateData.price_starter = data.price_starter;
        if (data.price_pro !== undefined) updateData.price_pro = data.price_pro;
        if (data.price_growth !== undefined) updateData.price_growth = data.price_growth;
        if (data.limit_starter !== undefined) updateData.limit_starter = data.limit_starter;
        if (data.limit_pro !== undefined) updateData.limit_pro = data.limit_pro;
        if (data.limit_growth !== undefined) updateData.limit_growth = data.limit_growth;
        break;
        
      case 5: // Stripe Connect (handled separately via /api/agency/connect/onboard)
        break;
        
      case 6: // Password step (handled by frontend redirect to /auth/set-password)
        updateData.onboarding_completed = true;
        break;
        
      case 7: // Complete
        updateData.onboarding_completed = true;
        break;
    }
    
    await supabase
      .from('agencies')
      .update(updateData)
      .eq('id', agency_id);
    
    // If step 1 completed and we now have agency name + referral source, send updated SMS
    if (step === 1 && data.name) {
      try {
        // Fetch updated agency data
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
      next_step: step < 7 ? step + 1 : null,
      completed: step >= 7
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
  getReferralSourceLabel
};
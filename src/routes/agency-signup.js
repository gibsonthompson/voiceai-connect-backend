// ============================================================================
// AGENCY SIGNUP & ONBOARDING
// ============================================================================
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { supabase } = require('../lib/supabase');
const { sendAgencyWelcomeEmail } = require('../lib/notifications');

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

async function ensureUniqueSlug(baseSlug) {
  let slug = baseSlug;
  let counter = 1;
  
  while (true) {
    const { data } = await supabase
      .from('agencies')
      .select('id')
      .eq('slug', slug)
      .single();
    
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
// VALIDATE AGENCY SIGNUP
// ============================================================================
function validateAgencySignup(body) {
  const errors = [];
  
  if (!body.name || body.name.trim().length < 2) {
    errors.push('Agency name is required (min 2 characters)');
  }
  if (!body.email || !body.email.includes('@')) {
    errors.push('Valid email is required');
  }
  if (!body.phone || body.phone.replace(/\D/g, '').length < 10) {
    errors.push('Valid phone number is required');
  }
  if (!body.firstName || body.firstName.trim().length < 1) {
    errors.push('First name is required');
  }
  if (!body.password || body.password.length < 6) {
    errors.push('Password is required (min 6 characters)');
  }
  
  return errors;
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
    
    const { name, email, phone, firstName, lastName, password } = req.body;
    
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
    
    // Generate unique slug
    const baseSlug = generateSlug(name);
    const slug = await ensureUniqueSlug(baseSlug);
    
    console.log(`🏢 Creating agency: ${name} (${slug})`);
    
    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);
    
    // Create agency record
    const { data: agency, error: agencyError } = await supabase
      .from('agencies')
      .insert({
        name: name,
        slug: slug,
        email: email.toLowerCase(),
        phone: phone,
        status: 'pending_payment',
        subscription_status: 'pending',
        plan_type: 'starter',
        onboarding_step: 0,
        // Default branding
        primary_color: '#2563eb',
        secondary_color: '#1e40af',
        accent_color: '#3b82f6',
        // Default pricing
        price_starter: 4900,
        price_pro: 9900,
        price_growth: 14900,
        // Default limits
        limit_starter: 50,
        limit_pro: 150,
        limit_growth: 500
      })
      .select()
      .single();
    
    if (agencyError) {
      console.error('❌ Agency creation error:', agencyError);
      throw agencyError;
    }
    
    console.log(`✅ Agency created: ${agency.id}`);
    
    // Create user record for agency owner with hashed password
    const { data: user, error: userError } = await supabase
      .from('users')
      .insert({
        agency_id: agency.id,
        email: email.toLowerCase(),
        first_name: firstName,
        last_name: lastName || null,
        role: 'agency_owner',
        password_hash: passwordHash
      })
      .select()
      .single();
    
    if (userError) {
      console.error('❌ User creation error:', userError);
      throw userError;
    }
    
    console.log(`✅ Agency user created: ${user.id}`);
    
    // Generate password token (for password reset if needed later)
    const token = await createPasswordToken(user.id, email.toLowerCase());
    
    // Send welcome email (optional - skip if not configured)
    try {
      await sendAgencyWelcomeEmail(agency, token);
    } catch (emailError) {
      console.warn('⚠️ Welcome email failed (non-blocking):', emailError.message);
    }
    
    console.log('🎉 Agency signup complete:', name);
    
    res.status(200).json({
      success: true,
      agencyId: agency.id,
      message: 'Agency created! Check your email to complete setup.',
      agency: {
        id: agency.id,
        name: agency.name,
        slug: agency.slug,
        url: `https://${slug}.voiceaiconnect.com`
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
// AGENCY ONBOARDING HANDLER (After plan selection)
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
    
    let updateData = { onboarding_step: step };
    
    switch (step) {
      case 1: // Logo upload
        if (data.logo_url) {
          updateData.logo_url = data.logo_url;
        }
        break;
        
      case 2: // Brand colors
        if (data.primary_color) updateData.primary_color = data.primary_color;
        if (data.secondary_color) updateData.secondary_color = data.secondary_color;
        if (data.accent_color) updateData.accent_color = data.accent_color;
        break;
        
      case 3: // Pricing
        if (data.price_starter) updateData.price_starter = data.price_starter;
        if (data.price_pro) updateData.price_pro = data.price_pro;
        if (data.price_growth) updateData.price_growth = data.price_growth;
        if (data.limit_starter) updateData.limit_starter = data.limit_starter;
        if (data.limit_pro) updateData.limit_pro = data.limit_pro;
        if (data.limit_growth) updateData.limit_growth = data.limit_growth;
        break;
        
      case 4: // Stripe Connect (handled separately)
        break;
        
      case 5: // Complete
        updateData.onboarding_completed = true;
        break;
    }
    
    await supabase
      .from('agencies')
      .update(updateData)
      .eq('id', agency_id);
    
    res.json({
      success: true,
      step: step,
      next_step: step < 5 ? step + 1 : null,
      completed: step >= 5
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
  handleAgencyOnboarding
};
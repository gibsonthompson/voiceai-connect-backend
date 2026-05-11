// ============================================================================
// GOOGLE OAUTH ROUTES FOR AGENCY SIGNUP
// ============================================================================

const { OAuth2Client } = require('google-auth-library');
const { supabase } = require('../lib/supabase');
const { generateToken } = require('./auth');
const { createPasswordToken, getCurrencyForCountry } = require('./agency-signup');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://myvoiceaiconnect.com';

const oauth2Client = new OAuth2Client(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI
);

function generateSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 50);
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
// Helper: Check if agency has moved past onboarding
// An agency is "past onboarding" if they have a subscription (trialing/active)
// OR if onboarding_completed is true
// ============================================================================
function isAgencyPastOnboarding(agency) {
  if (!agency) return false;
  if (agency.onboarding_completed) return true;
  // If they have a subscription, they clearly completed onboarding even if the flag is wrong
  const activeStatuses = ['trialing', 'trial', 'active', 'past_due'];
  if (activeStatuses.includes(agency.subscription_status)) return true;
  // If they have a stripe subscription ID, they went through checkout
  if (agency.stripe_subscription_id) return true;
  return false;
}

// GET /api/auth/google
async function googleAuth(req, res) {
  try {
    // Parse all query params - ref and country come from frontend
    const referralCode = req.query.ref || null;
    const country = req.query.country || null;
    
    const scopes = [
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ];

    const state = JSON.stringify({ ref: referralCode, country: country });

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      prompt: 'select_account',
      state: state,
    });

    res.redirect(authUrl);
  } catch (error) {
    console.error('❌ Google auth init error:', error);
    res.redirect(`${FRONTEND_URL}/signup?error=google_auth_failed`);
  }
}

// GET /api/auth/google/callback
async function googleCallback(req, res) {
  try {
    const { code, state } = req.query;
    
    if (!code) {
      return res.redirect(`${FRONTEND_URL}/signup?error=no_code`);
    }

    let referralCode = null;
    let country = null;
    try {
      const stateData = JSON.parse(state || '{}');
      referralCode = stateData.ref;
      country = stateData.country;
    } catch {}

    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    if (!response.ok) {
      throw new Error('Failed to get user info from Google');
    }

    const googleUser = await response.json();
    const { email, given_name, family_name, picture } = googleUser;

    if (!email) {
      return res.redirect(`${FRONTEND_URL}/signup?error=no_email`);
    }

    console.log(`🔐 Google auth for: ${email} [country: ${country || 'not set'}]`);

    // Check if user exists
    const { data: existingUser } = await supabase
      .from('users')
      .select('*, agencies!clients_agency_id_fkey(*)')
      .eq('email', email.toLowerCase())
      .single();

    if (existingUser) {
      if (existingUser.agency_id && existingUser.agencies) {
        const token = generateToken(existingUser);
        const agency = existingUser.agencies;
        
        await supabase
          .from('users')
          .update({ last_login_at: new Date().toISOString() })
          .eq('id', existingUser.id);

        await supabase
          .from('agencies')
          .update({ last_login_at: new Date().toISOString() })
          .eq('id', agency.id);

        // If the agency has moved past onboarding (has subscription, completed flag, etc.)
        // → go straight to dashboard
        if (isAgencyPastOnboarding(agency)) {
          // Also fix onboarding_completed if it was stuck at false
          if (!agency.onboarding_completed) {
            await supabase
              .from('agencies')
              .update({ onboarding_completed: true, onboarding_step: 7 })
              .eq('id', agency.id);
            console.log(`🔧 Fixed onboarding_completed for agency: ${agency.name}`);
          }

          console.log(`✅ Google login: ${email} → dashboard`);
          return res.redirect(`${FRONTEND_URL}/auth/google-success?token=${token}&agencyId=${agency.id}&redirect=/agency/dashboard`);
        }

        // Agency hasn't completed onboarding yet → send to onboarding
        console.log(`✅ Google login: ${email} → onboarding (step ${agency.onboarding_step})`);
        return res.redirect(`${FRONTEND_URL}/auth/google-success?token=${token}&agencyId=${agency.id}&redirect=/onboarding`);
      } else {
        return res.redirect(`${FRONTEND_URL}/signup?error=account_exists`);
      }
    }

    // New user - create agency
    const tempAgencyName = given_name ? `${given_name}'s Agency` : 'My Agency';
    const baseSlug = generateSlug(tempAgencyName);
    const slug = await ensureUniqueSlug(baseSlug);

    // Resolve country and currency
    const resolvedCountry = country || 'US';
    const resolvedCurrency = getCurrencyForCountry(resolvedCountry);

    let referredByAgencyId = null;
    if (referralCode) {
      const { data: referrer } = await supabase
        .from('agencies')
        .select('id')
        .eq('referral_code', referralCode.toLowerCase())
        .single();
      
      if (referrer) {
        referredByAgencyId = referrer.id;
        console.log(`📎 Referral applied: ${referralCode}`);
      }
    }

    const { data: agency, error: agencyError } = await supabase
      .from('agencies')
      .insert({
        name: tempAgencyName,
        slug: slug,
        email: email.toLowerCase(),
        country: resolvedCountry,
        currency: resolvedCurrency,
        status: 'pending_payment',
        subscription_status: 'pending',
        plan_type: 'starter',
        onboarding_step: 1,
        onboarding_completed: false,
        referred_by: referredByAgencyId,
        primary_color: '#10b981',
        secondary_color: '#059669',
        accent_color: '#34d399',
        price_starter: 4900,
        price_pro: 9900,
        price_growth: 14900,
        limit_starter: 50,
        limit_pro: 150,
        limit_growth: 500,
      })
      .select()
      .single();

    if (agencyError) {
      console.error('❌ Agency creation error:', agencyError);
      return res.redirect(`${FRONTEND_URL}/signup?error=signup_failed`);
    }

    console.log(`🏢 Agency created via Google: ${agency.id} [${resolvedCountry}/${resolvedCurrency}]`);

    const { data: user, error: userError } = await supabase
      .from('users')
      .insert({
        agency_id: agency.id,
        email: email.toLowerCase(),
        first_name: given_name || '',
        last_name: family_name || '',
        role: 'agency_owner',
        avatar_url: picture || null,
        password_hash: null,
      })
      .select()
      .single();

    if (userError) {
      console.error('❌ User creation error:', userError);
      await supabase.from('agencies').delete().eq('id', agency.id);
      return res.redirect(`${FRONTEND_URL}/signup?error=signup_failed`);
    }

    const token = generateToken(user);
    const passwordToken = await createPasswordToken(user.id, email.toLowerCase());

    console.log(`✅ Google signup: ${email} | Agency: ${agency.name}`);

    res.redirect(`${FRONTEND_URL}/auth/google-success?token=${token}&passwordToken=${passwordToken}&agencyId=${agency.id}&redirect=/onboarding`);

  } catch (error) {
    console.error('❌ Google callback error:', error);
    res.redirect(`${FRONTEND_URL}/signup?error=google_auth_failed`);
  }
}

module.exports = {
  googleAuth,
  googleCallback,
};
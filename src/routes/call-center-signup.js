// ============================================================================
// CALL CENTER SIGNUP
// ----------------------------------------------------------------------------
// Creates a call_centers account record plus its owner user (role 'cc_owner').
// Separate from agency signup: writes to call_centers + users, sets no agency
// fields. Mirrors the agency pattern (account starts pending; password is set
// via an emailed token flow), but is its own account type end to end.
//
// Mounted at POST /api/cc/signup.
// CREATED: 2026-11-02
// ============================================================================
const crypto = require('crypto');
const { supabase } = require('../lib/supabase');

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
const getCurrencyForCountry = (c) => COUNTRY_CURRENCY_MAP[c] || 'USD';

function generateSlug(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 30);
}

function generatePasswordToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function ensureUniqueCallCenterSlug(baseSlug) {
  const safeBase = (baseSlug && baseSlug.trim()) ? baseSlug.trim() : 'callcenter';
  let slug = safeBase;
  let counter = 1;
  while (true) {
    const { data } = await supabase.from('call_centers').select('id').eq('slug', slug).limit(1).maybeSingle();
    if (!data) break;
    slug = `${safeBase}-${counter}`;
    counter++;
  }
  return slug;
}

// A call-center email is taken if a call_centers row already uses it, or a
// call-center user (cc_* role) already exists with it. (Agencies/clients can
// reuse the same email on their own account type, matching the platform's
// one-email-per-account-type model.)
async function callCenterEmailTaken(rawEmail) {
  const email = (rawEmail || '').toLowerCase().trim();
  if (!email) return false;
  const { data: cc } = await supabase.from('call_centers').select('id').eq('email', email).limit(1).maybeSingle();
  if (cc) return true;
  const { data: u } = await supabase.from('users').select('id').eq('email', email).in('role', ['cc_owner', 'cc_manager', 'cc_agent']).limit(1).maybeSingle();
  return !!u;
}

async function createPasswordToken(userId, email) {
  const token = generatePasswordToken();
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + 24);
  await supabase.from('password_reset_tokens').insert({
    user_id: userId,
    email,
    token,
    expires_at: expiresAt.toISOString(),
    used: false,
  });
  return token;
}

async function handleCallCenterSignup(req, res) {
  try {
    const { email, firstName, lastName, name: ccName, phone, country } = req.body || {};
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email is required' });
    if (!firstName || !firstName.trim()) return res.status(400).json({ error: 'First name is required' });

    const normEmail = email.toLowerCase().trim();
    if (await callCenterEmailTaken(normEmail)) {
      return res.status(409).json({ error: 'account_exists', message: 'A call center with this email already exists. Please log in.' });
    }

    const tempName = (ccName && ccName.trim()) || `${firstName.trim()}'s Call Center`;
    const slug = await ensureUniqueCallCenterSlug(generateSlug(tempName));
    const resolvedCountry = country || 'US';
    const resolvedCurrency = getCurrencyForCountry(resolvedCountry);

    // Create the call-center account record.
    const { data: callCenter, error: ccErr } = await supabase
      .from('call_centers')
      .insert({
        name: tempName,
        slug,
        email: normEmail,
        phone: phone || null,
        country: resolvedCountry,
        currency: resolvedCurrency,
        status: 'pending_payment',
        subscription_status: 'pending',
        plan_type: 'standard',
      })
      .select()
      .single();
    if (ccErr) {
      if (ccErr.code === '23505') {
        return res.status(409).json({ error: 'account_exists', message: 'A call center with these details already exists. Please log in.' });
      }
      console.error('❌ Call center creation error:', ccErr);
      throw ccErr;
    }

    // Create the owner user (password set later via the token flow).
    const { data: user, error: userErr } = await supabase
      .from('users')
      .insert({
        call_center_id: callCenter.id,
        email: normEmail,
        first_name: firstName,
        last_name: lastName || null,
        role: 'cc_owner',
        password_hash: null,
      })
      .select()
      .single();
    if (userErr) {
      console.error('❌ Call center owner user creation error:', userErr);
      throw userErr;
    }

    const token = await createPasswordToken(user.id, normEmail);
    console.log('🎉 Call center signup complete:', normEmail, '→', callCenter.id);

    res.status(200).json({
      success: true,
      callCenterId: callCenter.id,
      token,
      message: 'Account created. Set your password to continue.',
      call_center: { id: callCenter.id, name: callCenter.name, slug: callCenter.slug },
    });
  } catch (error) {
    console.error('❌ Call center signup error:', error);
    res.status(500).json({ error: 'Signup failed' });
  }
}

module.exports = { handleCallCenterSignup };

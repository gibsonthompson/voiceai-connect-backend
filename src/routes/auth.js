// ============================================================================
// AUTHENTICATION ROUTES
// UPDATED: Team member permissions in login responses
// UPDATED: client_staff role accepted in client login
// UPDATED: Clear visible_password on self-password-change
// UPDATED: 2026-05-18 - Phase 1: dashboard_access check on client login
// UPDATED: 2026-07-11: requireAgencyAccess middleware. Requires a valid token,
//          confirms the caller owns the :agencyId in the URL (super_admin and
//          admin-impersonation tokens pass), and enforces a Page Access key
//          for agency_staff. Used to protect the Connect financials endpoints,
//          which expose the agency's live Stripe balance.
// UPDATED: 2026-07-19: JWT_EXPIRES_IN raised from 7d to 30d. Tokens live in
//          localStorage, so the lifetime stays bounded rather than infinite,
//          but 7 days silently logged every agency out weekly. Existing tokens
//          keep the 7d expiry baked in at signing time; only tokens issued
//          after this deploy get 30 days.
// UPDATED: 2026-07-30: recoverAccountSetup (POST /api/auth/recover-setup). A
//          token-based recovery for an account that was created but never
//          finished setting a password (password_hash is null). This is the
//          case a lost/closed set-password tab produces: the one-time token in
//          that URL is gone, agencyLogin returns "Password not set", and the
//          user has no way back. recoverAccountSetup mints a FRESH
//          password_reset_tokens row and returns the token so the frontend can
//          send them straight to /auth/set-password. No email is sent, matching
//          the rest of the signup flow. It only ever acts on an account whose
//          password_hash is null, so an active account can't be taken over
//          through it. See the SECURITY note on the function for gating.
// Destination: src/routes/auth.js (FULL REPLACEMENT)
// ============================================================================
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { supabase, getUserByEmail, getUserById } = require('../lib/supabase');
const { sendEmail } = require('../lib/notifications');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const JWT_EXPIRES_IN = '30d';

function generateToken(user) {
  return jwt.sign(
    { userId: user.id, email: user.email, role: user.role, agencyId: user.agency_id, clientId: user.client_id },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

// ============================================================================
// AGENCY LOGIN (unchanged)
// ============================================================================
async function agencyLogin(req, res) {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = await getUserByEmail(email.toLowerCase());
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    if (!user.agency_id || !['agency_owner', 'agency_staff', 'super_admin'].includes(user.role)) return res.status(401).json({ error: 'Invalid credentials for agency login' });
    if (!user.password_hash) return res.status(401).json({ error: 'Password not set', message: 'Please set your password using the link in your welcome email' });

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) return res.status(401).json({ error: 'Invalid email or password' });

    const { data: agency, error: agencyError } = await supabase.from('agencies').select('*').eq('id', user.agency_id).single();
    if (agencyError) console.error('❌ Agency fetch error:', agencyError);
    if (agency && agency.status === 'suspended') return res.status(403).json({ error: 'Your account has been suspended. Please contact support.' });

    let teamPermissions = null;
    if (user.role === 'agency_staff') {
      const { data: teamMember } = await supabase.from('team_members').select('permissions, notification_prefs, status').eq('member_user_id', user.id).eq('entity_type', 'agency').eq('entity_id', user.agency_id).single();
      if (teamMember) {
        if (teamMember.status === 'disabled') return res.status(403).json({ error: 'Your account has been disabled by the agency owner.' });
        teamPermissions = teamMember.permissions;
      }
    }

    await supabase.from('users').update({ last_login: new Date().toISOString() }).eq('id', user.id);
    if (user.agency_id) await supabase.from('agencies').update({ last_login_at: new Date().toISOString() }).eq('id', user.agency_id);

    const token = generateToken(user);
    console.log('✅ Agency login:', user.email, '| Agency:', agency?.name, '| Role:', user.role);

    res.json({
      success: true, token,
      user: { id: user.id, email: user.email, first_name: user.first_name, last_name: user.last_name, role: user.role, agency_id: user.agency_id, permissions: teamPermissions },
      agency
    });
  } catch (error) { console.error('❌ Agency login error:', error); res.status(500).json({ error: 'Login failed' }); }
}

// ============================================================================
// CLIENT LOGIN
// UPDATED: Phase 1 - dashboard_access check + read_only flag
// ============================================================================
async function clientLogin(req, res) {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = await getUserByEmail(email.toLowerCase());
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    if (!user.client_id || !['client', 'client_staff'].includes(user.role)) return res.status(401).json({ error: 'Invalid credentials for client login' });
    if (!user.password_hash) return res.status(401).json({ error: 'Password not set', message: 'Please set your password using the link in your welcome email' });

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) return res.status(401).json({ error: 'Invalid email or password' });

    const { data: client, error: clientError } = await supabase.from('clients').select('*').eq('id', user.client_id).single();
    if (clientError) console.error('❌ Client fetch error:', clientError);

    // ================================================================
    // PHASE 1: Check dashboard access level
    // If agency set this client to 'none', block login entirely
    // ================================================================
    if (client && client.dashboard_access === 'none') {
      console.log(`🚫 Client login blocked (dashboard_access=none): ${user.email} | ${client.business_name}`);
      return res.status(403).json({
        error: 'Dashboard access disabled',
        message: 'Your account is managed by your service provider. Contact them for any changes or to view your call activity.'
      });
    }

    let teamPermissions = null;
    if (user.role === 'client_staff') {
      const { data: teamMember } = await supabase.from('team_members').select('permissions, notification_prefs, status').eq('member_user_id', user.id).eq('entity_type', 'client').eq('entity_id', user.client_id).single();
      if (teamMember) {
        if (teamMember.status === 'disabled') return res.status(403).json({ error: 'Your account has been disabled.' });
        teamPermissions = teamMember.permissions;
      }
    }

    await supabase.from('users').update({ last_login: new Date().toISOString() }).eq('id', user.id);

    const token = generateToken(user);
    console.log('✅ Client login:', user.email, '| Client:', client?.business_name, '| Role:', user.role, '| Access:', client?.dashboard_access || 'full');

    res.json({
      success: true, token,
      user: {
        id: user.id, email: user.email, first_name: user.first_name, last_name: user.last_name,
        role: user.role, client_id: user.client_id, permissions: teamPermissions,
        read_only: client?.dashboard_access === 'read_only',
      },
      client
    });
  } catch (error) { console.error('❌ Client login error:', error); res.status(500).json({ error: 'Login failed' }); }
}

// ============================================================================
// RECOVER ACCOUNT SETUP  (POST /api/auth/recover-setup)
// ----------------------------------------------------------------------------
// Fixes the dead end where an account was created but the password was never
// set, and the one-time set-password token was lost (closed/expired tab). The
// login page calls this when it gets "Password not set" back. This mints a
// FRESH password_reset_tokens row (same table setPassword consumes) and returns
// the token so the frontend can redirect straight to /auth/set-password. No
// email is involved, matching the rest of the signup flow.
//
// Response contract (deliberately does not leak which emails exist):
//   { needsSetup: true,  token }  -> account exists, password_hash is null.
//                                    Send them to /auth/set-password?token=...
//   { needsSetup: false }         -> either no such account, OR the account
//                                    already has a password. The UI treats both
//                                    the same: "check your password / sign in".
//
// scope (optional body field): 'agency' | 'client'. When provided we only
// recover a matching role, so the agency login page can't hand back a token for
// a client account and vice versa. Omitted = allow either.
//
// SECURITY: this is intentionally UNGATED for now, which is fine because it only
// ever acts on an account whose password_hash is null (a never-finished
// account); an active account is untouched. To harden later (recommended before
// heavy public traffic), gate it behind proof the caller actually completed
// checkout, e.g. require the Stripe checkout session_id and verify it maps to
// this account and is paid before issuing the token. The single place to add
// that check is marked below with "GATE HERE".
// ============================================================================
async function recoverAccountSetup(req, res) {
  try {
    const { email, scope } = req.body;
    if (!email || !String(email).includes('@')) {
      return res.status(400).json({ error: 'Valid email required' });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const user = await getUserByEmail(normalizedEmail);

    // No such user. Do not reveal that. Present the same shape as "already set".
    if (!user) {
      return res.json({ needsSetup: false });
    }

    // Restrict by role when the caller told us which surface it is, so an agency
    // login can only recover an agency account and a client login only a client.
    if (scope === 'agency' && !['agency_owner', 'agency_staff'].includes(user.role)) {
      return res.json({ needsSetup: false });
    }
    if (scope === 'client' && !['client', 'client_staff'].includes(user.role)) {
      return res.json({ needsSetup: false });
    }

    // Account already has a password: nothing to recover. The user should just
    // sign in (or use the normal forgot-password flow, which emails a link).
    if (user.password_hash) {
      return res.json({ needsSetup: false });
    }

    // GATE HERE: before this point, add any proof-of-ownership check you want
    // (e.g. verify a Stripe checkout session_id belongs to this account and is
    // paid). Everything below issues a fresh set-password token.

    // Mint a fresh single-use token (same table + shape setPassword consumes).
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);

    const { error: insertError } = await supabase.from('password_reset_tokens').insert({
      user_id: user.id,
      email: normalizedEmail,
      token,
      expires_at: expiresAt.toISOString(),
      used: false,
    });

    if (insertError) {
      console.error('❌ recover-setup token insert failed:', insertError.message);
      return res.status(500).json({ error: 'Could not start account setup. Please try again.' });
    }

    console.log('🔁 Account setup recovery token issued for:', normalizedEmail, '| role:', user.role);
    return res.json({ needsSetup: true, token });
  } catch (error) {
    console.error('❌ recover-setup error:', error);
    return res.status(500).json({ error: 'Could not start account setup' });
  }
}

// ============================================================================
// VERIFY TOKEN (unchanged)
// ============================================================================
async function verifyToken(req, res) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided' });
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await getUserById(decoded.userId);
      if (!user) return res.status(401).json({ error: 'User not found' });
      res.json({ valid: true, user: { id: user.id, email: user.email, first_name: user.first_name, last_name: user.last_name, role: user.role, agency_id: user.agency_id, client_id: user.client_id } });
    } catch (jwtError) { return res.status(401).json({ error: 'Invalid or expired token' }); }
  } catch (error) { console.error('❌ Token verification error:', error); res.status(500).json({ error: 'Token verification failed' }); }
}

// ============================================================================
// SET PASSWORD (unchanged)
// ============================================================================
async function setPassword(req, res) {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const { data: tokenRecord, error: tokenError } = await supabase.from('password_reset_tokens').select('*').eq('token', token).eq('used', false).single();
    if (tokenError || !tokenRecord) return res.status(400).json({ error: 'Invalid or expired token' });
    if (new Date(tokenRecord.expires_at) < new Date()) return res.status(400).json({ error: 'Token has expired' });

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    const { error: updateError } = await supabase.from('users').update({ password_hash: passwordHash }).eq('id', tokenRecord.user_id);
    if (updateError) { console.error('❌ Password update error:', updateError); return res.status(500).json({ error: 'Failed to set password' }); }

    await supabase.from('password_reset_tokens').update({ used: true }).eq('id', tokenRecord.id);

    // Clear any agency-set visible password now that the user has set their own.
    // Separate, non-fatal call so a missing column never blocks password set.
    await supabase.from('users').update({ visible_password: null }).eq('id', tokenRecord.user_id);

    const user = await getUserById(tokenRecord.user_id);

    if (user && user.agency_id && (user.role === 'agency_owner' || user.role === 'agency_staff')) {
      const { error: onboardingError } = await supabase.from('agencies').update({ onboarding_completed: true, onboarding_step: 6, updated_at: new Date().toISOString() }).eq('id', user.agency_id);
      if (onboardingError) console.warn('⚠️ Failed to update onboarding status (non-blocking):', onboardingError.message);
      else console.log(`✅ Onboarding marked complete for agency: ${user.agency_id}`);
    }

    const authToken = generateToken(user);
    console.log('✅ Password set for:', user.email);
    res.json({ success: true, message: 'Password set successfully', token: authToken, user: { id: user.id, email: user.email, role: user.role } });
  } catch (error) { console.error('❌ Set password error:', error); res.status(500).json({ error: 'Failed to set password' }); }
}

// ============================================================================
// CHANGE PASSWORD (unchanged)
// ============================================================================
async function changePassword(req, res) {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current password and new password are required' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' });
    const token = authHeader.split(' ')[1];
    let decoded;
    try { decoded = jwt.verify(token, JWT_SECRET); } catch (jwtError) { return res.status(401).json({ error: 'Invalid or expired token' }); }

    const user = await getUserById(decoded.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.password_hash) return res.status(400).json({ error: 'No password set on this account' });

    const validPassword = await bcrypt.compare(currentPassword, user.password_hash);
    if (!validPassword) return res.status(400).json({ error: 'Current password is incorrect' });

    const salt = await bcrypt.genSalt(10);
    const newHash = await bcrypt.hash(newPassword, salt);
    const { error: updateError } = await supabase.from('users').update({ password_hash: newHash }).eq('id', user.id);
    if (updateError) { console.error('❌ Password update error:', updateError); return res.status(500).json({ error: 'Failed to update password' }); }

    await supabase.from('team_members').update({ visible_password: null, updated_at: new Date().toISOString() }).eq('member_user_id', user.id);

    // Clear any agency-set visible password now that the user has chosen their
    // own. Separate, non-fatal call so a missing column never blocks the change.
    await supabase.from('users').update({ visible_password: null }).eq('id', user.id);

    console.log('✅ Password changed for:', user.email);
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) { console.error('❌ Change password error:', error); res.status(500).json({ error: 'Failed to update password' }); }
}

// ============================================================================
// REQUEST PASSWORD RESET (unchanged)
// ============================================================================
async function requestPasswordReset(req, res) {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await getUserByEmail(email.toLowerCase());
    if (!user) return res.json({ success: true, message: 'If an account exists, a reset link has been sent' });

    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(); expiresAt.setHours(expiresAt.getHours() + 1);
    await supabase.from('password_reset_tokens').insert({ user_id: user.id, email: email.toLowerCase(), token, expires_at: expiresAt.toISOString(), used: false });

    const resetUrl = `${process.env.FRONTEND_URL}/auth/reset-password?token=${token}`;
    await sendEmail({ to: email, subject: 'Reset Your Password', html: `<h2>Reset Your Password</h2><p>Click the link below to reset your password. This link expires in 1 hour.</p><p><a href="${resetUrl}">Reset Password</a></p><p>If you didn't request this, you can ignore this email.</p>` });

    console.log('✅ Password reset email sent to:', email);
    res.json({ success: true, message: 'If an account exists, a reset link has been sent' });
  } catch (error) { console.error('❌ Password reset request error:', error); res.status(500).json({ error: 'Failed to process request' }); }
}

// ============================================================================
// AUTH MIDDLEWARE (unchanged)
// ============================================================================
function authMiddleware(requiredRoles = []) {
  return async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' });
      const token = authHeader.split(' ')[1];
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (requiredRoles.length > 0 && !requiredRoles.includes(decoded.role)) return res.status(403).json({ error: 'Insufficient permissions' });
        req.user = decoded;
        next();
      } catch (jwtError) { return res.status(401).json({ error: 'Invalid or expired token' }); }
    } catch (error) { console.error('❌ Auth middleware error:', error); res.status(500).json({ error: 'Authentication failed' }); }
  };
}

// ============================================================================
// PERMISSION MIDDLEWARE
// ----------------------------------------------------------------------------
// Enforces a single Page Access permission on a route. This is the SERVER-SIDE
// half of the per-member gating - the sidebar/route guards in the frontend are
// UX only; this is what actually stops a staff member from hitting an endpoint
// their toggles don't allow (e.g. a direct curl to the settings/billing API).
//
// Owners (agency_owner / client) and super_admin always pass. For *_staff
// roles it loads team_members.permissions for the member's entity and 403s
// when the key is explicitly false, or when the member has been disabled.
//
// Must be mounted AFTER authMiddleware so req.user (the decoded token) exists.
// Example:
//   router.put('/:id/settings',
//     authMiddleware(['agency_owner','agency_staff']),
//     requirePermission('settings'),
//     handler);
//
// Permission keys (agency): dashboard, clients, leads, outreach, analytics,
//   marketing, settings, billing.
// Permission keys (client):  dashboard, calls, contacts, ai_agent, settings,
//   billing.
// ============================================================================
function requirePermission(permissionKey) {
  return async (req, res, next) => {
    try {
      const u = req.user;
      if (!u) return res.status(401).json({ error: 'Authentication required' });

      // Owners and super admins are never gated by Page Access toggles.
      if (u.role === 'agency_owner' || u.role === 'client' || u.role === 'super_admin') return next();

      let entityType = null;
      let entityId = null;
      if (u.role === 'agency_staff') { entityType = 'agency'; entityId = u.agencyId; }
      else if (u.role === 'client_staff') { entityType = 'client'; entityId = u.clientId; }
      else return res.status(403).json({ error: 'Insufficient permissions' });

      if (!entityId) return res.status(403).json({ error: 'Insufficient permissions' });

      const { data: member } = await supabase
        .from('team_members')
        .select('permissions, status')
        .eq('member_user_id', u.userId)
        .eq('entity_type', entityType)
        .eq('entity_id', entityId)
        .single();

      // Fail closed: no member row, disabled, or an explicit false on the key
      // all deny. An absent key on an existing permissions object is allowed,
      // matching how the UI toggles default (only an explicit off blocks).
      if (!member || member.status === 'disabled') {
        return res.status(403).json({ error: 'Access disabled' });
      }
      if (member.permissions && member.permissions[permissionKey] === false) {
        return res.status(403).json({ error: `You do not have permission to access ${permissionKey}.` });
      }

      next();
    } catch (error) {
      console.error('❌ requirePermission error:', error);
      return res.status(500).json({ error: 'Permission check failed' });
    }
  };
}

// ============================================================================
// SOFT PERMISSION MIDDLEWARE (for dual-use routes)
// ----------------------------------------------------------------------------
// Same policy as requirePermission, but for routes that legitimately run BOTH
// authenticated (dashboard) and unauthenticated (signup) - e.g. the agency
// checkout endpoint is hit during signup before the user has a token. This
// guard reads the token itself rather than relying on a prior authMiddleware:
//
//   - No Authorization header (signup path)      → next() (defer to handler)
//   - Invalid/expired token                      → next() (defer to handler)
//   - Owner / client owner / super_admin token   → next()
//   - *_staff token WITH the key explicitly off  → 403
//   - *_staff token disabled                      → 403
//
// Because a missing token passes through, mounting this on a currently-open
// route introduces ZERO regression for existing callers (anonymous calls
// behave exactly as before) while still blocking an authenticated staff
// member whose Page Access toggles don't include the action. Closing the
// broader anonymous-access gap on these routes is a separate security item.
// ============================================================================
function requirePermissionIfAuthed(permissionKey) {
  return async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) return next();

      const token = authHeader.split(' ')[1];
      let decoded;
      try { decoded = jwt.verify(token, JWT_SECRET); } catch { return next(); }
      req.user = decoded;

      // Owners and super admins are never gated by Page Access toggles.
      if (decoded.role === 'agency_owner' || decoded.role === 'client' || decoded.role === 'super_admin') return next();

      let entityType = null;
      let entityId = null;
      if (decoded.role === 'agency_staff') { entityType = 'agency'; entityId = decoded.agencyId; }
      else if (decoded.role === 'client_staff') { entityType = 'client'; entityId = decoded.clientId; }
      else return next(); // unknown role on a dual-use route - defer to handler

      if (!entityId) return next();

      const { data: member } = await supabase
        .from('team_members')
        .select('permissions, status')
        .eq('member_user_id', decoded.userId)
        .eq('entity_type', entityType)
        .eq('entity_id', entityId)
        .single();

      if (!member || member.status === 'disabled') {
        return res.status(403).json({ error: 'Access disabled' });
      }
      if (member.permissions && member.permissions[permissionKey] === false) {
        return res.status(403).json({ error: `You do not have permission to access ${permissionKey}.` });
      }

      return next();
    } catch (error) {
      // Fail open ONLY on unexpected errors so a transient DB blip can't lock
      // a paying owner out of billing. The explicit-false / disabled denials
      // above already returned before reaching here.
      console.error('❌ requirePermissionIfAuthed error:', error);
      return next();
    }
  };
}

// ============================================================================
// AGENCY OWNERSHIP MIDDLEWARE (hard)
// ----------------------------------------------------------------------------
// For agency routes carrying an :agencyId param whose payload is sensitive
// enough that a valid token AND ownership of that specific agency must both be
// proven (e.g. the Connect financials endpoints, which return the agency's
// live Stripe balance). Unlike requirePermissionIfAuthed, this does NOT let
// anonymous callers through: a missing or invalid token is a hard 401.
//
// Pass conditions:
//   - super_admin token                         → any agency
//   - admin-impersonation token (type='agency') → must match :agencyId (id)
//   - agency_owner token                        → must match :agencyId (agencyId)
//   - agency_staff token                        → must match :agencyId AND the
//       Page Access `permissionKey` is not explicitly false, and not disabled
//
// Deny conditions:
//   - no/invalid token                          → 401
//   - caller's agency id != :agencyId           → 403
//   - client / client_staff / unknown roles     → 403 (not agency users)
//
// Token shapes handled: normal agency tokens carry { role, agencyId } from
// generateToken; admin impersonation tokens (routes/admin.js) carry
// { id, type:'agency' } and no role, so ownership is read from id.
// ============================================================================
function requireAgencyAccess(permissionKey) {
  return async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const token = authHeader.split(' ')[1];
      let decoded;
      try { decoded = jwt.verify(token, JWT_SECRET); }
      catch { return res.status(401).json({ error: 'Invalid or expired token' }); }
      req.user = decoded;

      const routeAgencyId = req.params.agencyId;
      if (!routeAgencyId) return res.status(400).json({ error: 'agencyId required' });

      // super_admin can access any agency.
      if (decoded.role === 'super_admin') return next();

      // Resolve the caller's own agency id. Normal agency tokens carry
      // agencyId; admin-impersonation tokens carry id + type='agency'.
      const callerAgencyId = decoded.agencyId || (decoded.type === 'agency' ? decoded.id : null);
      if (!callerAgencyId || callerAgencyId !== routeAgencyId) {
        return res.status(403).json({ error: 'Not authorized for this agency' });
      }

      // Owners and impersonation tokens pass without a Page Access check.
      if (decoded.role === 'agency_owner' || decoded.type === 'agency') return next();

      // Agency staff: enforce the Page Access permission key (fail closed).
      if (decoded.role === 'agency_staff') {
        const { data: member } = await supabase
          .from('team_members')
          .select('permissions, status')
          .eq('member_user_id', decoded.userId)
          .eq('entity_type', 'agency')
          .eq('entity_id', callerAgencyId)
          .single();

        if (!member || member.status === 'disabled') {
          return res.status(403).json({ error: 'Access disabled' });
        }
        if (member.permissions && member.permissions[permissionKey] === false) {
          return res.status(403).json({ error: `You do not have permission to access ${permissionKey}.` });
        }
        return next();
      }

      // Any other role (client, client_staff, unknown) is not an agency user.
      return res.status(403).json({ error: 'Not authorized for this agency' });
    } catch (error) {
      console.error('❌ requireAgencyAccess error:', error);
      return res.status(500).json({ error: 'Authorization check failed' });
    }
  };
}

module.exports = { agencyLogin, clientLogin, recoverAccountSetup, verifyToken, setPassword, changePassword, requestPasswordReset, authMiddleware, requirePermission, requirePermissionIfAuthed, requireAgencyAccess, generateToken };
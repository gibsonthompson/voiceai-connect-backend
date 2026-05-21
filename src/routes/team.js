// ============================================================================
// TEAM MEMBER ROUTES
// VoiceAI Connect - Agency + Client Level
// Destination: src/routes/team.js
// ============================================================================
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { supabase } = require('../lib/supabase');

let sendSms;
function getSendSms() {
  if (!sendSms) {
    try {
      const notifications = require('../lib/notifications');
      sendSms = notifications.sendTelnyxSMS;
    } catch {
      sendSms = async () => console.warn('⚠️ SMS not available');
    }
  }
  return sendSms;
}

const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

function decodeToken(req) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return null;
    return jwt.verify(token, JWT_SECRET);
  } catch { return null; }
}

function isAgencyOwnerRole(role) { return role === 'agency_owner' || role === 'super_admin'; }
function isClientOwnerRole(role) { return role === 'client'; }

function generateTempPassword() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pw = '';
  for (let i = 0; i < 10; i++) pw += chars.charAt(Math.floor(Math.random() * chars.length));
  return pw;
}

const DEFAULT_PERMISSIONS = {
  agency: { dashboard: true, clients: true, leads: true, outreach: false, analytics: true, marketing: false, settings: false, billing: false },
  client: { dashboard: true, calls: true, contacts: true, ai_agent: false, settings: false, billing: false },
};

function sanitizePermissions(perms, entityType) {
  const validKeys = Object.keys(DEFAULT_PERMISSIONS[entityType] || {});
  const cleaned = {};
  for (const key of validKeys) {
    cleaned[key] = typeof perms[key] === 'boolean' ? perms[key] : DEFAULT_PERMISSIONS[entityType][key];
  }
  return cleaned;
}

// ============================================================================
// CHECK TEAM LIMIT — Updated to read per-plan team_members from plan_features
// ============================================================================
async function checkTeamLimit(entityType, entityId) {
  if (entityType === 'agency') {
    const { data: agency } = await supabase
      .from('agencies')
      .select('max_team_members_agency')
      .eq('id', entityId)
      .single();
    const maxAllowed = agency?.max_team_members_agency ?? 0;

    const { count } = await supabase
      .from('team_members')
      .select('id', { count: 'exact', head: true })
      .eq('entity_type', 'agency')
      .eq('entity_id', entityId)
      .neq('status', 'disabled');

    return { allowed: (count || 0) < maxAllowed, current: count || 0, max: maxAllowed };
  }

  if (entityType === 'client') {
    // 1. Check per-client override first
    const { data: client } = await supabase
      .from('clients')
      .select('max_team_members, agency_id, plan_type')
      .eq('id', entityId)
      .single();

    let maxAllowed = client?.max_team_members;

    // 2. If no per-client override, check agency's per-plan-tier config
    if (maxAllowed === null || maxAllowed === undefined) {
      if (client?.agency_id) {
        const { data: agency } = await supabase
          .from('agencies')
          .select('max_team_members_client, plan_features')
          .eq('id', client.agency_id)
          .single();

        // Check plan_features for per-plan team_members count
        const planFeatures = agency?.plan_features;
        const clientPlan = client?.plan_type || 'starter';
        const planTeamLimit = planFeatures?.[clientPlan]?.team_members;

        if (typeof planTeamLimit === 'number' && planTeamLimit >= 0) {
          maxAllowed = planTeamLimit;
        } else {
          // 3. Fall back to global agency default
          maxAllowed = agency?.max_team_members_client ?? 0;
        }
      } else {
        maxAllowed = 0;
      }
    }

    const { count } = await supabase
      .from('team_members')
      .select('id', { count: 'exact', head: true })
      .eq('entity_type', 'client')
      .eq('entity_id', entityId)
      .neq('status', 'disabled');

    return { allowed: (count || 0) < maxAllowed, current: count || 0, max: maxAllowed };
  }

  return { allowed: false, current: 0, max: 0 };
}

async function logActivity(teamMemberId, userId, entityType, entityId, action, details = null) {
  try {
    await supabase.from('team_activity_log').insert({
      team_member_id: teamMemberId, user_id: userId,
      entity_type: entityType, entity_id: entityId, action, details,
    });
  } catch (err) { console.error('⚠️ Failed to log team activity:', err.message); }
}

// ============================================================================
// AGENCY TEAM ROUTES
// ============================================================================

router.get('/:agencyId/team', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const { data: members, error } = await supabase
      .from('team_members')
      .select(`id, display_name, phone, visible_password, permissions, notification_prefs, status, created_at, updated_at, member_user_id, users:member_user_id (id, email, last_login, avatar_url)`)
      .eq('entity_type', 'agency').eq('entity_id', agencyId)
      .order('created_at', { ascending: true });
    if (error) { console.error('❌ Fetch team error:', error); return res.status(500).json({ error: 'Failed to fetch team members' }); }
    const limits = await checkTeamLimit('agency', agencyId);
    res.json({
      success: true,
      members: (members || []).map(m => ({ id: m.id, display_name: m.display_name, phone: m.phone, email: m.users?.email || null, visible_password: m.visible_password, permissions: m.permissions, notification_prefs: m.notification_prefs, status: m.status, last_login: m.users?.last_login || null, avatar_url: m.users?.avatar_url || null, created_at: m.created_at })),
      limits,
    });
  } catch (err) { console.error('❌ List team error:', err); res.status(500).json({ error: 'Failed to fetch team members' }); }
});

router.post('/:agencyId/team', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const { name, email, phone, permissions } = req.body;
    const decoded = decodeToken(req);
    if (!decoded || !isAgencyOwnerRole(decoded.role)) return res.status(403).json({ error: 'Only the agency owner can manage team members' });
    const ownerUserId = decoded.userId;
    if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });
    const limits = await checkTeamLimit('agency', agencyId);
    if (!limits.allowed) return res.status(403).json({ error: `Team member limit reached (${limits.current}/${limits.max}). Upgrade your plan to add more.`, limits });
    const { data: existingUser } = await supabase.from('users').select('id, email, role, agency_id').eq('email', email.toLowerCase()).single();
    if (existingUser) {
      if (existingUser.agency_id === agencyId) return res.status(409).json({ error: 'A user with this email already exists for this agency' });
      return res.status(409).json({ error: 'This email is already associated with another account' });
    }
    const tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    const { data: newUser, error: userError } = await supabase.from('users').insert({ email: email.toLowerCase(), password_hash: passwordHash, first_name: name.split(' ')[0] || name, last_name: name.split(' ').slice(1).join(' ') || null, phone: phone || null, role: 'agency_staff', agency_id: agencyId, invited_by: ownerUserId }).select('id, email, first_name, last_name').single();
    if (userError) { console.error('❌ Create user error:', userError); return res.status(500).json({ error: 'Failed to create user account' }); }
    const sanitizedPerms = sanitizePermissions(permissions || {}, 'agency');
    const { data: member, error: memberError } = await supabase.from('team_members').insert({ owner_user_id: ownerUserId, member_user_id: newUser.id, entity_type: 'agency', entity_id: agencyId, display_name: name, phone: phone || null, visible_password: tempPassword, permissions: sanitizedPerms, status: 'active' }).select().single();
    if (memberError) { console.error('❌ Create team member error:', memberError); await supabase.from('users').delete().eq('id', newUser.id); return res.status(500).json({ error: 'Failed to create team member' }); }
    await logActivity(member.id, ownerUserId, 'agency', agencyId, 'member_added', { name, email: email.toLowerCase(), phone });
    if (phone) { try { const send = getSendSms(); await send(phone, `You've been added to a VoiceAI Connect team!\n\nLogin: https://myvoiceaiconnect.com/agency/login\nEmail: ${email.toLowerCase()}\nPassword: ${tempPassword}\n\nChange your password after first login.`); } catch (smsErr) { console.warn('⚠️ SMS send failed:', smsErr.message); } }
    console.log(`✅ Team member added: ${name} (${email}) → agency ${agencyId}`);
    res.json({ success: true, member: { id: member.id, display_name: member.display_name, phone: member.phone, email: newUser.email, visible_password: tempPassword, permissions: member.permissions, notification_prefs: member.notification_prefs, status: member.status, created_at: member.created_at } });
  } catch (err) { console.error('❌ Add team member error:', err); res.status(500).json({ error: 'Failed to add team member' }); }
});

router.put('/:agencyId/team/:memberId', async (req, res) => {
  try {
    const { agencyId, memberId } = req.params;
    const { display_name, phone, permissions, notification_prefs, status } = req.body;
    const decoded = decodeToken(req);
    if (!decoded || !isAgencyOwnerRole(decoded.role)) return res.status(403).json({ error: 'Only the agency owner can manage team members' });
    const { data: existing } = await supabase.from('team_members').select('id, member_user_id, permissions').eq('id', memberId).eq('entity_type', 'agency').eq('entity_id', agencyId).single();
    if (!existing) return res.status(404).json({ error: 'Team member not found' });
    const updates = { updated_at: new Date().toISOString() };
    const userUpdates = {};
    if (display_name !== undefined) { updates.display_name = display_name; userUpdates.first_name = display_name.split(' ')[0] || display_name; userUpdates.last_name = display_name.split(' ').slice(1).join(' ') || null; }
    if (phone !== undefined) { updates.phone = phone || null; userUpdates.phone = phone || null; }
    if (permissions !== undefined) updates.permissions = sanitizePermissions(permissions, 'agency');
    if (notification_prefs !== undefined) updates.notification_prefs = notification_prefs;
    if (status !== undefined && ['active', 'disabled'].includes(status)) updates.status = status;
    const { data: updated, error } = await supabase.from('team_members').update(updates).eq('id', memberId).select().single();
    if (error) { console.error('❌ Update team member error:', error); return res.status(500).json({ error: 'Failed to update team member' }); }
    if (Object.keys(userUpdates).length > 0) await supabase.from('users').update(userUpdates).eq('id', existing.member_user_id);
    if (permissions !== undefined) await logActivity(memberId, decoded.userId, 'agency', agencyId, 'permissions_changed', { old: existing.permissions, new: updates.permissions });
    res.json({ success: true, member: updated });
  } catch (err) { console.error('❌ Update team member error:', err); res.status(500).json({ error: 'Failed to update team member' }); }
});

router.post('/:agencyId/team/:memberId/reset-password', async (req, res) => {
  try {
    const { agencyId, memberId } = req.params;
    const { password } = req.body;
    const decoded = decodeToken(req);
    if (!decoded || !isAgencyOwnerRole(decoded.role)) return res.status(403).json({ error: 'Only the agency owner can manage team members' });
    const { data: member } = await supabase.from('team_members').select('id, member_user_id, phone, display_name').eq('id', memberId).eq('entity_type', 'agency').eq('entity_id', agencyId).single();
    if (!member) return res.status(404).json({ error: 'Team member not found' });
    const newPassword = password || generateTempPassword();
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await supabase.from('users').update({ password_hash: passwordHash }).eq('id', member.member_user_id);
    await supabase.from('team_members').update({ visible_password: newPassword, updated_at: new Date().toISOString() }).eq('id', memberId);
    await logActivity(memberId, decoded.userId, 'agency', agencyId, 'password_reset', { reset_by: 'owner' });
    if (member.phone) { try { const send = getSendSms(); await send(member.phone, `Your VoiceAI Connect password has been reset.\n\nNew password: ${newPassword}\n\nPlease change it after logging in.`); } catch {} }
    res.json({ success: true, visible_password: newPassword });
  } catch (err) { console.error('❌ Reset password error:', err); res.status(500).json({ error: 'Failed to reset password' }); }
});

router.delete('/:agencyId/team/:memberId', async (req, res) => {
  try {
    const { agencyId, memberId } = req.params;
    const decoded = decodeToken(req);
    if (!decoded || !isAgencyOwnerRole(decoded.role)) return res.status(403).json({ error: 'Only the agency owner can manage team members' });
    const { data: member } = await supabase.from('team_members').select('id, member_user_id, display_name').eq('id', memberId).eq('entity_type', 'agency').eq('entity_id', agencyId).single();
    if (!member) return res.status(404).json({ error: 'Team member not found' });
    await logActivity(memberId, decoded.userId, 'agency', agencyId, 'member_removed', { name: member.display_name });
    await supabase.from('team_members').delete().eq('id', memberId);
    await supabase.from('users').delete().eq('id', member.member_user_id);
    res.json({ success: true });
  } catch (err) { console.error('❌ Remove team member error:', err); res.status(500).json({ error: 'Failed to remove team member' }); }
});

// ============================================================================
// CLIENT TEAM ROUTES
// ============================================================================

router.get('/client/:clientId/team', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { data: members, error } = await supabase
      .from('team_members')
      .select(`id, display_name, phone, visible_password, permissions, notification_prefs, status, created_at, updated_at, member_user_id, users:member_user_id ( id, email, last_login )`)
      .eq('entity_type', 'client').eq('entity_id', clientId)
      .order('created_at', { ascending: true });
    if (error) { console.error('❌ Fetch client team error:', error); return res.status(500).json({ error: 'Failed to fetch team members' }); }
    const limits = await checkTeamLimit('client', clientId);
    res.json({
      success: true,
      members: (members || []).map(m => ({ id: m.id, display_name: m.display_name, phone: m.phone, email: m.users?.email || null, visible_password: m.visible_password, permissions: m.permissions, notification_prefs: m.notification_prefs, status: m.status, last_login: m.users?.last_login || null, created_at: m.created_at })),
      limits,
    });
  } catch (err) { console.error('❌ List client team error:', err); res.status(500).json({ error: 'Failed to fetch team members' }); }
});

router.post('/client/:clientId/team', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { name, email, phone, permissions } = req.body;
    const decoded = decodeToken(req);
    if (!decoded || !isClientOwnerRole(decoded.role)) return res.status(403).json({ error: 'Only the account owner can manage team members' });
    const ownerUserId = decoded.userId;
    if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });
    const limits = await checkTeamLimit('client', clientId);
    if (!limits.allowed) return res.status(403).json({ error: `Team member limit reached (${limits.current}/${limits.max}). Contact your provider to upgrade.`, limits });
    const { data: client } = await supabase.from('clients').select('agency_id').eq('id', clientId).single();
    const { data: existingUser } = await supabase.from('users').select('id').eq('email', email.toLowerCase()).single();
    if (existingUser) return res.status(409).json({ error: 'This email is already associated with an account' });
    const tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    const { data: newUser, error: userError } = await supabase.from('users').insert({ email: email.toLowerCase(), password_hash: passwordHash, first_name: name.split(' ')[0] || name, last_name: name.split(' ').slice(1).join(' ') || null, phone: phone || null, role: 'client_staff', client_id: clientId, agency_id: client?.agency_id || null, invited_by: ownerUserId }).select('id, email').single();
    if (userError) { console.error('❌ Create client team user error:', userError); return res.status(500).json({ error: 'Failed to create user account' }); }
    const sanitizedPerms = sanitizePermissions(permissions || {}, 'client');
    const { data: member, error: memberError } = await supabase.from('team_members').insert({ owner_user_id: ownerUserId, member_user_id: newUser.id, entity_type: 'client', entity_id: clientId, display_name: name, phone: phone || null, visible_password: tempPassword, permissions: sanitizedPerms, status: 'active' }).select().single();
    if (memberError) { console.error('❌ Create client team member error:', memberError); await supabase.from('users').delete().eq('id', newUser.id); return res.status(500).json({ error: 'Failed to create team member' }); }
    await logActivity(member.id, ownerUserId, 'client', clientId, 'member_added', { name, email: email.toLowerCase() });
    if (phone) { try { const send = getSendSms(); await send(phone, `You've been added as a team member!\n\nLogin: https://myvoiceaiconnect.com/client/login\nEmail: ${email.toLowerCase()}\nPassword: ${tempPassword}`); } catch {} }
    res.json({ success: true, member: { id: member.id, display_name: member.display_name, phone: member.phone, email: newUser.email, visible_password: tempPassword, permissions: member.permissions, notification_prefs: member.notification_prefs, status: member.status, created_at: member.created_at } });
  } catch (err) { console.error('❌ Add client team member error:', err); res.status(500).json({ error: 'Failed to add team member' }); }
});

router.put('/client/:clientId/team/:memberId', async (req, res) => {
  try {
    const { clientId, memberId } = req.params;
    const { display_name, phone, permissions, notification_prefs, status } = req.body;
    const decoded = decodeToken(req);
    if (!decoded || !isClientOwnerRole(decoded.role)) return res.status(403).json({ error: 'Only the account owner can manage team members' });
    const { data: existing } = await supabase.from('team_members').select('id, member_user_id').eq('id', memberId).eq('entity_type', 'client').eq('entity_id', clientId).single();
    if (!existing) return res.status(404).json({ error: 'Team member not found' });
    const updates = { updated_at: new Date().toISOString() };
    const userUpdates = {};
    if (display_name !== undefined) { updates.display_name = display_name; userUpdates.first_name = display_name.split(' ')[0]; userUpdates.last_name = display_name.split(' ').slice(1).join(' ') || null; }
    if (phone !== undefined) { updates.phone = phone || null; userUpdates.phone = phone || null; }
    if (permissions !== undefined) updates.permissions = sanitizePermissions(permissions, 'client');
    if (notification_prefs !== undefined) updates.notification_prefs = notification_prefs;
    if (status !== undefined && ['active', 'disabled'].includes(status)) updates.status = status;
    const { data: updated, error } = await supabase.from('team_members').update(updates).eq('id', memberId).select().single();
    if (error) return res.status(500).json({ error: 'Failed to update team member' });
    if (Object.keys(userUpdates).length > 0) await supabase.from('users').update(userUpdates).eq('id', existing.member_user_id);
    res.json({ success: true, member: updated });
  } catch (err) { console.error('❌ Update client team member error:', err); res.status(500).json({ error: 'Failed to update team member' }); }
});

router.post('/client/:clientId/team/:memberId/reset-password', async (req, res) => {
  try {
    const { clientId, memberId } = req.params;
    const decoded = decodeToken(req);
    if (!decoded || !isClientOwnerRole(decoded.role)) return res.status(403).json({ error: 'Only the account owner can manage team members' });
    const { data: member } = await supabase.from('team_members').select('id, member_user_id, phone, display_name').eq('id', memberId).eq('entity_type', 'client').eq('entity_id', clientId).single();
    if (!member) return res.status(404).json({ error: 'Team member not found' });
    const newPassword = req.body.password || generateTempPassword();
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await supabase.from('users').update({ password_hash: passwordHash }).eq('id', member.member_user_id);
    await supabase.from('team_members').update({ visible_password: newPassword, updated_at: new Date().toISOString() }).eq('id', memberId);
    if (member.phone) { try { const send = getSendSms(); await send(member.phone, `Your password has been reset.\n\nNew password: ${newPassword}`); } catch {} }
    res.json({ success: true, visible_password: newPassword });
  } catch (err) { console.error('❌ Reset client team password error:', err); res.status(500).json({ error: 'Failed to reset password' }); }
});

router.delete('/client/:clientId/team/:memberId', async (req, res) => {
  try {
    const { clientId, memberId } = req.params;
    const decoded = decodeToken(req);
    if (!decoded || !isClientOwnerRole(decoded.role)) return res.status(403).json({ error: 'Only the account owner can manage team members' });
    const { data: member } = await supabase.from('team_members').select('id, member_user_id, display_name').eq('id', memberId).eq('entity_type', 'client').eq('entity_id', clientId).single();
    if (!member) return res.status(404).json({ error: 'Team member not found' });
    await supabase.from('team_members').delete().eq('id', memberId);
    await supabase.from('users').delete().eq('id', member.member_user_id);
    res.json({ success: true });
  } catch (err) { console.error('❌ Remove client team member error:', err); res.status(500).json({ error: 'Failed to remove team member' }); }
});

module.exports = router;
// ============================================================================
// CALL-CENTER TEAM ROUTES
// VoiceAI Connect - Call Center Level
// Destination: src/routes/cc-team.js
//
// WHAT THIS IS
// ------------
// The call-center equivalent of the agency team routes in team.js. A call
// center has an OWNER (cc_owner), MANAGERS (cc_manager) who run the dashboard,
// and AGENTS (cc_agent) who take escalated live calls. This file lets the owner
// and permitted managers create / edit / remove managers and agents.
//
// WHY A SEPARATE FILE (and not owner-agnostic edits to team.js)
// -------------------------------------------------------------
// team.js is the LIVE agency team system. Making it owner-agnostic would touch
// the agency write path everywhere. Instead this file is a parallel, call-
// center-keyed mirror, so team.js stays byte-identical and the agency level
// cannot regress. Everything here is scoped to:
//     team_members.entity_type = 'call_center'
//     team_members.entity_id   = <callCenterId>
//     users.call_center_id     = <callCenterId>   (users.agency_id stays null)
//     users.role               = 'cc_manager' | 'cc_agent'
// and guarded by requireCallCenterAccess, which already enforces that the
// caller's token.callCenterId matches the :callCenterId in the URL.
//
// URL SHAPE
// ---------
//   GET    /:callCenterId/cc/team                      list managers + agents
//   POST   /:callCenterId/cc/team                      add a manager or agent
//   PUT    /:callCenterId/cc/team/:memberId            edit one
//   POST   /:callCenterId/cc/team/:memberId/reset-password
//   DELETE /:callCenterId/cc/team/:memberId
// Mounted on '/api/agency' in server.js so the existing /cc screens keep their
// URL shape (/api/agency/:id/cc/team) exactly like the other cc routes.
// ============================================================================
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { supabase } = require('../lib/supabase');
const { requireCallCenterAccess } = require('./auth');

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
const JWT_SECRET = process.env.JWT_SECRET;

function decodeToken(req) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return null;
    return jwt.verify(token, JWT_SECRET);
  } catch { return null; }
}

function generateTempPassword() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pw = '';
  for (let i = 0; i < 10; i++) pw += chars.charAt(Math.floor(Math.random() * chars.length));
  return pw;
}

// Call-center permission keys. These are the ONLY keys requireCallCenterAccess
// reads to gate a manager/agent (dashboard also gates calls/messages/sms/
// contacts, which all mount under requireCallCenterAccess('dashboard')).
//   - manage_team: may create/edit/remove managers & agents. Owner bypasses all.
// NOTE: requireCallCenterAccess only blocks on an EXPLICIT false, so an agent
// preset that omits a key is not blocked by that key; settings/manage_team are
// the ones to keep false for agents.
const DEFAULT_CC_PERMISSIONS = {
  dashboard: true,
  clients: true,
  analytics: true,
  settings: false,
  manage_team: false,
};

function sanitizeCcPermissions(perms) {
  const validKeys = Object.keys(DEFAULT_CC_PERMISSIONS);
  const cleaned = {};
  const src = (perms && typeof perms === 'object') ? perms : {};
  for (const key of validKeys) {
    cleaned[key] = typeof src[key] === 'boolean' ? src[key] : DEFAULT_CC_PERMISSIONS[key];
  }
  return cleaned;
}

// Per-agent weekly working hours. Same normalized shape as the agency side
// (agent-presence.isAgentOnSchedule reads it): { enabled, override, days:{ mon:
// { on, windows:[{start,end}] }, ... } } with HH:mm times. null clears it.
const _HM = (v, fb) => (typeof v === 'string' && /^\d{1,2}:\d{2}$/.test(v) ? v : fb);
function sanitizeAvailabilityHours(h) {
  if (h === null) return null;
  if (!h || typeof h !== 'object') return null;
  const names = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const src = (h.days && typeof h.days === 'object') ? h.days : {};
  const days = {};
  for (const n of names) {
    const d = src[n] || {};
    let raw = Array.isArray(d.windows) ? d.windows : ((d.start || d.end) ? [{ start: d.start, end: d.end }] : []);
    let windows = raw.slice(0, 6).map((w) => ({ start: _HM(w && w.start, '09:00'), end: _HM(w && w.end, '17:00') }));
    if (windows.length === 0) windows = [{ start: '09:00', end: '17:00' }];
    days[n] = { on: d.on === true, windows };
  }
  return { enabled: h.enabled === true, override: h.override === true, days };
}

// AGENT -> BUSINESS ASSIGNMENT (call center). Same semantics as the agency side
// but validated against THIS call center's own clients (clients.call_center_id)
// so a manager can never point an agent at a business the call center doesn't
// own.  null => unrestricted; [] => assigned to nothing; [...] => only ids that
// are genuinely this call center's clients.
async function sanitizeAssignedClientIds(raw, callCenterId) {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) return null;
  const wanted = [...new Set(raw.filter(x => typeof x === 'string' && x.trim()))];
  if (wanted.length === 0) return [];
  const { data: rows } = await supabase
    .from('clients')
    .select('id')
    .eq('call_center_id', callCenterId)
    .in('id', wanted);
  const valid = new Set((rows || []).map(r => r.id));
  return wanted.filter(id => valid.has(id));
}

// Can the CALLER create/edit/remove team members for this call center?
//   - super_admin / cc_owner  -> always
//   - cc_manager              -> only with the manage_team permission (fail-closed)
//   - cc_agent / anyone else  -> never
async function callerCanManageCcTeam(decoded, callCenterId) {
  if (!decoded) return false;
  if (decoded.role === 'super_admin' || decoded.role === 'cc_owner') return true;
  if (decoded.role !== 'cc_manager') return false;
  try {
    const { data: m } = await supabase.from('team_members')
      .select('is_manager, permissions, status')
      .eq('member_user_id', decoded.userId)
      .eq('entity_type', 'call_center')
      .eq('entity_id', callCenterId)
      .maybeSingle();
    if (!m || m.status === 'disabled') return false;
    return !!(m.permissions && m.permissions.manage_team === true);
  } catch (e) {
    console.warn('callerCanManageCcTeam check failed:', e.message);
    return false;
  }
}

// The user id to stamp as owner/actor on writes. The token carries userId for
// every real cc session; fall back to the call center's owner user.
async function resolveActingCcUserId(decoded, callCenterId) {
  if (decoded && decoded.userId) return decoded.userId;
  const { data: users } = await supabase.from('users').select('id, role').eq('call_center_id', callCenterId);
  const u = (users || []).find((x) => x.role === 'cc_owner') || (users || [])[0];
  return u ? u.id : null;
}

// Call centers are agent-pool businesses: their agents ARE the product, so seats
// are unlimited. We still report the live count so the UI can show it.
async function checkCcTeamLimit(callCenterId) {
  const { count } = await supabase
    .from('team_members')
    .select('id', { count: 'exact', head: true })
    .eq('entity_type', 'call_center')
    .eq('entity_id', callCenterId)
    .neq('status', 'disabled');
  return { allowed: true, current: count || 0, max: -1 };
}

async function logActivity(teamMemberId, userId, callCenterId, action, details = null) {
  try {
    await supabase.from('team_activity_log').insert({
      team_member_id: teamMemberId, user_id: userId,
      entity_type: 'call_center', entity_id: callCenterId, action, details,
    });
  } catch (err) { console.error('⚠️ Failed to log cc team activity:', err.message); }
}

async function ccLoginUrl(callCenterId) {
  try {
    const { data: cc } = await supabase.from('call_centers').select('slug').eq('id', callCenterId).maybeSingle();
    return `https://${cc?.slug || 'app'}.myvoiceaiconnect.com/cc/login`;
  } catch { return 'https://app.myvoiceaiconnect.com/cc/login'; }
}

// ============================================================================
// ROUTES
// Guarded by requireCallCenterAccess('settings'): valid token, caller's
// callCenterId matches :callCenterId, and (for managers) the 'settings' key.
// Writes are additionally gated by callerCanManageCcTeam (manage_team / owner).
// ============================================================================

router.get('/:callCenterId/cc/team', requireCallCenterAccess('settings'), async (req, res) => {
  try {
    const { callCenterId } = req.params;
    const { data: members, error } = await supabase
      .from('team_members')
      .select(`id, display_name, phone, visible_password, permissions, notification_prefs, status, assigned_client_ids, call_delivery, agent_phone, availability_hours, is_manager, created_at, updated_at, member_user_id, users:member_user_id (id, email, last_login, avatar_url)`)
      .eq('entity_type', 'call_center').eq('entity_id', callCenterId)
      .order('created_at', { ascending: true });
    if (error) { console.error('❌ Fetch cc team error:', error); return res.status(500).json({ error: 'Failed to fetch team members' }); }
    const limits = await checkCcTeamLimit(callCenterId);
    res.json({
      success: true,
      members: (members || []).map(m => ({
        id: m.id, user_id: m.member_user_id, display_name: m.display_name, phone: m.phone,
        email: m.users?.email || null, visible_password: m.visible_password, permissions: m.permissions,
        notification_prefs: m.notification_prefs, status: m.status,
        assigned_client_ids: m.assigned_client_ids || null, call_delivery: m.call_delivery || 'browser',
        agent_phone: m.agent_phone || null, availability_hours: m.availability_hours || null,
        is_manager: m.is_manager === true, last_login: m.users?.last_login || null,
        avatar_url: m.users?.avatar_url || null, created_at: m.created_at,
      })),
      limits,
      can_manage_team: await callerCanManageCcTeam(req.user, callCenterId),
    });
  } catch (err) { console.error('❌ List cc team error:', err); res.status(500).json({ error: 'Failed to fetch team members' }); }
});

router.post('/:callCenterId/cc/team', requireCallCenterAccess('settings'), async (req, res) => {
  try {
    const { callCenterId } = req.params;
    const { name, email, phone, permissions } = req.body;
    const decoded = decodeToken(req);
    if (!(await callerCanManageCcTeam(decoded, callCenterId))) return res.status(403).json({ error: 'You do not have permission to manage the team.' });
    const ownerUserId = await resolveActingCcUserId(decoded, callCenterId);
    if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });

    const { data: existingUser } = await supabase.from('users').select('id, email, call_center_id, agency_id').eq('email', email.toLowerCase()).single();
    if (existingUser) {
      if (existingUser.call_center_id === callCenterId) return res.status(409).json({ error: 'A user with this email already exists for this call center' });
      return res.status(409).json({ error: 'This email is already associated with another account' });
    }

    // A MANAGER runs the dashboard; an AGENT takes escalated calls. is_manager
    // flips the role (cc_manager vs cc_agent) and the frontend nav/tab access.
    const isManager = req.body.is_manager === true;
    const role = isManager ? 'cc_manager' : 'cc_agent';

    const tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    const { data: newUser, error: userError } = await supabase.from('users').insert({
      email: email.toLowerCase(), password_hash: passwordHash,
      first_name: name.split(' ')[0] || name, last_name: name.split(' ').slice(1).join(' ') || null,
      phone: phone || null, role, call_center_id: callCenterId, invited_by: ownerUserId,
    }).select('id, email, first_name, last_name').single();
    if (userError) { console.error('❌ Create cc user error:', userError); return res.status(500).json({ error: 'Failed to create user account' }); }

    const sanitizedPerms = sanitizeCcPermissions(permissions || {});
    const assignedClientIds = await sanitizeAssignedClientIds(req.body.assigned_client_ids, callCenterId);
    const callDelivery = req.body.call_delivery === 'phone' ? 'phone' : 'browser';
    const agentPhone = (typeof req.body.agent_phone === 'string' && req.body.agent_phone.trim()) ? req.body.agent_phone.trim() : null;

    const { data: member, error: memberError } = await supabase.from('team_members').insert({
      owner_user_id: ownerUserId, member_user_id: newUser.id, entity_type: 'call_center', entity_id: callCenterId,
      display_name: name, phone: phone || null, visible_password: tempPassword, permissions: sanitizedPerms,
      assigned_client_ids: assignedClientIds, call_delivery: callDelivery, agent_phone: agentPhone,
      is_manager: isManager, status: 'active',
    }).select().single();
    if (memberError) {
      console.error('❌ Create cc team member error:', memberError);
      await supabase.from('users').delete().eq('id', newUser.id);
      return res.status(500).json({ error: 'Failed to create team member' });
    }
    await logActivity(member.id, ownerUserId, callCenterId, 'member_added', { name, email: email.toLowerCase(), phone, role });

    if (phone) {
      try {
        const send = getSendSms();
        const { data: ccRow } = await supabase.from('call_centers').select('name, slug').eq('id', callCenterId).single();
        const teamLabel = ccRow?.name ? `${ccRow.name} team` : 'team';
        const loginUrl = `https://${ccRow?.slug || 'app'}.myvoiceaiconnect.com/cc/login`;
        await send(phone, `You've been added to the ${teamLabel}!\n\nLogin: ${loginUrl}\nEmail: ${email.toLowerCase()}\nPassword: ${tempPassword}\n\nChange your password after first login.`);
      } catch (smsErr) { console.warn('⚠️ SMS send failed:', smsErr.message); }
    }
    console.log(`✅ CC team member added: ${name} (${email}) → call_center ${callCenterId} as ${role}`);
    res.json({ success: true, member: {
      id: member.id, user_id: member.member_user_id, display_name: member.display_name, phone: member.phone,
      email: newUser.email, visible_password: tempPassword, permissions: member.permissions,
      notification_prefs: member.notification_prefs, status: member.status,
      assigned_client_ids: member.assigned_client_ids || null, call_delivery: member.call_delivery || 'browser',
      agent_phone: member.agent_phone || null, is_manager: member.is_manager === true, created_at: member.created_at,
    } });
  } catch (err) { console.error('❌ Add cc team member error:', err); res.status(500).json({ error: 'Failed to add team member' }); }
});

router.put('/:callCenterId/cc/team/:memberId', requireCallCenterAccess('settings'), async (req, res) => {
  try {
    const { callCenterId, memberId } = req.params;
    const { display_name, phone, permissions, notification_prefs, status } = req.body;
    const decoded = decodeToken(req);
    if (!(await callerCanManageCcTeam(decoded, callCenterId))) return res.status(403).json({ error: 'You do not have permission to manage the team.' });
    const actingUserId = await resolveActingCcUserId(decoded, callCenterId);
    const { data: existing } = await supabase.from('team_members').select('id, member_user_id, permissions, is_manager').eq('id', memberId).eq('entity_type', 'call_center').eq('entity_id', callCenterId).single();
    if (!existing) return res.status(404).json({ error: 'Team member not found' });

    const updates = { updated_at: new Date().toISOString() };
    const userUpdates = {};
    if (display_name !== undefined) { updates.display_name = display_name; userUpdates.first_name = display_name.split(' ')[0] || display_name; userUpdates.last_name = display_name.split(' ').slice(1).join(' ') || null; }
    if (phone !== undefined) { updates.phone = phone || null; userUpdates.phone = phone || null; }
    if (permissions !== undefined) updates.permissions = sanitizeCcPermissions(permissions);
    if (notification_prefs !== undefined) updates.notification_prefs = notification_prefs;
    if (status !== undefined && ['active', 'disabled'].includes(status)) updates.status = status;
    if (req.body.assigned_client_ids !== undefined) updates.assigned_client_ids = await sanitizeAssignedClientIds(req.body.assigned_client_ids, callCenterId);
    if (req.body.call_delivery !== undefined) updates.call_delivery = req.body.call_delivery === 'phone' ? 'phone' : 'browser';
    if (req.body.agent_phone !== undefined) updates.agent_phone = (typeof req.body.agent_phone === 'string' && req.body.agent_phone.trim()) ? req.body.agent_phone.trim() : null;
    if (req.body.availability_hours !== undefined) updates.availability_hours = sanitizeAvailabilityHours(req.body.availability_hours);

    // Promote/demote between manager and agent. Keep users.role in step so login
    // and requireCallCenterAccess resolve the member consistently.
    if (req.body.is_manager !== undefined) {
      updates.is_manager = req.body.is_manager === true;
      userUpdates.role = updates.is_manager ? 'cc_manager' : 'cc_agent';
    }

    const { data: updated, error } = await supabase.from('team_members').update(updates).eq('id', memberId).select().single();
    if (error) { console.error('❌ Update cc team member error:', error); return res.status(500).json({ error: 'Failed to update team member' }); }
    if (Object.keys(userUpdates).length > 0) await supabase.from('users').update(userUpdates).eq('id', existing.member_user_id);
    if (permissions !== undefined) await logActivity(memberId, actingUserId, callCenterId, 'permissions_changed', { old: existing.permissions, new: updates.permissions });
    res.json({ success: true, member: updated });
  } catch (err) { console.error('❌ Update cc team member error:', err); res.status(500).json({ error: 'Failed to update team member' }); }
});

router.post('/:callCenterId/cc/team/:memberId/reset-password', requireCallCenterAccess('settings'), async (req, res) => {
  try {
    const { callCenterId, memberId } = req.params;
    const { password } = req.body;
    const decoded = decodeToken(req);
    if (!(await callerCanManageCcTeam(decoded, callCenterId))) return res.status(403).json({ error: 'You do not have permission to manage the team.' });
    const actingUserId = await resolveActingCcUserId(decoded, callCenterId);
    const { data: member } = await supabase.from('team_members').select('id, member_user_id, phone, display_name').eq('id', memberId).eq('entity_type', 'call_center').eq('entity_id', callCenterId).single();
    if (!member) return res.status(404).json({ error: 'Team member not found' });
    const newPassword = password || generateTempPassword();
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await supabase.from('users').update({ password_hash: passwordHash }).eq('id', member.member_user_id);
    await supabase.from('team_members').update({ visible_password: newPassword, updated_at: new Date().toISOString() }).eq('id', memberId);
    await logActivity(memberId, actingUserId, callCenterId, 'password_reset', { reset_by: 'owner' });
    if (member.phone) {
      try {
        const send = getSendSms();
        const { data: ccRow } = await supabase.from('call_centers').select('name, slug').eq('id', callCenterId).single();
        const brandName = ccRow?.name || 'VoiceAI Connect';
        const loginUrl = `https://${ccRow?.slug || 'app'}.myvoiceaiconnect.com/cc/login`;
        await send(member.phone, `Your ${brandName} password has been reset.\n\nNew password: ${newPassword}\nLogin: ${loginUrl}\n\nPlease change it after logging in.`);
      } catch {}
    }
    res.json({ success: true, visible_password: newPassword });
  } catch (err) { console.error('❌ Reset cc password error:', err); res.status(500).json({ error: 'Failed to reset password' }); }
});

router.delete('/:callCenterId/cc/team/:memberId', requireCallCenterAccess('settings'), async (req, res) => {
  try {
    const { callCenterId, memberId } = req.params;
    const decoded = decodeToken(req);
    if (!(await callerCanManageCcTeam(decoded, callCenterId))) return res.status(403).json({ error: 'You do not have permission to manage the team.' });
    const actingUserId = await resolveActingCcUserId(decoded, callCenterId);
    const { data: member } = await supabase.from('team_members').select('id, member_user_id, display_name').eq('id', memberId).eq('entity_type', 'call_center').eq('entity_id', callCenterId).single();
    if (!member) return res.status(404).json({ error: 'Team member not found' });
    await logActivity(memberId, actingUserId, callCenterId, 'member_removed', { name: member.display_name });
    await supabase.from('team_members').delete().eq('id', memberId);
    await supabase.from('users').delete().eq('id', member.member_user_id);
    res.json({ success: true });
  } catch (err) { console.error('❌ Remove cc team member error:', err); res.status(500).json({ error: 'Failed to remove team member' }); }
});

module.exports = router;

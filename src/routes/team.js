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

// Lazy-load SMS to avoid circular deps
let sendSms;
function getSendSms() {
  if (!sendSms) {
    try {
      const notifications = require('../lib/notifications');
      sendSms = notifications.sendSms || notifications.sendSMS;
    } catch {
      sendSms = async () => console.warn('⚠️ SMS not available');
    }
  }
  return sendSms;
}

// ============================================================================
// HELPERS
// ============================================================================

/** Generate a random 10-char password (readable, no ambiguous chars) */
function generateTempPassword() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pw = '';
  for (let i = 0; i < 10; i++) {
    pw += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return pw;
}

/** Default permissions by entity type */
const DEFAULT_PERMISSIONS = {
  agency: {
    dashboard: true,
    clients: true,
    leads: true,
    outreach: false,
    analytics: true,
    marketing: false,
    settings: false,
    billing: false,
  },
  client: {
    dashboard: true,
    calls: true,
    contacts: true,
    ai_agent: false,
    settings: false,
    billing: false,
  },
};

/** Validate permissions object — strip unknown keys */
function sanitizePermissions(perms, entityType) {
  const validKeys = Object.keys(DEFAULT_PERMISSIONS[entityType] || {});
  const cleaned = {};
  for (const key of validKeys) {
    cleaned[key] = typeof perms[key] === 'boolean' ? perms[key] : DEFAULT_PERMISSIONS[entityType][key];
  }
  return cleaned;
}

/** Check plan limits for team member count */
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
    // Client limit: check client.max_team_members first, fallback to agency.max_team_members_client
    const { data: client } = await supabase
      .from('clients')
      .select('max_team_members, agency_id')
      .eq('id', entityId)
      .single();

    let maxAllowed = client?.max_team_members;

    if (maxAllowed === null || maxAllowed === undefined) {
      // Fallback to agency default
      if (client?.agency_id) {
        const { data: agency } = await supabase
          .from('agencies')
          .select('max_team_members_client')
          .eq('id', client.agency_id)
          .single();
        maxAllowed = agency?.max_team_members_client ?? 0;
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

/** Log team activity */
async function logActivity(teamMemberId, userId, entityType, entityId, action, details = null) {
  try {
    await supabase.from('team_activity_log').insert({
      team_member_id: teamMemberId,
      user_id: userId,
      entity_type: entityType,
      entity_id: entityId,
      action,
      details,
    });
  } catch (err) {
    console.error('⚠️ Failed to log team activity:', err.message);
  }
}

// ============================================================================
// GET /:agencyId/team — List agency team members
// ============================================================================
router.get('/:agencyId/team', async (req, res) => {
  try {
    const { agencyId } = req.params;

    const { data: members, error } = await supabase
      .from('team_members')
      .select(`
        id, display_name, phone, visible_password, permissions, 
        notification_prefs, status, created_at, updated_at,
        member_user_id,
        users:member_user_id (
          id, email, last_login, avatar_url
        )
      `)
      .eq('entity_type', 'agency')
      .eq('entity_id', agencyId)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('❌ Fetch team error:', error);
      return res.status(500).json({ error: 'Failed to fetch team members' });
    }

    // Check plan limits
    const limits = await checkTeamLimit('agency', agencyId);

    res.json({
      success: true,
      members: (members || []).map(m => ({
        id: m.id,
        display_name: m.display_name,
        phone: m.phone,
        email: m.users?.email || null,
        visible_password: m.visible_password,
        permissions: m.permissions,
        notification_prefs: m.notification_prefs,
        status: m.status,
        last_login: m.users?.last_login || null,
        avatar_url: m.users?.avatar_url || null,
        created_at: m.created_at,
      })),
      limits,
    });
  } catch (err) {
    console.error('❌ List team error:', err);
    res.status(500).json({ error: 'Failed to fetch team members' });
  }
});

// ============================================================================
// POST /:agencyId/team — Add agency team member
// Body: { name, email, phone, permissions? }
// ============================================================================
router.post('/:agencyId/team', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const { name, email, phone, permissions } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required' });
    }

    // Check plan limit
    const limits = await checkTeamLimit('agency', agencyId);
    if (!limits.allowed) {
      return res.status(403).json({
        error: `Team member limit reached (${limits.current}/${limits.max}). Upgrade your plan to add more.`,
        limits,
      });
    }

    // Check if email already exists as a user
    const { data: existingUser } = await supabase
      .from('users')
      .select('id, email, role, agency_id')
      .eq('email', email.toLowerCase())
      .single();

    if (existingUser) {
      // If already a team member of this agency, reject
      if (existingUser.agency_id === agencyId) {
        return res.status(409).json({ error: 'A user with this email already exists for this agency' });
      }
      return res.status(409).json({ error: 'This email is already associated with another account' });
    }

    // Get the owner user (from JWT — the person making the request)
    const jwt = require('jsonwebtoken');
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key-change-in-production');
    const ownerUserId = decoded.userId;

    // Generate temp password
    const tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    // Create user record
    const { data: newUser, error: userError } = await supabase
      .from('users')
      .insert({
        email: email.toLowerCase(),
        password_hash: passwordHash,
        first_name: name.split(' ')[0] || name,
        last_name: name.split(' ').slice(1).join(' ') || null,
        phone: phone || null,
        role: 'agency_staff',
        agency_id: agencyId,
        invited_by: ownerUserId,
      })
      .select('id, email, first_name, last_name')
      .single();

    if (userError) {
      console.error('❌ Create user error:', userError);
      return res.status(500).json({ error: 'Failed to create user account' });
    }

    // Create team_members record
    const sanitizedPerms = sanitizePermissions(permissions || {}, 'agency');

    const { data: member, error: memberError } = await supabase
      .from('team_members')
      .insert({
        owner_user_id: ownerUserId,
        member_user_id: newUser.id,
        entity_type: 'agency',
        entity_id: agencyId,
        display_name: name,
        phone: phone || null,
        visible_password: tempPassword,
        permissions: sanitizedPerms,
        status: 'active',
      })
      .select()
      .single();

    if (memberError) {
      console.error('❌ Create team member error:', memberError);
      // Rollback user creation
      await supabase.from('users').delete().eq('id', newUser.id);
      return res.status(500).json({ error: 'Failed to create team member' });
    }

    // Log activity
    await logActivity(member.id, ownerUserId, 'agency', agencyId, 'member_added', {
      name, email: email.toLowerCase(), phone,
    });

    // Send SMS with credentials
    if (phone) {
      try {
        const send = getSendSms();
        const loginUrl = `https://myvoiceaiconnect.com/agency/login`;
        await send(phone, 
          `You've been added to a VoiceAI Connect team!\n\nLogin: ${loginUrl}\nEmail: ${email.toLowerCase()}\nPassword: ${tempPassword}\n\nChange your password after first login.`
        );
        console.log(`📱 SMS credentials sent to ${phone}`);
      } catch (smsErr) {
        console.warn('⚠️ SMS send failed (non-blocking):', smsErr.message);
      }
    }

    console.log(`✅ Team member added: ${name} (${email}) → agency ${agencyId}`);

    res.json({
      success: true,
      member: {
        id: member.id,
        display_name: member.display_name,
        phone: member.phone,
        email: newUser.email,
        visible_password: tempPassword,
        permissions: member.permissions,
        notification_prefs: member.notification_prefs,
        status: member.status,
        created_at: member.created_at,
      },
    });
  } catch (err) {
    console.error('❌ Add team member error:', err);
    res.status(500).json({ error: 'Failed to add team member' });
  }
});

// ============================================================================
// PUT /:agencyId/team/:memberId — Update team member
// Body: { display_name?, phone?, permissions?, notification_prefs?, status? }
// ============================================================================
router.put('/:agencyId/team/:memberId', async (req, res) => {
  try {
    const { agencyId, memberId } = req.params;
    const { display_name, phone, permissions, notification_prefs, status } = req.body;

    // Verify member belongs to this agency
    const { data: existing } = await supabase
      .from('team_members')
      .select('id, member_user_id, permissions')
      .eq('id', memberId)
      .eq('entity_type', 'agency')
      .eq('entity_id', agencyId)
      .single();

    if (!existing) {
      return res.status(404).json({ error: 'Team member not found' });
    }

    const updates = { updated_at: new Date().toISOString() };
    const userUpdates = {};

    if (display_name !== undefined) {
      updates.display_name = display_name;
      userUpdates.first_name = display_name.split(' ')[0] || display_name;
      userUpdates.last_name = display_name.split(' ').slice(1).join(' ') || null;
    }
    if (phone !== undefined) {
      updates.phone = phone || null;
      userUpdates.phone = phone || null;
    }
    if (permissions !== undefined) {
      updates.permissions = sanitizePermissions(permissions, 'agency');
    }
    if (notification_prefs !== undefined) {
      updates.notification_prefs = notification_prefs;
    }
    if (status !== undefined && ['active', 'disabled'].includes(status)) {
      updates.status = status;
    }

    const { data: updated, error } = await supabase
      .from('team_members')
      .update(updates)
      .eq('id', memberId)
      .select()
      .single();

    if (error) {
      console.error('❌ Update team member error:', error);
      return res.status(500).json({ error: 'Failed to update team member' });
    }

    // Sync user table if name/phone changed
    if (Object.keys(userUpdates).length > 0) {
      await supabase.from('users').update(userUpdates).eq('id', existing.member_user_id);
    }

    // Log permission changes
    if (permissions !== undefined) {
      const jwt = require('jsonwebtoken');
      const token = req.headers.authorization?.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key-change-in-production');
      await logActivity(memberId, decoded.userId, 'agency', agencyId, 'permissions_changed', {
        old: existing.permissions,
        new: updates.permissions,
      });
    }

    console.log(`✅ Team member updated: ${memberId}`);
    res.json({ success: true, member: updated });
  } catch (err) {
    console.error('❌ Update team member error:', err);
    res.status(500).json({ error: 'Failed to update team member' });
  }
});

// ============================================================================
// POST /:agencyId/team/:memberId/reset-password — Reset password
// Body: { password? } — if omitted, generates a new temp password
// ============================================================================
router.post('/:agencyId/team/:memberId/reset-password', async (req, res) => {
  try {
    const { agencyId, memberId } = req.params;
    const { password } = req.body;

    // Verify member belongs to this agency
    const { data: member } = await supabase
      .from('team_members')
      .select('id, member_user_id, phone, display_name')
      .eq('id', memberId)
      .eq('entity_type', 'agency')
      .eq('entity_id', agencyId)
      .single();

    if (!member) {
      return res.status(404).json({ error: 'Team member not found' });
    }

    const newPassword = password || generateTempPassword();
    const passwordHash = await bcrypt.hash(newPassword, 10);

    // Update users table
    await supabase.from('users').update({ password_hash: passwordHash }).eq('id', member.member_user_id);

    // Update visible_password in team_members
    await supabase.from('team_members').update({
      visible_password: newPassword,
      updated_at: new Date().toISOString(),
    }).eq('id', memberId);

    // Log
    const jwt = require('jsonwebtoken');
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key-change-in-production');
    await logActivity(memberId, decoded.userId, 'agency', agencyId, 'password_reset', {
      reset_by: 'owner',
    });

    // Send SMS with new password
    if (member.phone) {
      try {
        const send = getSendSms();
        await send(member.phone,
          `Your VoiceAI Connect password has been reset.\n\nNew password: ${newPassword}\n\nPlease change it after logging in.`
        );
      } catch (smsErr) {
        console.warn('⚠️ SMS send failed:', smsErr.message);
      }
    }

    console.log(`✅ Password reset for team member: ${member.display_name}`);
    res.json({ success: true, visible_password: newPassword });
  } catch (err) {
    console.error('❌ Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ============================================================================
// DELETE /:agencyId/team/:memberId — Remove team member
// ============================================================================
router.delete('/:agencyId/team/:memberId', async (req, res) => {
  try {
    const { agencyId, memberId } = req.params;

    const { data: member } = await supabase
      .from('team_members')
      .select('id, member_user_id, display_name')
      .eq('id', memberId)
      .eq('entity_type', 'agency')
      .eq('entity_id', agencyId)
      .single();

    if (!member) {
      return res.status(404).json({ error: 'Team member not found' });
    }

    // Log before deleting
    const jwt = require('jsonwebtoken');
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key-change-in-production');
    await logActivity(memberId, decoded.userId, 'agency', agencyId, 'member_removed', {
      name: member.display_name,
    });

    // Delete team_members row (cascades to activity log references via SET NULL)
    await supabase.from('team_members').delete().eq('id', memberId);

    // Delete user account
    await supabase.from('users').delete().eq('id', member.member_user_id);

    console.log(`✅ Team member removed: ${member.display_name}`);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Remove team member error:', err);
    res.status(500).json({ error: 'Failed to remove team member' });
  }
});

// ============================================================================
// CLIENT-LEVEL TEAM ROUTES
// Mounted under /api/client — uses same pattern, different entity_type
// ============================================================================

// GET /api/client/:clientId/team
router.get('/client/:clientId/team', async (req, res) => {
  try {
    const { clientId } = req.params;

    const { data: members, error } = await supabase
      .from('team_members')
      .select(`
        id, display_name, phone, visible_password, permissions, 
        notification_prefs, status, created_at, updated_at,
        member_user_id,
        users:member_user_id ( id, email, last_login )
      `)
      .eq('entity_type', 'client')
      .eq('entity_id', clientId)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('❌ Fetch client team error:', error);
      return res.status(500).json({ error: 'Failed to fetch team members' });
    }

    const limits = await checkTeamLimit('client', clientId);

    res.json({
      success: true,
      members: (members || []).map(m => ({
        id: m.id,
        display_name: m.display_name,
        phone: m.phone,
        email: m.users?.email || null,
        visible_password: m.visible_password,
        permissions: m.permissions,
        notification_prefs: m.notification_prefs,
        status: m.status,
        last_login: m.users?.last_login || null,
        created_at: m.created_at,
      })),
      limits,
    });
  } catch (err) {
    console.error('❌ List client team error:', err);
    res.status(500).json({ error: 'Failed to fetch team members' });
  }
});

// POST /api/client/:clientId/team
router.post('/client/:clientId/team', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { name, email, phone, permissions } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required' });
    }

    const limits = await checkTeamLimit('client', clientId);
    if (!limits.allowed) {
      return res.status(403).json({
        error: `Team member limit reached (${limits.current}/${limits.max}). Contact your provider to upgrade.`,
        limits,
      });
    }

    // Get client's agency_id for the user record
    const { data: client } = await supabase
      .from('clients')
      .select('agency_id')
      .eq('id', clientId)
      .single();

    // Check existing
    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('email', email.toLowerCase())
      .single();

    if (existingUser) {
      return res.status(409).json({ error: 'This email is already associated with an account' });
    }

    const jwt = require('jsonwebtoken');
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key-change-in-production');
    const ownerUserId = decoded.userId;

    const tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    // Create user
    const { data: newUser, error: userError } = await supabase
      .from('users')
      .insert({
        email: email.toLowerCase(),
        password_hash: passwordHash,
        first_name: name.split(' ')[0] || name,
        last_name: name.split(' ').slice(1).join(' ') || null,
        phone: phone || null,
        role: 'client_staff',
        client_id: clientId,
        agency_id: client?.agency_id || null,
        invited_by: ownerUserId,
      })
      .select('id, email')
      .single();

    if (userError) {
      console.error('❌ Create client team user error:', userError);
      return res.status(500).json({ error: 'Failed to create user account' });
    }

    const sanitizedPerms = sanitizePermissions(permissions || {}, 'client');

    const { data: member, error: memberError } = await supabase
      .from('team_members')
      .insert({
        owner_user_id: ownerUserId,
        member_user_id: newUser.id,
        entity_type: 'client',
        entity_id: clientId,
        display_name: name,
        phone: phone || null,
        visible_password: tempPassword,
        permissions: sanitizedPerms,
        status: 'active',
      })
      .select()
      .single();

    if (memberError) {
      console.error('❌ Create client team member error:', memberError);
      await supabase.from('users').delete().eq('id', newUser.id);
      return res.status(500).json({ error: 'Failed to create team member' });
    }

    await logActivity(member.id, ownerUserId, 'client', clientId, 'member_added', { name, email: email.toLowerCase() });

    // Send SMS
    if (phone) {
      try {
        const send = getSendSms();
        await send(phone,
          `You've been added as a team member!\n\nLogin: https://myvoiceaiconnect.com/client/login\nEmail: ${email.toLowerCase()}\nPassword: ${tempPassword}`
        );
      } catch (smsErr) {
        console.warn('⚠️ SMS send failed:', smsErr.message);
      }
    }

    console.log(`✅ Client team member added: ${name} → client ${clientId}`);

    res.json({
      success: true,
      member: {
        id: member.id,
        display_name: member.display_name,
        phone: member.phone,
        email: newUser.email,
        visible_password: tempPassword,
        permissions: member.permissions,
        notification_prefs: member.notification_prefs,
        status: member.status,
        created_at: member.created_at,
      },
    });
  } catch (err) {
    console.error('❌ Add client team member error:', err);
    res.status(500).json({ error: 'Failed to add team member' });
  }
});

// PUT /api/client/:clientId/team/:memberId
router.put('/client/:clientId/team/:memberId', async (req, res) => {
  try {
    const { clientId, memberId } = req.params;
    const { display_name, phone, permissions, notification_prefs, status } = req.body;

    const { data: existing } = await supabase
      .from('team_members')
      .select('id, member_user_id')
      .eq('id', memberId)
      .eq('entity_type', 'client')
      .eq('entity_id', clientId)
      .single();

    if (!existing) return res.status(404).json({ error: 'Team member not found' });

    const updates = { updated_at: new Date().toISOString() };
    const userUpdates = {};

    if (display_name !== undefined) {
      updates.display_name = display_name;
      userUpdates.first_name = display_name.split(' ')[0];
      userUpdates.last_name = display_name.split(' ').slice(1).join(' ') || null;
    }
    if (phone !== undefined) { updates.phone = phone || null; userUpdates.phone = phone || null; }
    if (permissions !== undefined) updates.permissions = sanitizePermissions(permissions, 'client');
    if (notification_prefs !== undefined) updates.notification_prefs = notification_prefs;
    if (status !== undefined && ['active', 'disabled'].includes(status)) updates.status = status;

    const { data: updated, error } = await supabase
      .from('team_members').update(updates).eq('id', memberId).select().single();

    if (error) return res.status(500).json({ error: 'Failed to update team member' });

    if (Object.keys(userUpdates).length > 0) {
      await supabase.from('users').update(userUpdates).eq('id', existing.member_user_id);
    }

    res.json({ success: true, member: updated });
  } catch (err) {
    console.error('❌ Update client team member error:', err);
    res.status(500).json({ error: 'Failed to update team member' });
  }
});

// POST /api/client/:clientId/team/:memberId/reset-password
router.post('/client/:clientId/team/:memberId/reset-password', async (req, res) => {
  try {
    const { clientId, memberId } = req.params;

    const { data: member } = await supabase
      .from('team_members')
      .select('id, member_user_id, phone, display_name')
      .eq('id', memberId)
      .eq('entity_type', 'client')
      .eq('entity_id', clientId)
      .single();

    if (!member) return res.status(404).json({ error: 'Team member not found' });

    const newPassword = req.body.password || generateTempPassword();
    const passwordHash = await bcrypt.hash(newPassword, 10);

    await supabase.from('users').update({ password_hash: passwordHash }).eq('id', member.member_user_id);
    await supabase.from('team_members').update({ visible_password: newPassword, updated_at: new Date().toISOString() }).eq('id', memberId);

    if (member.phone) {
      try {
        const send = getSendSms();
        await send(member.phone, `Your password has been reset.\n\nNew password: ${newPassword}`);
      } catch {}
    }

    res.json({ success: true, visible_password: newPassword });
  } catch (err) {
    console.error('❌ Reset client team password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// DELETE /api/client/:clientId/team/:memberId
router.delete('/client/:clientId/team/:memberId', async (req, res) => {
  try {
    const { clientId, memberId } = req.params;

    const { data: member } = await supabase
      .from('team_members')
      .select('id, member_user_id, display_name')
      .eq('id', memberId)
      .eq('entity_type', 'client')
      .eq('entity_id', clientId)
      .single();

    if (!member) return res.status(404).json({ error: 'Team member not found' });

    await supabase.from('team_members').delete().eq('id', memberId);
    await supabase.from('users').delete().eq('id', member.member_user_id);

    console.log(`✅ Client team member removed: ${member.display_name}`);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Remove client team member error:', err);
    res.status(500).json({ error: 'Failed to remove team member' });
  }
});

module.exports = router;
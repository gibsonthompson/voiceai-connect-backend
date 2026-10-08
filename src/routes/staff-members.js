// ============================================================================
// STAFF MEMBERS ROUTES, CRUD for per-client staff profiles
// VoiceAI Connect, Phase 3A: Staff Members + Services
//
// Mounted at: app.use('/api/client', staffMembersRoutes)
// Endpoints:
//   GET    /api/client/:clientId/staff
//   POST   /api/client/:clientId/staff
//   PUT    /api/client/:clientId/staff/:staffId
//   DELETE /api/client/:clientId/staff/:staffId
//
// UPDATED: 2026-06-16, Per-tab Page Access enforcement. requirePermissionIfAuthed('my_business')
//          on every route (Staff Directory lives under the My Business tab).
//          NOTE: this is the AI's staff DIRECTORY (providers the AI references
//          on calls), NOT dashboard login users, those are team_members.
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { requirePermissionIfAuthed } = require('./auth');
const { isSimilar } = require('../lib/scrape-suggestions');

// ============================================================================
// GET /api/client/:clientId/staff, List all staff for a client
// ============================================================================
router.get('/:clientId/staff', requirePermissionIfAuthed('my_business'), async (req, res) => {
  try {
    const { clientId } = req.params;

    const { data: staff, error } = await supabase
      .from('staff_members')
      .select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Error fetching staff:', error);
      return res.status(400).json({ error: error.message });
    }

    // Website-scraped staff suggestions, re-filtered against current staff so
    // anyone the client has added since the scrape drops off automatically.
    let suggestions = [];
    try {
      const { data: clientRow } = await supabase
        .from('clients')
        .select('staff_suggestions')
        .eq('id', clientId)
        .single();
      const raw = Array.isArray(clientRow?.staff_suggestions) ? clientRow.staff_suggestions : [];
      const existing = (staff || []).map(s => s.name);
      suggestions = raw.filter(sg => sg && sg.name && !existing.some(ex => isSimilar(sg.name, ex)));
    } catch (e) { /* best-effort */ }

    res.json({ success: true, staff: staff || [], suggestions });
  } catch (error) {
    console.error('Error fetching staff:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// POST /api/client/:clientId/staff/suggestions/dismiss, remove one scraped
// staff suggestion by name. Defined before the /:staffId routes so "suggestions"
// is never matched as a staff id.
// ============================================================================
router.post('/:clientId/staff/suggestions/dismiss', requirePermissionIfAuthed('my_business'), async (req, res) => {
  try {
    const { clientId } = req.params;
    const { name } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    const { data: clientRow } = await supabase
      .from('clients')
      .select('staff_suggestions')
      .eq('id', clientId)
      .single();
    const raw = Array.isArray(clientRow?.staff_suggestions) ? clientRow.staff_suggestions : [];
    const remaining = raw.filter(sg => !(sg && sg.name && isSimilar(sg.name, name)));
    await supabase.from('clients').update({ staff_suggestions: remaining }).eq('id', clientId);
    res.json({ success: true, suggestions: remaining });
  } catch (error) {
    console.error('Error dismissing staff suggestion:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// POST /api/client/:clientId/staff, Create a new staff member
// ============================================================================
router.post('/:clientId/staff', requirePermissionIfAuthed('my_business'), async (req, res) => {
  try {
    const { clientId } = req.params;
    const { name, role, phone, email, notes, available_hours, transferable } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Staff member name is required' });
    }

    const staffData = {
      client_id: clientId,
      name: name.trim(),
      role: role?.trim() || null,
      phone: phone?.trim() || null,
      email: email?.trim()?.toLowerCase() || null,
      notes: notes?.trim() || null,
      available_hours: available_hours || {},
      services: [],
      is_active: true,
      // Whether the AI may transfer a live caller to this person. Only takes
      // effect on calls when the member also has a phone number.
      transferable: transferable === true,
    };

    const { data: staff, error } = await supabase
      .from('staff_members')
      .insert(staffData)
      .select()
      .single();

    if (error) {
      console.error('Error creating staff member:', error);
      return res.status(400).json({ error: error.message });
    }

    console.log(`✅ Staff member created: ${staff.name} for client ${clientId}`);
    res.json({ success: true, staff });
  } catch (error) {
    console.error('Error creating staff member:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// PUT /api/client/:clientId/staff/:staffId, Update a staff member
// ============================================================================
router.put('/:clientId/staff/:staffId', requirePermissionIfAuthed('my_business'), async (req, res) => {
  try {
    const { clientId, staffId } = req.params;
    const { name, role, phone, email, notes, available_hours, is_active, transferable } = req.body;

    const updates = {};
    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ error: 'Name cannot be empty' });
      updates.name = name.trim();
    }
    if (role !== undefined) updates.role = role?.trim() || null;
    if (phone !== undefined) updates.phone = phone?.trim() || null;
    if (email !== undefined) updates.email = email?.trim()?.toLowerCase() || null;
    if (notes !== undefined) updates.notes = notes?.trim() || null;
    if (available_hours !== undefined) updates.available_hours = available_hours;
    if (is_active !== undefined) updates.is_active = is_active;
    if (transferable !== undefined) updates.transferable = transferable === true;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    const { data: staff, error } = await supabase
      .from('staff_members')
      .update(updates)
      .eq('id', staffId)
      .eq('client_id', clientId)
      .select()
      .single();

    if (error) {
      console.error('Error updating staff member:', error);
      return res.status(400).json({ error: error.message });
    }

    if (!staff) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    console.log(`✅ Staff member updated: ${staff.name} (${staffId})`);
    res.json({ success: true, staff });
  } catch (error) {
    console.error('Error updating staff member:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// DELETE /api/client/:clientId/staff/:staffId, Delete a staff member
// ============================================================================
router.delete('/:clientId/staff/:staffId', requirePermissionIfAuthed('my_business'), async (req, res) => {
  try {
    const { clientId, staffId } = req.params;

    // Remove this staff member from any service assignments
    const { data: services } = await supabase
      .from('client_services')
      .select('id, assigned_staff')
      .eq('client_id', clientId);

    if (services) {
      for (const svc of services) {
        if (Array.isArray(svc.assigned_staff) && svc.assigned_staff.includes(staffId)) {
          const updated = svc.assigned_staff.filter(id => id !== staffId);
          await supabase
            .from('client_services')
            .update({ assigned_staff: updated })
            .eq('id', svc.id);
        }
      }
    }

    const { error } = await supabase
      .from('staff_members')
      .delete()
      .eq('id', staffId)
      .eq('client_id', clientId);

    if (error) {
      console.error('Error deleting staff member:', error);
      return res.status(400).json({ error: error.message });
    }

    console.log(`✅ Staff member deleted: ${staffId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting staff member:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
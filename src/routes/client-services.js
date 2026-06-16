// ============================================================================
// CLIENT SERVICES ROUTES — CRUD for per-client service definitions
// VoiceAI Connect — Phase 3A: Staff Members + Services
//
// Mounted at: app.use('/api/client', clientServicesRoutes)
// Endpoints:
//   GET    /api/client/:clientId/services
//   POST   /api/client/:clientId/services
//   PUT    /api/client/:clientId/services/:serviceId
//   DELETE /api/client/:clientId/services/:serviceId
//   PUT    /api/client/:clientId/services/reorder
//
// UPDATED: 2026-06-16 — Per-tab Page Access enforcement. requirePermissionIfAuthed('my_business')
//          on every route (Services live under the My Business tab).
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { requirePermissionIfAuthed } = require('./auth');

// ============================================================================
// GET /api/client/:clientId/services — List all services for a client
// ============================================================================
router.get('/:clientId/services', requirePermissionIfAuthed('my_business'), async (req, res) => {
  try {
    const { clientId } = req.params;

    const { data: services, error } = await supabase
      .from('client_services')
      .select('*')
      .eq('client_id', clientId)
      .order('sort_order', { ascending: true });

    if (error) {
      console.error('Error fetching services:', error);
      return res.status(400).json({ error: error.message });
    }

    // Also fetch staff names for display (assigned_staff are UUIDs)
    const { data: staff } = await supabase
      .from('staff_members')
      .select('id, name')
      .eq('client_id', clientId)
      .eq('is_active', true);

    const staffMap = {};
    (staff || []).forEach(s => { staffMap[s.id] = s.name; });

    res.json({ success: true, services: services || [], staffMap });
  } catch (error) {
    console.error('Error fetching services:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// POST /api/client/:clientId/services — Create a new service
// ============================================================================
router.post('/:clientId/services', requirePermissionIfAuthed('my_business'), async (req, res) => {
  try {
    const { clientId } = req.params;
    const { name, duration_minutes, buffer_minutes, booking_mode, assigned_staff } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Service name is required' });
    }

    if (booking_mode && !['auto_book', 'collect_request', 'disabled'].includes(booking_mode)) {
      return res.status(400).json({ error: 'Invalid booking_mode' });
    }

    // Get next sort_order
    const { data: existing } = await supabase
      .from('client_services')
      .select('sort_order')
      .eq('client_id', clientId)
      .order('sort_order', { ascending: false })
      .limit(1);

    const nextOrder = existing && existing.length > 0 ? (existing[0].sort_order || 0) + 1 : 0;

    const serviceData = {
      client_id: clientId,
      name: name.trim(),
      duration_minutes: duration_minutes || 30,
      buffer_minutes: buffer_minutes || 0,
      booking_mode: booking_mode || 'auto_book',
      assigned_staff: Array.isArray(assigned_staff) ? assigned_staff : [],
      is_active: true,
      sort_order: nextOrder,
    };

    const { data: service, error } = await supabase
      .from('client_services')
      .insert(serviceData)
      .select()
      .single();

    if (error) {
      console.error('Error creating service:', error);
      return res.status(400).json({ error: error.message });
    }

    console.log(`✅ Service created: ${service.name} for client ${clientId}`);
    res.json({ success: true, service });
  } catch (error) {
    console.error('Error creating service:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// PUT /api/client/:clientId/services/reorder — Reorder services
// Must be defined BEFORE the /:serviceId route to avoid matching "reorder" as a UUID
// ============================================================================
router.put('/:clientId/services/reorder', requirePermissionIfAuthed('my_business'), async (req, res) => {
  try {
    const { clientId } = req.params;
    const { order } = req.body; // Array of { id, sort_order }

    if (!Array.isArray(order)) {
      return res.status(400).json({ error: 'order must be an array of { id, sort_order }' });
    }

    for (const item of order) {
      await supabase
        .from('client_services')
        .update({ sort_order: item.sort_order })
        .eq('id', item.id)
        .eq('client_id', clientId);
    }

    console.log(`✅ Services reordered for client ${clientId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error reordering services:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// PUT /api/client/:clientId/services/:serviceId — Update a service
// ============================================================================
router.put('/:clientId/services/:serviceId', requirePermissionIfAuthed('my_business'), async (req, res) => {
  try {
    const { clientId, serviceId } = req.params;
    const { name, duration_minutes, buffer_minutes, booking_mode, assigned_staff, is_active } = req.body;

    const updates = {};
    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ error: 'Name cannot be empty' });
      updates.name = name.trim();
    }
    if (duration_minutes !== undefined) {
      const dur = parseInt(duration_minutes);
      if (isNaN(dur) || dur < 5 || dur > 480) return res.status(400).json({ error: 'Duration must be between 5 and 480 minutes' });
      updates.duration_minutes = dur;
    }
    if (buffer_minutes !== undefined) {
      const buf = parseInt(buffer_minutes);
      if (isNaN(buf) || buf < 0 || buf > 120) return res.status(400).json({ error: 'Buffer must be between 0 and 120 minutes' });
      updates.buffer_minutes = buf;
    }
    if (booking_mode !== undefined) {
      if (!['auto_book', 'collect_request', 'disabled'].includes(booking_mode)) return res.status(400).json({ error: 'Invalid booking_mode' });
      updates.booking_mode = booking_mode;
    }
    if (assigned_staff !== undefined) {
      if (!Array.isArray(assigned_staff)) return res.status(400).json({ error: 'assigned_staff must be an array' });
      updates.assigned_staff = assigned_staff;
    }
    if (is_active !== undefined) updates.is_active = is_active;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    const { data: service, error } = await supabase
      .from('client_services')
      .update(updates)
      .eq('id', serviceId)
      .eq('client_id', clientId)
      .select()
      .single();

    if (error) {
      console.error('Error updating service:', error);
      return res.status(400).json({ error: error.message });
    }

    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    console.log(`✅ Service updated: ${service.name} (${serviceId})`);
    res.json({ success: true, service });
  } catch (error) {
    console.error('Error updating service:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// DELETE /api/client/:clientId/services/:serviceId — Delete a service
// ============================================================================
router.delete('/:clientId/services/:serviceId', requirePermissionIfAuthed('my_business'), async (req, res) => {
  try {
    const { clientId, serviceId } = req.params;

    const { error } = await supabase
      .from('client_services')
      .delete()
      .eq('id', serviceId)
      .eq('client_id', clientId);

    if (error) {
      console.error('Error deleting service:', error);
      return res.status(400).json({ error: error.message });
    }

    console.log(`✅ Service deleted: ${serviceId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting service:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
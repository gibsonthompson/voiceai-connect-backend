// ============================================================================
// CLIENT CONTACTS ROUTES - Lead Capture / Mini-CRM for Clients
// VoiceAI Connect Multi-Tenant
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');

// ============================================================================
// GET /api/client/:id/contacts - List all contacts with stats
// Supports: ?search=, ?status=, ?sort=recent|calls|name, ?limit=, ?offset=
// ============================================================================
router.get('/:id/contacts', async (req, res) => {
  try {
    const { id } = req.params;
    const { search, status, sort = 'recent', limit = '50', offset = '0' } = req.query;

    let query = supabase
      .from('client_contacts')
      .select('*', { count: 'exact' })
      .eq('client_id', id);

    // Filters
    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    if (search) {
      query = query.or(
        `name.ilike.%${search}%,phone.ilike.%${search}%,email.ilike.%${search}%`
      );
    }

    // Sorting
    switch (sort) {
      case 'calls':
        query = query.order('total_calls', { ascending: false });
        break;
      case 'name':
        query = query.order('name', { ascending: true });
        break;
      case 'oldest':
        query = query.order('created_at', { ascending: true });
        break;
      case 'recent':
      default:
        query = query.order('last_call_at', { ascending: false, nullsFirst: false });
        break;
    }

    query = query.range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    const { data: contacts, error, count } = await query;

    if (error) {
      console.error('Error fetching contacts:', error);
      return res.status(400).json({ error: error.message });
    }

    // Calculate aggregate stats
    const { data: statsData } = await supabase
      .from('client_contacts')
      .select('status')
      .eq('client_id', id);

    const stats = {
      total: statsData?.length || 0,
      new: statsData?.filter(c => c.status === 'new').length || 0,
      active: statsData?.filter(c => c.status === 'active').length || 0,
      converted: statsData?.filter(c => c.status === 'converted').length || 0,
      inactive: statsData?.filter(c => c.status === 'inactive').length || 0,
    };

    res.json({
      contacts: contacts || [],
      stats,
      pagination: {
        total: count || 0,
        limit: parseInt(limit),
        offset: parseInt(offset),
      },
    });
  } catch (error) {
    console.error('Error fetching contacts:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// GET /api/client/:id/contacts/:contactId - Single contact with call history
// ============================================================================
router.get('/:id/contacts/:contactId', async (req, res) => {
  try {
    const { id, contactId } = req.params;

    const { data: contact, error } = await supabase
      .from('client_contacts')
      .select('*')
      .eq('id', contactId)
      .eq('client_id', id)
      .single();

    if (error || !contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    // Get all calls from this contact (match by phone + client_id)
    const { data: calls } = await supabase
      .from('calls')
      .select('*')
      .eq('client_id', id)
      .or(`customer_phone.eq.${contact.phone},caller_phone.eq.${contact.phone}`)
      .order('created_at', { ascending: false });

    res.json({
      contact,
      calls: calls || [],
    });
  } catch (error) {
    console.error('Error fetching contact detail:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// PUT /api/client/:id/contacts/:contactId - Update contact
// Supports: status, notes, tags, name, email, address
// ============================================================================
router.put('/:id/contacts/:contactId', async (req, res) => {
  try {
    const { id, contactId } = req.params;
    const { status, notes, tags, name, email, address } = req.body;

    const updates = {};
    if (status !== undefined) updates.status = status;
    if (notes !== undefined) updates.notes = notes;
    if (tags !== undefined) updates.tags = tags;
    if (name !== undefined) updates.name = name;
    if (email !== undefined) updates.email = email;
    if (address !== undefined) updates.address = address;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    const { data: contact, error } = await supabase
      .from('client_contacts')
      .update(updates)
      .eq('id', contactId)
      .eq('client_id', id)
      .select()
      .single();

    if (error) {
      console.error('Error updating contact:', error);
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, contact });
  } catch (error) {
    console.error('Error updating contact:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// POST /api/client/:id/contacts - Manually create a contact
// ============================================================================
router.post('/:id/contacts', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone, email, address, notes, status } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    // Get client to find agency_id
    const { data: client } = await supabase
      .from('clients')
      .select('agency_id')
      .eq('id', id)
      .single();

    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    // Normalize phone (strip non-digits, ensure +1 prefix)
    const normalizedPhone = normalizePhone(phone);

    // Check for existing contact with same phone
    const { data: existing } = await supabase
      .from('client_contacts')
      .select('id')
      .eq('client_id', id)
      .eq('phone', normalizedPhone)
      .single();

    if (existing) {
      return res.status(409).json({ error: 'Contact with this phone number already exists', contactId: existing.id });
    }

    const { data: contact, error } = await supabase
      .from('client_contacts')
      .insert([{
        client_id: id,
        agency_id: client.agency_id,
        name: name || 'Unknown',
        phone: normalizedPhone,
        email: email || null,
        address: address || null,
        notes: notes || null,
        status: status || 'new',
        source: 'manual',
        total_calls: 0,
        tags: [],
      }])
      .select()
      .single();

    if (error) {
      console.error('Error creating contact:', error);
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json({ success: true, contact });
  } catch (error) {
    console.error('Error creating contact:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// DELETE /api/client/:id/contacts/:contactId - Delete a contact
// ============================================================================
router.delete('/:id/contacts/:contactId', async (req, res) => {
  try {
    const { id, contactId } = req.params;

    const { error } = await supabase
      .from('client_contacts')
      .delete()
      .eq('id', contactId)
      .eq('client_id', id);

    if (error) {
      console.error('Error deleting contact:', error);
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting contact:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// HELPER: Normalize phone number
// ============================================================================
function normalizePhone(phone) {
  if (!phone) return phone;
  // Strip everything except digits and leading +
  let digits = phone.replace(/[^\d+]/g, '');
  // If it starts with +, keep it
  if (digits.startsWith('+')) return digits;
  // If 10 digits, assume US and prepend +1
  if (digits.length === 10) return `+1${digits}`;
  // If 11 digits starting with 1, prepend +
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return digits;
}

module.exports = router;
module.exports.normalizePhone = normalizePhone;
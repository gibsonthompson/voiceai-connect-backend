// ============================================================================
// CLIENT CONTACTS ROUTES - Lead Capture / Mini-CRM for Clients
// VoiceAI Connect Multi-Tenant
// UPDATED: 2026-06-16 — Per-tab Page Access enforcement. requirePermissionIfAuthed('contacts')
//          on every route so a client_staff member without the Contacts toggle
//          gets a 403 from the API, not just a hidden nav link. Owners and
//          untokened callers pass through unchanged.
// UPDATED: 2026-06-18 — FIX: contact detail call history was always empty. The
//          old query used .or(customer_phone.eq.X,caller_phone.eq.X); caller_phone
//          is not a column on calls, so the whole query errored and returned
//          nothing, and the exact-string match also missed because customer_phone
//          is stored AI-formatted ("(305) 555-1234") while contact.phone is
//          normalized ("+13055551234"). Now matched by calls.contact_id AND a set
//          of phone-format candidates, merged + de-duped. Also added GET
//          /:id/contacts/export (CSV) so the dashboard Export button stops 404ing.
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { requirePermissionIfAuthed } = require('./auth');

// ============================================================================
// GET /api/client/:id/contacts - List all contacts with stats
// Supports: ?search=, ?status=, ?sort=recent|calls|name, ?limit=, ?offset=
// ============================================================================
router.get('/:id/contacts', requirePermissionIfAuthed('contacts'), async (req, res) => {
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

    // Total contacts for this client (unfiltered). The contacts UI only reads
    // stats.total, so the old per-status breakdown was dropped.
    const { count: totalCount } = await supabase
      .from('client_contacts')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', id);

    const stats = { total: totalCount || 0 };

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
// GET /api/client/:id/contacts/export - CSV export of all contacts
// Defined BEFORE /:contactId so "export" is not matched as a contact id.
// ============================================================================
router.get('/:id/contacts/export', requirePermissionIfAuthed('contacts'), async (req, res) => {
  try {
    const { id } = req.params;

    const { data: contacts, error } = await supabase
      .from('client_contacts')
      .select('name, phone, email, address, total_calls, last_call_at, tags, source, created_at')
      .eq('client_id', id)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error exporting contacts:', error);
      return res.status(400).json({ error: error.message });
    }

    const esc = (v) => {
      if (v === null || v === undefined) return '';
      const s = Array.isArray(v) ? v.join('; ') : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const header = ['Name', 'Phone', 'Email', 'Address', 'Total Calls', 'Last Call', 'Tags', 'Source', 'Created'];
    const rows = (contacts || []).map(c => [
      esc(c.name),
      esc(c.phone),
      esc(c.email),
      esc(c.address),
      esc(c.total_calls),
      esc(c.last_call_at ? new Date(c.last_call_at).toISOString() : ''),
      esc(c.tags),
      esc(c.source),
      esc(c.created_at ? new Date(c.created_at).toISOString() : ''),
    ].join(','));

    const csv = [header.join(','), ...rows].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="contacts-${new Date().toISOString().split('T')[0]}.csv"`);
    res.send(csv);
  } catch (error) {
    console.error('Error exporting contacts:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// GET /api/client/:id/contacts/:contactId - Single contact with call history
// ============================================================================
router.get('/:id/contacts/:contactId', requirePermissionIfAuthed('contacts'), async (req, res) => {
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

    // Call history. Match BOTH by calls.contact_id (set by contact-upsert.js)
    // AND by phone, then merge + de-dupe. The phone fallback matters because
    // customer_phone is stored in several shapes (raw E.164 like +13055551234,
    // AI-formatted like "(305) 555-1234", etc.) and older calls predate the
    // contact_id link. Candidate phone strings are built from the contact's
    // normalized number.
    const byId = new Map();

    // Linked calls. If the contact_id column does not exist yet (pre-migration)
    // this returns an error, which we ignore so the phone fallback still runs.
    const linked = await supabase
      .from('calls')
      .select('*')
      .eq('client_id', id)
      .eq('contact_id', contactId);
    if (!linked.error && Array.isArray(linked.data)) {
      linked.data.forEach(c => byId.set(c.id, c));
    }

    const candidates = phoneCandidates(contact.phone);
    if (candidates.length) {
      const byPhone = await supabase
        .from('calls')
        .select('*')
        .eq('client_id', id)
        .in('customer_phone', candidates);
      if (!byPhone.error && Array.isArray(byPhone.data)) {
        byPhone.data.forEach(c => byId.set(c.id, c));
      }
    }

    const calls = Array.from(byId.values())
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    res.json({
      contact,
      calls,
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
router.put('/:id/contacts/:contactId', requirePermissionIfAuthed('contacts'), async (req, res) => {
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
router.post('/:id/contacts', requirePermissionIfAuthed('contacts'), async (req, res) => {
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
router.delete('/:id/contacts/:contactId', requirePermissionIfAuthed('contacts'), async (req, res) => {
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

// ============================================================================
// HELPER: Candidate phone strings for matching calls.customer_phone, which is
// stored in several shapes across the lifetime of a call. Built from the
// contact's (normalized) phone so history matches regardless of format.
// ============================================================================
function phoneCandidates(stored) {
  const digits = (stored || '').replace(/\D/g, '');
  const last10 = digits.slice(-10);
  const out = new Set();
  if (stored) out.add(stored);
  if (last10.length === 10) {
    const a = last10.slice(0, 3), b = last10.slice(3, 6), c = last10.slice(6);
    out.add(`+1${last10}`);
    out.add(`1${last10}`);
    out.add(last10);
    out.add(`(${a}) ${b}-${c}`);
    out.add(`+1 (${a}) ${b}-${c}`);
    out.add(`${a}-${b}-${c}`);
    out.add(`${a}.${b}.${c}`);
  }
  return Array.from(out);
}

module.exports = router;
module.exports.normalizePhone = normalizePhone;
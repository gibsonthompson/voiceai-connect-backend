// ============================================================================
// src/routes/cc-contacts.js
// Mounted at: app.use('/api/agency', require('./routes/cc-contacts'))
//
// Call-center CONTACTS: the mini-CRM across every business the center serves,
// in one place. Contacts live in the same client_contacts table the reseller
// client dashboard uses and that caller recognition populates (contact-upsert.js
// on a call, plus the VAPI webhook), so an inbound caller already shows up here
// with their call count and last call. Agents and managers can also add and edit
// contacts by hand, and start a text to one from the Texts tab.
//
//   GET  /:agencyId/cc/contacts                 -> list across scoped businesses
//   GET  /:agencyId/cc/contacts/:contactId      -> one contact + its call history
//   POST /:agencyId/cc/contacts                 -> add a contact to a business
//   PUT  /:agencyId/cc/contacts/:contactId      -> edit name/email/address/status/tags
//   DELETE /:agencyId/cc/contacts/:contactId    -> remove a contact
//
// Scoped to the viewer exactly like the rest of /cc: an owner/manager sees every
// business, an agent only the businesses assigned to them.
// ============================================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { requireAgencyAccess } = require('./auth');

// ---- scoping (same model as cc-sms / cc-messages) --------------------------
async function resolveScope(decoded, agencyId) {
  if (decoded && decoded.role === 'agency_staff') {
    const { data: m } = await supabase
      .from('team_members').select('assigned_client_ids')
      .eq('member_user_id', decoded.userId).eq('entity_type', 'agency').eq('entity_id', agencyId).maybeSingle();
    if (m && Array.isArray(m.assigned_client_ids)) return m.assigned_client_ids;
  }
  return null;
}
async function scopedClients(req, agencyId) {
  const { data: clients } = await supabase
    .from('clients').select('id, business_name').eq('agency_id', agencyId);
  let list = clients || [];
  const scope = await resolveScope(req.user, agencyId);
  if (Array.isArray(scope)) { const ok = new Set(scope); list = list.filter((c) => ok.has(c.id)); }
  return list;
}
function toBizList(clients) {
  return clients.map((c) => ({ clientId: c.id, businessName: c.business_name || 'Business' }))
    .sort((a, b) => a.businessName.localeCompare(b.businessName));
}
function sanitizeSearch(q) {
  return String(q || '').replace(/[,()*:"%]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

// ---- phone helpers (mirror client-contacts.js) -----------------------------
function normalizePhone(phone) {
  if (!phone) return phone;
  let digits = phone.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return digits;
}
function phoneCandidates(stored) {
  const digits = (stored || '').replace(/\D/g, '');
  const last10 = digits.slice(-10);
  const out = new Set();
  if (stored) out.add(stored);
  if (last10.length === 10) {
    const a = last10.slice(0, 3), b = last10.slice(3, 6), c = last10.slice(6);
    out.add(`+1${last10}`); out.add(`1${last10}`); out.add(last10);
    out.add(`(${a}) ${b}-${c}`); out.add(`+1 (${a}) ${b}-${c}`);
    out.add(`${a}-${b}-${c}`); out.add(`${a}.${b}.${c}`);
  }
  return Array.from(out);
}

// Resolve + scope-check a contact. Returns { contact, businessName } or { error, code }.
async function scopedContact(req, agencyId, contactId) {
  const { data: contact } = await supabase
    .from('client_contacts').select('*').eq('id', contactId).maybeSingle();
  if (!contact) return { error: 'Contact not found', code: 404 };
  const clients = await scopedClients(req, agencyId);
  const ok = new Set(clients.map((c) => c.id));
  if (!ok.has(contact.client_id)) return { error: 'Contact not found', code: 404 };
  const nameById = new Map(clients.map((c) => [c.id, c.business_name || 'Business']));
  return { contact, businessName: nameById.get(contact.client_id) || 'Business' };
}

function mapContact(c, nameById) {
  return {
    id: c.id,
    clientId: c.client_id,
    businessName: nameById.get(c.client_id) || 'Business',
    name: c.name || 'Unknown',
    phone: c.phone || null,
    email: c.email || null,
    address: c.address || null,
    status: c.status || null,
    tags: Array.isArray(c.tags) ? c.tags : [],
    source: c.source || null,
    totalCalls: c.total_calls || 0,
    lastCallAt: c.last_call_at || null,
    aiSummary: c.ai_summary || null,
    createdAt: c.created_at || null,
  };
}

// ---- GET /:agencyId/cc/contacts -------------------------------------------
router.get('/:agencyId/cc/contacts', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const { agencyId } = req.params;
    const clients = await scopedClients(req, agencyId);
    const nameById = new Map(clients.map((c) => [c.id, c.business_name || 'Business']));
    let clientIds = clients.map((c) => c.id);

    const business = (req.query.business || '').toString().trim();
    if (business) clientIds = clientIds.filter((id) => id === business);

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));

    if (clientIds.length === 0) {
      return res.json({ success: true, page, limit, total: 0, totalPages: 0, businesses: toBizList(clients), rows: [] });
    }

    let q = supabase.from('client_contacts').select('*', { count: 'exact' }).in('client_id', clientIds);

    const search = sanitizeSearch(req.query.q);
    if (search) q = q.or(`name.ilike.*${search}*,phone.ilike.*${search}*,email.ilike.*${search}*`);

    const sort = (req.query.sort || 'recent').toString();
    if (sort === 'calls') q = q.order('total_calls', { ascending: false });
    else if (sort === 'name') q = q.order('name', { ascending: true });
    else if (sort === 'oldest') q = q.order('created_at', { ascending: true });
    else q = q.order('last_call_at', { ascending: false, nullsFirst: false });

    q = q.range((page - 1) * limit, page * limit - 1);
    const { data, count, error } = await q;
    if (error) { console.error('cc/contacts list error:', error.message); return res.status(500).json({ success: false, error: 'Server error' }); }

    const total = count || 0;
    res.json({
      success: true, page, limit, total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      businesses: toBizList(clients),
      rows: (data || []).map((c) => mapContact(c, nameById)),
    });
  } catch (e) {
    console.error('cc/contacts list error:', e.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ---- GET /:agencyId/cc/contacts/:contactId --------------------------------
router.get('/:agencyId/cc/contacts/:contactId', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const { agencyId, contactId } = req.params;
    const chk = await scopedContact(req, agencyId, contactId);
    if (chk.error) return res.status(chk.code).json({ success: false, error: chk.error });

    // Call history: match by calls.contact_id AND phone candidates, merged.
    const byId = new Map();
    const linked = await supabase.from('calls').select('id, created_at, customer_name, customer_phone, duration_seconds, ai_summary, summary, call_status, appointment_booked').eq('client_id', chk.contact.client_id).eq('contact_id', contactId);
    if (!linked.error && Array.isArray(linked.data)) linked.data.forEach((c) => byId.set(c.id, c));
    const candidates = phoneCandidates(chk.contact.phone);
    if (candidates.length) {
      const byPhone = await supabase.from('calls').select('id, created_at, customer_name, customer_phone, duration_seconds, ai_summary, summary, call_status, appointment_booked').eq('client_id', chk.contact.client_id).in('customer_phone', candidates);
      if (!byPhone.error && Array.isArray(byPhone.data)) byPhone.data.forEach((c) => byId.set(c.id, c));
    }
    const calls = Array.from(byId.values())
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 50)
      .map((c) => ({ id: c.id, at: c.created_at, caller: c.customer_name || null, durationSeconds: c.duration_seconds || 0, reason: c.ai_summary || c.summary || null, status: c.call_status || null, booked: c.appointment_booked === true }));

    const nameById = new Map([[chk.contact.client_id, chk.businessName]]);
    res.json({ success: true, contact: mapContact(chk.contact, nameById), calls });
  } catch (e) {
    console.error('cc/contacts detail error:', e.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ---- POST /:agencyId/cc/contacts ------------------------------------------
router.post('/:agencyId/cc/contacts', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const { agencyId } = req.params;
    const clientId = (req.body?.clientId || '').toString();
    const phoneRaw = (req.body?.phone || '').toString();
    if (!clientId) return res.status(400).json({ success: false, error: 'Pick a business for this contact.' });
    if (!phoneRaw.trim()) return res.status(400).json({ success: false, error: 'A phone number is required.' });

    // Scope-check: the chosen business must be in the viewer's scope.
    const clients = await scopedClients(req, agencyId);
    const client = clients.find((c) => c.id === clientId);
    if (!client) return res.status(404).json({ success: false, error: 'Business not found' });

    const phone = normalizePhone(phoneRaw);

    // Dedupe per business.
    const { data: existing } = await supabase
      .from('client_contacts').select('id').eq('client_id', clientId).eq('phone', phone).maybeSingle();
    if (existing) return res.status(409).json({ success: false, error: 'A contact with this number already exists for that business.', contactId: existing.id });

    const row = {
      client_id: clientId,
      agency_id: agencyId,
      name: (req.body?.name || '').toString().trim() || 'Unknown',
      phone,
      email: (req.body?.email || '').toString().trim() || null,
      address: (req.body?.address || '').toString().trim() || null,
      status: 'new',
      source: 'manual',
      total_calls: 0,
      tags: [],
    };
    const { data: contact, error } = await supabase.from('client_contacts').insert([row]).select().single();
    if (error) { console.error('cc/contacts create error:', error.message); return res.status(400).json({ success: false, error: 'Could not add the contact.' }); }

    const nameById = new Map([[clientId, client.business_name || 'Business']]);
    res.status(201).json({ success: true, contact: mapContact(contact, nameById) });
  } catch (e) {
    console.error('cc/contacts create error:', e.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ---- PUT /:agencyId/cc/contacts/:contactId --------------------------------
router.put('/:agencyId/cc/contacts/:contactId', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const { agencyId, contactId } = req.params;
    const chk = await scopedContact(req, agencyId, contactId);
    if (chk.error) return res.status(chk.code).json({ success: false, error: chk.error });

    const updates = {};
    if (req.body?.name !== undefined) updates.name = String(req.body.name).trim() || 'Unknown';
    if (req.body?.email !== undefined) updates.email = String(req.body.email).trim() || null;
    if (req.body?.address !== undefined) updates.address = String(req.body.address).trim() || null;
    if (req.body?.status !== undefined) updates.status = String(req.body.status).trim() || null;
    if (req.body?.tags !== undefined && Array.isArray(req.body.tags)) updates.tags = req.body.tags.map((t) => String(t)).slice(0, 20);
    if (req.body?.phone !== undefined && String(req.body.phone).trim()) updates.phone = normalizePhone(String(req.body.phone));
    if (Object.keys(updates).length === 0) return res.status(400).json({ success: false, error: 'No fields to update' });

    const { data: contact, error } = await supabase
      .from('client_contacts').update(updates).eq('id', contactId).eq('client_id', chk.contact.client_id).select().single();
    if (error) { console.error('cc/contacts update error:', error.message); return res.status(400).json({ success: false, error: 'Could not update the contact.' }); }

    // Stamp a renamed contact onto its past nameless calls, like the reseller route.
    if (updates.name && contact) {
      try { const { backfillContactCallNames } = require('../lib/contact-upsert'); if (typeof backfillContactCallNames === 'function') await backfillContactCallNames(contactId, contact.name); } catch (e) { /* non-blocking */ }
    }

    const nameById = new Map([[chk.contact.client_id, chk.businessName]]);
    res.json({ success: true, contact: mapContact(contact, nameById) });
  } catch (e) {
    console.error('cc/contacts update error:', e.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ---- DELETE /:agencyId/cc/contacts/:contactId -----------------------------
router.delete('/:agencyId/cc/contacts/:contactId', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const { agencyId, contactId } = req.params;
    const chk = await scopedContact(req, agencyId, contactId);
    if (chk.error) return res.status(chk.code).json({ success: false, error: chk.error });
    const { error } = await supabase.from('client_contacts').delete().eq('id', contactId).eq('client_id', chk.contact.client_id);
    if (error) return res.status(400).json({ success: false, error: 'Could not delete the contact.' });
    res.json({ success: true });
  } catch (e) {
    console.error('cc/contacts delete error:', e.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

module.exports = router;

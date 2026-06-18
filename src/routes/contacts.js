// ============================================================================
// CLIENT CONTACTS ROUTES - VoiceAI Connect Multi-Tenant
// Mounted at /api/client (same prefix as routes/client.js). These serve the
// client dashboard Contacts tab: list, detail (with call history), manual
// add, and edit (name/notes/email/address).
//
// AUTH: self-scoped, same pattern as PUT /:id/forwarding in routes/client.js —
//   decodeToken, then require decoded.clientId === :id (owner + that client's
//   staff). Untokened requests are rejected. (There is no 'contacts' key in
//   requirePermissionIfAuthed yet; if one is added to routes/auth.js later,
//   these can be swapped to per-tab gating.)
//
// CALL HISTORY: the detail endpoint returns a contact's calls matched BOTH by
//   calls.contact_id (set by lib/contact-upsert.js) AND by phone number, then
//   merged and de-duplicated. The phone fallback means history still shows for
//   calls saved before contact_id linking existed, or if the contact_id column
//   was missing when the call came in. customer_phone is stored in several
//   shapes (raw E.164, AI-formatted "(XXX) XXX-XXXX", etc.), so we match on a
//   set of candidate formats built from the contact's normalized phone.
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');

const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

function decodeToken(req) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return null;
    return jwt.verify(token, JWT_SECRET);
  } catch { return null; }
}

// Self-scope guard: returns the decoded token if the caller owns this client,
// otherwise sends the appropriate error and returns null.
function requireSelf(req, res, id) {
  const decoded = decodeToken(req);
  if (!decoded) { res.status(401).json({ error: 'Authentication required' }); return null; }
  if (decoded.clientId !== id) { res.status(403).json({ error: 'Forbidden' }); return null; }
  return decoded;
}

// Matches lib/contact-upsert.js normalizePhone so manual adds dedupe against
// call-created contacts.
function normalizePhone(phone) {
  if (!phone) return phone;
  let digits = phone.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return digits;
}

// Build the set of phone strings a call's customer_phone might be stored as,
// derived from the contact's (normalized) phone.
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

const CALL_COLS = 'id, customer_name, customer_phone, ai_summary, urgency_level, duration_seconds, call_status, created_at';

// ============================================================================
// GET /:id/contacts — list (search + sort). Returns { contacts, stats:{total} }
// ============================================================================
router.get('/:id/contacts', async (req, res) => {
  try {
    const { id } = req.params;
    if (!requireSelf(req, res, id)) return;

    const sort = (req.query.sort || 'recent').toString();
    const search = (req.query.search || '').toString().replace(/[,()*]/g, ' ').trim();
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = parseInt(req.query.offset, 10) || 0;

    let q = supabase
      .from('client_contacts')
      .select('id, name, phone, email, tags, total_calls, last_call_at, ai_summary, source, created_at')
      .eq('client_id', id);

    if (search) q = q.or(`name.ilike.%${search}%,phone.ilike.%${search}%`);

    if (sort === 'calls') q = q.order('total_calls', { ascending: false });
    else if (sort === 'name') q = q.order('name', { ascending: true });
    else if (sort === 'oldest') q = q.order('created_at', { ascending: true });
    else q = q.order('last_call_at', { ascending: false, nullsFirst: false });

    q = q.range(offset, offset + limit - 1);

    const { data, error } = await q;
    if (error) { console.error('contacts list error:', error.message); return res.status(400).json({ error: error.message }); }

    const { count } = await supabase
      .from('client_contacts')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', id);

    res.json({ contacts: data || [], stats: { total: count || 0 } });
  } catch (error) {
    console.error('Error listing contacts:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// GET /:id/contacts/:contactId — contact + merged call history
// ============================================================================
router.get('/:id/contacts/:contactId', async (req, res) => {
  try {
    const { id, contactId } = req.params;
    if (!requireSelf(req, res, id)) return;

    const { data: contact, error } = await supabase
      .from('client_contacts')
      .select('*')
      .eq('id', contactId)
      .eq('client_id', id)
      .single();

    if (error || !contact) return res.status(404).json({ error: 'Contact not found' });

    const byIdMap = new Map();

    // Linked calls (calls.contact_id). If the column doesn't exist yet this
    // returns an error, which we ignore — the phone fallback still works.
    const linked = await supabase
      .from('calls')
      .select(CALL_COLS)
      .eq('client_id', id)
      .eq('contact_id', contactId);
    if (!linked.error && Array.isArray(linked.data)) {
      linked.data.forEach(c => byIdMap.set(c.id, c));
    }

    // Phone-matched calls (covers unlinked / pre-migration calls).
    const cands = phoneCandidates(contact.phone);
    if (cands.length) {
      const byPhone = await supabase
        .from('calls')
        .select(CALL_COLS)
        .eq('client_id', id)
        .in('customer_phone', cands);
      if (!byPhone.error && Array.isArray(byPhone.data)) {
        byPhone.data.forEach(c => byIdMap.set(c.id, c));
      }
    }

    const calls = Array.from(byIdMap.values())
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    res.json({ contact, calls });
  } catch (error) {
    console.error('Error fetching contact:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// POST /:id/contacts — manual add
// ============================================================================
router.post('/:id/contacts', async (req, res) => {
  try {
    const { id } = req.params;
    if (!requireSelf(req, res, id)) return;

    const { name, phone, email } = req.body || {};
    if (!phone || !phone.toString().trim()) return res.status(400).json({ error: 'Phone number is required' });

    const normalized = normalizePhone(phone.toString().trim());

    const { data: clientRow } = await supabase
      .from('clients').select('agency_id').eq('id', id).single();

    const baseRow = {
      client_id: id,
      agency_id: clientRow?.agency_id || null,
      name: (name && name.toString().trim()) || 'Unknown',
      phone: normalized,
      email: (email && email.toString().trim()) || null,
      source: 'manual',
      tags: [],
      total_calls: 0,
    };

    let { data, error } = await supabase.from('client_contacts').insert([baseRow]).select().single();

    // If the table still has a NOT NULL status column with no default, retry
    // once including status. (The status system is removed from the UI, but
    // the column may still exist.)
    if (error && (error.code === '23502' || (error.message && error.message.toLowerCase().includes('status')))) {
      const retry = await supabase.from('client_contacts').insert([{ ...baseRow, status: 'new' }]).select().single();
      data = retry.data; error = retry.error;
    }

    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'A contact with this phone number already exists' });
      console.error('contact create error:', error.message);
      return res.status(400).json({ error: error.message });
    }

    res.json({ contact: data });
  } catch (error) {
    console.error('Error creating contact:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// PUT /:id/contacts/:contactId — edit (name, notes, email, address)
// ============================================================================
router.put('/:id/contacts/:contactId', async (req, res) => {
  try {
    const { id, contactId } = req.params;
    if (!requireSelf(req, res, id)) return;

    const allowed = ['name', 'notes', 'email', 'address'];
    const updates = {};
    for (const k of allowed) {
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, k)) updates[k] = req.body[k];
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });

    const { data, error } = await supabase
      .from('client_contacts')
      .update(updates)
      .eq('id', contactId)
      .eq('client_id', id)
      .select()
      .single();

    if (error) { console.error('contact update error:', error.message); return res.status(400).json({ error: error.message }); }
    res.json({ contact: data });
  } catch (error) {
    console.error('Error updating contact:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
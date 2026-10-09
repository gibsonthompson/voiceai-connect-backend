// ============================================================================
// CONTACT UPSERT - Called from VAPI webhook after saving a call
// Deduplicates by phone + client_id, increments call count, updates summary
// ============================================================================
const { supabase } = require('./supabase');

// A call's customer_name is a placeholder when it's empty or a generic stand-in
// the system writes when the AI never caught a real name.
const CALL_NAME_PLACEHOLDERS = ['unknown', 'unknown caller', 'customer'];
function isPlaceholderName(n) {
  const t = String(n || '').trim().toLowerCase();
  return !t || CALL_NAME_PLACEHOLDERS.includes(t);
}

// Set a real caller name on a contact's past calls that have none, so the calls
// list, call detail, and CSV export all read correctly once the name is known.
// Matches by contact_id and a stored placeholder (null / "Unknown" / "Customer").
async function backfillContactCallNames(contactId, name) {
  if (!contactId || isPlaceholderName(name)) return;
  try {
    await supabase
      .from('calls')
      .update({ customer_name: name })
      .eq('contact_id', contactId)
      .or('customer_name.is.null,customer_name.eq.Unknown,customer_name.eq.Customer');
  } catch (e) {
    console.warn('⚠️ backfillContactCallNames failed (non-fatal):', e.message);
  }
}

/**
 * Upsert a contact from an inbound call.
 * - If contact exists (by phone + client_id): increment total_calls, update last_call_at, update ai_summary
 * - If contact is new: create it
 * 
 * @param {Object} params
 * @param {string} params.clientId - The client (business) ID
 * @param {string} params.agencyId - The agency ID
 * @param {string} params.callId - The call record ID just inserted
 * @param {string} params.customerPhone - Caller's phone number
 * @param {string} params.customerName - AI-extracted caller name
 * @param {string} params.customerEmail - AI-extracted email (may be null)
 * @param {string} params.customerAddress - AI-extracted address (may be null)
 * @param {string} params.aiSummary - AI summary of this call
 * @param {string} params.urgency - Urgency level of this call
 * @param {string} params.serviceRequested - What the caller needed (from transcript/AI)
 * @returns {Object} { contact, isNew }
 */
async function upsertContactFromCall({
  clientId,
  agencyId,
  callId,
  customerPhone,
  customerName,
  customerEmail,
  customerAddress,
  aiSummary,
  urgency,
  serviceRequested,
}) {
  if (!customerPhone || customerPhone === 'Unknown') {
    console.log('📇 Skipping contact upsert — no phone number');
    return { contact: null, isNew: false };
  }

  const normalizedPhone = normalizePhone(customerPhone);

  try {
    // Check if contact already exists for this client
    const { data: existing, error: findError } = await supabase
      .from('client_contacts')
      .select('*')
      .eq('client_id', clientId)
      .eq('phone', normalizedPhone)
      .single();

    if (findError && findError.code !== 'PGRST116') {
      // PGRST116 = no rows returned (not found) — that's fine
      console.error('❌ Error finding contact:', findError);
      return { contact: null, isNew: false };
    }

    const now = new Date().toISOString();

    if (existing) {
      // ========================================
      // UPDATE EXISTING CONTACT
      // ========================================
      const updates = {
        total_calls: (existing.total_calls || 0) + 1,
        last_call_at: now,
        last_call_id: callId,
      };

      // Update name if we have a better one (not "Unknown")
      if (customerName && customerName !== 'Unknown' && existing.name === 'Unknown') {
        updates.name = customerName;
      }

      // Fill in email if we didn't have one
      if (customerEmail && !existing.email) {
        updates.email = customerEmail;
      }

      // Fill in address if we didn't have one
      if (customerAddress && !existing.address) {
        updates.address = customerAddress;
      }

      // Append to AI summary (rolling summary of all interactions)
      if (aiSummary) {
        const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const newEntry = `[${date}] ${aiSummary}`;
        updates.ai_summary = existing.ai_summary
          ? `${existing.ai_summary}\n\n${newEntry}`
          : newEntry;
      }

      // Auto-tag based on urgency and service
      const currentTags = existing.tags || [];
      const newTags = [...currentTags];

      if (urgency === 'emergency' && !newTags.includes('emergency')) {
        newTags.push('emergency');
      }
      if (urgency === 'high' && !newTags.includes('high_priority')) {
        newTags.push('high_priority');
      }
      if ((existing.total_calls || 0) + 1 >= 3 && !newTags.includes('repeat_caller')) {
        newTags.push('repeat_caller');
      }

      if (newTags.length !== currentTags.length) {
        updates.tags = newTags;
      }

      // Move from "new" to "active" on second call
      if (existing.status === 'new' && (existing.total_calls || 0) + 1 >= 2) {
        updates.status = 'active';
      }

      const { data: updated, error: updateError } = await supabase
        .from('client_contacts')
        .update(updates)
        .eq('id', existing.id)
        .select()
        .single();

      if (updateError) {
        console.error('❌ Error updating contact:', updateError);
        return { contact: existing, isNew: false };
      }

      // Link the call to this contact, and stamp the contact's real name onto
      // the call when this call came in without one, so the call record itself
      // (and any export of it) shows who it was, not "Unknown".
      const resolvedName = (updates.name && !isPlaceholderName(updates.name)) ? updates.name
        : (!isPlaceholderName(existing.name)) ? existing.name
        : (!isPlaceholderName(customerName)) ? customerName : null;
      const callPatch = { contact_id: existing.id };
      if (resolvedName && isPlaceholderName(customerName)) callPatch.customer_name = resolvedName;
      await supabase
        .from('calls')
        .update(callPatch)
        .eq('id', callId);

      // If this call is what taught us the caller's name (the contact had none
      // before), backfill the contact's earlier nameless calls too.
      if (updates.name && !isPlaceholderName(updates.name)) {
        await backfillContactCallNames(existing.id, updates.name);
      }

      console.log(`📇 Contact updated: ${updated.name} (${normalizedPhone}) — ${updated.total_calls} calls`);
      return { contact: updated, isNew: false };

    } else {
      // ========================================
      // CREATE NEW CONTACT
      // ========================================
      const tags = [];
      if (urgency === 'emergency') tags.push('emergency');
      if (urgency === 'high') tags.push('high_priority');

      const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const summaryEntry = aiSummary ? `[${date}] ${aiSummary}` : null;

      const { data: created, error: createError } = await supabase
        .from('client_contacts')
        .insert([{
          client_id: clientId,
          agency_id: agencyId,
          name: customerName || 'Unknown',
          phone: normalizedPhone,
          email: customerEmail || null,
          address: customerAddress || null,
          source: 'inbound_call',
          status: 'new',
          tags,
          total_calls: 1,
          last_call_at: now,
          last_call_id: callId,
          ai_summary: summaryEntry,
        }])
        .select()
        .single();

      if (createError) {
        // Handle race condition: if another webhook already created it
        if (createError.code === '23505') {
          console.log('📇 Contact created by concurrent request — retrying as update');
          return upsertContactFromCall({
            clientId, agencyId, callId, customerPhone,
            customerName, customerEmail, customerAddress,
            aiSummary, urgency, serviceRequested,
          });
        }
        console.error('❌ Error creating contact:', createError);
        return { contact: null, isNew: false };
      }

      // Link the call to this contact; stamp the name if we have a real one and
      // this call came in without.
      const callPatch = { contact_id: created.id };
      if (!isPlaceholderName(created.name) && isPlaceholderName(customerName)) callPatch.customer_name = created.name;
      await supabase
        .from('calls')
        .update(callPatch)
        .eq('id', callId);

      console.log(`📇 New contact created: ${created.name} (${normalizedPhone})`);
      return { contact: created, isNew: true };
    }
  } catch (error) {
    console.error('❌ Contact upsert error:', error);
    return { contact: null, isNew: false };
  }
}

function normalizePhone(phone) {
  if (!phone) return phone;
  let digits = phone.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return digits;
}

module.exports = { upsertContactFromCall, backfillContactCallNames, isPlaceholderName };
// ============================================================================
// TOOL CONFIG ROUTES - Per-client feature toggles for dynamic assistant
// Mounted at: app.use('/api/client', toolConfigRoutes)
// UPDATED: 2026-06-16 — Per-tab Page Access enforcement. requirePermissionIfAuthed('ai_agent')
//          on both routes (these toggles configure the AI agent's call handling).
// UPDATED: 2026-10-17 — Appointment booking SMS: owner alert (free) + customer
//          confirmation (gated upgrade). GET returns apptCustomerSmsUnlocked so
//          the UI can lock the customer toggle; PUT enforces the entitlement
//          server-side so it can't be bypassed.
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { requirePermissionIfAuthed } = require('./auth');
const { looksLikeStreetAddress } = require('../lib/address-utils');
const { canOfferApptCustomerSms } = require('../lib/calendar-booking');

// Default tool config — used when client has no tool_config or is missing keys
const DEFAULT_TOOL_CONFIG = {
  callerRecognition: true,
  spamDetection: true,
  transferCall: true,
  // On by default (see assistant-config-builder DEFAULT_TOOL_CONFIG). Only has
  // an effect once business hours are set; 24/7 businesses turn it off.
  businessHoursRouting: true,
  speechTimeout: true,
  speechTimeoutSeconds: 12,
  smsToCaller: false,
  smsInstructions: '',
  smsSnippets: [],
  smsPresets: {},
  // Appointment booking SMS. The owner "new appointment booked" alert is free.
  // The customer booking-confirmation is a paid upgrade (Scale plan for reseller
  // agencies; appointment_sms_addon for call centers / platform override),
  // enforced here and in calendar-booking.js.
  apptOwnerSmsEnabled: false,
  apptCustomerSmsEnabled: false,
  apptCustomerSmsTemplate: '',
};

// Pull the business address + website out of what the AI already knows, so the
// "Texting the caller" address/website presets can pre-fill from the knowledge
// base instead of the client re-typing them. Website is a stored field; the
// address is read from the assembled KB document the website scrape wrote
// (its "QUICK FACTS" block, or the "## Addresses" section).
function deriveKbContact(client) {
  const website = String(client && client.business_website || '').trim();
  let address = '';
  const kb = String(client && client.knowledge_base_content || '');
  if (kb) {
    // "- Address (text this ...): <addr>" from the QUICK FACTS block.
    let m = kb.match(/^\s*-+\s*Address\b[^:\n]*:\s*(.+)$/im);
    if (m && m[1]) address = m[1].trim();
    if (!address) {
      // First bullet under a "## Addresses" heading.
      const sec = kb.match(/##\s*Addresses\s*\n([\s\S]*?)(?:\n#|$)/i);
      if (sec && sec[1]) { const b = sec[1].match(/^\s*-+\s*(.+)$/m); if (b && b[1]) address = b[1].trim(); }
    }
  }
  // Guard against older/garbage KB values (a vague area, not a street address).
  if (address && !looksLikeStreetAddress(address)) address = '';
  return { address, website };
}

// Is the client's agency entitled to offer the CUSTOMER booking-confirmation
// SMS? Reads the agency behind the client and defers to the shared helper.
async function isApptCustomerSmsUnlocked(agencyId) {
  if (!agencyId) return false;
  try {
    const { data: ag } = await supabase
      .from('agencies')
      .select('plan_type, subscription_status, is_call_center, appointment_sms_addon')
      .eq('id', agencyId)
      .single();
    return canOfferApptCustomerSms(ag);
  } catch (_) {
    return false;
  }
}

// ============================================================================
// GET /api/client/:id/tool-config
// ============================================================================
router.get('/:id/tool-config', requirePermissionIfAuthed('ai_agent'), async (req, res) => {
  try {
    const { id } = req.params;

    const { data: client, error } = await supabase
      .from('clients')
      .select('tool_config, business_hours, business_website, knowledge_base_content, agency_id')
      .eq('id', id)
      .single();

    if (error || !client) {
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    // Merge stored config with defaults (fill any missing keys)
    const config = { ...DEFAULT_TOOL_CONFIG, ...(client.tool_config || {}) };

    const apptCustomerSmsUnlocked = await isApptCustomerSmsUnlocked(client.agency_id);

    res.json({
      success: true,
      tool_config: config,
      business_hours: client.business_hours || null,
      // Whether the customer booking-confirmation SMS upgrade is available, so
      // the UI can lock that toggle behind it (backend still enforces on PUT).
      apptCustomerSmsUnlocked,
      // Address + website pulled from the knowledge base, so the texting presets
      // can pre-fill when the client hasn't typed them yet.
      kb_contact: deriveKbContact(client),
    });
  } catch (error) {
    console.error('Error fetching tool config:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================================
// PUT /api/client/:id/tool-config
// Accepts partial updates — merges with existing config
// ============================================================================
router.put('/:id/tool-config', requirePermissionIfAuthed('ai_agent'), async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({ success: false, error: 'Invalid request body' });
    }

    // Whitelist allowed keys
    const allowed = [
      'callerRecognition', 'spamDetection', 'transferCall',
      'businessHoursRouting',
      'speechTimeout', 'speechTimeoutSeconds',
      'smsToCaller',
      'smsInstructions',
      'smsSnippets',
      'smsPresets',
      'apptOwnerSmsEnabled',
      'apptCustomerSmsEnabled',
      'apptCustomerSmsTemplate',
    ];

    // Get current config
    const { data: client, error: fetchError } = await supabase
      .from('clients')
      .select('tool_config, agency_id')
      .eq('id', id)
      .single();

    if (fetchError || !client) {
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    const currentConfig = { ...DEFAULT_TOOL_CONFIG, ...(client.tool_config || {}) };

    // Apply only whitelisted updates
    const newConfig = { ...currentConfig };
    for (const key of allowed) {
      if (updates[key] !== undefined) {
        newConfig[key] = updates[key];
      }
    }

    // Validate speechTimeoutSeconds range
    if (typeof newConfig.speechTimeoutSeconds === 'number') {
      newConfig.speechTimeoutSeconds = Math.max(5, Math.min(30, newConfig.speechTimeoutSeconds));
    }

    // Keep the confirmation template bounded.
    if (typeof newConfig.apptCustomerSmsTemplate === 'string') {
      newConfig.apptCustomerSmsTemplate = newConfig.apptCustomerSmsTemplate.slice(0, 320);
    }

    // Enforce the customer booking-confirmation entitlement server-side, so the
    // toggle can't be flipped on by a client whose agency isn't entitled even if
    // the UI is bypassed. The owner alert stays free.
    if (newConfig.apptCustomerSmsEnabled === true) {
      const unlocked = await isApptCustomerSmsUnlocked(client.agency_id);
      if (!unlocked) newConfig.apptCustomerSmsEnabled = false;
    }

    const { error: updateError } = await supabase
      .from('clients')
      .update({ tool_config: newConfig })
      .eq('id', id);

    if (updateError) {
      return res.status(400).json({ success: false, error: updateError.message });
    }

    console.log(`✅ Tool config updated for client ${id}:`, Object.keys(updates).filter(k => allowed.includes(k)).join(', '));
    res.json({ success: true, tool_config: newConfig });
  } catch (error) {
    console.error('Error updating tool config:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

module.exports = router;
module.exports.DEFAULT_TOOL_CONFIG = DEFAULT_TOOL_CONFIG;

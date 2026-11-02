// ============================================================================
// CALL CENTER - ADD BUSINESS
// ----------------------------------------------------------------------------
// A call center onboarding a business it will answer for. Separate from the
// agency add-client path: the business is owned by the CALL CENTER
// (clients.call_center_id), billed offline/manual (no Stripe per-client), and
// provisioned on the full call-control engine (voice_routing='telnyx_cc') so
// the live-agent / whisper features apply, which is the point of a call center.
//
// Reuses the agency-independent building blocks from lib/vapi:
//   createIndustryAssistant (agencyId=null -> standard industry templates)
//   provisionLocalPhone (voiceRouting 'telnyx_cc' -> Telnyx number routed to the
//     shared Call Control app; no VAPI import; inbound resolves the client by
//     its number). SMS assignment happens inside that path.
//
// The business keeps its own public number and forwards it to this provisioned
// AI number (the call center's standard model). Bring-your-own-carrier/SIP for a
// business is a later, additive option on top of this.
//
// Mounted: POST /api/cc/:callCenterId/clients/add  (requireCallCenterAccess)
// CREATED: 2026-11-02
// ============================================================================
const { supabase } = require('../lib/supabase');
const { createIndustryAssistant, provisionLocalPhone } = require('../lib/vapi');
const { timezoneFromPhone } = require('../lib/area-code-timezone');

const VAPI_API_KEY = process.env.VAPI_API_KEY;

function formatPhoneE164ish(raw) {
  if (!raw) return null;
  const p = String(raw).trim();
  if (p.startsWith('+')) return p;
  const d = p.replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return d ? `+${d}` : null;
}

// Pull the KB query tool id off a freshly created assistant (same purpose as the
// agency path's extractQueryToolId) so the dynamic config builder can reference
// it. Best-effort: null is fine.
async function extractQueryToolId(assistantId) {
  if (!assistantId || !VAPI_API_KEY) return null;
  try {
    const r = await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
      headers: { Authorization: `Bearer ${VAPI_API_KEY}` },
    });
    if (!r.ok) return null;
    const a = await r.json();
    return a.model?.toolIds?.[0] || null;
  } catch { return null; }
}

// Best-effort teardown if provisioning fails after the assistant was created, so
// a failed add does not leak a billable VAPI assistant.
async function deleteAssistantBestEffort(assistantId) {
  if (!assistantId || !VAPI_API_KEY) return;
  try {
    await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${VAPI_API_KEY}` },
    });
  } catch (e) { console.warn('⚠️ CC add-business: assistant cleanup failed:', e.message); }
}

function manualUsageResetAt() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}

async function handleCallCenterAddClient(req, res) {
  let createdAssistantId = null;
  try {
    const { callCenterId } = req.params;
    const {
      firstName, lastName = '', email, phone,
      businessName, industry, businessCity, businessState, businessCountry, websiteUrl,
    } = req.body || {};

    const errors = [];
    if (!businessName || businessName.trim().length < 2) errors.push('Business name is required');
    if (!businessCity || businessCity.trim().length < 2) errors.push('City is required');
    if (!businessState || businessState.trim().length < 1) errors.push('State / region is required');
    if (!industry) errors.push('Industry is required');
    const ownerPhone = formatPhoneE164ish(phone);
    if (!ownerPhone) errors.push('A valid business phone number is required');
    if (errors.length) return res.status(400).json({ error: 'Validation failed', errors });

    // The call center (ownership already proven by requireCallCenterAccess).
    const { data: callCenter, error: ccErr } = await supabase
      .from('call_centers').select('id, country').eq('id', callCenterId).single();
    if (ccErr || !callCenter) return res.status(404).json({ error: 'Call center not found' });

    const provisionCountry = (businessCountry || callCenter.country || 'US').toUpperCase();
    const ownerName = `${(firstName || '').trim()} ${(lastName || '').trim()}`.trim() || businessName.trim();

    // 1) AI assistant (agencyId=null -> standard industry templates/KB).
    const assistant = await createIndustryAssistant(
      businessName.trim(), industry, null, ownerPhone, null, null, null,
    );
    if (!assistant || !assistant.id) {
      return res.status(502).json({ error: 'Could not create the AI assistant. Please try again.' });
    }
    createdAssistantId = assistant.id;
    const queryToolId = await extractQueryToolId(assistant.id);

    // 2) Provision the AI number on full call control (telnyx_cc). On failure,
    //    tear the assistant back down so nothing is left billing.
    let phoneData;
    try {
      phoneData = await provisionLocalPhone(
        businessCity.trim(), businessState.trim(), assistant.id, businessName.trim(), ownerPhone,
        { voiceRouting: 'telnyx_cc', country: provisionCountry },
      );
    } catch (phoneErr) {
      await deleteAssistantBestEffort(createdAssistantId);
      console.error('❌ CC add-business provisioning failed:', phoneErr.message);
      return res.status(503).json({ error: 'Provisioning failed', message: phoneErr.message });
    }

    // 3) Create the business row, owned by the call center, live immediately
    //    (manual billing), unlimited platform call cap (-1), telnyx_cc routing.
    const aiNumber = phoneData.number;
    const payload = {
      call_center_id: callCenterId,
      business_name: businessName.trim(),
      business_city: businessCity.trim(),
      business_state: businessState.trim(),
      country: provisionCountry,
      phone_number: aiNumber,
      phone_area_code: aiNumber && aiNumber.length >= 5 ? aiNumber.substring(2, 5) : null,
      owner_name: ownerName,
      owner_phone: ownerPhone,
      timezone: timezoneFromPhone(ownerPhone) || timezoneFromPhone(aiNumber) || null,
      email: email ? email.toLowerCase() : null,
      industry,
      vapi_assistant_id: assistant.id,
      vapi_phone_number: aiNumber,
      vapi_phone_id: phoneData.vapiPhoneId || null,  // null for telnyx_cc (routed to Call Control)
      vapi_query_tool_id: queryToolId,
      status: 'active',
      subscription_status: 'manual',
      billing_mode: 'manual',
      usage_resets_at: manualUsageResetAt(),
      trial_ends_at: null,                 // permanent, no access window
      plan_type: 'standard',
      monthly_call_limit: -1,              // unlimited platform cap; call center bills offline
      calls_this_month: 0,
      business_website: websiteUrl ? String(websiteUrl).trim() : null,
      provisioning_method: phoneData.provisioningMethod || 'telnyx_cc',
      voice_routing: phoneData.voice_routing || 'telnyx_cc',
    };

    const { data: client, error: insErr } = await supabase
      .from('clients').insert(payload).select('id, business_name, phone_number, vapi_phone_number').single();
    if (insErr || !client) {
      await deleteAssistantBestEffort(createdAssistantId);
      console.error('❌ CC add-business client insert failed:', insErr && insErr.message);
      return res.status(500).json({ error: 'Could not save the business. Please try again.' });
    }

    console.log(`✅ CC ${callCenterId} added business ${client.id} (${client.business_name}) on ${aiNumber}`);
    return res.status(200).json({
      success: true,
      client: { id: client.id, business_name: client.business_name, phone_number: client.phone_number },
    });
  } catch (error) {
    await deleteAssistantBestEffort(createdAssistantId);
    console.error('❌ CC add-business error:', error);
    return res.status(500).json({ error: 'Failed to add business' });
  }
}

module.exports = { handleCallCenterAddClient };

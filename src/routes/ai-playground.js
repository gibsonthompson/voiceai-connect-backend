// ============================================================================
// AI PLAYGROUND - Test & Configure AI Receptionists
// Endpoints: client listing, AI config details (full prompt from VAPI), SMS swap
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');

// Local phone helpers (avoid dependency on notifications module)
function formatPhoneE164(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return phone;
}

function formatPhoneDisplay(phone) {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (ten.length === 10) return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
  return phone;
}

// ============================================================================
// GET /:agencyId/ai-playground/clients
// ============================================================================
router.get('/:agencyId/ai-playground/clients', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const { data: clients, error } = await supabase
      .from('clients')
      .select('id, business_name, industry, owner_name, owner_phone, email, vapi_assistant_id, vapi_phone_number, vapi_phone_id, knowledge_base_id, subscription_status, status, plan_type, business_city, business_state, call_mode')
      .eq('agency_id', agencyId)
      .neq('status', 'deleted')
      .order('created_at', { ascending: false });

    if (error) return res.status(400).json({ error: error.message });
    res.json({ clients: clients || [] });
  } catch (error) {
    console.error('Playground clients error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// GET /:agencyId/ai-playground/clients/:clientId/ai-details
// ============================================================================
router.get('/:agencyId/ai-playground/clients/:clientId/ai-details', async (req, res) => {
  try {
    const { agencyId, clientId } = req.params;
    const { data: client, error } = await supabase
      .from('clients')
      .select('*')
      .eq('id', clientId)
      .eq('agency_id', agencyId)
      .single();

    if (error || !client) return res.status(404).json({ error: 'Client not found' });

    let assistantDetails = null;
    if (client.vapi_assistant_id && process.env.VAPI_API_KEY) {
      try {
        const vapiResponse = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
          headers: { 'Authorization': `Bearer ${process.env.VAPI_API_KEY}` },
        });
        if (vapiResponse.ok) {
          const raw = await vapiResponse.json();
          let systemPrompt = '';
          if (raw.model?.messages && Array.isArray(raw.model.messages)) {
            const systemMsg = raw.model.messages.find(m => m.role === 'system');
            if (systemMsg) systemPrompt = systemMsg.content || '';
          }
          assistantDetails = {
            id: raw.id,
            name: raw.name || null,
            model: raw.model?.model || 'gpt-4o-mini',
            voice: raw.voice?.voiceId || '',
            voiceProvider: raw.voice?.provider || '11labs',
            firstMessage: raw.firstMessage || '',
            systemPrompt,
            systemPromptLength: systemPrompt.length,
            temperature: raw.model?.temperature ?? 0.7,
            tools: (raw.model?.tools || []).map(t => {
              if (t.type === 'transferCall') return 'transferCall';
              return t.function?.name || t.type || 'unknown';
            }),
            toolIds: raw.model?.toolIds || [],
            serverUrl: raw.serverUrl || null,
          };
        }
      } catch (vapiErr) {
        console.warn('Failed to fetch VAPI assistant:', vapiErr.message);
      }
    }

    res.json({
      client: {
        id: client.id, business_name: client.business_name, industry: client.industry,
        owner_name: client.owner_name, owner_phone: client.owner_phone, email: client.email,
        business_city: client.business_city, business_state: client.business_state,
        vapi_assistant_id: client.vapi_assistant_id, vapi_phone_number: client.vapi_phone_number,
        vapi_phone_id: client.vapi_phone_id, knowledge_base_id: client.knowledge_base_id,
        subscription_status: client.subscription_status, status: client.status,
        plan_type: client.plan_type, call_mode: client.call_mode || 'primary',
      },
      assistant: assistantDetails,
    });
  } catch (error) {
    console.error('AI details error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// PUT /:agencyId/ai-playground/clients/:clientId/notification-phone
// ============================================================================
router.put('/:agencyId/ai-playground/clients/:clientId/notification-phone', async (req, res) => {
  try {
    const { agencyId, clientId } = req.params;
    const { phone } = req.body;
    if (!phone || typeof phone !== 'string') return res.status(400).json({ error: 'phone is required' });

    const { data: client, error: fetchError } = await supabase
      .from('clients')
      .select('id, owner_phone, business_name, country')
      .eq('id', clientId)
      .eq('agency_id', agencyId)
      .single();

    if (fetchError || !client) return res.status(404).json({ error: 'Client not found' });

    const previousPhone = client.owner_phone;
    const formattedPhone = formatPhoneE164(phone) || phone;

    const { error: updateError } = await supabase
      .from('clients')
      .update({ owner_phone: formattedPhone })
      .eq('id', clientId);

    if (updateError) return res.status(500).json({ error: 'Failed to update phone number' });

    console.log(`📱 Notification phone swapped for ${client.business_name}: ${formatPhoneDisplay(previousPhone)} → ${formatPhoneDisplay(formattedPhone)}`);

    res.json({
      success: true,
      previous_phone: previousPhone,
      new_phone: formattedPhone,
      previous_phone_display: formatPhoneDisplay(previousPhone),
      new_phone_display: formatPhoneDisplay(formattedPhone),
    });
  } catch (error) {
    console.error('Notification phone swap error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
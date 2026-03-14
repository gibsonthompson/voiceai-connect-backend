// ============================================================================
// CLIENT PROMPT ROUTES - Agency-level editing of individual client AI config
// PUT handles: system_prompt, first_message, voice_id, model, temperature,
//              call_mode (Supabase-only), transfer_phone (VAPI transferCall tool)
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { INDUSTRY_MAPPING, INDUSTRY_CONFIGS } = require('../lib/vapi');

const VAPI_API_KEY = process.env.VAPI_API_KEY;

// ============================================================================
// GET /api/agency/:agencyId/clients/:clientId/prompt
// ============================================================================
router.get('/:agencyId/clients/:clientId/prompt', async (req, res) => {
  try {
    const { agencyId, clientId } = req.params;

    const { data: client, error } = await supabase
      .from('clients')
      .select('id, vapi_assistant_id, system_prompt, industry, business_name')
      .eq('id', clientId)
      .eq('agency_id', agencyId)
      .single();

    if (error || !client) {
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    if (!client.vapi_assistant_id) {
      return res.status(400).json({ success: false, error: 'Client has no AI assistant configured' });
    }

    const industryKey = INDUSTRY_MAPPING[client.industry] || 'professional_services';

    if (client.system_prompt) {
      return res.json({ success: true, system_prompt: client.system_prompt, industry: industryKey, business_name: client.business_name, source: 'cache' });
    }

    const vapiResponse = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
      headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
    });

    if (!vapiResponse.ok) {
      return res.status(500).json({ success: false, error: 'Failed to fetch assistant from VAPI' });
    }

    const assistant = await vapiResponse.json();
    const systemPrompt = assistant.model?.messages?.[0]?.content || '';

    await supabase.from('clients').update({ system_prompt: systemPrompt }).eq('id', clientId);

    return res.json({ success: true, system_prompt: systemPrompt, industry: industryKey, business_name: client.business_name, source: 'vapi' });
  } catch (error) {
    console.error('Error fetching client prompt:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================================
// PUT /api/agency/:agencyId/clients/:clientId/prompt
// All fields optional. Only provided fields are updated. Backwards compatible.
// ============================================================================
router.put('/:agencyId/clients/:clientId/prompt', async (req, res) => {
  try {
    const { agencyId, clientId } = req.params;
    const { system_prompt, first_message, voice_id, model, temperature, call_mode, transfer_phone } = req.body;

    // Detect which fields were provided
    const hasPrompt = typeof system_prompt === 'string' && system_prompt.trim().length >= 10;
    const hasGreeting = typeof first_message === 'string';
    const hasVoice = typeof voice_id === 'string' && voice_id.trim().length > 0;
    const hasModel = typeof model === 'string' && model.trim().length > 0;
    const hasTemp = typeof temperature === 'number' && temperature >= 0 && temperature <= 1;
    const hasCallMode = typeof call_mode === 'string' && (call_mode === 'primary' || call_mode === 'secondary');
    const hasTransferPhone = typeof transfer_phone === 'string' && transfer_phone.trim().length > 0;

    // Validate prompt length
    if (typeof system_prompt === 'string' && system_prompt.trim().length > 0 && system_prompt.trim().length < 10) {
      return res.status(400).json({ success: false, error: 'system_prompt must be at least 10 characters' });
    }

    if (!hasPrompt && !hasGreeting && !hasVoice && !hasModel && !hasTemp && !hasCallMode && !hasTransferPhone) {
      return res.status(400).json({ success: false, error: 'At least one field required' });
    }

    // Fetch client
    const { data: client, error } = await supabase
      .from('clients')
      .select('id, vapi_assistant_id, business_name')
      .eq('id', clientId)
      .eq('agency_id', agencyId)
      .single();

    if (error || !client) {
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    // ====================================================================
    // VAPI PATCH
    // ====================================================================
    const needsVapiPatch = hasPrompt || hasGreeting || hasVoice || hasModel || hasTemp || hasTransferPhone;

    if (needsVapiPatch) {
      if (!client.vapi_assistant_id) {
        return res.status(400).json({ success: false, error: 'Client has no AI assistant configured' });
      }

      // GET current config
      const getResponse = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
        headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
      });

      if (!getResponse.ok) {
        return res.status(500).json({ success: false, error: 'Failed to fetch current assistant config from VAPI' });
      }

      const currentAssistant = await getResponse.json();
      const currentModel = currentAssistant.model || {};
      const currentVoice = currentAssistant.voice || {};

      const patchPayload = {};

      // --- model object (prompt, model name, temperature, transfer phone) ---
      if (hasPrompt || hasModel || hasTemp || hasTransferPhone) {
        patchPayload.model = { ...currentModel };

        if (hasPrompt) {
          patchPayload.model.messages = [{ role: 'system', content: system_prompt.trim() }];
        }
        if (hasModel) {
          patchPayload.model.model = model.trim();
        }
        if (hasTemp) {
          patchPayload.model.temperature = temperature;
        }

        // --- Transfer phone: update transferCall tool destination ---
        if (hasTransferPhone) {
          const tools = patchPayload.model.tools || currentModel.tools || [];
          const formattedPhone = formatPhoneForTransfer(transfer_phone.trim());

          if (formattedPhone) {
            const transferIdx = tools.findIndex(t => t.type === 'transferCall');
            if (transferIdx !== -1) {
              // Update existing transferCall tool destination
              const existingTool = { ...tools[transferIdx] };
              if (existingTool.destinations && existingTool.destinations.length > 0) {
                existingTool.destinations = existingTool.destinations.map(d => ({
                  ...d,
                  number: formattedPhone,
                }));
              } else {
                existingTool.destinations = [{
                  type: 'number',
                  number: formattedPhone,
                  description: 'Transfer to business owner',
                  message: 'One moment, let me connect you.',
                }];
              }
              tools[transferIdx] = existingTool;
            } else {
              // No transferCall tool exists — add one
              tools.push({
                type: 'transferCall',
                destinations: [{
                  type: 'number',
                  number: formattedPhone,
                  description: 'Transfer to business owner',
                  message: 'One moment, let me connect you.',
                }],
              });
            }
            patchPayload.model.tools = tools;
          }
        }
      }

      // --- firstMessage ---
      if (hasGreeting) {
        patchPayload.firstMessage = first_message.trim();
      }

      // --- voice ---
      if (hasVoice) {
        patchPayload.voice = { ...currentVoice, voiceId: voice_id.trim() };
      }

      // PATCH VAPI
      const patchResponse = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${VAPI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(patchPayload),
      });

      if (!patchResponse.ok) {
        const errorText = await patchResponse.text();
        console.error('VAPI update failed:', patchResponse.status, errorText);
        return res.status(500).json({ success: false, error: 'Failed to update assistant in VAPI', details: errorText });
      }
    }

    // ====================================================================
    // SUPABASE
    // ====================================================================
    const supabaseUpdate = {};
    if (hasPrompt) supabaseUpdate.system_prompt = system_prompt.trim();
    if (hasCallMode) supabaseUpdate.call_mode = call_mode;

    if (Object.keys(supabaseUpdate).length > 0) {
      await supabase.from('clients').update(supabaseUpdate).eq('id', clientId);
    }

    // Build response
    const updated = {};
    if (hasPrompt) updated.system_prompt = system_prompt.trim();
    if (hasGreeting) updated.first_message = first_message.trim();
    if (hasVoice) updated.voice_id = voice_id.trim();
    if (hasModel) updated.model = model.trim();
    if (hasTemp) updated.temperature = temperature;
    if (hasCallMode) updated.call_mode = call_mode;
    if (hasTransferPhone) updated.transfer_phone = transfer_phone.trim();

    console.log(`✅ AI config updated for ${client.business_name} (${clientId}): ${Object.keys(updated).join(', ')}`);
    res.json({ success: true, updated });
  } catch (error) {
    console.error('Error updating client AI config:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================================
// POST /api/agency/:agencyId/clients/:clientId/prompt/reset
// ============================================================================
router.post('/:agencyId/clients/:clientId/prompt/reset', async (req, res) => {
  try {
    const { agencyId, clientId } = req.params;

    const { data: client, error } = await supabase
      .from('clients')
      .select('id, vapi_assistant_id, industry, business_name')
      .eq('id', clientId)
      .eq('agency_id', agencyId)
      .single();

    if (error || !client) return res.status(404).json({ success: false, error: 'Client not found' });
    if (!client.vapi_assistant_id) return res.status(400).json({ success: false, error: 'Client has no AI assistant configured' });

    const industryKey = INDUSTRY_MAPPING[client.industry] || 'professional_services';
    const config = INDUSTRY_CONFIGS[industryKey] || INDUSTRY_CONFIGS['professional_services'];
    const defaultPrompt = config.systemPrompt(client.business_name);

    const getResponse = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
      headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
    });

    if (!getResponse.ok) return res.status(500).json({ success: false, error: 'Failed to fetch current assistant config' });

    const currentAssistant = await getResponse.json();
    const updatedModel = { ...currentAssistant.model, messages: [{ role: 'system', content: defaultPrompt }] };

    const patchResponse = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${VAPI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: updatedModel }),
    });

    if (!patchResponse.ok) {
      const errorText = await patchResponse.text();
      return res.status(500).json({ success: false, error: 'Failed to reset prompt in VAPI' });
    }

    await supabase.from('clients').update({ system_prompt: defaultPrompt }).eq('id', clientId);

    console.log(`✅ Prompt reset to ${industryKey} default for ${client.business_name}`);
    res.json({ success: true, system_prompt: defaultPrompt, industry: industryKey });
  } catch (error) {
    console.error('Error resetting client prompt:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================================
// HELPER: Format phone for VAPI transferCall (E.164)
// ============================================================================
function formatPhoneForTransfer(phone) {
  if (!phone) return null;
  // Already E.164
  if (phone.startsWith('+') && phone.length >= 11) return phone;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

module.exports = router;
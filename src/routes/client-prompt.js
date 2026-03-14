// ============================================================================
// CLIENT PROMPT ROUTES - Agency-level editing of individual client AI config
// Allows agency owners to view/edit/reset a client's VAPI assistant:
//   - System prompt (model.messages)
//   - First message / greeting (firstMessage)
//   - Voice (voice.voiceId)
//   - Model (model.model)
//   - Temperature (model.temperature)
//   - Call mode: primary / secondary (Supabase only — controls routing logic)
// Pattern: VAPI PATCH + Supabase cache
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { INDUSTRY_MAPPING, INDUSTRY_CONFIGS } = require('../lib/vapi');

const VAPI_API_KEY = process.env.VAPI_API_KEY;

// ============================================================================
// GET /api/agency/:agencyId/clients/:clientId/prompt
// Fetches current system prompt — checks DB cache first, falls back to VAPI
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

    // Return cached prompt if available
    if (client.system_prompt) {
      return res.json({
        success: true,
        system_prompt: client.system_prompt,
        industry: industryKey,
        business_name: client.business_name,
        source: 'cache',
      });
    }

    // Fetch from VAPI
    const vapiResponse = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
      headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
    });

    if (!vapiResponse.ok) {
      console.error('VAPI fetch failed:', vapiResponse.status);
      return res.status(500).json({ success: false, error: 'Failed to fetch assistant from VAPI' });
    }

    const assistant = await vapiResponse.json();
    const systemPrompt = assistant.model?.messages?.[0]?.content || '';

    // Cache in DB
    await supabase
      .from('clients')
      .update({ system_prompt: systemPrompt })
      .eq('id', clientId);

    return res.json({
      success: true,
      system_prompt: systemPrompt,
      industry: industryKey,
      business_name: client.business_name,
      source: 'vapi',
    });
  } catch (error) {
    console.error('Error fetching client prompt:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================================
// PUT /api/agency/:agencyId/clients/:clientId/prompt
// Updates AI assistant config in VAPI + caches relevant fields in Supabase
//
// Accepts (all optional — only provided fields are updated):
//   - system_prompt: string (min 10 chars) → patches model.messages
//   - first_message: string              → patches firstMessage
//   - voice_id: string                   → patches voice.voiceId
//   - model: string                      → patches model.model
//   - temperature: number (0-1)          → patches model.temperature
//   - call_mode: 'primary' | 'secondary' → Supabase only (not a VAPI field)
//
// Backwards compatible: if only system_prompt is sent, behaves identically
// to the original endpoint.
// ============================================================================
router.put('/:agencyId/clients/:clientId/prompt', async (req, res) => {
  try {
    const { agencyId, clientId } = req.params;
    const { system_prompt, first_message, voice_id, model, temperature, call_mode } = req.body;

    // Detect which fields were provided
    const hasPrompt = typeof system_prompt === 'string' && system_prompt.trim().length >= 10;
    const hasGreeting = typeof first_message === 'string';
    const hasVoice = typeof voice_id === 'string' && voice_id.trim().length > 0;
    const hasModel = typeof model === 'string' && model.trim().length > 0;
    const hasTemp = typeof temperature === 'number' && temperature >= 0 && temperature <= 1;
    const hasCallMode = typeof call_mode === 'string' && (call_mode === 'primary' || call_mode === 'secondary');

    // Validate: prompt was provided but too short
    if (typeof system_prompt === 'string' && system_prompt.trim().length > 0 && system_prompt.trim().length < 10) {
      return res.status(400).json({ success: false, error: 'system_prompt must be at least 10 characters' });
    }

    // At least one field must be provided
    if (!hasPrompt && !hasGreeting && !hasVoice && !hasModel && !hasTemp && !hasCallMode) {
      return res.status(400).json({
        success: false,
        error: 'At least one field required: system_prompt, first_message, voice_id, model, temperature, call_mode',
      });
    }

    // Fetch client (scoped to agency)
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
    // VAPI PATCH (skip if only call_mode was changed — that's Supabase-only)
    // ====================================================================
    const needsVapiPatch = hasPrompt || hasGreeting || hasVoice || hasModel || hasTemp;

    if (needsVapiPatch) {
      if (!client.vapi_assistant_id) {
        return res.status(400).json({ success: false, error: 'Client has no AI assistant configured' });
      }

      // GET current assistant config to preserve unchanged fields
      const getResponse = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
        headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
      });

      if (!getResponse.ok) {
        console.error('VAPI GET failed:', getResponse.status);
        return res.status(500).json({ success: false, error: 'Failed to fetch current assistant config from VAPI' });
      }

      const currentAssistant = await getResponse.json();
      const currentModel = currentAssistant.model || {};
      const currentVoice = currentAssistant.voice || {};

      // Build VAPI PATCH payload — only include changed fields
      const patchPayload = {};

      // --- model object (prompt, model name, and/or temperature) ---
      if (hasPrompt || hasModel || hasTemp) {
        // Start with current model config to preserve tools, toolIds, provider, etc.
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
      }

      // --- firstMessage (greeting) ---
      if (hasGreeting) {
        patchPayload.firstMessage = first_message.trim();
      }

      // --- voice object ---
      if (hasVoice) {
        // Preserve existing voice config (provider, stability, etc.), only change voiceId
        patchPayload.voice = {
          ...currentVoice,
          voiceId: voice_id.trim(),
        };
      }

      // PATCH VAPI assistant
      const patchResponse = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${VAPI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(patchPayload),
      });

      if (!patchResponse.ok) {
        const errorText = await patchResponse.text();
        console.error('VAPI update failed:', patchResponse.status, errorText);
        return res.status(500).json({
          success: false,
          error: 'Failed to update assistant in VAPI',
          details: errorText,
        });
      }
    }

    // ====================================================================
    // SUPABASE CACHE
    // Prompt is cached in supabase for fast GET. call_mode is supabase-only.
    // Voice/model/temp are VAPI-authoritative (not cached in supabase).
    // ====================================================================
    const supabaseUpdate = {};
    if (hasPrompt) supabaseUpdate.system_prompt = system_prompt.trim();
    if (hasCallMode) supabaseUpdate.call_mode = call_mode;

    if (Object.keys(supabaseUpdate).length > 0) {
      const { error: updateError } = await supabase
        .from('clients')
        .update(supabaseUpdate)
        .eq('id', clientId);

      if (updateError) {
        console.warn('Supabase cache update failed (VAPI was already updated):', updateError.message);
      }
    }

    // Build response
    const updated = {};
    if (hasPrompt) updated.system_prompt = system_prompt.trim();
    if (hasGreeting) updated.first_message = first_message.trim();
    if (hasVoice) updated.voice_id = voice_id.trim();
    if (hasModel) updated.model = model.trim();
    if (hasTemp) updated.temperature = temperature;
    if (hasCallMode) updated.call_mode = call_mode;

    const fields = Object.keys(updated).join(', ');
    console.log(`✅ AI config updated for ${client.business_name} (${clientId}): ${fields}`);

    res.json({ success: true, updated });
  } catch (error) {
    console.error('Error updating client AI config:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================================
// POST /api/agency/:agencyId/clients/:clientId/prompt/reset
// Resets prompt to industry default from INDUSTRY_CONFIGS
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

    if (error || !client) {
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    if (!client.vapi_assistant_id) {
      return res.status(400).json({ success: false, error: 'Client has no AI assistant configured' });
    }

    // Generate default prompt from industry config
    const industryKey = INDUSTRY_MAPPING[client.industry] || 'professional_services';
    const config = INDUSTRY_CONFIGS[industryKey] || INDUSTRY_CONFIGS['professional_services'];
    const defaultPrompt = config.systemPrompt(client.business_name);

    // GET current assistant config from VAPI to preserve model settings
    const getResponse = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
      headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
    });

    if (!getResponse.ok) {
      console.error('VAPI GET failed:', getResponse.status);
      return res.status(500).json({ success: false, error: 'Failed to fetch current assistant config' });
    }

    const currentAssistant = await getResponse.json();
    const currentModel = currentAssistant.model || {};

    // Build updated model with default prompt
    const updatedModel = {
      ...currentModel,
      messages: [{ role: 'system', content: defaultPrompt }],
    };

    // PATCH VAPI assistant
    const patchResponse = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${VAPI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: updatedModel }),
    });

    if (!patchResponse.ok) {
      const errorText = await patchResponse.text();
      console.error('VAPI prompt reset failed:', errorText);
      return res.status(500).json({ success: false, error: 'Failed to reset prompt in VAPI' });
    }

    // Update cache in Supabase
    await supabase
      .from('clients')
      .update({ system_prompt: defaultPrompt })
      .eq('id', clientId);

    console.log(`✅ System prompt reset to ${industryKey} default for ${client.business_name} (${clientId})`);
    res.json({
      success: true,
      system_prompt: defaultPrompt,
      industry: industryKey,
    });
  } catch (error) {
    console.error('Error resetting client prompt:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

module.exports = router;
// ============================================================================
// CLIENT PROMPT ROUTES - Agency-level editing of individual client AI prompts
// Allows agency owners to view/edit/reset a client's VAPI assistant system prompt
// Pattern: mirrors voice/greeting update flow (VAPI PATCH + Supabase cache)
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

    // Fetch client (scoped to agency)
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

    // Resolve industry key for default prompt generation
    const industryKey = INDUSTRY_MAPPING[client.industry] || 'professional_services';

    // 1. Return cached prompt if available
    if (client.system_prompt) {
      return res.json({
        success: true,
        system_prompt: client.system_prompt,
        industry: industryKey,
        business_name: client.business_name,
        source: 'cache',
      });
    }

    // 2. Fetch from VAPI
    const vapiResponse = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
      headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
    });

    if (!vapiResponse.ok) {
      console.error('VAPI fetch failed:', vapiResponse.status);
      return res.status(500).json({ success: false, error: 'Failed to fetch assistant from VAPI' });
    }

    const assistant = await vapiResponse.json();
    const systemPrompt = assistant.model?.messages?.[0]?.content || '';

    // Cache it in DB for next time
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
// Updates system prompt in VAPI + caches in Supabase
// Preserves all other model config (provider, temperature, tools, toolIds)
// ============================================================================
router.put('/:agencyId/clients/:clientId/prompt', async (req, res) => {
  try {
    const { agencyId, clientId } = req.params;
    const { system_prompt } = req.body;

    if (!system_prompt || typeof system_prompt !== 'string' || system_prompt.trim().length < 10) {
      return res.status(400).json({ success: false, error: 'system_prompt is required (minimum 10 characters)' });
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

    if (!client.vapi_assistant_id) {
      return res.status(400).json({ success: false, error: 'Client has no AI assistant configured' });
    }

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

    // Build updated model — preserve everything, only replace messages
    const updatedModel = {
      ...currentModel,
      messages: [{ role: 'system', content: system_prompt.trim() }],
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
      console.error('VAPI prompt update failed:', errorText);
      return res.status(500).json({ success: false, error: 'Failed to update prompt in VAPI' });
    }

    // Cache in Supabase
    await supabase
      .from('clients')
      .update({ system_prompt: system_prompt.trim() })
      .eq('id', clientId);

    console.log(`✅ System prompt updated for client ${client.business_name} (${clientId})`);
    res.json({ success: true, system_prompt: system_prompt.trim() });
  } catch (error) {
    console.error('Error updating client prompt:', error);
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

    // Fetch client (scoped to agency)
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

    // Update cache in Supabase (store the default so GET returns it next time)
    await supabase
      .from('clients')
      .update({ system_prompt: defaultPrompt })
      .eq('id', clientId);

    console.log(`✅ System prompt reset to ${industryKey} default for client ${client.business_name} (${clientId})`);
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
// ============================================================================
// AI PLAYGROUND - Test AI Receptionists in Real Time
// Includes: Chat endpoint, Client AI details, SMS phone swap
// Requires OPENAI_API_KEY for chat, VAPI for live calls
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { formatPhoneE164, formatPhoneDisplay } = require('../lib/notifications');

// ============================================================================
// POST /:agencyId/ai-playground/chat
// Chat with AI using a system prompt (from industry template or custom)
// Returns response + detailed metadata for debug panel
// ============================================================================
router.post('/:agencyId/ai-playground/chat', async (req, res) => {
  const requestStart = Date.now();

  try {
    const { agencyId } = req.params;
    const { 
      systemPrompt, 
      messages, 
      temperature = 0.7, 
      model = 'gpt-4o-mini',
      maxTokens = 500 
    } = req.body;

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ 
        error: 'OPENAI_API_KEY not configured',
        message: 'Add OPENAI_API_KEY to your backend environment variables to use the AI Playground.',
        metadata: { latency_ms: Date.now() - requestStart },
      });
    }

    if (!systemPrompt || typeof systemPrompt !== 'string') {
      return res.status(400).json({ error: 'systemPrompt is required' });
    }

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required and must not be empty' });
    }

    const { data: agency, error: agencyError } = await supabase
      .from('agencies')
      .select('id, name, subscription_status')
      .eq('id', agencyId)
      .single();

    if (agencyError || !agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    const openaiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => ({ role: m.role, content: m.content })),
    ];

    const apiStart = Date.now();

    const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: openaiMessages,
        temperature,
        max_tokens: maxTokens,
      }),
    });

    const apiLatency = Date.now() - apiStart;
    const totalLatency = Date.now() - requestStart;
    const data = await openaiResponse.json();

    if (!openaiResponse.ok) {
      console.error('AI Playground OpenAI error:', data.error);
      return res.status(openaiResponse.status).json({
        error: 'OpenAI API error',
        message: data.error?.message || 'Unknown OpenAI error',
        code: data.error?.code || null,
        type: data.error?.type || null,
        metadata: { 
          api_latency_ms: apiLatency,
          total_latency_ms: totalLatency,
          model, 
          temperature,
          system_prompt_chars: systemPrompt.length,
          message_count: messages.length,
        },
      });
    }

    const assistantMessage = data.choices?.[0]?.message?.content || '';
    const finishReason = data.choices?.[0]?.finish_reason || 'unknown';

    console.log(`🧪 Playground chat for ${agency.name}: ${apiLatency}ms, ${data.usage?.total_tokens || 0} tokens`);

    res.json({
      success: true,
      message: assistantMessage,
      metadata: {
        api_latency_ms: apiLatency,
        total_latency_ms: totalLatency,
        prompt_tokens: data.usage?.prompt_tokens || 0,
        completion_tokens: data.usage?.completion_tokens || 0,
        total_tokens: data.usage?.total_tokens || 0,
        model: data.model || model,
        system_prompt_chars: systemPrompt.length,
        temperature,
        finish_reason: finishReason,
        message_count: messages.length + 1,
      },
    });

  } catch (error) {
    console.error('AI Playground error:', error);
    res.status(500).json({
      error: 'Playground error',
      message: error.message || 'Something went wrong',
      metadata: { total_latency_ms: Date.now() - requestStart },
    });
  }
});

// ============================================================================
// GET /:agencyId/ai-playground/clients
// List all clients for the agency with AI-relevant fields
// Used by the AI Lab client selector
// ============================================================================
router.get('/:agencyId/ai-playground/clients', async (req, res) => {
  try {
    const { agencyId } = req.params;

    const { data: clients, error } = await supabase
      .from('clients')
      .select('id, business_name, industry, owner_name, owner_phone, email, vapi_assistant_id, vapi_phone_number, vapi_phone_id, knowledge_base_id, subscription_status, status, plan_type, business_city, business_state')
      .eq('agency_id', agencyId)
      .neq('status', 'deleted')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching playground clients:', error);
      return res.status(400).json({ error: error.message });
    }

    res.json({ clients: clients || [] });
  } catch (error) {
    console.error('Playground clients error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// GET /:agencyId/ai-playground/clients/:clientId/ai-details
// Get full AI config for a specific client (for live call testing)
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

    if (error || !client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    // Fetch VAPI assistant details if we have an ID
    let assistantDetails = null;
    if (client.vapi_assistant_id && process.env.VAPI_API_KEY) {
      try {
        const vapiResponse = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
          headers: { 'Authorization': `Bearer ${process.env.VAPI_API_KEY}` },
        });
        if (vapiResponse.ok) {
          assistantDetails = await vapiResponse.json();
        }
      } catch (vapiErr) {
        console.warn('Failed to fetch VAPI assistant details:', vapiErr.message);
      }
    }

    res.json({
      client: {
        id: client.id,
        business_name: client.business_name,
        industry: client.industry,
        owner_name: client.owner_name,
        owner_phone: client.owner_phone,
        email: client.email,
        business_city: client.business_city,
        business_state: client.business_state,
        vapi_assistant_id: client.vapi_assistant_id,
        vapi_phone_number: client.vapi_phone_number,
        vapi_phone_id: client.vapi_phone_id,
        knowledge_base_id: client.knowledge_base_id,
        subscription_status: client.subscription_status,
        status: client.status,
        plan_type: client.plan_type,
      },
      assistant: assistantDetails ? {
        id: assistantDetails.id,
        name: assistantDetails.name,
        model: assistantDetails.model?.model || 'unknown',
        voice: assistantDetails.voice?.voiceId || 'unknown',
        voiceProvider: assistantDetails.voice?.provider || 'unknown',
        firstMessage: assistantDetails.firstMessage || null,
        systemPromptLength: assistantDetails.model?.messages?.[0]?.content?.length || 0,
        tools: (assistantDetails.model?.tools || []).map(t => t.function?.name || t.type || 'unknown'),
        serverUrl: assistantDetails.serverUrl || null,
      } : null,
    });
  } catch (error) {
    console.error('AI details error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// PUT /:agencyId/ai-playground/clients/:clientId/notification-phone
// Swap the SMS notification phone number for testing
// Agency owner can temporarily set it to their own number, test, then revert
// ============================================================================
router.put('/:agencyId/ai-playground/clients/:clientId/notification-phone', async (req, res) => {
  try {
    const { agencyId, clientId } = req.params;
    const { phone } = req.body;

    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ error: 'phone is required' });
    }

    // Verify client belongs to agency
    const { data: client, error: fetchError } = await supabase
      .from('clients')
      .select('id, owner_phone, business_name, country')
      .eq('id', clientId)
      .eq('agency_id', agencyId)
      .single();

    if (fetchError || !client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const previousPhone = client.owner_phone;
    const formattedPhone = formatPhoneE164(phone, client.country || 'US') || phone;

    const { error: updateError } = await supabase
      .from('clients')
      .update({ owner_phone: formattedPhone })
      .eq('id', clientId);

    if (updateError) {
      console.error('Error updating notification phone:', updateError);
      return res.status(500).json({ error: 'Failed to update phone number' });
    }

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

// ============================================================================
// GET /:agencyId/ai-playground/models
// Available models for the playground
// ============================================================================
router.get('/:agencyId/ai-playground/models', (req, res) => {
  res.json({
    models: [
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', description: 'Fast, cost-effective — default for most assistants', recommended: true },
      { id: 'gpt-4o', name: 'GPT-4o', description: 'Most capable, higher latency and cost' },
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', description: 'Latest mini model' },
      { id: 'gpt-4.1', name: 'GPT-4.1', description: 'Latest flagship model' },
    ],
  });
});

module.exports = router;
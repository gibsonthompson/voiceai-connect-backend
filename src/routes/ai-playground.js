// ============================================================================
// AI PLAYGROUND - Test AI Receptionists in Real Time
// Requires OPENAI_API_KEY in environment variables
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');

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

    // Validate
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

    // Verify agency exists (lightweight check)
    const { data: agency, error: agencyError } = await supabase
      .from('agencies')
      .select('id, name, subscription_status')
      .eq('id', agencyId)
      .single();

    if (agencyError || !agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    // Build OpenAI messages array
    const openaiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => ({ role: m.role, content: m.content })),
    ];

    const apiStart = Date.now();

    // Call OpenAI
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

    // Handle OpenAI errors
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
        message_count: messages.length + 1, // +1 for system
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
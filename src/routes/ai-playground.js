// ============================================================================
// AI PLAYGROUND - Test & Configure AI Receptionists
// Endpoints: client listing, AI config details, SMS swap, knowledge base
// ============================================================================
const express = require('express');
const router = express.Router();
const FormData = require('form-data');
const fetch = require('node-fetch');
const { supabase } = require('../lib/supabase');

const VAPI_API_KEY = process.env.VAPI_API_KEY;

// Import industry knowledge bases and mapping for KB reset
let INDUSTRY_KNOWLEDGE_BASES, INDUSTRY_MAPPING;
try {
  INDUSTRY_KNOWLEDGE_BASES = require('../lib/industry-knowledge-bases').INDUSTRY_KNOWLEDGE_BASES;
  INDUSTRY_MAPPING = require('../lib/vapi').INDUSTRY_MAPPING;
} catch (err) {
  console.warn('⚠️ Industry KB modules not loaded — KB reset will not work');
}

// ============================================================================
// PHONE HELPERS
// ============================================================================
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
// VAPI KB HELPERS
// ============================================================================

/**
 * Upload text content as a file to VAPI and create a query tool pointing to it.
 * Returns { fileId, toolId }
 */
async function uploadFileAndCreateTool(content, businessName) {
  // 1. Upload file
  const form = new FormData();
  form.append('file', Buffer.from(content, 'utf-8'), {
    filename: `${businessName.replace(/\s+/g, '_')}_knowledge.txt`,
    contentType: 'text/plain',
  });

  const uploadRes = await fetch('https://api.vapi.ai/file', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${VAPI_API_KEY}`, ...form.getHeaders() },
    body: form,
  });

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    throw new Error(`File upload failed: ${errText}`);
  }

  const uploadData = await uploadRes.json();
  console.log(`✅ KB file uploaded: ${uploadData.id}`);

  // 2. Create query tool
  const toolRes = await fetch('https://api.vapi.ai/tool', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${VAPI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type: 'query',
      async: false,
      function: {
        name: 'search_knowledge_base',
        description: `Search ${businessName}'s knowledge base.`,
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: 'The search query' } },
          required: ['query'],
        },
      },
      knowledgeBases: [{
        name: `${businessName} Knowledge Base`,
        model: 'gemini-1.5-flash',
        provider: 'google',
        description: `Information about ${businessName}`,
        fileIds: [uploadData.id],
      }],
    }),
  });

  if (!toolRes.ok) {
    const errText = await toolRes.text();
    throw new Error(`Tool creation failed: ${errText}`);
  }

  const toolData = await toolRes.json();
  console.log(`✅ Query tool created: ${toolData.id}`);

  return { fileId: uploadData.id, toolId: toolData.id };
}

/**
 * Swap toolIds on assistant. Preserves model.tools (transferCall etc).
 */
async function swapToolOnAssistant(assistantId, newToolId) {
  const getRes = await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
    headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
  });

  if (!getRes.ok) throw new Error('Failed to fetch assistant from VAPI');

  const assistant = await getRes.json();
  const currentModel = assistant.model || {};

  // Only replace toolIds — leave model.tools (transferCall etc) untouched
  const updatedModel = {
    ...currentModel,
    toolIds: [newToolId],
  };

  const patchRes = await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${VAPI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: updatedModel }),
  });

  if (!patchRes.ok) {
    const errText = await patchRes.text();
    throw new Error(`Assistant PATCH failed: ${errText}`);
  }

  console.log(`✅ Assistant ${assistantId} toolIds updated to [${newToolId}]`);
}

/**
 * Walk VAPI chain: assistant → toolIds[0] → tool → knowledgeBases[0].fileIds[0] → file content
 */
async function fetchKBContentFromVapi(assistantId) {
  try {
    const aRes = await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
      headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
    });
    if (!aRes.ok) return null;
    const assistant = await aRes.json();

    const toolId = assistant.model?.toolIds?.[0];
    if (!toolId) return null;

    const tRes = await fetch(`https://api.vapi.ai/tool/${toolId}`, {
      headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
    });
    if (!tRes.ok) return null;
    const tool = await tRes.json();

    const fileId = tool.knowledgeBases?.[0]?.fileIds?.[0];
    if (!fileId) return null;

    const fRes = await fetch(`https://api.vapi.ai/file/${fileId}/content`, {
      headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
    });
    if (!fRes.ok) return null;

    const content = await fRes.text();
    return { content, toolId, fileId };
  } catch (err) {
    console.error('Failed to fetch KB from VAPI:', err.message);
    return null;
  }
}

/**
 * Generate industry default KB content
 */
function generateDefaultContent(businessName, industryKey) {
  if (!INDUSTRY_KNOWLEDGE_BASES) {
    return `# ${businessName} Knowledge Base\n\nNo industry knowledge base module available.`;
  }
  const generator = INDUSTRY_KNOWLEDGE_BASES[industryKey] || INDUSTRY_KNOWLEDGE_BASES['professional_services'];
  return generator(businessName);
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
    if (client.vapi_assistant_id && VAPI_API_KEY) {
      try {
        const vapiResponse = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
          headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
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
// GET /:agencyId/ai-playground/clients/:clientId/knowledge-base
// Returns KB content. Priority: DB cache → VAPI file → generate default.
// ============================================================================
router.get('/:agencyId/ai-playground/clients/:clientId/knowledge-base', async (req, res) => {
  try {
    const { agencyId, clientId } = req.params;

    const { data: client, error } = await supabase
      .from('clients')
      .select('id, vapi_assistant_id, industry, business_name, knowledge_base_content, business_website')
      .eq('id', clientId)
      .eq('agency_id', agencyId)
      .single();

    if (error || !client) {
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    const industryKey = INDUSTRY_MAPPING?.[client.industry] || 'professional_services';

    // 1. Return cached content if available
    if (client.knowledge_base_content) {
      return res.json({
        success: true,
        content: client.knowledge_base_content,
        industry: industryKey,
        business_name: client.business_name,
        has_website: !!client.business_website,
        source: 'cache',
      });
    }

    // 2. Try fetching from VAPI file chain
    if (client.vapi_assistant_id) {
      const vapiData = await fetchKBContentFromVapi(client.vapi_assistant_id);
      if (vapiData?.content) {
        // Cache for next time
        await supabase
          .from('clients')
          .update({
            knowledge_base_content: vapiData.content,
            knowledge_base_data: { fileId: vapiData.fileId, toolId: vapiData.toolId },
          })
          .eq('id', clientId);

        return res.json({
          success: true,
          content: vapiData.content,
          industry: industryKey,
          business_name: client.business_name,
          has_website: !!client.business_website,
          source: 'vapi',
        });
      }
    }

    // 3. Generate industry default
    const defaultContent = generateDefaultContent(client.business_name, industryKey);

    await supabase
      .from('clients')
      .update({ knowledge_base_content: defaultContent })
      .eq('id', clientId);

    return res.json({
      success: true,
      content: defaultContent,
      industry: industryKey,
      business_name: client.business_name,
      has_website: !!client.business_website,
      source: 'generated',
    });
  } catch (error) {
    console.error('Error fetching knowledge base:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================================
// PUT /:agencyId/ai-playground/clients/:clientId/knowledge-base
// Updates KB: upload new file → create tool → swap on assistant → cache
// ============================================================================
router.put('/:agencyId/ai-playground/clients/:clientId/knowledge-base', async (req, res) => {
  try {
    const { agencyId, clientId } = req.params;
    const { content } = req.body;

    if (!content || typeof content !== 'string' || content.trim().length < 50) {
      return res.status(400).json({ success: false, error: 'Content is required (minimum 50 characters)' });
    }

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

    const trimmed = content.trim();

    // Upload file + create query tool + swap on assistant
    const { fileId, toolId } = await uploadFileAndCreateTool(trimmed, client.business_name);
    await swapToolOnAssistant(client.vapi_assistant_id, toolId);

    // Cache in Supabase
    await supabase
      .from('clients')
      .update({
        knowledge_base_content: trimmed,
        knowledge_base_data: { fileId, toolId },
        knowledge_base_updated_at: new Date().toISOString(),
      })
      .eq('id', clientId);

    console.log(`✅ Knowledge base updated for ${client.business_name} (${clientId}) via AI Lab`);
    res.json({ success: true, content: trimmed });
  } catch (error) {
    console.error('Error updating knowledge base:', error);
    res.status(500).json({ success: false, error: error.message || 'Server error' });
  }
});

// ============================================================================
// POST /:agencyId/ai-playground/clients/:clientId/knowledge-base/reset
// Resets KB to industry default, re-uploads to VAPI, swaps tool
// ============================================================================
router.post('/:agencyId/ai-playground/clients/:clientId/knowledge-base/reset', async (req, res) => {
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

    const industryKey = INDUSTRY_MAPPING?.[client.industry] || 'professional_services';
    const defaultContent = generateDefaultContent(client.business_name, industryKey);

    // Upload + create tool + swap
    const { fileId, toolId } = await uploadFileAndCreateTool(defaultContent, client.business_name);
    await swapToolOnAssistant(client.vapi_assistant_id, toolId);

    // Cache
    await supabase
      .from('clients')
      .update({
        knowledge_base_content: defaultContent,
        knowledge_base_data: { fileId, toolId },
        knowledge_base_updated_at: new Date().toISOString(),
      })
      .eq('id', clientId);

    console.log(`✅ Knowledge base reset to ${industryKey} default for ${client.business_name} (${clientId})`);
    res.json({
      success: true,
      content: defaultContent,
      industry: industryKey,
    });
  } catch (error) {
    console.error('Error resetting knowledge base:', error);
    res.status(500).json({ success: false, error: error.message || 'Server error' });
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
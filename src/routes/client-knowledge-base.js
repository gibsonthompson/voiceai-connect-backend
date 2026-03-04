// ============================================================================
// KNOWLEDGE BASE ROUTES - Agency-level viewing/editing of client KB content
// Allows agency owners to view/edit/reset a client's AI receptionist knowledge base
//
// Data flow for UPDATE:
//   1. Upload new file to VAPI (POST /file)
//   2. Create new query tool pointing to new file (POST /tool)
//   3. PATCH assistant model.toolIds to swap old tool for new
//   4. Cache content + IDs in Supabase
//
// VAPI structure (from live assistant):
//   model.toolIds = ["<query-tool-id>"]     ← KB query tool (what we swap)
//   model.tools   = [{ type: "transferCall" ... }]  ← inline tools (DON'T TOUCH)
// ============================================================================
const express = require('express');
const router = express.Router();
const FormData = require('form-data');
const { supabase } = require('../lib/supabase');
const { INDUSTRY_MAPPING } = require('../lib/vapi');

let INDUSTRY_KNOWLEDGE_BASES;
try {
  INDUSTRY_KNOWLEDGE_BASES = require('../lib/industry-knowledge-bases').INDUSTRY_KNOWLEDGE_BASES;
} catch (err) {
  console.warn('⚠️ industry-knowledge-bases module not found — reset will not work');
}

const VAPI_API_KEY = process.env.VAPI_API_KEY;

// ============================================================================
// HELPER: Upload content as file to VAPI + create query tool
// Returns { fileId, toolId }
// ============================================================================
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

  // 2. Create query tool pointing to the new file
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

// ============================================================================
// HELPER: Swap toolIds on assistant (preserves model.tools like transferCall)
// ============================================================================
async function swapToolOnAssistant(assistantId, newToolId) {
  // GET current assistant to preserve everything
  const getRes = await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
    headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
  });

  if (!getRes.ok) throw new Error('Failed to fetch assistant from VAPI');

  const assistant = await getRes.json();
  const currentModel = assistant.model || {};

  // Only replace toolIds — leave tools (transferCall etc) untouched
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

// ============================================================================
// HELPER: Try to fetch current KB content from VAPI file
// Walks: assistant → toolIds[0] → tool → knowledgeBases[0].fileIds[0] → file
// ============================================================================
async function fetchContentFromVapi(assistantId) {
  try {
    // Get assistant
    const aRes = await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
      headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
    });
    if (!aRes.ok) return null;
    const assistant = await aRes.json();

    const toolId = assistant.model?.toolIds?.[0];
    if (!toolId) return null;

    // Get tool
    const tRes = await fetch(`https://api.vapi.ai/tool/${toolId}`, {
      headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
    });
    if (!tRes.ok) return null;
    const tool = await tRes.json();

    const fileId = tool.knowledgeBases?.[0]?.fileIds?.[0];
    if (!fileId) return null;

    // Get file content
    const fRes = await fetch(`https://api.vapi.ai/file/${fileId}/content`, {
      headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
    });
    if (!fRes.ok) return null;

    const content = await fRes.text();
    return { content, toolId, fileId };
  } catch (err) {
    console.error('Failed to fetch KB content from VAPI:', err.message);
    return null;
  }
}

// ============================================================================
// HELPER: Generate default KB content for an industry
// ============================================================================
function generateDefaultContent(businessName, industryKey) {
  if (!INDUSTRY_KNOWLEDGE_BASES) {
    return `# ${businessName} Knowledge Base\n\nNo industry knowledge base module available.`;
  }
  const generator = INDUSTRY_KNOWLEDGE_BASES[industryKey] || INDUSTRY_KNOWLEDGE_BASES['professional_services'];
  return generator(businessName);
}

// ============================================================================
// GET /:agencyId/clients/:clientId/knowledge-base
// Returns KB content. Priority: DB cache → VAPI file → generate default.
// ============================================================================
router.get('/:agencyId/clients/:clientId/knowledge-base', async (req, res) => {
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

    const industryKey = INDUSTRY_MAPPING[client.industry] || 'professional_services';

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

    // 2. Try fetching from VAPI (for clients created with KB but no cache yet)
    if (client.vapi_assistant_id) {
      const vapiData = await fetchContentFromVapi(client.vapi_assistant_id);
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
// PUT /:agencyId/clients/:clientId/knowledge-base
// Updates KB: upload new file → create tool → swap on assistant → cache
// ============================================================================
router.put('/:agencyId/clients/:clientId/knowledge-base', async (req, res) => {
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

    // Upload + create tool + swap on assistant
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

    console.log(`✅ Knowledge base updated for ${client.business_name} (${clientId})`);
    res.json({ success: true, content: trimmed });
  } catch (error) {
    console.error('Error updating knowledge base:', error);
    res.status(500).json({ success: false, error: error.message || 'Server error' });
  }
});

// ============================================================================
// POST /:agencyId/clients/:clientId/knowledge-base/reset
// Resets KB to industry default, re-uploads to VAPI, swaps tool
// ============================================================================
router.post('/:agencyId/clients/:clientId/knowledge-base/reset', async (req, res) => {
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

    const industryKey = INDUSTRY_MAPPING[client.industry] || 'professional_services';
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

module.exports = router;
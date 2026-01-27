// ============================================================================
// KNOWLEDGE BASE ROUTES - VoiceAI Connect Multi-Tenant Backend
// Location: src/routes/knowledge-base.js
// 
// FIXED: Uses Query Tool approach per VAPI 2025 documentation
// Flow:
// 1. Upload file → fileId
// 2. Create Query Tool with knowledgeBases[].fileIds → toolId
// 3. Attach toolId to assistant via model.toolIds
// ============================================================================

const fetch = require('node-fetch');
const FormData = require('form-data');
const { supabase } = require('../lib/supabase');

const VAPI_API_KEY = process.env.VAPI_API_KEY;

// ============================================================================
// FORMAT KNOWLEDGE BASE CONTENT
// ============================================================================
function formatKnowledgeBase(data) {
  const sections = [
    `# ${data.businessName} - Business Information`,
    ``,
    `## Company Details`,
    `- Business Name: ${data.businessName}`,
  ];

  if (data.industry) {
    sections.push(`- Industry: ${data.industry}`);
  }
  
  if (data.city || data.state) {
    sections.push(`- Location: ${[data.city, data.state].filter(Boolean).join(', ')}`);
  }
  
  if (data.phoneNumber) {
    sections.push(`- Phone: ${data.phoneNumber}`);
  }

  if (data.websiteUrl) {
    sections.push(`- Website: ${data.websiteUrl}`);
  }

  if (data.businessHours && data.businessHours.trim()) {
    sections.push(``);
    sections.push(`## Business Hours`);
    sections.push(data.businessHours);
  }

  if (data.services && data.services.trim()) {
    sections.push(``);
    sections.push(`## Services & Pricing`);
    sections.push(data.services);
  }

  if (data.faqs && data.faqs.trim()) {
    sections.push(``);
    sections.push(`## Frequently Asked Questions`);
    sections.push(data.faqs);
  }

  if (data.additionalInfo && data.additionalInfo.trim()) {
    sections.push(``);
    sections.push(`## Additional Information`);
    sections.push(data.additionalInfo);
  }

  // Only include website content if it's NOT from our own sites
  if (data.websiteContent && data.websiteContent.trim() && !data.websiteContent.includes('CallBird AI')) {
    sections.push(``);
    sections.push(`## Website Content`);
    sections.push(data.websiteContent.substring(0, 8000));
  }

  return sections.join('\n');
}

// ============================================================================
// DELETE OLD FILES FOR THIS CLIENT
// ============================================================================
async function deleteOldFiles(businessName) {
  try {
    const listResponse = await fetch('https://api.vapi.ai/file', {
      headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
    });
    
    if (!listResponse.ok) return;
    
    const files = await listResponse.json();
    const sanitizedName = businessName.replace(/[^a-zA-Z0-9]/g, '_');
    
    const oldFiles = files.filter(f => 
      f.name && 
      f.name.includes(sanitizedName) && 
      f.name.includes('_knowledge')
    );
    
    console.log(`🗑️ Found ${oldFiles.length} old files to delete`);
    
    for (const file of oldFiles) {
      try {
        await fetch(`https://api.vapi.ai/file/${file.id}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
        });
        console.log(`   Deleted: ${file.name}`);
      } catch (e) {
        console.log(`   ⚠️ Could not delete ${file.id}`);
      }
    }
  } catch (error) {
    console.log('⚠️ Could not cleanup old files:', error.message);
  }
}

// ============================================================================
// DELETE OLD QUERY TOOLS FOR THIS CLIENT
// ============================================================================
async function deleteOldTools(assistantId) {
  if (!assistantId) return;
  
  try {
    // Get current assistant to find attached tools
    const getResponse = await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
      headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
    });
    
    if (!getResponse.ok) return;
    
    const assistant = await getResponse.json();
    const toolIds = assistant.model?.toolIds || [];
    
    if (toolIds.length === 0) {
      console.log('🗑️ No existing tools to check');
      return;
    }
    
    // Check each tool to see if it's a knowledge base query tool
    for (const toolId of toolIds) {
      try {
        const toolResponse = await fetch(`https://api.vapi.ai/tool/${toolId}`, {
          headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
        });
        
        if (toolResponse.ok) {
          const tool = await toolResponse.json();
          
          // Delete if it's a query tool for knowledge base
          if (tool.type === 'query' && 
              (tool.function?.name === 'search_knowledge_base' || 
               tool.function?.name?.includes('kb_search'))) {
            await fetch(`https://api.vapi.ai/tool/${toolId}`, {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
            });
            console.log(`🗑️ Deleted old KB tool: ${tool.function?.name}`);
          }
        }
      } catch (e) {
        console.log(`   ⚠️ Could not check/delete tool ${toolId}`);
      }
    }
  } catch (error) {
    console.log('⚠️ Could not cleanup old tools:', error.message);
  }
}

// ============================================================================
// SMART MERGE - Only update fields that have new non-empty values
// ============================================================================
function smartMerge(existingData, newData) {
  const result = { ...existingData };
  
  if (newData.businessHours && newData.businessHours.trim()) {
    result.businessHours = newData.businessHours;
  }
  
  if (newData.services && newData.services.trim()) {
    result.services = newData.services;
  }
  
  if (newData.faqs && newData.faqs.trim()) {
    result.faqs = newData.faqs;
  }
  
  if (newData.additionalInfo && newData.additionalInfo.trim()) {
    result.additionalInfo = newData.additionalInfo;
  }
  
  if (newData.websiteContent && newData.websiteContent.trim()) {
    result.websiteContent = newData.websiteContent;
  }
  
  return result;
}

// ============================================================================
// UPDATE KNOWLEDGE BASE - Main handler
// ============================================================================
async function updateKnowledgeBase(req, res) {
  try {
    console.log('');
    console.log('📚 ====== KNOWLEDGE BASE UPDATE (Query Tool Method) ======');
    
    const {
      clientId,
      businessHours,
      services,
      faqs,
      additionalInfo,
      websiteUrl
    } = req.body;

    if (!clientId) {
      return res.status(400).json({ success: false, error: 'Client ID required' });
    }

    // ========================================
    // 1. GET CLIENT DATA
    // ========================================
    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select(`
        *,
        agencies (id, name)
      `)
      .eq('id', clientId)
      .single();

    if (clientError || !client) {
      console.error('❌ Client not found:', clientError);
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    console.log('✅ Client:', client.business_name);
    console.log('   Assistant ID:', client.vapi_assistant_id);

    // ========================================
    // 2. SMART MERGE - Keep existing data, only update non-empty fields
    // ========================================
    const existingData = client.knowledge_base_data || {};
    console.log('📂 Existing data keys:', Object.keys(existingData).filter(k => existingData[k]));

    const newData = {
      businessHours: businessHours || '',
      services: services || '',
      faqs: faqs || '',
      additionalInfo: additionalInfo || '',
    };
    console.log('📥 New data keys:', Object.keys(newData).filter(k => newData[k] && newData[k].trim()));

    const finalData = smartMerge(existingData, newData);
    console.log('📦 Final data keys:', Object.keys(finalData).filter(k => finalData[k] && finalData[k].trim()));

    // ========================================
    // 3. WEBSITE SCRAPING (if URL changed)
    // ========================================
    let websiteContent = existingData.websiteContent || '';
    const newWebsiteUrl = websiteUrl || client.business_website;
    
    if (websiteUrl && 
        websiteUrl.trim() && 
        websiteUrl !== client.business_website &&
        !websiteUrl.includes('callbirdai.com') &&
        !websiteUrl.includes('myvoiceaiconnect.com')) {
      try {
        console.log('🌐 Scraping website:', websiteUrl);
        const scrapeResponse = await fetch(`https://r.jina.ai/${websiteUrl}`, {
          headers: { 'Accept': 'text/plain' }
        });
        if (scrapeResponse.ok) {
          websiteContent = await scrapeResponse.text();
          finalData.websiteContent = websiteContent;
          console.log('✅ Website scraped, length:', websiteContent.length);
        }
      } catch (error) {
        console.log('⚠️ Website scraping failed:', error.message);
      }
    }

    // ========================================
    // 4. FORMAT KNOWLEDGE BASE CONTENT
    // ========================================
    const content = formatKnowledgeBase({
      businessName: client.business_name,
      industry: client.industry,
      city: client.business_city,
      state: client.business_state,
      phoneNumber: client.vapi_phone_number,
      websiteUrl: newWebsiteUrl,
      websiteContent: finalData.websiteContent || '',
      businessHours: finalData.businessHours || '',
      services: finalData.services || '',
      faqs: finalData.faqs || '',
      additionalInfo: finalData.additionalInfo || '',
    });

    console.log('📄 Formatted KB length:', content.length, 'chars');

    // ========================================
    // 5. DELETE OLD FILES AND TOOLS
    // ========================================
    await deleteOldFiles(client.business_name);
    await deleteOldTools(client.vapi_assistant_id);

    // ========================================
    // 6. UPLOAD NEW FILE TO VAPI
    // ========================================
    const form = new FormData();
    const filename = `${client.business_name.replace(/[^a-zA-Z0-9]/g, '_')}_knowledge.txt`;
    form.append('file', Buffer.from(content, 'utf-8'), {
      filename: filename,
      contentType: 'text/plain',
    });

    console.log('📤 Uploading file:', filename);
    const uploadResponse = await fetch('https://api.vapi.ai/file', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VAPI_API_KEY}`,
        ...form.getHeaders(),
      },
      body: form,
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      console.error('❌ VAPI file upload failed:', errorText);
      throw new Error(`VAPI file upload failed: ${uploadResponse.status}`);
    }

    const uploadData = await uploadResponse.json();
    const fileId = uploadData.id;
    console.log('✅ File uploaded:', fileId);

    // ========================================
    // 7. CREATE KNOWLEDGE BASE ENTITY (indexes the file)
    // ========================================
    console.log('📚 Creating Knowledge Base entity...');
    
    const kbResponse = await fetch('https://api.vapi.ai/knowledge-base', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VAPI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        provider: 'canonical',
        fileIds: [fileId],
      }),
    });

    if (!kbResponse.ok) {
      const errorText = await kbResponse.text();
      console.error('⚠️ KB entity creation failed:', errorText);
      // Continue anyway - Query Tool might still work
    } else {
      const kbData = await kbResponse.json();
      console.log('✅ Knowledge Base entity created:', kbData.id);
    }

    // ========================================
    // 8. CREATE QUERY TOOL WITH KNOWLEDGE BASE
    // ========================================
    console.log('🔧 Creating Query Tool...');
    
    const toolResponse = await fetch('https://api.vapi.ai/tool', {
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
          description: `Search ${client.business_name}'s knowledge base for information about services, pricing, hours, policies, and company information.`,
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'The search query to find relevant information'
              }
            },
            required: ['query']
          }
        },
        knowledgeBases: [{
          name: `${client.business_name} Knowledge Base`,
          model: 'gemini-1.5-flash',
          provider: 'google',
          description: `Contains information about ${client.business_name}'s services, pricing, hours, policies, and company details`,
          fileIds: [fileId]
        }]
      }),
    });

    if (!toolResponse.ok) {
      const errorText = await toolResponse.text();
      console.error('❌ Query Tool creation failed:', errorText);
      throw new Error(`Query Tool creation failed: ${toolResponse.status}`);
    }

    const toolData = await toolResponse.json();
    const toolId = toolData.id;
    console.log('✅ Query Tool created:', toolId);

    // ========================================
    // 9. ATTACH QUERY TOOL TO ASSISTANT
    // ========================================
    if (client.vapi_assistant_id) {
      console.log('🔗 Attaching Query Tool to assistant...');
      
      // Get current assistant to preserve settings
      const getResponse = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
        headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
      });
      
      if (getResponse.ok) {
        const currentAssistant = await getResponse.json();
        console.log('   Current model:', currentAssistant.model?.model);
        console.log('   Has messages:', !!currentAssistant.model?.messages?.length);
        
        // Just use our new KB tool (old one was already deleted)
        const newToolIds = [toolId];
        console.log('   Setting toolIds:', newToolIds);
        
        // IMPORTANT: Preserve the ENTIRE model object including messages/system prompt
        const updatedModel = {
          ...currentAssistant.model,  // Preserve everything (messages, temperature, etc.)
          toolIds: newToolIds         // Add our new tool
        };
        
        // Update assistant with new toolIds while preserving everything else
        const patchResponse = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${VAPI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: updatedModel
          }),
        });
        
        if (patchResponse.ok) {
          console.log('✅ Query Tool attached to assistant!');
        } else {
          const errorText = await patchResponse.text();
          console.error('⚠️ Failed to attach tool:', errorText);
        }
      } else {
        console.error('⚠️ Could not fetch assistant');
      }
    } else {
      console.log('⚠️ No vapi_assistant_id - skipping tool attachment');
    }

    // ========================================
    // 10. SAVE TO DATABASE
    // ========================================
    const { error: updateError } = await supabase
      .from('clients')
      .update({
        knowledge_base_id: toolId, // Store tool ID for reference
        knowledge_base_data: finalData,
        knowledge_base_updated_at: new Date().toISOString(),
        business_website: newWebsiteUrl || client.business_website,
      })
      .eq('id', clientId);

    if (updateError) {
      console.error('❌ Database update error:', updateError);
      throw new Error('Failed to save to database');
    }

    console.log('✅ Database updated');
    console.log('📚 ====== UPDATE COMPLETE ======');
    console.log('');

    return res.json({
      success: true,
      message: 'Knowledge base updated successfully',
      fileId: fileId,
      toolId: toolId,
    });

  } catch (error) {
    console.error('❌ Knowledge base update error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to update knowledge base',
    });
  }
}

module.exports = { updateKnowledgeBase, formatKnowledgeBase, smartMerge };
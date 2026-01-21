// ============================================================================
// KNOWLEDGE BASE MANAGEMENT - Multi-Tenant
// Adapted from CallBird's knowledge-base.js
// ============================================================================
const fetch = require('node-fetch');
const FormData = require('form-data');
const { supabase, getClientById } = require('../lib/supabase');

const VAPI_API_KEY = process.env.VAPI_API_KEY;

// ============================================================================
// CREATE QUERY TOOL (for Knowledge Base access)
// ============================================================================
async function createQueryTool(fileId, businessName) {
  try {
    console.log('🔧 Creating Query Tool...');
    
    const response = await fetch('https://api.vapi.ai/tool', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VAPI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        type: 'query',
        async: false,
        function: {
          name: 'search_knowledge_base',
          description: `Search ${businessName}'s knowledge base for information about services, pricing, hours, and policies.`,
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'The search query'
              }
            },
            required: ['query']
          }
        },
        knowledgeBases: [{
          name: `${businessName} Knowledge Base`,
          model: 'gemini-1.5-flash',
          provider: 'google',
          description: `Information about ${businessName}`,
          fileIds: [fileId]
        }]
      })
    });

    if (!response.ok) {
      console.error('⚠️ Query tool creation failed');
      return null;
    }

    const data = await response.json();
    console.log(`✅ Query Tool created: ${data.id}`);
    return data.id;
  } catch (error) {
    console.error('❌ Query tool error:', error);
    return null;
  }
}

// ============================================================================
// FORMAT KNOWLEDGE BASE CONTENT
// ============================================================================
function formatKnowledgeBase(data) {
  const sections = [
    `# ${data.businessName} - AI Assistant Knowledge Base`,
    `\n## Business Information`,
    `- Business Name: ${data.businessName}`,
    `- Industry: ${data.industry || 'N/A'}`,
    `- Location: ${data.city}, ${data.state}`,
    `- Phone Number: ${data.phoneNumber || 'N/A'}`,
  ];

  if (data.websiteUrl) {
    sections.push(`- Website: ${data.websiteUrl}`);
  }

  if (data.businessHours) {
    sections.push(`\n## Business Hours`);
    sections.push(data.businessHours);
  }

  if (data.services) {
    sections.push(`\n## Services & Pricing`);
    sections.push(data.services);
  }

  if (data.faqs) {
    sections.push(`\n## Frequently Asked Questions`);
    sections.push(data.faqs);
  }

  if (data.additionalInfo) {
    sections.push(`\n## Additional Information`);
    sections.push(data.additionalInfo);
  }

  if (data.websiteContent) {
    sections.push(`\n## Website Content`);
    sections.push(data.websiteContent.substring(0, 10000));
  }

  sections.push(`\n## Instructions for AI Assistant`);
  sections.push(`You are an AI phone assistant for ${data.businessName}. Use the information above to answer customer questions accurately. Always be professional, friendly, and helpful. If you don't know something, politely say so and offer to take a message.`);

  return sections.join('\n');
}

// ============================================================================
// UPDATE KNOWLEDGE BASE
// ============================================================================
async function updateKnowledgeBase(req, res) {
  try {
    console.log('📚 Knowledge base update started');
    
    const {
      clientId,
      businessHours,
      services,
      faqs,
      additionalInfo,
      websiteUrl
    } = req.body;

    if (!clientId) {
      return res.status(400).json({ error: 'Client ID required' });
    }

    // Get client with agency data
    const client = await getClientById(clientId);

    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    console.log('✅ Client found:', client.business_name);
    if (client.agencies) {
      console.log('🏢 Agency:', client.agencies.name);
    }

    // Merge logic: Keep existing data if field is empty
    const existingData = client.knowledge_base_data || {};
    
    const finalData = {
      businessHours: businessHours || existingData.businessHours || '',
      services: services || existingData.services || '',
      faqs: faqs || existingData.faqs || '',
      additionalInfo: additionalInfo || existingData.additionalInfo || '',
    };

    // Website scraping (if URL changed)
    let websiteContent = existingData.websiteContent || '';
    
    if (websiteUrl && websiteUrl.trim() && websiteUrl !== client.business_website) {
      try {
        console.log('🌐 Scraping website:', websiteUrl);
        const scrapeResponse = await fetch(`https://r.jina.ai/${websiteUrl}`);
        if (scrapeResponse.ok) {
          websiteContent = await scrapeResponse.text();
          console.log('✅ Website scraped, length:', websiteContent.length);
        }
      } catch (error) {
        console.error('⚠️ Website scraping failed:', error.message);
      }
    }

    // Format knowledge base content
    const content = formatKnowledgeBase({
      businessName: client.business_name,
      industry: client.industry,
      city: client.business_city,
      state: client.business_state,
      phoneNumber: client.vapi_phone_number,
      websiteUrl: websiteUrl || client.business_website,
      websiteContent: websiteContent,
      businessHours: finalData.businessHours,
      services: finalData.services,
      faqs: finalData.faqs,
      additionalInfo: finalData.additionalInfo,
    });

    console.log('📄 Knowledge base formatted, length:', content.length);

    // Upload file to VAPI
    const form = new FormData();
    form.append('file', Buffer.from(content, 'utf-8'), {
      filename: `${client.business_name.replace(/\s+/g, '_')}_knowledge.txt`,
      contentType: 'text/plain',
    });

    console.log('📤 Uploading to VAPI...');
    const uploadResponse = await fetch('https://api.vapi.ai/file', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VAPI_API_KEY}`,
        ...form.getHeaders(),
      },
      body: form,
    });

    if (!uploadResponse.ok) {
      throw new Error(`VAPI upload failed: ${uploadResponse.status}`);
    }

    const uploadData = await uploadResponse.json();
    const fileId = uploadData.id;
    console.log('✅ File uploaded:', fileId);

    // Create knowledge base
    console.log('📚 Creating knowledge base...');
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
      throw new Error('Failed to create knowledge base');
    }

    const kbData = await kbResponse.json();
    const knowledgeBaseId = kbData.id;
    console.log('✅ Knowledge base created:', knowledgeBaseId);

    // Update assistant with new Query Tool
    if (client.vapi_assistant_id) {
      console.log('🔧 Creating Query Tool...');
      
      const queryToolId = await createQueryTool(fileId, client.business_name);
      
      if (queryToolId) {
        // Get current assistant config
        const getResponse = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
          headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
        });
        
        if (getResponse.ok) {
          const currentAssistant = await getResponse.json();
          
          // Update with new Query Tool
          await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
            method: 'PATCH',
            headers: {
              'Authorization': `Bearer ${VAPI_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: {
                ...currentAssistant.model,
                toolIds: [queryToolId]
              },
            }),
          });
          
          console.log('✅ Assistant updated with Query Tool');
        }
      }
    }

    // Save to database
    const { error: updateError } = await supabase
      .from('clients')
      .update({
        knowledge_base_id: knowledgeBaseId,
        knowledge_base_data: {
          ...finalData,
          websiteContent: websiteContent,
        },
        knowledge_base_updated_at: new Date().toISOString(),
        business_website: websiteUrl || client.business_website,
      })
      .eq('id', clientId);

    if (updateError) {
      throw new Error('Failed to save to database');
    }

    console.log('✅ Knowledge base update complete');

    return res.json({
      success: true,
      message: 'Knowledge base updated successfully',
      knowledgeBaseId,
    });

  } catch (error) {
    console.error('❌ Knowledge base update error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to update knowledge base',
    });
  }
}

module.exports = { updateKnowledgeBase, createQueryTool, formatKnowledgeBase };

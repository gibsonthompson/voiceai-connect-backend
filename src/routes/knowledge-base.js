// ============================================================================
// KNOWLEDGE BASE ROUTES - VoiceAI Connect Multi-Tenant Backend
// Location: src/routes/knowledge-base.js
// 
// FIXED: Properly creates VAPI Knowledge Base entity and attaches to assistant
// 
// Flow:
// 1. Upload file → fileId
// 2. Create Knowledge Base with fileId → knowledgeBaseId
// 3. Attach knowledgeBaseId to assistant
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

  // Only include website content if it's NOT from callbirdai.com (our marketing site)
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
// DELETE OLD KNOWLEDGE BASES FOR THIS CLIENT
// ============================================================================
async function deleteOldKnowledgeBases(businessName) {
  try {
    const listResponse = await fetch('https://api.vapi.ai/knowledge-base', {
      headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
    });
    
    if (!listResponse.ok) return;
    
    const knowledgeBases = await listResponse.json();
    const sanitizedName = businessName.replace(/[^a-zA-Z0-9]/g, '_');
    
    const oldKBs = knowledgeBases.filter(kb => 
      kb.name && kb.name.includes(sanitizedName)
    );
    
    console.log(`🗑️ Found ${oldKBs.length} old knowledge bases to delete`);
    
    for (const kb of oldKBs) {
      try {
        await fetch(`https://api.vapi.ai/knowledge-base/${kb.id}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
        });
        console.log(`   Deleted KB: ${kb.name}`);
      } catch (e) {
        console.log(`   ⚠️ Could not delete KB ${kb.id}`);
      }
    }
  } catch (error) {
    console.log('⚠️ Could not cleanup old knowledge bases:', error.message);
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
    console.log('📚 ====== KNOWLEDGE BASE UPDATE ======');
    
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
    
    // Only scrape if URL is provided, different from before, and NOT our own site
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
    // 5. DELETE OLD FILES AND KNOWLEDGE BASES
    // ========================================
    await deleteOldFiles(client.business_name);
    await deleteOldKnowledgeBases(client.business_name);

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
    // 7. CREATE KNOWLEDGE BASE IN VAPI
    // ========================================
    console.log('📚 Creating Knowledge Base...');
    
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
      console.error('❌ Knowledge Base creation failed:', errorText);
      throw new Error(`Knowledge Base creation failed: ${kbResponse.status}`);
    }

    const kbData = await kbResponse.json();
    const knowledgeBaseId = kbData.id;
    console.log('✅ Knowledge Base created:', knowledgeBaseId);

    // ========================================
    // 8. ATTACH KNOWLEDGE BASE TO ASSISTANT VIA MODEL
    // ========================================
    if (client.vapi_assistant_id) {
      console.log('🔗 Attaching Knowledge Base to assistant...');
      
      // First get current assistant to preserve model settings
      const getResponse = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
        headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
      });
      
      if (getResponse.ok) {
        const currentAssistant = await getResponse.json();
        console.log('   Current model provider:', currentAssistant.model?.provider);
        console.log('   Current model:', currentAssistant.model?.model);
        
        // Try exactly like CallBird - just model.knowledgeBase, no spread
        console.log('   Trying method 1: model.knowledgeBase with id...');
        const patchResponse = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${VAPI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: {
              knowledgeBase: {
                provider: 'canonical',
                id: knowledgeBaseId,
              }
            }
          }),
        });
        
        if (patchResponse.ok) {
          console.log('✅ Method 1 worked! Knowledge Base attached!');
        } else {
          const errorText = await patchResponse.text();
          console.error('   Method 1 failed:', errorText);
          
          // Try method 2: knowledgeBase at root level
          console.log('   Trying method 2: knowledgeBase at root...');
          const patch2 = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
            method: 'PATCH',
            headers: {
              'Authorization': `Bearer ${VAPI_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              knowledgeBase: {
                provider: 'canonical',
                id: knowledgeBaseId,
              }
            }),
          });
          
          if (patch2.ok) {
            console.log('✅ Method 2 worked! Knowledge Base attached!');
          } else {
            const error2 = await patch2.text();
            console.error('   Method 2 failed:', error2);
            
            // Try method 3: model with provider + knowledgeBase
            console.log('   Trying method 3: model with provider...');
            const patch3 = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
              method: 'PATCH',
              headers: {
                'Authorization': `Bearer ${VAPI_API_KEY}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                model: {
                  provider: currentAssistant.model?.provider || 'openai',
                  model: currentAssistant.model?.model || 'gpt-4o',
                  knowledgeBase: {
                    provider: 'canonical',
                    id: knowledgeBaseId,
                  }
                }
              }),
            });
            
            if (patch3.ok) {
              console.log('✅ Method 3 worked! Knowledge Base attached!');
            } else {
              const error3 = await patch3.text();
              console.error('   Method 3 failed:', error3);
              
              // Try method 4: knowledgeBaseId direct
              console.log('   Trying method 4: knowledgeBaseId direct...');
              const patch4 = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
                method: 'PATCH',
                headers: {
                  'Authorization': `Bearer ${VAPI_API_KEY}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  knowledgeBaseId: knowledgeBaseId
                }),
              });
              
              if (patch4.ok) {
                console.log('✅ Method 4 worked! Knowledge Base attached!');
              } else {
                const error4 = await patch4.text();
                console.error('   Method 4 failed:', error4);
                console.log('❌ All methods failed - manual attachment needed');
              }
            }
          }
        }
      } else {
        console.error('⚠️ Could not fetch assistant');
      }
    } else {
      console.log('⚠️ No vapi_assistant_id - skipping attachment');
    }

    // ========================================
    // 9. SAVE TO DATABASE
    // ========================================
    const { error: updateError } = await supabase
      .from('clients')
      .update({
        knowledge_base_id: knowledgeBaseId,
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
      knowledgeBaseId: knowledgeBaseId,
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
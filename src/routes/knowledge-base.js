// ============================================================================
// KNOWLEDGE BASE ROUTES - VoiceAI Connect Multi-Tenant Backend
// Location: src/routes/knowledge-base.js
// 
// FIXED:
// 1. Proper merge logic - only overwrites fields if new value is non-empty
// 2. Deletes old files before uploading new one (no duplicates)
// 3. Properly attaches file to VAPI assistant
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

  if (data.websiteContent && data.websiteContent.trim()) {
    sections.push(``);
    sections.push(`## Website Content`);
    sections.push(data.websiteContent.substring(0, 8000));
  }

  return sections.join('\n');
}

// ============================================================================
// DELETE OLD FILES FOR THIS CLIENT
// ============================================================================
async function deleteOldFiles(businessName, currentFileId = null) {
  try {
    const listResponse = await fetch('https://api.vapi.ai/file', {
      headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
    });
    
    if (!listResponse.ok) return;
    
    const files = await listResponse.json();
    const sanitizedName = businessName.replace(/[^a-zA-Z0-9]/g, '_');
    
    // Find old files for this business (exclude current if provided)
    const oldFiles = files.filter(f => 
      f.name && 
      f.name.includes(sanitizedName) && 
      f.name.includes('_knowledge') &&
      f.id !== currentFileId
    );
    
    console.log(`🗑️ Found ${oldFiles.length} old files to delete`);
    
    for (const file of oldFiles) {
      try {
        await fetch(`https://api.vapi.ai/file/${file.id}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
        });
        console.log(`   Deleted: ${file.name} (${file.id})`);
      } catch (e) {
        console.log(`   ⚠️ Could not delete ${file.id}`);
      }
    }
  } catch (error) {
    console.log('⚠️ Could not cleanup old files:', error.message);
  }
}

// ============================================================================
// SMART MERGE - Only update fields that have new non-empty values
// ============================================================================
function smartMerge(existingData, newData) {
  const result = { ...existingData };
  
  // For each field, only overwrite if new value is non-empty
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

    // Smart merge - only overwrites if new value is non-empty
    const finalData = smartMerge(existingData, newData);
    console.log('📦 Final data keys:', Object.keys(finalData).filter(k => finalData[k] && finalData[k].trim()));

    // ========================================
    // 3. WEBSITE SCRAPING (if URL changed)
    // ========================================
    let websiteContent = existingData.websiteContent || '';
    const newWebsiteUrl = websiteUrl || client.business_website;
    
    if (websiteUrl && websiteUrl.trim() && websiteUrl !== client.business_website) {
      try {
        console.log('🌐 Scraping website:', websiteUrl);
        const scrapeResponse = await fetch(`https://r.jina.ai/${websiteUrl}`, {
          headers: { 'Accept': 'text/plain' },
          timeout: 10000
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
    // 5. DELETE OLD FILES (prevent duplicates)
    // ========================================
    await deleteOldFiles(client.business_name);

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
      console.error('❌ VAPI upload failed:', errorText);
      throw new Error(`VAPI upload failed: ${uploadResponse.status}`);
    }

    const uploadData = await uploadResponse.json();
    const fileId = uploadData.id;
    console.log('✅ File uploaded:', fileId);

    // ========================================
    // 7. ATTACH FILE TO ASSISTANT
    // ========================================
    if (client.vapi_assistant_id) {
      console.log('🔗 Attaching file to assistant...');
      
      // Get current assistant
      const getResponse = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
        headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
      });
      
      if (getResponse.ok) {
        const currentAssistant = await getResponse.json();
        
        // Build the update payload - attach file via model.knowledgeBase
        const updatePayload = {
          model: {
            ...currentAssistant.model,
            knowledgeBase: {
              provider: 'canonical',
              fileIds: [fileId]
            }
          }
        };

        console.log('   Updating assistant with knowledgeBase.fileIds:', [fileId]);
        
        const patchResponse = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${VAPI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(updatePayload),
        });
        
        if (patchResponse.ok) {
          console.log('✅ File attached to assistant successfully');
        } else {
          const errorText = await patchResponse.text();
          console.error('⚠️ Failed to attach file:', errorText);
          
          // Try alternative: direct knowledgeBase on assistant root
          console.log('🔄 Trying alternative method...');
          const altResponse = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
            method: 'PATCH',
            headers: {
              'Authorization': `Bearer ${VAPI_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              knowledgeBase: {
                provider: 'canonical', 
                fileIds: [fileId]
              }
            }),
          });
          
          if (altResponse.ok) {
            console.log('✅ File attached via alternative method');
          } else {
            const altError = await altResponse.text();
            console.error('⚠️ Alternative method failed:', altError);
          }
        }
      } else {
        console.error('⚠️ Could not fetch assistant');
      }
    } else {
      console.log('⚠️ No vapi_assistant_id - skipping file attachment');
    }

    // ========================================
    // 8. SAVE TO DATABASE
    // ========================================
    const { error: updateError } = await supabase
      .from('clients')
      .update({
        knowledge_base_id: fileId,
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
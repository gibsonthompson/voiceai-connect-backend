// ============================================================================
// KNOWLEDGE BASE ROUTES - VoiceAI Connect Multi-Tenant Backend
// Location: src/routes/knowledge-base.js
// 
// BULLETPROOF APPROACH: Embeds business info directly in system prompt
// No VAPI KB, no files, no tools - just reliable prompt updates
// ============================================================================

const fetch = require('node-fetch');
const { supabase } = require('../lib/supabase');

const VAPI_API_KEY = process.env.VAPI_API_KEY;

// ============================================================================
// FORMAT BUSINESS INFO FOR SYSTEM PROMPT
// ============================================================================
function formatBusinessInfo(data) {
  const sections = [];

  sections.push(`## BUSINESS INFORMATION`);
  sections.push(`Business Name: ${data.businessName}`);
  
  if (data.industry) {
    sections.push(`Industry: ${data.industry}`);
  }
  
  if (data.city || data.state) {
    sections.push(`Location: ${[data.city, data.state].filter(Boolean).join(', ')}`);
  }
  
  if (data.phoneNumber) {
    sections.push(`Phone: ${data.phoneNumber}`);
  }

  if (data.websiteUrl) {
    sections.push(`Website: ${data.websiteUrl}`);
  }

  if (data.businessHours && data.businessHours.trim()) {
    sections.push(``);
    sections.push(`### Business Hours`);
    sections.push(data.businessHours);
  }

  if (data.services && data.services.trim()) {
    sections.push(``);
    sections.push(`### Services & Pricing`);
    sections.push(data.services);
  }

  if (data.faqs && data.faqs.trim()) {
    sections.push(``);
    sections.push(`### Frequently Asked Questions`);
    sections.push(data.faqs);
  }

  if (data.additionalInfo && data.additionalInfo.trim()) {
    sections.push(``);
    sections.push(`### Additional Information`);
    sections.push(data.additionalInfo);
  }

  return sections.join('\n');
}

// ============================================================================
// BUILD COMPLETE SYSTEM PROMPT
// ============================================================================
function buildSystemPrompt(businessName, businessInfo) {
  return `You are the phone assistant for ${businessName}.

## YOUR ROLE
Listen to customers' needs, answer their questions using the business information below, collect their information when needed, and let them know when someone will contact them. Be warm, empathetic, and efficient.

${businessInfo}

## HOW TO USE BUSINESS INFORMATION
- When customers ask about hours, services, pricing, or policies, use the BUSINESS INFORMATION section above
- Answer confidently based on this information
- If something isn't covered above, politely say "I don't have that specific information, but our team can help you with that when they call back"

## CONVERSATION FLOW
1. Let them explain their need or question
2. If asking about services/hours/pricing → Answer using business information above
3. If they need service/appointment → Collect their information:
   - Name: "What's your name?" → "Thanks [name]"
   - Phone: "Best number to reach you?" → "Got it"
   - Address (if needed): "What's the address?" → "Perfect"
   - Issue/Need: "What can we help you with?" → Listen and acknowledge
4. Let them know next steps: "Our team will call you back shortly"
5. Ask: "Is there anything else I can help you with?"

## COMMUNICATION STYLE
- Natural and conversational, not robotic
- Use brief acknowledgments ("Got it", "Perfect", "Great question")
- Be warm and helpful
- Sound like a knowledgeable human assistant

## CRITICAL RULE
You do NOT have the ability to end calls. The customer will hang up when they're ready.`;
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
  
  return result;
}

// ============================================================================
// UPDATE KNOWLEDGE BASE - Main handler
// ============================================================================
async function updateKnowledgeBase(req, res) {
  try {
    console.log('');
    console.log('📚 ====== KNOWLEDGE BASE UPDATE (Prompt Embedding) ======');
    
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
    // 3. FORMAT BUSINESS INFO
    // ========================================
    const businessInfo = formatBusinessInfo({
      businessName: client.business_name,
      industry: client.industry,
      city: client.business_city,
      state: client.business_state,
      phoneNumber: client.vapi_phone_number,
      websiteUrl: websiteUrl || client.business_website,
      businessHours: finalData.businessHours || '',
      services: finalData.services || '',
      faqs: finalData.faqs || '',
      additionalInfo: finalData.additionalInfo || '',
    });

    console.log('📄 Business info length:', businessInfo.length, 'chars');

    // ========================================
    // 4. BUILD NEW SYSTEM PROMPT
    // ========================================
    const newSystemPrompt = buildSystemPrompt(client.business_name, businessInfo);
    console.log('📝 System prompt length:', newSystemPrompt.length, 'chars');

    // ========================================
    // 5. UPDATE VAPI ASSISTANT
    // ========================================
    if (client.vapi_assistant_id) {
      console.log('🔗 Updating VAPI assistant system prompt...');
      
      // Get current assistant to preserve other settings
      const getResponse = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
        headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
      });
      
      if (getResponse.ok) {
        const currentAssistant = await getResponse.json();
        console.log('   Current model:', currentAssistant.model?.model);
        
        // Update the system prompt while preserving everything else
        const patchResponse = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${VAPI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: {
              ...currentAssistant.model,
              messages: [
                {
                  role: 'system',
                  content: newSystemPrompt
                }
              ]
            }
          }),
        });
        
        if (patchResponse.ok) {
          console.log('✅ VAPI assistant updated successfully!');
        } else {
          const errorText = await patchResponse.text();
          console.error('⚠️ Failed to update assistant:', errorText);
          // Don't fail the whole request - still save to DB
        }
      } else {
        console.error('⚠️ Could not fetch current assistant');
      }
    } else {
      console.log('⚠️ No vapi_assistant_id - skipping VAPI update');
    }

    // ========================================
    // 6. SAVE TO DATABASE
    // ========================================
    const { error: updateError } = await supabase
      .from('clients')
      .update({
        knowledge_base_data: finalData,
        knowledge_base_updated_at: new Date().toISOString(),
        business_website: websiteUrl || client.business_website,
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
    });

  } catch (error) {
    console.error('❌ Knowledge base update error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to update knowledge base',
    });
  }
}

module.exports = { updateKnowledgeBase, formatBusinessInfo, buildSystemPrompt, smartMerge };
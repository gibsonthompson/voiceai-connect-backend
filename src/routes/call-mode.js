// ============================================================================
// CALL MODE ROUTES - Primary vs Fallback AI Receptionist
// Mount as: app.use('/api/client', require('./routes/call-mode'));
//
// PRIMARY MODE:  AI answers every call immediately (default)
// FALLBACK MODE: AI says "connecting you", transfers to owner's phone.
//                If owner doesn't pick up, AI takes back over seamlessly.
//
// FIX: Uses firstMessageMode='assistant-speaks-first-with-model-generated-message'
//      so the model can invoke transferCall on its first turn (static firstMessage
//      causes a deadlock where both sides wait for each other to speak).
// FIX: Uses transferPlan with warm-transfer-experimental + fallbackPlan so the
//      call returns to the AI if the owner doesn't answer (instead of dropping).
// ============================================================================
var express = require('express');
var router = express.Router();
var fetch = require('node-fetch');
var { supabase } = require('../lib/supabase');

var VAPI_API_KEY = process.env.VAPI_API_KEY;

// Fallback instructions that get prepended to the system prompt
var FALLBACK_MARKER = '## CALL ROUTING - FALLBACK MODE';
var FALLBACK_INSTRUCTIONS = FALLBACK_MARKER + '\n' +
  'CRITICAL: This call should be connected to the business owner first.\n' +
  'Your FIRST message must be EXACTLY: "One moment while I connect you."\n' +
  'Immediately after speaking, use the transferCall tool to transfer the call.\n' +
  'Do NOT ask any questions. Do NOT introduce yourself. Do NOT say anything else first.\n' +
  'Just say the connection message and transfer.\n\n' +
  'If the transfer fails or the owner does not answer, you will hear a fallback message.\n' +
  'After that, switch to your normal receptionist role and say:\n' +
  '"Sorry about that — I wasn\'t able to reach anyone directly, but I\'d be happy to help you myself. How can I assist you today?"\n' +
  'Then proceed with your normal receptionist duties as described below.\n\n';

// ============================================================================
// GET /api/client/:id/call-mode - Get current call mode
// ============================================================================
router.get('/:id/call-mode', async function(req, res) {
  try {
    var id = req.params.id;

    var result = await supabase
      .from('clients')
      .select('call_mode, ring_timeout, owner_phone')
      .eq('id', id)
      .single();

    if (result.error || !result.data) {
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    res.json({
      success: true,
      call_mode: result.data.call_mode || 'primary',
      ring_timeout: result.data.ring_timeout || 20,
      owner_phone: result.data.owner_phone || null
    });
  } catch (error) {
    console.error('Error fetching call mode:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================================
// PUT /api/client/:id/call-mode - Update call mode + sync VAPI assistant
// ============================================================================
router.put('/:id/call-mode', async function(req, res) {
  try {
    var id = req.params.id;
    var callMode = req.body.call_mode;
    var ringTimeout = req.body.ring_timeout;

    // Validate
    if (!callMode || (callMode !== 'primary' && callMode !== 'fallback')) {
      return res.status(400).json({ success: false, error: 'call_mode must be "primary" or "fallback"' });
    }

    if (ringTimeout !== undefined) {
      ringTimeout = parseInt(ringTimeout);
      if (isNaN(ringTimeout) || ringTimeout < 10 || ringTimeout > 45) {
        return res.status(400).json({ success: false, error: 'ring_timeout must be between 10 and 45 seconds' });
      }
    }

    // Get client data
    var clientResult = await supabase
      .from('clients')
      .select('vapi_assistant_id, owner_phone, greeting_message, business_name, call_mode')
      .eq('id', id)
      .single();

    if (clientResult.error || !clientResult.data) {
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    var client = clientResult.data;

    // Fallback mode requires owner phone
    if (callMode === 'fallback' && !client.owner_phone) {
      return res.status(400).json({
        success: false,
        error: 'Fallback mode requires an owner phone number. Please add one in Contact Information first.'
      });
    }

    // Save to database
    var updates = { call_mode: callMode };
    if (ringTimeout !== undefined) updates.ring_timeout = ringTimeout;

    var updateResult = await supabase
      .from('clients')
      .update(updates)
      .eq('id', id);

    if (updateResult.error) {
      return res.status(400).json({ success: false, error: updateResult.error.message });
    }

    // Update VAPI assistant
    if (client.vapi_assistant_id) {
      var vapiUpdated = await updateAssistantCallMode(
        client.vapi_assistant_id,
        callMode,
        client.owner_phone,
        client.greeting_message,
        client.business_name,
        ringTimeout || 20
      );

      if (!vapiUpdated) {
        console.warn('⚠️ Call mode saved to DB but VAPI update failed');
      }
    }

    console.log('✅ Call mode updated for client ' + id + ': ' + callMode);
    res.json({ success: true, call_mode: callMode, ring_timeout: ringTimeout || 20 });
  } catch (error) {
    console.error('Error updating call mode:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================================
// Update VAPI assistant based on call mode
// ============================================================================
async function updateAssistantCallMode(assistantId, callMode, ownerPhone, greetingMessage, businessName, ringTimeout) {
  try {
    // Fetch current assistant config
    var getResponse = await fetch('https://api.vapi.ai/assistant/' + assistantId, {
      headers: { 'Authorization': 'Bearer ' + VAPI_API_KEY }
    });

    if (!getResponse.ok) {
      console.error('Failed to get assistant:', await getResponse.text());
      return false;
    }

    var assistant = await getResponse.json();
    var systemPrompt = assistant.model?.messages?.[0]?.content || '';
    var existingInlineTools = assistant.model?.tools || [];
    var existingToolIds = assistant.model?.toolIds || [];

    // ---- Strip existing fallback instructions from system prompt ----
    var fallbackIdx = systemPrompt.indexOf(FALLBACK_MARKER);
    if (fallbackIdx >= 0) {
      // Find where fallback section ends (next ## heading or original content)
      var afterFallback = systemPrompt.indexOf('\n## ', fallbackIdx + FALLBACK_MARKER.length);
      if (afterFallback === -1) {
        systemPrompt = systemPrompt.substring(0, fallbackIdx).trimEnd();
      } else {
        systemPrompt = systemPrompt.substring(0, fallbackIdx) + systemPrompt.substring(afterFallback + 1);
      }
    }
    // Clean up any leading whitespace left behind
    systemPrompt = systemPrompt.replace(/^\n+/, '');

    // ---- Build VAPI PATCH payload ----
    var updatePayload = {};

    if (callMode === 'fallback') {
      // == FALLBACK MODE ==
      // 1. Prepend fallback instructions to system prompt
      systemPrompt = FALLBACK_INSTRUCTIONS + systemPrompt;

      // 2. Use model-generated first message so the model can invoke transferCall
      //    on its very first turn (static firstMessage causes a deadlock).
      updatePayload.firstMessage = null;
      updatePayload.firstMessageMode = 'assistant-speaks-first-with-model-generated-message';

      // 3. Ensure transferCall tool exists with owner phone + warm transfer fallback
      var formattedPhone = formatPhoneE164(ownerPhone);
      if (formattedPhone) {
        // Remove any existing transferCall tools (we'll add the correct one)
        existingInlineTools = existingInlineTools.filter(function(t) {
          return t.type !== 'transferCall';
        });

        // Add transferCall with warm-transfer-experimental + fallbackPlan
        // so the AI picks back up if the owner doesn't answer.
        existingInlineTools.push({
          type: 'transferCall',
          destinations: [{
            type: 'number',
            number: formattedPhone,
            description: 'Transfer to business owner. Use this immediately when the call starts.',
            message: ''  // Silent — AI already said the connection message
          }],
          transferPlan: {
            mode: 'warm-transfer-experimental',
            fallbackPlan: {
              // This plays to the caller if the owner doesn't pick up,
              // then endCallAfterSpokenEnabled: false means the AI takes back over.
              message: 'It looks like no one is available to take your call right now. Let me help you instead.',
              endCallAfterSpokenEnabled: false
            },
            // Voicemail detection so we don't connect to the owner's voicemail
            voicemailDetectionType: 'audio'
          }
        });

        console.log('📞 Configured transferCall with warm-transfer fallback for: ' + formattedPhone);
      }
    } else {
      // == PRIMARY MODE ==
      // 1. Restore original static greeting
      var defaultGreeting = 'Hi, you\'ve reached ' + (businessName || 'our office') + '. This call may be recorded. How can I help you today?';
      updatePayload.firstMessage = greetingMessage || defaultGreeting;
      updatePayload.firstMessageMode = 'assistant-speaks-first';

      // 2. Restore a normal transferCall tool (owner can still request transfers)
      var formattedPhonePrimary = formatPhoneE164(ownerPhone);
      if (formattedPhonePrimary) {
        existingInlineTools = existingInlineTools.filter(function(t) {
          return t.type !== 'transferCall';
        });

        existingInlineTools.push({
          type: 'transferCall',
          destinations: [{
            type: 'number',
            number: formattedPhonePrimary,
            description: 'Transfer to business owner for urgent matters, complex issues, or when caller requests to speak with a person.',
            message: 'One moment, let me connect you.'
          }]
          // No transferPlan needed for on-demand transfers in primary mode
        });
      }
    }

    // Build model payload preserving existing config
    updatePayload.model = {
      provider: assistant.model?.provider || 'openai',
      model: assistant.model?.model || 'gpt-4o-mini',
      temperature: assistant.model?.temperature,
      toolIds: existingToolIds,
      tools: existingInlineTools,
      messages: [{ role: 'system', content: systemPrompt }]
    };

    // Send PATCH to VAPI
    var updateResponse = await fetch('https://api.vapi.ai/assistant/' + assistantId, {
      method: 'PATCH',
      headers: {
        'Authorization': 'Bearer ' + VAPI_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(updatePayload)
    });

    if (!updateResponse.ok) {
      var errText = await updateResponse.text();
      console.error('Failed to update assistant call mode:', errText);
      return false;
    }

    console.log('✅ VAPI assistant updated for ' + callMode + ' mode');
    return true;
  } catch (error) {
    console.error('❌ Error updating assistant call mode:', error);
    return false;
  }
}

function formatPhoneE164(phone) {
  if (!phone) return null;
  var digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.charAt(0) === '1') return '+' + digits;
  return null;
}

module.exports = router;
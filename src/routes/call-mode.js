// ============================================================================
// CALL MODE ROUTES - Primary vs Fallback AI Receptionist
// Mount as: app.use('/api/client', require('./routes/call-mode'));
// ============================================================================
var express = require('express');
var router = express.Router();
var fetch = require('node-fetch');
var { supabase } = require('../lib/supabase');

var VAPI_API_KEY = process.env.VAPI_API_KEY;

// Fallback instructions that get prepended to the system prompt
var FALLBACK_MARKER = '## CALL ROUTING - FALLBACK MODE';
var FALLBACK_INSTRUCTIONS = FALLBACK_MARKER + '\n' +
  'CRITICAL: Before doing ANYTHING else, you MUST transfer this call to the business owner.\n' +
  'Say ONLY: "One moment while I connect you."\n' +
  'Then IMMEDIATELY use the transferCall tool.\n' +
  'Do NOT ask any questions first. Do NOT introduce yourself. Just transfer.\n' +
  'If the transfer fails or is not answered, THEN say:\n' +
  '"I wasn\'t able to reach anyone directly, but I\'d be happy to help you."\n' +
  'After that, proceed with your normal receptionist duties as described below.\n\n';

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
        client.business_name
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
// Update VAPI assistant system prompt based on call mode
// ============================================================================
async function updateAssistantCallMode(assistantId, callMode, ownerPhone, greetingMessage, businessName) {
  try {
    // Fetch current assistant
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

    // Remove any existing fallback instructions
    var fallbackIdx = systemPrompt.indexOf(FALLBACK_MARKER);
    if (fallbackIdx >= 0) {
      // Find where fallback section ends (next ## or the original content)
      var afterFallback = systemPrompt.indexOf('\n## ', fallbackIdx + FALLBACK_MARKER.length);
      if (afterFallback === -1) {
        // Fallback was at the end — just remove it
        systemPrompt = systemPrompt.substring(0, fallbackIdx).trimEnd();
      } else {
        systemPrompt = systemPrompt.substring(0, fallbackIdx) + systemPrompt.substring(afterFallback + 1);
      }
    }

    // Build update payload
    var updatePayload = {};

    if (callMode === 'fallback') {
      // Prepend fallback instructions
      systemPrompt = FALLBACK_INSTRUCTIONS + systemPrompt;

      // Ensure transferCall tool exists with owner phone
      var hasTransfer = existingInlineTools.some(function(t) {
        return t.type === 'transferCall';
      });

      if (!hasTransfer && ownerPhone) {
        var formattedPhone = formatPhoneE164(ownerPhone);
        if (formattedPhone) {
          existingInlineTools.push({
            type: 'transferCall',
            destinations: [{
              type: 'number',
              number: formattedPhone,
              description: 'Transfer to business owner',
              message: 'One moment, let me connect you.'
            }]
          });
          console.log('📞 Added transferCall tool for fallback mode');
        }
      }

      // Change first message to just transfer
      updatePayload.firstMessage = 'One moment while I connect you.';
    } else {
      // Primary mode — restore original greeting
      var defaultGreeting = 'Hi, you\'ve reached ' + (businessName || 'our office') + '. This call may be recorded. How can I help you today?';
      updatePayload.firstMessage = greetingMessage || defaultGreeting;
    }

    updatePayload.model = {
      provider: assistant.model?.provider || 'openai',
      model: assistant.model?.model || 'gpt-4o-mini',
      temperature: assistant.model?.temperature,
      toolIds: existingToolIds,
      tools: existingInlineTools,
      messages: [{ role: 'system', content: systemPrompt }]
    };

    var updateResponse = await fetch('https://api.vapi.ai/assistant/' + assistantId, {
      method: 'PATCH',
      headers: {
        'Authorization': 'Bearer ' + VAPI_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(updatePayload)
    });

    if (!updateResponse.ok) {
      console.error('Failed to update assistant call mode:', await updateResponse.text());
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
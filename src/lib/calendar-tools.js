const fetch = require('node-fetch');

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const BACKEND_URL = process.env.BACKEND_URL || 'https://urchin-app-bqb4i.ondigitalocean.app';

async function updateAssistantCalendar(assistantId, clientId, enabled) {
  try {
    console.log('📅 ' + (enabled ? 'Enabling' : 'Disabling') + ' calendar for assistant: ' + assistantId);
    
    var getResponse = await fetch('https://api.vapi.ai/assistant/' + assistantId, {
      headers: {
        'Authorization': 'Bearer ' + VAPI_API_KEY
      }
    });

    if (!getResponse.ok) {
      throw new Error('Failed to get assistant: ' + (await getResponse.text()));
    }

    var assistant = await getResponse.json();
    
    var existingToolIds = assistant.model?.toolIds || [];
    var existingInlineTools = assistant.model?.tools || [];
    console.log('📋 Existing toolIds: ' + existingToolIds.length + ', inline tools: ' + existingInlineTools.length);
    
    if (enabled) {
      var toolsListRes = await fetch('https://api.vapi.ai/tool', {
        headers: { 'Authorization': 'Bearer ' + VAPI_API_KEY }
      });
      var allTools = await toolsListRes.json();
      
      var existingAvailabilityTool = allTools.find(function(t) {
        return t.function?.name === 'check_availability' && t.server?.url?.includes(clientId);
      });
      var existingBookingTool = allTools.find(function(t) {
        return t.function?.name === 'book_appointment' && t.server?.url?.includes(clientId);
      });
      
      var availabilityToolId, bookingToolId;
      
      if (existingAvailabilityTool) {
        console.log('📋 Using existing check_availability tool: ' + existingAvailabilityTool.id);
        availabilityToolId = existingAvailabilityTool.id;
      } else {
        console.log('🔧 Creating check_availability tool...');
        var availabilityToolRes = await fetch('https://api.vapi.ai/tool', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + VAPI_API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            type: 'function',
            function: {
              name: 'check_availability',
              description: 'Check available appointment times for a specific date. Use this when a customer wants to book an appointment.',
              parameters: {
                type: 'object',
                properties: {
                  date: { 
                    type: 'string', 
                    description: 'Date to check in YYYY-MM-DD format (e.g., 2026-01-15)' 
                  }
                },
                required: ['date']
              }
            },
            server: { 
              url: BACKEND_URL + '/api/calendar/availability/' + clientId
            }
          })
        });

        if (!availabilityToolRes.ok) {
          throw new Error('Failed to create availability tool: ' + (await availabilityToolRes.text()));
        }
        var availabilityTool = await availabilityToolRes.json();
        availabilityToolId = availabilityTool.id;
        console.log('✅ check_availability tool created: ' + availabilityToolId);
      }

      if (existingBookingTool) {
        console.log('📋 Using existing book_appointment tool: ' + existingBookingTool.id);
        bookingToolId = existingBookingTool.id;
      } else {
        console.log('🔧 Creating book_appointment tool...');
        var bookingToolRes = await fetch('https://api.vapi.ai/tool', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + VAPI_API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            type: 'function',
            function: {
              name: 'book_appointment',
              description: 'Book an appointment after confirming availability and collecting customer details.',
              parameters: {
                type: 'object',
                properties: {
                  customer_name: { type: 'string', description: 'Full name of the customer' },
                  customer_phone: { type: 'string', description: 'Customer phone number' },
                  date: { type: 'string', description: 'Appointment date in YYYY-MM-DD format' },
                  time: { type: 'string', description: 'Appointment time (e.g., 2:00 PM)' },
                  service_type: { type: 'string', description: 'Type of service or reason for appointment' },
                  notes: { type: 'string', description: 'Any special requests or notes' }
                },
                required: ['customer_name', 'customer_phone', 'date', 'time']
              }
            },
            server: { 
              url: BACKEND_URL + '/api/calendar/book/' + clientId
            }
          })
        });

        if (!bookingToolRes.ok) {
          throw new Error('Failed to create booking tool: ' + (await bookingToolRes.text()));
        }
        var bookingTool = await bookingToolRes.json();
        bookingToolId = bookingTool.id;
        console.log('✅ book_appointment tool created: ' + bookingToolId);
      }

      var calendarToolIds = [availabilityToolId, bookingToolId];
      var filteredToolIds = existingToolIds.filter(function(id) {
        return !allTools.some(function(t) {
          return t.id === id && (t.function?.name === 'check_availability' || t.function?.name === 'book_appointment');
        });
      });
      var newToolIds = Array.from(new Set(filteredToolIds.concat(calendarToolIds)));
      
      console.log('📋 Final toolIds: ' + newToolIds.length);
      
      var systemPrompt = assistant.model?.messages?.[0]?.content || '';
      var calendarInstructions = '\n\n## APPOINTMENT BOOKING\nYou can book appointments directly to the business calendar.\n\nCRITICAL DATE RULES:\n- You do NOT know today\'s date. Do NOT guess or say any date to the caller until AFTER you receive the tool response.\n- When a caller asks to book, say "Let me check that for you" — do NOT repeat back any date.\n- The check_availability tool response will tell you the EXACT correct date. ONLY use that date when speaking to the caller.\n- NEVER say a date like "October", "November", or any date from your own memory. ONLY say the date that appears in the tool response.\n\nBooking flow:\n1. Caller wants to book — ask for their preferred date\n2. Call check_availability with whatever date info you have\n3. Read the tool response — it contains the CORRECT date and available times\n4. Tell the caller the date and times FROM THE TOOL RESPONSE ONLY\n5. Collect: name, phone number, service type\n6. Use book_appointment to confirm\n7. Read the booking confirmation from the tool response and repeat it to the caller\n\nIf no slots are available, offer alternative dates or take their info for a callback.';

      if (!systemPrompt.includes('APPOINTMENT BOOKING')) {
        systemPrompt += calendarInstructions;
      } else {
        // Replace old calendar instructions with new ones
        var startIdx = systemPrompt.indexOf('## APPOINTMENT BOOKING');
        if (startIdx > 0) {
          // Find a reasonable end point - look for next ## or end of string
          var beforeCalendar = systemPrompt.substring(0, startIdx).trimEnd();
          systemPrompt = beforeCalendar + calendarInstructions;
        }
      }

      var updatePayload = {
        model: {
          provider: assistant.model?.provider || 'openai',
          model: assistant.model?.model || 'gpt-4o-mini',
          temperature: assistant.model?.temperature,
          toolIds: newToolIds,
          tools: existingInlineTools,
          messages: [{ role: 'system', content: systemPrompt }]
        }
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
        throw new Error('Failed to update assistant: ' + (await updateResponse.text()));
      }

      console.log('✅ Calendar enabled for assistant: ' + assistantId);
      console.log('   Tools: ' + availabilityToolId + ', ' + bookingToolId);
      return { success: true, toolIds: [availabilityToolId, bookingToolId] };

    } else {
      var systemPrompt2 = assistant.model?.messages?.[0]?.content || '';
      
      // Remove calendar instructions
      var startIdx2 = systemPrompt2.indexOf('## APPOINTMENT BOOKING');
      if (startIdx2 > 0) {
        systemPrompt2 = systemPrompt2.substring(0, startIdx2).trimEnd();
      }

      var updateResponse2 = await fetch('https://api.vapi.ai/assistant/' + assistantId, {
        method: 'PATCH',
        headers: {
          'Authorization': 'Bearer ' + VAPI_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: {
            provider: assistant.model?.provider || 'openai',
            model: assistant.model?.model || 'gpt-4o-mini',
            tools: existingInlineTools,
            messages: [{ role: 'system', content: systemPrompt2 }]
          }
        })
      });

      if (!updateResponse2.ok) {
        throw new Error('Failed to update assistant: ' + (await updateResponse2.text()));
      }

      console.log('✅ Calendar disabled for assistant: ' + assistantId);
      return { success: true };
    }
  } catch (error) {
    console.error('❌ Error updating assistant calendar:', error);
    return { success: false, error: error.message };
  }
}

module.exports = { updateAssistantCalendar };
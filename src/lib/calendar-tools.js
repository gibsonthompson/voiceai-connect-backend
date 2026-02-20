// ============================================================================
// CALENDAR TOOLS - VAPI Assistant Integration
// Creates/removes Google Calendar tools from VAPI assistants dynamically
// Called when a client connects or disconnects Google Calendar
// Ported from CallBird, adapted for VoiceAI Connect multi-tenant
// ============================================================================
const fetch = require('node-fetch');

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const BACKEND_URL = process.env.BACKEND_URL || 'https://urchin-app-bqb4i.ondigitalocean.app';

// Calendar instructions appended to system prompt when enabled
const CALENDAR_INSTRUCTIONS = `

## APPOINTMENT BOOKING
You can book appointments directly to the business calendar.
1. When a customer wants to book, ask for their preferred date
2. Use check_availability to see available times for that date
3. Suggest a few good times rather than listing all available slots
4. Collect: name, phone number, service type
5. Use book_appointment to confirm the booking
6. Confirm the details back to them

If no slots are available, offer alternative dates or take their info for a callback.`;

// ============================================================================
// UPDATE ASSISTANT WITH CALENDAR TOOLS
// enabled=true: Creates tools in VAPI, attaches to assistant, adds prompt
// enabled=false: Removes tools from assistant, removes prompt
// ============================================================================
async function updateAssistantCalendar(assistantId, clientId, enabled) {
  try {
    console.log(`📅 ${enabled ? 'Enabling' : 'Disabling'} calendar for assistant: ${assistantId}`);
    
    // Get current assistant config from VAPI
    const getResponse = await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
      headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
    });

    if (!getResponse.ok) {
      throw new Error(`Failed to get assistant: ${await getResponse.text()}`);
    }

    const assistant = await getResponse.json();
    
    // Preserve existing toolIds and inline tools (like transferCall)
    let existingToolIds = assistant.model?.toolIds || [];
    const existingInlineTools = assistant.model?.tools || [];
    console.log(`📋 Existing toolIds: ${existingToolIds.length}, inline tools: ${existingInlineTools.length}`);
    
    if (enabled) {
      // ================================================================
      // ENABLING — Create tools, attach to assistant, add prompt
      // ================================================================
      
      // Check if calendar tools already exist for this client (avoid duplicates)
      const toolsListRes = await fetch('https://api.vapi.ai/tool', {
        headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
      });
      const allTools = await toolsListRes.json();
      
      const existingAvailabilityTool = allTools.find(t => 
        t.function?.name === 'check_availability' && 
        t.server?.url?.includes(clientId)
      );
      const existingBookingTool = allTools.find(t => 
        t.function?.name === 'book_appointment' && 
        t.server?.url?.includes(clientId)
      );
      
      let availabilityToolId, bookingToolId;
      
      // Create or reuse check_availability tool
      if (existingAvailabilityTool) {
        console.log(`📋 Reusing existing check_availability tool: ${existingAvailabilityTool.id}`);
        availabilityToolId = existingAvailabilityTool.id;
      } else {
        console.log('🔧 Creating check_availability tool...');
        const availabilityToolRes = await fetch('https://api.vapi.ai/tool', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${VAPI_API_KEY}`,
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
                    description: 'Date to check in YYYY-MM-DD format (e.g., 2026-02-20)' 
                  }
                },
                required: ['date']
              }
            },
            server: { 
              url: `${BACKEND_URL}/api/calendar/availability/${clientId}` 
            }
          })
        });

        if (!availabilityToolRes.ok) {
          throw new Error(`Failed to create availability tool: ${await availabilityToolRes.text()}`);
        }
        const availabilityTool = await availabilityToolRes.json();
        availabilityToolId = availabilityTool.id;
        console.log(`✅ check_availability tool created: ${availabilityToolId}`);
      }

      // Create or reuse book_appointment tool
      if (existingBookingTool) {
        console.log(`📋 Reusing existing book_appointment tool: ${existingBookingTool.id}`);
        bookingToolId = existingBookingTool.id;
      } else {
        console.log('🔧 Creating book_appointment tool...');
        const bookingToolRes = await fetch('https://api.vapi.ai/tool', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${VAPI_API_KEY}`,
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
              url: `${BACKEND_URL}/api/calendar/book/${clientId}` 
            }
          })
        });

        if (!bookingToolRes.ok) {
          throw new Error(`Failed to create booking tool: ${await bookingToolRes.text()}`);
        }
        const bookingTool = await bookingToolRes.json();
        bookingToolId = bookingTool.id;
        console.log(`✅ book_appointment tool created: ${bookingToolId}`);
      }

      // Build new toolIds — remove old calendar tools, add new ones
      const calendarToolIds = [availabilityToolId, bookingToolId];
      const filteredToolIds = existingToolIds.filter(id => 
        !allTools.some(t => 
          t.id === id && 
          (t.function?.name === 'check_availability' || t.function?.name === 'book_appointment')
        )
      );
      const newToolIds = [...new Set([...filteredToolIds, ...calendarToolIds])];
      
      console.log(`📋 Final toolIds: ${newToolIds.length}`);
      
      // Update system prompt with calendar instructions
      let systemPrompt = assistant.model?.messages?.[0]?.content || '';
      if (!systemPrompt.includes('APPOINTMENT BOOKING')) {
        systemPrompt += CALENDAR_INSTRUCTIONS;
      }

      // PATCH assistant — preserve inline tools (transferCall etc.)
      const updatePayload = {
        model: {
          provider: assistant.model?.provider || 'openai',
          model: assistant.model?.model || 'gpt-4o-mini',
          temperature: assistant.model?.temperature,
          toolIds: newToolIds,
          tools: existingInlineTools,
          messages: [{ role: 'system', content: systemPrompt }]
        }
      };

      const updateResponse = await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${VAPI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(updatePayload)
      });

      if (!updateResponse.ok) {
        throw new Error(`Failed to update assistant: ${await updateResponse.text()}`);
      }

      console.log(`✅ Calendar enabled for assistant: ${assistantId}`);
      console.log(`   Tools: ${availabilityToolId}, ${bookingToolId}`);
      return { success: true, toolIds: [availabilityToolId, bookingToolId] };

    } else {
      // ================================================================
      // DISABLING — Remove calendar instructions, toolIds stay
      // (VAPI tools are reusable, just remove prompt so AI stops using them)
      // ================================================================
      
      let systemPrompt = assistant.model?.messages?.[0]?.content || '';
      systemPrompt = systemPrompt.replace(CALENDAR_INSTRUCTIONS, '');

      const updateResponse = await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${VAPI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: {
            provider: assistant.model?.provider || 'openai',
            model: assistant.model?.model || 'gpt-4o-mini',
            temperature: assistant.model?.temperature,
            tools: existingInlineTools,
            messages: [{ role: 'system', content: systemPrompt }]
          }
        })
      });

      if (!updateResponse.ok) {
        throw new Error(`Failed to update assistant: ${await updateResponse.text()}`);
      }

      console.log(`✅ Calendar disabled for assistant: ${assistantId}`);
      return { success: true };
    }
  } catch (error) {
    console.error('❌ Error updating assistant calendar:', error);
    return { success: false, error: error.message };
  }
}

module.exports = { updateAssistantCalendar };
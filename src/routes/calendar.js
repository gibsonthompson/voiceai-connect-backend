// ============================================================================
// GOOGLE CALENDAR ROUTES - VAPI Tool Endpoints
// Ported from CallBird, adapted for VoiceAI Connect
// These endpoints are called by VAPI during live calls via server.url
// Response format: { results: [{ toolCallId, result: 'message' }] }
// ============================================================================
const express = require('express');
const router = express.Router();
const { getAvailableSlots, bookAppointment } = require('../lib/calendar-booking');

// Returns today's date string for injection into every tool response
function todayContext() {
  const now = new Date();
  const dayName = now.toLocaleDateString('en-US', { weekday: 'long' });
  const monthName = now.toLocaleDateString('en-US', { month: 'long' });
  const day = now.getDate();
  const year = now.getFullYear();
  const iso = now.toISOString().split('T')[0];
  return `[Today is ${dayName}, ${monthName} ${day}, ${year} (${iso})]`;
}

// ============================================================================
// POST /api/calendar/availability/:clientId
// VAPI Tool: Check available appointment times
// ============================================================================
router.post('/availability/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { message } = req.body;
    
    // Extract tool call data from VAPI payload
    const toolCall = message?.toolCallList?.[0] || message?.toolCalls?.[0];
    const toolCallId = toolCall?.id;
    const args = toolCall?.arguments || toolCall?.function?.arguments;
    
    let date;
    if (args) {
      const parsed = typeof args === 'string' ? JSON.parse(args) : args;
      date = parsed.date;
    }
    
    if (!date) {
      return res.json({ 
        results: [{ toolCallId, result: `${todayContext()} What date would you like to check availability for?` }] 
      });
    }

    // Validate date isn't in the past
    const requestedDate = new Date(date + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (requestedDate < today) {
      // Auto-correct: if the date is in the past, assume they meant the next occurrence
      const correctedDate = new Date(date + 'T00:00:00');
      correctedDate.setFullYear(today.getFullYear());
      if (correctedDate < today) {
        correctedDate.setFullYear(today.getFullYear() + 1);
      }
      const correctedStr = correctedDate.toISOString().split('T')[0];
      console.log(`⚠️ Date ${date} is in the past, correcting to ${correctedStr}`);
      date = correctedStr;
    }

    console.log(`📅 Checking availability for client ${clientId} on ${date}`);
    const result = await getAvailableSlots(clientId, date);
    
    if (!result.success) {
      return res.json({ 
        results: [{ toolCallId, result: result.error }] 
      });
    }

    if (result.slots.length === 0) {
      return res.json({ 
        results: [{ toolCallId, result: `${todayContext()} No availability on ${date}. Would you like to try another date?` }] 
      });
    }

    // Suggest a few representative slots (morning, midday, afternoon)
    const slots = result.slots;
    let suggested = [];
    
    if (slots.length <= 4) {
      suggested = slots;
    } else {
      suggested.push(slots[0]); // First available (morning)
      suggested.push(slots[Math.floor(slots.length / 2)]); // Midday
      suggested.push(slots[Math.floor(slots.length * 0.75)]); // Afternoon
      if (slots.length > 10) {
        suggested.push(slots[slots.length - 2]); // Late afternoon
      }
    }

    return res.json({ 
      results: [{ 
        toolCallId,
        result: `${todayContext()} Available on ${date}: ${suggested.join(', ')}. Which works best for you? I also have other times if none of those work.`
      }] 
    });

  } catch (error) {
    console.error('❌ Calendar availability error:', error);
    return res.json({ 
      results: [{ result: 'I\'m having trouble checking the calendar. Let me take your information and have someone call you back to schedule.' }] 
    });
  }
});

// ============================================================================
// POST /api/calendar/book/:clientId
// VAPI Tool: Book an appointment
// ============================================================================
router.post('/book/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { message } = req.body;
    
    // Extract tool call data from VAPI payload
    const toolCall = message?.toolCallList?.[0] || message?.toolCalls?.[0];
    const toolCallId = toolCall?.id;
    const args = toolCall?.arguments || toolCall?.function?.arguments;
    
    if (!args) {
      return res.json({ 
        results: [{ toolCallId, result: `${todayContext()} I need your name, phone number, and preferred date and time to book the appointment.` }] 
      });
    }

    const parsed = typeof args === 'string' ? JSON.parse(args) : args;
    let { customer_name, customer_phone, date, time, service_type, notes } = parsed;

    // Validate required fields
    if (!customer_name || !customer_phone || !date || !time) {
      const missing = [];
      if (!customer_name) missing.push('your name');
      if (!customer_phone) missing.push('your phone number');
      if (!date) missing.push('the date');
      if (!time) missing.push('the time');
      return res.json({ 
        results: [{ toolCallId, result: `${todayContext()} I still need ${missing.join(' and ')} to complete the booking.` }] 
      });
    }

    // Auto-correct past dates
    const requestedDate = new Date(date + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (requestedDate < today) {
      const correctedDate = new Date(date + 'T00:00:00');
      correctedDate.setFullYear(today.getFullYear());
      if (correctedDate < today) {
        correctedDate.setFullYear(today.getFullYear() + 1);
      }
      date = correctedDate.toISOString().split('T')[0];
      console.log(`⚠️ Booking date corrected from ${parsed.date} to ${date}`);
    }

    console.log(`📅 Booking for client ${clientId}: ${customer_name} on ${date} at ${time}`);
    const result = await bookAppointment(clientId, customer_name, customer_phone, date, time, service_type, notes);

    return res.json({ 
      results: [{ toolCallId, result: `${todayContext()} ${result.success ? result.message : result.error}` }] 
    });

  } catch (error) {
    console.error('❌ Calendar booking error:', error);
    return res.json({ 
      results: [{ result: 'I\'m having trouble with the booking system. I have your information and someone will call you back to confirm the appointment.' }] 
    });
  }
});

module.exports = router;
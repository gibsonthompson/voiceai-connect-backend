// ============================================================================
// GOOGLE CALENDAR ROUTES - VAPI Tool Endpoints
// Ported from CallBird, adapted for VoiceAI Connect
// These endpoints are called by VAPI during live calls via server.url
// Response format: { results: [{ toolCallId, result: 'message' }] }
// ============================================================================
const express = require('express');
const router = express.Router();
const { getAvailableSlots, bookAppointment } = require('../lib/calendar-booking');

// ============================================================================
// SERVER-SIDE DATE RESOLVER
// Converts natural language dates into YYYY-MM-DD relative to today.
// The AI passes whatever the caller said — we figure it out here.
// ============================================================================
function resolveDate(input) {
  if (!input) return null;
  
  const raw = input.toString().trim().toLowerCase();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const parsed = new Date(raw + 'T12:00:00');
    // If it's in the past, bump the year forward
    if (parsed < today) {
      parsed.setFullYear(now.getFullYear());
      if (parsed < today) parsed.setFullYear(now.getFullYear() + 1);
    }
    return parsed.toISOString().split('T')[0];
  }
  
  // "today"
  if (raw === 'today') {
    return formatISO(today);
  }
  
  // "tomorrow"
  if (raw === 'tomorrow') {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    return formatISO(d);
  }
  
  // "day after tomorrow"
  if (raw.includes('day after tomorrow')) {
    const d = new Date(today);
    d.setDate(d.getDate() + 2);
    return formatISO(d);
  }

  // Day names: "monday", "next monday", "this friday"
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayMatch = raw.match(/(?:next\s+|this\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i);
  if (dayMatch) {
    const targetDay = dayNames.indexOf(dayMatch[1].toLowerCase());
    const currentDay = today.getDay();
    let daysAhead = targetDay - currentDay;
    if (daysAhead <= 0) daysAhead += 7; // Always go forward
    if (raw.includes('next') && daysAhead <= 7) daysAhead += 7; // "next" = skip this week
    const d = new Date(today);
    d.setDate(d.getDate() + daysAhead);
    return formatISO(d);
  }
  
  // "the 3rd", "the 15th", "the twenty-first"
  const ordinalMatch = raw.match(/(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?$/);
  if (ordinalMatch) {
    const dayNum = parseInt(ordinalMatch[1]);
    if (dayNum >= 1 && dayNum <= 31) {
      // Try this month first, if past then next month
      let d = new Date(now.getFullYear(), now.getMonth(), dayNum);
      if (d < today) {
        d = new Date(now.getFullYear(), now.getMonth() + 1, dayNum);
      }
      return formatISO(d);
    }
  }
  
  // "March 3rd", "February 20", "march 3", "feb 20th", "Jan 15"
  const monthNames = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
    apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
    aug: 7, august: 7, sep: 8, september: 8, oct: 9, october: 9,
    nov: 10, november: 10, dec: 11, december: 11
  };
  const monthDayMatch = raw.match(/(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?/i);
  if (monthDayMatch) {
    const month = monthNames[monthDayMatch[1].toLowerCase()];
    const day = parseInt(monthDayMatch[2]);
    if (month !== undefined && day >= 1 && day <= 31) {
      let d = new Date(now.getFullYear(), month, day);
      if (d < today) {
        d = new Date(now.getFullYear() + 1, month, day);
      }
      return formatISO(d);
    }
  }
  
  // "3/15", "03/15", "3/15/2026"
  const slashMatch = raw.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (slashMatch) {
    const month = parseInt(slashMatch[1]) - 1;
    const day = parseInt(slashMatch[2]);
    let year = slashMatch[3] ? parseInt(slashMatch[3]) : now.getFullYear();
    if (year < 100) year += 2000;
    let d = new Date(year, month, day);
    if (d < today && !slashMatch[3]) {
      d = new Date(now.getFullYear() + 1, month, day);
    }
    return formatISO(d);
  }
  
  // "in X days"
  const inDaysMatch = raw.match(/in\s+(\d+)\s+days?/);
  if (inDaysMatch) {
    const d = new Date(today);
    d.setDate(d.getDate() + parseInt(inDaysMatch[1]));
    return formatISO(d);
  }
  
  // "next week" = next Monday
  if (raw.includes('next week')) {
    const d = new Date(today);
    const daysUntilMonday = (8 - today.getDay()) % 7 || 7;
    d.setDate(d.getDate() + daysUntilMonday);
    return formatISO(d);
  }
  
  // Last resort: try JS Date.parse
  const lastResort = new Date(raw);
  if (!isNaN(lastResort.getTime())) {
    if (lastResort < today) {
      lastResort.setFullYear(now.getFullYear() + 1);
    }
    return formatISO(lastResort);
  }
  
  return null; // Couldn't parse
}

function formatISO(d) {
  return d.toISOString().split('T')[0];
}

function todayContext() {
  const now = new Date();
  const iso = now.toISOString().split('T')[0];
  return `[Today is ${iso}]`;
}

function friendlyDate(isoDate) {
  const d = new Date(isoDate + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

// ============================================================================
// POST /api/calendar/availability/:clientId
// VAPI Tool: Check available appointment times
// ============================================================================
router.post('/availability/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { message } = req.body;
    
    const toolCall = message?.toolCallList?.[0] || message?.toolCalls?.[0];
    const toolCallId = toolCall?.id;
    const args = toolCall?.arguments || toolCall?.function?.arguments;
    
    let dateInput;
    if (args) {
      const parsed = typeof args === 'string' ? JSON.parse(args) : args;
      dateInput = parsed.date;
    }
    
    if (!dateInput) {
      return res.json({ 
        results: [{ toolCallId, result: `${todayContext()} What date would you like to check availability for?` }] 
      });
    }

    // Resolve natural language to YYYY-MM-DD
    const date = resolveDate(dateInput);
    if (!date) {
      return res.json({ 
        results: [{ toolCallId, result: `${todayContext()} I couldn't understand the date "${dateInput}". Could you say something like "next Tuesday", "March 5th", or "the 15th"?` }] 
      });
    }

    console.log(`📅 Checking availability for client ${clientId}: "${dateInput}" → ${date}`);
    const result = await getAvailableSlots(clientId, date);
    
    if (!result.success) {
      return res.json({ 
        results: [{ toolCallId, result: `${todayContext()} ${result.error}` }] 
      });
    }

    if (result.slots.length === 0) {
      return res.json({ 
        results: [{ toolCallId, result: `${todayContext()} No availability on ${friendlyDate(date)}. Would you like to try another date?` }] 
      });
    }

    // Suggest a few representative slots
    const slots = result.slots;
    let suggested = [];
    
    if (slots.length <= 4) {
      suggested = slots;
    } else {
      suggested.push(slots[0]);
      suggested.push(slots[Math.floor(slots.length / 2)]);
      suggested.push(slots[Math.floor(slots.length * 0.75)]);
      if (slots.length > 10) {
        suggested.push(slots[slots.length - 2]);
      }
    }

    return res.json({ 
      results: [{ 
        toolCallId,
        result: `${todayContext()} Available on ${friendlyDate(date)}: ${suggested.join(', ')}. Which works best? I also have other times if none of those work.`
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
    
    const toolCall = message?.toolCallList?.[0] || message?.toolCalls?.[0];
    const toolCallId = toolCall?.id;
    const args = toolCall?.arguments || toolCall?.function?.arguments;
    
    if (!args) {
      return res.json({ 
        results: [{ toolCallId, result: `${todayContext()} I need your name, phone number, and preferred date and time to book the appointment.` }] 
      });
    }

    const parsed = typeof args === 'string' ? JSON.parse(args) : args;
    let { customer_name, customer_phone, date: dateInput, time, service_type, notes } = parsed;

    if (!customer_name || !customer_phone || !dateInput || !time) {
      const missing = [];
      if (!customer_name) missing.push('your name');
      if (!customer_phone) missing.push('your phone number');
      if (!dateInput) missing.push('the date');
      if (!time) missing.push('the time');
      return res.json({ 
        results: [{ toolCallId, result: `${todayContext()} I still need ${missing.join(' and ')} to complete the booking.` }] 
      });
    }

    // Resolve natural language to YYYY-MM-DD
    const date = resolveDate(dateInput);
    if (!date) {
      return res.json({ 
        results: [{ toolCallId, result: `${todayContext()} I couldn't understand the date "${dateInput}". Could you say something like "next Tuesday", "March 5th", or "the 15th"?` }] 
      });
    }

    console.log(`📅 Booking for client ${clientId}: ${customer_name} on "${dateInput}" → ${date} at ${time}`);
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
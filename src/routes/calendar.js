const express = require('express');
const router = express.Router();
const { getAvailableSlots, bookAppointment } = require('../lib/calendar-booking');

// ============================================================================
// SERVER-SIDE DATE RESOLVER
// The AI model has no clock. It will send garbage dates.
// This function takes whatever the AI sent and figures out the correct date.
// ============================================================================
function resolveDate(input) {
  if (!input) return null;
  
  const raw = input.toString().trim().toLowerCase();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // --- "today" ---
  if (raw === 'today') {
    return formatISO(today);
  }

  // --- "tomorrow" ---
  if (raw === 'tomorrow') {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    return formatISO(d);
  }

  // --- "next available" / "next opening" / "soonest" ---
  if (raw.includes('next available') || raw.includes('next opening') || raw.includes('soonest') || raw.includes('earliest')) {
    return formatISO(today);
  }

  // --- Day names: "monday", "tuesday", "next friday", "this wednesday" ---
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayMatch = raw.match(/(next\s+|this\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i);
  if (dayMatch) {
    const targetDay = dayNames.indexOf(dayMatch[2].toLowerCase());
    const currentDay = today.getDay();
    let daysAhead = targetDay - currentDay;
    if (daysAhead <= 0) daysAhead += 7;
    if (dayMatch[1] && dayMatch[1].trim() === 'next' && daysAhead <= 7) daysAhead += 7;
    const d = new Date(today);
    d.setDate(d.getDate() + daysAhead);
    return formatISO(d);
  }

  // --- "in X days" ---
  const inDaysMatch = raw.match(/in\s+(\d+)\s+days?/);
  if (inDaysMatch) {
    const d = new Date(today);
    d.setDate(d.getDate() + parseInt(inDaysMatch[1]));
    return formatISO(d);
  }

  // --- "next week" ---
  if (raw.includes('next week')) {
    const d = new Date(today);
    const daysUntilMonday = (8 - today.getDay()) % 7 || 7;
    d.setDate(d.getDate() + daysUntilMonday);
    return formatISO(d);
  }

  // --- "March 5th", "feb 20", "january 3rd" ---
  const monthNames = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
    apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
    aug: 7, august: 7, sep: 8, september: 8, oct: 9, october: 9,
    nov: 10, november: 10, dec: 11, december: 11
  };
  const monthDayMatch = raw.match(/(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})/i);
  if (monthDayMatch) {
    const month = monthNames[monthDayMatch[1].toLowerCase()];
    const day = parseInt(monthDayMatch[2]);
    if (month !== undefined && day >= 1 && day <= 31) {
      var d = new Date(now.getFullYear(), month, day);
      if (d < today) d = new Date(now.getFullYear() + 1, month, day);
      return formatISO(d);
    }
  }

  // --- Already YYYY-MM-DD: if future trust it, if past extract day and find next occurrence ---
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const parsed = new Date(raw + 'T12:00:00');
    if (parsed >= today) return raw;
    
    var dayOfMonth = parsed.getDate();
    var corrected = new Date(now.getFullYear(), now.getMonth(), dayOfMonth);
    if (corrected < today) {
      corrected = new Date(now.getFullYear(), now.getMonth() + 1, dayOfMonth);
    }
    return formatISO(corrected);
  }

  // --- Bare number: "the 3rd", "the 15th", "3", "15" ---
  const bareNumberMatch = raw.match(/(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?/);
  if (bareNumberMatch) {
    const dayNum = parseInt(bareNumberMatch[1]);
    if (dayNum >= 1 && dayNum <= 31) {
      var d2 = new Date(now.getFullYear(), now.getMonth(), dayNum);
      if (d2 < today) d2 = new Date(now.getFullYear(), now.getMonth() + 1, dayNum);
      return formatISO(d2);
    }
  }

  // --- Last resort: JS Date.parse ---
  const lastResort = new Date(raw);
  if (!isNaN(lastResort.getTime())) {
    if (lastResort >= today) return formatISO(lastResort);
    var dayOfMonth2 = lastResort.getDate();
    var corrected2 = new Date(now.getFullYear(), now.getMonth(), dayOfMonth2);
    if (corrected2 < today) {
      corrected2 = new Date(now.getFullYear(), now.getMonth() + 1, dayOfMonth2);
    }
    return formatISO(corrected2);
  }

  return null;
}

function formatISO(d) {
  return d.toISOString().split('T')[0];
}

function friendlyDate(isoDate) {
  var d = new Date(isoDate + 'T12:00:00');
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  });
}

// ============================================================================
// VAPI Tool: Check availability
// ============================================================================
router.post('/availability/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { message } = req.body;
    
    const toolCall = message?.toolCallList?.[0] || message?.toolCalls?.[0];
    const toolCallId = toolCall?.id;
    const args = toolCall?.arguments || toolCall?.function?.arguments;
    
    var dateInput;
    if (args) {
      const parsed = typeof args === 'string' ? JSON.parse(args) : args;
      dateInput = parsed.date;
    }
    
    if (!dateInput) {
      return res.json({ 
        results: [{ toolCallId, result: 'What date would you like to check availability for?' }] 
      });
    }

    // Resolve whatever the AI sent to a correct YYYY-MM-DD
    const date = resolveDate(dateInput);
    console.log('📅 Date resolver: "' + dateInput + '" → ' + date);

    if (!date) {
      console.log('❌ Could not resolve date: "' + dateInput + '"');
      return res.json({ 
        results: [{ toolCallId, result: 'I couldn\'t determine the date. Could you tell me the specific date you\'d like?' }] 
      });
    }

    // Check if caller wants "next available" — search multiple days
    const raw = dateInput.toString().trim().toLowerCase();
    if (raw.includes('next available') || raw.includes('next opening') || raw.includes('soonest') || raw.includes('earliest')) {
      for (var i = 0; i < 7; i++) {
        var checkDate = new Date();
        checkDate.setDate(checkDate.getDate() + i);
        var checkStr = formatISO(checkDate);
        
        console.log('📅 Checking next available: ' + checkStr);
        var result = await getAvailableSlots(clientId, checkStr);
        
        if (result.success && result.slots.length > 0) {
          var slots = result.slots;
          var suggested = slots.length <= 4 ? slots : [slots[0], slots[Math.floor(slots.length / 2)], slots[Math.floor(slots.length * 0.75)]];
          var dateLabel = friendlyDate(checkStr);
          
          return res.json({ 
            results: [{ 
              toolCallId,
              result: 'The next available date is ' + dateLabel + '. I have openings at ' + suggested.join(', ') + '. Which works best for you?'
            }] 
          });
        }
      }
      
      return res.json({ 
        results: [{ toolCallId, result: 'I don\'t see any availability in the next 7 days. Would you like to check a specific date further out?' }] 
      });
    }

    console.log('📅 Checking availability for client ' + clientId + ' on ' + date);
    var result2 = await getAvailableSlots(clientId, date);
    
    if (!result2.success) {
      return res.json({ 
        results: [{ toolCallId, result: result2.error }] 
      });
    }

    var dateLabel2 = friendlyDate(date);

    if (result2.slots.length === 0) {
      return res.json({ 
        results: [{ toolCallId, result: 'No availability on ' + dateLabel2 + '. Would you like to try another date?' }] 
      });
    }

    var slots2 = result2.slots;
    var suggested2 = [];
    
    if (slots2.length <= 4) {
      suggested2 = slots2;
    } else {
      suggested2.push(slots2[0]);
      suggested2.push(slots2[Math.floor(slots2.length / 2)]);
      suggested2.push(slots2[Math.floor(slots2.length * 0.75)]);
      if (slots2.length > 10) {
        suggested2.push(slots2[slots2.length - 2]);
      }
    }

    return res.json({ 
      results: [{ 
        toolCallId,
        result: 'Availability for ' + dateLabel2 + ': ' + suggested2.join(', ') + '. Which works best for you? I also have other times if none of those work.'
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
// VAPI Tool: Book appointment
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
        results: [{ toolCallId, result: 'I need your name, phone number, and preferred date and time to book the appointment.' }] 
      });
    }

    const parsed = typeof args === 'string' ? JSON.parse(args) : args;
    const customerName = parsed.customer_name;
    const customerPhone = parsed.customer_phone;
    const dateInput = parsed.date;
    const time = parsed.time;
    const serviceType = parsed.service_type;
    const notes = parsed.notes;

    if (!customerName || !customerPhone || !dateInput || !time) {
      var missing = [];
      if (!customerName) missing.push('your name');
      if (!customerPhone) missing.push('your phone number');
      if (!dateInput) missing.push('the date');
      if (!time) missing.push('the time');
      return res.json({ 
        results: [{ toolCallId, result: 'I still need ' + missing.join(' and ') + ' to complete the booking.' }] 
      });
    }

    // Resolve whatever the AI sent to a correct YYYY-MM-DD
    const date = resolveDate(dateInput);
    console.log('📅 Booking date resolver: "' + dateInput + '" → ' + date);

    if (!date) {
      return res.json({ 
        results: [{ toolCallId, result: 'I couldn\'t determine the date. Could you confirm the date you\'d like to book?' }] 
      });
    }

    console.log('📅 Booking for client ' + clientId + ': ' + customerName + ' on ' + date + ' at ' + time);
    var result = await bookAppointment(clientId, customerName, customerPhone, date, time, serviceType, notes);

    return res.json({ 
      results: [{ toolCallId, result: result.success ? result.message : result.error }] 
    });

  } catch (error) {
    console.error('❌ Calendar booking error:', error);
    return res.json({ 
      results: [{ result: 'I\'m having trouble with the booking system. I have your information and someone will call you back to confirm the appointment.' }] 
    });
  }
});

module.exports = router;
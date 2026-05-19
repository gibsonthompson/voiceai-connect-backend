var express = require('express');
var router = express.Router();
var calendarBooking = require('../lib/calendar-booking');
var getAvailableSlots = calendarBooking.getAvailableSlots;
var bookAppointment = calendarBooking.bookAppointment;
var lookupServiceConfig = calendarBooking.lookupServiceConfig;

// ============================================================================
// SERVER-SIDE DATE RESOLVER
// The AI model has no clock. It sends garbage dates.
// This extracts the intent and resolves to the correct upcoming date.
// ============================================================================
function resolveDate(input) {
  if (!input) return null;
  
  var raw = input.toString().trim().toLowerCase();
  var now = new Date();
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (raw === 'today') {
    return formatISO(today);
  }

  if (raw === 'tomorrow') {
    var d = new Date(today);
    d.setDate(d.getDate() + 1);
    return formatISO(d);
  }

  if (raw.includes('next available') || raw.includes('next opening') || raw.includes('soonest') || raw.includes('earliest')) {
    return 'NEXT_AVAILABLE';
  }

  var dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  var dayMatch = raw.match(/(next\s+|this\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i);
  if (dayMatch) {
    var targetDay = dayNames.indexOf(dayMatch[2].toLowerCase());
    var currentDay = today.getDay();
    var daysAhead = targetDay - currentDay;
    if (daysAhead <= 0) daysAhead += 7;
    if (dayMatch[1] && dayMatch[1].trim() === 'next' && daysAhead <= 7) daysAhead += 7;
    var d2 = new Date(today);
    d2.setDate(d2.getDate() + daysAhead);
    return formatISO(d2);
  }

  var inDaysMatch = raw.match(/in\s+(\d+)\s+days?/);
  if (inDaysMatch) {
    var d3 = new Date(today);
    d3.setDate(d3.getDate() + parseInt(inDaysMatch[1]));
    return formatISO(d3);
  }

  if (raw.includes('next week')) {
    var d4 = new Date(today);
    var daysUntilMonday = (8 - today.getDay()) % 7 || 7;
    d4.setDate(d4.getDate() + daysUntilMonday);
    return formatISO(d4);
  }

  var monthNames = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
    apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
    aug: 7, august: 7, sep: 8, september: 8, oct: 9, october: 9,
    nov: 10, november: 10, dec: 11, december: 11
  };
  var monthDayMatch = raw.match(/(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})/i);
  if (monthDayMatch) {
    var month = monthNames[monthDayMatch[1].toLowerCase()];
    var day = parseInt(monthDayMatch[2]);
    if (month !== undefined && day >= 1 && day <= 31) {
      var d5 = new Date(now.getFullYear(), month, day);
      if (d5 < today) d5 = new Date(now.getFullYear() + 1, month, day);
      return formatISO(d5);
    }
  }

  // YYYY-MM-DD — if future trust it, if past find next occurrence of that weekday
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    var parsed = new Date(raw + 'T12:00:00');
    if (parsed >= today) return raw;
    var targetDow = parsed.getDay();
    var currentDow = today.getDay();
    var ahead = targetDow - currentDow;
    if (ahead <= 0) ahead += 7;
    var corrected = new Date(today);
    corrected.setDate(corrected.getDate() + ahead);
    return formatISO(corrected);
  }

  // Bare number: "the 3rd", "15th", "3"
  var bareNumberMatch = raw.match(/(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?/);
  if (bareNumberMatch) {
    var dayNum = parseInt(bareNumberMatch[1]);
    if (dayNum >= 1 && dayNum <= 31) {
      var d6 = new Date(now.getFullYear(), now.getMonth(), dayNum);
      if (d6 < today) d6 = new Date(now.getFullYear(), now.getMonth() + 1, dayNum);
      return formatISO(d6);
    }
  }

  // Last resort
  var lastResort = new Date(raw);
  if (!isNaN(lastResort.getTime())) {
    if (lastResort >= today) return formatISO(lastResort);
    var targetDow2 = lastResort.getDay();
    var currentDow2 = today.getDay();
    var ahead2 = targetDow2 - currentDow2;
    if (ahead2 <= 0) ahead2 += 7;
    var corrected2 = new Date(today);
    corrected2.setDate(corrected2.getDate() + ahead2);
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
// UPDATED Phase 3B: Looks up service config for duration/buffer overrides
// ============================================================================
router.post('/availability/:clientId', async function(req, res) {
  try {
    var clientId = req.params.clientId;
    var message = req.body.message;
    
    var toolCall = message?.toolCallList?.[0] || message?.toolCalls?.[0];
    var toolCallId = toolCall?.id;
    var args = toolCall?.arguments || toolCall?.function?.arguments;
    
    var dateInput;
    var serviceType = null;
    if (args) {
      var parsed = typeof args === 'string' ? JSON.parse(args) : args;
      dateInput = parsed.date;
      serviceType = parsed.service_type || null;
    }
    
    if (!dateInput) {
      return res.json({ 
        results: [{ toolCallId: toolCallId, result: 'What date would you like to check availability for?' }] 
      });
    }

    var date = resolveDate(dateInput);
    console.log('📅 Date resolver: "' + dateInput + '" → ' + date);

    if (!date) {
      console.log('❌ Could not resolve date: "' + dateInput + '"');
      return res.json({ 
        results: [{ toolCallId: toolCallId, result: 'I could not determine the date. Could you tell me the specific date you would like?' }] 
      });
    }

    // Phase 3B: Look up service config for duration/buffer
    var slotOptions = {};
    if (serviceType) {
      var svcConfig = await lookupServiceConfig(clientId, serviceType);
      if (svcConfig) {
        if (svcConfig.duration_minutes) slotOptions.durationOverride = svcConfig.duration_minutes;
        if (svcConfig.buffer_minutes) slotOptions.bufferMinutes = svcConfig.buffer_minutes;
        console.log('📅 Service "' + serviceType + '": duration=' + (svcConfig.duration_minutes || 'default') + 'min, buffer=' + (svcConfig.buffer_minutes || 0) + 'min');
      }
    }

    // Handle "next available" — search consecutive days
    if (date === 'NEXT_AVAILABLE') {
      for (var i = 0; i < 7; i++) {
        var checkDate = new Date();
        checkDate.setDate(checkDate.getDate() + i);
        var checkStr = formatISO(checkDate);
        
        console.log('📅 Checking next available: ' + checkStr);
        var checkResult = await getAvailableSlots(clientId, checkStr, slotOptions);
        
        if (checkResult.success && checkResult.slots.length > 0) {
          var slots = checkResult.slots;
          var suggested = slots.length <= 4 ? slots : [slots[0], slots[Math.floor(slots.length / 2)], slots[Math.floor(slots.length * 0.75)]];
          var dateLabel = friendlyDate(checkStr);
          
          return res.json({ 
            results: [{ 
              toolCallId: toolCallId,
              result: 'CORRECT DATE: ' + dateLabel + '. The next available date is ' + dateLabel + '. Available times: ' + suggested.join(', ') + '. Tell the caller this date and ask which time works best.'
            }] 
          });
        }
      }
      
      return res.json({ 
        results: [{ toolCallId: toolCallId, result: 'No availability in the next 7 days. Ask if the caller would like to check a specific date further out.' }] 
      });
    }

    console.log('📅 Checking availability for client ' + clientId + ' on ' + date);
    var result = await getAvailableSlots(clientId, date, slotOptions);
    
    if (!result.success) {
      return res.json({ 
        results: [{ toolCallId: toolCallId, result: result.error }] 
      });
    }

    var dateLabel2 = friendlyDate(date);

    if (result.slots.length === 0) {
      return res.json({ 
        results: [{ toolCallId: toolCallId, result: 'CORRECT DATE: ' + dateLabel2 + '. No availability on ' + dateLabel2 + '. Ask if the caller would like to try another date.' }] 
      });
    }

    var slots2 = result.slots;
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
        toolCallId: toolCallId,
        result: 'CORRECT DATE: ' + dateLabel2 + '. Available times on ' + dateLabel2 + ': ' + suggested2.join(', ') + '. Tell the caller this exact date and ask which time works best. Do NOT say any other date.'
      }] 
    });

  } catch (error) {
    console.error('❌ Calendar availability error:', error);
    return res.json({ 
      results: [{ result: 'I am having trouble checking the calendar. Let me take your information and have someone call you back to schedule.' }] 
    });
  }
});

// ============================================================================
// VAPI Tool: Book appointment
// UPDATED Phase 3B: Extracts staff_name, passes through to bookAppointment
// ============================================================================
router.post('/book/:clientId', async function(req, res) {
  try {
    var clientId = req.params.clientId;
    var message = req.body.message;
    
    var toolCall = message?.toolCallList?.[0] || message?.toolCalls?.[0];
    var toolCallId = toolCall?.id;
    var args = toolCall?.arguments || toolCall?.function?.arguments;
    
    if (!args) {
      return res.json({ 
        results: [{ toolCallId: toolCallId, result: 'I need your name, phone number, and preferred date and time to book the appointment.' }] 
      });
    }

    var parsed = typeof args === 'string' ? JSON.parse(args) : args;
    var customerName = parsed.customer_name;
    var customerPhone = parsed.customer_phone;
    var dateInput = parsed.date;
    var time = parsed.time;
    var serviceType = parsed.service_type;
    var notes = parsed.notes;
    var staffName = parsed.staff_name || null;

    if (!customerName || !customerPhone || !dateInput || !time) {
      var missing = [];
      if (!customerName) missing.push('your name');
      if (!customerPhone) missing.push('your phone number');
      if (!dateInput) missing.push('the date');
      if (!time) missing.push('the time');
      return res.json({ 
        results: [{ toolCallId: toolCallId, result: 'I still need ' + missing.join(' and ') + ' to complete the booking.' }] 
      });
    }

    var date = resolveDate(dateInput);
    console.log('📅 Booking date resolver: "' + dateInput + '" → ' + date);

    if (!date) {
      return res.json({ 
        results: [{ toolCallId: toolCallId, result: 'I could not determine the date. Could you confirm the date you would like to book?' }] 
      });
    }

    console.log('📅 Booking for client ' + clientId + ': ' + customerName + ' on ' + date + ' at ' + time + (staffName ? ' with ' + staffName : ''));
    var result = await bookAppointment(clientId, customerName, customerPhone, date, time, serviceType, notes, staffName);

    if (result.success) {
      return res.json({ 
        results: [{ toolCallId: toolCallId, result: 'BOOKING CONFIRMED. ' + result.message + '. Repeat this exact confirmation to the caller. Do NOT say any other date.' }] 
      });
    } else {
      return res.json({ 
        results: [{ toolCallId: toolCallId, result: result.error }] 
      });
    }

  } catch (error) {
    console.error('❌ Calendar booking error:', error);
    return res.json({ 
      results: [{ result: 'I am having trouble with the booking system. I have your information and someone will call you back to confirm the appointment.' }] 
    });
  }
});

module.exports = router;
// ============================================================================
// BOOKING CALL CACHE
// A booking succeeds mid-call via the /api/calendar/book tool, but the call
// record is only written at end-of-call. This short-lived in-memory map lets the
// book endpoint flag that a booking happened on a specific VAPI call, keyed by
// the VAPI call id, so the end-of-call handler can stamp appointment_booked /
// appointment_time on the saved call. Best-effort: on a restart or scale-out a
// cache miss simply means the "Booked" badge is not set (the appointment itself
// is still booked in Google Calendar). Mirrors the _demoToolInfo pattern.
// ============================================================================
const _bookings = new Map();
const TTL_MS = 60 * 60 * 1000; // 1 hour, plenty for a call's lifetime

function recordCallBooking(callId, data) {
  if (!callId) return;
  _bookings.set(String(callId), { ...(data || {}), at: Date.now() });
}

function getCallBooking(callId) {
  if (!callId) return null;
  const rec = _bookings.get(String(callId));
  if (!rec) return null;
  if (Date.now() - rec.at > TTL_MS) { _bookings.delete(String(callId)); return null; }
  return rec;
}

// Occasional cleanup so the map does not grow unbounded on a long-lived process.
const _sweep = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _bookings) { if (now - v.at > TTL_MS) _bookings.delete(k); }
}, 15 * 60 * 1000);
if (_sweep.unref) _sweep.unref();

module.exports = { recordCallBooking, getCallBooking };
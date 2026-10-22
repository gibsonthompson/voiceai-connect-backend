// ============================================================================
// BILLING MATH - shared minute-rounding policy
// ----------------------------------------------------------------------------
// One place that defines how call seconds become billed minutes, so the client
// meter, the platform meter, the self-billed (Paystack/Flutterwave) overage
// tally, and the dashboard counter can never drift apart.
//
// Policy: every answered call bills a MINIMUM of 1 minute, then rounds to the
// nearest whole minute with a 30-second threshold above that floor:
//   0:05 -> 1 min, 0:45 -> 1 min, 1:20 -> 1 min, 1:30 -> 2 min, 3:05 -> 3 min,
//   3:30 -> 4 min. A zero-duration call (silent line / instant drop) bills 0.
// This is OUR pricing choice, not a provider constraint: VAPI bills us the real
// per-call cost (captured as usage_records.vapi_cost), not a rounded-up minute,
// so we are free to set the floor and threshold.
// ============================================================================
function billedMinutesFromSeconds(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s <= 0) return 0;                 // no answered call, nothing to bill
  return Math.max(1, Math.round(s / 60)); // 1-minute floor, 30s threshold above
}

module.exports = { billedMinutesFromSeconds };

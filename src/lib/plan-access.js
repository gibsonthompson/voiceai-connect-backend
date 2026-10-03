// ============================================================================
// PLAN ACCESS — feature gating decoupled from billing
// ----------------------------------------------------------------------------
// getEffectivePlan resolves the plan used ONLY for FEATURE GATING. It is NOT a
// billing function: billing always uses plan_type (+ platform_fee_waived).
//
//   access_plan set     -> that plan (e.g. a comped partner billed on Pro who
//                          should see Scale features: plan_type='pro',
//                          access_plan='scale')
//   else trialing       -> 'scale' (trials get full access, unchanged behavior)
//   else                -> the agency's real plan_type
// ============================================================================
function getEffectivePlan(agency) {
  if (!agency) return 'free';
  if (agency.access_plan) return String(agency.access_plan).toLowerCase();
  const isTrialing = ['trialing', 'trial'].includes(agency.subscription_status);
  return isTrialing ? 'scale' : String(agency.plan_type || 'free').toLowerCase();
}
function isScalePlan(agency) { return getEffectivePlan(agency) === 'scale'; }
module.exports = { getEffectivePlan, isScalePlan };

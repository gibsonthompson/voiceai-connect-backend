// ============================================================================
// AGENCY SETTINGS
// WITH BYOT STATUS IN SETTINGS RESPONSE
// UPDATED: Added branding_overrides support for UI theme customization
// UPDATED: Added calendar_enabled_plans for Google Calendar plan gating
// UPDATED: Added analytics tracking (GTM, GA4, FB Pixel) + OG meta fields
// UPDATED: Added AI tool keys to plan_features validation
// UPDATED: Added team member limits to settings response
// UPDATED: Added marketing_template to responses + whitelist
// UPDATED: 2026-05-22 - Added client_header_mode + allow_client_branding to whitelist + response
// UPDATED: 2026-05-29 - Fixed plan_features validation: team_members is a number, not boolean
// UPDATED: 2026-06-08 - Added plan_*_name and plan_*_description columns for
//                       white-label plan customization (Phase 3). Returned in
//                       both getAgencyByHost (public) and getAgencySettings.
// UPDATED: 2026-07-19: getAgencySettings no longer returns the sensitive half
//                      of the agency row to unauthenticated callers. The route
//                      is mounted open in server.js because app/onboarding and
//                      lib/branding-context both call it with no token, so it
//                      cannot simply be guarded. Instead the handler now checks
//                      the caller itself: an owner (or super_admin, or an admin
//                      impersonation token) gets the full dashboard payload,
//                      anyone else gets the same publicAgencyShape projection
//                      that /api/agency/by-id already serves. Before this, any
//                      party holding an agency UUID (which is public, it is the
//                      data-agency value in every embed snippet) could read that
//                      agency's MRR, client counts, contact email and phone,
//                      twilio_account_sid, and Stripe customer/subscription ids.
// UPDATED: 2026-07-30: Client per-minute billing. getAgencySettings (auth
//                      branch) now returns minute_pass_through,
//                      client_minute_rate_cents, and included_minutes_* so the
//                      Payments tab can render the section. updateAgencySettings
//                      allows client_minute_rate_cents and the three
//                      included_minutes_* fields through, with range validation.
//                      minute_pass_through is deliberately NOT writable here (it
//                      goes through the dedicated toggle endpoint, which
//                      validates, creates the connected-account meter, and
//                      sweeps existing clients). connect_minute_meter_id is
//                      system-managed and never user-writable.
// UPDATED: 2026-08-04: Slug is now editable via updateAgencySettings. The slug
//                      routes the whole white-label site
//                      ({slug}.myvoiceaiconnect.com), so an edit is guarded
//                      three ways before it saves: format (3-63 chars,
//                      a-z 0-9 and hyphen, no leading/trailing hyphen), a
//                      reserved list of routing-critical subdomains, and
//                      case-insensitive uniqueness against every other agency.
//                      Typed errors (slug_invalid 400 / slug_reserved 400 /
//                      slug_taken 409) let the Settings UI surface the reason
//                      inline. An unchanged slug is dropped so a plain profile
//                      save neither re-validates a legacy value nor runs a
//                      needless uniqueness query.
// UPDATED: 2026-08-06: Custom marketing nav links. Agencies can add up to 5
//                      external links (label + url) rendered in the marketing
//                      site header and footer. custom_nav_links is whitelisted
//                      and validated (array cap, label and url length caps).
//                      URLs are normalized: a bare domain like yourmainsite.com
//                      or www.yourmainsite.com is accepted and stored as
//                      https://...; a value that already has http:// or https://
//                      is kept as-is; anything that is not a valid http(s) URL
//                      after that is rejected, which still blocks javascript:/
//                      data: and other unsafe schemes. Exposed via
//                      publicAgencyShape so the public marketing render receives
//                      it, and returned in the authenticated getAgencySettings
//                      branch so the Navigation settings tab can load current
//                      values.
// UPDATED: 2026-08-13: Manual client billing. client_billing_mode ('connect'
//                      default | 'manual') is whitelisted and validated in
//                      updateAgencySettings (only those two values), and
//                      returned in the authenticated getAgencySettings payload
//                      so the settings toggle can render its state. It is NOT
//                      added to publicAgencyShape: the public marketing/embed
//                      surface never needs it, and the backend decides manual
//                      behavior server-side at signup. The authenticated stats
//                      block now counts a manual client (subscription_status
//                      'manual') as an active client, since a manual client is
//                      live; without this an agency's own dashboard would show
//                      its manual clients as neither active nor trial. MRR also
//                      counts manual clients at their plan price (same treatment
//                      as an active connect client); if you would rather exclude
//                      manual clients from platform-computed MRR (because a
//                      manual agency may charge its clients outside these plan
//                      prices), drop 'manual' from the ACTIVE_STAT_STATUSES set
//                      used in the mrr reducer only.
// UPDATED: 2026-08-20: One-time client setup fee. setup_fee_cents (agency
//                      currency, cents; null/0 = no fee) is whitelisted and
//                      range-validated in updateAgencySettings, returned in the
//                      authenticated getAgencySettings payload so the Pricing
//                      tab can load it, and exposed on publicAgencyShape so the
//                      signup widget / marketing site can show it before
//                      checkout. The fee itself is charged by stripe-connect's
//                      buildSetupFeeLineItem on the client's first paid invoice.
// Destination: src/routes/agency-settings.js (REPLACE existing)
// ============================================================================
const dns = require('dns').promises;
const jwt = require('jsonwebtoken');
const { supabase, getAgencyBySlug, getAgencyByDomain, getAgencyById } = require('../lib/supabase');
// Reprice sweep for client per-minute billing. Stripe prices are immutable, so
// a rate/included-minutes change only reaches EXISTING clients if their metered
// item is re-pointed to a fresh price. updateAgencySettings fires this in the
// background after such a change. Requiring stripe-connect here is safe: it
// does not require this module back (no circular dependency).
const { repriceMinuteItemsForAgency } = require('./stripe-connect');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Client subscription_status values that count as a live/active client in the
// agency's own dashboard stats. 'manual' is a first-class live status (a manual
// client is provisioned and taking calls), so it counts here alongside 'active'.
const ACTIVE_STAT_STATUSES = new Set(['active', 'manual']);

// ============================================================================
// CALLER OWNS AGENCY
// ----------------------------------------------------------------------------
// True when the request carries a valid token that is entitled to this agency's
// private data. Mirrors the pass conditions in requireAgencyAccess (routes/
// auth.js) so the two cannot drift:
//   - super_admin                          -> any agency
//   - normal agency token  { agencyId }    -> must match
//   - admin impersonation  { id, type }    -> must match
// Returns false for a missing, malformed, or expired token instead of throwing,
// because on this route an unauthenticated caller is legitimate: it just gets
// the public projection rather than a 401. Deliberately does NOT consult the
// Page Access toggles, since this is the dashboard bootstrap every agency user
// needs regardless of which tabs they can open.
// ============================================================================
function callerOwnsAgency(req, agencyId) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return false;

    const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
    if (decoded.role === 'super_admin') return true;

    const callerAgencyId = decoded.agencyId || (decoded.type === 'agency' ? decoded.id : null);
    return !!callerAgencyId && callerAgencyId === agencyId;
  } catch {
    return false;
  }
}

// ============================================================================
// PUBLIC AGENCY SHAPE
// ----------------------------------------------------------------------------
// Whitelisted projection of an agency row for unauthenticated consumers:
// marketing site, signup widget, embed iframe. NEVER include columns that
// shouldn't be public (BYOT credentials, internal tokens, anything sensitive).
// Used by both getAgencyByHost (subdomain/marketing-domain lookup) and
// getAgencyByIdPublic (Path A embed flow - iframe knows agency UUID from the
// embed snippet's data-agency attribute), and by the unauthenticated branch of
// getAgencySettings.
//
// client_billing_mode is deliberately NOT exposed here: the public
// marketing/embed surface never needs it (manual behavior is decided
// server-side in the signup handlers), so it stays out of the public shape.
// ============================================================================
function publicAgencyShape(agency) {
  return {
    id: agency.id,
    name: agency.name,
    slug: agency.slug,
    logo_url: agency.logo_url,
    favicon_url: agency.favicon_url,
    primary_color: agency.primary_color,
    secondary_color: agency.secondary_color,
    accent_color: agency.accent_color,
    support_email: agency.support_email,
    support_phone: agency.support_phone,

    // Marketing website content
    company_tagline: agency.company_tagline,
    website_headline: agency.website_headline,
    website_subheadline: agency.website_subheadline,
    marketing_config: agency.marketing_config,
    marketing_template: agency.marketing_template || 'classic',
    // Custom nav links (external header/footer links defined by the agency)
    custom_nav_links: Array.isArray(agency.custom_nav_links) ? agency.custom_nav_links : [],

    // Theme settings
    website_theme: agency.website_theme,
    logo_background_color: agency.logo_background_color,

    // Dashboard branding overrides (nav, bg, card, button colors)
    branding_overrides: agency.branding_overrides || null,

    // Plan type (for feature gating)
    plan_type: agency.plan_type,
    subscription_status: agency.subscription_status,

    // Pricing (for client signup + marketing website)
    price_starter: agency.price_starter,
    price_pro: agency.price_pro,
    price_growth: agency.price_growth,

    // One-time client setup fee (cents, agency currency; null = none). Public
    // so the signup widget and marketing site can show it before checkout. The
    // charge itself is added server-side by stripe-connect at checkout.
    setup_fee_cents: agency.setup_fee_cents ?? null,

    // Limits
    limit_starter: agency.limit_starter,
    limit_pro: agency.limit_pro,
    limit_growth: agency.limit_growth,

    // White-label plan customization (Phase 3)
    plan_starter_name: agency.plan_starter_name || 'Starter',
    plan_pro_name: agency.plan_pro_name || 'Professional',
    plan_growth_name: agency.plan_growth_name || 'Growth',
    plan_starter_description: agency.plan_starter_description || null,
    plan_pro_description: agency.plan_pro_description || null,
    plan_growth_description: agency.plan_growth_description || null,

    // Client plan features (for dynamic plan cards on signup)
    plan_features: agency.plan_features || null,

    // Demo phone (auto-provisioned per agency via VAPI)
    demo_phone_number: agency.demo_phone_number || null,
    // Legacy manual override field
    demo_phone: agency.demo_phone || null,

    // Currency (for marketing page pricing display)
    currency: agency.currency || 'USD',
    display_currency: agency.display_currency || null,
    // Country. Drives the marketing-page currency fallback when the agency
    // never picked a display_currency in Settings. Without this the site can't
    // tell a GB agency from a US one and defaults to "$".
    country: agency.country || 'US',
    // Stripe (needed for checkout)
    stripe_account_id: agency.stripe_account_id,
    stripe_charges_enabled: agency.stripe_charges_enabled,

    // Client trial card requirement. The signup/plan step ANDs this with
    // stripe_charges_enabled (mirroring the cardRequired check in
    // handleClientSignup) to decide whether to show the card-required
    // auto-renew consent language. Safe to expose: it is already a
    // public-facing toggle written via updateAgencySettings, and reveals
    // nothing sensitive.
    require_card_for_trial: agency.require_card_for_trial === true,

    // Analytics & Tracking (for marketing site script injection)
    gtm_id: agency.gtm_id || null,
    fb_pixel_id: agency.fb_pixel_id || null,
    google_analytics_id: agency.google_analytics_id || null,
    custom_head_scripts: agency.custom_head_scripts || null,
    custom_body_scripts: agency.custom_body_scripts || null,

    // OG / Social meta (for marketing site social sharing)
    og_title: agency.og_title || null,
    og_description: agency.og_description || null,
    og_image_url: agency.og_image_url || null,

    // Marketing domain (used by the embed widget for cross-origin auth handoff)
    marketing_domain: agency.marketing_domain || null,
    domain_verified: agency.domain_verified || false
  };
}

// ============================================================================
// GET AGENCY BY HOST (For middleware/frontend)
// ============================================================================
async function getAgencyByHost(req, res) {
  try {
    const { host } = req.query;
    
    if (!host) {
      return res.status(400).json({ error: 'host parameter required' });
    }
    
    console.log('🔍 Looking up agency for host:', host);
    
    let agency = null;
    
    // Check if it's a subdomain of myvoiceaiconnect.com
    const subdomainMatch = host.match(/^([^.]+)\.myvoiceaiconnect\.com$/);
    if (subdomainMatch) {
      const slug = subdomainMatch[1];
      agency = await getAgencyBySlug(slug);
    }
    
    // Check for custom domain
    if (!agency) {
      agency = await getAgencyByDomain(host);
    }
    
    if (!agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }
    
    // Return public agency info (for branding + marketing website + embed widget)
    res.json({
      success: true,
      agency: publicAgencyShape(agency)
    });
    
  } catch (error) {
    console.error('❌ Agency lookup error:', error);
    res.status(500).json({ error: 'Failed to lookup agency' });
  }
}

// ============================================================================
// GET AGENCY BY ID (Public, embed-widget Path A)
// ----------------------------------------------------------------------------
// The embed snippet bakes in the agency's UUID via data-agency. When the
// iframe loads on the platform domain (myvoiceaiconnect.com), there's no
// host-based agency context to derive - middleware sees a platform request
// and skips Supabase. This endpoint lets the iframe look up the agency by
// the UUID it already has, then render the client-side signup flow branded
// by that agency.
//
// Security:
//   - UUID format guard rejects garbage before hitting the DB.
//   - Same status filter as getAgencyByHost: only 'active' or 'trial' agencies
//     are returned. Suspended/canceled → 403 so the embed shows an unavailable
//     state instead of a working form for an off-status agency.
//   - Returns the publicAgencyShape projection (same as by-host). NEVER add
//     fields here that aren't already exposed via by-host - they'd leak via
//     the embed widget too.
// ============================================================================
async function getAgencyByIdPublic(req, res) {
  try {
    const { id } = req.query;

    if (!id) {
      return res.status(400).json({ error: 'id parameter required' });
    }

    // UUID v4-ish format guard. Prevents the DB from being hit with arbitrary
    // strings and gives us a fast 400 for malformed embed snippets.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return res.status(400).json({ error: 'invalid id format' });
    }

    const agency = await getAgencyById(id);

    if (!agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    // Mirror suspended-agency handling from middleware's rewriteToUnavailable.
    // We don't want a suspended agency's embed snippet to keep working in the
    // wild after they've been removed.
    if (agency.status !== 'active' && agency.status !== 'trial') {
      return res.status(403).json({ error: 'Agency not active' });
    }

    res.json({
      success: true,
      agency: publicAgencyShape(agency)
    });

  } catch (error) {
    console.error('❌ Agency by-id lookup error:', error);
    res.status(500).json({ error: 'Failed to lookup agency' });
  }
}

// ============================================================================
// GET AGENCY SETTINGS (agency dashboard bootstrap)
// ----------------------------------------------------------------------------
// Mounted WITHOUT a route guard in server.js on purpose: app/onboarding/page.tsx
// and lib/branding-context.tsx both call this with no Authorization header, so
// a hard 401 would break agency onboarding and white-label branding for
// logged-out visitors.
//
// The privacy boundary therefore lives here instead of in middleware:
//
//   authenticated owner  -> full payload + stats (what the dashboard reads)
//   everyone else        -> publicAgencyShape + a few non-sensitive operational
//                           fields, and NO stats
//
// Withheld from the public branch, all of which used to be world-readable to
// anyone holding the agency UUID: email, phone, mrr_cents and the client-count
// stats, twilio_account_sid, byot_*, stripe_customer_id,
// stripe_subscription_id, stripe_onboarding_complete, stripe_payouts_enabled,
// and the team-member seat limits. stripe_account_id and
// stripe_charges_enabled stay, because checkout needs them and by-host already
// publishes them.
//
// The public branch sets public:true so a caller can tell the two apart, and
// keeps stats present-but-null rather than absent so `data.stats?.x` reads
// stay safe.
// ============================================================================
async function getAgencySettings(req, res) {
  try {
    const { agencyId } = req.params;
    
    const agency = await getAgencyById(agencyId);
    
    if (!agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    // ── Unauthenticated / other-agency caller: public projection only ──
    if (!callerOwnsAgency(req, agencyId)) {
      return res.json({
        success: true,
        public: true,
        agency: {
          ...publicAgencyShape(agency),
          // Non-sensitive operational fields the onboarding page and the
          // branding context legitimately read. None of these reveal revenue,
          // contact details, or provider credentials.
          status: agency.status,
          onboarding_completed: agency.onboarding_completed,
          onboarding_step: agency.onboarding_step,
          client_header_mode: agency.client_header_mode || 'agency_name',
          allow_client_branding: agency.allow_client_branding || false,
          calendar_enabled_plans: agency.calendar_enabled_plans || ['pro', 'growth'],
          timezone: agency.timezone,
          country: agency.country || 'US',
        },
        stats: null
      });
    }
    
    // Get client count and stats
    const { data: clients } = await supabase
      .from('clients')
      .select('id, subscription_status, plan_type, calls_this_month')
      .eq('agency_id', agencyId);
    
    const stats = {
      total_clients: clients?.length || 0,
      // A manual client (subscription_status 'manual') is live, so it counts as
      // active here alongside connect 'active' clients. Trial is unchanged.
      active_clients: clients?.filter(c => ACTIVE_STAT_STATUSES.has(c.subscription_status)).length || 0,
      trial_clients: clients?.filter(c => c.subscription_status === 'trial').length || 0,
      total_calls_this_month: clients?.reduce((sum, c) => sum + (c.calls_this_month || 0), 0) || 0,
      mrr_cents: clients?.reduce((sum, c) => {
        // Count active AND manual clients at their plan price. If you would
        // rather exclude manual clients from platform-computed MRR (a manual
        // agency may bill its clients outside these plan prices), change this
        // guard to `c.subscription_status !== 'active'`.
        if (!ACTIVE_STAT_STATUSES.has(c.subscription_status)) return sum;
        const prices = {
          starter: agency.price_starter,
          pro: agency.price_pro,
          growth: agency.price_growth
        };
        return sum + (prices[c.plan_type] || 0);
      }, 0) || 0
    };
    
    res.json({
      success: true,
      agency: {
        // Basic info
        id: agency.id,
        name: agency.name,
        slug: agency.slug,
        email: agency.email,
        phone: agency.phone,
        
        // Status
        status: agency.status,
        subscription_status: agency.subscription_status,
        plan_type: agency.plan_type,
        trial_ends_at: agency.trial_ends_at,
        onboarding_completed: agency.onboarding_completed,
        onboarding_step: agency.onboarding_step,
        
        // Branding
        logo_url: agency.logo_url,
        favicon_url: agency.favicon_url,
        primary_color: agency.primary_color,
        secondary_color: agency.secondary_color,
        accent_color: agency.accent_color,
        
        // Marketing website content
        company_tagline: agency.company_tagline,
        website_headline: agency.website_headline,
        website_subheadline: agency.website_subheadline,
        marketing_config: agency.marketing_config,
        marketing_template: agency.marketing_template || 'classic',
        custom_nav_links: Array.isArray(agency.custom_nav_links) ? agency.custom_nav_links : [],
        
        // Theme settings
        website_theme: agency.website_theme,
        logo_background_color: agency.logo_background_color,
        
        // Dashboard branding overrides (nav, bg, card, button colors)
        branding_overrides: agency.branding_overrides || null,
        
        // Client dashboard settings
        client_header_mode: agency.client_header_mode || 'agency_name',
        allow_client_branding: agency.allow_client_branding || false,
        
        // Domain
        marketing_domain: agency.marketing_domain,
        domain_verified: agency.domain_verified,
        
        // Pricing
        price_starter: agency.price_starter,
        price_pro: agency.price_pro,
        price_growth: agency.price_growth,

        // One-time client setup fee (cents, agency currency; null = none).
        // Loaded by the Pricing tab. Charged on the client's first paid invoice
        // by stripe-connect's buildSetupFeeLineItem.
        setup_fee_cents: agency.setup_fee_cents ?? null,

        limit_starter: agency.limit_starter,
        limit_pro: agency.limit_pro,
        limit_growth: agency.limit_growth,

        // White-label plan customization (Phase 3)
        plan_starter_name: agency.plan_starter_name || 'Starter',
        plan_pro_name: agency.plan_pro_name || 'Professional',
        plan_growth_name: agency.plan_growth_name || 'Growth',
        plan_starter_description: agency.plan_starter_description || null,
        plan_pro_description: agency.plan_pro_description || null,
        plan_growth_description: agency.plan_growth_description || null,

        // Client plan feature gating
        plan_features: agency.plan_features || null,
        
        // Calendar plan gating (which client plans can use Google Calendar)
        calendar_enabled_plans: agency.calendar_enabled_plans || ['pro', 'growth'],

        // Client per-minute billing (agency charges its own clients per voice
        // minute on its connected account). minute_pass_through is READ here so
        // the Payments tab can render the toggle state, but it is only WRITTEN
        // via POST /api/agency/:agencyId/minute-pass-through, never through the
        // settings PUT. Rate is stored in cents (numeric(10,4), sub-cent
        // allowed); included minutes are the per-plan free allotment.
        minute_pass_through: agency.minute_pass_through === true,
        client_minute_rate_cents: agency.client_minute_rate_cents ?? null,
        included_minutes_starter: agency.included_minutes_starter ?? 0,
        included_minutes_pro: agency.included_minutes_pro ?? 0,
        included_minutes_growth: agency.included_minutes_growth ?? 0,

        // Client billing mode. 'connect' (default) routes clients through
        // Stripe Connect; 'manual' onboards clients with no Stripe step (the
        // agency bills them by invoice / payment link). Returned so the Settings
        // toggle can render its current state. Written via the settings PUT
        // (validated to connect|manual there).
        client_billing_mode: agency.client_billing_mode || 'connect',
        
        // Client trial card requirement (require_card_for_trial). Returned so
        // the Settings pricing tab can render and toggle it. The signup flow
        // ANDs it with stripe_charges_enabled to decide the card-required path.
        require_card_for_trial: agency.require_card_for_trial === true,
        
        // Demo phone (auto-provisioned per agency via VAPI)
        demo_phone_number: agency.demo_phone_number || null,
        demo_assistant_id: agency.demo_assistant_id || null,
        demo_vapi_phone_id: agency.demo_vapi_phone_id || null,
        
        // Stripe
        stripe_account_id: agency.stripe_account_id,
        stripe_customer_id: agency.stripe_customer_id,
        stripe_subscription_id: agency.stripe_subscription_id,
        stripe_onboarding_complete: agency.stripe_onboarding_complete,
        stripe_charges_enabled: agency.stripe_charges_enabled,
        stripe_payouts_enabled: agency.stripe_payouts_enabled,
        
        // Support
        support_email: agency.support_email,
        support_phone: agency.support_phone,
        timezone: agency.timezone,
        
        // International / BYOT
        country: agency.country || 'US',
        currency: agency.currency || 'USD',
        display_currency: agency.display_currency || null,
        byot_enabled: agency.byot_enabled || false,
        byot_verified_at: agency.byot_verified_at || null,
        twilio_account_sid: agency.twilio_account_sid || null,

        // Team member limits
        max_team_members_agency: agency.max_team_members_agency ?? null,
        max_team_members_client: agency.max_team_members_client || 0,

        // Analytics & Tracking
        gtm_id: agency.gtm_id || null,
        fb_pixel_id: agency.fb_pixel_id || null,
        google_analytics_id: agency.google_analytics_id || null,
        custom_head_scripts: agency.custom_head_scripts || null,
        custom_body_scripts: agency.custom_body_scripts || null,

        // OG / Social meta
        og_title: agency.og_title || null,
        og_description: agency.og_description || null,
        og_image_url: agency.og_image_url || null,
        
        // Timestamps
        created_at: agency.created_at,
        updated_at: agency.updated_at
      },
      stats
    });
    
  } catch (error) {
    console.error('❌ Get agency settings error:', error);
    res.status(500).json({ error: 'Failed to get agency settings' });
  }
}

// ============================================================================
// SLUG VALIDATION HELPERS (editable white-label subdomain)
// ----------------------------------------------------------------------------
// The slug is the agency's white-label subdomain ({slug}.myvoiceaiconnect.com)
// and resolves the entire marketing/signup/checkout site via getAgencyBySlug.
// Because an agency can now edit it from Settings, three guards run before any
// save: format, a reserved-subdomain list, and case-insensitive uniqueness.
// ============================================================================
const RESERVED_SLUGS = new Set([
  'www', 'api', 'admin', 'app', 'signup', 'login', 'demo', 'dashboard',
  'platform', 'client', 'agency', 'mail', 'static', 'assets', 'cdn'
]);

// 3-63 chars, lowercase a-z 0-9 and hyphen, must start and end alphanumeric
// (no leading/trailing hyphen).
const SLUG_FORMAT = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

// Valid client billing modes. 'connect' (default) routes clients through Stripe
// Connect; 'manual' onboards clients with no Stripe step (agency bills its own
// clients). Any other value is rejected by updateAgencySettings.
const VALID_CLIENT_BILLING_MODES = new Set(['connect', 'manual']);

// ============================================================================
// UPDATE AGENCY SETTINGS
// ============================================================================
async function updateAgencySettings(req, res) {
  try {
    const { agencyId } = req.params;
    const updates = req.body;
    
    // Whitelist allowed fields
    const allowedFields = [
      'name', 'phone', 'slug',
      'logo_url', 'favicon_url',
      'primary_color', 'secondary_color', 'accent_color',
      'marketing_domain', 'domain_verified',
      'price_starter', 'price_pro', 'price_growth',
      // One-time client setup fee (cents). Range-validated below. NULL/0 = none.
      'setup_fee_cents',
      'limit_starter', 'limit_pro', 'limit_growth',
      // Client per-minute billing: the agency-wide overage rate (cents/min)
      // and the per-plan included-minute allotments. Written via the normal
      // settings PUT. IMPORTANT: minute_pass_through is intentionally NOT in
      // this list. Enabling/disabling pass-through has side effects (validate
      // rate + Connect, create the connected-account meter, sweep existing
      // clients, clean up inert items at renewal), so it must go through the
      // dedicated POST /api/agency/:agencyId/minute-pass-through endpoint.
      // connect_minute_meter_id is system-managed and never user-writable.
      'client_minute_rate_cents',
      'included_minutes_starter', 'included_minutes_pro', 'included_minutes_growth',
      // Client billing mode ('connect' | 'manual'). A plain settings write:
      // switching to manual changes what NEW clients get (each client is stamped
      // billing_mode at creation), so it has no retroactive side effects and
      // needs no dedicated endpoint. Validated below against
      // VALID_CLIENT_BILLING_MODES.
      'client_billing_mode',
      // Phase 3 - white-label plan customization
      'plan_starter_name', 'plan_pro_name', 'plan_growth_name',
      'plan_starter_description', 'plan_pro_description', 'plan_growth_description',
      'support_email', 'support_phone', 'timezone',
      // Marketing website content fields
      'company_tagline',
      'website_headline',
      'website_subheadline',
      'marketing_config',
      'marketing_template',
      // Custom marketing nav links (agency-defined external header/footer links)
      'custom_nav_links',
      // Theme settings
      'website_theme',
      'logo_background_color',
      // Dashboard branding overrides (nav, bg, card, button colors)
      'branding_overrides',
      // Client dashboard settings
      'client_header_mode',
      'allow_client_branding',
      // Client plan feature gating
      'plan_features',
      // Calendar plan gating (which client plans can connect Google Calendar)
      'calendar_enabled_plans',
      // Client trial card requirement (require_card_for_trial)
      // When true, /api/client/signup creates Stripe Connect Checkout with
      // trial_period_days=7. When false (default), trials are DB-only.
      // Backend silently no-ops if stripe_charges_enabled is false.
      'require_card_for_trial',
      // Marketing page currency override
      'display_currency',
      // Analytics & Tracking
      'gtm_id',
      'fb_pixel_id',
      'google_analytics_id',
      'custom_head_scripts',
      'custom_body_scripts',
      // OG / Social meta
      'og_title',
      'og_description',
      'og_image_url'
    ];
    
    const sanitizedUpdates = {};
    for (const key of allowedFields) {
      if (updates[key] !== undefined) {
        sanitizedUpdates[key] = updates[key];
      }
    }

    // ── Slug (white-label subdomain) ─────────────────────────────────────
    // Guarded three ways before it can save. Order matters: normalize first,
    // short-circuit an unchanged value (so a plain profile save is not held to
    // current format rules and does not run a needless uniqueness query), then
    // format, reserved list, and case-insensitive uniqueness. Each failure
    // returns a typed error the Settings UI renders inline.
    if (sanitizedUpdates.slug !== undefined) {
      const raw = sanitizedUpdates.slug;
      if (typeof raw !== 'string') {
        return res.status(400).json({ error: 'slug_invalid', message: 'Slug must be text.' });
      }
      const slug = raw.trim().toLowerCase();

      // Compare against the stored value. Unchanged -> drop it and move on.
      const { data: currentRow, error: currentErr } = await supabase
        .from('agencies')
        .select('slug')
        .eq('id', agencyId)
        .single();

      if (currentErr) {
        console.error('❌ Slug current-value lookup failed:', currentErr);
        return res.status(500).json({ error: 'Failed to validate slug' });
      }

      if ((currentRow?.slug || '').toLowerCase() === slug) {
        // No change (including a case-only difference on a legacy slug). Do not
        // rewrite it, so we never fail a save over an existing out-of-spec slug.
        delete sanitizedUpdates.slug;
      } else {
        // Format
        if (slug.length < 3 || slug.length > 63 || !SLUG_FORMAT.test(slug)) {
          return res.status(400).json({
            error: 'slug_invalid',
            message: 'Use 3 to 63 characters: lowercase letters, numbers, and hyphens, not starting or ending with a hyphen.'
          });
        }
        // Reserved routing-critical subdomains
        if (RESERVED_SLUGS.has(slug)) {
          return res.status(400).json({
            error: 'slug_reserved',
            message: 'That subdomain is reserved. Please choose another.'
          });
        }
        // Case-insensitive uniqueness against every OTHER agency. After format
        // validation the slug has no % or _ , so ilike acts as case-insensitive
        // equality here.
        const { data: clash, error: clashErr } = await supabase
          .from('agencies')
          .select('id')
          .ilike('slug', slug)
          .neq('id', agencyId)
          .limit(1);

        if (clashErr) {
          console.error('❌ Slug uniqueness check failed:', clashErr);
          return res.status(500).json({ error: 'Failed to validate slug' });
        }
        if (clash && clash.length > 0) {
          return res.status(409).json({
            error: 'slug_taken',
            message: 'That subdomain is already taken. Please choose another.'
          });
        }

        // Persist the normalized value.
        sanitizedUpdates.slug = slug;
      }
    }

    // ── Client billing mode ('connect' | 'manual') ───────────────────────
    // Normalize and validate. Anything outside the set is a 400 so a typo can
    // never silently write an unknown mode (which the signup handlers would
    // then treat as connect). null / '' resets to the default 'connect'.
    if (sanitizedUpdates.client_billing_mode !== undefined) {
      const raw = sanitizedUpdates.client_billing_mode;
      if (raw === null || raw === '') {
        sanitizedUpdates.client_billing_mode = 'connect';
      } else if (typeof raw !== 'string' || !VALID_CLIENT_BILLING_MODES.has(raw.trim().toLowerCase())) {
        return res.status(400).json({
          error: 'client_billing_mode_invalid',
          message: "client_billing_mode must be 'connect' or 'manual'.",
        });
      } else {
        sanitizedUpdates.client_billing_mode = raw.trim().toLowerCase();
      }
    }

    // Validate + sanitize plan name / description fields (Phase 3)
    const PLAN_NAME_FIELDS = ['plan_starter_name', 'plan_pro_name', 'plan_growth_name'];
    const PLAN_DESC_FIELDS = ['plan_starter_description', 'plan_pro_description', 'plan_growth_description'];
    const PLAN_NAME_DEFAULTS = {
      plan_starter_name: 'Starter',
      plan_pro_name: 'Professional',
      plan_growth_name: 'Growth',
    };

    for (const field of PLAN_NAME_FIELDS) {
      if (sanitizedUpdates[field] === undefined) continue;
      const v = sanitizedUpdates[field];
      if (v === null) {
        // null means "reset to default"
        sanitizedUpdates[field] = PLAN_NAME_DEFAULTS[field];
        continue;
      }
      if (typeof v !== 'string') {
        return res.status(400).json({ error: `${field} must be a string` });
      }
      const trimmed = v.trim();
      if (trimmed.length === 0) {
        // Empty input → reset to default rather than store empty string
        sanitizedUpdates[field] = PLAN_NAME_DEFAULTS[field];
      } else if (trimmed.length > 50) {
        return res.status(400).json({ error: `${field} must be 50 characters or fewer` });
      } else {
        sanitizedUpdates[field] = trimmed;
      }
    }

    for (const field of PLAN_DESC_FIELDS) {
      if (sanitizedUpdates[field] === undefined) continue;
      const v = sanitizedUpdates[field];
      if (v === null) {
        sanitizedUpdates[field] = null;
        continue;
      }
      if (typeof v !== 'string') {
        return res.status(400).json({ error: `${field} must be a string` });
      }
      const trimmed = v.trim();
      if (trimmed.length === 0) {
        sanitizedUpdates[field] = null;
      } else if (trimmed.length > 200) {
        return res.status(400).json({ error: `${field} must be 200 characters or fewer` });
      } else {
        sanitizedUpdates[field] = trimmed;
      }
    }

    // Validate client per-minute billing fields.
    // client_minute_rate_cents is stored in CENTS as numeric(10,4), so sub-cent
    // precision is allowed (do not force an integer). Range guard: >= 0 and a
    // sane ceiling of 1000 cents/min (10.00 per minute) to catch a fat-fingered
    // value. Empty/null clears the rate. The frontend collects dollars and
    // multiplies by 100 before sending, so what arrives here is already cents.
    if (sanitizedUpdates.client_minute_rate_cents !== undefined) {
      const raw = sanitizedUpdates.client_minute_rate_cents;
      if (raw === null || raw === '') {
        sanitizedUpdates.client_minute_rate_cents = null;
      } else {
        const cents = Number(raw);
        if (!Number.isFinite(cents) || cents < 0) {
          return res.status(400).json({ error: 'client_minute_rate_cents must be a number >= 0' });
        }
        if (cents > 1000) {
          return res.status(400).json({ error: 'client_minute_rate_cents cannot exceed 1000 (10.00 per minute)' });
        }
        // Clamp to numeric(10,4): at most 4 decimal places of cents.
        sanitizedUpdates.client_minute_rate_cents = Math.round(cents * 10000) / 10000;
      }
    }

    // Validate the one-time client setup fee.
    // Stored in the agency's currency, in CENTS, as a whole integer. Range
    // guard: >= 0 and a sane ceiling of 1,000,000 cents (10,000.00) to catch a
    // fat-fingered value. Empty/null clears it (no setup fee). The frontend
    // collects dollars and multiplies by 100 before sending, so what arrives
    // here is already whole cents.
    if (sanitizedUpdates.setup_fee_cents !== undefined) {
      const raw = sanitizedUpdates.setup_fee_cents;
      if (raw === null || raw === '') {
        sanitizedUpdates.setup_fee_cents = null;
      } else {
        const cents = Number(raw);
        if (!Number.isInteger(cents) || cents < 0) {
          return res.status(400).json({ error: 'setup_fee_cents must be an integer of 0 or greater (in cents)' });
        }
        if (cents > 1000000) {
          return res.status(400).json({ error: 'setup_fee_cents cannot exceed 1000000 (10,000.00)' });
        }
        sanitizedUpdates.setup_fee_cents = cents;
      }
    }

    for (const field of ['included_minutes_starter', 'included_minutes_pro', 'included_minutes_growth']) {
      if (sanitizedUpdates[field] === undefined) continue;
      const raw = sanitizedUpdates[field];
      if (raw === null || raw === '') {
        sanitizedUpdates[field] = 0;
        continue;
      }
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        return res.status(400).json({ error: `${field} must be an integer >= 0` });
      }
      if (n > 100000) {
        return res.status(400).json({ error: `${field} cannot exceed 100000` });
      }
      sanitizedUpdates[field] = n;
    }

    // Validate branding_overrides structure if provided
    if (sanitizedUpdates.branding_overrides !== undefined) {
      const bo = sanitizedUpdates.branding_overrides;
      // Allow null (reset to defaults)
      if (bo !== null) {
        if (typeof bo !== 'object' || Array.isArray(bo)) {
          return res.status(400).json({ error: 'branding_overrides must be an object or null' });
        }
        const validKeys = [
          'nav_bg', 'nav_text', 'page_bg', 'card_bg', 'card_border',
          'button_text', 'text_primary', 'text_muted'
        ];
        // Strip any invalid keys
        const cleaned = {};
        for (const key of validKeys) {
          if (bo[key] !== undefined && bo[key] !== null) {
            // Validate hex color format
            if (typeof bo[key] === 'string' && /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(bo[key])) {
              cleaned[key] = bo[key];
            }
          }
        }
        // If all values were stripped, store null instead of empty object
        sanitizedUpdates.branding_overrides = Object.keys(cleaned).length > 0 ? cleaned : null;
      }
    }

    // Validate allow_client_branding if provided
    if (sanitizedUpdates.allow_client_branding !== undefined) {
      sanitizedUpdates.allow_client_branding = sanitizedUpdates.allow_client_branding === true;
    }

    // Validate client_header_mode if provided
    if (sanitizedUpdates.client_header_mode !== undefined && sanitizedUpdates.client_header_mode !== null) {
      if (!['agency_name', 'business_name'].includes(sanitizedUpdates.client_header_mode)) {
        return res.status(400).json({ error: 'Invalid client_header_mode. Must be agency_name or business_name' });
      }
    }

    // Validate require_card_for_trial if provided (coerce to strict boolean).
    // The card-required signup flow only actually engages when Stripe charges
    // are enabled; that AND is enforced at signup time in handleClientSignup,
    // so no cross-field check is needed here.
    if (sanitizedUpdates.require_card_for_trial !== undefined) {
      sanitizedUpdates.require_card_for_trial = sanitizedUpdates.require_card_for_trial === true;
    }
    
    // Validate display_currency if provided
    if (sanitizedUpdates.display_currency !== undefined) {
      const validCurrencies = [
        null, 'USD', 'GBP', 'EUR', 'CAD', 'AUD', 'NZD', 'JPY', 'CHF',
        'SGD', 'HKD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON',
        'BGN', 'BRL', 'MXN', 'INR', 'THB', 'MYR', 'AED'
      ];
      if (sanitizedUpdates.display_currency !== null && !validCurrencies.includes(sanitizedUpdates.display_currency)) {
        return res.status(400).json({ error: 'Invalid display_currency value' });
      }
    }
    
    // Validate plan_features structure if provided
    if (sanitizedUpdates.plan_features) {
      const pf = sanitizedUpdates.plan_features;
      const validPlans = ['starter', 'pro', 'growth'];
      
      let isValid = true;
      for (const plan of validPlans) {
        if (!pf[plan] || typeof pf[plan] !== 'object') {
          isValid = false;
          break;
        }
        // Validate feature values: booleans for toggles, numbers for team_members
        for (const feature of Object.keys(pf[plan])) {
          const val = pf[plan][feature];
          if (feature === 'team_members') {
            if (typeof val !== 'number' || val < 0) {
              isValid = false;
              break;
            }
          } else {
            if (typeof val !== 'boolean') {
              isValid = false;
              break;
            }
          }
        }
        if (!isValid) break;
      }
      
      if (!isValid) {
        return res.status(400).json({ error: 'Invalid plan_features structure' });
      }
    }
    
    // Validate calendar_enabled_plans if provided
    if (sanitizedUpdates.calendar_enabled_plans !== undefined) {
      const cep = sanitizedUpdates.calendar_enabled_plans;
      if (!Array.isArray(cep)) {
        return res.status(400).json({ error: 'calendar_enabled_plans must be an array' });
      }
      const validPlans = ['starter', 'pro', 'growth'];
      const allValid = cep.every(plan => validPlans.includes(plan));
      if (!allValid) {
        return res.status(400).json({ error: 'calendar_enabled_plans contains invalid plan names' });
      }
    }

    // Validate marketing_template if provided
    if (sanitizedUpdates.marketing_template !== undefined && sanitizedUpdates.marketing_template !== null) {
      const validTemplates = ['classic', 'beside', 'editorial', 'aurora'];
      if (!validTemplates.includes(sanitizedUpdates.marketing_template)) {
        return res.status(400).json({ error: 'Invalid marketing_template value' });
      }
    }

    // Validate custom_nav_links if provided. Array of { label, url }, max 5.
    // URLs are normalized: a bare domain (yourmainsite.com, www.yourmainsite.com)
    // is accepted and stored as https://...; an existing http:// or https:// is
    // kept as-is; anything that is not a valid http(s) URL after normalization
    // is rejected, which still blocks javascript:/data: and other unsafe schemes.
    if (sanitizedUpdates.custom_nav_links !== undefined) {
      const raw = sanitizedUpdates.custom_nav_links;
      if (raw === null) {
        sanitizedUpdates.custom_nav_links = [];
      } else if (!Array.isArray(raw)) {
        return res.status(400).json({ error: 'custom_nav_links must be an array' });
      } else if (raw.length > 5) {
        return res.status(400).json({ error: 'custom_nav_links cannot exceed 5 links' });
      } else {
        const cleaned = [];
        for (const item of raw) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            return res.status(400).json({ error: 'Each nav link must have a label and url' });
          }
          const label = typeof item.label === 'string' ? item.label.trim() : '';
          const url = typeof item.url === 'string' ? item.url.trim() : '';
          if (!label || !url) {
            return res.status(400).json({ error: 'Each nav link needs a label and a url' });
          }
          if (label.length > 30) {
            return res.status(400).json({ error: 'Nav link labels must be 30 characters or fewer' });
          }
          if (url.length > 500) {
            return res.status(400).json({ error: 'Nav link URLs must be 500 characters or fewer' });
          }
          // Accept a bare domain by assuming https:// when no http(s):// scheme
          // is present, so an agency can type "yourmainsite.com" or
          // "www.yourmainsite.com" without the prefix. A value that already has
          // http:// or https:// is left exactly as-is. After normalizing, reject
          // anything that still is not a valid http(s) URL: this keeps blocking
          // javascript: and data: links, which become unparseable once https://
          // is prepended and so are rejected.
          let normalizedUrl = url;
          if (!/^https?:\/\//i.test(normalizedUrl)) {
            normalizedUrl = `https://${normalizedUrl}`;
          }
          let parsedNav;
          try {
            parsedNav = new URL(normalizedUrl);
          } catch {
            return res.status(400).json({ error: 'Each nav link needs a valid web address, for example yourmainsite.com' });
          }
          if (parsedNav.protocol !== 'http:' && parsedNav.protocol !== 'https:') {
            return res.status(400).json({ error: 'Nav link URLs must be a web address (http or https).' });
          }
          cleaned.push({ label, url: normalizedUrl });
        }
        sanitizedUpdates.custom_nav_links = cleaned;
      }
    }

    // Validate GTM ID format if provided
    if (sanitizedUpdates.gtm_id !== undefined && sanitizedUpdates.gtm_id !== null && sanitizedUpdates.gtm_id !== '') {
      if (!/^GTM-[A-Z0-9]+$/i.test(sanitizedUpdates.gtm_id)) {
        return res.status(400).json({ error: 'Invalid GTM ID format. Expected GTM-XXXXXXX' });
      }
    }

    // Validate GA4 Measurement ID format if provided
    if (sanitizedUpdates.google_analytics_id !== undefined && sanitizedUpdates.google_analytics_id !== null && sanitizedUpdates.google_analytics_id !== '') {
      if (!/^G-[A-Z0-9]+$/i.test(sanitizedUpdates.google_analytics_id)) {
        return res.status(400).json({ error: 'Invalid GA4 Measurement ID format. Expected G-XXXXXXXXXX' });
      }
    }

    // Validate FB Pixel ID format if provided (numeric string)
    if (sanitizedUpdates.fb_pixel_id !== undefined && sanitizedUpdates.fb_pixel_id !== null && sanitizedUpdates.fb_pixel_id !== '') {
      if (!/^\d+$/.test(sanitizedUpdates.fb_pixel_id)) {
        return res.status(400).json({ error: 'Invalid Facebook Pixel ID format. Expected numeric ID.' });
      }
    }

    // Validate OG image URL if provided
    if (sanitizedUpdates.og_image_url !== undefined && sanitizedUpdates.og_image_url !== null && sanitizedUpdates.og_image_url !== '') {
      try {
        new URL(sanitizedUpdates.og_image_url);
      } catch {
        return res.status(400).json({ error: 'Invalid OG image URL format.' });
      }
    }

    // Sanitize custom scripts - basic length check (prevent abuse)
    if (sanitizedUpdates.custom_head_scripts !== undefined && sanitizedUpdates.custom_head_scripts !== null) {
      if (sanitizedUpdates.custom_head_scripts.length > 10000) {
        return res.status(400).json({ error: 'Custom head scripts too long (max 10,000 characters)' });
      }
    }
    if (sanitizedUpdates.custom_body_scripts !== undefined && sanitizedUpdates.custom_body_scripts !== null) {
      if (sanitizedUpdates.custom_body_scripts.length > 10000) {
        return res.status(400).json({ error: 'Custom body scripts too long (max 10,000 characters)' });
      }
    }
    
    // If marketing_domain changed, reset verification
    if (updates.marketing_domain !== undefined) {
      const { data: current } = await supabase
        .from('agencies')
        .select('marketing_domain')
        .eq('id', agencyId)
        .single();
      
      if (current?.marketing_domain !== updates.marketing_domain) {
        sanitizedUpdates.domain_verified = false;
      }
    }
    
    sanitizedUpdates.updated_at = new Date().toISOString();
    
    const { data: agency, error } = await supabase
      .from('agencies')
      .update(sanitizedUpdates)
      .eq('id', agencyId)
      .select()
      .single();
    
    if (error) {
      console.error('❌ Update error:', error);
      return res.status(500).json({ error: 'Failed to update settings' });
    }
    
    console.log('✅ Agency settings updated:', agency.name);

    // If the per-minute rate or any plan's included minutes changed, re-point
    // existing clients' metered items to a fresh price at the new values.
    // Stripe prices are immutable, so without this a rate change would only
    // apply to new signups and plan changes. Fired in the background: it hits
    // Stripe per client and must not block or fail the settings save. No-ops
    // when pass-through is off (the sweep checks minutePassThroughActive).
    const minuteFieldsTouched = ['client_minute_rate_cents', 'included_minutes_starter', 'included_minutes_pro', 'included_minutes_growth']
      .some((f) => f in sanitizedUpdates);
    if (minuteFieldsTouched) {
      repriceMinuteItemsForAgency(agencyId)
        .then((r) => {
          if (r?.ok) console.log(`Minute reprice sweep for ${agencyId}: repriced ${r.repriced}, attached ${r.attached}, skipped ${r.skipped}`);
        })
        .catch((e) => console.error('Minute reprice sweep failed (non-fatal):', e.message));
    }

    res.json({
      success: true,
      agency
    });
    
  } catch (error) {
    console.error('❌ Update agency settings error:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
}

// ============================================================================
// VERIFY CUSTOM DOMAIN (DNS Check)
// ============================================================================
async function verifyAgencyDomain(req, res) {
  try {
    const { agencyId } = req.params;
    
    const { data: agency, error } = await supabase
      .from('agencies')
      .select('marketing_domain')
      .eq('id', agencyId)
      .single();
    
    if (error || !agency?.marketing_domain) {
      return res.status(404).json({ 
        verified: false, 
        error: 'No custom domain configured' 
      });
    }
    
    const domain = agency.marketing_domain;
    const platformDomain = process.env.PLATFORM_DOMAIN || 'myvoiceaiconnect.com';
    const expectedCname = `cname.${platformDomain}`;
    
    console.log(`🔍 Verifying domain: ${domain}, expecting CNAME to: ${expectedCname}`);
    
    try {
      const records = await dns.resolveCname(domain);
      console.log(`📋 CNAME records found:`, records);
      
      const verified = records.some(record => 
        record.toLowerCase() === expectedCname.toLowerCase() ||
        record.toLowerCase().endsWith(`.${platformDomain.toLowerCase()}`) ||
        record.toLowerCase().includes('vercel')
      );
      
      if (verified) {
        await supabase
          .from('agencies')
          .update({ domain_verified: true, updated_at: new Date().toISOString() })
          .eq('id', agencyId);
        
        console.log(`✅ Domain verified: ${domain}`);
        
        return res.json({ 
          verified: true, 
          message: 'Domain verified successfully',
          cname_found: records[0]
        });
      } else {
        return res.json({ 
          verified: false, 
          message: `CNAME found but points to "${records[0]}", expected "${expectedCname}"`,
          cname_found: records[0],
          expected: expectedCname
        });
      }
    } catch (dnsError) {
      console.log(`⚠️ DNS lookup error for ${domain}:`, dnsError.code);
      
      try {
        const aRecords = await dns.resolve4(domain);
        console.log(`📋 A records found:`, aRecords);
        
        const vercelIps = ['76.76.21.21', '76.76.21.22', '76.76.21.93'];
        const hasVercelIp = aRecords.some(ip => vercelIps.includes(ip) || ip.startsWith('76.76.'));
        
        if (hasVercelIp) {
          await supabase
            .from('agencies')
            .update({ domain_verified: true, updated_at: new Date().toISOString() })
            .eq('id', agencyId);
          
          console.log(`✅ Domain verified via A record: ${domain}`);
          
          return res.json({
            verified: true,
            message: 'Domain verified via A record',
            a_record: aRecords[0]
          });
        }
      } catch (aError) {
        // No A records either
      }
      
      return res.json({ 
        verified: false, 
        message: 'DNS records not found. Changes can take up to 48 hours to propagate.',
        expected_cname: expectedCname,
        dns_error: dnsError.code
      });
    }
  } catch (error) {
    console.error('❌ Domain verification error:', error);
    return res.status(500).json({ 
      verified: false, 
      error: 'Failed to verify domain' 
    });
  }
}

// ============================================================================
// EXPORTS
// ============================================================================
module.exports = {
  getAgencyByHost,
  getAgencyByIdPublic,
  getAgencySettings,
  updateAgencySettings,
  verifyAgencyDomain
};
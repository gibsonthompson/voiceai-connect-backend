// ============================================================================
// GOOGLE CALENDAR AUTH - OAuth Connect/Disconnect/Callback
// Plan gating: agency decides which client plans get calendar access
// via the calendar_enabled_plans column on the agencies table.
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { updateAssistantCalendar } = require('../lib/calendar-tools');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CALENDAR_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CALENDAR_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
const BACKEND_URL = process.env.BACKEND_URL || 'https://urchin-app-bqb4i.ondigitalocean.app';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://myvoiceaiconnect.com';

const SCOPES = 'https://www.googleapis.com/auth/calendar.events';
const REDIRECT_URI = `${BACKEND_URL}/api/auth/google-calendar/callback`;

// ============================================================================
// PLAN GATING
// Checks if the client's plan_type is in the agency's calendar_enabled_plans.
// Each agency controls which of their client tiers get calendar access.
// Default: ['pro', 'growth'] — starter is the upsell.
// Agency configures this in their settings dashboard.
// ============================================================================
async function checkPlanAccess(clientId) {
  try {
    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('plan_type, agency_id, subscription_status, is_test_client')
      .eq('id', clientId)
      .single();

    if (clientError || !client) {
      return { allowed: false, reason: 'Client not found' };
    }

    // Test clients are a sandbox: calendar is always available so agencies can
    // explore the full feature set regardless of plan gating.
    if (client.is_test_client) return { allowed: true };

    const { data: agency, error: agencyError } = await supabase
      .from('agencies')
      .select('calendar_enabled_plans')
      .eq('id', client.agency_id)
      .single();

    if (agencyError || !agency) {
      return { allowed: false, reason: 'Agency not found' };
    }

    // Agency's configured list of client plans that include calendar
    // Default to pro + growth if agency hasn't configured it yet
    const enabledPlans = agency.calendar_enabled_plans || ['pro', 'growth'];

    const clientPlan = client.plan_type || 'starter';

    if (enabledPlans.includes(clientPlan)) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: 'Calendar integration is not included in your current plan. Please contact your provider about upgrading.'
    };
  } catch (err) {
    console.error('❌ Plan check error:', err);
    return { allowed: false, reason: 'Failed to check plan access' };
  }
}

// ============================================================================
// GET /api/auth/google-calendar/connect
// Initiates OAuth flow — called from client dashboard
// ============================================================================
router.get('/connect', async (req, res) => {
  try {
    const clientId = req.query.clientId;

    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' });
    }

    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      console.error('❌ Google Calendar credentials not configured');
      return res.status(500).json({ error: 'Google Calendar not configured' });
    }

    // Plan gating — does this client's plan include calendar?
    const planCheck = await checkPlanAccess(clientId);
    if (!planCheck.allowed) {
      console.log(`🚫 Calendar access denied for client ${clientId}: ${planCheck.reason}`);
      return res.redirect(`${FRONTEND_URL}/client/settings?error=plan_upgrade_required`);
    }

    // Store clientId in state param so we get it back in callback
    const state = Buffer.from(JSON.stringify({ clientId })).toString('base64url');

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', SCOPES);
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('state', state);

    console.log(`📅 Calendar OAuth initiated for client: ${clientId}`);
    res.redirect(authUrl.toString());
  } catch (error) {
    console.error('❌ Calendar OAuth initiation error:', error);
    res.status(500).json({ error: 'Failed to initiate calendar connection' });
  }
});

// ============================================================================
// GET /api/auth/google-calendar/callback
// Handles Google's OAuth redirect — exchanges code for tokens
// Then triggers VAPI assistant update to add calendar tools
// ============================================================================
router.get('/callback', async (req, res) => {
  try {
    const { code, state, error: oauthError } = req.query;

    let redirectBase = FRONTEND_URL;

    if (oauthError) {
      console.error('❌ OAuth error from Google:', oauthError);
      return res.redirect(`${redirectBase}/client/settings?error=calendar_denied`);
    }

    if (!code || !state) {
      return res.redirect(`${redirectBase}/client/settings?error=calendar_failed`);
    }

    // Decode state to get clientId
    let clientId;
    try {
      const stateDecoded = JSON.parse(Buffer.from(state, 'base64url').toString());
      clientId = stateDecoded.clientId;
    } catch (e) {
      console.error('❌ Failed to decode state:', e);
      return res.redirect(`${redirectBase}/client/settings?error=calendar_failed`);
    }

    if (!clientId) {
      return res.redirect(`${redirectBase}/client/settings?error=calendar_failed`);
    }

    // Exchange code for tokens
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text();
      console.error('❌ Token exchange failed:', errText);
      return res.redirect(`${redirectBase}/client/settings?error=calendar_token_failed`);
    }

    const tokens = await tokenResponse.json();
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

    console.log('✅ Google Calendar tokens received for client:', clientId);

    // Store tokens in client record
    const { error: updateError } = await supabase
      .from('clients')
      .update({
        google_calendar_connected: true,
        google_access_token: tokens.access_token,
        google_refresh_token: tokens.refresh_token || null,
        google_token_expires_at: expiresAt,
        google_calendar_id: 'primary',
        updated_at: new Date().toISOString(),
      })
      .eq('id', clientId);

    if (updateError) {
      console.error('❌ Database update error:', updateError);
      return res.redirect(`${redirectBase}/client/settings?error=calendar_db_error`);
    }

    // Get client's VAPI assistant ID to add calendar tools
    const { data: client } = await supabase
      .from('clients')
      .select('vapi_assistant_id, agency_id, agencies(slug)')
      .eq('id', clientId)
      .single();

    // Update VAPI assistant with calendar tools (non-blocking)
    if (client?.vapi_assistant_id) {
      updateAssistantCalendar(client.vapi_assistant_id, clientId, true)
        .then(result => {
          if (result.success) {
            console.log(`✅ VAPI assistant updated with calendar tools for client: ${clientId}`);
          } else {
            console.error(`❌ Failed to update VAPI assistant:`, result.error);
          }
        })
        .catch(err => console.error('❌ VAPI update error (non-blocking):', err));
    } else {
      console.warn(`⚠️ No VAPI assistant found for client ${clientId} — calendar tools not added`);
    }

    // Determine redirect URL based on agency slug
    if (client?.agencies?.slug) {
      redirectBase = `https://${client.agencies.slug}.myvoiceaiconnect.com`;
    }

    console.log(`✅ Google Calendar connected for client: ${clientId}`);
    res.redirect(`${redirectBase}/client/settings?success=calendar_connected`);
  } catch (error) {
    console.error('❌ Calendar callback error:', error);
    res.redirect(`${FRONTEND_URL}/client/settings?error=calendar_unknown`);
  }
});

// ============================================================================
// POST /api/auth/google-calendar/disconnect
// Disconnects Google Calendar — revokes token, clears DB, removes VAPI tools
// ============================================================================
router.post('/disconnect', async (req, res) => {
  try {
    const { clientId } = req.body;

    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' });
    }

    // Get current client data
    const { data: client } = await supabase
      .from('clients')
      .select('google_access_token, google_refresh_token, vapi_assistant_id')
      .eq('id', clientId)
      .single();

    // Revoke token with Google (best effort)
    if (client?.google_access_token) {
      try {
        await fetch(`https://oauth2.googleapis.com/revoke?token=${client.google_access_token}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        console.log('✅ Google token revoked');
      } catch (revokeErr) {
        console.warn('⚠️ Token revocation failed (non-blocking):', revokeErr.message);
      }
    }

    // Clear all calendar data from client record
    const { error: updateError } = await supabase
      .from('clients')
      .update({
        google_calendar_connected: false,
        google_access_token: null,
        google_refresh_token: null,
        google_token_expires_at: null,
        google_calendar_id: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', clientId);

    if (updateError) {
      console.error('❌ DB update error:', updateError);
      return res.status(500).json({ error: 'Failed to disconnect' });
    }

    // Remove calendar tools from VAPI assistant (non-blocking)
    if (client?.vapi_assistant_id) {
      updateAssistantCalendar(client.vapi_assistant_id, clientId, false)
        .then(result => {
          if (result.success) {
            console.log(`✅ Calendar tools removed from VAPI assistant for client: ${clientId}`);
          }
        })
        .catch(err => console.error('❌ VAPI update error (non-blocking):', err));
    }

    console.log(`✅ Google Calendar disconnected for client: ${clientId}`);
    res.json({ success: true, message: 'Calendar disconnected' });
  } catch (error) {
    console.error('❌ Calendar disconnect error:', error);
    res.status(500).json({ error: 'Failed to disconnect calendar' });
  }
});

// ============================================================================
// GET /api/auth/google-calendar/status/:clientId
// Check calendar connection status + plan access (used by frontend)
// Frontend uses this to decide:
//   - plan_allowed=false → show "Upgrade to unlock" message
//   - plan_allowed=true, connected=false → show "Connect Calendar" button
//   - plan_allowed=true, connected=true → show "Disconnect" button
// ============================================================================
router.get('/status/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;

    const { data: client, error } = await supabase
      .from('clients')
      .select('google_calendar_connected, google_token_expires_at')
      .eq('id', clientId)
      .single();

    if (error || !client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    // Check if this client's plan allows calendar
    const planCheck = await checkPlanAccess(clientId);

    res.json({
      connected: client.google_calendar_connected || false,
      token_valid: client.google_token_expires_at
        ? new Date(client.google_token_expires_at) > new Date()
        : false,
      plan_allowed: planCheck.allowed,
      plan_message: planCheck.allowed ? null : planCheck.reason,
    });
  } catch (error) {
    console.error('❌ Calendar status error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
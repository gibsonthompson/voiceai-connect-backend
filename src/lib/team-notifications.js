// ============================================================================
// TEAM NOTIFICATIONS - Send call alerts to team members
// Destination: src/lib/team-notifications.js
//
// Usage in VAPI webhook (after existing sendCallNotificationSMS):
//   const { notifyTeamMembers } = require('./lib/team-notifications');
//   await notifyTeamMembers(client.id, callData, agency);
//
// UPDATED: 2026-08-06 - Team SMS now routes through sendAndLogSMS with the
//          agency id instead of raw sendTelnyxSMS. Raw Telnyx sends from the US
//          platform number, which UK (and other non-US) carriers block, so team
//          members under a non-US BYOT agency never received their alerts.
//          Routing through sendAndLogSMS sends those from the agency's own
//          Twilio; US agencies still fall through to platform Telnyx unchanged.
//          Every team alert is now also written to sms_log.
// UPDATED: 2026-08-12 - Removed the client-facing team EMAIL branch (white-label
//          integrity: it sent from notifications@myvoiceaiconnect.com, leaking
//          the platform brand to a client's team). Team members are still
//          notified by agency-branded SMS. The unused sendEmail import, the
//          email preference key, and the users email join were dropped with it.
// ============================================================================
const { supabase } = require('./supabase');
const { formatPhoneDisplay } = require('./notifications');
const { sendAndLogSMS } = require('./sms-logger');

/**
 * Send call notifications to all team members who have opted in.
 * Checks notification_prefs for sms_new_call, sms_missed_call.
 *
 * @param {string} clientId - The client whose call this is
 * @param {object} callData - { customerName, customerPhone, urgency, summary, missed }
 * @param {object} agency - Agency object (for branding in messages)
 */
async function notifyTeamMembers(clientId, callData, agency) {
  try {
    // Fetch all active team members for this client who have any notification enabled
    const { data: members, error } = await supabase
      .from('team_members')
      .select('id, display_name, phone, notification_prefs, member_user_id')
      .eq('entity_type', 'client')
      .eq('entity_id', clientId)
      .eq('status', 'active');

    if (error || !members || members.length === 0) return;

    const { customerName, customerPhone, urgency, summary, missed } = callData;
    const brandName = agency?.name || 'AI Receptionist';

    // Determine which notification key to check
    const smsKey = missed ? 'sms_missed_call' : 'sms_new_call';

    for (const member of members) {
      const prefs = member.notification_prefs || {};

      // SMS notification
      if (prefs[smsKey] && member.phone) {
        try {
          let smsMessage = missed
            ? `📵 Missed Call - ${brandName}\n`
            : `🔔 New Call - ${brandName}\n`;

          smsMessage += `Caller: ${customerName || 'Unknown'}\n`;
          smsMessage += `Phone: ${formatPhoneDisplay(customerPhone) || customerPhone || 'Unknown'}\n`;

          if (urgency === 'high' || urgency === 'emergency') {
            smsMessage += `⚠️ Urgency: HIGH\n`;
          }

          if (summary) {
            // Truncate summary for SMS
            const shortSummary = summary.length > 120 ? summary.substring(0, 117) + '...' : summary;
            smsMessage += `Summary: ${shortSummary}`;
          }

          // Route through sendAndLogSMS so a non-US BYOT agency sends from its
          // own Twilio (US carriers block the platform Telnyx number for UK).
          // US agencies fall through to platform Telnyx unchanged.
          await sendAndLogSMS({
            phone: member.phone,
            message: smsMessage,
            agencyId: agency?.id,
            recipientType: 'team_member',
            messageType: missed ? 'team_missed_call' : 'team_new_call',
            metadata: { clientId, teamMemberId: member.id, entity: 'client' },
          });
          console.log(`📱 Team SMS (${smsKey}) sent to ${member.display_name}`);
        } catch (err) {
          console.error(`⚠️ Team SMS failed for ${member.display_name}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error('❌ notifyTeamMembers error:', err.message);
  }
}

/**
 * Send call notifications to agency team members (for agency-level alerts).
 * Same pattern but queries agency team members instead of client team members.
 */
async function notifyAgencyTeamMembers(agencyId, clientName, callData) {
  try {
    const { data: members, error } = await supabase
      .from('team_members')
      .select('id, display_name, phone, notification_prefs')
      .eq('entity_type', 'agency')
      .eq('entity_id', agencyId)
      .eq('status', 'active');

    if (error || !members || members.length === 0) return;

    const { customerName, customerPhone, urgency, summary } = callData;

    for (const member of members) {
      const prefs = member.notification_prefs || {};

      if (prefs.sms_new_call && member.phone) {
        try {
          let msg = `🔔 New Call - ${clientName}\n`;
          msg += `Caller: ${customerName || 'Unknown'}\n`;
          msg += `Phone: ${formatPhoneDisplay(customerPhone) || 'Unknown'}`;
          if (urgency === 'high' || urgency === 'emergency') msg += `\n⚠️ HIGH URGENCY`;

          await sendAndLogSMS({
            phone: member.phone,
            message: msg,
            agencyId,
            recipientType: 'team_member',
            messageType: 'agency_team_new_call',
            metadata: { agencyId, teamMemberId: member.id, entity: 'agency', clientName },
          });
          console.log(`📱 Agency team SMS sent to ${member.display_name}`);
        } catch (err) {
          console.error(`⚠️ Agency team SMS failed for ${member.display_name}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error('❌ notifyAgencyTeamMembers error:', err.message);
  }
}

module.exports = {
  notifyTeamMembers,
  notifyAgencyTeamMembers,
};
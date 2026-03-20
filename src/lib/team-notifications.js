// ============================================================================
// TEAM NOTIFICATIONS — Send call alerts to team members
// Destination: src/lib/team-notifications.js (NEW FILE)
// 
// Usage in VAPI webhook (after existing sendCallNotificationSMS):
//   const { notifyTeamMembers } = require('./lib/team-notifications');
//   await notifyTeamMembers(client.id, callData, agency);
// ============================================================================
const { supabase } = require('./supabase');
const { sendTelnyxSMS, sendEmail, formatPhoneDisplay } = require('./notifications');

/**
 * Send call notifications to all team members who have opted in.
 * Checks notification_prefs for sms_new_call, sms_missed_call, email_new_call.
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
      .select('id, display_name, phone, notification_prefs, member_user_id, users:member_user_id (email)')
      .eq('entity_type', 'client')
      .eq('entity_id', clientId)
      .eq('status', 'active');

    if (error || !members || members.length === 0) return;

    const { customerName, customerPhone, urgency, summary, missed } = callData;
    const brandName = agency?.name || 'AI Receptionist';

    // Determine which notification key to check
    const smsKey = missed ? 'sms_missed_call' : 'sms_new_call';
    const emailKey = 'email_new_call';

    for (const member of members) {
      const prefs = member.notification_prefs || {};

      // SMS notification
      if (prefs[smsKey] && member.phone) {
        try {
          let smsMessage = missed
            ? `📵 Missed Call — ${brandName}\n`
            : `🔔 New Call — ${brandName}\n`;

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

          await sendTelnyxSMS(member.phone, smsMessage);
          console.log(`📱 Team SMS (${smsKey}) sent to ${member.display_name}`);
        } catch (err) {
          console.error(`⚠️ Team SMS failed for ${member.display_name}:`, err.message);
        }
      }

      // Email notification
      if (prefs[emailKey] && member.users?.email) {
        try {
          const urgencyLabel = (urgency === 'high' || urgency === 'emergency') ? ' ⚠️ URGENT' : '';
          await sendEmail({
            from: `${brandName} <notifications@myvoiceaiconnect.com>`,
            to: member.users.email,
            subject: `${missed ? 'Missed Call' : 'New Call'}${urgencyLabel} — ${customerName || 'Unknown Caller'}`,
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
                <h2 style="color: #111; margin-bottom: 16px;">${missed ? '📵 Missed Call' : '🔔 New Call'}</h2>
                <table style="width: 100%; border-collapse: collapse;">
                  <tr><td style="padding: 8px 0; color: #666; width: 80px;">Caller</td><td style="padding: 8px 0; font-weight: 600;">${customerName || 'Unknown'}</td></tr>
                  <tr><td style="padding: 8px 0; color: #666;">Phone</td><td style="padding: 8px 0;"><a href="tel:${customerPhone}">${formatPhoneDisplay(customerPhone) || customerPhone || 'Unknown'}</a></td></tr>
                  ${urgency ? `<tr><td style="padding: 8px 0; color: #666;">Urgency</td><td style="padding: 8px 0; ${(urgency === 'high' || urgency === 'emergency') ? 'color: #dc2626; font-weight: 600;' : ''}">${urgency}</td></tr>` : ''}
                </table>
                ${summary ? `<div style="margin-top: 16px; padding: 12px; background: #f9fafb; border-radius: 8px;"><p style="margin: 0; font-size: 14px; color: #444;">${summary}</p></div>` : ''}
                <p style="margin-top: 20px; font-size: 12px; color: #999;">Sent by ${brandName}</p>
              </div>
            `
          });
          console.log(`📧 Team email (${emailKey}) sent to ${member.display_name}`);
        } catch (err) {
          console.error(`⚠️ Team email failed for ${member.display_name}:`, err.message);
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
          let msg = `🔔 New Call — ${clientName}\n`;
          msg += `Caller: ${customerName || 'Unknown'}\n`;
          msg += `Phone: ${formatPhoneDisplay(customerPhone) || 'Unknown'}`;
          if (urgency === 'high' || urgency === 'emergency') msg += `\n⚠️ HIGH URGENCY`;

          await sendTelnyxSMS(member.phone, msg);
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
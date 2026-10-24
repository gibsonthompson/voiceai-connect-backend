// ============================================================================
// WORKFLOW TEMPLATES - the starter recipes
//
// The blank canvas is the #1 reason non-technical agency staff abandon a
// workflow builder, so a workflow is never created from zero: it is cloned from
// one of these. Each is grounded in signals the receptionist already produces
// (followup_outcome, appointment_booked, caller_spoke), which is the thing
// GoHighLevel cannot do.
//
// All four use only BASIC nodes (send_sms / wait / condition / end), so they
// are available on Pro. Scale-only variants (ai_sms grounded in the business
// KB) come later as alternate node swaps.
//
// Message copy: no links (A2P deliverability), no em-dashes, plain human voice,
// first name only. Tokens are whitelisted in workflow-nodes.js.
// ============================================================================

// Trigger config keys the engine understands (see workflow-triggers.js):
//   followup_outcome_in : string[]  - only these call outcomes enroll
//   require_caller_spoke: bool       - skip silent/robocall hang-ups
//   exclude_spam        : bool       - skip calls flagged spam
//   require_booked      : bool       - only when an appointment was booked

const TEMPLATES = {
  // -------------------------------------------------------------------------
  // 1. Missed-call / unresolved-call follow-up
  // The receptionist answered, but the caller wanted a human, left a message,
  // asked for a callback, or hung up mid-need. Text them back right away, then
  // nudge once the next day if they never replied or booked.
  // -------------------------------------------------------------------------
  missed_call_followup: {
    key: 'missed_call_followup',
    name: 'Missed-call follow-up',
    description: 'Texts the caller back when they wanted a human, left a message, or hung up before we resolved it, then nudges once the next day.',
    tier: 'basic',
    trigger_type: 'call.completed',
    trigger_config: {
      followup_outcome_in: ['callback_requested', 'unanswered', 'abandoned', 'message'],
      require_caller_spoke: true,
      exclude_spam: true,
    },
    stop_on: { reply: true, booked: true },
    entry_rules: { reenroll: false, cooldown_hours: 24 },
    graph: {
      nodes: [
        { id: 'trigger', type: 'trigger', data: {} },
        { id: 's1', type: 'send_sms', data: {
          // Immediate acknowledgement: a reply to a call they just made is
          // expected, so this one does not wait for daytime quiet hours.
          respect_quiet_hours: false,
          message: "Hi {{first_name}}, sorry we couldn't finish up on the phone just now. This is {{business_name}}. How can we help? Reply here and we'll get right back to you.",
        } },
        { id: 'w1', type: 'wait', data: { minutes: 1440 } },
        { id: 's2', type: 'send_sms', data: {
          message: "Hi {{first_name}}, just following up from {{business_name}}. We're still happy to help whenever you're ready, just reply here.",
        } },
        { id: 'done', type: 'end', data: {} },
      ],
      edges: [
        { source: 'trigger', target: 's1' },
        { source: 's1', target: 'w1' },
        { source: 'w1', target: 's2' },
        { source: 's2', target: 'done' },
      ],
    },
  },

  // -------------------------------------------------------------------------
  // 2. Post-call follow-up
  // Any real (non-spam) call where the caller spoke. A short thank-you a little
  // while later that invites a reply, which opens the two-way thread.
  // -------------------------------------------------------------------------
  post_call_followup: {
    key: 'post_call_followup',
    name: 'Post-call follow-up',
    description: 'Sends a short thank-you after any real call and invites the caller to reply with anything else.',
    tier: 'basic',
    trigger_type: 'call.completed',
    trigger_config: {
      require_caller_spoke: true,
      exclude_spam: true,
    },
    stop_on: { reply: true },
    entry_rules: { reenroll: false, cooldown_hours: 24 },
    graph: {
      nodes: [
        { id: 'trigger', type: 'trigger', data: {} },
        { id: 'w1', type: 'wait', data: { minutes: 120 } },
        { id: 's1', type: 'send_sms', data: {
          message: "Thanks for calling {{business_name}}, {{first_name}}. If there's anything else we can help with, just reply here.",
        } },
        { id: 'done', type: 'end', data: {} },
      ],
      edges: [
        { source: 'trigger', target: 'w1' },
        { source: 'w1', target: 's1' },
        { source: 's1', target: 'done' },
      ],
    },
  },

  // -------------------------------------------------------------------------
  // 3. Appointment confirmation
  // Fires the moment an appointment is booked. Phase 0 sends an immediate
  // confirmation; timed "day before" reminders arrive in Phase 1 once
  // appointment_time is structured rather than free text.
  // -------------------------------------------------------------------------
  appointment_confirmation: {
    key: 'appointment_confirmation',
    name: 'Appointment confirmation',
    description: 'Texts a confirmation the moment an appointment is booked.',
    tier: 'basic',
    trigger_type: 'appointment.booked',
    trigger_config: {},
    stop_on: {},
    entry_rules: { reenroll: true, cooldown_hours: 0 },
    graph: {
      nodes: [
        { id: 'trigger', type: 'trigger', data: {} },
        { id: 's1', type: 'send_sms', data: {
          respect_quiet_hours: false,
          message: "You're booked with {{business_name}}, {{first_name}}. Reply here if you need to change anything. See you soon!",
        } },
        { id: 'done', type: 'end', data: {} },
      ],
      edges: [
        { source: 'trigger', target: 's1' },
        { source: 's1', target: 'done' },
      ],
    },
  },

  // -------------------------------------------------------------------------
  // 4. Review request
  // A day after a handled call where an appointment was booked, ask for a
  // review. One message, no stop condition (it is a single touch).
  // -------------------------------------------------------------------------
  review_request: {
    key: 'review_request',
    name: 'Review request',
    description: 'A day after a booked call, asks the customer for a quick review.',
    tier: 'basic',
    trigger_type: 'call.completed',
    trigger_config: {
      require_booked: true,
      exclude_spam: true,
    },
    stop_on: {},
    entry_rules: { reenroll: false, cooldown_hours: 168 },
    graph: {
      nodes: [
        { id: 'trigger', type: 'trigger', data: {} },
        { id: 'w1', type: 'wait', data: { minutes: 1440 } },
        { id: 's1', type: 'send_sms', data: {
          message: "Hi {{first_name}}, thanks for choosing {{business_name}}. If we did a good job, would you mind leaving us a quick review? It really helps us out.",
        } },
        { id: 'done', type: 'end', data: {} },
      ],
      edges: [
        { source: 'trigger', target: 'w1' },
        { source: 'w1', target: 's1' },
        { source: 's1', target: 'done' },
      ],
    },
  },

  appointment_reminder: {
    key: 'appointment_reminder',
    name: 'Appointment reminders',
    description: 'Texts the customer a reminder the day before, then again a couple of hours before their appointment.',
    tier: 'basic',
    subject: 'customer',
    trigger_type: 'appointment.booked',
    trigger_config: {},
    stop_on: {},
    entry_rules: { reenroll: true, cooldown_hours: 0 },
    graph: {
      nodes: [
        { id: 'trigger', type: 'trigger', data: {} },
        { id: 'r1', type: 'reminder', data: { anchor: 'appointment_time', direction: 'before', amount: 1, unit: 'days' } },
        { id: 's1', type: 'send_sms', data: {
          respect_quiet_hours: false,
          message: 'Reminder: your appointment with {{business_name}} is {{appointment_time}}. Reply here if you need to reschedule.',
        } },
        { id: 'r2', type: 'reminder', data: { anchor: 'appointment_time', direction: 'before', amount: 2, unit: 'hours' } },
        { id: 's2', type: 'send_sms', data: {
          respect_quiet_hours: false,
          message: 'See you soon, {{first_name}}! Your {{business_name}} appointment is {{appointment_time}}.',
        } },
        { id: 'done', type: 'end', data: {} },
      ],
      edges: [
        { source: 'trigger', target: 'r1' },
        { source: 'r1', target: 's1' },
        { source: 's1', target: 'r2' },
        { source: 'r2', target: 's2' },
        { source: 's2', target: 'done' },
      ],
    },
  },

  // -------------------------------------------------------------------------
  // ACCOUNT / BILLING automations. The subject is the BUSINESS, so a Send SMS
  // here texts the business OWNER, not a customer. These run on your own
  // billing/lifecycle events, not on calls.
  // -------------------------------------------------------------------------
  payment_failed_dunning: {
    key: 'payment_failed_dunning',
    name: 'Payment failed follow-up',
    description: "Texts the business owner when their payment fails, then reminds them a few days later if it's still unpaid.",
    tier: 'basic',
    subject: 'account',
    trigger_type: 'client.payment_failed',
    trigger_config: {},
    stop_on: {},
    entry_rules: { reenroll: true, cooldown_hours: 24 },
    graph: {
      nodes: [
        { id: 'trigger', type: 'trigger', data: {} },
        { id: 's1', type: 'send_sms', data: {
          respect_quiet_hours: false,
          message: "Hi {{first_name}}, your payment for {{business_name}} didn't go through. Please update your payment method to keep your AI receptionist active.",
        } },
        { id: 'w1', type: 'wait', data: { minutes: 4320 } },
        { id: 's2', type: 'send_sms', data: {
          message: "Hi {{first_name}}, just a reminder that your {{business_name}} payment is still failing. Update your card to avoid any interruption to your receptionist.",
        } },
        { id: 'done', type: 'end', data: {} },
      ],
      edges: [
        { source: 'trigger', target: 's1' },
        { source: 's1', target: 'w1' },
        { source: 'w1', target: 's2' },
        { source: 's2', target: 'done' },
      ],
    },
  },

  client_winback: {
    key: 'client_winback',
    name: 'Win back a canceled client',
    description: 'Texts the business owner when they cancel, inviting them to come back.',
    tier: 'basic',
    subject: 'account',
    trigger_type: 'client.canceled',
    trigger_config: {},
    stop_on: {},
    entry_rules: { reenroll: true, cooldown_hours: 0 },
    graph: {
      nodes: [
        { id: 'trigger', type: 'trigger', data: {} },
        { id: 's1', type: 'send_sms', data: {
          respect_quiet_hours: false,
          message: "Sorry to see {{business_name}} go, {{first_name}}. If you change your mind, just reply here and we'll get your AI receptionist back up and running.",
        } },
        { id: 'done', type: 'end', data: {} },
      ],
      edges: [
        { source: 'trigger', target: 's1' },
        { source: 's1', target: 'done' },
      ],
    },
  },

  new_client_welcome: {
    key: 'new_client_welcome',
    name: 'New client welcome',
    description: 'Texts the business owner the moment their subscription activates, so they feel taken care of from day one.',
    tier: 'basic',
    subject: 'account',
    trigger_type: 'client.subscription_activated',
    trigger_config: {},
    stop_on: {},
    entry_rules: { reenroll: false, cooldown_hours: 0 },
    graph: {
      nodes: [
        { id: 'trigger', type: 'trigger', data: {} },
        { id: 's1', type: 'send_sms', data: {
          respect_quiet_hours: false,
          message: "Welcome aboard, {{first_name}}! Your AI receptionist for {{business_name}} is live and answering calls. Reply here anytime you need a hand.",
        } },
        { id: 'done', type: 'end', data: {} },
      ],
      edges: [
        { source: 'trigger', target: 's1' },
        { source: 's1', target: 'done' },
      ],
    },
  },

  trial_ending_upsell: {
    key: 'trial_ending_upsell',
    name: 'Trial ended upsell',
    description: 'Texts the business owner when their trial ends, nudging them to upgrade before they lose the receptionist.',
    tier: 'basic',
    subject: 'account',
    trigger_type: 'client.trial_expired',
    trigger_config: {},
    stop_on: {},
    entry_rules: { reenroll: false, cooldown_hours: 0 },
    graph: {
      nodes: [
        { id: 'trigger', type: 'trigger', data: {} },
        { id: 's1', type: 'send_sms', data: {
          respect_quiet_hours: false,
          message: "Hi {{first_name}}, your {{business_name}} trial just ended, so your AI receptionist has paused. Upgrade to switch it back on. Reply here and I'll help you get set up.",
        } },
        { id: 'done', type: 'end', data: {} },
      ],
      edges: [
        { source: 'trigger', target: 's1' },
        { source: 's1', target: 'done' },
      ],
    },
  },
};

function getTemplate(key) {
  return TEMPLATES[key] || null;
}

function listTemplates() {
  return Object.values(TEMPLATES).map((t) => ({
    key: t.key, name: t.name, description: t.description, tier: t.tier, trigger_type: t.trigger_type, subject: t.subject || 'customer',
  }));
}

module.exports = { TEMPLATES, getTemplate, listTemplates };

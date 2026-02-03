// ============================================================================
// DEFAULT TEMPLATES - Seed templates for new agencies
// VoiceAI Connect
// ============================================================================
const { supabase } = require('./supabase');

// Default templates - NO 'category' column (doesn't exist in schema)
const DEFAULT_TEMPLATES = [
  // ==================== EMAIL TEMPLATES ====================
  {
    name: 'Initial Outreach',
    description: 'First contact with a new lead - friendly, value-focused',
    type: 'email',
    subject: 'Quick question about {lead_business_name}',
    body: `Hi {lead_contact_first_name},

I came across {lead_business_name} and noticed you're doing great work in the {lead_industry} space.

Quick question - how are you currently handling after-hours calls and missed calls during busy periods?

I work with {lead_industry} businesses to make sure they never miss a lead. Our AI receptionist answers every call 24/7, books appointments, and sounds completely natural - callers can't tell the difference.

Would you be open to a quick 10-minute call to see if it might be a fit?

Best,
{agency_owner_name}
{agency_name}
{agency_phone}`,
    is_default: false, // Will be owned by agency, not global
    is_follow_up: false,
    sequence_name: 'initial_sequence',
    sequence_order: 1,
    delay_days: 0
  },
  {
    name: 'Follow-up #1 - Value Add',
    description: 'First follow-up - share a specific benefit or testimonial',
    type: 'email',
    subject: 'Following up - {lead_business_name}',
    body: `Hi {lead_contact_first_name},

I wanted to follow up on my note about AI receptionists for {lead_business_name}.

Here's what one of our {lead_industry} clients told us last month:

"We were missing about 30% of our calls. Now we capture every single one, and the AI books appointments directly into our calendar. It paid for itself in the first week."

I'd love to show you how it works - takes about 10 minutes and there's zero obligation.

Would tomorrow or Thursday work for a quick call?

{agency_owner_name}
{agency_name}`,
    is_default: false,
    is_follow_up: true,
    sequence_name: 'initial_sequence',
    sequence_order: 2,
    delay_days: 3
  },
  {
    name: 'Follow-up #2 - Social Proof',
    description: 'Second follow-up - ROI focused with statistics',
    type: 'email',
    subject: 'Real numbers from {lead_industry} businesses',
    body: `Hi {lead_contact_first_name},

I know you're busy running {lead_business_name}, so I'll keep this short.

Here's what we're seeing with {lead_industry} businesses using our AI receptionist:

- 40% increase in booked appointments
- Zero missed calls (even at 2am)
- Average ROI of 5x in the first 90 days

If you're curious, I can show you exactly how it works in under 10 minutes. No pressure, no long sales pitch.

Just reply "interested" and I'll send over a few time options.

{agency_owner_name}
{agency_phone}`,
    is_default: false,
    is_follow_up: true,
    sequence_name: 'initial_sequence',
    sequence_order: 3,
    delay_days: 4
  },
  {
    name: 'Follow-up #3 - Direct Ask',
    description: 'Third follow-up - more direct approach',
    type: 'email',
    subject: 'One more thing - {lead_business_name}',
    body: `Hi {lead_contact_first_name},

I've reached out a couple times about helping {lead_business_name} capture more calls and book more appointments.

I don't want to keep filling up your inbox, so I'll ask directly:

Is this something you'd like to explore, or should I check back in a few months?

Either way is totally fine - just let me know and I'll adjust accordingly.

{agency_owner_name}
{agency_name}`,
    is_default: false,
    is_follow_up: true,
    sequence_name: 'initial_sequence',
    sequence_order: 4,
    delay_days: 5
  },
  {
    name: 'Break-up Email',
    description: 'Final attempt - creates urgency through scarcity',
    type: 'email',
    subject: 'Closing your file - {lead_business_name}',
    body: `Hi {lead_contact_first_name},

I've tried to connect a few times about AI receptionists for {lead_business_name}, but I haven't heard back.

No worries at all - I know timing is everything.

I'm going to close out my notes on this for now. If you ever want to explore how to capture more calls and book more appointments on autopilot, just reply to this email and I'll be here.

Wishing you and {lead_business_name} continued success.

Best,
{agency_owner_name}
{agency_name}`,
    is_default: false,
    is_follow_up: true,
    sequence_name: 'initial_sequence',
    sequence_order: 5,
    delay_days: 7
  },
  {
    name: 'Referral Introduction',
    description: 'When you get a warm referral from an existing client',
    type: 'email',
    subject: '{lead_contact_first_name} - [Referrer Name] suggested I reach out',
    body: `Hi {lead_contact_first_name},

[Referrer Name] mentioned you might be interested in learning about AI receptionists for {lead_business_name}.

We've been helping them capture more calls and book appointments automatically - they thought it might be valuable for you too.

The short version: our AI answers your calls 24/7, handles common questions, and books appointments directly into your calendar. Callers think they're talking to a real person.

Would you have 10 minutes this week to see how it works?

Best,
{agency_owner_name}
{agency_name}
{agency_phone}`,
    is_default: false,
    is_follow_up: false,
    sequence_name: null,
    sequence_order: null,
    delay_days: null
  },
  {
    name: 'Post-Demo Follow-up',
    description: 'After showing a demo - move toward close',
    type: 'email',
    subject: 'Next steps for {lead_business_name}',
    body: `Hi {lead_contact_first_name},

Great chatting with you today about {lead_business_name}!

As promised, here's a quick recap:

- Your AI receptionist will answer calls 24/7
- It'll handle FAQs, book appointments, and take messages
- Setup takes about 24-48 hours
- You can try it risk-free for 7 days

Ready to get started? Just reply "let's do it" and I'll send over the signup link.

Or if you have any questions, I'm happy to jump on another quick call.

{agency_owner_name}
{agency_phone}`,
    is_default: false,
    is_follow_up: false,
    sequence_name: null,
    sequence_order: null,
    delay_days: null
  },
  {
    name: 'Re-engagement - Past Lead',
    description: 'Reaching back out to cold leads after some time',
    type: 'email',
    subject: 'Still missing calls at {lead_business_name}?',
    body: `Hi {lead_contact_first_name},

We chatted a while back about AI receptionists for {lead_business_name}, but the timing wasn't right.

A lot has changed since then - our AI is even smarter, setup is faster, and we're seeing incredible results with {lead_industry} businesses.

If missed calls or after-hours inquiries are still a pain point, I'd love to show you what's new.

Worth a quick 10-minute call?

{agency_owner_name}
{agency_name}`,
    is_default: false,
    is_follow_up: false,
    sequence_name: null,
    sequence_order: null,
    delay_days: null
  },

  // ==================== SMS TEMPLATES ====================
  {
    name: 'SMS - Initial Outreach',
    description: 'First SMS contact - short and direct',
    type: 'sms',
    subject: null,
    body: `Hi {lead_contact_first_name}, this is {agency_owner_name} from {agency_name}. I help {lead_industry} businesses like {lead_business_name} never miss a call with AI receptionists. Worth a quick chat? Let me know!`,
    is_default: false,
    is_follow_up: false,
    sequence_name: 'sms_sequence',
    sequence_order: 1,
    delay_days: 0
  },
  {
    name: 'SMS - Follow-up',
    description: 'SMS follow-up after no response',
    type: 'sms',
    subject: null,
    body: `Hi {lead_contact_first_name}, following up on my message about AI receptionists for {lead_business_name}. Our clients see 40% more booked appointments. Quick call this week? - {agency_owner_name}`,
    is_default: false,
    is_follow_up: true,
    sequence_name: 'sms_sequence',
    sequence_order: 2,
    delay_days: 2
  },
  {
    name: 'SMS - After Voicemail',
    description: 'Send after leaving a voicemail',
    type: 'sms',
    subject: null,
    body: `Hi {lead_contact_first_name}, just left you a voicemail about AI receptionists for {lead_business_name}. Happy to answer any questions via text if that's easier! - {agency_owner_name}`,
    is_default: false,
    is_follow_up: false,
    sequence_name: null,
    sequence_order: null,
    delay_days: null
  },
  {
    name: 'SMS - Demo Reminder',
    description: 'Remind about scheduled demo call',
    type: 'sms',
    subject: null,
    body: `Hi {lead_contact_first_name}! Just a reminder about our call today at [TIME]. Looking forward to showing you how AI receptionists can help {lead_business_name}. Talk soon! - {agency_owner_name}`,
    is_default: false,
    is_follow_up: false,
    sequence_name: null,
    sequence_order: null,
    delay_days: null
  },
  {
    name: 'SMS - Quick Question',
    description: 'Casual check-in to start a conversation',
    type: 'sms',
    subject: null,
    body: `Hey {lead_contact_first_name}, quick question - how many calls does {lead_business_name} miss per week? Just curious if our AI receptionist could help. - {agency_owner_name}`,
    is_default: false,
    is_follow_up: false,
    sequence_name: null,
    sequence_order: null,
    delay_days: null
  }
];

/**
 * Seed default templates for an agency if they don't have any
 * @param {string} agencyId - The agency ID to seed templates for
 * @returns {Promise<{success: boolean, count?: number, skipped?: boolean, error?: string}>}
 */
async function seedDefaultTemplatesIfNeeded(agencyId) {
  try {
    // Check if agency already has templates
    const { data: existingTemplates, error: checkError } = await supabase
      .from('outreach_templates')
      .select('id')
      .eq('agency_id', agencyId)
      .limit(1);

    if (checkError) {
      console.error('Error checking existing templates:', checkError);
      return { success: false, error: checkError.message };
    }

    // If templates exist, skip seeding
    if (existingTemplates && existingTemplates.length > 0) {
      console.log(`⏭️ Agency ${agencyId} already has templates, skipping seed`);
      return { success: true, skipped: true };
    }

    // Add agency_id to each template
    const templatesToInsert = DEFAULT_TEMPLATES.map(template => ({
      ...template,
      agency_id: agencyId
    }));

    // Insert templates
    const { data: insertedTemplates, error: insertError } = await supabase
      .from('outreach_templates')
      .insert(templatesToInsert)
      .select();

    if (insertError) {
      console.error('Error inserting templates:', insertError);
      return { success: false, error: insertError.message };
    }

    console.log(`✅ Seeded ${insertedTemplates.length} default templates for agency ${agencyId}`);
    return { success: true, count: insertedTemplates.length };
  } catch (error) {
    console.error('Error seeding templates:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Force seed templates (even if some exist - useful for adding new defaults)
 * @param {string} agencyId - The agency ID to seed templates for
 * @returns {Promise<{success: boolean, count?: number, error?: string}>}
 */
async function forceSeedTemplates(agencyId) {
  try {
    // Add agency_id to each template
    const templatesToInsert = DEFAULT_TEMPLATES.map(template => ({
      ...template,
      agency_id: agencyId
    }));

    // Insert templates
    const { data: insertedTemplates, error: insertError } = await supabase
      .from('outreach_templates')
      .insert(templatesToInsert)
      .select();

    if (insertError) {
      console.error('Error inserting templates:', insertError);
      return { success: false, error: insertError.message };
    }

    console.log(`✅ Force seeded ${insertedTemplates.length} templates for agency ${agencyId}`);
    return { success: true, count: insertedTemplates.length };
  } catch (error) {
    console.error('Error force seeding templates:', error);
    return { success: false, error: error.message };
  }
}

module.exports = {
  seedDefaultTemplatesIfNeeded,
  forceSeedTemplates,
  DEFAULT_TEMPLATES
};
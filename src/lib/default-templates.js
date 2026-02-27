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
    is_default: false,
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
  },

  // ==================== CALL SCRIPT TEMPLATES ====================
  {
    name: 'Intro / Discovery Call',
    description: 'First cold call to a new lead — build rapport, qualify need, and set next step',
    type: 'call_script',
    subject: 'Cold Call - Intro & Discovery',
    body: `[OPENING — keep it warm, 10 seconds max]

Hey {lead_contact_first_name}, this is {agency_caller_name} with {agency_name}. How's your day going?

[PAUSE — let them respond, match their energy]

Awesome. I'll be super quick — I know you're busy running {lead_business_name}.

[REASON FOR CALL]

I work with {lead_industry} businesses in your area, and we help them stop missing calls and start booking more jobs automatically using an AI receptionist.

I'm not sure if it's a fit for you, but I figured it was worth a quick conversation. Can I ask you a couple questions?

[IF YES — DISCOVERY QUESTIONS]

→ How are you handling calls right now when you're on a job or after hours?
→ Roughly how many calls a week do you think go to voicemail?
→ What happens when you miss a call — do most people leave a message or just call someone else?

[LISTEN — take notes, reflect back what they say]

[TRANSITION TO VALUE]

That's exactly what we hear from a lot of {lead_industry} businesses. Here's what we do differently — our AI answers your phone 24/7, sounds like a real receptionist, handles FAQs, and books appointments right into your calendar. Callers genuinely can't tell the difference.

[GAUGE INTEREST]

Would you be open to seeing a quick demo? Takes about 10 minutes and I can show you exactly how it'd work for {lead_business_name}.

[IF YES — BOOK THE DEMO]

Perfect! Would [suggest 2 specific times] work? I'll send you a calendar invite right after we hang up.

[IF NOT NOW]

Totally understand. Would it be cool if I followed up in a couple weeks? Things get busy — I just don't want you to miss out if timing gets better.

[IF NOT INTERESTED]

No problem at all, {lead_contact_first_name}. If anything changes down the road, you've got my number. Have a great rest of your day!

[CLOSE — always confirm next step]

Awesome, I'll send that calendar invite to {lead_email} right now. Looking forward to showing you how it works. Talk soon!`,
    is_default: false,
    is_follow_up: false,
    sequence_name: null,
    sequence_order: null,
    delay_days: null
  },
  {
    name: 'Follow-Up Call',
    description: 'Second call after initial outreach — reference previous touchpoint and re-engage',
    type: 'call_script',
    subject: 'Follow-Up Call',
    body: `[OPENING — reference the previous contact]

Hey {lead_contact_first_name}, this is {agency_caller_name} from {agency_name}. We connected briefly a little while back — I'd sent you some info about AI receptionists for {lead_business_name}. Ring a bell?

[IF THEY REMEMBER]

Great! I just wanted to circle back and see if you had any questions or if the timing might be better now.

[IF THEY DON'T REMEMBER]

No worries at all! Quick refresher — I help {lead_industry} businesses like yours stop missing calls. We set up an AI receptionist that answers 24/7, books appointments, and handles FAQs. Sounds like a real person.

[RECONNECT WITH THEIR PAIN POINT]

Last time we talked, you mentioned [reference any notes from previous call, or use:] that missed calls were an issue, especially during busy periods. Is that still the case?

[LISTEN — let them talk]

[VALUE REMINDER]

Yeah, that's super common. Our clients in {lead_industry} are typically seeing about 40% more booked appointments once the AI is handling their calls. And it pays for itself pretty fast.

[ASK FOR THE MEETING]

Would you have 10 minutes this week to see a quick demo? I promise it's painless — no long pitch, just a walkthrough of how it'd work for {lead_business_name} specifically.

[IF YES]

Awesome! How about [suggest 2 times]? I'll shoot you a calendar invite right away.

[IF NOT YET]

Totally hear you. Mind if I check back in [suggest timeframe]? I don't want to bug you, but I also don't want you to miss out when the timing's right.

[IF NO]

No pressure at all. If anything changes, you know where to find me. Have a great one, {lead_contact_first_name}!`,
    is_default: false,
    is_follow_up: true,
    sequence_name: null,
    sequence_order: null,
    delay_days: null
  },
  {
    name: 'Demo Close Call',
    description: 'Post-demo call to handle objections and close the deal',
    type: 'call_script',
    subject: 'Demo Close Call',
    body: `[OPENING — warm, reference the demo]

Hey {lead_contact_first_name}! It's {agency_caller_name} from {agency_name}. Thanks again for checking out the demo the other day. How's everything going?

[PAUSE — let them respond]

[CHECK TEMPERATURE]

I wanted to follow up and see what you thought. Did anything stand out or surprise you about how the AI receptionist works?

[LISTEN — their response tells you where they are]

[IF POSITIVE RESPONSE]

That's awesome to hear. Yeah, [reflect back what they liked]. That's exactly what our {lead_industry} clients love about it.

So here's what I'm thinking — we could get {lead_business_name} set up this week. Takes about 24-48 hours, and you get a 7-day free trial to make sure it's a perfect fit. Zero risk.

[IF THEY HAVE CONCERNS — HANDLE OBJECTIONS]

→ "It's too expensive"
I totally get that. Here's how I think about it though — how much is a missed call worth? If even one extra job per week comes through that you would've missed, the AI pays for itself multiple times over. Our starter plan is just {agency_starter_price} per month.

→ "I need to think about it"
Of course. What specifically are you weighing? [Listen] That makes sense. Would it help if I could [address their specific concern]?

→ "I'm not sure my customers will like talking to AI"
That's the #1 concern everyone has, and it's the #1 thing that surprises them. Our AI sounds completely natural — callers genuinely don't know the difference. And if they ever want a real person, it can transfer them instantly.

→ "I already have a receptionist / answering service"
That's great! A lot of our clients use us alongside their existing setup. The AI handles overflow, after-hours, and weekends so your team never misses a beat. Think of it as backup that works 24/7.

[CLOSE]

Here's what I'd recommend — let's get you started with the free trial this week. You'll see real results within days, and if it's not for you, you cancel with zero hassle. Sound fair?

[IF YES]

Amazing! I'll send you the signup link right now to {lead_email}. Setup is quick and I'll personally make sure everything's dialed in for {lead_business_name}.

[IF NEEDS MORE TIME]

Totally fine. I'll follow up [specific day] and we can go from there. In the meantime, feel free to text me if any questions come up — {agency_phone}.

[CLOSE — always end with clear next step]

Thanks {lead_contact_first_name}, really excited to get this going for you. Talk soon!`,
    is_default: false,
    is_follow_up: false,
    sequence_name: null,
    sequence_order: null,
    delay_days: null
  }
];

/**
 * Seed default templates for an agency if they don't have the full set
 * FIXED: Checks for minimum count instead of "any exist" to handle partial seeds
 * @param {string} agencyId - The agency ID to seed templates for
 * @returns {Promise<{success: boolean, count?: number, skipped?: boolean, error?: string}>}
 */
async function seedDefaultTemplatesIfNeeded(agencyId) {
  try {
    // Check how many templates agency currently has
    const { data: existingTemplates, error: checkError } = await supabase
      .from('outreach_templates')
      .select('id, name')
      .eq('agency_id', agencyId);

    if (checkError) {
      console.error('Error checking existing templates:', checkError);
      return { success: false, error: checkError.message };
    }

    const existingCount = existingTemplates ? existingTemplates.length : 0;
    const expectedCount = DEFAULT_TEMPLATES.length;

    // Only skip if agency already has the full set (or more from custom templates)
    if (existingCount >= expectedCount) {
      console.log(`⏭️ Agency ${agencyId} has ${existingCount} templates (expected ${expectedCount}), skipping seed`);
      return { success: true, skipped: true };
    }

    // Find which default templates are missing by name
    const existingNames = new Set((existingTemplates || []).map(t => t.name));
    const missingTemplates = DEFAULT_TEMPLATES.filter(t => !existingNames.has(t.name));

    if (missingTemplates.length === 0) {
      console.log(`⏭️ Agency ${agencyId} has all default templates by name, skipping seed`);
      return { success: true, skipped: true };
    }

    // Add agency_id to each missing template
    const templatesToInsert = missingTemplates.map(template => ({
      ...template,
      agency_id: agencyId
    }));

    // Insert only missing templates
    const { data: insertedTemplates, error: insertError } = await supabase
      .from('outreach_templates')
      .insert(templatesToInsert)
      .select();

    if (insertError) {
      console.error('Error inserting templates:', insertError);
      return { success: false, error: insertError.message };
    }

    console.log(`✅ Seeded ${insertedTemplates.length} missing templates for agency ${agencyId} (had ${existingCount}, now ${existingCount + insertedTemplates.length})`);
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
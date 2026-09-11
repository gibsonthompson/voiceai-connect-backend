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
    description: 'First cold email. Leads with the missed-call problem and a hear-it-yourself demo instead of asking for a meeting.',
    type: 'email',
    subject: 'calls slipping past {lead_business_name}?',
    body: `Hi {lead_contact_first_name},

{personalized_line}

Quick reason I'm reaching out: most {lead_industry} shops lose calls they never even see. Someone rings while you're on a job or after you've closed, hits voicemail, and just dials the next name on the list.

I set up an AI receptionist that catches those. It answers 24/7, sounds like a real person, and books the job straight onto your calendar.

Easiest way to judge it is to hear it. {demo_cta}

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
    description: 'First follow-up. One concrete scenario plus the hear-it CTA. Short.',
    type: 'email',
    subject: 're: {lead_business_name}',
    body: `Hi {lead_contact_first_name},

Following up on my note, and I'll keep it to one thought.

Think about the last call {lead_business_name} missed after hours. If the AI receptionist had picked up, taken the details, and booked it, that's a job you keep instead of hand to a competitor. Now do that every night and every weekend.

Fastest way to see it is to hear it. {demo_cta}

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
    description: 'Second follow-up. Reframes the math honestly instead of quoting invented stats.',
    type: 'email',
    subject: 'the math on missed calls',
    body: `Hi {lead_contact_first_name},

I know you're busy running {lead_business_name}, so, short version.

You don't need a fancy statistic to see this one. If the AI catches even one job a week you'd otherwise have missed, it has already paid for itself several times over, and it's catching a lot more than one. Nights, weekends, lunch rushes, the calls that never even make it to voicemail.

{demo_cta}

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
    description: 'Third follow-up. A clean yes/no so you stop chasing dead leads.',
    type: 'email',
    subject: 'worth a look, or not?',
    body: `Hi {lead_contact_first_name},

I've sent a couple of notes about catching more of {lead_business_name}'s calls, so I'll just ask it straight:

Is this worth a look, or should I close it out for now?

Either answer is genuinely fine. A quick "yes" or "not now" and I'll take it from there.

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
    description: 'Final email in the sequence. Low-key, leaves the door open, no fake scarcity.',
    type: 'email',
    subject: 'closing this out',
    body: `Hi {lead_contact_first_name},

Haven't heard back, so I'll get out of your inbox.

If the day comes where you're tired of missed calls turning into lost jobs, just reply to this and I'll get {lead_business_name} an AI receptionist set up fast. It'll be here whenever you want it.

All the best,
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
    description: 'Warm referral intro. Leads with the referrer, then offers the hear-it demo. Replace [Referrer] before sending.',
    type: 'email',
    subject: '{lead_contact_first_name}, [Referrer] pointed me your way',
    body: `Hi {lead_contact_first_name},

[Referrer] figured {lead_business_name} might want what I set up for them: an AI receptionist that answers every call, day or night, and books jobs straight to the calendar. It's been catching calls they used to lose.

Happy to show you the same. {demo_cta}

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
    description: 'After they have heard the demo. Short recap plus a one-click signup link.',
    type: 'email',
    subject: 'getting {lead_business_name} set up',
    body: `Hi {lead_contact_first_name},

Good talking today. Quick recap of what {lead_business_name} gets:

- A receptionist that answers 24/7 and never drops a caller to voicemail
- Books appointments and takes messages on its own
- Live in about a day, with a 7-day free trial so there's no risk

When you're ready, here's the link: {signup_link}. I'll personally make sure it's dialed in for you.

Any questions, just reply.

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
    description: 'Re-engaging an old lead. Short, references the gap, offers the live demo.',
    type: 'email',
    subject: 'still missing calls at {lead_business_name}?',
    body: `Hi {lead_contact_first_name},

We talked a while back about missed calls at {lead_business_name} and the timing wasn't right. No problem, just checking whether it still is.

The AI receptionist is better than when we last spoke, and it takes about a day to go live. If calls are still slipping through, hear it for yourself. {demo_cta}

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
    description: 'First SMS. Short, human, ends with the hear-it offer.',
    type: 'sms',
    subject: null,
    body: `Hi {lead_contact_first_name}, {agency_owner_name} here from {agency_name}. I set up AI receptionists that catch the calls {lead_business_name} misses after hours and on the job. {demo_cta}`,
    is_default: false,
    is_follow_up: false,
    sequence_name: 'sms_sequence',
    sequence_order: 1,
    delay_days: 0
  },
  {
    name: 'SMS - Follow-up',
    description: 'SMS follow-up after no response. One line, one ask.',
    type: 'sms',
    subject: null,
    body: `Hi {lead_contact_first_name}, following up on the AI receptionist for {lead_business_name}. {demo_cta} - {agency_owner_name}`,
    is_default: false,
    is_follow_up: true,
    sequence_name: 'sms_sequence',
    sequence_order: 2,
    delay_days: 2
  },
  {
    name: 'SMS - After Voicemail',
    description: 'Send right after leaving a voicemail.',
    type: 'sms',
    subject: null,
    body: `Hi {lead_contact_first_name}, just left you a voicemail about catching more of {lead_business_name}'s calls. Text is easier if you prefer, happy to answer anything here. - {agency_owner_name}`,
    is_default: false,
    is_follow_up: false,
    sequence_name: null,
    sequence_order: null,
    delay_days: null
  },
  {
    name: 'SMS - Demo Reminder',
    description: 'Reminder before a scheduled demo. Set [TIME] before sending.',
    type: 'sms',
    subject: null,
    body: `Hi {lead_contact_first_name}! Reminder about our chat today at [TIME]. I'll show you exactly how the AI would answer for {lead_business_name}. Talk soon! - {agency_owner_name}`,
    is_default: false,
    is_follow_up: false,
    sequence_name: null,
    sequence_order: null,
    delay_days: null
  },
  {
    name: 'SMS - Quick Question',
    description: 'Casual one-liner to start a conversation.',
    type: 'sms',
    subject: null,
    body: `Hey {lead_contact_first_name}, honest question, how many calls a week does {lead_business_name} miss when you're on a job or closed for the day? Might be an easy fix. - {agency_owner_name}`,
    is_default: false,
    is_follow_up: false,
    sequence_name: null,
    sequence_order: null,
    delay_days: null
  },

  // ==================== CALL SCRIPT TEMPLATES ====================
  {
    name: 'Intro / Discovery Call',
    description: 'First cold call. Build rapport, find the missed-call pain, then let them hear the AI live.',
    type: 'call_script',
    subject: 'Cold Call - Intro & Discovery',
    body: `[OPENING, warm, 10 seconds]

Hey {lead_contact_first_name}, it's {agency_caller_name} with {agency_name}. Caught you at an okay time?

[PAUSE, match their energy]

I'll be quick, I know you're busy running {lead_business_name}.

[REASON FOR CALL]

I work with {lead_industry} businesses around here and set them up so they stop losing calls when nobody can get to the phone. Mind if I ask you a couple quick questions to see if it's even worth your time?

[IF YES, DISCOVERY]

- When you're on a job or closed, what happens to a call that comes in right now?
- Rough guess, how many a week go to voicemail?
- When someone hits your voicemail, do they leave a message, or just call the next shop?

[LISTEN, take notes, reflect it back]

[VALUE, keep it tight]

That's the exact gap we close. I set up an AI receptionist that answers 24/7, sounds like a real person, and books the job straight onto your calendar. The part people don't expect is how normal it sounds.

[THE ASK, let them hear it, don't sell it]

Honestly the fastest way to get it is to hear it. Can I text you our demo line right now? It's {agency_demo_number}, call it whenever and it'll answer like it's picking up for {lead_business_name}. Then you'll know in about 60 seconds whether it's any good.

[IF YES]

Perfect, sending it to {lead_phone} now. Give it a call today and I'll follow up tomorrow to hear what you thought.

[IF NOT NOW]

No problem. Want me to check back in a couple weeks? Things get busy, I just don't want you missing out if the timing gets better.

[IF NOT INTERESTED]

All good, {lead_contact_first_name}. You've got my number if anything changes. Have a good one.`,
    is_default: false,
    is_follow_up: false,
    sequence_name: null,
    sequence_order: null,
    delay_days: null
  },
  {
    name: 'Follow-Up Call',
    description: 'Second call after the first touch. Reference it, reconnect with the pain, then let them hear it.',
    type: 'call_script',
    subject: 'Follow-Up Call',
    body: `[OPENING, reference the last touch]

Hey {lead_contact_first_name}, it's {agency_caller_name} from {agency_name}. We crossed paths a little while back, I'd reached out about missed calls at {lead_business_name}. Ring a bell?

[IF THEY REMEMBER]

Great. I just wanted to see if the timing's any better now, or if you had questions I can knock out.

[IF THEY DON'T]

No worries, quick refresher: I set up an AI receptionist for {lead_industry} businesses that answers 24/7, books jobs, and sounds like a real person, so calls stop slipping through.

[RECONNECT WITH THE PAIN]

Last time, the thing that stood out was missed calls when you're on a job or after hours. Still happening?

[LISTEN]

[THE ASK, hear it, not book it]

Let me just put it in your hands. I'll text you our demo line right now, {agency_demo_number}, call it whenever and it'll answer like it's picking up for {lead_business_name}. Takes a minute and you'll know if it's for real.

[IF YES]

Sending it to {lead_phone} now. Try it today and I'll check in tomorrow.

[IF NOT YET]

Totally fair. Mind if I check back in a couple weeks? I don't want to pester you, just don't want you missing out when it's the right time.

[IF NO]

No pressure at all. You know where I am if anything changes. Take care, {lead_contact_first_name}.`,
    is_default: false,
    is_follow_up: true,
    sequence_name: null,
    sequence_order: null,
    delay_days: null
  },
  {
    name: 'Demo Close Call',
    description: 'After they have heard the AI. Check reaction, handle the common objections, and start the free trial.',
    type: 'call_script',
    subject: 'Demo Close Call',
    body: `[OPENING, reference the demo]

Hey {lead_contact_first_name}! It's {agency_caller_name} from {agency_name}. You got a chance to call the number and hear it, right? What'd you think?

[LISTEN, their answer tells you where they are]

[IF POSITIVE]

Yeah, that's the reaction most people have, it just sounds normal. So here's what I'd do: get {lead_business_name} set up this week. It's live in about a day, and you get a 7-day free trial, so there's no risk in trying it.

[COMMON OBJECTIONS]

- "It's too pricey."
  Fair. Flip it around though, what's one missed job worth to you? If it catches even one a week you'd have lost, it's paid for itself many times over. Starter is {agency_starter_price}.

- "I need to think about it."
  Of course. What's the piece you're weighing? [Listen.] Makes sense, would it help if I [address that specific thing]?

- "Not sure my customers want to talk to a bot."
  That's the number one worry, and the number one thing that flips people. It sounds like a real person, and if a caller ever wants a human it transfers them on the spot.

- "I already have someone answering."
  Great, this doesn't replace them. It catches the overflow, the after-hours, and the weekends so nothing slips when your person is busy or gone.

[CLOSE]

Here's my honest recommendation: start the free trial this week. You'll see real calls handled within days, and if it's not for you, you cancel, no hassle. Fair enough?

[IF YES]

Love it. Sending the signup link to {lead_email} now. I'll personally make sure everything's dialed in for {lead_business_name}.

[IF THEY NEED TIME]

No problem. I'll follow up [specific day]. Anything comes up before then, just text me at {agency_phone}.

[CLOSE, always confirm the next step]

Thanks {lead_contact_first_name}, excited to get this going for you. Talk soon.`,
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
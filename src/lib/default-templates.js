// ============================================================================
// DEFAULT TEMPLATES - Seed templates for new agencies
// VoiceAI Connect
// ============================================================================
const crypto = require('crypto');
const { supabase } = require('./supabase');

// Default templates - NO 'category' column (doesn't exist in schema)
const DEFAULT_TEMPLATES = [
  // ==================== EMAIL TEMPLATES ====================
  {
    name: 'Initial Outreach',
    description: 'First cold email. Leads with the missed-call problem and a hear-it-yourself demo instead of asking for a meeting.',
    type: 'email',
    subject: 'A quick idea for {lead_business_name}',
    body: `Hi {lead_contact_first_name},

{personalized_line}

I'm reaching out because when you're out on a job, helping a customer, or closed for the day, answering every incoming call can be difficult. And when someone can't reach you, they may move on to another business.

I help {lead_industry} businesses handle those calls with an AI receptionist that can answer questions, take messages, and book appointments directly onto your calendar.

I thought it might be worth showing you how it would work for {lead_business_name}. You can hear it yourself here: {demo_cta}

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

One situation worth thinking about: someone finds {lead_business_name} after searching for a service you offer, calls while you're busy, and doesn't get an answer.

That could be a potential job going somewhere else. An AI receptionist can answer that call, collect the details, and help get the customer booked without you having to stop what you're doing.

Here's a quick way to hear how it works: {demo_cta}

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
    subject: 'What could one missed job cost?',
    body: `Hi {lead_contact_first_name},

I know you're busy running {lead_business_name}, so I'll keep this short.

Think about what an average new customer is worth to your business. If a call you couldn't answer turns into a job for another company, that's revenue you potentially missed.

The idea isn't to replace your team. It's to give callers somewhere to go when your team can't get to the phone.

You can hear how it works here: {demo_cta}

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
    subject: 'Would this be useful for {lead_business_name}?',
    body: `Hi {lead_contact_first_name},

I've reached out a couple of times because I think there's an opportunity to help {lead_business_name} capture more of its incoming calls.

Would having an AI receptionist answer calls, handle basic questions, and help book appointments be useful for your business?

If it's not something you need right now, that's completely fine. Just let me know.

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
    subject: 'I\'ll leave it here',
    body: `Hi {lead_contact_first_name},

I haven't heard back, so I'll leave it here for now.

If answering calls becomes a challenge for {lead_business_name}, whether you're busy with customers, out on jobs, or closed for the day, I'd be happy to show you how an AI receptionist could help.

You can always reach me by replying to this email.

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
    subject: '{lead_contact_first_name}, [Referrer] suggested I reach out',
    body: `Hi {lead_contact_first_name},

[Referrer] thought it might be worth connecting because of what we've helped them with.

We help businesses handle incoming calls when their team is unavailable, using an AI receptionist that can answer questions, take messages, and book appointments.

I thought something similar might be useful for {lead_business_name}. Rather than explain it all over email, I'd be happy to let you hear how it works.

{demo_cta}

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
    subject: 'Next steps for {lead_business_name}',
    body: `Hi {lead_contact_first_name},

Thanks for taking the time to hear the demo today.

The goal is to make sure people calling {lead_business_name} can get help even when you or your team can't answer immediately.

With your AI receptionist, you can:

- Have incoming calls answered around the clock.
- Give callers answers to common questions.
- Capture customer details and take messages.
- Book appointments directly onto your calendar.

We can get your receptionist configured for your business, and you'll have a 7-day free trial to see how it works with real calls.

When you're ready, here's your setup link: {signup_link}

I'll personally help make sure everything is configured around how {lead_business_name} operates.

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
    subject: 'Still looking to improve call handling at {lead_business_name}?',
    body: `Hi {lead_contact_first_name},

We spoke a while back about helping {lead_business_name} handle incoming calls, but the timing wasn't right.

I wanted to see if that's something you've thought about again.

The goal is simple: make sure potential customers can reach someone, get answers, and book appointments even when you're unavailable.

We've also continued improving the service since we last spoke.

If it's worth another look, you can hear it for yourself here: {demo_cta}

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
    body: `Hi {lead_contact_first_name}, this is {agency_owner_name} with {agency_name}. I work with {lead_industry} businesses to help them handle incoming calls when they're busy or unavailable. Thought it might be useful for {lead_business_name}. Here's a quick demo: {demo_cta}`,
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
    body: `Hi {lead_contact_first_name}, just wanted to follow up. Have you had a chance to hear how an AI receptionist could handle incoming calls for {lead_business_name}? {demo_cta} - {agency_owner_name}`,
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
    body: `Hi {lead_contact_first_name}, just left you a voicemail. I was reaching out because I thought there might be an opportunity to help {lead_business_name} handle more incoming calls. Happy to answer any questions here if that's easier. - {agency_owner_name}`,
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
    body: `Hi {lead_contact_first_name}, just a reminder about our chat today at [TIME]. I'll show you how an AI receptionist could answer calls and help book appointments for {lead_business_name}. Talk soon! - {agency_owner_name}`,
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
    body: `Hi {lead_contact_first_name}, quick question: when you're busy with a customer or out on a job, who usually handles incoming calls for {lead_business_name}? - {agency_owner_name}`,
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
    subject: 'Cold Call: Intro & Discovery',
    body: `[OPENING, warm and conversational]

Hey {lead_contact_first_name}, it's {agency_caller_name} with {agency_name}. Did I catch you at an okay time?

[PAUSE, match their energy]

I'll keep it brief. I work with {lead_industry} businesses, and I wanted to ask you something about how {lead_business_name} handles incoming calls.

[REASON FOR CALL]

When you're out on a job, helping another customer, or closed for the day, it can be difficult to get to every call. We help businesses handle those calls so potential customers aren't left without an answer.

Mind if I ask you a couple of quick questions?

[IF YES, DISCOVERY]

- When you're busy or unavailable, who normally answers your incoming calls?
- What happens when someone calls after business hours?
- Do you have a way to capture those callers and follow up with them?
- Are appointments usually booked over the phone?

[LISTEN, TAKE NOTES, REFLECT THEIR ANSWERS]

[VALUE, CONNECT TO THEIR SPECIFIC SITUATION]

That makes sense. Based on what you're telling me, there may be an opportunity to make things easier for you.

We set up an AI receptionist that can answer incoming calls, handle common questions, take messages, and book appointments directly onto your calendar. It gives callers somewhere to go even when you can't get to the phone.

[THE ASK, LET THEM EXPERIENCE IT]

Rather than just explain it, I'd rather let you hear it. Can I text you our demo number? It's {agency_demo_number}. You can call it and hear how it would answer for a business like yours.

[IF YES]

Perfect. I'll send it to {lead_phone} now. Give it a call when you have a minute, and I'll follow up to hear what you think.

[IF NOT NOW]

No problem. Would another day be better? I don't want to interrupt your work.

[IF NOT INTERESTED]

Understood. Thanks for your time, {lead_contact_first_name}. Have a good one.`,
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
    subject: 'Follow-up Call',
    body: `[OPENING, REFERENCE THE LAST TOUCH]

Hey {lead_contact_first_name}, it's {agency_caller_name} from {agency_name}. We spoke a little while back about helping {lead_business_name} handle incoming calls. Does that ring a bell?

[IF THEY REMEMBER]

Great. I wanted to see if you had a chance to think about it or if you had any questions.

[IF THEY DON'T]

No worries. Quick refresher: we help businesses answer calls when their team is busy or unavailable, using an AI receptionist that can also take messages and book appointments.

[RECONNECT WITH THEIR SPECIFIC SITUATION]

Last time we spoke, you mentioned [REFERENCE THEIR SPECIFIC CALL-HANDLING CHALLENGE].

Is that still something you're dealing with?

[LISTEN]

[THE ASK, LET THEM EXPERIENCE IT]

I'd rather let you hear it than spend time trying to explain it. Our demo number is {agency_demo_number}. I'll text it over, and you can call it whenever you have a minute.

It'll give you a much better idea of how it could work for {lead_business_name}.

[IF YES]

Perfect. I'll send it to {lead_phone} now. Let me know what you think once you've tried it.

[IF NOT YET]

Totally fair. Would it make sense for me to check back in a couple of weeks?

[IF NO]

No problem at all. Thanks for your time. Take care, {lead_contact_first_name}.`,
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
    body: `[OPENING, REFERENCE THE DEMO]

Hey {lead_contact_first_name}! It's {agency_caller_name} from {agency_name}. I wanted to see if you got a chance to call the demo number and hear how it works. What did you think?

[LISTEN, LET THEM EXPLAIN THEIR REACTION]

[IF POSITIVE]

Glad you got to hear it. Now the important part is making sure it works the way {lead_business_name} needs it to.

We can configure it around your business, including the information it gives callers, how it handles different requests, and where appointments get booked.

I'd suggest getting it set up so you can try it with real calls. You'll have a 7-day free trial to see how it fits into your day-to-day operations.

[COMMON OBJECTIONS]

- "It's too pricey."

  I understand. The best way to look at it is what a new customer is worth to your business. If it helps you capture even one additional job that might otherwise have been missed, how would that compare to the monthly cost? Our Starter plan is {agency_starter_price}.

- "I need to think about it."

  Of course. Is there something specific you're unsure about, or do you just need some time to consider it?

  [LISTEN AND ADDRESS THE ACTUAL CONCERN]

- "I'm not sure my customers want to talk to a bot."

  That's a fair concern. The important thing is that callers still get help instead of being sent straight to voicemail. The receptionist can handle common requests, and calls can be transferred to a person when needed.

- "I already have someone answering."

  That's great. This doesn't have to replace anyone. It can help cover calls when your team is busy, unavailable, or outside normal business hours.

[PERSONALIZED CLOSE]

Based on what we've discussed, I think it's worth trying for {lead_business_name}. You can test it with real calls during the 7-day free trial and see whether it makes a difference for your business.

Would you like to get the setup started?

[IF YES]

Perfect. I'll send the signup link to {lead_email} now. I'll personally help make sure everything is configured for {lead_business_name}.

[IF THEY NEED TIME]

No problem. When would be a good day for me to follow up? Anything comes up before then, you can reach me at {agency_phone}.

[CLOSE, ALWAYS CONFIRM THE NEXT STEP]

Thanks, {lead_contact_first_name}. I appreciate your time. Talk soon.`,
    is_default: false,
    is_follow_up: false,
    sequence_name: null,
    sequence_order: null,
    delay_days: null
  }
];

// SHA-256 of every prior default BODY (trimmed), across generations we've shipped.
// Used by resyncDefaultTemplates to recognize a row that is still an untouched
// default (so it can be refreshed) versus one an agency has customized (left alone).
const PRIOR_DEFAULT_BODY_HASHES = new Set([
  '05c9a905814015a3e2abd87c052584cd61542e4979abf13f85a3396b3bea35e1',
  '1e4f8ab0125fadfe53fc7f2f70557db87c2ede35bf2d9ea84ef49feb5072758a',
  '21cc254ebbf38618ba41b64f5b05403ddb9bdd1aefc6635a2a7615ab1c1c4fd4',
  '250f1d8f7790df0ad6708e9bf1478ab061d65ebdf0d85b5053bc763bd439b2e2',
  '387be3b137feb60e054cdfc8e76eaa879275dafc135ab5914033716a6980acbe',
  '4de4c5ab012ef0728159a2e2933ce082a894eab2c92cb9c6c98798423ab88eef',
  '6241b8648f6a31df568cda9ef413201e755fe05e3b295d9cfc70194c41bb4670',
  '721ff3176be7c3393ca00c9397d525d2d856e7b21e09554d9d7039b733fd816f',
  '744e7ae6569df415b178608820a120801cc5a511af42ad504397d427c0cc8314',
  '748e468cc793ab28a9b5261af0f5e95c5bfe1f36ba5d9675196c1ab476f04a90',
  '8230ed3b1b5be465d5e6d16ffa4818b4f127dbc0d54f6f7a8e56ca3a7bf35885',
  '88bef5ea1baf093dfcdabafce31ecd23c8ee15fcd15e87c6d0fd9e8a3f692358',
  'ab60ba038f29968dba7b68715568bf404004cd741c4c8d63b79d8a1c2bf4d1b7',
  'afa817fd25967878631c483cc98c98d8c011aabb247b0cd273a6734741e3b2b1',
  'ca87f7b848dc65fb30f963834629a46969afc4a1c65cb0d3bffedc0b7bc3509f',
  'fe3431a0413a5c71f4b428d3e0a056114efdaeb8c500aed682ca22b8cef91fb9',
]);
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

/**
 * Re-sync existing agencies' default-named templates to the CURRENT copy in
 * DEFAULT_TEMPLATES. This is the piece that was missing: seedDefaultTemplatesIfNeeded
 * only inserts templates whose NAME is absent, so when the default copy is
 * rewritten (e.g. moving outreach from "book a 10-minute call" to "call our demo
 * line"), agencies seeded earlier keep their stale bodies forever. Run this to
 * push the new copy out.
 *
 * Safe by default: only rows that are still an UNTOUCHED shipped default get
 * overwritten. Detection covers both the old meeting-ask language (marker match)
 * and any prior default body exactly (hash match in PRIOR_DEFAULT_BODY_HASHES),
 * so an agency's own customizations and already-current rows are left untouched.
 * Pass { force: true } to overwrite every default-named row regardless.
 *
 * @param {string|null} agencyId - A single agency, or null for ALL agencies.
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<{success: boolean, updated?: number, scanned?: number, error?: string}>}
 */
async function resyncDefaultTemplates(agencyId, opts = {}) {
  const force = opts.force === true;
  try {
    const names = DEFAULT_TEMPLATES.map(t => t.name);
    const byName = Object.fromEntries(DEFAULT_TEMPLATES.map(t => [t.name, t]));

    let sel = supabase.from('outreach_templates').select('id, name, body').in('name', names);
    // A single agency, or every agency-owned row (never the platform-level
    // null-agency library rows).
    sel = agencyId ? sel.eq('agency_id', agencyId) : sel.not('agency_id', 'is', null);
    const { data: rows, error } = await sel;
    if (error) return { success: false, error: error.message };

    const OLD_MARKERS = ['10 minute', '10-minute', '10-min', 'quick chat', 'quick call', 'quick 10'];
    const bodyHash = (body) => crypto.createHash('sha256').update((body || '').trim()).digest('hex');
    // A row is an untouched default if it still carries the oldest meeting-ask
    // language, OR its body exactly matches a body we previously shipped as a
    // default. Either way it is safe to refresh. A customized row matches neither.
    const isStale = (body) => {
      const b = (body || '').toLowerCase();
      if (OLD_MARKERS.some(m => b.includes(m))) return true;
      if (PRIOR_DEFAULT_BODY_HASHES.has(bodyHash(body))) return true;
      return false;
    };

    let updated = 0;
    for (const r of rows || []) {
      const tpl = byName[r.name];
      if (!tpl) continue;
      if (!force && !isStale(r.body)) continue; // leave customized / already-current rows alone
      const { error: uErr } = await supabase
        .from('outreach_templates')
        .update({ subject: tpl.subject, body: tpl.body, description: tpl.description, updated_at: new Date().toISOString() })
        .eq('id', r.id);
      if (!uErr) updated++;
      else console.error('resyncDefaultTemplates update error:', r.id, uErr.message);
    }
    console.log(`🔄 Resynced ${updated} default template(s) (${agencyId ? `agency ${agencyId}` : 'ALL agencies'}, force=${force})`);
    return { success: true, updated, scanned: (rows || []).length };
  } catch (error) {
    console.error('resyncDefaultTemplates error:', error);
    return { success: false, error: error.message };
  }
}

module.exports = {
  seedDefaultTemplatesIfNeeded,
  forceSeedTemplates,
  resyncDefaultTemplates,
  DEFAULT_TEMPLATES
};
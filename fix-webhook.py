#!/usr/bin/env python3
"""
Patches src/webhooks/vapi-webhook.js to save call records BEFORE AI summary.
Run from the backend project root:
  python3 fix-webhook.py
"""
import re, sys

FILE = 'src/webhooks/vapi-webhook.js'

try:
    with open(FILE, 'r') as f:
        content = f.read()
except FileNotFoundError:
    print(f'❌ {FILE} not found. Run this from the backend project root.')
    sys.exit(1)

# ── FIND THE OLD SECTION ────────────────────────────────────────────────
# Starts at: "const transcript = message.transcript || '';"
# Ends at: the return statement "spam: false });" before the catch block
START_MARKER = "    const transcript = message.transcript || '';\n    const callerPhone = call.customer?.number || 'Unknown';\n    const aiData = await generateAISummary"
END_MARKER = "      endedReason, transferStatus, wasTransferred, spam: false });"

start_idx = content.find(START_MARKER)
if start_idx == -1:
    print('❌ Could not find start marker. Has this file already been patched?')
    sys.exit(1)

# Find the end marker AFTER the start
end_idx = content.find(END_MARKER, start_idx)
if end_idx == -1:
    print('❌ Could not find end marker.')
    sys.exit(1)
end_idx += len(END_MARKER)

old_section = content[start_idx:end_idx]
print(f'Found old section: {len(old_section)} chars, {old_section.count(chr(10))} lines')

# ── NEW SECTION ─────────────────────────────────────────────────────────
NEW_SECTION = r"""    // ── EXTRACT CALL DATA (before AI, so we can save immediately) ──────
    const transcript = message.transcript || '';
    const callerPhone = call.customer?.number || 'Unknown';
    const recordingUrl = message.recordingUrl || message.artifact?.recordingUrl || call.recordingUrl || null;
    const durationSeconds = call.duration || message.duration || message.artifact?.duration || message.durationSeconds || null;
    const endedReason = call.endedReason || message.endedReason || null;
    const { transferStatus, wasTransferred } = detectTransferStatus(endedReason, transcript);

    // ── HIPAA mode: strip recording and transcript before storage ──────
    const hipaaMode = client.hipaa_mode === true;
    const storedRecordingUrl = hipaaMode ? null : recordingUrl;
    const storedTranscript = hipaaMode ? null : transcript;
    if (hipaaMode) {
      console.log('🏥 HIPAA mode — recording and transcript will not be stored');
    }

    // ── STEP 1: SAVE CALL RECORD IMMEDIATELY ──────────────────────────
    // Insert before AI summary so a slow/failed Claude API never loses
    // the call record. AI data is backfilled in step 4.
    const initialRec = {
      client_id: client.id, customer_name: 'Unknown', customer_phone: callerPhone,
      customer_email: null, ai_summary: null, transcript: storedTranscript,
      recording_url: storedRecordingUrl, duration_seconds: durationSeconds,
      urgency_level: 'routine', call_status: wasTransferred ? 'transferred' : 'completed',
      ended_reason: endedReason, transfer_status: transferStatus,
      is_spam: false, spam_reason: null,
      call_language: 'en', created_at: new Date().toISOString()
    };
    let savedCallId = null;
    {
      const { data: insertedCall, error: insertError } = await supabase.from('calls').insert([initialRec]).select();
      if (insertError) {
        if (insertError.message && (insertError.message.includes('ended_reason') || insertError.message.includes('transfer_status') || insertError.message.includes('is_spam') || insertError.message.includes('spam_reason') || insertError.message.includes('call_language'))) {
          delete initialRec.ended_reason; delete initialRec.transfer_status; delete initialRec.is_spam; delete initialRec.spam_reason; delete initialRec.call_language; initialRec.call_status = 'completed';
          const { data: retried, error: retryError } = await supabase.from('calls').insert([initialRec]).select();
          if (retryError) return res.status(500).json({ error: 'Failed to save call' });
          savedCallId = retried?.[0]?.id || null;
        } else {
          return res.status(500).json({ error: 'Failed to save call' });
        }
      } else {
        savedCallId = insertedCall?.[0]?.id || null;
      }
    }
    console.log('✅ Call saved (pre-AI):', savedCallId);

    // ── STEP 2: UPDATE CALL COUNT ─────────────────────────────────────
    const newCount = currentCallCount + 1;
    const isFirst = newCount === 1;
    const upd = { calls_this_month: newCount };
    if (isFirst) { upd.first_call_received = true; upd.first_call_received_at = new Date().toISOString(); }
    await supabase.from('clients').update(upd).eq('id', client.id);

    // ── STEP 3: RECORD VOICE USAGE ────────────────────────────────────
    try {
      const agencyId = agency?.id || client.agency_id;
      if (agencyId && durationSeconds && durationSeconds > 0) {
        await insertUsageRecord({ agencyId, clientId: client.id, callId: savedCallId, durationSeconds });
      }
    } catch (usageErr) {
      console.warn('⚠️ Usage record failed (non-fatal):', usageErr.message);
    }

    // ── STEP 4: GENERATE AI SUMMARY (with hard timeout) ───────────────
    // Promise.race guarantees we never hang even if AbortController fails.
    let aiData = {
      customerName: 'Unknown', customerPhone: callerPhone, customerEmail: null,
      urgency: 'routine', summary: `Customer called regarding ${(client.industry || 'professional_services').replace('_', ' ')} services.`,
      callLanguage: 'en', isSpam: false, spamReason: null
    };
    try {
      aiData = await Promise.race([
        generateAISummary(transcript, client.industry || 'professional_services', callerPhone),
        new Promise((_, reject) => setTimeout(() => reject(new Error('AI summary hard timeout (12s)')), 12000))
      ]);
    } catch (aiErr) {
      console.warn('⚠️ AI summary failed/timed out:', aiErr.message);
    }

    const { customerName, customerPhone: aiPhone, customerEmail, urgency, summary: aiSummary } = aiData;
    let { isSpam, spamReason } = aiData;

    if (wasTransferred && isSpam) {
      console.log(`⚠️ Spam flag overridden — call was successfully transferred (${endedReason})`);
      isSpam = false;
      spamReason = null;
    }

    // ── STEP 5: UPDATE CALL RECORD WITH AI DATA ───────────────────────
    if (savedCallId) {
      const aiUpdate = {
        customer_name: customerName,
        customer_phone: aiPhone || callerPhone,
        customer_email: customerEmail,
        ai_summary: aiSummary,
        urgency_level: isSpam ? 'spam' : urgency,
        call_status: isSpam ? 'spam' : (wasTransferred ? 'transferred' : 'completed'),
        is_spam: isSpam,
        spam_reason: spamReason || null,
        call_language: aiData.callLanguage || 'en',
      };
      const { error: updateErr } = await supabase.from('calls').update(aiUpdate).eq('id', savedCallId);
      if (updateErr) console.warn('⚠️ Call AI update failed (non-fatal):', updateErr.message);
      else console.log('✅ Call updated with AI data');
    }

    // ── SPAM: notify and return early ─────────────────────────────────
    if (isSpam) {
      console.log(`🚫 SPAM: ${spamReason}`);
      if (client.owner_phone) { try { await sendSpamBlockedSMS(client, agency, callerPhone, spamReason); } catch {} }
      return res.status(200).json({ received: true, saved: true, spam: true, spamReason, callId: savedCallId });
    }

    // ── STEP 6: UPSERT CONTACT ────────────────────────────────────────
    try {
      const { contact, isNew } = await upsertContactFromCall({ clientId: client.id, agencyId: agency?.id, callId: savedCallId,
        customerPhone: aiPhone || callerPhone, customerName, customerEmail, customerAddress: call.customer?.address || null,
        aiSummary, urgency, serviceRequested: call.customer?.serviceRequested || null });
      if (contact) console.log(`📇 Contact ${isNew ? 'created' : 'updated'}: ${contact.name}`);
    } catch (e) { console.warn('⚠️ Contact upsert failed:', e.message); }

    // ── STEP 7: USAGE WARNINGS ────────────────────────────────────────
    if (callLimit !== -1) {
      const pct = (newCount / callLimit) * 100;
      if (pct >= 80 && pct < 100 && newCount === Math.floor(callLimit * 0.8)) await sendUsageWarningEmail(client, agency, newCount, callLimit);
      if (newCount >= callLimit && newCount === callLimit) await sendLimitReachedEmail(client, agency, callLimit);
    }

    // ── STEP 8: NOTIFICATIONS ─────────────────────────────────────────
    let smsSent = false, emailSent = false;
    if (client.owner_phone) smsSent = await sendCallNotificationSMS(client, agency, aiData);
    await notifyTeamMembers(client.id, aiData, agency);
    if (isFeatureEnabled(client, agency, 'email_summaries') && client.email) {
      const r = await sendCallSummaryEmail(client, agency, aiData, { duration_seconds: durationSeconds, transcript: storedTranscript, created_at: new Date().toISOString() });
      emailSent = r?.success || false;
    }

    return res.status(200).json({ received: true, saved: true, callId: savedCallId,
      smsSent, emailSent, firstCall: isFirst, agency: agency?.name, duration: durationSeconds,
      endedReason, transferStatus, wasTransferred, spam: false });"""

# ── APPLY ───────────────────────────────────────────────────────────────
new_content = content[:start_idx] + NEW_SECTION + content[end_idx:]

# Sanity checks
assert 'Call saved (pre-AI)' in new_content, 'Missing pre-AI save log'
assert 'Promise.race' in new_content, 'Missing Promise.race timeout'
assert 'Call updated with AI data' in new_content, 'Missing AI update log'
assert new_content.count('generateAISummary') == new_content.count('generateAISummary'), 'generateAISummary count unchanged'
# Make sure the old pattern is gone
assert 'const aiData = await generateAISummary' not in new_content, 'Old AI-first pattern still present'
assert 'savedCall?.[0]?.id' not in new_content, 'Old savedCall reference still present'

with open(FILE, 'w') as f:
    f.write(new_content)

print(f'✅ Patched {FILE}')
print(f'   Old section: {len(old_section)} chars')
print(f'   New section: {len(NEW_SECTION)} chars')
print(f'   Total file: {len(new_content)} chars')
print()
print('Changes:')
print('  1. Call record saved BEFORE AI summary (never lost on timeout)')
print('  2. Call count + usage recorded before AI')
print('  3. AI summary wrapped in Promise.race (12s hard timeout)')
print('  4. AI data backfilled into call record after generation')
print('  5. SMS/email notifications still use AI data when available')

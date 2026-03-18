#!/usr/bin/env node
// ============================================================================
// PATCH SCRIPT: Apply spam detection changes to src/lib/vapi.js
//
// Usage (from your voiceai-connect-backend directory):
//   node patch-vapi.js
//
// What it does:
//   1. Reads your current src/lib/vapi.js
//   2. Applies 3 surgical additions (no removals, no modifications)
//   3. Writes the result back to src/lib/vapi.js
//   4. Saves a backup at src/lib/vapi.js.bak
//
// What it adds:
//   - SPAM_DETECTION_BLOCK constant (after INDUSTRY_CONFIGS, before helpers)
//   - systemPrompt += SPAM_DETECTION_BLOCK in createIndustryAssistant()
//   - SPAM_DETECTION_BLOCK in module.exports
//   - Updated header comment
// ============================================================================
const fs = require('fs');
const path = require('path');

const VAPI_PATH = path.join(__dirname, 'src', 'lib', 'vapi.js');
const BACKUP_PATH = VAPI_PATH + '.bak';

// ============================================================================
// THE SPAM DETECTION BLOCK (matches backfill-spam-detection.js)
// ============================================================================
const SPAM_DETECTION_CONSTANT = `
// ============================================================================
// SPAM DETECTION BLOCK — Appended to every assistant's system prompt
// Trains the AI to detect and end spam/robocalls during the call itself.
// Post-call detection also happens in the webhook via Claude analysis.
// ============================================================================
const SPAM_DETECTION_BLOCK = \`

# Spam Detection
If the caller appears to be a robocall, telemarketer, or spam:
- They play a pre-recorded message or sales pitch
- They don't respond to your questions naturally
- They're trying to sell a product or service TO the business (SEO, Google ads, insurance leads, credit card processing, etc.)
- They ask for "the business owner" or "the person in charge of your Google listing"
- The line goes silent after connecting
- They use high-pressure tactics or claim there's an urgent issue with the business's online presence

If you detect spam: say "We're not interested, thanks. Have a good day." Then end the call using the endCall tool if available. If you cannot end the call, simply stop responding after your goodbye.\`;

`;

const APPEND_LINE = `
    // ═══════════════════════════════════════════════════════════════════
    // SPAM DETECTION — Appended to ALL assistants (default + custom)
    // ═══════════════════════════════════════════════════════════════════
    systemPrompt += SPAM_DETECTION_BLOCK;`;

// ============================================================================
// APPLY PATCHES
// ============================================================================
function main() {
  // Read current file
  if (!fs.existsSync(VAPI_PATH)) {
    console.error('❌ File not found:', VAPI_PATH);
    console.error('   Run this script from your voiceai-connect-backend root directory.');
    process.exit(1);
  }

  let content = fs.readFileSync(VAPI_PATH, 'utf8');
  console.log(`📄 Read ${VAPI_PATH} (${content.length} chars)`);

  // Check if already patched
  if (content.includes('SPAM_DETECTION_BLOCK')) {
    console.log('⚠️  File already contains SPAM_DETECTION_BLOCK — skipping to avoid double-patch.');
    console.log('   If you want to re-apply, restore from backup: cp src/lib/vapi.js.bak src/lib/vapi.js');
    process.exit(0);
  }

  // Save backup
  fs.writeFileSync(BACKUP_PATH, content);
  console.log(`💾 Backup saved to ${BACKUP_PATH}`);

  let changes = 0;

  // ── CHANGE 1: Add header comment ──────────────────────────────────────
  const headerTarget = '// UPDATED: Retired Rachel voice, replaced with Matilda (2026-03-14)';
  if (content.includes(headerTarget)) {
    content = content.replace(
      headerTarget,
      headerTarget + '\n// UPDATED: Spam detection block appended to all assistants (2026-03-17)'
    );
    changes++;
    console.log('✅ Change 1/4: Header comment updated');
  } else {
    console.log('⚠️  Change 1/4: Header target not found (non-critical, skipping)');
  }

  // ── CHANGE 2: Insert SPAM_DETECTION_BLOCK constant ────────────────────
  const constantTarget = 'function sanitizeAssistantName(businessName) {';
  if (content.includes(constantTarget)) {
    content = content.replace(
      constantTarget,
      SPAM_DETECTION_CONSTANT + constantTarget
    );
    changes++;
    console.log('✅ Change 2/4: SPAM_DETECTION_BLOCK constant inserted');
  } else {
    console.error('❌ Change 2/4: Could not find sanitizeAssistantName — CRITICAL');
    process.exit(1);
  }

  // ── CHANGE 3: Append to system prompt in createIndustryAssistant ──────
  const promptTarget = `      // NOTE: No guardrails appended — default prompts have # Guardrails built in
    }`;
  if (content.includes(promptTarget)) {
    content = content.replace(
      promptTarget,
      promptTarget + APPEND_LINE
    );
    changes++;
    console.log('✅ Change 3/4: systemPrompt += SPAM_DETECTION_BLOCK added');
  } else {
    console.error('❌ Change 3/4: Could not find guardrails comment — CRITICAL');
    console.error('   Your vapi.js may have different whitespace. Check manually.');
    process.exit(1);
  }

  // ── CHANGE 4: Add to module.exports ───────────────────────────────────
  const exportsTarget = '  INDUSTRY_CONFIGS,';
  if (content.includes(exportsTarget)) {
    content = content.replace(
      exportsTarget,
      exportsTarget + '\n  SPAM_DETECTION_BLOCK,'
    );
    changes++;
    console.log('✅ Change 4/4: Added to module.exports');
  } else {
    console.error('❌ Change 4/4: Could not find INDUSTRY_CONFIGS in exports — CRITICAL');
    process.exit(1);
  }

  // Write result
  fs.writeFileSync(VAPI_PATH, content);
  console.log(`\n🎉 Done! ${changes}/4 changes applied.`);
  console.log(`   Output: ${VAPI_PATH} (${content.length} chars)`);
  console.log(`   Backup: ${BACKUP_PATH}`);

  // Verification
  console.log('\n── Verification ──');
  const verify = [
    ['SPAM_DETECTION_BLOCK constant defined', content.includes('const SPAM_DETECTION_BLOCK = `')],
    ['Appended to systemPrompt', content.includes('systemPrompt += SPAM_DETECTION_BLOCK')],
    ['In module.exports', content.includes('SPAM_DETECTION_BLOCK,')],
    ['Header updated', content.includes('Spam detection block appended')],
    ['Original sanitizeAssistantName intact', content.includes('function sanitizeAssistantName(businessName)')],
    ['Original createIndustryAssistant intact', content.includes('async function createIndustryAssistant(')],
    ['Original INDUSTRY_CONFIGS intact', content.includes('const INDUSTRY_CONFIGS = {')],
  ];
  
  let allGood = true;
  verify.forEach(([label, ok]) => {
    console.log(`   ${ok ? '✅' : '❌'} ${label}`);
    if (!ok) allGood = false;
  });

  if (!allGood) {
    console.log('\n⚠️  Some verifications failed. Review the output file.');
    console.log('   To revert: cp src/lib/vapi.js.bak src/lib/vapi.js');
  } else {
    console.log('\n✅ All verifications passed. File is ready to deploy.');
  }
}

main();
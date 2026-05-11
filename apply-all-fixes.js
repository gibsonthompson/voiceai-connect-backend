// ============================================================================
// APPLY ALL FIXES — Run from backend root:
//   node apply-all-fixes.js
//
// Fixes:
// 1. FK disambiguation — agencies(*) → agencies!clients_agency_id_fkey(*)
//    in client-signup.js, stripe-connect.js, google-auth.js, client-routes.js
// 2. Webhook timeout — 15s AbortController on both AI summary functions
// 3. Test client industry — 'general' → 'home_services'
// ============================================================================
const fs = require('fs');

let totalFixes = 0;

function patch(file, find, replace, label) {
  let code = fs.readFileSync(file, 'utf8');
  if (!code.includes(find)) {
    console.log(`  ⚠️  SKIP (not found): ${label}`);
    return;
  }
  code = code.replace(find, replace);
  fs.writeFileSync(file, code);
  totalFixes++;
  console.log(`  ✅ ${label}`);
}

function patchAll(file, find, replace, label) {
  let code = fs.readFileSync(file, 'utf8');
  const count = code.split(find).length - 1;
  if (count === 0) {
    console.log(`  ⚠️  SKIP (not found): ${label}`);
    return;
  }
  code = code.replaceAll(find, replace);
  fs.writeFileSync(file, code);
  totalFixes += count;
  console.log(`  ✅ ${label} (${count} replacements)`);
}

// ============================================================================
// FIX 1: FK DISAMBIGUATION
// ============================================================================
console.log('\n🔧 Fix 1: FK disambiguation (agencies(*) on clients table)\n');

patchAll(
  'src/routes/client-signup.js',
  "agencies(*)",
  "agencies!clients_agency_id_fkey(*)",
  'client-signup.js'
);

patchAll(
  'src/routes/stripe-connect.js',
  "agencies(*)",
  "agencies!clients_agency_id_fkey(*)",
  'stripe-connect.js'
);

patchAll(
  'src/routes/google-auth.js',
  "agencies(*)",
  "agencies!clients_agency_id_fkey(*)",
  'google-auth.js'
);

patch(
  'src/routes/client-routes.js',
  "agency:agencies (",
  "agency:agencies!clients_agency_id_fkey (",
  'client-routes.js'
);

// ============================================================================
// FIX 2: WEBHOOK TIMEOUT (generateAISummary)
// ============================================================================
console.log('\n🔧 Fix 2: Webhook timeout (15s AbortController)\n');

patch(
  'src/routes/vapi-webhook.js',
  `  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 500, temperature: 0.3, messages: [{ role: "user", content: prompt }] })
    });
    if (!response.ok) throw new Error(\`Claude API failed: \${response.status}\`);`,
  `  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 500, temperature: 0.3, messages: [{ role: "user", content: prompt }] }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!response.ok) throw new Error(\`Claude API failed: \${response.status}\`);`,
  'generateAISummary timeout'
);

// generateDemoSummary timeout
patch(
  'src/routes/vapi-webhook.js',
  `    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        temperature: 0.3,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) throw new Error(\`Claude API failed: \${response.status}\`);`,
  `    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        temperature: 0.3,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) throw new Error(\`Claude API failed: \${response.status}\`);`,
  'generateDemoSummary timeout'
);

// ============================================================================
// FIX 3: TEST CLIENT INDUSTRY
// ============================================================================
console.log('\n🔧 Fix 3: Test client default industry\n');

patch(
  'src/routes/test-client.js',
  "industry: 'general',",
  "industry: 'home_services',",
  "test-client.js: general → home_services"
);

// Also fix the assistant creation call to use home_services
patch(
  'src/routes/test-client.js',
  "      'general',       // generic industry",
  "      'home_services', // default test client industry",
  "test-client.js: createIndustryAssistant industry arg"
);

// ============================================================================
// SUMMARY
// ============================================================================
console.log(`\n✅ All done — ${totalFixes} fixes applied`);
console.log('\nNext steps:');
console.log('  git diff                   # verify changes');
console.log('  git add . && git commit -m "fix: FK disambiguation, webhook timeout, test client industry" && git push');
console.log('  # Then update existing test client in Supabase:');
console.log("  # UPDATE clients SET industry = 'home_services' WHERE is_test_client = true;");

const fs = require('fs');

// 1. client.js FK fix
let cr = fs.readFileSync('src/routes/client.js', 'utf8');
if (cr.includes('agency:agencies (')) {
  cr = cr.replace('agency:agencies (', 'agency:agencies!clients_agency_id_fkey (');
  fs.writeFileSync('src/routes/client.js', cr);
  console.log('✅ client.js — FK fixed');
} else {
  console.log('⚠️  client.js — pattern not found (may already be fixed)');
}

// 2. test-client.js industry
let tc = fs.readFileSync('src/routes/test-client.js', 'utf8');
let tcFixed = 0;
if (tc.includes("industry: 'general',")) {
  tc = tc.replace("industry: 'general',", "industry: 'home_services',");
  tcFixed++;
}
if (tc.includes("'general',       // generic industry")) {
  tc = tc.replace("'general',       // generic industry", "'home_services', // default test client industry");
  tcFixed++;
}
if (tcFixed > 0) {
  fs.writeFileSync('src/routes/test-client.js', tc);
  console.log('✅ test-client.js — industry fixed (' + tcFixed + ' replacements)');
} else {
  console.log('⚠️  test-client.js — already fixed or pattern mismatch');
}

// 3. vapi-webhook.js — add timeout to generateAISummary
let wh = fs.readFileSync('src/routes/vapi-webhook.js', 'utf8');
let whFixed = 0;

// Pattern: the generateAISummary fetch (uses double quotes)
if (wh.includes('const response = await fetch("https://api.anthropic.com/v1/messages"') && !wh.includes('AbortController')) {
  wh = wh.replace(
    'const response = await fetch("https://api.anthropic.com/v1/messages", {\n      method: "POST",',
    'const controller = new AbortController();\n    const timeout = setTimeout(() => controller.abort(), 15000);\n    const response = await fetch("https://api.anthropic.com/v1/messages", {\n      method: "POST",\n      signal: controller.signal,'
  );
  // Add clearTimeout after the response line
  wh = wh.replace(
    '    if (!response.ok) throw new Error(`Claude API failed: ${response.status}`);\n    const data = await response.json();\n    let text = data.content[0].text.trim().replace(/```json\\n?/g, "").replace(/```\\n?/g, "").trim();',
    '    clearTimeout(timeout);\n    if (!response.ok) throw new Error(`Claude API failed: ${response.status}`);\n    const data = await response.json();\n    let text = data.content[0].text.trim().replace(/```json\\n?/g, "").replace(/```\\n?/g, "").trim();'
  );
  whFixed++;
  console.log('✅ vapi-webhook.js — generateAISummary timeout added');
}

// Pattern: the generateDemoSummary fetch (uses single quotes)
if (wh.includes("const response = await fetch('https://api.anthropic.com/v1/messages'")) {
  wh = wh.replace(
    "const response = await fetch('https://api.anthropic.com/v1/messages', {\n      method: 'POST',",
    "const controller2 = new AbortController();\n    const timeout2 = setTimeout(() => controller2.abort(), 15000);\n    const response = await fetch('https://api.anthropic.com/v1/messages', {\n      method: 'POST',\n      signal: controller2.signal,"
  );
  wh = wh.replace(
    "    if (!response.ok) throw new Error(`Claude API failed: ${response.status}`);\n\n    const data = await response.json();\n    let text = data.content[0].text.trim()\n      .replace(/```json\\n?/g, '')\n      .replace(/```\\n?/g, '')\n      .trim();",
    "    clearTimeout(timeout2);\n    if (!response.ok) throw new Error(`Claude API failed: ${response.status}`);\n\n    const data = await response.json();\n    let text = data.content[0].text.trim()\n      .replace(/```json\\n?/g, '')\n      .replace(/```\\n?/g, '')\n      .trim();"
  );
  whFixed++;
  console.log('✅ vapi-webhook.js — generateDemoSummary timeout added');
}

if (whFixed > 0) {
  fs.writeFileSync('src/routes/vapi-webhook.js', wh);
} else {
  console.log('⚠️  vapi-webhook.js — timeout patterns not matched (check manually)');
  console.log('   Manually add AbortController + signal + clearTimeout around fetch calls in:');
  console.log('   - generateAISummary function');
  console.log('   - generateDemoSummary function');
}

console.log('\n🎯 Done. Run: git diff');

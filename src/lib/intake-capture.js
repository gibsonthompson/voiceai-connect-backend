// ============================================================================
// Intake capture (post-call)
// VoiceAI Connect
// ----------------------------------------------------------------------------
// After a call for a client with an intake template enabled, pull the
// structured order/request out of the transcript (Claude, using the template's
// extraction schema), store it in intake_records, and optionally text it to the
// owner. Isolated and fully guarded so it can never disturb the call pipeline:
// every failure is caught and logged, nothing throws back into the webhook.
// ============================================================================

const { getIntakeTemplate } = require('./intake-templates');
const { normalizeIntakeSchema, buildIntakeExtractionSchema, computeOrderTotals } = require('./intake-prompt');
const { sendAndLogSMS } = require('./sms-logger');

const INTAKE_MODEL = process.env.INTAKE_MODEL || 'claude-sonnet-4-6';

// A client's own customized schema wins; otherwise the platform template it points at.
function resolveSchema(client) {
  const raw = client.intake_config || (client.intake_template_key ? getIntakeTemplate(client.intake_template_key) : null);
  return normalizeIntakeSchema(raw);
}

async function extractRecord(transcript, schema) {
  const extractionSchema = buildIntakeExtractionSchema(schema);
  if (!extractionSchema) return null;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const prompt = `You are extracting a structured "${schema.label}" from a phone call transcript for a business.\n\n`
    + `Return ONLY a valid JSON object with exactly these keys. Use null for anything the caller did not clearly provide, never guess or invent a value:\n`
    + `${JSON.stringify(extractionSchema.properties, null, 2)}\n\n`
    + `Transcript:\n${transcript}\n\n`
    + `Return ONLY the JSON object, no prose, no code fences.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: INTAKE_MODEL, max_tokens: 700, temperature: 0, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await res.json();
    const text = (data && data.content && data.content[0] && data.content[0].text) || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    // Keep only keys the schema defines.
    const clean = {};
    for (const f of schema.fields) clean[f.key] = parsed[f.key] === undefined ? null : parsed[f.key];
    // Priced order lines ride alongside the fields when the form has a price list.
    if (schema.pricing && schema.pricing.length && Array.isArray(parsed.order_items)) clean.order_items = parsed.order_items;
    return clean;
  } catch (e) {
    console.warn('⚠️ intake extraction failed:', e && e.message);
    return null;
  }
}

// At least one real field (beyond a lone callback number) was captured.
function hasContent(schema, data) {
  return schema.fields.some((f) => f.type !== 'phone' && data[f.key] !== null && data[f.key] !== undefined && String(data[f.key]).trim() !== '');
}

function formatRecordSms(schema, data, businessName) {
  const lines = [`New ${schema.label} for ${businessName}:`];
  for (const f of schema.fields) {
    const v = data[f.key];
    if (v === null || v === undefined || String(v).trim() === '') continue;
    lines.push(`${f.label}: ${v}`);
  }
  if (Array.isArray(data.order_items) && data.order_items.length) {
    lines.push('Order:');
    for (const li of data.order_items) {
      lines.push(`  ${li.quantity} x ${li.item}${li.unit ? ` (${li.unit})` : ''} - $${Number(li.subtotal).toFixed(2)}`);
    }
    if (data.order_total != null) lines.push(`Total: $${Number(data.order_total).toFixed(2)}`);
  }
  return lines.join('\n');
}

// Main entry. Safe to await directly; it resolves to true if a record was saved.
async function captureIntake({ client, agency, transcript, callId, callerPhone, supabase }) {
  try {
    if (!client || !client.intake_enabled || !transcript || String(transcript).length < 20) return false;
    const schema = resolveSchema(client);
    if (!schema) return false;

    const data = await extractRecord(transcript, schema);
    if (!data || !hasContent(schema, data)) return false;

    // Price the order in code: replace the raw order_items with priced line items
    // and a computed total, so money is never left to the model's arithmetic.
    if (schema.pricing && schema.pricing.length && Array.isArray(data.order_items)) {
      const totals = computeOrderTotals(schema.pricing, data.order_items);
      if (totals) { data.order_items = totals.lineItems; data.order_total = totals.total; }
      else { delete data.order_items; }
    }

    try {
      await supabase.from('intake_records').insert([{
        agency_id: (agency && agency.id) || client.agency_id || null,
        client_id: client.id,
        call_id: callId || null,
        template_key: client.intake_template_key || schema.key || null,
        data,
        caller_phone: callerPhone || null,
      }]);
    } catch (e) {
      console.warn('⚠️ intake record insert failed:', e && e.message);
    }

    if (client.intake_sms_enabled) {
      const to = client.intake_sms_number || client.owner_phone;
      if (to) {
        try {
          await sendAndLogSMS({
            phone: to,
            message: formatRecordSms(schema, data, client.business_name),
            agencyId: (agency && agency.id) || client.agency_id,
            recipientType: 'client_owner',
            messageType: 'intake_record',
            from: (agency && agency.demo_phone_number) || null,
            metadata: { clientId: client.id, callId },
          });
        } catch (e) {
          console.warn('⚠️ intake SMS failed:', e && e.message);
        }
      }
    }
    return true;
  } catch (e) {
    console.warn('⚠️ intake capture failed (non-fatal):', e && e.message);
    return false;
  }
}

module.exports = { captureIntake };

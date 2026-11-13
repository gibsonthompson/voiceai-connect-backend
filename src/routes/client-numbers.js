// ============================================================================
// CLIENT EXTRA PHONE NUMBERS
// ----------------------------------------------------------------------------
// An agency can add extra phone numbers to a client. Every extra number rings
// the SAME AI receptionist as the client's primary number (the inbound resolver
// getClientByVapiPhoneNumber matches client_phone_numbers too), so a client can
// put different numbers on different ads or channels and track which ones ring.
//
// Billing: the platform charges the AGENCY a flat $9.99/mo per extra number
// (syncExtraNumberBillingQuantity), independent of the agency's plan and of
// whatever the agency charges its own client for the number. Removing a number
// releases the Telnyx line (stops the rental) and reconciles the charge down.
//
// Mounted at /api/agency, so the routes are:
//   GET    /api/agency/:agencyId/clients/:clientId/numbers
//   POST   /api/agency/:agencyId/clients/:clientId/numbers        { areaCode?, label? }
//   DELETE /api/agency/:agencyId/clients/:clientId/numbers/:numberId
// ============================================================================
const express = require('express');
const { supabase } = require('../lib/supabase');
const { requireAgencyAccess } = require('./auth');
const { provisionPhoneNumber, fullyReleaseNumber } = require('../lib/vapi');
const { syncExtraNumberBillingQuantity } = require('./stripe-platform');

const router = express.Router();

// Flat platform charge per extra number, in cents. Surfaced to the UI so the
// agency sees exactly what it pays before adding one.
const EXTRA_NUMBER_PRICE_CENTS = 999;
// Guardrail so a stray UI loop can't order a pile of (paid) numbers.
const MAX_EXTRA_NUMBERS = 5;

// Load the client and confirm it belongs to the agency in the URL. The auth
// middleware already proved the caller owns :agencyId; this proves :clientId is
// one of that agency's clients.
async function loadOwnedClient(agencyId, clientId) {
  const { data } = await supabase
    .from('clients')
    .select('id, agency_id, business_name, country, phone_area_code, phone_number, voice_routing')
    .eq('id', clientId)
    .single();
  if (!data || data.agency_id !== agencyId) return null;
  return data;
}

router.get('/:agencyId/clients/:clientId/numbers', requireAgencyAccess('dashboard'), async (req, res) => {
  const { agencyId, clientId } = req.params;
  const client = await loadOwnedClient(agencyId, clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const { data } = await supabase
    .from('client_phone_numbers')
    .select('id, e164, label, status, created_at')
    .eq('client_id', clientId)
    .eq('status', 'active')
    .order('created_at', { ascending: true });

  res.json({
    primary: client.phone_number || null,
    numbers: data || [],
    monthlyCostCents: EXTRA_NUMBER_PRICE_CENTS,
    max: MAX_EXTRA_NUMBERS,
  });
});

router.post('/:agencyId/clients/:clientId/numbers', requireAgencyAccess('dashboard'), async (req, res) => {
  const { agencyId, clientId } = req.params;
  const client = await loadOwnedClient(agencyId, clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const { count } = await supabase
    .from('client_phone_numbers')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .eq('status', 'active');
  if ((count || 0) >= MAX_EXTRA_NUMBERS) {
    return res.status(400).json({ error: `Up to ${MAX_EXTRA_NUMBERS} additional numbers per client.` });
  }

  // provisionPhoneNumber only has US/CA (Telnyx) inventory. Blocking other
  // countries up front avoids handing, say, a UK client a US number their
  // callers can't dial. (International clients run their primary on BYOT/Twilio.)
  const rawCountry = String(client.country || 'US').toUpperCase();
  if (rawCountry !== 'US' && rawCountry !== 'CA') {
    return res.status(400).json({ error: `Extra numbers are available for US and Canada clients only (this client is set to ${rawCountry}).` });
  }
  const country = rawCountry === 'CA' ? 'CA' : 'US';

  const rawArea = (req.body && req.body.areaCode ? String(req.body.areaCode) : '').replace(/\D/g, '').slice(0, 3);
  const areaCode = rawArea || client.phone_area_code || null;
  const label = req.body && req.body.label ? String(req.body.label).slice(0, 60) : null;

  // Match the client's own routing so the extra line behaves EXACTLY like its
  // primary. Nearly every client is telnyx_cc (whisper warm-transfer): that
  // branch points the number at the platform Call Control app, and inbound calls
  // hit /webhook/telnyx-voice, which resolves the client with the same
  // getClientByVapiPhoneNumber helper we extended, so whisper + warm transfer
  // work on the extra number. vapi_direct clients import to VAPI as before.
  const voiceRouting = client.voice_routing || 'vapi_direct';

  let provisioned;
  try {
    provisioned = await provisionPhoneNumber(areaCode, { country, voiceRouting });
  } catch (e) {
    const where = areaCode ? ` for area code ${areaCode}` : '';
    return res.status(502).json({ error: `Could not provision a number${where}. ${e.message}` });
  }

  // telnyx_cc returns the Telnyx number id in .id (no VAPI phone object);
  // vapi_direct returns the VAPI phone id in .id. Store each in its own column so
  // teardown releases the right resource.
  const isCc = provisioned.provider === 'telnyx_cc' || provisioned.voice_routing === 'telnyx_cc';
  const { data: row, error } = await supabase
    .from('client_phone_numbers')
    .insert({
      client_id: clientId,
      agency_id: agencyId,
      e164: provisioned.number,
      vapi_phone_number_id: isCc ? null : (provisioned.id || null),
      telnyx_number_id: provisioned.telnyx_number_id || (isCc ? provisioned.id : null) || null,
      provider: provisioned.provider || (isCc ? 'telnyx_cc' : 'telnyx'),
      label,
      status: 'active',
    })
    .select('id, e164, label, status, created_at')
    .single();

  if (error) {
    // Don't leave a paid-for orphan line on Telnyx if the row didn't save.
    try { await fullyReleaseNumber(isCc ? null : provisioned.id, provisioned.number); } catch (_) {}
    console.error('client-numbers insert failed:', error.message);
    return res.status(500).json({ error: 'Number was provisioned but could not be saved. It has been released, please try again.' });
  }

  await syncExtraNumberBillingQuantity(agencyId);
  res.json({ number: row });
});

router.delete('/:agencyId/clients/:clientId/numbers/:numberId', requireAgencyAccess('dashboard'), async (req, res) => {
  const { agencyId, clientId, numberId } = req.params;
  const client = await loadOwnedClient(agencyId, clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const { data: row } = await supabase
    .from('client_phone_numbers')
    .select('id, e164, vapi_phone_number_id, agency_id, client_id')
    .eq('id', numberId)
    .single();
  if (!row || row.client_id !== clientId || row.agency_id !== agencyId) {
    return res.status(404).json({ error: 'Number not found' });
  }

  // Release the line first so the Telnyx rental stops. Only drop the row once
  // the release is CONFIRMED: otherwise we would keep paying for a line we no
  // longer track. fullyReleaseNumber returns telnyxReleased=true on success or
  // when the number is already gone from the account, and false on a failed or
  // unconfirmed release. On an unconfirmed release we keep the row (so billing
  // still matches the still-rented line and the number is never lost) and ask
  // the agency to retry; fullyReleaseNumber is idempotent so a retry is safe.
  let released = { vapiDeleted: false, telnyxReleased: false };
  try {
    released = await fullyReleaseNumber(row.vapi_phone_number_id, row.e164);
  } catch (e) {
    console.error(`fullyReleaseNumber threw for ${row.e164}:`, e.message);
  }
  if (!released || released.telnyxReleased !== true) {
    console.error(`Extra number ${row.e164}: Telnyx release not confirmed, keeping row for retry.`);
    return res.status(502).json({ error: 'Could not confirm the number was released yet. It is still active, please try again in a moment.' });
  }

  await supabase.from('client_phone_numbers').delete().eq('id', numberId);
  await syncExtraNumberBillingQuantity(agencyId);
  res.json({ ok: true });
});

module.exports = router;

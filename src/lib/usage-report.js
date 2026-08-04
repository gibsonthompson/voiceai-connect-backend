// ============================================================================
// MONTHLY USAGE REPORT + PER-CLIENT STATEMENT ENGINE
// Location: src/lib/usage-report.js
// Created: 2026-08-04
// ----------------------------------------------------------------------------
// Builds a month's usage statement for an agency from data that already
// persists: usage_records (billed minutes, keyed by billing_month) and calls
// (call + spam counts, keyed by created_at). Nothing here is deleted by the
// monthly counter reset, so ANY past month can be recomputed on demand.
//
// Two perspectives in one report:
//   1. Per client (client -> agency): what each of the agency's clients used
//      and owes the agency this month. Doubles as a manual invoice for clients
//      the agency bills off-Stripe (PayPal, etc.). Spam minutes are excluded
//      from the client's billable minutes to match the public FAQ promise that
//      spam calls do not count, even though the platform metered them.
//   2. Platform rollup (agency -> platform): what the agency owes VoiceAI
//      Connect this month, computed from PLAN_RATES the same way
//      getAgencyUsageSummary does, but for the requested month.
//
// All money is in integer cents. Use formatCents() for display.
// ============================================================================
const { supabase } = require('./supabase');
const { getPlanRates } = require('./usage-tracker');

// ----------------------------------------------------------------------------
// Resolve a 'YYYY-MM' (or undefined = current month) into the billing_month
// string used by usage_records and the [start, end) created_at range used by
// calls. Mirrors usage-tracker's billing_month computation (local date, day 1,
// midnight), so it lines up with rows already written by insertUsageRecord.
// ----------------------------------------------------------------------------
function resolveMonth(month) {
  let base;
  if (typeof month === 'string' && /^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split('-').map(Number);
    base = new Date(y, m - 1, 1);
  } else {
    base = new Date();
    base.setDate(1);
  }
  base.setHours(0, 0, 0, 0);
  const start = new Date(base);
  const end = new Date(base.getFullYear(), base.getMonth() + 1, 1);
  end.setHours(0, 0, 0, 0);
  const billingMonthStr = start.toISOString().split('T')[0];
  const label = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;
  return { start, end, billingMonthStr, label };
}

function formatCents(cents) {
  const n = Math.round(Number(cents) || 0) / 100;
  return `$${n.toFixed(2)}`;
}

// ----------------------------------------------------------------------------
// getAgencyMonthlyReport(agencyId, { month })
// Returns the full statement object, or null if the agency is not found.
// ----------------------------------------------------------------------------
async function getAgencyMonthlyReport(agencyId, opts = {}) {
  const { start, end, billingMonthStr, label } = resolveMonth(opts.month);

  const { data: agency, error: agencyErr } = await supabase
    .from('agencies')
    .select('id, name, email, support_email, plan_type, currency, display_currency, minute_pass_through, client_minute_rate_cents, price_starter, price_pro, price_growth, included_minutes_starter, included_minutes_pro, included_minutes_growth')
    .eq('id', agencyId)
    .single();

  if (agencyErr || !agency) return null;

  const { data: allClients } = await supabase
    .from('clients')
    .select('id, business_name, plan_type, status, subscription_status, is_test_client, stripe_connected_subscription_id')
    .eq('agency_id', agencyId);

  // Real (non-test) clients only, consistent with dashboard/analytics.
  const clients = (allClients || []).filter(c => !c.is_test_client);
  const clientIds = clients.map(c => c.id);

  // Usage records for the month (billed minutes). Keyed by billing_month.
  const { data: usage } = await supabase
    .from('usage_records')
    .select('client_id, call_id, duration_minutes')
    .eq('agency_id', agencyId)
    .eq('billing_month', billingMonthStr);

  // Calls for the month (counts + spam). calls has no billing_month, so filter
  // by created_at range and the agency's real client ids.
  let callRows = [];
  if (clientIds.length > 0) {
    const { data } = await supabase
      .from('calls')
      .select('id, client_id, is_spam')
      .in('client_id', clientIds)
      .gte('created_at', start.toISOString())
      .lt('created_at', end.toISOString());
    callRows = data || [];
  }

  // Spam call ids so spam minutes can be split out of the billable total.
  const spamCallIds = new Set(callRows.filter(c => c.is_spam === true).map(c => c.id));

  const callsByClient = {};
  for (const c of callRows) {
    const b = callsByClient[c.client_id] || (callsByClient[c.client_id] = { total: 0, spam: 0 });
    b.total += 1;
    if (c.is_spam === true) b.spam += 1;
  }

  const minutesByClient = {};
  for (const u of usage || []) {
    const b = minutesByClient[u.client_id] || (minutesByClient[u.client_id] = { billable: 0, spam: 0 });
    const mins = Number(u.duration_minutes) || 0;
    if (u.call_id && spamCallIds.has(u.call_id)) b.spam += mins;
    else b.billable += mins;
  }

  const rateCents = Number(agency.client_minute_rate_cents) || 0;
  const passThrough = agency.minute_pass_through === true && rateCents > 0;

  const lineItems = [];
  let totalCalls = 0;
  let totalSpam = 0;
  let totalMinutesUsed = 0;      // non-spam billed minutes across clients
  let totalMeteredMinutes = 0;   // all billed minutes incl spam (what platform metered)
  let totalBillableMinutes = 0;
  let totalMinuteChargeCents = 0;
  let totalBaseCents = 0;

  for (const client of clients) {
    const plan = String(client.plan_type || 'starter').toLowerCase();
    const includedMinutes = Number(agency[`included_minutes_${plan}`]) || 0;
    const basePlanCents = Number(agency[`price_${plan}`]) || 0;

    const cm = callsByClient[client.id] || { total: 0, spam: 0 };
    const mm = minutesByClient[client.id] || { billable: 0, spam: 0 };

    const minutesUsed = mm.billable; // non-spam
    const billableMinutes = passThrough ? Math.max(0, minutesUsed - includedMinutes) : 0;
    const minuteChargeCents = Math.round(billableMinutes * rateCents);
    const totalCents = basePlanCents + minuteChargeCents;
    const billingMode = client.stripe_connected_subscription_id ? 'stripe' : 'manual';

    totalCalls += cm.total;
    totalSpam += cm.spam;
    totalMinutesUsed += minutesUsed;
    totalMeteredMinutes += mm.billable + mm.spam;
    totalBillableMinutes += billableMinutes;
    totalMinuteChargeCents += minuteChargeCents;
    totalBaseCents += basePlanCents;

    lineItems.push({
      clientId: client.id,
      businessName: client.business_name || 'Unnamed client',
      planType: plan,
      status: client.status || null,
      totalCalls: cm.total,
      spamCalls: cm.spam,
      minutesUsed,
      includedMinutes,
      billableMinutes,
      perMinuteRateCents: passThrough ? rateCents : 0,
      minuteChargeCents,
      basePlanCents,
      totalCents,
      billingMode,
    });
  }

  lineItems.sort((a, b) => b.totalCents - a.totalCents || b.minutesUsed - a.minutesUsed);

  // Platform rollup (agency -> platform) for THIS month, from PLAN_RATES.
  // Mirrors getAgencyUsageSummary but scoped to the requested month and stated
  // in cents. billable_clients is the current active real-client count.
  const rates = getPlanRates(agency.plan_type);
  const billableClients = clients.filter(c => c.status === 'active').length;
  const platformFeeCents = Math.round(rates.platformFee * 100);
  const perClientRateCents = Math.round(rates.perClient * 100);
  const perMinuteRateCents = Math.round(rates.perMinute * 100);
  const clientChargeCents = Math.round(billableClients * rates.perClient * 100);
  const minuteChargeCents = Math.round(totalMeteredMinutes * rates.perMinute * 100);
  const platformTotalCents = platformFeeCents + clientChargeCents + minuteChargeCents;

  return {
    agencyId: agency.id,
    agencyName: agency.name,
    month: label,
    billingMonth: billingMonthStr,
    generatedAt: new Date().toISOString(),
    passThroughEnabled: passThrough,
    clientMinuteRateCents: rateCents,
    clients: lineItems,
    totals: {
      clients: lineItems.length,
      calls: totalCalls,
      spamBlocked: totalSpam,
      minutesUsed: totalMinutesUsed,
      meteredMinutes: totalMeteredMinutes,
      billableMinutes: totalBillableMinutes,
      minuteChargeCents: totalMinuteChargeCents,
      baseCents: totalBaseCents,
      grandTotalCents: totalBaseCents + totalMinuteChargeCents,
    },
    platform: {
      planType: agency.plan_type || null,
      platformFeeCents,
      billableClients,
      perClientRateCents,
      clientChargeCents,
      perMinuteRateCents,
      meteredMinutes: totalMeteredMinutes,
      minuteChargeCents,
      estimatedTotalCents: platformTotalCents,
    },
  };
}

// ----------------------------------------------------------------------------
// CSV export (one row per client + a totals row). For the "save" action.
// ----------------------------------------------------------------------------
function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCSV(report) {
  const rows = [];
  rows.push(['Client', 'Plan', 'Billing', 'Calls', 'Spam blocked', 'Minutes used', 'Included', 'Billable minutes', 'Rate', 'Minute charge', 'Base plan', 'Total'].join(','));
  for (const c of report.clients) {
    rows.push([
      csvEscape(c.businessName),
      c.planType,
      c.billingMode,
      c.totalCalls,
      c.spamCalls,
      c.minutesUsed,
      c.includedMinutes,
      c.billableMinutes,
      formatCents(c.perMinuteRateCents),
      formatCents(c.minuteChargeCents),
      formatCents(c.basePlanCents),
      formatCents(c.totalCents),
    ].join(','));
  }
  const t = report.totals;
  rows.push([
    'TOTALS', '', '', t.calls, t.spamBlocked, t.minutesUsed, '', t.billableMinutes, '',
    formatCents(t.minuteChargeCents), formatCents(t.baseCents), formatCents(t.grandTotalCents),
  ].join(','));
  return rows.join('\n');
}

// ----------------------------------------------------------------------------
// Printable HTML statement. Used as the email body AND served at ?format=html
// so an agency can open, print, or save it as a PDF invoice. Self-contained,
// inline styles only.
// ----------------------------------------------------------------------------
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function renderReportHTML(report) {
  const rowsHtml = report.clients.map(c => `
      <tr>
        <td>${esc(c.businessName)}</td>
        <td style="text-transform:capitalize">${esc(c.planType)}</td>
        <td>${esc(c.billingMode)}</td>
        <td style="text-align:right">${c.totalCalls}</td>
        <td style="text-align:right">${c.spamCalls}</td>
        <td style="text-align:right">${c.minutesUsed}</td>
        <td style="text-align:right">${c.includedMinutes}</td>
        <td style="text-align:right">${c.billableMinutes}</td>
        <td style="text-align:right">${formatCents(c.minuteChargeCents)}</td>
        <td style="text-align:right">${formatCents(c.basePlanCents)}</td>
        <td style="text-align:right;font-weight:600">${formatCents(c.totalCents)}</td>
      </tr>`).join('');

  const t = report.totals;
  const p = report.platform;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Usage statement ${esc(report.month)} - ${esc(report.agencyName)}</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #1f2937; margin: 0; padding: 2rem; background: #ffffff; }
  .wrap { max-width: 920px; margin: 0 auto; }
  h1 { font-size: 1.35rem; margin: 0 0 0.25rem; }
  .muted { color: #6b7280; font-size: 0.85rem; }
  table { width: 100%; border-collapse: collapse; margin-top: 1.25rem; font-size: 0.8rem; }
  th, td { padding: 0.5rem 0.6rem; border-bottom: 1px solid #e5e7eb; }
  th { text-align: left; color: #6b7280; font-weight: 600; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.03em; }
  tfoot td { font-weight: 700; border-top: 2px solid #1f2937; border-bottom: none; }
  .summary { margin-top: 1.5rem; display: flex; gap: 1rem; flex-wrap: wrap; }
  .card { border: 1px solid #e5e7eb; border-radius: 10px; padding: 1rem 1.25rem; min-width: 200px; }
  .card h3 { margin: 0 0 0.5rem; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.03em; color: #6b7280; }
  .card .big { font-size: 1.4rem; font-weight: 800; }
  .card p { margin: 0.15rem 0; font-size: 0.8rem; color: #374151; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>${esc(report.agencyName)}</h1>
    <div class="muted">Usage statement for ${esc(report.month)}. Generated ${esc(report.generatedAt.split('T')[0])}.</div>

    <table>
      <thead>
        <tr>
          <th>Client</th><th>Plan</th><th>Billing</th>
          <th style="text-align:right">Calls</th><th style="text-align:right">Spam blocked</th>
          <th style="text-align:right">Minutes</th><th style="text-align:right">Included</th><th style="text-align:right">Billable min</th>
          <th style="text-align:right">Minute charge</th><th style="text-align:right">Base plan</th><th style="text-align:right">Total</th>
        </tr>
      </thead>
      <tbody>${rowsHtml || '<tr><td colspan="11" class="muted">No client activity this month.</td></tr>'}</tbody>
      <tfoot>
        <tr>
          <td colspan="3">Totals</td>
          <td style="text-align:right">${t.calls}</td>
          <td style="text-align:right">${t.spamBlocked}</td>
          <td style="text-align:right">${t.minutesUsed}</td>
          <td></td>
          <td style="text-align:right">${t.billableMinutes}</td>
          <td style="text-align:right">${formatCents(t.minuteChargeCents)}</td>
          <td style="text-align:right">${formatCents(t.baseCents)}</td>
          <td style="text-align:right">${formatCents(t.grandTotalCents)}</td>
        </tr>
      </tfoot>
    </table>

    <div class="summary">
      <div class="card">
        <h3>Billed to your clients</h3>
        <div class="big">${formatCents(t.grandTotalCents)}</div>
        <p>${t.clients} clients, ${t.calls} calls, ${t.spamBlocked} spam blocked</p>
        <p>${t.minutesUsed} minutes used, ${t.billableMinutes} billable</p>
      </div>
      <div class="card">
        <h3>Your platform cost (${esc(p.planType || 'plan')})</h3>
        <div class="big">${formatCents(p.estimatedTotalCents)}</div>
        <p>Platform fee ${formatCents(p.platformFeeCents)}</p>
        <p>Clients ${p.billableClients} x ${formatCents(p.perClientRateCents)} = ${formatCents(p.clientChargeCents)}</p>
        <p>${p.meteredMinutes} min x ${formatCents(p.perMinuteRateCents)} = ${formatCents(p.minuteChargeCents)}</p>
      </div>
    </div>
    <p class="muted" style="margin-top:1.5rem">Spam calls are shown for visibility and are excluded from client billable minutes.</p>
  </div>
</body>
</html>`;
}

module.exports = {
  getAgencyMonthlyReport,
  toCSV,
  renderReportHTML,
  formatCents,
  resolveMonth,
};
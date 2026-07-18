'use strict';

const crypto = require('crypto');
const queries = require('../db/queries');
const logger = require('../utils/logger');

function formatNaira(kobo) {
  const naira = Number(kobo) / 100;
  return `\u20a6${Math.round(naira).toLocaleString('en-NG')}`;
}

function escapeHtml(unsafe) {
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Rule-based natural-language insight — no external LLM call in this
 * codebase, so this is a template that composes whichever observations
 * actually apply: revenue trend, product concentration, and a persistent
 * top-debtor callout when the same customer has led the debt list for
 * multiple consecutive months.
 */
function buildAiInsightText({ growthPct, topProducts, totalRevenueKobo, topDebtor, debtorStreakMonths }) {
  const sentences = [];

  if (growthPct != null) {
    sentences.push(`Your revenue ${growthPct >= 0 ? 'grew' : 'declined'} ${Math.abs(growthPct).toFixed(0)}% month-over-month.`);
  }

  if (topProducts.length >= 2 && Number(totalRevenueKobo) > 0) {
    const top2Kobo = Number(topProducts[0].revenue_kobo) + Number(topProducts[1].revenue_kobo);
    const pct = Math.round((top2Kobo / Number(totalRevenueKobo)) * 100);
    const names = `${capitalize(topProducts[0].name)} and ${capitalize(topProducts[1].name)}`;
    sentences.push(`${names} drive ${pct}% of your income. Consider restocking both ahead of next month.`);
  }

  if (topDebtor && debtorStreakMonths >= 2) {
    sentences.push(
      `${topDebtor.counterparty_name} has been your highest debtor for ${debtorStreakMonths} months \u2014 a gentle reminder is recommended.`
    );
  }

  if (sentences.length === 0) {
    sentences.push('Keep logging your sales daily \u2014 more data means sharper insights next month.');
  }

  return sentences.join(' ');
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * Computes the full data snapshot the report is built from. Snapshotted
 * (not recomputed on every page view) so the report a merchant opens days
 * later still matches what they were told at send time.
 */
async function buildReportSnapshot({ merchant, periodKey, monthStart, monthEnd, prevMonthStart }) {
  const [current, previous, debtors, topProducts, tradeDays, topDebtor] = await Promise.all([
    queries.getPeriodSummary(merchant.id, monthStart, monthEnd),
    queries.getPeriodSummary(merchant.id, prevMonthStart, monthStart),
    queries.getDebtorBreakdown(merchant.id),
    queries.getTopProductsByRevenue(merchant.id, monthStart, monthEnd),
    queries.getTradeDaysCount(merchant.id, monthStart, monthEnd),
    queries.getTopDebtor(merchant.id),
  ]);

  const weeklyRevenueRows = await queries.getWeeklyRevenue(merchant.id, monthStart, monthEnd);
  const weeklyRevenue = [0, 1, 2, 3, 4].map((i) => {
    const row = weeklyRevenueRows.find((r) => r.week_index === i);
    return { week: i + 1, revenueKobo: row ? Number(row.revenue_kobo) : 0 };
  }).filter((w, idx) => idx < 4 || w.revenueKobo > 0); // show a 5th bar only if it has data

  const totalRevenueKobo = Number(current.sales_kobo);
  const totalOutstandingKobo = debtors.reduce((sum, d) => sum + Number(d.balance_kobo), 0);
  const netCashflowKobo = totalRevenueKobo - Number(current.expenses_kobo);

  const previousRevenueKobo = Number(previous.sales_kobo);
  const growthPct = previousRevenueKobo > 0 ? ((totalRevenueKobo - previousRevenueKobo) / previousRevenueKobo) * 100 : null;

  // Debtor streak: how many consecutive prior months also had this same
  // top debtor, based on previously-saved report snapshots.
  let debtorStreakMonths = topDebtor ? 1 : 0;
  if (topDebtor) {
    const priorReports = await queries.getRecentMonthlyReports(merchant.id, periodKey, 6);
    for (const report of priorReports) {
      const priorTopDebtorName = report.report_data?.topDebtor?.counterparty_name;
      if (priorTopDebtorName && priorTopDebtorName === topDebtor.counterparty_name) {
        debtorStreakMonths += 1;
      } else {
        break;
      }
    }
  }

  const bestWeek = weeklyRevenue.reduce((best, w) => (w.revenueKobo > (best?.revenueKobo || 0) ? w : best), null);

  const aiInsight = buildAiInsightText({ growthPct, topProducts, totalRevenueKobo, topDebtor, debtorStreakMonths });

  return {
    periodKey,
    businessName: merchant.business_name || merchant.whatsapp_display_name || merchant.display_name || 'Merchant',
    totalRevenueKobo,
    growthPct,
    totalOutstandingKobo,
    debtorCount: debtors.length,
    netCashflowKobo,
    tradeDays,
    weeklyRevenue,
    bestWeek,
    debtors,
    topProducts,
    topDebtor,
    debtorStreakMonths,
    aiInsight,
  };
}

function renderDebtorRow(d) {
  const initial = escapeHtml((d.counterparty_name || '?').charAt(0).toUpperCase());
  return `
    <div class="debtor-row">
      <div class="avatar">${initial}</div>
      <div class="debtor-main">
        <div class="debtor-top">
          <span class="debtor-name">${escapeHtml(d.counterparty_name)}</span>
          <span class="debtor-amount">${formatNaira(d.balance_kobo)}</span>
        </div>
        <div class="progress-track"><div class="progress-fill" style="width:${d.percentage}%"></div></div>
      </div>
      <span class="debtor-pct">${d.percentage}%</span>
    </div>`;
}

function renderProductRow(p, index) {
  return `
    <div class="product-row">
      <div class="product-rank">${index + 1}</div>
      <div class="product-main">
        <span class="product-name">${escapeHtml(capitalize(p.name))}</span>
        <span class="product-units">${Math.round(Number(p.total_quantity))} units</span>
      </div>
      <span class="product-revenue">${formatNaira(p.revenue_kobo)}</span>
    </div>`;
}

function renderWeekBar(w, maxKobo) {
  const heightPct = maxKobo > 0 ? Math.max(6, Math.round((w.revenueKobo / maxKobo) * 100)) : 6;
  return `
    <div class="week-col">
      <span class="week-amount">${formatNaira(w.revenueKobo).replace('\u20a6', '\u20a6')}</span>
      <div class="week-bar-track"><div class="week-bar" style="height:${heightPct}%"></div></div>
      <span class="week-label">W${w.week}</span>
    </div>`;
}

function renderReportHtml(snapshot) {
  const maxWeekKobo = Math.max(...snapshot.weeklyRevenue.map((w) => w.revenueKobo), 1);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Kika Monthly Report \u2014 ${escapeHtml(snapshot.periodKey)}</title>
<style>
  :root {
    --bg: #0B0F19; --card-bg: #161B26; --accent: #10B981; --mint: #34D399;
    --amber: #FBBF24; --coral: #F0655A; --text-primary: #F9FAFB; --text-muted: #9CA3AF;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text-primary);
    font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif;
    padding: 24px 16px 60px; max-width: 640px; margin-inline: auto;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .subtitle { color: var(--text-muted); font-size: 14px; margin-bottom: 24px; }
  .stat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 24px; }
  .stat-card { background: var(--card-bg); border-radius: 16px; padding: 16px 14px; }
  .stat-icon { font-size: 20px; margin-bottom: 8px; }
  .stat-label { color: var(--text-muted); font-size: 13px; margin-bottom: 6px; }
  .stat-value { font-size: 22px; font-weight: 700; }
  .stat-value.green { color: var(--mint); }
  .stat-value.amber { color: var(--amber); }
  .stat-sub { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
  .section-card { background: var(--card-bg); border-radius: 16px; padding: 20px; margin-bottom: 20px; }
  .section-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 16px; }
  .section-title { font-size: 17px; font-weight: 700; }
  .section-total { color: var(--amber); font-weight: 700; font-size: 14px; }
  .week-chart { display: flex; justify-content: space-between; align-items: flex-end; height: 160px; margin-bottom: 12px; }
  .week-col { display: flex; flex-direction: column; align-items: center; width: 22%; height: 100%; }
  .week-amount { font-size: 11px; color: var(--text-muted); margin-bottom: 6px; }
  .week-bar-track { flex: 1; width: 100%; display: flex; align-items: flex-end; }
  .week-bar { width: 100%; background: linear-gradient(180deg, var(--mint), #0d5c40); border-radius: 8px 8px 4px 4px; }
  .week-label { font-size: 12px; color: var(--text-muted); margin-top: 6px; }
  .callout { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-muted); border-top: 1px solid rgba(255,255,255,0.08); padding-top: 12px; }
  .callout-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--mint); flex-shrink: 0; }
  .debtor-row { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
  .debtor-row:last-child { margin-bottom: 0; }
  .avatar { width: 36px; height: 36px; border-radius: 50%; background: #4A3416; color: var(--amber); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 14px; flex-shrink: 0; }
  .debtor-main { flex: 1; min-width: 0; }
  .debtor-top { display: flex; justify-content: space-between; font-size: 14px; margin-bottom: 6px; }
  .debtor-name { font-weight: 600; }
  .debtor-amount { color: var(--amber); font-weight: 700; }
  .progress-track { height: 6px; border-radius: 4px; background: rgba(255,255,255,0.08); overflow: hidden; }
  .progress-fill { height: 100%; background: var(--amber); border-radius: 4px; }
  .debtor-pct { font-size: 12px; color: var(--text-muted); width: 36px; text-align: right; flex-shrink: 0; }
  .product-row { display: flex; align-items: center; gap: 14px; padding: 12px 0; border-bottom: 1px solid rgba(255,255,255,0.06); }
  .product-row:last-child { border-bottom: none; }
  .product-rank { width: 26px; height: 26px; border-radius: 8px; background: #3A1620; color: var(--coral); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 13px; flex-shrink: 0; }
  .product-main { flex: 1; display: flex; flex-direction: column; }
  .product-name { font-weight: 600; font-size: 15px; }
  .product-units { font-size: 12px; color: var(--text-muted); }
  .product-revenue { font-weight: 700; font-size: 16px; }
  .insight-card { background: rgba(16,185,129,0.08); border: 1px solid rgba(16,185,129,0.4); border-radius: 16px; padding: 18px; display: flex; gap: 14px; }
  .insight-icon { width: 36px; height: 36px; border-radius: 50%; background: rgba(16,185,129,0.2); display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: 16px; }
  .insight-title { color: var(--mint); font-weight: 700; font-size: 15px; margin-bottom: 6px; }
  .insight-text { font-size: 14px; line-height: 1.5; color: #D1D5DB; }
</style>
</head>
<body>
  <h1>Monthly Report</h1>
  <div class="subtitle">${escapeHtml(snapshot.businessName)} &middot; ${escapeHtml(snapshot.periodKey)}</div>

  <div class="stat-grid">
    <div class="stat-card">
      <div class="stat-icon">\ud83d\udcc8</div>
      <div class="stat-label">Total Revenue</div>
      <div class="stat-value green">${formatNaira(snapshot.totalRevenueKobo)}</div>
      <div class="stat-sub">${snapshot.growthPct == null ? 'No prior data' : `${snapshot.growthPct >= 0 ? '+' : ''}${snapshot.growthPct.toFixed(0)}% vs last month`}</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon">\u26a0\ufe0f</div>
      <div class="stat-label">Outstanding</div>
      <div class="stat-value amber">${formatNaira(snapshot.totalOutstandingKobo)}</div>
      <div class="stat-sub">${snapshot.debtorCount} debtor${snapshot.debtorCount === 1 ? '' : 's'}</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon">\u26a1</div>
      <div class="stat-label">Net Cashflow</div>
      <div class="stat-value green">${formatNaira(snapshot.netCashflowKobo)}</div>
      <div class="stat-sub">Clean profit</div>
    </div>
  </div>

  <div class="section-card">
    <div class="section-header">
      <span class="section-title">Weekly Revenue</span>
      <span class="stat-sub">${escapeHtml(snapshot.periodKey)}</span>
    </div>
    <div class="week-chart">
      ${snapshot.weeklyRevenue.map((w) => renderWeekBar(w, maxWeekKobo)).join('')}
    </div>
    ${snapshot.bestWeek ? `
    <div class="callout">
      <span class="callout-dot"></span>
      <span>Week ${snapshot.bestWeek.week} was your best trading week \u2014 ${formatNaira(snapshot.bestWeek.revenueKobo)} in sales</span>
    </div>` : ''}
  </div>

  <div class="section-card">
    <div class="section-header">
      <span class="section-title">Outstanding Debts</span>
      <span class="section-total">${formatNaira(snapshot.totalOutstandingKobo)} total</span>
    </div>
    ${snapshot.debtors.length > 0 ? snapshot.debtors.map(renderDebtorRow).join('') : '<div class="stat-sub">No outstanding debt \u2014 nice work.</div>'}
  </div>

  <div class="section-card">
    <div class="section-header">
      <span class="section-title">Top Products This Month</span>
    </div>
    ${snapshot.topProducts.length > 0 ? snapshot.topProducts.map(renderProductRow).join('') : '<div class="stat-sub">No itemized sales recorded yet.</div>'}
  </div>

  <div class="insight-card">
    <div class="insight-icon">\u26a1</div>
    <div>
      <div class="insight-title">Kika AI Insight</div>
      <div class="insight-text">${escapeHtml(snapshot.aiInsight)}</div>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Computes the report snapshot, persists it (so the link stays stable),
 * and returns the safe unguessable URL for the "View Full Report" button.
 */
async function generateFullReport({ merchant, periodKey, monthStart, monthEnd, prevMonthStart }) {
  const snapshot = await buildReportSnapshot({ merchant, periodKey, monthStart, monthEnd, prevMonthStart });

  const publicToken = crypto.randomBytes(24).toString('hex');
  const ttlDays = Number(process.env.MONTHLY_REPORT_URL_TTL_DAYS || 90);
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 3600 * 1000);

  await queries.createMonthlyReport({
    merchantId: merchant.id,
    periodKey,
    reportData: snapshot,
    publicToken,
    expiresAt,
  });

  const baseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const reportUrl = `${baseUrl}/api/v1/reports/${publicToken}`;

  logger.info({ merchantId: merchant.id, periodKey }, 'Full monthly report generated');

  return { reportUrl, snapshot };
}

module.exports = { generateFullReport, renderReportHtml, formatNaira };

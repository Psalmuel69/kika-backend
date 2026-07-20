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

// ---------------------------------------------------------------------------
// This HTML/CSS is a direct port of the supplied FullReport.tsx +
// WeeklyRevenueChart.tsx (React/Tailwind) — every hex color, spacing value,
// type size, and icon below matches those components exactly (icon path
// data pulled straight from `lucide-static`, so it's pixel-identical to
// lucide-react's own rendering). The one deliberate structural change: the
// TSX renders this as a modal dialog (dark backdrop, close button, escape-
// to-close) sitting on top of a host page; a monthly report is instead a
// standalone page reached via its own link, so the "card" IS the page and
// the close button is dropped — there's nothing here for it to close.
// Framer-motion's entrance animations aren't meaningful for a page a
// merchant opens directly, so they're intentionally not reproduced either.
// Everything else — every section, color, icon, and pixel value — is as-is.
// ---------------------------------------------------------------------------

// Exact icon path data from lucide-static, matching lucide-react's
// TrendingUp / AlertTriangle / Zap / BookOpen used in FullReport.tsx.
const ICON_PATHS = {
  trendingUp: ['M16 7h6v6', 'm22 7-8.5 8.5-5-5L2 17'],
  alertTriangle: [
    'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3',
    'M12 9v4',
    'M12 17h.01',
  ],
  zap: [
    'M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z',
  ],
  bookOpen: [
    'M12 7v14',
    'M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z',
  ],
};

function lucideIcon(name, { size = 18, color = 'currentColor', strokeWidth = 2.3 } = {}) {
  const paths = ICON_PATHS[name].map((d) => `<path d="${d}" />`).join('');
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

const STAT_ICON_BY_ID = { revenue: 'trendingUp', outstanding: 'alertTriangle', cashflow: 'zap' };

function renderStatCard({ id, icon, label, value, tone, note }) {
  return `
    <div class="stat-card">
      <div class="stat-icon">${lucideIcon(icon, { size: 18, color: tone === 'green' ? 'var(--tone-green)' : 'var(--tone-amber)', strokeWidth: 2.3 })}</div>
      <p class="stat-label">${escapeHtml(label)}</p>
      <div class="stat-value ${tone}">${value}</div>
      <p class="stat-note">${escapeHtml(note)}</p>
    </div>`;
}

function renderDebtorRow(d) {
  const initial = escapeHtml((d.counterparty_name || '?').charAt(0).toUpperCase());
  return `
    <div class="debtor-row">
      <div class="debtor-avatar">${initial}</div>
      <span class="debtor-name">${escapeHtml(d.counterparty_name)}</span>
      <span class="debtor-amount">${formatNaira(d.balance_kobo)}</span>
      <span class="debtor-pct">${d.percentage}%</span>
    </div>
    <div class="debtor-progress-track"><div class="debtor-progress-fill" style="width:${d.percentage}%"></div></div>`;
}

function renderProductRow(p, index) {
  return `
    <div class="product-row">
      <div class="product-rank">${index + 1}</div>
      <span class="product-name">${escapeHtml(capitalize(p.name))}</span>
      <div class="product-main">
        <div class="product-amount">${formatNaira(p.revenue_kobo)}</div>
        <div class="product-units">${Math.round(Number(p.total_quantity))} units</div>
      </div>
    </div>`;
}

function renderWeekBar(w, maxKobo, isBest) {
  const CHART_HEIGHT = 168;
  const heightPx = maxKobo > 0 ? Math.max((w.revenueKobo / maxKobo) * CHART_HEIGHT, 24) : 24;
  const shortLabel = w.revenueKobo >= 1000 ? `\u20a6${Math.round(w.revenueKobo / 1000)}k` : formatNaira(w.revenueKobo);
  return `
    <div class="week-col">
      <span class="week-value">${escapeHtml(shortLabel)}</span>
      <div class="week-track" style="height:${CHART_HEIGHT}px">
        <div class="week-bar ${isBest ? 'best' : ''}" style="height:${heightPx}px"></div>
      </div>
      <span class="week-label">W${w.week}</span>
    </div>`;
}

function renderReportHtml(snapshot) {
  const maxWeekKobo = Math.max(...snapshot.weeklyRevenue.map((w) => w.revenueKobo), 1);
  const weekCols = Math.max(snapshot.weeklyRevenue.length, 1);

  const stats = [
    {
      id: 'revenue',
      label: 'Total Revenue',
      value: formatNaira(snapshot.totalRevenueKobo),
      tone: 'green',
      note: snapshot.growthPct == null ? 'No prior data' : `${snapshot.growthPct >= 0 ? '+' : ''}${snapshot.growthPct.toFixed(0)}% vs last month`,
    },
    {
      id: 'outstanding',
      label: 'Outstanding',
      value: formatNaira(snapshot.totalOutstandingKobo),
      tone: 'amber',
      note: `${snapshot.debtorCount} debtor${snapshot.debtorCount === 1 ? '' : 's'}`,
    },
    {
      id: 'cashflow',
      label: 'Net Cashflow',
      value: formatNaira(snapshot.netCashflowKobo),
      tone: 'green',
      note: snapshot.netCashflowKobo >= 0 ? 'Clean profit' : 'Running at a loss',
    },
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Kika Monthly Report \u2014 ${escapeHtml(snapshot.periodKey)}</title>
<style>
  :root {
    --tone-green: #22c55e; --tone-amber: #eab308; --tone-red: #f05252; --tone-red-dark: #d63c3c;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #0b0b0c; color: #ffffff;
    font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif;
    display: flex; justify-content: center; padding: 24px 12px 48px;
  }
  .card {
    width: 100%; max-width: 720px; background: #131315; border: 1px solid #26262b;
    border-radius: 20px; overflow: hidden;
  }
  /* ===== Header ===== */
  .header { display: flex; align-items: flex-start; gap: 16px; padding: 24px 24px 8px; }
  .header-badge {
    flex-shrink: 0; width: 44px; height: 44px; border-radius: 12px;
    background: linear-gradient(135deg, var(--tone-red), var(--tone-red-dark));
    display: flex; align-items: center; justify-content: center;
  }
  .header h1 { margin: 0; font-size: 18px; font-weight: 700; letter-spacing: -0.2px; }
  .header .subtitle { margin: 2px 0 0; font-size: 12.5px; color: #7d7d85; }

  /* ===== Stat cards ===== */
  .stat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; padding: 16px 24px 0; }
  @media (max-width: 560px) { .stat-grid { grid-template-columns: 1fr; } }
  .stat-card { border-radius: 12px; border: 1px solid #232328; background: #1a1a1d; padding: 16px; }
  .stat-icon { line-height: 0; }
  .stat-label { margin: 14px 0 0; font-size: 12px; font-weight: 500; color: #9a9aa3; }
  .stat-value { margin: 6px 0 0; font-size: 21px; font-weight: 700; letter-spacing: -0.2px; line-height: 1; }
  .stat-value.green { color: var(--tone-green); }
  .stat-value.amber { color: var(--tone-amber); }
  .stat-note { margin: 8px 0 0; font-size: 11.5px; color: #6b6b73; }

  /* ===== Shared section card ===== */
  .section-card { border-radius: 16px; border: 1px solid #232328; background: #1a1a1d; margin: 16px 24px 0; padding: 20px; }
  .section-header { display: flex; align-items: baseline; justify-content: space-between; }
  .section-title { margin: 0; font-size: 15px; font-weight: 600; }
  .section-period { font-size: 12px; color: #6b6b73; }
  .section-total { font-size: 13.5px; font-weight: 600; color: var(--tone-amber); }

  /* ===== Weekly Revenue ===== */
  .week-chart { margin-top: 24px; display: grid; grid-template-columns: repeat(${weekCols}, 1fr); gap: 16px; }
  .week-col { display: flex; flex-direction: column; align-items: center; }
  .week-value { font-size: 12px; font-weight: 500; color: #7d7d85; margin-bottom: 8px; }
  .week-track { width: 100%; display: flex; align-items: flex-end; justify-content: center; }
  .week-bar {
    width: 100%; max-width: 150px; border-radius: 10px 10px 0 0;
    background: linear-gradient(180deg, #0f6b48, #0d5a3e);
  }
  .week-bar.best {
    background: linear-gradient(180deg, #4ade80, #10b981);
    box-shadow: 0 0 28px -4px rgba(52, 211, 153, 0.45);
  }
  .week-label { margin-top: 10px; font-size: 12px; color: #6b6b73; }
  .week-divider { margin-top: 20px; height: 1px; background: #232328; }
  .week-callout { margin-top: 16px; display: flex; align-items: center; gap: 10px; }
  .week-callout-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--tone-green); box-shadow: 0 0 10px rgba(34,197,94,0.8); flex-shrink: 0; }
  .week-callout-text { font-size: 13px; color: #9a9aa3; }

  /* ===== Outstanding Debts ===== */
  .debtor-row { display: flex; align-items: center; gap: 12px; margin-top: 20px; }
  .section-card .debtor-row:first-of-type { margin-top: 20px; }
  .debtor-avatar {
    flex-shrink: 0; width: 36px; height: 36px; border-radius: 50%;
    border: 1px solid rgba(74,61,22,0.6); background: #2c2410; color: var(--tone-amber);
    display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700;
  }
  .debtor-name { font-size: 13.5px; font-weight: 500; color: #e4e4e7; }
  .debtor-amount { margin-left: auto; font-size: 13.5px; font-weight: 700; color: #ffffff; }
  .debtor-pct { width: 32px; text-align: right; font-size: 11.5px; color: #6b6b73; }
  .debtor-progress-track { margin-left: 48px; margin-top: 8px; height: 7px; border-radius: 999px; background: #26262b; overflow: hidden; }
  .debtor-progress-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, #d97706, #facc15); box-shadow: 0 0 12px rgba(234,179,8,0.35); }
  .empty-note { margin-top: 16px; font-size: 13px; color: #6b6b73; }

  /* ===== Top Products ===== */
  .products-card { padding: 0; }
  .products-title { margin: 0; padding: 20px 20px 12px; font-size: 15px; font-weight: 600; }
  .product-row { display: flex; align-items: center; gap: 16px; padding: 18px 20px; border-top: 1px solid #222226; }
  .product-row:first-child { border-top: none; }
  .product-rank {
    flex-shrink: 0; width: 28px; height: 28px; border-radius: 8px;
    border: 1px solid rgba(91,36,38,0.5); background: #331a1c; color: var(--tone-red);
    display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700;
  }
  .product-name { font-size: 13.5px; font-weight: 500; color: #d4d4d8; }
  .product-main { margin-left: auto; text-align: right; }
  .product-amount { font-size: 13.5px; font-weight: 700; color: #ffffff; }
  .product-units { margin-top: 2px; font-size: 11.5px; color: #6b6b73; }

  /* ===== Kika AI Insight ===== */
  .insight-card {
    margin: 16px 24px 24px; padding: 20px; border-radius: 16px;
    border: 1px solid rgba(20,83,45,0.4); background: linear-gradient(135deg, #0b1f16, #091711);
  }
  .insight-header { display: flex; align-items: center; gap: 12px; }
  .insight-icon {
    flex-shrink: 0; width: 36px; height: 36px; border-radius: 50%;
    border: 1px solid rgba(22,101,52,0.6); background: #052e16;
    display: flex; align-items: center; justify-content: center;
  }
  .insight-title { margin: 0; font-size: 14px; font-weight: 600; color: #4ade80; }
  .insight-body { margin: 14px 0 0; font-size: 13.5px; line-height: 1.7; color: #9db4a7; }
</style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="header-badge">${lucideIcon('bookOpen', { size: 20, color: '#ffffff', strokeWidth: 2.2 })}</div>
      <div>
        <h1>${escapeHtml(snapshot.periodKey)} \u2014 Full Report</h1>
        <p class="subtitle">${escapeHtml(snapshot.businessName)} &middot; Powered by Kika AI</p>
      </div>
    </div>

    <div class="stat-grid">
      ${stats.map((s) => renderStatCard({ ...s, icon: STAT_ICON_BY_ID[s.id] })).join('')}
    </div>

    <div class="section-card">
      <div class="section-header">
        <h3 class="section-title">Weekly Revenue</h3>
        <span class="section-period">${escapeHtml(snapshot.periodKey)}</span>
      </div>
      <div class="week-chart">
        ${snapshot.weeklyRevenue.map((w) => renderWeekBar(w, maxWeekKobo, snapshot.bestWeek && w.week === snapshot.bestWeek.week)).join('')}
      </div>
      ${snapshot.bestWeek ? `
      <div class="week-divider"></div>
      <div class="week-callout">
        <span class="week-callout-dot"></span>
        <span class="week-callout-text">Week ${snapshot.bestWeek.week} was your best trading week \u2014 ${formatNaira(snapshot.bestWeek.revenueKobo)} in sales</span>
      </div>` : ''}
    </div>

    <div class="section-card">
      <div class="section-header">
        <h3 class="section-title">Outstanding Debts</h3>
        <span class="section-total">${formatNaira(snapshot.totalOutstandingKobo)} total</span>
      </div>
      ${snapshot.debtors.length > 0 ? snapshot.debtors.map(renderDebtorRow).join('') : '<p class="empty-note">No outstanding debt \u2014 nice work.</p>'}
    </div>

    <div class="section-card products-card">
      <h3 class="products-title">Top Products This Month</h3>
      ${snapshot.topProducts.length > 0 ? snapshot.topProducts.map(renderProductRow).join('') : '<p class="empty-note" style="padding:0 20px 20px;">No itemized sales recorded yet.</p>'}
    </div>

    <div class="insight-card">
      <div class="insight-header">
        <div class="insight-icon">${lucideIcon('zap', { size: 16, color: 'var(--tone-green)', strokeWidth: 2.3 })}</div>
        <h3 class="insight-title">Kika AI Insight</h3>
      </div>
      <p class="insight-body">${escapeHtml(snapshot.aiInsight)}</p>
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

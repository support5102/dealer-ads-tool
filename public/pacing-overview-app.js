/* Budget Pacing Overview — client-side logic */

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

const STATUS_ORDER = { over: 0, under: 1, on_pace: 2 };
const STATUS_LABELS = {
  on_pace: 'On Pace', over: 'Overpacing', under: 'Underpacing',
};
// Status color is now dynamic — see getStatusColor()
const PROJ_LABELS = {
  on_track: 'On Track', over: 'Over', under: 'Under',
  will_over: 'Over', will_under: 'Under',
};
const PROJ_COLORS = {
  on_track: 'green', over: 'yellow', under: 'yellow',
  will_over: 'red', will_under: 'red',
};

function getStatusColor(account) {
  if (account.status === 'on_pace') return 'green';
  const paceRatio = 100 + (account.pacePercent || 0);
  if (paceRatio > 115 || paceRatio < 85) return 'red';
  return 'yellow';
}

let currentData = null;
let sortCol = 'pacePercent';
let sortAsc = false;

// ── Filtering ──

function getFilteredAccounts() {
  if (!currentData) return [];
  let accounts = currentData.accounts;

  // Text search filter
  const searchEl = document.getElementById('filterInput');
  const search = (searchEl ? searchEl.value : '').toLowerCase().trim();
  if (search) {
    accounts = accounts.filter(a => a.dealerName.toLowerCase().includes(search));
  }

  // Status filter
  const statusEl = document.getElementById('statusFilter');
  const statusFilter = statusEl ? statusEl.value : 'all';
  if (statusFilter !== 'all') {
    accounts = accounts.filter(a => a.status === statusFilter);
  }

  return accounts;
}

function applyFilters() {
  if (!currentData) return;
  const filtered = getFilteredAccounts();
  renderTable(filtered);
}

// ── Formatting helpers ──

function fmtCurrency(n) {
  return '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtSignedCurrency(n) {
  const sign = n >= 0 ? '+' : '-';
  return sign + fmtCurrency(n);
}

function fmtPercent(n) {
  const sign = n > 0 ? '+' : '';
  return sign + n.toFixed(1) + '%';
}

// ── Auth check ──

async function checkAuth() {
  try {
    const res = await fetch('/api/auth/status');
    const data = await res.json();
    const el = document.getElementById('authStatus');
    if (data.connected) {
      el.textContent = 'Google Ads Connected';
      el.style.opacity = '1';
      el.style.borderColor = '#166534';
      el.style.color = '#4ade80';
      loadOverview();
    } else {
      el.textContent = 'Not Connected';
      el.style.opacity = '1';
      el.style.cursor = 'pointer';
      el.style.pointerEvents = 'auto';
      el.onclick = () => { window.location.href = '/auth/google'; };
      document.getElementById('content').innerHTML =
        '<div class="empty-msg">Connect Google Ads to view pacing overview.</div>';
    }
  } catch {
    document.getElementById('authStatus').textContent = 'Connection Error';
  }
}

// ── Load data ──

async function loadOverview() {
  const content = document.getElementById('content');
  const loading = document.getElementById('loadingState');
  const summaryBar = document.getElementById('summaryBar');
  const failedSection = document.getElementById('failedSection');

  content.innerHTML = '';
  loading.style.display = 'block';
  summaryBar.style.display = 'none';
  failedSection.innerHTML = '';
  document.getElementById('refreshBtn').disabled = true;

  try {
    // Ensure accounts are loaded into session before fetching pacing
    await fetch('/api/accounts');
    const res = await fetch('/api/pacing/all');
    const data = await res.json();

    if (!res.ok) {
      content.innerHTML = `<div class="error-msg">${esc(data.error || 'Failed to load pacing data.')}</div>`;
      return;
    }

    if (data.accounts.length === 0 && data.failed.length === 0) {
      content.innerHTML = '<div class="empty-msg">No accounts found with monthly budgets set in Google Sheets.</div>';
      return;
    }

    currentData = data;
    renderSummary(data);
    renderTable(data.accounts);
    renderFailed(data.failed);
  } catch (err) {
    content.innerHTML = `<div class="error-msg">Network error: ${esc(err.message)}</div>`;
  } finally {
    loading.style.display = 'none';
    document.getElementById('refreshBtn').disabled = false;
  }
}

// ── Summary bar ──

function renderSummary(data) {
  const bar = document.getElementById('summaryBar');
  const accts = data.accounts;
  const totalSpend = accts.reduce((s, a) => s + a.mtdSpend, 0);
  const totalBudget = accts.reduce((s, a) => s + a.monthlyBudget, 0);
  const offPace = accts.filter(a => a.status !== 'on_pace').length;

  bar.innerHTML = `
    <div class="summary-stat"><strong>${data.loadedAccounts}</strong> accounts loaded</div>
    <div class="summary-stat"><strong>${fmtCurrency(totalSpend)}</strong> total MTD spend</div>
    <div class="summary-stat"><strong>${fmtCurrency(totalBudget)}</strong> total budget</div>
    <div class="summary-stat"><strong class="${offPace > 0 ? 'pace-yellow' : 'pace-green'}">${offPace}</strong> off-pace</div>
  `;
  bar.style.display = 'flex';
}

// ── Table rendering ──

function sortAccounts(accounts) {
  return [...accounts].sort((a, b) => {
    let cmp = 0;
    const PROJ_ORDER = { will_over: 0, over: 1, on_track: 2, under: 3, will_under: 4 };
    if (sortCol === 'status') {
      cmp = (STATUS_ORDER[a.status] ?? 5) - (STATUS_ORDER[b.status] ?? 5);
      if (cmp === 0) cmp = a.dealerName.localeCompare(b.dealerName);
    } else if (sortCol === 'projectedStatus') {
      cmp = (PROJ_ORDER[a.projectedStatus] ?? 5) - (PROJ_ORDER[b.projectedStatus] ?? 5);
      if (cmp === 0) cmp = a.dealerName.localeCompare(b.dealerName);
    } else if (sortCol === 'dealerName') {
      cmp = a.dealerName.localeCompare(b.dealerName);
    } else {
      cmp = (a[sortCol] ?? 0) - (b[sortCol] ?? 0);
    }
    return sortAsc ? cmp : -cmp;
  });
}

function handleSort(col) {
  if (sortCol === col) {
    sortAsc = !sortAsc;
  } else {
    sortCol = col;
    sortAsc = true;
  }
  if (currentData) renderTable(getFilteredAccounts());
}

function renderTable(accounts) {
  const sorted = sortAccounts(accounts);
  const content = document.getElementById('content');

  const cols = [
    { key: 'dealerName', label: 'Dealer Name' },
    { key: 'mtdSpend', label: 'MTD Spend' },
    { key: 'monthlyBudget', label: 'Monthly Budget' },
    { key: 'pacePercent', label: 'Pacing' },
    { key: 'status', label: 'Status' },
    { key: 'dailyAdjustment', label: 'Daily Adj.' },
    { key: 'sevenDayAvg', label: '7-Day Avg' },
    { key: 'sevenDayTrendPercent', label: '7-Day Trend' },
    { key: 'projectedStatus', label: 'Projection' },
  ];

  const headerHtml = cols.map(c => {
    const arrow = sortCol === c.key ? (sortAsc ? ' ↑' : ' ↓') : '';
    return `<th onclick="handleSort('${c.key}')">${c.label}${arrow}</th>`;
  }).join('');

  const rowsHtml = sorted.map(a => {
    const color = getStatusColor(a);
    const paceClass = color === 'green' ? 'pace-green' : color === 'yellow' ? 'pace-yellow' : 'pace-red';
    // On the last day of month, dailyAdjustment is meaningless (required rate = 0)
    // Show remaining budget instead
    const remainingBudget = a.monthlyBudget - a.mtdSpend;
    const isLastDay = new Date().getDate() === new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
    const adjValue = isLastDay ? remainingBudget : a.dailyAdjustment;
    const adjClass = adjValue >= 0 ? 'adj-positive' : 'adj-negative';
    const trendClass = a.sevenDayTrend === 'up' ? 'trend-up' : a.sevenDayTrend === 'down' ? 'trend-down' : 'trend-flat';
    const trendArrow = a.sevenDayTrend === 'up' ? '↑' : a.sevenDayTrend === 'down' ? '↓' : '→';

    return `<tr onclick="window.location.href='/pacing.html?account=${esc(a.customerId)}'">
      <td>${esc(a.dealerName)}</td>
      <td>${fmtCurrency(a.mtdSpend)}</td>
      <td>${fmtCurrency(a.monthlyBudget)}</td>
      <td class="${paceClass}">${(100 + a.pacePercent).toFixed(1)}%</td>
      <td><span class="status-mini ${color}">${STATUS_LABELS[a.status] || a.status}</span>${a.changeDate ? ' <span title="Budget changed ' + esc(a.changeDate) + '" style="font-size:10px;color:var(--text3);">⏳</span>' : ''}</td>
      <td class="${adjClass}">${isLastDay ? fmtSignedCurrency(remainingBudget) + ' left' : fmtSignedCurrency(adjValue) + '/day'}</td>
      <td>${fmtCurrency(a.sevenDayAvg)}/day</td>
      <td class="${trendClass}">${trendArrow} ${fmtPercent(a.sevenDayTrendPercent)}</td>
      <td title="${a.changeDate ? 'Since ' + esc(a.changeDate) + ': ' + fmtCurrency(a.postChangeDailyAvg || 0) + '/day → Proj: ' + fmtCurrency(a.projectedSpend) : 'Full-month avg → Proj: ' + fmtCurrency(a.projectedSpend)}"><span class="status-mini ${PROJ_COLORS[a.projectedStatus] || 'gray'}">${PROJ_LABELS[a.projectedStatus] || 'N/A'}</span></td>
    </tr>`;
  }).join('');

  content.innerHTML = `
    <table class="overview-table">
      <thead><tr>${headerHtml}</tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  `;
}

// ── Failed accounts ──

function renderFailed(failed) {
  const el = document.getElementById('failedSection');
  if (!failed || failed.length === 0) { el.innerHTML = ''; return; }

  const items = failed.map(f => `<li>${esc(f.dealerName)} (${esc(f.customerId)}): ${esc(f.error)}</li>`).join('');
  el.innerHTML = `
    <details class="failed-section">
      <summary>${failed.length} account(s) failed to load</summary>
      <ul>${items}</ul>
    </details>
  `;
}

// ── Init ──
checkAuth();

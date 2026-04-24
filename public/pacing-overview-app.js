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
let selectedGroup = 'all'; // 'all' or a group key like 'alan_jay'

// ── Filtering ──

function getAvailableGroups(accounts) {
  const byKey = new Map();
  for (const a of accounts) {
    if (a.groupKey && !byKey.has(a.groupKey)) {
      byKey.set(a.groupKey, a.groupLabel || a.groupKey);
    }
  }
  return [['all', 'All Dealers'], ...Array.from(byKey.entries())];
}

function renderGroupFilter(accounts) {
  const groups = getAvailableGroups(accounts);
  const options = groups.map(([key, label]) => {
    const selected = key === selectedGroup ? ' selected' : '';
    const count = key === 'all' ? accounts.length : accounts.filter(a => a.groupKey === key).length;
    return `<option value="${key}"${selected}>${label} (${count})</option>`;
  }).join('');
  return `<select id="group-filter" onchange="handleGroupChange(this.value)" style="padding:6px 12px;background:var(--bg3);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;outline:none;">${options}</select>`;
}

function handleGroupChange(value) {
  selectedGroup = value;
  if (currentData) renderTable(getFilteredAccounts());
}

function getFilteredAccounts() {
  if (!currentData) return [];
  let accounts = currentData.accounts;

  // Group filter
  if (selectedGroup !== 'all') {
    accounts = accounts.filter(a => a.groupKey === selectedGroup);
  }

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
    const groupFilterEl = document.getElementById('group-filter-container');
    if (groupFilterEl) groupFilterEl.innerHTML = renderGroupFilter(data.accounts);
    renderTable(getFilteredAccounts());
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

function renderPacingSinceLastChange(a) {
  if (a.pacingSinceLastChange == null) return '<span style="color:var(--text3);">—</span>';
  const pct = a.pacingSinceLastChange;
  const cls = pct >= 95 && pct <= 105 ? 'pace-green'
            : pct > 105 ? 'pace-red'
            : 'pace-yellow';
  return `<span class="${cls}">${pct.toFixed(1)}%</span>`;
}

function renderDaysSinceLastChange(a) {
  if (a.daysSinceLastChange == null) return '<span style="color:var(--text3);">Never</span>';
  return `${a.daysSinceLastChange}d`;
}

function buildPacingExplanation(a) {
  const parts = [];
  parts.push(`Current pacing: ${(100 + a.pacePercent).toFixed(1)}%`);
  if (a.changeDate) {
    parts.push(`Last budget change: ${a.changeDate} (${a.daysSinceLastChange ?? '?'} days ago)`);
    if (a.pacingSinceLastChange != null) {
      parts.push(`Since change: pacing at ${a.pacingSinceLastChange.toFixed(1)}%`);
    }
  } else {
    parts.push(`No budget changes recorded this month`);
  }
  if (a.pacingCurveId && a.pacingCurveId !== 'linear') {
    parts.push(`Curve: ${a.pacingCurveId}`);
  }
  return parts.join(' · ');
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
    { key: 'pacingSinceLastChange', label: 'Pacing Since Last Change' },
    { key: 'daysSinceLastChange', label: 'Days Since Change' },
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

    return `<tr onclick="window.location.href='/pacing.html?account=${esc(a.customerId)}'">
      <td>${esc(a.dealerName)}</td>
      <td>${fmtCurrency(a.mtdSpend)}</td>
      <td>${fmtCurrency(a.monthlyBudget)} <button class="budget-edit-btn" onclick="event.stopPropagation(); openBudgetModal('${esc(a.dealerName).replace(/'/g, "\\'")}', ${a.monthlyBudget})" title="Edit monthly budget">&#9998;</button></td>
      <td class="${paceClass}" title="${esc(buildPacingExplanation(a))}">${(100 + a.pacePercent).toFixed(1)}%</td>
      <td><span class="status-mini ${color}">${STATUS_LABELS[a.status] || a.status}</span>${a.changeDate ? ' <span title="Budget changed ' + esc(a.changeDate) + '" style="font-size:10px;color:var(--text3);">⏳</span>' : ''}</td>
      <td class="${adjClass}">${isLastDay ? fmtSignedCurrency(remainingBudget) + ' left' : fmtSignedCurrency(adjValue) + '/day'}</td>
      <td>${renderPacingSinceLastChange(a)}</td>
      <td>${renderDaysSinceLastChange(a)}</td>
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

// ── Budget Edit Modal ──

let modalState = { dealerName: null, currentBudget: 0 };

function openBudgetModal(dealerName, currentBudget) {
  modalState = { dealerName, currentBudget };
  document.getElementById('modalDealer').textContent = dealerName;
  document.getElementById('modalCurrentBudget').textContent = '$' + Number(currentBudget).toFixed(2);
  document.getElementById('modalNewBudget').value = currentBudget;
  document.getElementById('modalNote').value = '';
  document.getElementById('modalFeedback').textContent = '';
  document.getElementById('modalFeedback').className = 'modal-feedback';
  document.getElementById('budgetEditModal').style.display = 'flex';
  validateModalForm();
  // Wire change listeners (first time only)
  if (!openBudgetModal._wired) {
    document.getElementById('modalNewBudget').addEventListener('input', validateModalForm);
    document.getElementById('modalNote').addEventListener('input', validateModalForm);
    // Esc closes modal
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') closeBudgetModal();
    });
    // Enter submits if save button is enabled
    document.getElementById('modalNote').addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && e.ctrlKey) {
        const btn = document.getElementById('modalSaveBtn');
        if (!btn.disabled) saveBudget();
      }
    });
    // Overlay click closes modal
    document.getElementById('budgetEditModal').addEventListener('click', function(e) {
      if (e.target === this) closeBudgetModal();
    });
    openBudgetModal._wired = true;
  }
  // Focus the new-budget input
  setTimeout(() => document.getElementById('modalNewBudget').focus(), 50);
}

function closeBudgetModal() {
  document.getElementById('budgetEditModal').style.display = 'none';
}

function validateModalForm() {
  const budgetInput = document.getElementById('modalNewBudget');
  const noteInput = document.getElementById('modalNote');
  const saveBtn = document.getElementById('modalSaveBtn');
  const budget = parseFloat(budgetInput.value);
  const noteOk = noteInput.value.trim().length >= 5;
  const budgetOk = Number.isFinite(budget) && budget > 0;
  // Also require change from current (don't save a no-op)
  const changed = Math.abs(budget - modalState.currentBudget) > 0.005;
  saveBtn.disabled = !(noteOk && budgetOk && changed);
}

async function saveBudget() {
  const saveBtn = document.getElementById('modalSaveBtn');
  const feedback = document.getElementById('modalFeedback');
  saveBtn.disabled = true;
  feedback.textContent = '';
  try {
    const res = await fetch(`/api/dealers/${encodeURIComponent(modalState.dealerName)}/budget`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        monthlyBudget: parseFloat(document.getElementById('modalNewBudget').value),
        note: document.getElementById('modalNote').value.trim(),
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      feedback.textContent = data.error || `Save failed (HTTP ${res.status})`;
      feedback.className = 'modal-feedback err';
      saveBtn.disabled = false;
      return;
    }
    feedback.textContent = 'Saved.';
    feedback.className = 'modal-feedback ok';
    // Reload the overview so the new budget shows immediately
    setTimeout(() => {
      closeBudgetModal();
      if (typeof loadOverview === 'function') loadOverview();
      else window.location.reload();
    }, 600);
  } catch (err) {
    feedback.textContent = err.message || 'Network error';
    feedback.className = 'modal-feedback err';
    saveBtn.disabled = false;
  }
}

// Expose for inline onclick handlers
window.openBudgetModal = openBudgetModal;
window.closeBudgetModal = closeBudgetModal;
window.saveBudget = saveBudget;

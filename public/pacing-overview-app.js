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

    const dealerAttr = esc(a.dealerName).replace(/'/g, "\\'");
    return `<tr class="dealer-row" onclick="window.location.href='/pacing.html?account=${esc(a.customerId)}'">
      <td class="expand-col"><button class="expand-btn" title="Show monthly spend history" onclick="event.stopPropagation(); toggleSpendHistory('${dealerAttr}', this)">▸</button></td>
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
      <thead><tr><th class="expand-col"></th>${headerHtml}</tr></thead>
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
loadFeatureFlags();

// ── Feature flags ──

let featureFlags = { budgetAdjustByAmountEnabled: false };

async function loadFeatureFlags() {
  try {
    const res = await fetch('/api/config/features', { credentials: 'include' });
    if (!res.ok) return;
    featureFlags = await res.json();
    if (featureFlags.budgetAdjustByAmountEnabled) {
      const adjustTabBtn = document.querySelector('.modal-tab[data-tab="adjust"]');
      if (adjustTabBtn) adjustTabBtn.style.display = '';
    }
  } catch (_) { /* defensive: leave tab hidden */ }
}

// ── Budget Edit Modal ──

let modalState = {
  dealerName: null,
  currentBudget: 0,
  activeTab: 'set-total',          // 'set-total' | 'adjust'
  pendingRevert: null,              // populated by openBudgetModal from /pending-revert
};

function openBudgetModal(dealerName, currentBudget) {
  modalState = { dealerName, currentBudget, activeTab: 'set-total', pendingRevert: null };

  document.getElementById('modalDealer').textContent = dealerName;
  document.getElementById('modalCurrentBudget').textContent = '$' + Number(currentBudget).toFixed(2);
  document.getElementById('modalNewBudget').value = currentBudget;
  document.getElementById('modalNote').value = '';
  document.getElementById('modalAdjustAmount').value = '';
  document.getElementById('modalAdjustNote').value = '';
  document.querySelectorAll('input[name="adjustScope"]').forEach(r => { r.checked = false; });
  document.querySelectorAll('input[name="adjustDaySubScope"]').forEach(r => { r.checked = false; });
  document.querySelectorAll('input[name="adjustMonthSubScope"]').forEach(r => { r.checked = false; });
  setSubGroupEnabled(null);

  document.getElementById('modalFeedback').textContent = '';
  document.getElementById('modalFeedback').className = 'modal-feedback';
  setActiveTab('set-total');
  document.getElementById('budgetEditModal').style.display = 'flex';

  validateModalForm();
  fetchPendingRevert(dealerName);

  if (!openBudgetModal._wired) {
    wireModal();
    openBudgetModal._wired = true;
  }
  setTimeout(() => document.getElementById('modalNewBudget').focus(), 50);
}

function closeBudgetModal() {
  document.getElementById('budgetEditModal').style.display = 'none';
}

function setActiveTab(tab) {
  modalState.activeTab = tab;
  document.querySelectorAll('.modal-tab').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === tab);
  });
  document.querySelectorAll('.modal-tab-panel').forEach(el => {
    el.classList.toggle('active', el.dataset.tabPanel === tab);
  });
  validateModalForm();
}

function setSubGroupEnabled(activeScope) {
  // activeScope: 'day' | 'month' | null. Enables only the matching sub-group.
  const dayActive   = activeScope === 'day';
  const monthActive = activeScope === 'month';
  document.getElementById('adjustDaySubGroup').classList.toggle('disabled', !dayActive);
  document.querySelectorAll('input[name="adjustDaySubScope"]').forEach(r => { r.disabled = !dayActive; });
  document.getElementById('adjustMonthSubGroup').classList.toggle('disabled', !monthActive);
  document.querySelectorAll('input[name="adjustMonthSubScope"]').forEach(r => { r.disabled = !monthActive; });
}

function wireModal() {
  document.querySelectorAll('.modal-tab').forEach(el => {
    el.addEventListener('click', () => setActiveTab(el.dataset.tab));
  });
  document.getElementById('modalNewBudget').addEventListener('input', validateModalForm);
  document.getElementById('modalNote').addEventListener('input', validateModalForm);
  document.getElementById('modalAdjustAmount').addEventListener('input', () => {
    validateModalForm();
    renderPreview();
  });
  document.getElementById('modalAdjustNote').addEventListener('input', validateModalForm);
  document.querySelectorAll('input[name="adjustScope"]').forEach(r => {
    r.addEventListener('change', () => {
      setSubGroupEnabled(r.checked ? r.value : null);
      validateModalForm();
      renderPreview();
    });
  });
  document.querySelectorAll('input[name="adjustDaySubScope"], input[name="adjustMonthSubScope"]').forEach(r => {
    r.addEventListener('change', () => {
      validateModalForm();
      renderPreview();
    });
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') closeBudgetModal();
  });
  document.querySelectorAll('#modalNote, #modalAdjustNote').forEach(el => {
    el.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && e.ctrlKey) {
        const btn = document.getElementById('modalSaveBtn');
        if (!btn.disabled) saveBudget();
      }
    });
  });
  document.getElementById('budgetEditModal').addEventListener('click', function(e) {
    if (e.target === this) closeBudgetModal();
  });
}

function getSelectedScope() {
  const r = document.querySelector('input[name="adjustScope"]:checked');
  return r ? r.value : null;
}
function getSelectedDaySubScope() {
  const r = document.querySelector('input[name="adjustDaySubScope"]:checked');
  return r ? r.value : null;
}
function getSelectedMonthSubScope() {
  const r = document.querySelector('input[name="adjustMonthSubScope"]:checked');
  return r ? r.value : null;
}

function validateModalForm() {
  const saveBtn = document.getElementById('modalSaveBtn');
  if (modalState.activeTab === 'set-total') {
    const budget = parseFloat(document.getElementById('modalNewBudget').value);
    const note = document.getElementById('modalNote').value.trim();
    const noteOk = note.length >= 5;
    const budgetOk = Number.isFinite(budget) && budget > 0;
    const changed = Math.abs(budget - modalState.currentBudget) > 0.005;
    saveBtn.disabled = !(noteOk && budgetOk && changed);
  } else {
    const amount = parseFloat(document.getElementById('modalAdjustAmount').value);
    const note = document.getElementById('modalAdjustNote').value.trim();
    const scope = getSelectedScope();
    const daySub = getSelectedDaySubScope();
    const monthSub = getSelectedMonthSubScope();
    const noteOk = note.length >= 5;
    const amountOk = Number.isFinite(amount) && amount !== 0;
    const scopeOk =
      (scope === 'day'   && ['forward', 'whole_month', 'rest_of_month'].includes(daySub)) ||
      (scope === 'month' && ['permanent', 'rest_of_month'].includes(monthSub));
    saveBtn.disabled = !(noteOk && amountOk && scopeOk);
  }
}

function renderPreview() {
  const amount = parseFloat(document.getElementById('modalAdjustAmount').value);
  const scope = getSelectedScope();
  const daySub = getSelectedDaySubScope();
  const monthSub = getSelectedMonthSubScope();
  const current = modalState.currentBudget;
  const elCurrent = document.getElementById('previewCurrent');
  const elAfter   = document.getElementById('previewAfter');
  const elReverts = document.getElementById('previewReverts');
  elCurrent.textContent = '$' + Number(current).toFixed(2);

  if (!Number.isFinite(amount) || amount === 0 || !scope) {
    elAfter.textContent = '—';
    elReverts.textContent = '—';
    return;
  }
  const today = new Date();
  const D = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const R = D - today.getDate() + 1;
  const oldDaily = current / D;
  const firstNext = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const nextMonthLabel = firstNext.toLocaleString('en-US', { month: 'short' }) + ' 1';

  let after;
  let revertText = 'No (permanent)';
  if (scope === 'day') {
    if (daySub === 'forward') {
      after = current + amount * R;
    } else if (daySub === 'whole_month') {
      after = (oldDaily + amount) * D;
    } else if (daySub === 'rest_of_month') {
      after = current + amount * R;
      revertText = `Yes — reverts on ${nextMonthLabel}`;
    } else {
      elAfter.textContent = '—';
      elReverts.textContent = '—';
      return;
    }
  } else if (scope === 'month') {
    if (monthSub === 'permanent') {
      after = current + amount;
    } else if (monthSub === 'rest_of_month') {
      after = current + amount;
      revertText = `Yes — reverts on ${nextMonthLabel}`;
    } else {
      elAfter.textContent = '—';
      elReverts.textContent = '—';
      return;
    }
  }
  elAfter.textContent = '$' + Number(after).toFixed(2);
  elReverts.textContent = revertText;
}

async function fetchPendingRevert(dealerName) {
  const banner = document.getElementById('modalPendingRevertBanner');
  const text = document.getElementById('modalPendingRevertText');
  banner.style.display = 'none';
  try {
    const res = await fetch(`/api/dealers/${encodeURIComponent(dealerName)}/pending-revert`, {
      credentials: 'include',
    });
    if (!res.ok) return;
    const data = await res.json();
    const pr = data.pendingRevert;
    if (!pr) return;
    modalState.pendingRevert = pr;
    const dueDate = new Date(pr.revertDueDate);
    const monthName = dueDate.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    const day = dueDate.getUTCDate();
    const sign = pr.bumpAmount >= 0 ? '+' : '−';
    const absAmt = Math.abs(pr.bumpAmount).toFixed(2);
    text.textContent = `This dealer has a pending revert: ${sign}$${absAmt} rest-of-month queued for ${monthName} ${day}. Saving any change on this modal will cancel it.`;
    banner.style.display = 'flex';
  } catch (_) { /* non-fatal */ }
}

async function saveBudget() {
  const saveBtn = document.getElementById('modalSaveBtn');
  const feedback = document.getElementById('modalFeedback');
  saveBtn.disabled = true;
  feedback.textContent = '';
  try {
    let res;
    if (modalState.activeTab === 'set-total') {
      res = await fetch(`/api/dealers/${encodeURIComponent(modalState.dealerName)}/budget`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          monthlyBudget: parseFloat(document.getElementById('modalNewBudget').value),
          note: document.getElementById('modalNote').value.trim(),
        }),
      });
    } else {
      const uiScope = getSelectedScope();
      const uiDaySub = getSelectedDaySubScope();
      const uiMonthSub = getSelectedMonthSubScope();
      // Translate UI to backend payload:
      //   Day  + (forward|whole_month|rest_of_month) → scope='day',           daySubScope=<sub>
      //   Month + permanent                           → scope='month'
      //   Month + rest_of_month                       → scope='rest_of_month' (existing legacy enum)
      let payloadScope = uiScope;
      let payloadDaySub = null;
      if (uiScope === 'day') {
        payloadDaySub = uiDaySub;
      } else if (uiScope === 'month') {
        payloadScope = uiMonthSub === 'rest_of_month' ? 'rest_of_month' : 'month';
      }
      res = await fetch(`/api/dealers/${encodeURIComponent(modalState.dealerName)}/budget-adjust`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: parseFloat(document.getElementById('modalAdjustAmount').value),
          scope: payloadScope,
          daySubScope: payloadDaySub,
          note: document.getElementById('modalAdjustNote').value.trim(),
        }),
      });
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      feedback.textContent = data.error || `Save failed (HTTP ${res.status})`;
      feedback.className = 'modal-feedback err';
      saveBtn.disabled = false;
      return;
    }
    feedback.textContent = 'Saved.';
    feedback.className = 'modal-feedback ok';
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

// ── Monthly spend history (row expand) ──

const spendHistoryCache = new Map(); // dealerName → array | 'loading'

function formatMonthLabel(period) {
  // period is 'YYYY-MM-01'
  const [y, m] = period.split('-');
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${names[Number(m) - 1]} ${y}`;
}

function formatUpdated(updatedAt) {
  if (!updatedAt) return '';
  const d = new Date(updatedAt);
  if (isNaN(d)) return '';
  return `updated ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

function renderSpendHistoryRows(history) {
  if (history === 'loading') return '<div class="sh-empty">Loading…</div>';
  if (!history || history.length === 0) {
    return '<div class="sh-empty">No months recorded yet — history starts this month.</div>';
  }
  return '<div class="sh-list">' + history.map(h => {
    const pct = (h.monthlyBudget && h.monthlyBudget > 0)
      ? ` · ${Math.round((h.totalSpend / h.monthlyBudget) * 100)}%`
      : '';
    const budget = (h.monthlyBudget != null) ? ` / ${fmtCurrency(h.monthlyBudget)}` : '';
    return `<div class="sh-entry">
      <span class="sh-month">${esc(formatMonthLabel(h.period))}</span>
      <span class="sh-sep">·</span>
      <span class="sh-spend">${fmtCurrency(h.totalSpend)} spent${budget}${pct}</span>
      <span class="sh-updated">${esc(formatUpdated(h.updatedAt))}</span>
    </div>`;
  }).join('') + '</div>';
}

async function toggleSpendHistory(dealerName, btn) {
  const dealerRow = btn.closest('tr');
  const existing = dealerRow.nextElementSibling;
  // Collapse if already open
  if (existing && existing.classList.contains('sh-detail-row')) {
    existing.remove();
    btn.textContent = '▸';
    btn.classList.remove('open');
    return;
  }

  btn.textContent = '▾';
  btn.classList.add('open');

  const detail = document.createElement('tr');
  detail.className = 'sh-detail-row';
  const colspan = dealerRow.children.length;
  const cached = spendHistoryCache.get(dealerName);
  detail.innerHTML = `<td colspan="${colspan}"><div class="sh-panel">${renderSpendHistoryRows(cached || 'loading')}</div></td>`;
  dealerRow.after(detail);

  if (cached && cached !== 'loading') return; // already have data

  spendHistoryCache.set(dealerName, 'loading');
  try {
    const res = await fetch(`/api/dealers/${encodeURIComponent(dealerName)}/spend-history`, { credentials: 'include' });
    const data = res.ok ? await res.json() : { history: [] };
    spendHistoryCache.set(dealerName, data.history || []);
  } catch (err) {
    spendHistoryCache.set(dealerName, []);
  }
  // Re-render if the panel is still open
  const panel = detail.querySelector('.sh-panel');
  if (panel) panel.innerHTML = renderSpendHistoryRows(spendHistoryCache.get(dealerName));
}

// Expose for inline onclick handlers
window.openBudgetModal = openBudgetModal;
window.closeBudgetModal = closeBudgetModal;
window.saveBudget = saveBudget;
window.toggleSpendHistory = toggleSpendHistory;

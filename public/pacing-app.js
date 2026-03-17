/**
 * Pacing Dashboard App — fetches pacing data and renders budget recommendations.
 *
 * Loaded by: public/pacing.html
 * Calls: /api/auth/status, /api/accounts, /api/pacing?customerId=X
 *
 * Vanilla JavaScript — no framework, no build step.
 */

// ─────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────
let state = {
  connected:  false,
  accounts:   [],
  selectedId: null,
  loading:    false,
  data:       null,
  _requestId: 0,
};

// ─────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(window.location.search);
  if (params.get('connected')) {
    window.history.replaceState({}, '', '/pacing.html');
    showToast('Google Ads connected!');
  }
  if (params.get('error')) {
    showToast('Connection failed: ' + params.get('error'), 'error');
    window.history.replaceState({}, '', '/pacing.html');
  }
  await checkAuthStatus();
});

// ─────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────
async function checkAuthStatus() {
  try {
    const res  = await fetch('/api/auth/status');
    const data = await res.json();
    if (data.connected) {
      state.connected = true;
      showConnectedState();
      await loadAccounts();
    }
  } catch (e) {
    console.error('Auth check failed:', e);
  }
}

function connectGoogle() {
  window.location.href = '/auth/google';
}

function showConnectedState() {
  const hr = document.getElementById('headerRight');
  hr.innerHTML = `
    <a href="/" class="nav-link">Task Manager</a>
    <div class="connected-badge">
      <div class="pulse-dot"></div>
      Google Ads Connected
    </div>
    <button class="logout-btn" onclick="window.location.href='/auth/logout'">Disconnect</button>
  `;
  document.getElementById('notConnected').style.display = 'none';
  document.getElementById('selectPrompt').style.display = 'block';
}

// ─────────────────────────────────────────────────────────────
// LOAD ACCOUNTS
// ─────────────────────────────────────────────────────────────
async function loadAccounts() {
  const sel = document.getElementById('accountSelect');
  sel.disabled = true;
  sel.innerHTML = '<option>Loading accounts...</option>';

  try {
    const res  = await fetch('/api/accounts');
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    state.accounts = (data.accounts || []).filter(a => !a.isManager);
    sel.innerHTML = '<option value="">-- Select a dealer account --</option>';

    state.accounts.forEach(acc => {
      const opt = document.createElement('option');
      opt.value = acc.id;
      opt.text  = acc.name + (acc.currency ? ` (${acc.currency})` : '');
      sel.appendChild(opt);
    });

    sel.disabled = false;

    if (state.accounts.length === 0) {
      sel.innerHTML = '<option>No dealer accounts found</option>';
    }
  } catch (err) {
    sel.innerHTML = '<option>Error loading accounts</option>';
    showToast(err.message, 'error');
  }
}

// ─────────────────────────────────────────────────────────────
// LOAD PACING
// ─────────────────────────────────────────────────────────────
async function loadPacing(customerId) {
  if (!customerId) {
    state.selectedId = null;
    state.data = null;
    showView('selectPrompt');
    document.getElementById('refreshBtn').disabled = true;
    return;
  }

  state.selectedId = customerId;
  state.loading = true;
  const requestId = ++state._requestId;
  document.getElementById('refreshBtn').disabled = false;
  showView('loadingState');

  // Find account name from loaded accounts list
  const account = state.accounts.find(a => a.id === customerId);
  const accountName = account ? account.name : '';

  try {
    const res = await fetch(`/api/pacing?customerId=${encodeURIComponent(customerId)}&accountName=${encodeURIComponent(accountName)}`);
    if (state._requestId !== requestId) return; // stale response
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    state.data = data;
    renderDashboard(data);
    showView('dashboard');
  } catch (err) {
    if (state._requestId !== requestId) return; // stale error
    document.getElementById('errorTitle').textContent = 'Pacing Error';
    document.getElementById('errorMessage').textContent = err.message;
    showView('errorState');
  } finally {
    state.loading = false;
  }
}

function refreshCurrent() {
  if (state.selectedId) loadPacing(state.selectedId);
}

// ─────────────────────────────────────────────────────────────
// VIEW MANAGEMENT
// ─────────────────────────────────────────────────────────────
function showView(id) {
  ['notConnected', 'selectPrompt', 'loadingState', 'errorState', 'dashboard']
    .forEach(v => {
      const el = document.getElementById(v);
      if (el) el.style.display = v === id ? '' : 'none';
    });
}

// ─────────────────────────────────────────────────────────────
// RENDER DASHBOARD
// ─────────────────────────────────────────────────────────────
function renderDashboard(data) {
  renderHeader(data);
  renderMetrics(data);
  renderRecommendations(data.recommendations);
  renderImpressionShare(data.impressionShareSummary);
  renderInventory(data.inventory);
}

function renderHeader(data) {
  const color = data.statusColor || 'gray';
  const statusLabel = formatStatus(data.status);
  document.getElementById('dashHeader').innerHTML = `
    <div>
      <div class="dash-dealer">${esc(data.dealerName)}</div>
      <div class="dash-id">Customer ID: ${esc(data.customerId)}</div>
    </div>
    <div class="status-badge ${color}">
      <div class="status-dot-lg ${color}"></div>
      ${statusLabel}
    </div>
  `;
}

function renderMetrics(data) {
  const p = data.pacing || {};
  const pctNum = p.pacingPercent != null ? p.pacingPercent : 0;
  const pct = p.pacingPercent != null ? p.pacingPercent.toFixed(1) : '--';
  const color = data.statusColor || 'gray';

  document.getElementById('metricsRow').innerHTML = `
    <div class="metric-card">
      <div class="metric-label">Monthly Budget</div>
      <div class="metric-value">$${fmt(p.monthlyBudget)}</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Spend to Date</div>
      <div class="metric-value">$${fmt(data.totalSpend)}</div>
      <div class="metric-sub">$${fmt(p.remainingBudget)} remaining</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Pacing</div>
      <div class="metric-value">${pct}%</div>
      <div class="pace-bar-container">
        <div class="pace-bar ${color}" style="width:${Math.min(pctNum, 100)}%"></div>
      </div>
      <div class="metric-sub">Day ${p.currentDay} of ${p.daysInMonth}</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Required Daily Rate</div>
      <div class="metric-value">$${fmt(p.requiredDailyRate)}</div>
      <div class="metric-sub">${p.daysRemaining} days remaining</div>
    </div>
  `;
}

function renderRecommendations(recs) {
  const section = document.getElementById('recommendationsSection');
  if (!recs || recs.length === 0) {
    section.innerHTML = `
      <div class="dash-section">
        <div class="dash-section-header">
          <div class="dash-section-title">Budget Recommendations</div>
        </div>
        <div class="no-recs">On pace — no budget changes recommended.</div>
      </div>
    `;
    return;
  }

  let rows = '';
  recs.forEach(r => {
    const dir = r.change >= 0 ? 'increase' : 'decrease';
    const sign = r.change >= 0 ? '+' : '';
    rows += `
      <div class="rec-item">
        <div>
          <div class="rec-target">${esc(r.target)}</div>
          <div class="rec-budget-row">
            <span class="rec-current">$${r.currentDailyBudget.toFixed(2)}/day</span>
            <span class="rec-arrow">&rarr;</span>
            <span class="rec-recommended ${dir}">$${r.recommendedDailyBudget.toFixed(2)}/day</span>
            <span class="rec-change ${dir}">${sign}$${r.change.toFixed(2)}</span>
          </div>
          <div class="rec-reason">${esc(r.reason)}</div>
        </div>
      </div>
    `;
  });

  section.innerHTML = `
    <div class="dash-section">
      <div class="dash-section-header">
        <div class="dash-section-title">Budget Recommendations</div>
        <div class="dash-section-count">${recs.length} shared budget${recs.length !== 1 ? 's' : ''}</div>
      </div>
      ${rows}
    </div>
  `;
}

function renderImpressionShare(is) {
  const section = document.getElementById('impressionSection');
  if (!is || is.avgImpressionShare == null) {
    section.innerHTML = '';
    return;
  }

  const avgIS = (is.avgImpressionShare * 100).toFixed(1);
  const avgBLS = is.avgBudgetLostShare != null ? (is.avgBudgetLostShare * 100).toFixed(1) : '--';
  const limited = is.limitedCampaigns || [];

  let isColor = '#4ade80';
  if (is.avgImpressionShare < 0.5) isColor = '#f87171';
  else if (is.avgImpressionShare < 0.75) isColor = '#fbbf24';

  let bColor = '#4ade80';
  if (is.avgBudgetLostShare > 0.15) bColor = '#f87171';
  else if (is.avgBudgetLostShare > 0.05) bColor = '#fbbf24';

  section.innerHTML = `
    <div class="dash-section">
      <div class="dash-section-header">
        <div class="dash-section-title">Impression Share</div>
      </div>
      <div class="is-row">
        <span class="is-label">Avg Impression Share</span>
        <div class="is-bar-container">
          <div class="is-bar" style="width:${avgIS}%;background:${isColor}"></div>
        </div>
        <span class="is-value">${avgIS}%</span>
      </div>
      <div class="is-row">
        <span class="is-label">Avg Budget Lost Share</span>
        <div class="is-bar-container">
          <div class="is-bar" style="width:${avgBLS !== '--' ? avgBLS : 0}%;background:${bColor}"></div>
        </div>
        <span class="is-value">${avgBLS}%</span>
      </div>
      ${limited.length > 0 ? `
        <div class="is-row" style="flex-direction:column;align-items:flex-start;gap:4px">
          <span class="is-label">Budget-Limited Campaigns (&gt;10% lost)</span>
          ${limited.map(c => `<span style="color:#fb923c;font-size:12px;padding-left:8px">&bull; ${esc(c)}</span>`).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function renderInventory(inv) {
  const section = document.getElementById('inventorySection');
  if (!inv) {
    section.innerHTML = '';
    return;
  }

  let modColor = 'var(--text3)';
  if (inv.modifier > 1) modColor = '#4ade80';
  else if (inv.modifier < 1) modColor = '#fb923c';

  section.innerHTML = `
    <div class="dash-section">
      <div class="dash-section-header">
        <div class="dash-section-title">Inventory</div>
      </div>
      <div class="is-row">
        <span class="is-label">New Vehicles on Lot</span>
        <span class="is-value">${inv.count != null ? inv.count : '--'}</span>
      </div>
      ${inv.modifier != null ? `
        <div class="is-row">
          <span class="is-label">Inventory Modifier</span>
          <span class="is-value" style="color:${modColor}">${inv.modifier.toFixed(2)}x</span>
        </div>
      ` : ''}
      ${inv.reason ? `
        <div class="is-row">
          <span class="is-label">Impact</span>
          <span style="color:var(--text2);font-size:12px">${esc(inv.reason)}</span>
        </div>
      ` : ''}
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────
function formatStatus(status) {
  switch (status) {
    case 'on_pace':        return 'On Pace';
    case 'over':           return 'Over-Pacing';
    case 'under':          return 'Under-Pacing';
    case 'critical_over':  return 'Critical Over';
    case 'critical_under': return 'Critical Under';
    default:               return status || 'Unknown';
  }
}

function fmt(n) {
  if (n == null) return '--';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function esc(str) {
  if (!str) return '';
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}

let toastTimer;
function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent       = msg;
  t.style.display     = 'block';
  t.style.background  = type === 'error' ? '#3d0d0d'  : '#071a0e';
  t.style.borderColor = type === 'error' ? '#991b1b'  : '#166534';
  t.style.color       = type === 'error' ? '#f87171'  : '#4ade80';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.display = 'none'; }, 4000);
}

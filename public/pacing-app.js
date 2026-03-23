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
  renderRecommendations(data.recommendations, data.budgetSummary, data.pausableCampaigns);
  renderImpressionShare(data.impressionShareSummary, data.changeDate);
  renderCampaignIS(data.campaignIS, data.changeDate);
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
  // pacePercent is a variance (e.g. +49 means 49% above expected).
  // Convert to pace ratio for display: 100 + variance = 149% of expected pace.
  const paceRatio = p.pacePercent != null ? (100 + p.pacePercent) : null;
  const pct = paceRatio != null ? paceRatio.toFixed(1) : '--';
  // Progress bar shows budget utilization (spend / budget)
  const spendProgress = p.monthlyBudget > 0 ? (data.totalSpend / p.monthlyBudget) * 100 : 0;
  const color = data.statusColor || 'gray';

  // Post-change average card (only shown when a budget change happened this month)
  let postChangeCard = '';
  if (data.postChangeAvg && data.postChangeAvg.daysTracked > 0) {
    const pca = data.postChangeAvg;
    const changeLabel = pca.changeDate.replace(/^(\d{4})-(\d{2})-(\d{2})$/, (_, y, m, d) => `${m}/${d}`);
    postChangeCard = `
    <div class="metric-card">
      <div class="metric-label">Post-Change Daily Avg</div>
      <div class="metric-value">$${fmt(pca.dailyAvg)}</div>
      <div class="metric-sub">Since ${changeLabel} (${pca.daysTracked} day${pca.daysTracked !== 1 ? 's' : ''})</div>
    </div>`;
  }

  // Warning when post-change data couldn't be loaded
  let postChangeWarning = '';
  if (data.postChangeWarning) {
    postChangeWarning = `
    <div class="metric-card" style="border-color:#92400e">
      <div class="metric-label" style="color:#fbbf24">⚠ Data Note</div>
      <div class="metric-sub" style="color:#fbbf24">${esc(data.postChangeWarning)}</div>
    </div>`;
  }

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
        <div class="pace-bar ${color}" style="width:${Math.min(spendProgress, 100)}%"></div>
      </div>
      <div class="metric-sub">Day ${p.daysElapsed} of ${p.daysInMonth}</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Required Daily Rate</div>
      <div class="metric-value">$${fmt(p.requiredDailyRate)}</div>
      <div class="metric-sub">${p.daysRemaining} days remaining</div>
    </div>
    ${postChangeCard}
    ${postChangeWarning}
  `;
}

function renderRecommendations(recs, budgetSummary, pausableCampaigns) {
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

  // Budget allocation summary bar
  let summaryHtml = '';
  if (budgetSummary) {
    const { requiredDailyRate, currentDailyTotal, totalChange } = budgetSummary;
    const gap = requiredDailyRate - currentDailyTotal;
    const gapSign = gap >= 0 ? '+' : '';
    const gapColor = Math.abs(gap) < 1 ? '#4ade80' : (gap > 0 ? '#4ade80' : '#f87171');
    const gapLabel = gap > 0 ? 'Under by' : (gap < 0 ? 'Over by' : 'On target');
    const gapAmount = Math.abs(gap);
    summaryHtml = `
      <div class="budget-summary">
        <div class="budget-summary-item">
          <span class="budget-summary-label">Target Daily Rate</span>
          <span class="budget-summary-value">$${requiredDailyRate.toFixed(2)}/day</span>
        </div>
        <div class="budget-summary-item">
          <span class="budget-summary-label">Current Daily Spend</span>
          <span class="budget-summary-value">$${currentDailyTotal.toFixed(2)}/day</span>
        </div>
        <div class="budget-summary-item">
          <span class="budget-summary-label">Change Needed</span>
          <span class="budget-summary-value" style="color:${gapColor}">${gapLabel} $${gapAmount.toFixed(2)}/day</span>
        </div>
      </div>
    `;
  }

  let rows = '';
  recs.forEach(r => {
    const dir = r.change >= 0 ? 'increase' : 'decrease';
    const sign = r.change >= 0 ? '+' : '';
    const vlaBadge = r.isVla ? '<span class="vla-badge">VLA</span>' : '';
    // Tier badge for shared budgets
    let tierBadge = '';
    if (!r.isVla && r.tier === 3) tierBadge = '<span class="tier-badge brand">Brand</span>';
    else if (!r.isVla && r.tier === 1) tierBadge = '<span class="tier-badge low">General/Regional</span>';
    // Budget setting — what the budget is actually set to in Google Ads
    const setLabel = r.budgetSetting != null
      ? `<span class="rec-setting">Set: $${r.budgetSetting.toFixed(2)}/day</span>` : '';
    rows += `
      <div class="rec-item">
        <div>
          <div class="rec-target">${vlaBadge}${tierBadge}${esc(r.target)}</div>
          <div class="rec-budget-row">
            ${setLabel}
            <span class="rec-current">Avg spend: $${r.currentDailyBudget.toFixed(2)}/day</span>
            <span class="rec-arrow">&rarr;</span>
            <span class="rec-recommended ${dir}">$${r.recommendedDailyBudget.toFixed(2)}/day</span>
            <span class="rec-change ${dir}">${sign}$${r.change.toFixed(2)}</span>
          </div>
          <div class="rec-reason"${r.isCapped ? ' style="color:#fbbf24"' : ''}>${r.isCapped ? '⚠ ' : ''}${esc(r.reason)}</div>
        </div>
      </div>
    `;
  });

  // Pausable campaigns suggestion
  let pausableHtml = '';
  if (pausableCampaigns && pausableCampaigns.length > 0) {
    const totalSavings = pausableCampaigns.reduce((s, c) => s + c.dailySpend, 0);
    pausableHtml = `
      <div class="pausable-section">
        <div class="pausable-title">Consider pausing (low priority — saves ~$${totalSavings.toFixed(2)}/day):</div>
        ${pausableCampaigns.map(c => `<span class="pausable-item">&bull; ${esc(c.campaignName)}${c.dailySpend > 0 ? ` ($${c.dailySpend.toFixed(2)}/day)` : ''}</span>`).join('')}
      </div>
    `;
  }

  const vlaCount = recs.filter(r => r.isVla).length;
  const sharedCount = recs.length - vlaCount;
  const countParts = [];
  if (vlaCount > 0) countParts.push(`${vlaCount} VLA`);
  if (sharedCount > 0) countParts.push(`${sharedCount} shared`);

  section.innerHTML = `
    <div class="dash-section">
      <div class="dash-section-header">
        <div class="dash-section-title">Budget Recommendations</div>
        <div class="dash-section-count">${countParts.join(' + ')} budget${recs.length !== 1 ? 's' : ''}</div>
      </div>
      ${summaryHtml}
      ${rows}
      ${pausableHtml}
    </div>
  `;
}

function renderImpressionShare(is, changeDate) {
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
        <div class="dash-section-title">Impression Share${changeDate ? ` <span style="font-size:12px;color:#94a3b8;font-weight:400">(since ${changeDate.replace(/^(\d{4})-(\d{2})-(\d{2})$/, (_, y, m, d) => m + '/' + d)})</span>` : ''}</div>
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

function renderCampaignIS(campaigns, changeDate) {
  const section = document.getElementById('campaignISSection');
  if (!campaigns || campaigns.length === 0) {
    section.innerHTML = '';
    return;
  }

  let rows = '';
  campaigns.forEach(c => {
    const is = c.impressionShare;
    let isColor = '#4ade80';
    if (is < 50) isColor = '#f87171';
    else if (is < 75) isColor = '#fbbf24';

    const blsText = c.budgetLostShare != null && c.budgetLostShare > 0
      ? `<span style="color:#fb923c;font-size:11px;margin-left:8px">${c.budgetLostShare}% lost to budget</span>`
      : '';

    rows += `
      <div class="is-row" style="gap:8px">
        <span class="is-label" style="flex:2;font-size:12px">${esc(c.campaignName)}</span>
        <div class="is-bar-container" style="flex:1">
          <div class="is-bar" style="width:${is}%;background:${isColor}"></div>
        </div>
        <span class="is-value" style="color:${isColor}">${is}%</span>
        ${blsText}
      </div>
    `;
  });

  section.innerHTML = `
    <div class="dash-section">
      <div class="dash-section-header">
        <div class="dash-section-title">Search Impression Share by Campaign${changeDate ? ` <span style="font-size:12px;color:#94a3b8;font-weight:400">(since ${changeDate.replace(/^(\d{4})-(\d{2})-(\d{2})$/, (_, y, m, d) => m + '/' + d)})</span>` : ''}</div>
        <div class="dash-section-count">${campaigns.length} campaign${campaigns.length !== 1 ? 's' : ''}</div>
      </div>
      ${rows}
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
        <span class="is-value">${inv.count != null ? esc(String(inv.count)) : '--'}</span>
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
    default:               return esc(status) || 'Unknown';
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

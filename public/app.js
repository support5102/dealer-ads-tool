/**
 * Frontend App — handles UI state, API calls, and DOM rendering.
 *
 * Loaded by: public/index.html
 * Calls: /auth/*, /api/auth/*, /api/accounts, /api/account/:id/structure,
 *        /api/parse-task, /api/apply-changes
 *
 * Vanilla JavaScript — no framework, no build step.
 */

// ─────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────
let state = {
  connected:        false,
  accounts:         [],
  selectedId:       null,
  selectedName:     null,
  structure:        null,
  plan:             null,
  loadingAccounts:  false,
  loadingStructure: false,
  loadingTask:      false,
  applyingChanges:  false,
};

// ─────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(window.location.search);
  if (params.get('connected')) {
    window.history.replaceState({}, '', '/');
    showToast('Google Ads connected!');
  }
  if (params.get('error')) {
    showToast('Connection failed: ' + params.get('error'), 'error');
    window.history.replaceState({}, '', '/');
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

function logout() {
  window.location.href = '/auth/logout';
}

function showConnectedState() {
  const hr = document.getElementById('headerRight');
  hr.innerHTML = `
    <a href="/pacing.html" class="nav-link">Pacing Dashboard</a>
    <div class="connected-badge">
      <div class="pulse-dot"></div>
      Google Ads Connected
    </div>
    <button class="logout-btn" onclick="logout()">Disconnect</button>
  `;
  document.getElementById('notConnected').style.display = 'none';
  document.getElementById('taskArea').style.display     = 'block';
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

    state.accounts = data.accounts || [];
    sel.innerHTML  = '<option value="">— Select a dealer account —</option>';

    state.accounts.forEach(acc => {
      const opt  = document.createElement('option');
      opt.value  = acc.id;
      opt.text   = (acc.isManager ? '🏢 ' : '📍 ') + acc.name;
      if (acc.currency) opt.text += ` (${acc.currency})`;
      sel.appendChild(opt);
    });

    sel.disabled = false;

    if (state.accounts.length === 0) {
      sel.innerHTML = '<option>No accounts found</option>';
    }
  } catch (err) {
    sel.innerHTML = '<option>Error loading accounts</option>';
    showToast(err.message, 'error');
  }
}

// ─────────────────────────────────────────────────────────────
// SELECT ACCOUNT → load structure + build tree
// ─────────────────────────────────────────────────────────────
async function selectAccount(id) {
  if (!id) {
    state.selectedId   = null;
    state.selectedName = null;
    state.structure    = null;
    state.plan         = null;
    document.getElementById('accountTree').innerHTML   = '<div class="tree-empty">Select an account to see campaigns.</div>';
    document.getElementById('analyseBtn').disabled     = true;
    document.getElementById('accountLabel').textContent = '';
    document.getElementById('planArea').innerHTML       = '';
    return;
  }

  const acc = state.accounts.find(a => a.id === id);
  state.selectedId   = id;
  state.selectedName = acc?.name || id;
  state.plan         = null;
  document.getElementById('planArea').innerHTML       = '';
  document.getElementById('accountLabel').textContent = '→ ' + state.selectedName;
  document.getElementById('analyseBtn').disabled      = true;

  const tree = document.getElementById('accountTree');
  tree.innerHTML = '<div class="tree-empty" style="color:#334155">Loading account structure...</div>';

  try {
    const res  = await fetch(`/api/account/${id}/structure`);
    const data = await res.json();

    if (data.error) throw new Error(data.error);

    state.structure = data;
    renderTree(data.campaigns);
    document.getElementById('analyseBtn').disabled = false;
    showToast(`Loaded ${data.stats.campaigns} campaigns, ${data.stats.adGroups} ad groups, ${data.stats.keywords} keywords`);
  } catch (err) {
    tree.innerHTML = `<div class="tree-empty" style="color:#f87171">Error: ${err.message}</div>`;
    showToast(err.message, 'error');
  }
}

// ─────────────────────────────────────────────────────────────
// RENDER ACCOUNT TREE
// ─────────────────────────────────────────────────────────────
function renderTree(campaigns) {
  const tree = document.getElementById('accountTree');
  if (!campaigns || campaigns.length === 0) {
    tree.innerHTML = '<div class="tree-empty">No campaigns found.</div>';
    return;
  }

  tree.innerHTML = '';
  campaigns.forEach(camp => {
    const campDiv = document.createElement('div');
    campDiv.className = 'tree-campaign';

    const statusClass = camp.status.toLowerCase();
    campDiv.innerHTML = `
      <div class="tree-camp-header" onclick="toggleCampaign(this)" data-camp="${camp.name}">
        <span class="tree-arrow">▶</span>
        <div class="status-dot ${statusClass}"></div>
        <span class="tree-camp-name">${camp.name}</span>
        <span class="tree-budget">$${camp.budget}</span>
      </div>
      <div class="tree-ag-list" style="display:none">
        ${camp.adGroups.map(ag => `
          <div class="tree-ag">
            <div class="tree-ag-header" onclick="toggleAG(this)" data-ag="${ag.name}">
              <span class="tree-arrow">▶</span>
              <div class="status-dot ${ag.status.toLowerCase()}"></div>
              <span class="tree-ag-name">📁 ${ag.name}</span>
              <span class="tree-kw-count">🔑${ag.keywords.length}</span>
            </div>
            <div class="tree-keywords" style="display:none">
              ${ag.keywords.slice(0, 30).map(kw => {
                const match = kw.match.toLowerCase().replace('_', '');
                const matchShort = match === 'exact' ? 'Exact' : match === 'phrase' ? 'Phrase' : 'Broad';
                return `<div class="tree-kw">
                  <span class="match-badge ${match}">${matchShort}</span>
                  ${kw.negative ? '<span style="color:#f87171;font-size:9px">NEG</span>' : ''}
                  <span class="kw-text">${kw.text}</span>
                  ${kw.bid ? `<span style="font-size:10px;color:#475569">$${kw.bid}</span>` : ''}
                </div>`;
              }).join('')}
              ${ag.keywords.length > 30 ? `<div class="tree-kw" style="color:#334155;font-size:10px">...and ${ag.keywords.length - 30} more</div>` : ''}
            </div>
          </div>
        `).join('')}
        ${camp.adGroups.length === 0 ? '<div style="padding:8px 32px;font-size:11px;color:#334155">(no ad groups)</div>' : ''}
      </div>
    `;
    tree.appendChild(campDiv);
  });
}

function toggleCampaign(el) {
  const list  = el.nextElementSibling;
  const arrow = el.querySelector('.tree-arrow');
  const open  = list.style.display !== 'none';
  list.style.display = open ? 'none' : 'block';
  arrow.textContent  = open ? '▶' : '▼';
  el.classList.toggle('open', !open);
}

function toggleAG(el) {
  const list  = el.nextElementSibling;
  const arrow = el.querySelector('.tree-arrow');
  const open  = list.style.display !== 'none';
  list.style.display = open ? 'none' : 'block';
  arrow.textContent  = open ? '▶' : '▼';
}

// ─────────────────────────────────────────────────────────────
// ANALYSE TASK → call Claude via our backend
// ─────────────────────────────────────────────────────────────
async function analyseTask() {
  const task = document.getElementById('taskInput').value.trim();
  if (!task) return;
  if (!state.selectedId) { showToast('Select an account first', 'error'); return; }

  document.getElementById('analyseBtn').disabled  = true;
  document.getElementById('analyseBtn').innerHTML  = '<span class="spinner"></span> Analysing...';
  document.getElementById('planArea').innerHTML     = '';

  try {
    const res  = await fetch('/api/parse-task', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task,
        customerId:       state.selectedId,
        accountName:      state.selectedName,
        accountStructure: state.structure,
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    state.plan = data;
    renderPlan(data);
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    document.getElementById('analyseBtn').disabled = false;
    document.getElementById('analyseBtn').innerHTML = '🔍 Analyse Task';
  }
}

document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') analyseTask();
});

// ─────────────────────────────────────────────────────────────
// RENDER PLAN
// ─────────────────────────────────────────────────────────────
const TYPE_META = {
  pause_campaign:       { label: 'Pause Campaign',   color: '#fb923c', bg: '#3d2a0d', border: '#92400e' },
  enable_campaign:      { label: 'Enable Campaign',  color: '#4ade80', bg: '#0d3d1f', border: '#166534' },
  update_budget:        { label: 'Budget Change',    color: '#60a5fa', bg: '#1a2e50', border: '#1d4ed8' },
  pause_ad_group:       { label: 'Pause Ad Group',   color: '#fb923c', bg: '#3d2a0d', border: '#92400e' },
  enable_ad_group:      { label: 'Enable Ad Group',  color: '#4ade80', bg: '#0d3d1f', border: '#166534' },
  pause_keyword:        { label: 'Pause Keyword',    color: '#fb923c', bg: '#3d2a0d', border: '#92400e' },
  enable_keyword:       { label: 'Enable Keyword',   color: '#4ade80', bg: '#0d3d1f', border: '#166534' },
  add_keyword:          { label: 'Add Keyword',      color: '#34d399', bg: '#0d3d2a', border: '#065f46' },
  add_negative_keyword: { label: 'Negative Keyword', color: '#f87171', bg: '#3d0d0d', border: '#991b1b' },
  exclude_radius:       { label: 'Exclude Radius',   color: '#f472b6', bg: '#3d0d2a', border: '#9d174d' },
  add_radius:           { label: 'Add Radius',       color: '#f472b6', bg: '#3d0d2a', border: '#9d174d' },
  update_bid:           { label: 'Update Bid',       color: '#fbbf24', bg: '#3d2a0d', border: '#92400e' },
};

function renderPlan(plan) {
  const area    = document.getElementById('planArea');
  const changes  = plan.changes || [];
  const warnings = plan.warnings || [];

  let html = `
    <div class="plan-card">
      <div class="plan-header">
        <div class="plan-summary">${plan.summary || 'Task parsed'}</div>
        <div class="plan-count">${changes.length} change${changes.length !== 1 ? 's' : ''} · ${state.selectedName}</div>
      </div>
      <div class="change-list">
  `;

  changes.forEach(c => {
    const meta = TYPE_META[c.type] || { label: c.type, color: '#94a3b8', bg: '#1a2035', border: '#334155' };
    let desc = '';
    if (c.type === 'update_budget') desc = `New budget: $${c.details?.newBudget}/day`;
    else if (c.type.includes('keyword')) desc = `[${c.details?.matchType || '?'}] "${c.details?.keyword}"`;
    else if (c.type.includes('radius')) desc = `${c.details?.radius}mi radius around (${c.details?.lat}, ${c.details?.lng})`;
    else desc = c.adGroupName ? `${c.campaignName} > ${c.adGroupName}` : (c.campaignName || '');

    html += `
      <div class="change-item">
        <span class="change-type-badge" style="background:${meta.bg};color:${meta.color};border:1px solid ${meta.border}">${meta.label}</span>
        <div>
          <div class="change-desc">${desc || '—'}</div>
          <div class="change-campaign">${c.campaignName || ''}${c.adGroupName ? ' > ' + c.adGroupName : ''}</div>
        </div>
      </div>
    `;
  });

  html += `</div></div>`;

  if (warnings.length) {
    html += `<div class="warnings-box">
      <div class="warnings-title">Review Before Applying</div>
      ${warnings.map(w => `<div class="warning-item">• ${w}</div>`).join('')}
    </div>`;
  }

  html += `
    <div class="apply-row">
      <button class="btn-dryrun" onclick="applyChanges(true)">🔍 Dry Run (preview only)</button>
      <button class="btn-apply" onclick="confirmApply()">Apply Changes to Google Ads</button>
      <button class="btn-secondary" onclick="exportChangesCSV()">📥 Export as CSV</button>
      <button class="btn-secondary" onclick="clearPlan()">Cancel</button>
    </div>
  `;

  area.innerHTML = html;
}

// ─────────────────────────────────────────────────────────────
// APPLY CHANGES
// ─────────────────────────────────────────────────────────────
function confirmApply() {
  const count = state.plan?.changes?.length || 0;
  if (confirm(`Apply ${count} change${count !== 1 ? 's' : ''} to ${state.selectedName} in Google Ads?\n\nThis will make live changes to your account.`)) {
    applyChanges(false);
  }
}

async function applyChanges(dryRun) {
  if (!state.plan) return;

  const btns = document.querySelectorAll('.btn-apply, .btn-dryrun');
  btns.forEach(b => b.disabled = true);

  const label = dryRun ? 'Running preview...' : 'Applying changes...';
  document.querySelector('.btn-dryrun').innerHTML = dryRun ? `<span class="spinner"></span> ${label}` : '🔍 Dry Run';
  document.querySelector('.btn-apply').innerHTML  = !dryRun ? `<span class="spinner"></span> ${label}` : 'Apply Changes';

  try {
    const res  = await fetch('/api/apply-changes', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        changes:    state.plan.changes,
        customerId: state.selectedId,
        dryRun,
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    renderResults(data, dryRun);
    if (!dryRun) {
      showToast(`${data.applied} change${data.applied !== 1 ? 's' : ''} applied to Google Ads`);
      setTimeout(() => selectAccount(state.selectedId), 2000);
    }
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btns.forEach(b => b.disabled = false);
    document.querySelector('.btn-dryrun').innerHTML = '🔍 Dry Run (preview only)';
    document.querySelector('.btn-apply').innerHTML  = 'Apply Changes to Google Ads';
  }
}

function renderResults(data, dryRun) {
  const area  = document.getElementById('planArea');
  const extra = `
    <div class="results-card">
      <div class="results-header">
        ${dryRun ? '🔍 Dry Run Results — no changes were made' : `Applied — ${data.applied} change${data.applied !== 1 ? 's' : ''} live in Google Ads`}
        ${data.failed ? ` · ${data.failed} error${data.failed !== 1 ? 's' : ''}` : ''}
      </div>
      ${data.results.map(r => `
        <div class="result-item">
          <span class="result-icon">${r.success ? '✓' : '✗'}</span>
          <span class="result-text" style="color:${r.success ? '#94a3b8' : '#f87171'}">${r.result}</span>
        </div>
      `).join('')}
    </div>
  `;
  area.innerHTML = area.innerHTML + extra;
}

// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────
function clearTask() {
  document.getElementById('taskInput').value = '';
  clearPlan();
}

function clearPlan() {
  state.plan = null;
  document.getElementById('planArea').innerHTML = '';
}

// ─────────────────────────────────────────────────────────────
// EXPORT CHANGES AS CSV
// ─────────────────────────────────────────────────────────────
async function exportChangesCSV() {
  if (!state.plan || !state.plan.changes || !state.plan.changes.length) {
    showToast('No changes to export', 'error');
    return;
  }

  try {
    const res = await fetch('/api/export-changes-csv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        changes: state.plan.changes,
        accountName: state.selectedName || 'changes',
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Export failed' }));
      showToast(err.error || 'Export failed', 'error');
      return;
    }

    const data = await res.json();

    // Trigger browser download from the CSV string
    const blob = new Blob([data.csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = data.filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); document.body.removeChild(a); }, 1000);

    // Show result
    let msg = `Exported ${data.rowCount} change${data.rowCount !== 1 ? 's' : ''} to CSV`;
    if (data.skipped && data.skipped.length) {
      msg += ` (${data.skipped.length} skipped — API only)`;
    }
    showToast(msg);
  } catch (err) {
    showToast('Export error: ' + err.message, 'error');
  }
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

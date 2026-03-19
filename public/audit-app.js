/**
 * Audit Dashboard — frontend logic for account health auditor.
 *
 * Talks to:
 *   POST /api/audit/run?customerId=X  → runs audit
 *   GET  /api/audit/results?customerId=X → retrieves cached result
 *   GET  /auth/status → checks auth state
 *   GET  /api/accounts → loads MCC accounts
 */

/* global document, window, fetch */

// ── State ──
let accounts = [];
let selectedAccountId = null;
let selectedAccountName = null;

// ── DOM refs ──
const accountSelect = document.getElementById('accountSelect');
const runAuditBtn = document.getElementById('runAuditBtn');
const notConnected = document.getElementById('notConnected');
const auditLoading = document.getElementById('auditLoading');
const auditResults = document.getElementById('auditResults');
const auditClean = document.getElementById('auditClean');
const summaryRow = document.getElementById('summaryRow');
const findingsSection = document.getElementById('findingsSection');

// ── Auth / account loading (same pattern as pacing) ──

function connectGoogle() {
  window.location.href = '/auth/connect';
}

async function checkAuth() {
  try {
    const res = await fetch('/auth/status');
    const data = await res.json();
    if (data.connected) {
      notConnected.style.display = 'none';
      await loadAccounts();
    }
  } catch (_) { /* not connected */ }
}

async function loadAccounts() {
  try {
    const res = await fetch('/api/accounts');
    if (!res.ok) return;
    const data = await res.json();
    accounts = data.accounts || [];

    accountSelect.innerHTML = '<option value="">-- Select account --</option>';
    for (const a of accounts) {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = `${a.name || a.id} (${a.id})`;
      opt.dataset.name = a.name || '';
      accountSelect.appendChild(opt);
    }
    accountSelect.disabled = false;
  } catch (_) { /* failed to load */ }
}

function selectAccount(id) {
  selectedAccountId = id || null;
  const opt = accountSelect.selectedOptions[0];
  selectedAccountName = opt ? opt.dataset.name : null;
  runAuditBtn.disabled = !id;

  // Hide previous results
  auditResults.style.display = 'none';
  auditClean.style.display = 'none';
}

// ── Run audit ──

async function runAudit() {
  if (!selectedAccountId) return;

  auditLoading.style.display = 'flex';
  auditResults.style.display = 'none';
  auditClean.style.display = 'none';
  runAuditBtn.disabled = true;

  try {
    const res = await fetch(`/api/audit/run?customerId=${encodeURIComponent(selectedAccountId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!res.ok) {
      let errMsg = `HTTP ${res.status}`;
      try { const err = await res.json(); errMsg = err.error || errMsg; } catch (_) { /* non-JSON response */ }
      throw new Error(errMsg);
    }

    const result = await res.json();
    renderResults(result);
  } catch (err) {
    auditLoading.style.display = 'none';
    alert('Audit failed: ' + err.message);
  } finally {
    runAuditBtn.disabled = false;
  }
}

// ── Render results ──

function renderResults(result) {
  auditLoading.style.display = 'none';

  if (result.summary.total === 0) {
    auditClean.style.display = 'flex';
    auditResults.style.display = 'none';
    return;
  }

  auditResults.style.display = 'block';
  auditClean.style.display = 'none';

  // Summary cards
  summaryRow.innerHTML = `
    <div class="summary-card summary-total">
      <div class="summary-number">${result.summary.total}</div>
      <div class="summary-label">Total Findings</div>
    </div>
    <div class="summary-card summary-critical">
      <div class="summary-number">${result.summary.critical}</div>
      <div class="summary-label">Critical</div>
    </div>
    <div class="summary-card summary-warning">
      <div class="summary-number">${result.summary.warning}</div>
      <div class="summary-label">Warnings</div>
    </div>
    <div class="summary-card summary-info">
      <div class="summary-number">${result.summary.info}</div>
      <div class="summary-label">Info</div>
    </div>
  `;

  // Group findings by severity
  const groups = {
    critical: result.findings.filter(f => f.severity === 'critical'),
    warning: result.findings.filter(f => f.severity === 'warning'),
    info: result.findings.filter(f => f.severity === 'info'),
  };

  let html = '';

  for (const [severity, findings] of Object.entries(groups)) {
    if (findings.length === 0) continue;

    const icon = severity === 'critical' ? '&#x1F6D1;' : severity === 'warning' ? '&#x26A0;' : '&#x2139;';
    const label = severity.charAt(0).toUpperCase() + severity.slice(1);

    html += `<div class="findings-group">`;
    html += `<h3 class="findings-group-title severity-${severity}">${icon} ${label} (${findings.length})</h3>`;

    for (const f of findings) {
      html += `
        <div class="finding-card severity-${f.severity}">
          <div class="finding-header">
            <span class="finding-category">${escapeHtml(f.category)}</span>
            <span class="finding-title">${escapeHtml(f.title)}</span>
          </div>
          <div class="finding-message">${escapeHtml(f.message)}</div>
          ${renderDetails(f.details)}
        </div>
      `;
    }

    html += `</div>`;
  }

  html += `<div class="audit-meta">Audit ran at ${new Date(result.ranAt).toLocaleString()} &middot; ${result.checksRun.length} checks</div>`;

  findingsSection.innerHTML = html;
}

function renderDetails(details) {
  if (!details || Object.keys(details).length === 0) return '';

  // Render sample keywords/campaigns/ads as a compact list
  const items = details.sample || details.keywords || details.ads || details.campaigns || details.violations || [];
  if (items.length === 0) return '';

  let html = '<div class="finding-details"><table class="details-table">';

  // Auto-detect columns from first item
  const keys = Object.keys(items[0]).filter(k => typeof items[0][k] !== 'object');
  html += '<tr>' + keys.map(k => `<th>${escapeHtml(k)}</th>`).join('') + '</tr>';

  for (const item of items.slice(0, 5)) {
    html += '<tr>' + keys.map(k => `<td>${escapeHtml(String(item[k] ?? ''))}</td>`).join('') + '</tr>';
  }

  html += '</table>';
  if (items.length > 5) html += `<div class="details-more">...and ${items.length - 5} more</div>`;
  html += '</div>';

  return html;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ── Init ──
checkAuth();

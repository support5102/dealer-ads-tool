/**
 * Audit Dashboard — frontend logic for account health auditor.
 *
 * Talks to:
 *   POST /api/audit/run?customerId=X         → runs audit on one account
 *   GET  /api/audit/results?customerId=X     → retrieves cached result
 *   POST /api/audit/schedule/start           → starts scheduled MCC-wide audits
 *   POST /api/audit/schedule/stop            → stops scheduled audits
 *   GET  /api/audit/schedule/status          → scheduler status
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
  window.location.href = '/auth/google';
}

async function checkAuth() {
  try {
    const res = await fetch('/api/auth/status');
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
      <div class="summary-number">${escapeHtml(result.summary.total)}</div>
      <div class="summary-label">Total Findings</div>
    </div>
    <div class="summary-card summary-critical">
      <div class="summary-number">${escapeHtml(result.summary.critical)}</div>
      <div class="summary-label">Critical</div>
    </div>
    <div class="summary-card summary-warning">
      <div class="summary-number">${escapeHtml(result.summary.warning)}</div>
      <div class="summary-label">Warnings</div>
    </div>
    <div class="summary-card summary-info">
      <div class="summary-number">${escapeHtml(result.summary.info)}</div>
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
          ${renderDetails(f.details, f.checkId)}
        </div>
      `;
    }

    html += `</div>`;
  }

  html += `<div class="audit-actions" style="margin: 20px 0;">
    <button class="btn-primary" id="diagnoseBtn" onclick="diagnoseFindings()">Diagnose & Suggest Fixes</button>
  </div>`;

  html += `<div id="diagnosisResults"></div>`;

  html += `<div class="audit-meta">Audit ran at ${new Date(result.ranAt).toLocaleString()} &middot; ${result.checksRun.length} checks</div>`;

  findingsSection.innerHTML = html;
}

function renderDetails(details, checkId) {
  if (!details || Object.keys(details).length === 0) return '';

  // Type-specific rendering for ad copy findings
  switch (checkId) {
    case 'ad_copy_short_headlines':
    case 'ad_copy_allcaps_headlines': {
      const items = details.headlines || [];
      if (items.length === 0) return '';
      let h = '<div class="finding-details"><table class="details-table">';
      h += '<tr><th>Campaign</th><th>Ad Group</th><th>Headline</th></tr>';
      for (const item of items) {
        h += `<tr><td>${escapeHtml(item.campaignName)}</td><td>${escapeHtml(item.adGroupName)}</td><td><code style="color:var(--orange)">${escapeHtml(item.headline)}</code></td></tr>`;
      }
      return h + '</table></div>';
    }
    case 'ad_copy_stale_years': {
      const items = details.staleAds || [];
      if (items.length === 0) return '';
      let h = '<div class="finding-details"><table class="details-table">';
      h += '<tr><th>Campaign</th><th>Ad Group</th><th>Stale Years</th><th>Sample Text</th></tr>';
      for (const item of items) {
        h += `<tr><td>${escapeHtml(item.campaignName)}</td><td>${escapeHtml(item.adGroupName)}</td><td>${escapeHtml(item.staleYears.join(', '))}</td><td><code style="color:var(--orange)">${escapeHtml(item.text)}</code></td></tr>`;
      }
      return h + '</table></div>';
    }
    case 'ad_copy_pinning_overuse': {
      const items = details.ads || [];
      if (items.length === 0) return '';
      let h = '<div class="finding-details">';
      for (const item of items) {
        h += `<div style="margin-bottom:8px;font-size:12px;"><strong>${escapeHtml(item.campaignName)}</strong> &rarr; ${escapeHtml(item.adGroupName)} (${item.pinnedCount} pinned)<ul style="margin:4px 0 0 16px;">`;
        for (const ph of item.pinnedHeadlines) {
          h += `<li><code style="color:var(--orange)">${escapeHtml(ph.text)}</code> &mdash; ${escapeHtml(ph.position)}</li>`;
        }
        h += '</ul></div>';
      }
      return h + '</div>';
    }
    case 'ad_copy_wrong_dealer_name': {
      const items = details.ads || [];
      if (items.length === 0) return '';
      let h = '<div class="finding-details"><table class="details-table">';
      h += '<tr><th>Campaign</th><th>Ad Group</th><th>Expected Dealer Name</th></tr>';
      for (const item of items) {
        h += `<tr><td>${escapeHtml(item.campaignName)}</td><td>${escapeHtml(item.adGroupName)}</td><td>${escapeHtml(item.dealerPortion)}</td></tr>`;
      }
      return h + '</table></div>';
    }
    case 'MISSING_COMPETING_NEGS': {
      const camp = details.campaignName || '';
      const makes = details.missingMakes || [];
      if (!camp) return '';
      let h = '<div class="finding-details" style="font-size:12px;">';
      h += `<strong>${escapeHtml(camp)}</strong> (${escapeHtml(details.dealerMake || '')}) — missing ${makes.length} negatives:<ul style="margin:4px 0 0 16px;">`;
      for (const m of makes) h += `<li><code>${escapeHtml(m)}</code></li>`;
      return h + '</ul></div>';
    }
    case 'broad_match_keywords': {
      const byCampaign = details.byCampaign || {};
      const entries = Object.entries(byCampaign);
      if (entries.length === 0) return '';
      let h = '<div class="finding-details">';
      for (const [campaign, keywords] of entries) {
        h += `<div style="margin-bottom:8px;font-size:12px;"><strong>${escapeHtml(campaign)}</strong><ul style="margin:4px 0 0 16px;">`;
        for (const kw of keywords.slice(0, 10)) h += `<li><code>${escapeHtml(kw)}</code></li>`;
        if (keywords.length > 10) h += `<li>...and ${keywords.length - 10} more</li>`;
        h += '</ul></div>';
      }
      return h + '</div>';
    }
    default: break;
  }

  // Generic fallback
  const items = details.sample || details.keywords || details.ads || details.campaigns || details.violations || [];
  if (items.length === 0) return '';

  let html = '<div class="finding-details"><table class="details-table">';
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

// ── Scheduler controls ──

const schedulerControls = document.getElementById('schedulerControls');
const scheduleBtn = document.getElementById('scheduleBtn');
const scheduleStatusEl = document.getElementById('scheduleStatus');
let scheduleActive = false;
let statusPollTimer = null;

async function loadScheduleStatus() {
  try {
    const res = await fetch('/api/audit/schedule/status');
    if (!res.ok) return;
    const status = await res.json();
    scheduleActive = status.active;
    updateScheduleUI(status);
  } catch (_) { /* ignore */ }
}

function updateScheduleUI(status) {
  if (!schedulerControls) return;
  schedulerControls.style.display = 'flex';

  if (status.active) {
    scheduleBtn.textContent = 'Stop Schedule';
    scheduleBtn.classList.add('btn-stop');
    const parts = [];
    if (status.runCount > 0) parts.push(`${status.runCount} runs`);
    if (status.lastRunAccounts > 0) parts.push(`${status.lastRunAccounts} accounts`);
    if (status.lastRunFindings > 0) parts.push(`${status.lastRunFindings} findings`);
    if (status.running) parts.unshift('Running now...');
    scheduleStatusEl.textContent = parts.length > 0 ? parts.join(' · ') : 'Scheduled';
  } else {
    scheduleBtn.textContent = 'Schedule All';
    scheduleBtn.classList.remove('btn-stop');
    scheduleStatusEl.textContent = '';
  }
}

async function toggleSchedule() {
  scheduleBtn.disabled = true;

  try {
    if (scheduleActive) {
      const res = await fetch('/api/audit/schedule/stop', { method: 'POST' });
      const data = await res.json();
      if (data.stopped) {
        scheduleActive = false;
        stopStatusPolling();
      }
    } else {
      const res = await fetch('/api/audit/schedule/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runImmediately: true }),
      });
      if (!res.ok) {
        let errMsg = 'Failed to start';
        try { const err = await res.json(); errMsg = err.error || errMsg; } catch (_) {}
        throw new Error(errMsg);
      }
      const data = await res.json();
      if (data.started) {
        scheduleActive = true;
        startStatusPolling();
      }
    }
    await loadScheduleStatus();
  } catch (err) {
    alert('Schedule error: ' + err.message);
  } finally {
    scheduleBtn.disabled = false;
  }
}

function startStatusPolling() {
  stopStatusPolling();
  statusPollTimer = setInterval(loadScheduleStatus, 30000); // Poll every 30s
}

function stopStatusPolling() {
  if (statusPollTimer) {
    clearInterval(statusPollTimer);
    statusPollTimer = null;
  }
}

// ── Diagnosis & Fix ──

let currentDiagnoses = null;

async function diagnoseFindings() {
  const customerId = document.getElementById('accountSelect').value;
  if (!customerId) return alert('Select an account first.');

  const btn = document.getElementById('diagnoseBtn');
  const resultsDiv = document.getElementById('diagnosisResults');
  btn.disabled = true;
  btn.textContent = 'Diagnosing...';
  resultsDiv.innerHTML = '<div class="audit-loading"><div class="spinner"></div><p>Analyzing findings and generating fix recommendations...</p></div>';

  try {
    const res = await fetch(`/api/audit/diagnose?customerId=${customerId}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Diagnosis failed');

    currentDiagnoses = data.diagnoses;
    renderDiagnoses(data.diagnoses);
  } catch (err) {
    resultsDiv.innerHTML = `<div class="error-msg">Diagnosis error: ${escapeHtml(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Diagnose & Suggest Fixes';
  }
}

function renderDiagnoses(diagnoses) {
  const resultsDiv = document.getElementById('diagnosisResults');
  const fixable = diagnoses.filter(d => d.fixable && d.fixes.length > 0);
  const manual = diagnoses.filter(d => d.manualNotes && d.manualNotes.length > 0);

  let html = '';

  if (fixable.length > 0) {
    const totalFixes = fixable.reduce((sum, d) => sum + d.fixes.length, 0);
    html += `<div class="diagnosis-section">`;
    html += `<h3 class="diagnosis-title">Auto-Fixable (${totalFixes} fixes available)</h3>`;
    html += `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px;">`;
    html += `<button class="btn-primary" onclick="toggleSelectAll()" id="selectAllBtn">Select All</button>`;
    html += `<button class="btn-primary" onclick="applySelectedFixes()" id="applySelectedBtn" disabled style="background:var(--green);">Apply Selected (0)</button>`;
    html += `<button class="btn-primary" onclick="applyAllFixes()" id="applyAllBtn" style="background:var(--blue);">Apply All Fixes</button>`;
    html += `</div>`;

    for (const d of fixable) {
      html += `<div class="diagnosis-card fixable">`;
      html += `<div class="diagnosis-header" style="display:flex;align-items:center;justify-content:space-between;">
        <span>${escapeHtml(d.title)}</span>
        ${d.fixes.length > 1 ? `<button class="btn-fix" style="background:var(--blue);color:#fff;border:none;padding:4px 12px;border-radius:4px;font-size:11px;cursor:pointer;" data-fixall-check="${escapeHtml(d.checkId)}">Fix All (${d.fixes.length})</button>` : ''}
      </div>`;
      html += `<ul class="fix-list">`;
      for (let i = 0; i < d.fixes.length; i++) {
        const fix = d.fixes[i];
        html += `<li class="fix-item" style="display:flex;align-items:center;gap:8px;">
          <input type="checkbox" class="fix-checkbox" data-check-id="${escapeHtml(d.checkId)}" data-fix-index="${i}" onchange="updateSelectedCount()" style="min-width:16px;">
          <span class="fix-desc" style="flex:1;">${escapeHtml(fix.description)}</span>
          <button class="btn-fix" onclick="applySingleFix('${escapeHtml(d.checkId)}', ${i})">Fix</button>
        </li>`;
      }
      html += `</ul></div>`;
    }
    html += `</div>`;
  }

  if (manual.length > 0) {
    html += `<div class="diagnosis-section">`;
    html += `<h3 class="diagnosis-title">Manual Review Required</h3>`;
    for (const d of manual) {
      if (!d.fixable || d.fixes.length === 0) {
        html += `<div class="diagnosis-card manual">`;
        html += `<div class="diagnosis-header">${escapeHtml(d.title)}</div>`;
        html += `<ul class="manual-notes">`;
        for (const note of d.manualNotes) {
          html += `<li>${escapeHtml(note)}</li>`;
        }
        html += `</ul></div>`;
      }
    }
    html += `</div>`;
  }

  if (fixable.length === 0 && manual.length === 0) {
    html = '<div class="empty-msg">No actionable recommendations found.</div>';
  }

  resultsDiv.innerHTML = html;

  // Attach Fix All per-category handlers
  resultsDiv.querySelectorAll('[data-fixall-check]').forEach(btn => {
    btn.addEventListener('click', () => applyFixesForCheck(btn.dataset.fixallCheck));
  });
}

async function applyFixesForCheck(checkId) {
  if (!currentDiagnoses) return;
  const d = currentDiagnoses.find(diag => diag.checkId === checkId);
  if (!d || !d.fixes || d.fixes.length === 0) return;
  if (!confirm(`Apply all ${d.fixes.length} fixes for "${d.title}"? This will modify campaigns in Google Ads.`)) return;
  await executeFixes(d.fixes);
}

function updateSelectedCount() {
  const checked = document.querySelectorAll('.fix-checkbox:checked');
  const btn = document.getElementById('applySelectedBtn');
  if (btn) {
    btn.textContent = `Apply Selected (${checked.length})`;
    btn.disabled = checked.length === 0;
  }
}

function toggleSelectAll() {
  const boxes = document.querySelectorAll('.fix-checkbox');
  const allChecked = Array.from(boxes).every(cb => cb.checked);
  boxes.forEach(cb => { cb.checked = !allChecked; });
  const btn = document.getElementById('selectAllBtn');
  if (btn) btn.textContent = allChecked ? 'Select All' : 'Deselect All';
  updateSelectedCount();
}

async function applySelectedFixes() {
  if (!currentDiagnoses) return;
  const checked = document.querySelectorAll('.fix-checkbox:checked');
  if (checked.length === 0) return alert('No fixes selected.');

  const selectedFixes = [];
  checked.forEach(cb => {
    const checkId = cb.dataset.checkId;
    const fixIndex = parseInt(cb.dataset.fixIndex);
    const d = currentDiagnoses.find(diag => diag.checkId === checkId);
    if (d && d.fixes[fixIndex]) selectedFixes.push(d.fixes[fixIndex]);
  });

  if (selectedFixes.length === 0) return;
  if (!confirm(`Apply ${selectedFixes.length} selected fixes? This will modify campaigns in Google Ads.`)) return;
  await executeFixes(selectedFixes);
}

async function applyAllFixes() {
  if (!currentDiagnoses) return;
  const customerId = document.getElementById('accountSelect').value;
  if (!customerId) return;

  const allFixes = [];
  for (const d of currentDiagnoses) {
    if (d.fixable && d.fixes) {
      allFixes.push(...d.fixes);
    }
  }
  if (allFixes.length === 0) return alert('No fixes to apply.');
  if (!confirm(`Apply ${allFixes.length} fixes? This will modify campaigns in Google Ads.`)) return;

  await executeFixes(allFixes);
}

async function applySingleFix(checkId, fixIndex) {
  if (!currentDiagnoses) return;
  const customerId = document.getElementById('accountSelect').value;
  if (!customerId) return;

  const d = currentDiagnoses.find(diag => diag.checkId === checkId);
  if (!d || !d.fixes[fixIndex]) return;

  const fix = d.fixes[fixIndex];
  if (!confirm(`Apply fix: ${fix.description}?`)) return;

  await executeFixes([fix]);
}

async function executeFixes(fixes) {
  const customerId = document.getElementById('accountSelect').value;
  const resultsDiv = document.getElementById('diagnosisResults');
  const btn = document.getElementById('applyAllBtn');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch(`/api/audit/fix?customerId=${customerId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fixes }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Fix failed');

    // Show results
    let html = `<div class="fix-results">`;
    html += `<h3>${data.message}</h3>`;
    for (const detail of data.results.details) {
      const cls = detail.success ? 'fix-success' : 'fix-failure';
      html += `<div class="${cls}">${detail.success ? '&#x2705;' : '&#x274C;'} ${escapeHtml(detail.description)}${detail.error ? ' — ' + escapeHtml(detail.error) : ''}</div>`;
    }
    html += `<button class="btn-primary" onclick="runAudit()" style="margin-top: 12px;">Re-run Audit</button>`;
    html += `</div>`;
    resultsDiv.innerHTML = html;
  } catch (err) {
    resultsDiv.innerHTML += `<div class="error-msg">Fix error: ${escapeHtml(err.message)}</div>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Init ──
async function init() {
  await checkAuth();
  await loadScheduleStatus();
  if (scheduleActive) startStatusPolling();
}
init();

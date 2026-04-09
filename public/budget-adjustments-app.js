/* Budget Adjustments App — frontend for scan, review, approve/reject */

/* eslint-disable no-unused-vars */
/* global fetch */

let scanData = null;
let pendingBatches = [];

// ── Auth check ──
(async function checkAuth() {
  try {
    const res = await fetch('/api/accounts');
    if (res.ok) {
      document.getElementById('authStatus').textContent = 'Google Ads Connected';
      document.getElementById('authStatus').style.opacity = '1';
      // Auto-load pending adjustments
      await loadPending();
    } else {
      document.getElementById('authStatus').textContent = 'Not Connected';
    }
  } catch { /* ignore */ }
})();

// ── Helpers ──
function esc(str) { const d = document.createElement('div'); d.textContent = str; return d.innerHTML; }
function fmtCurrency(n) { return '$' + Math.abs(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtSignedCurrency(n) { return (n >= 0 ? '+' : '-') + fmtCurrency(n); }

// ── Scan ──
async function runScan() {
  const btn = document.getElementById('scanBtn');
  const content = document.getElementById('content');
  btn.disabled = true;
  btn.textContent = 'Scanning...';
  content.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Scanning all accounts for pacing issues...</p></div>';

  try {
    const res = await fetch('/api/budget-adjustments/scan', { method: 'POST' });
    const data = await res.json();

    if (!res.ok) {
      content.innerHTML = `<div class="error-msg">${esc(data.error || 'Scan failed')}</div>`;
      return;
    }

    scanData = data;

    // Show summary
    const summary = document.getElementById('scanSummary');
    summary.style.display = 'flex';
    summary.innerHTML = `
      <div class="scan-stat"><strong>${data.flagged?.length || 0}</strong> accounts flagged</div>
      <div class="scan-stat"><strong>${data.adjustments?.length || 0}</strong> adjustments generated</div>
      <div class="scan-stat" style="color:var(--text3)">${esc(data.message || '')}</div>
    `;

    if (!data.adjustments || data.adjustments.length === 0) {
      content.innerHTML = `<div class="empty-msg">${esc(data.message || 'No accounts need adjustment.')}</div>`;
      return;
    }

    // Load the full adjustment batches
    await loadPending();
  } catch (err) {
    content.innerHTML = `<div class="error-msg">Scan error: ${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Scan for Issues';
  }
}

// ── Load pending adjustments ──
async function loadPending() {
  const content = document.getElementById('content');

  try {
    const res = await fetch('/api/budget-adjustments/pending');
    const data = await res.json();
    pendingBatches = data.adjustments || [];

    if (pendingBatches.length === 0) {
      if (!scanData) {
        content.innerHTML = '<div class="empty-msg">No pending adjustments. Click "Scan for Issues" to check accounts.</div>';
      }
      return;
    }

    renderBatches(pendingBatches);
  } catch (err) {
    content.innerHTML = `<div class="error-msg">Failed to load pending adjustments: ${esc(err.message)}</div>`;
  }
}

// ── Render adjustment cards ──
function renderBatches(batches) {
  const content = document.getElementById('content');

  const cards = batches.map(batch => {
    const urgencyClass = batch.direction === 'over' ? 'high' : 'medium';
    const dirLabel = batch.direction === 'over' ? 'Over-Pacing' : 'Under-Pacing';

    // Adjustment rows
    const rows = (batch.adjustments || []).map(adj => {
      const changeClass = adj.change >= 0 ? 'change-pos' : 'change-neg';
      const sharedBadge = adj.isShared ? '<span class="shared-badge">SHARED</span>' : '';
      const modelLabel = adj.model ? ` (${esc(adj.model)})` : '';
      return `<tr>
        <td>${esc(adj.target)}${sharedBadge}${modelLabel}</td>
        <td>${esc(adj.campaignType || '')}</td>
        <td>${fmtCurrency(adj.currentDailyBudget)}/day</td>
        <td>${fmtCurrency(adj.recommendedDailyBudget)}/day</td>
        <td class="${changeClass}">${fmtSignedCurrency(adj.change)}/day</td>
        <td>${esc(adj.reason || '')}</td>
      </tr>`;
    }).join('');

    const summaryText = batch.summary
      ? `Need ${fmtSignedCurrency(batch.summary.totalChangeNeeded)}/day total`
      : '';

    return `<div class="adj-card" id="card-${esc(batch.adjustmentId)}">
      <div class="adj-card-header">
        <div class="adj-dealer-name">${esc(batch.dealerName)}</div>
        <span class="adj-direction">${dirLabel}</span>
        <span class="adj-urgency ${urgencyClass}">${batch.adjustments?.length || 0} changes</span>
      </div>
      <div class="adj-reasons">${summaryText}</div>
      <table class="adj-table">
        <thead><tr>
          <th>Campaign / Budget</th>
          <th>Type</th>
          <th>Current</th>
          <th>Recommended</th>
          <th>Change</th>
          <th>Reason</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="adj-actions">
        <button class="btn-reject" onclick="rejectBatch('${esc(batch.adjustmentId)}')">Reject</button>
        <button class="btn-approve" onclick="approveBatch('${esc(batch.adjustmentId)}')">Approve & Apply</button>
      </div>
    </div>`;
  }).join('');

  content.innerHTML = cards;
}

// ── Approve ──
async function approveBatch(adjustmentId) {
  const card = document.getElementById(`card-${adjustmentId}`);
  const actionsDiv = card?.querySelector('.adj-actions');
  if (actionsDiv) {
    actionsDiv.innerHTML = '<span style="color:var(--text3)">Applying changes...</span>';
  }

  try {
    const res = await fetch(`/api/budget-adjustments/${adjustmentId}/approve`, { method: 'POST' });
    const data = await res.json();

    if (!res.ok) {
      const msg = data.error || 'Approval failed';
      if (actionsDiv) {
        actionsDiv.innerHTML = `<div class="execution-result failed">${esc(msg)}</div>`;
      }
      if (data.staleAdjustments) {
        const staleList = data.staleAdjustments.map(s =>
          `${esc(s.target)}: was ${fmtCurrency(s.expectedBudget)}, now ${fmtCurrency(s.actualBudget)}`
        ).join('<br>');
        if (actionsDiv) {
          actionsDiv.innerHTML += `<div style="color:var(--text3);font-size:11px;margin-top:8px">${staleList}</div>`;
        }
      }
      return;
    }

    const r = data.results;
    const statusClass = r.failed === 0 ? 'success' : (r.applied > 0 ? 'partial' : 'failed');
    const msg = `Applied ${r.applied} of ${r.applied + r.failed} changes.`;

    if (actionsDiv) {
      actionsDiv.innerHTML = `<div class="execution-result ${statusClass}">${esc(msg)}</div>`;
    }

    // Show per-change results
    if (r.details && r.details.length > 0) {
      const detailHtml = r.details.map(d => {
        if (d.success) {
          return `<div style="font-size:11px;color:#4ade80;margin-top:4px">${esc(d.target)}: ${fmtCurrency(d.previousBudget)} → ${fmtCurrency(d.newBudget)}</div>`;
        }
        return `<div style="font-size:11px;color:#f87171;margin-top:4px">${esc(d.target)}: ${esc(d.error)}</div>`;
      }).join('');
      actionsDiv.innerHTML += detailHtml;
    }
  } catch (err) {
    if (actionsDiv) {
      actionsDiv.innerHTML = `<div class="execution-result failed">Error: ${esc(err.message)}</div>`;
    }
  }
}

// ── Reject ──
async function rejectBatch(adjustmentId) {
  try {
    await fetch(`/api/budget-adjustments/${adjustmentId}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Manually rejected' }),
    });

    const card = document.getElementById(`card-${adjustmentId}`);
    if (card) {
      card.style.opacity = '0.4';
      const actionsDiv = card.querySelector('.adj-actions');
      if (actionsDiv) actionsDiv.innerHTML = '<span style="color:var(--text3)">Rejected</span>';
    }
  } catch (err) {
    alert('Reject failed: ' + err.message);
  }
}

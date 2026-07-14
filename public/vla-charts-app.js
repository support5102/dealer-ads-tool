/* VLA Campaign Charts — client-side logic.
 *
 * Fetches per-dealer daily VLA metrics from /api/vla-charts/all and renders one
 * small line chart per dealer. A global toggle swaps the plotted metric between
 * Clicks / Spend / Impressions without refetching (data is cached client-side).
 */

// ── State ──
let vcData = null;          // { dealers: [{dealerName, customerId, days:[{date,clicks,impressions,cost}]}], failed }
let currentMetric = 'clicks';

const METRICS = {
  clicks:      { label: 'Clicks',      fmt: fmtInt,      stroke: '#3b82f6', fill: 'rgba(59,130,246,0.14)' },
  cost:        { label: 'Spend',       fmt: fmtCurrency, stroke: '#22c55e', fill: 'rgba(34,197,94,0.14)' },
  impressions: { label: 'Impressions', fmt: fmtInt,      stroke: '#a78bfa', fill: 'rgba(167,139,250,0.16)' },
};

// ── Formatting helpers ──
function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; }
function fmtInt(n) { return Math.round(Number(n) || 0).toLocaleString('en-US'); }
function fmtCurrency(n) { return '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtDateShort(d) { const [y, m, day] = String(d).split('-'); return `${Number(m)}/${Number(day)}`; }

// ── Auth ──
async function checkAuth() {
  try {
    const res = await fetch('/api/auth/status');
    const data = await res.json();
    const el = document.getElementById('authStatus');
    if (data.connected) {
      el.textContent = 'Google Ads Connected';
      el.style.opacity = '1';
      el.style.color = '#4ade80';
      loadCharts();
    } else {
      el.textContent = 'Not Connected';
      el.style.opacity = '1';
      el.style.cursor = 'pointer';
      el.style.pointerEvents = 'auto';
      el.onclick = () => { window.location.href = '/auth/google'; };
      document.getElementById('content').innerHTML =
        '<div class="empty-msg">Connect Google Ads to view VLA charts.</div>';
    }
  } catch {
    document.getElementById('authStatus').textContent = 'Connection Error';
  }
}

// ── Load ──
async function loadCharts() {
  const content = document.getElementById('content');
  const loading = document.getElementById('loadingState');
  const summary = document.getElementById('summaryBar');
  const failed = document.getElementById('failedSection');

  content.innerHTML = '';
  failed.innerHTML = '';
  summary.style.display = 'none';
  loading.style.display = 'block';
  document.getElementById('refreshBtn').disabled = true;

  try {
    // Ensure accounts are loaded into the session before querying.
    await fetch('/api/accounts');
    const res = await fetch('/api/vla-charts/all');
    const data = await res.json();

    if (!res.ok) {
      content.innerHTML = `<div class="error-msg">${esc(data.error || 'Failed to load VLA charts.')}</div>`;
      return;
    }
    if (!data.dealers || data.dealers.length === 0) {
      content.innerHTML = '<div class="empty-msg">No dealers with active VLA campaigns found.</div>';
      renderFailed(data.failed);
      return;
    }

    vcData = data;
    renderGrid();
    renderFailed(data.failed);
  } catch (err) {
    content.innerHTML = `<div class="error-msg">Network error: ${esc(err.message)}</div>`;
  } finally {
    loading.style.display = 'none';
    document.getElementById('refreshBtn').disabled = false;
  }
}

// ── Metric toggle ──
function setMetric(metric) {
  if (!METRICS[metric]) return;
  currentMetric = metric;
  document.querySelectorAll('.metric-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.metric === metric);
  });
  renderGrid();
}

// ── Render ──
function renderGrid() {
  if (!vcData) return;
  const content = document.getElementById('content');
  const summary = document.getElementById('summaryBar');
  const cfg = METRICS[currentMetric];

  const search = (document.getElementById('filterInput').value || '').toLowerCase().trim();
  const dealers = vcData.dealers.filter(d => !search || d.dealerName.toLowerCase().includes(search));

  // Summary: dealer count + total of the current metric across all shown dealers.
  const grandTotal = dealers.reduce((sum, d) => sum + d.days.reduce((s, x) => s + (Number(x[currentMetric]) || 0), 0), 0);
  summary.innerHTML =
    `<strong>${dealers.length}</strong> dealer${dealers.length === 1 ? '' : 's'} with VLA · ` +
    `30-day ${cfg.label.toLowerCase()}: <strong>${cfg.fmt(grandTotal)}</strong>`;
  summary.style.display = 'block';

  if (dealers.length === 0) {
    content.innerHTML = '<div class="empty-msg">No dealers match your search.</div>';
    return;
  }

  content.innerHTML = `<div class="vc-grid">${dealers.map(d => renderCard(d, cfg)).join('')}</div>`;
}

function renderCard(dealer, cfg) {
  const days = dealer.days;
  const total = days.reduce((s, x) => s + (Number(x[currentMetric]) || 0), 0);
  const first = days.length ? fmtDateShort(days[0].date) : '';
  const last = days.length ? fmtDateShort(days[days.length - 1].date) : '';
  const peak = days.reduce((mx, x) => Math.max(mx, Number(x[currentMetric]) || 0), 0);

  return `<div class="vc-card">
    <div class="vc-card-head">
      <span class="vc-dealer" title="${esc(dealer.dealerName)}">${esc(dealer.dealerName)}</span>
      <span class="vc-metric-total">${cfg.label}: <b>${cfg.fmt(total)}</b></span>
    </div>
    ${buildLineChart(days, currentMetric, cfg)}
    <div class="vc-card-foot">
      <span>${esc(first)}</span>
      <span>peak ${cfg.fmt(peak)}</span>
      <span>${esc(last)}</span>
    </div>
  </div>`;
}

/**
 * Builds an inline SVG line chart (area + line + last-point dot) for a metric
 * series. No external charting library — pure SVG scaled into a 300x90 viewBox.
 */
function buildLineChart(days, metricKey, cfg) {
  const W = 300, H = 90, P = 6;
  const vals = days.map(d => Number(d[metricKey]) || 0);
  const n = vals.length;
  if (n === 0) return `<svg class="vc-chart" viewBox="0 0 ${W} ${H}"></svg>`;

  const max = Math.max(1, ...vals);
  const x = i => P + (n <= 1 ? (W - 2 * P) / 2 : (i * (W - 2 * P) / (n - 1)));
  const y = v => (H - P) - (v / max) * (H - 2 * P);

  const linePts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const areaPts = `${x(0).toFixed(1)},${(H - P).toFixed(1)} ${linePts} ${x(n - 1).toFixed(1)},${(H - P).toFixed(1)}`;
  const lastX = x(n - 1).toFixed(1);
  const lastY = y(vals[n - 1]).toFixed(1);

  return `<svg class="vc-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <polygon points="${areaPts}" fill="${cfg.fill}" stroke="none"/>
    <polyline points="${linePts}" fill="none" stroke="${cfg.stroke}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    <circle cx="${lastX}" cy="${lastY}" r="3" fill="${cfg.stroke}"/>
  </svg>`;
}

// ── Failed accounts ──
function renderFailed(failed) {
  const el = document.getElementById('failedSection');
  if (!failed || failed.length === 0) { el.innerHTML = ''; return; }
  const items = failed.map(f => `<li>${esc(f.dealerName)}: ${esc(f.error)}</li>`).join('');
  el.innerHTML = `<details class="failed-section" style="margin-top:20px"><summary>${failed.length} account(s) failed to load</summary><ul>${items}</ul></details>`;
}

// ── Init ──
checkAuth();

// Expose for inline handlers
window.setMetric = setMetric;
window.loadCharts = loadCharts;
window.renderGrid = renderGrid;

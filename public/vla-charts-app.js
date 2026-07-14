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
  clicks:      { label: 'Clicks',      fmt: fmtInt },
  cost:        { label: 'Spend',       fmt: fmtCurrency },
  impressions: { label: 'Impressions', fmt: fmtInt },
};

// Distinct colors, one per VLA campaign within a dealer card (cycles if needed).
const CAMPAIGN_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#a78bfa', '#ef4444', '#14b8a6', '#ec4899', '#84cc16', '#eab308', '#06b6d4'];
const colorFor = i => CAMPAIGN_COLORS[i % CAMPAIGN_COLORS.length];

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
  const grandTotal = dealers.reduce((sum, d) => sum + dealerTotal(d), 0);
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

// Total of the current metric across one campaign's days.
function campaignTotal(campaign) {
  return campaign.days.reduce((s, x) => s + (Number(x[currentMetric]) || 0), 0);
}
// Total of the current metric across all of a dealer's VLA campaigns.
function dealerTotal(dealer) {
  return (dealer.campaigns || []).reduce((s, c) => s + campaignTotal(c), 0);
}

function renderCard(dealer, cfg) {
  const campaigns = dealer.campaigns || [];

  // Shared date axis: union of every campaign's dates, ascending.
  const dateSet = new Set();
  campaigns.forEach(c => c.days.forEach(d => dateSet.add(d.date)));
  const dates = [...dateSet].sort();
  const first = dates.length ? fmtDateShort(dates[0]) : '';
  const last = dates.length ? fmtDateShort(dates[dates.length - 1]) : '';

  const legend = campaigns.map((c, i) => `
    <span class="vc-legend-item">
      <span class="vc-swatch" style="background:${colorFor(i)}"></span>
      <span class="vc-legend-name" title="${esc(c.name)}">${esc(c.name)}</span>
      <span class="vc-legend-val">${cfg.fmt(campaignTotal(c))}</span>
    </span>`).join('');

  return `<div class="vc-card">
    <div class="vc-card-head">
      <span class="vc-dealer" title="${esc(dealer.dealerName)}">${esc(dealer.dealerName)}</span>
      <span class="vc-metric-total">${cfg.label}: <b>${cfg.fmt(dealerTotal(dealer))}</b></span>
    </div>
    ${buildMultiLineChart(campaigns, dates, currentMetric)}
    <div class="vc-legend">${legend}</div>
    <div class="vc-card-foot">
      <span>${esc(first)}</span>
      <span>${campaigns.length} campaign${campaigns.length === 1 ? '' : 's'}</span>
      <span>${esc(last)}</span>
    </div>
  </div>`;
}

/**
 * Builds an inline SVG chart with one line per VLA campaign, each in its own
 * color, over a shared date axis. No external charting library — pure SVG
 * scaled into a 300x90 viewBox. y-scale is shared across campaigns so line
 * heights are comparable within the card.
 */
function buildMultiLineChart(campaigns, dates, metricKey) {
  const W = 300, H = 90, P = 6;
  if (!dates.length || !campaigns.length) return `<svg class="vc-chart" viewBox="0 0 ${W} ${H}"></svg>`;

  const idx = new Map(dates.map((d, i) => [d, i]));
  const n = dates.length;
  let max = 1;
  campaigns.forEach(c => c.days.forEach(d => { const v = Number(d[metricKey]) || 0; if (v > max) max = v; }));

  const x = i => P + (n <= 1 ? (W - 2 * P) / 2 : (i * (W - 2 * P) / (n - 1)));
  const y = v => (H - P) - (v / max) * (H - 2 * P);

  const lines = campaigns.map((c, ci) => {
    const pts = c.days
      .filter(d => idx.has(d.date))
      .map(d => `${x(idx.get(d.date)).toFixed(1)},${y(Number(d[metricKey]) || 0).toFixed(1)}`)
      .join(' ');
    if (!pts) return '';
    return `<polyline points="${pts}" fill="none" stroke="${colorFor(ci)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
  }).join('');

  return `<svg class="vc-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${lines}</svg>`;
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

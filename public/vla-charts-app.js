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

// Chart geometry in viewBox units (the SVG is stretched to the card width via
// preserveAspectRatio="none", so x maps linearly from client px).
const VC_W = 300, VC_H = 90, VC_P = 6;
const vcX = (i, n) => VC_P + (n <= 1 ? (VC_W - 2 * VC_P) / 2 : (i * (VC_W - 2 * VC_P) / (n - 1)));
const vcY = (v, max) => (VC_H - VC_P) - (v / (max || 1)) * (VC_H - 2 * VC_P);

// Per-card chart models (campaigns/dates/metric/max), indexed by card position.
// Rebuilt on every renderGrid() so the hover handler can look up daily values.
let chartModels = [];
let vcTooltipEl = null;
function ensureTooltip() {
  if (!vcTooltipEl) {
    vcTooltipEl = document.createElement('div');
    vcTooltipEl.className = 'vc-tooltip';
    vcTooltipEl.style.display = 'none';
    document.body.appendChild(vcTooltipEl);
  }
  return vcTooltipEl;
}

// ── Formatting helpers ──
function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; }
function fmtInt(n) { return Math.round(Number(n) || 0).toLocaleString('en-US'); }
function fmtCurrency(n) { return '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtDateShort(d) { const [y, m, day] = String(d).split('-'); return `${Number(m)}/${Number(day)}`; }
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDateLong(d) { const [y, m, day] = String(d).split('-'); return `${MONTH_ABBR[Number(m) - 1]} ${Number(day)}`; }

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

  chartModels = [];
  content.innerHTML = `<div class="vc-grid">${dealers.map((d, i) => renderCard(d, cfg, i)).join('')}</div>`;
  attachHovers();
}

// Total of the current metric across one campaign's days.
function campaignTotal(campaign) {
  return campaign.days.reduce((s, x) => s + (Number(x[currentMetric]) || 0), 0);
}
// Total of the current metric across all of a dealer's VLA campaigns.
function dealerTotal(dealer) {
  return (dealer.campaigns || []).reduce((s, c) => s + campaignTotal(c), 0);
}

function renderCard(dealer, cfg, cardIdx) {
  const campaigns = dealer.campaigns || [];

  // Shared date axis: union of every campaign's dates, ascending.
  const dateSet = new Set();
  campaigns.forEach(c => c.days.forEach(d => dateSet.add(d.date)));
  const dates = [...dateSet].sort();
  const first = dates.length ? fmtDateShort(dates[0]) : '';
  const last = dates.length ? fmtDateShort(dates[dates.length - 1]) : '';

  // y-scale shared across campaigns so line heights are comparable within the card.
  let max = 1;
  campaigns.forEach(c => c.days.forEach(d => { const v = Number(d[currentMetric]) || 0; if (v > max) max = v; }));

  // Stash the model so the hover handler can resolve daily values by index.
  chartModels[cardIdx] = { campaigns, dates, metric: currentMetric, max };

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
    ${buildMultiLineChart(campaigns, dates, currentMetric, max, cardIdx)}
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
 * color, over a shared date axis. Also embeds the hover crosshair (a vertical
 * cursor line, one dot per campaign, and a transparent hit rect) that
 * attachHovers() wires up. No external charting library.
 */
function buildMultiLineChart(campaigns, dates, metricKey, max, cardIdx) {
  if (!dates.length || !campaigns.length) return `<svg class="vc-chart" viewBox="0 0 ${VC_W} ${VC_H}"></svg>`;

  const idx = new Map(dates.map((d, i) => [d, i]));
  const n = dates.length;

  const lines = campaigns.map((c, ci) => {
    const pts = c.days
      .filter(d => idx.has(d.date))
      .map(d => `${vcX(idx.get(d.date), n).toFixed(1)},${vcY(Number(d[metricKey]) || 0, max).toFixed(1)}`)
      .join(' ');
    return pts ? `<polyline points="${pts}" fill="none" stroke="${colorFor(ci)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>` : '';
  }).join('');

  const dots = campaigns.map((c, ci) =>
    `<circle class="vc-dot" r="3.5" fill="${colorFor(ci)}" pointer-events="none" style="display:none"/>`).join('');

  return `<svg class="vc-chart" viewBox="0 0 ${VC_W} ${VC_H}" preserveAspectRatio="none" data-card="${cardIdx}">
    ${lines}
    <line class="vc-cursor" y1="${VC_P}" y2="${VC_H - VC_P}" stroke="var(--text3, #6b7f9e)" stroke-width="1" vector-effect="non-scaling-stroke" pointer-events="none" style="display:none"/>
    ${dots}
    <rect class="vc-hit" x="0" y="0" width="${VC_W}" height="${VC_H}" fill="transparent" pointer-events="all" style="cursor:crosshair"/>
  </svg>`;
}

/**
 * Wires hover interactivity onto each rendered chart: on mousemove the crosshair
 * snaps to the nearest day, drops a dot on every campaign line that has data
 * that day, and shows a tooltip listing the date + each campaign's value.
 */
function attachHovers() {
  const tt = ensureTooltip();

  document.querySelectorAll('svg.vc-chart[data-card]').forEach(svg => {
    const model = chartModels[Number(svg.getAttribute('data-card'))];
    if (!model || !model.dates.length) return;

    const cursor = svg.querySelector('.vc-cursor');
    const dots = [...svg.querySelectorAll('.vc-dot')];
    const hit = svg.querySelector('.vc-hit');
    if (!hit) return;

    const move = (e) => {
      const rect = svg.getBoundingClientRect();
      if (!rect.width) return;
      const n = model.dates.length;
      const vbX = (e.clientX - rect.left) / rect.width * VC_W;
      let i = n <= 1 ? 0 : Math.round((vbX - VC_P) / ((VC_W - 2 * VC_P) / (n - 1)));
      i = Math.max(0, Math.min(n - 1, i));

      const date = model.dates[i];
      const cx = vcX(i, n);
      const cfg = METRICS[model.metric];

      cursor.setAttribute('x1', cx);
      cursor.setAttribute('x2', cx);
      cursor.style.display = '';

      const rows = [];
      model.campaigns.forEach((c, ci) => {
        const dd = c.days.find(d => d.date === date);
        const dot = dots[ci];
        if (dd) {
          const v = Number(dd[model.metric]) || 0;
          dot.setAttribute('cx', cx.toFixed(1));
          dot.setAttribute('cy', vcY(v, model.max).toFixed(1));
          dot.style.display = '';
          rows.push(`<div class="vc-tt-row"><span class="vc-swatch" style="background:${colorFor(ci)}"></span><span class="vc-tt-name">${esc(c.name)}</span><span class="vc-tt-val">${cfg.fmt(v)}</span></div>`);
        } else if (dot) {
          dot.style.display = 'none';
        }
      });

      tt.innerHTML = `<div class="vc-tt-date">${esc(fmtDateLong(date))} &middot; ${cfg.label}</div>${rows.join('')}`;
      tt.style.display = 'block';

      // Position near the cursor, flipping to stay on-screen.
      let left = e.clientX + 14, top = e.clientY + 14;
      const tw = tt.offsetWidth, th = tt.offsetHeight;
      if (left + tw > window.innerWidth - 8) left = e.clientX - tw - 14;
      if (top + th > window.innerHeight - 8) top = e.clientY - th - 14;
      tt.style.left = left + 'px';
      tt.style.top = top + 'px';
    };

    const leave = () => {
      cursor.style.display = 'none';
      dots.forEach(d => { d.style.display = 'none'; });
      tt.style.display = 'none';
    };

    hit.addEventListener('mousemove', move);
    hit.addEventListener('mouseleave', leave);
  });
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

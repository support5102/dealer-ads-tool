/* CPC Optimizer — client-side controller.
 *
 * Pulls /api/cpc-optimizer/scan, renders one row per campaign across all
 * dealers, with sort + "flagged only" filter. The server side does all the
 * threshold logic; this file only renders + interacts.
 */

(function () {
  var state = {
    campaigns: [],
    meta: null,
    sortKey: 'rankLostPct',
    sortDir: 'desc',
    flaggedOnly: false,
    dealerFilter: '',
  };

  window.runScan = async function runScan() {
    var btn = document.getElementById('scanBtn');
    var status = document.getElementById('status');
    btn.disabled = true;
    status.textContent = 'Scanning… this may take 30–60s for a full MCC.';
    try {
      var resp = await fetch('/api/cpc-optimizer/scan');
      if (!resp.ok) {
        var errText = await resp.text();
        try {
          var errJson = JSON.parse(errText);
          throw new Error(errJson.error || errText);
        } catch (_) {
          throw new Error(errText || ('HTTP ' + resp.status));
        }
      }
      var data = await resp.json();
      state.campaigns = data.campaigns || [];
      state.meta = data;
      status.textContent = '';
      populateDealerOptions();
      renderMeta();
      renderTable();
    } catch (err) {
      status.textContent = 'Error: ' + err.message;
    } finally {
      btn.disabled = false;
    }
  };

  window.toggleFlagFilter = function toggleFlagFilter() {
    state.flaggedOnly = !state.flaggedOnly;
    var pill = document.getElementById('flagPill');
    if (state.flaggedOnly) pill.classList.add('active');
    else pill.classList.remove('active');
    renderTable();
  };

  window.onDealerFilter = function onDealerFilter(value) {
    state.dealerFilter = value || '';
    renderTable();
  };

  function populateDealerOptions() {
    var sel = document.getElementById('dealerFilter');
    if (!sel) return;
    var seen = {};
    var names = [];
    for (var i = 0; i < state.campaigns.length; i++) {
      var n = state.campaigns[i].dealerName;
      if (n && !seen[n]) { seen[n] = true; names.push(n); }
    }
    names.sort(function (a, b) { return a.localeCompare(b); });
    var prev = state.dealerFilter;
    var html = '<option value="">All dealers (' + names.length + ')</option>';
    for (var j = 0; j < names.length; j++) {
      html += '<option value="' + esc(names[j]) + '">' + esc(names[j]) + '</option>';
    }
    sel.innerHTML = html;
    if (prev && seen[prev]) sel.value = prev;
    else state.dealerFilter = '';
  }

  function renderMeta() {
    var meta = state.meta;
    if (!meta) return;
    document.getElementById('meta').style.display = 'flex';
    document.getElementById('scannedAt').textContent = formatTime(meta.scannedAt);
    document.getElementById('accountsScanned').textContent =
      meta.accountsScanned + (meta.accountsFailed ? (' (' + meta.accountsFailed + ' failed)') : '');
    document.getElementById('totalCampaigns').textContent = state.campaigns.length;
    var flagged = state.campaigns.filter(function (c) { return c.flagged; }).length;
    document.getElementById('flaggedCount').textContent = flagged;
  }

  function renderTable() {
    var body = document.getElementById('resultsBody');
    var rows = state.campaigns.slice();
    if (state.dealerFilter) {
      rows = rows.filter(function (c) { return c.dealerName === state.dealerFilter; });
    }
    if (state.flaggedOnly) rows = rows.filter(function (c) { return c.flagged; });
    rows.sort(makeComparator(state.sortKey, state.sortDir));

    if (rows.length === 0) {
      body.innerHTML = '<tr><td colspan="10" class="cpc-empty">No campaigns match the current filter.</td></tr>';
      paintSortHeader();
      return;
    }

    var html = '';
    for (var i = 0; i < rows.length; i++) {
      var c = rows[i];
      var rowClass = c.flagged ? ' class="flagged"' : '';
      html += '<tr' + rowClass + '>';
      html += '<td>' + esc(c.dealerName) + '</td>';
      html += '<td>' + esc(c.campaignName) + '</td>';
      html += '<td>' + esc(shortChannel(c.channelType)) + '</td>';
      html += '<td class="num">' + fmtInt(c.impressions) + '</td>';
      html += '<td class="num">' + fmtInt(c.clicks) + '</td>';
      html += '<td class="num">' + fmtMoney(c.averageCpc) + '</td>';
      html += '<td class="num ' + pctClass(c.searchISPct, true) + '">' + fmtPct(c.searchISPct) + '</td>';
      html += '<td class="num ' + pctClass(c.rankLostPct) + '">' + fmtPct(c.rankLostPct) + '</td>';
      html += '<td class="num ' + pctClass(c.budgetLostPct) + '">' + fmtPct(c.budgetLostPct) + '</td>';
      html += '<td>' + (c.flagged ? '<span class="cpc-flag-badge">raise cpc</span>' : '') + '</td>';
      html += '</tr>';
    }
    body.innerHTML = html;
    paintSortHeader();
  }

  function paintSortHeader() {
    var ths = document.querySelectorAll('#resultsTable th[data-sort]');
    for (var i = 0; i < ths.length; i++) {
      var th = ths[i];
      th.classList.remove('sorted', 'asc');
      if (th.getAttribute('data-sort') === state.sortKey) {
        th.classList.add('sorted');
        if (state.sortDir === 'asc') th.classList.add('asc');
      }
    }
  }

  function makeComparator(key, dir) {
    var mult = dir === 'asc' ? 1 : -1;
    return function (a, b) {
      var av = a[key], bv = b[key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;          // nulls always last
      if (bv == null) return -1;
      if (typeof av === 'string') return mult * av.localeCompare(bv);
      return mult * (av - bv);
    };
  }

  // Click sort handlers
  document.addEventListener('click', function (ev) {
    var th = ev.target.closest && ev.target.closest('#resultsTable th[data-sort]');
    if (!th) return;
    var key = th.getAttribute('data-sort');
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
    } else {
      state.sortKey = key;
      // Numeric columns default to desc (biggest first); string columns default to asc.
      var isNum = th.classList.contains('num');
      state.sortDir = isNum ? 'desc' : 'asc';
    }
    renderTable();
  });

  // ─── helpers ──────────────────────────────────────────────────

  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmtInt(n) { return (n == null) ? '—' : Number(n).toLocaleString(); }
  function fmtMoney(n) { return (n == null) ? '—' : '$' + Number(n).toFixed(2); }
  function fmtPct(n) { return (n == null) ? '—' : Number(n).toFixed(1) + '%'; }
  function shortChannel(c) {
    if (!c) return '';
    if (c === 'SEARCH') return 'Search';
    if (c === 'PERFORMANCE_MAX') return 'PMax';
    if (c === 'SHOPPING') return 'Shop';
    if (c === 'DISPLAY') return 'Display';
    return c;
  }

  // Coloring: high lost-IS is bad (orange), low is fine. For search IS the
  // semantics flip (high IS is good).
  function pctClass(pct, higherIsBetter) {
    if (pct == null) return 'cpc-pct-low';
    if (higherIsBetter) {
      if (pct >= 75) return 'cpc-pct-low';     // good = muted
      if (pct >= 50) return 'cpc-pct-mid';
      return 'cpc-pct-high';                    // bad = orange
    }
    if (pct >= 15) return 'cpc-pct-high';
    if (pct >= 5)  return 'cpc-pct-mid';
    return 'cpc-pct-low';
  }

  function formatTime(iso) {
    if (!iso) return '—';
    try {
      var d = new Date(iso);
      return d.toLocaleString();
    } catch (_) { return iso; }
  }
})();

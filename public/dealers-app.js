/* Dealers Admin — client-side logic */

function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
}

function fmt(n) {
  if (n == null) return '—';
  return '$' + Number(n).toLocaleString();
}

function fmtDate(val) {
  if (!val) return '?';
  const d = new Date(val);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  dealers: [],
  history: new Map(), // dealerName -> [changes]
};

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function init() {
  await loadDealers();
  render();
  checkAuth();
}

async function loadDealers() {
  try {
    const res = await fetch('/api/dealers', { credentials: 'include' });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    state.dealers = data.dealers || [];
  } catch (err) {
    showGlobalFeedback('Failed to load dealers: ' + err.message, 'err');
  }
}

async function checkAuth() {
  try {
    const res = await fetch('/api/accounts', { credentials: 'include' });
    const el = document.getElementById('authStatus');
    if (!el) return;
    if (res.status === 401) {
      el.textContent = 'Not connected';
      el.style.opacity = '1';
      el.style.pointerEvents = 'auto';
    } else {
      const data = await res.json();
      el.textContent = data.email || 'Connected';
      el.style.opacity = '1';
    }
  } catch (_) {}
}

// ── Render ────────────────────────────────────────────────────────────────────

function render() {
  const list = document.getElementById('dealerList');
  const empty = document.getElementById('emptyState');

  if (state.dealers.length === 0) {
    empty.style.display = 'block';
    list.innerHTML = '';
    list.appendChild(empty);
    return;
  }

  empty.style.display = 'none';

  // Preserve open/close state across re-renders
  const openNames = new Set();
  list.querySelectorAll('.dealer-item.open').forEach(el => {
    openNames.add(el.dataset.dealerName);
  });

  list.innerHTML = state.dealers.map(d => renderDealer(d, openNames.has(d.dealerName))).join('');
}

function renderDealer(d, isOpen) {
  const openClass = isOpen ? ' open' : '';
  const encoded = encodeURIComponent(d.dealerName);

  // Splits summary: show which splits are configured
  const splitParts = [];
  if (d.newBudget != null) splitParts.push(`new:${fmt(d.newBudget)}`);
  if (d.usedBudget != null) splitParts.push(`used:${fmt(d.usedBudget)}`);
  if (d.vlaBudget != null) splitParts.push(`vla:${fmt(d.vlaBudget)}`);
  if (d.keywordBudget != null) splitParts.push(`kw:${fmt(d.keywordBudget)}`);
  const splitsSummary = splitParts.length > 0 ? splitParts.join(' · ') : 'no splits';

  const history = state.history.get(d.dealerName);
  const historyHtml = renderHistory(d.dealerName, history);

  return `
<div class="dealer-item${openClass}" data-dealer-name="${esc(d.dealerName)}">
  <div class="dealer-header" onclick="toggleDealer(${JSON.stringify(d.dealerName)})">
    <span class="dealer-chevron">&#9654;</span>
    <span class="dealer-name-badge">${esc(d.dealerName)}</span>
    <span class="budget-badge">${fmt(d.monthlyBudget)}</span>
    <span class="mode-badge">${esc(d.pacingMode || 'one_click')}</span>
    ${d.pacingCurveId ? `<span class="mode-badge">${esc(d.pacingCurveId)}</span>` : ''}
    <span class="splits-badge">${esc(splitsSummary)}</span>
  </div>
  <div class="dealer-body">

    <!-- (a) Edit non-budget fields -->
    <div class="body-section">
      <div class="section-label">Edit Settings</div>
      <div class="field-grid">
        <div>
          <span class="field-label">Pacing Mode</span>
          <select id="edit-mode-${encoded}">
            <option value="advisory"${d.pacingMode === 'advisory' ? ' selected' : ''}>advisory</option>
            <option value="one_click"${d.pacingMode === 'one_click' ? ' selected' : ''}>one_click</option>
            <option value="auto_apply"${d.pacingMode === 'auto_apply' ? ' selected' : ''}>auto_apply</option>
          </select>
        </div>
        <div>
          <span class="field-label">Pacing Curve</span>
          <select id="edit-curve-${encoded}">
            <option value=""${!d.pacingCurveId ? ' selected' : ''}>(none)</option>
            <option value="linear"${d.pacingCurveId === 'linear' ? ' selected' : ''}>linear</option>
            <option value="alanJay9505"${d.pacingCurveId === 'alanJay9505' ? ' selected' : ''}>alanJay9505</option>
          </select>
        </div>
        <div>
          <span class="field-label">New Budget</span>
          <input type="number" id="edit-newBudget-${encoded}" value="${d.newBudget != null ? d.newBudget : ''}" placeholder="optional" min="0" step="1"/>
        </div>
        <div>
          <span class="field-label">Used Budget</span>
          <input type="number" id="edit-usedBudget-${encoded}" value="${d.usedBudget != null ? d.usedBudget : ''}" placeholder="optional" min="0" step="1"/>
        </div>
        <div>
          <span class="field-label">VLA Budget</span>
          <input type="number" id="edit-vlaBudget-${encoded}" value="${d.vlaBudget != null ? d.vlaBudget : ''}" placeholder="optional" min="0" step="1"/>
        </div>
        <div>
          <span class="field-label">Keyword Budget</span>
          <input type="number" id="edit-keywordBudget-${encoded}" value="${d.keywordBudget != null ? d.keywordBudget : ''}" placeholder="optional" min="0" step="1"/>
        </div>
        <div class="full-width">
          <span class="field-label">Misc Notes</span>
          <input type="text" id="edit-miscNotes-${encoded}" value="${esc(d.miscNotes || '')}" placeholder="optional notes" maxlength="500"/>
        </div>
      </div>
      <button class="btn-sm" onclick="saveNonBudgetFields(${JSON.stringify(d.dealerName)})">Save Settings</button>
      <div id="editFeedback-${encoded}"></div>
    </div>

    <!-- (b) Monthly budget edit -->
    <div class="body-section">
      <div class="section-label">Change Monthly Budget</div>
      <div class="budget-edit-row">
        <div>
          <span class="field-label">New Budget ($)</span>
          <input type="number" id="budget-${encoded}" value="${d.monthlyBudget != null ? d.monthlyBudget : ''}" min="1" step="1" oninput="onBudgetInput(${JSON.stringify(d.dealerName)})"/>
        </div>
        <div style="flex:1">
          <span class="field-label">Note (required, min 5 chars)</span>
          <textarea id="note-${encoded}" placeholder="Why is this changing?" maxlength="500" oninput="onBudgetInput(${JSON.stringify(d.dealerName)})"></textarea>
        </div>
      </div>
      <div style="margin-top:8px">
        <button class="btn-sm" id="budgetSaveBtn-${encoded}" onclick="updateBudget(${JSON.stringify(d.dealerName)})" disabled>Save Budget</button>
      </div>
      <div id="budgetFeedback-${encoded}"></div>
    </div>

    <!-- (c) Budget history -->
    <div class="body-section">
      <div class="section-label">
        Budget History
        ${history == null ? `<button class="load-history-btn" onclick="loadAndShowHistory(${JSON.stringify(d.dealerName)})">Load</button>` : ''}
      </div>
      <div id="historyContent-${encoded}">${historyHtml}</div>
    </div>

    <!-- Footer: delete -->
    <div class="dealer-footer">
      <span></span>
      <button class="btn-danger" onclick="deleteDealer(${JSON.stringify(d.dealerName)})">Delete dealer</button>
    </div>

  </div>
</div>`;
}

function renderHistory(dealerName, history) {
  if (history == null) {
    return '<span class="history-empty">Click "Load" to fetch history.</span>';
  }
  if (history.length === 0) {
    return '<span class="history-empty">No budget changes recorded.</span>';
  }
  return `<div class="history-list">${history.map(h => {
    const oldStr = h.oldBudget != null ? fmt(h.oldBudget) : '(new)';
    return `<div class="history-entry">
      <span class="history-date">${esc(fmtDate(h.changedAt))}</span>
      <span class="history-arrow">·</span>
      <span class="history-budget">${esc(oldStr)} → ${esc(fmt(h.newBudget))}</span>
      <span class="history-arrow">·</span>
      <span class="history-by">${esc(h.changedBy || 'unknown')}</span>
      <span class="history-arrow">·</span>
      <span class="history-note">"${esc(h.note)}"</span>
    </div>`;
  }).join('')}</div>`;
}

// ── Toggle open/close ─────────────────────────────────────────────────────────

function toggleDealer(name) {
  const el = document.querySelector(`.dealer-item[data-dealer-name="${CSS.escape(name)}"]`);
  if (el) el.classList.toggle('open');
}

// ── Budget input live validation ──────────────────────────────────────────────

function onBudgetInput(dealerName) {
  const encoded = encodeURIComponent(dealerName);
  const budgetEl = document.getElementById(`budget-${encoded}`);
  const noteEl = document.getElementById(`note-${encoded}`);
  const btn = document.getElementById(`budgetSaveBtn-${encoded}`);
  if (!budgetEl || !noteEl || !btn) return;

  const budget = parseFloat(budgetEl.value);
  const note = noteEl.value.trim();
  const valid = Number.isFinite(budget) && budget > 0 && note.length >= 5;
  btn.disabled = !valid;
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

async function createDealer() {
  const name = document.getElementById('newDealerName').value.trim();
  const budget = parseFloat(document.getElementById('newMonthlyBudget').value);
  const pacingMode = document.getElementById('newPacingMode').value;
  const pacingCurveId = document.getElementById('newPacingCurveId').value || null;
  const miscNotes = document.getElementById('newMiscNotes').value.trim() || null;
  const fb = document.getElementById('createFeedback');

  const newBudgetVal = document.getElementById('newNewBudget').value;
  const usedBudgetVal = document.getElementById('newUsedBudget').value;
  const vlaBudgetVal = document.getElementById('newVlaBudget').value;
  const keywordBudgetVal = document.getElementById('newKeywordBudget').value;

  if (!name) { showFeedback(fb, 'Dealer name is required.', 'err'); return; }
  if (!Number.isFinite(budget) || budget <= 0) { showFeedback(fb, 'Monthly budget must be a positive number.', 'err'); return; }

  const body = {
    dealerName: name,
    monthlyBudget: budget,
    pacingMode,
    pacingCurveId,
    miscNotes,
    newBudget:     newBudgetVal     ? parseFloat(newBudgetVal)     : null,
    usedBudget:    usedBudgetVal    ? parseFloat(usedBudgetVal)    : null,
    vlaBudget:     vlaBudgetVal     ? parseFloat(vlaBudgetVal)     : null,
    keywordBudget: keywordBudgetVal ? parseFloat(keywordBudgetVal) : null,
  };

  try {
    const res = await fetch('/api/dealers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) { showFeedback(fb, data.error || 'Error creating dealer', 'err'); return; }

    // Clear form
    document.getElementById('newDealerName').value = '';
    document.getElementById('newMonthlyBudget').value = '';
    document.getElementById('newMiscNotes').value = '';
    document.getElementById('newNewBudget').value = '';
    document.getElementById('newUsedBudget').value = '';
    document.getElementById('newVlaBudget').value = '';
    document.getElementById('newKeywordBudget').value = '';
    document.getElementById('newPacingMode').value = 'one_click';
    document.getElementById('newPacingCurveId').value = '';

    showFeedback(fb, `Dealer "${name}" created.`, 'ok');
    await loadDealers();
    render();
  } catch (err) {
    showFeedback(fb, err.message, 'err');
  }
}

async function saveNonBudgetFields(dealerName) {
  const encoded = encodeURIComponent(dealerName);
  const fb = document.getElementById(`editFeedback-${encoded}`);

  const modeEl = document.getElementById(`edit-mode-${encoded}`);
  const curveEl = document.getElementById(`edit-curve-${encoded}`);
  const newBudgetEl = document.getElementById(`edit-newBudget-${encoded}`);
  const usedBudgetEl = document.getElementById(`edit-usedBudget-${encoded}`);
  const vlaBudgetEl = document.getElementById(`edit-vlaBudget-${encoded}`);
  const kwBudgetEl = document.getElementById(`edit-keywordBudget-${encoded}`);
  const notesEl = document.getElementById(`edit-miscNotes-${encoded}`);

  const body = {
    pacingMode:    modeEl   ? modeEl.value   : undefined,
    pacingCurveId: curveEl  ? (curveEl.value || null) : undefined,
    newBudget:     newBudgetEl    && newBudgetEl.value    ? parseFloat(newBudgetEl.value)    : null,
    usedBudget:    usedBudgetEl   && usedBudgetEl.value   ? parseFloat(usedBudgetEl.value)   : null,
    vlaBudget:     vlaBudgetEl    && vlaBudgetEl.value    ? parseFloat(vlaBudgetEl.value)    : null,
    keywordBudget: kwBudgetEl     && kwBudgetEl.value     ? parseFloat(kwBudgetEl.value)     : null,
    miscNotes:     notesEl  ? (notesEl.value.trim() || null) : undefined,
  };

  try {
    const res = await fetch(`/api/dealers/${encoded}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) { showFeedback(fb, data.error || 'Error saving', 'err'); return; }
    showFeedback(fb, 'Saved.', 'ok');
    await loadDealers();
    render();
  } catch (err) {
    showFeedback(fb, err.message, 'err');
  }
}

async function updateBudget(dealerName) {
  const encoded = encodeURIComponent(dealerName);
  const budgetEl = document.getElementById(`budget-${encoded}`);
  const noteEl = document.getElementById(`note-${encoded}`);
  const fb = document.getElementById(`budgetFeedback-${encoded}`);

  const newBudget = parseFloat(budgetEl.value);
  const note = noteEl.value.trim();

  if (!note || note.length < 5) { showFeedback(fb, 'Note required (min 5 characters).', 'err'); return; }
  if (!Number.isFinite(newBudget) || newBudget <= 0) { showFeedback(fb, 'Invalid budget.', 'err'); return; }

  try {
    const res = await fetch(`/api/dealers/${encoded}/budget`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ monthlyBudget: newBudget, note }),
    });
    const data = await res.json();
    if (!res.ok) { showFeedback(fb, data.error || 'Error updating budget', 'err'); return; }

    noteEl.value = '';
    showFeedback(fb, 'Budget updated.', 'ok');
    await loadDealers();
    await loadHistory(dealerName);
    render();
  } catch (err) {
    showFeedback(fb, err.message, 'err');
  }
}

async function loadHistory(dealerName) {
  try {
    const encoded = encodeURIComponent(dealerName);
    const res = await fetch(`/api/dealers/${encoded}/history`, { credentials: 'include' });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    state.history.set(dealerName, data.history || []);
  } catch (err) {
    state.history.set(dealerName, []);
  }
}

async function loadAndShowHistory(dealerName) {
  await loadHistory(dealerName);
  const encoded = encodeURIComponent(dealerName);
  const container = document.getElementById(`historyContent-${encoded}`);
  if (container) {
    container.innerHTML = renderHistory(dealerName, state.history.get(dealerName));
  }
}

async function deleteDealer(dealerName) {
  if (!confirm(`Delete ${dealerName}? This removes the dealer and its budget history.`)) return;

  const encoded = encodeURIComponent(dealerName);
  try {
    const res = await fetch(`/api/dealers/${encoded}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (!res.ok) {
      const data = await res.json();
      showGlobalFeedback(data.error || 'Error deleting dealer', 'err');
      return;
    }
    state.history.delete(dealerName);
    await loadDealers();
    render();
  } catch (err) {
    showGlobalFeedback(err.message, 'err');
  }
}

// ── Feedback helpers ──────────────────────────────────────────────────────────

function showFeedback(el, msg, type) {
  if (!el) return;
  el.innerHTML = `<div class="feedback ${type}">${esc(msg)}</div>`;
  setTimeout(() => { if (el) el.innerHTML = ''; }, 4000);
}

function showGlobalFeedback(msg, type) {
  const container = document.getElementById('dealerList');
  const div = document.createElement('div');
  div.className = `feedback ${type}`;
  div.textContent = msg;
  container.insertAdjacentElement('beforebegin', div);
  setTimeout(() => div.remove(), 5000);
}

// ── Import from Sheet ─────────────────────────────────────────────────────────

async function importFromSheet() {
  if (!confirm('Import all dealers from the Google Sheet into the DB?\n\nThis is idempotent — safe to run multiple times. Existing dealers are updated, new ones are added.')) return;
  const fb = document.getElementById('importFeedback');
  const res = await fetch('/api/dealers/import-from-sheet', { method: 'POST', credentials: 'include' });
  const data = await res.json();
  if (!res.ok) {
    showFeedback(fb, `Import failed: ${data.error || res.status}`, 'err');
    return;
  }
  showFeedback(
    fb,
    `Imported ${data.imported} dealer${data.imported !== 1 ? 's' : ''}. Created: ${data.created.length}. Updated: ${data.updated.length}. Skipped: ${data.skipped.length}.`,
    'ok'
  );
  await loadDealers();
  render();
}
window.importFromSheet = importFromSheet;

// ── Start ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);

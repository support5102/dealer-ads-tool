/* Dealer Groups Admin — client-side logic */

function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s || '');
  return d.innerHTML;
}

let state = {
  groups: [],      // [{ id, name, curveId, members: [dealerName, ...] }]
  dealers: [],     // dealer names from /api/pacing/all (best-effort)
};

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function init() {
  await Promise.all([loadGroups(), loadDealers()]);
  render();
  checkAuth();
}

async function loadGroups() {
  try {
    const res = await fetch('/api/groups', { credentials: 'include' });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    state.groups = data.groups || [];
  } catch (err) {
    showGlobalFeedback('Failed to load groups: ' + err.message, 'err');
  }
}

async function loadDealers() {
  try {
    const res = await fetch('/api/pacing/all', { credentials: 'include' });
    if (!res.ok) return; // non-fatal — dropdown just stays empty
    const data = await res.json();
    const accounts = data.accounts || [];
    state.dealers = accounts.map(a => a.dealerName).filter(Boolean).sort();
  } catch (_) {
    // non-fatal — pacing overview may require a session; skip silently
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
  const list = document.getElementById('groupList');
  const empty = document.getElementById('emptyState');
  const seedBar = document.getElementById('seedBar');

  if (state.groups.length === 0) {
    if (empty) empty.style.display = 'block';
    if (seedBar) seedBar.style.display = 'flex';
    if (list) list.innerHTML = '';
    return;
  }

  if (empty) empty.style.display = 'none';
  if (seedBar) seedBar.style.display = 'none';

  // Preserve open/close state across re-renders
  const openIds = new Set();
  list.querySelectorAll('.group-item.open').forEach(el => {
    openIds.add(Number(el.dataset.groupId));
  });

  list.innerHTML = state.groups.map(g => renderGroup(g, openIds.has(g.id))).join('');
}

function renderGroup(g, isOpen) {
  const memberCount = g.members.length;
  const openClass = isOpen ? ' open' : '';

  // Members chips
  const chipsHtml = memberCount === 0
    ? `<span class="no-members">No dealers assigned yet</span>`
    : g.members.map(m =>
        `<span class="member-chip">${esc(m)}<button onclick="removeMember(${g.id}, ${JSON.stringify(m)}, event)" title="Remove">&times;</button></span>`
      ).join('');

  // Add dealer dropdown — show dealers not already in this group
  const available = state.dealers.filter(d => !g.members.includes(d));
  const dealerOptions = available.length === 0
    ? `<option value="">-- no unassigned dealers --</option>`
    : `<option value="">Add dealer...</option>` +
      available.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join('');

  return `
<div class="group-item${openClass}" data-group-id="${g.id}">
  <div class="group-header" onclick="toggleGroup(${g.id})">
    <span class="group-chevron">&#9654;</span>
    <span class="group-name-badge">${esc(g.name)}</span>
    <span class="curve-badge">${esc(g.curveId)}</span>
    <span class="member-count">${memberCount} dealer${memberCount !== 1 ? 's' : ''}</span>
  </div>
  <div class="group-body">
    <div class="edit-row">
      <label>Name</label>
      <input type="text" id="editName-${g.id}" value="${esc(g.name)}" maxlength="80" style="width:200px"/>
      <label>Curve</label>
      <select id="editCurve-${g.id}">
        <option value="linear"${g.curveId === 'linear' ? ' selected' : ''}>linear</option>
        <option value="alanJay9505"${g.curveId === 'alanJay9505' ? ' selected' : ''}>alanJay9505</option>
      </select>
      <button class="btn-sm" onclick="updateGroup(${g.id})">Save</button>
    </div>

    <div class="members-label">Members</div>
    <div class="member-list" id="memberList-${g.id}">${chipsHtml}</div>

    <div class="add-dealer-row">
      <select id="addDealer-${g.id}" onchange="addMember(${g.id}, this)">
        ${dealerOptions}
      </select>
    </div>
    <div id="groupFeedback-${g.id}"></div>

    <div class="group-footer">
      <span></span>
      <button class="btn-danger" onclick="deleteGroup(${g.id}, ${JSON.stringify(g.name)})">Delete group</button>
    </div>
  </div>
</div>`;
}

// ── Toggle open/close ─────────────────────────────────────────────────────────

function toggleGroup(id) {
  const el = document.querySelector(`.group-item[data-group-id="${id}"]`);
  if (el) el.classList.toggle('open');
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

async function createGroup() {
  const name = document.getElementById('newGroupName').value.trim();
  const curveId = document.getElementById('newGroupCurve').value;
  const fb = document.getElementById('createFeedback');

  if (!name) { showFeedback(fb, 'Group name is required.', 'err'); return; }

  try {
    const res = await fetch('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name, curveId }),
    });
    const data = await res.json();
    if (!res.ok) { showFeedback(fb, data.error || 'Error creating group', 'err'); return; }
    document.getElementById('newGroupName').value = '';
    showFeedback(fb, `Group "${name}" created.`, 'ok');
    await loadGroups();
    render();
  } catch (err) {
    showFeedback(fb, err.message, 'err');
  }
}

async function updateGroup(id) {
  const nameEl = document.getElementById(`editName-${id}`);
  const curveEl = document.getElementById(`editCurve-${id}`);
  const fb = document.getElementById(`groupFeedback-${id}`);

  const name = nameEl ? nameEl.value.trim() : undefined;
  const curveId = curveEl ? curveEl.value : undefined;

  if (name === '') { showFeedback(fb, 'Name must not be blank.', 'err'); return; }

  try {
    const res = await fetch(`/api/groups/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name, curveId }),
    });
    const data = await res.json();
    if (!res.ok) { showFeedback(fb, data.error || 'Error updating group', 'err'); return; }
    showFeedback(fb, 'Saved.', 'ok');
    await loadGroups();
    render();
  } catch (err) {
    showFeedback(fb, err.message, 'err');
  }
}

async function deleteGroup(id, name) {
  if (!confirm(`Delete group "${name}"? This removes all dealer assignments.`)) return;

  try {
    const res = await fetch(`/api/groups/${id}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (!res.ok) {
      const data = await res.json();
      showGlobalFeedback(data.error || 'Error deleting group', 'err');
      return;
    }
    await loadGroups();
    render();
  } catch (err) {
    showGlobalFeedback(err.message, 'err');
  }
}

async function addMember(groupId, selectEl) {
  const dealerName = selectEl.value;
  if (!dealerName) return;
  const fb = document.getElementById(`groupFeedback-${groupId}`);

  try {
    const res = await fetch(`/api/groups/${groupId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ dealerName }),
    });
    const data = await res.json();
    if (!res.ok) { showFeedback(fb, data.error || 'Error adding dealer', 'err'); return; }
    selectEl.value = '';
    await loadGroups();
    render();
  } catch (err) {
    showFeedback(fb, err.message, 'err');
  }
}

async function removeMember(groupId, dealerName, event) {
  event.stopPropagation();
  const encoded = encodeURIComponent(dealerName);
  const fb = document.getElementById(`groupFeedback-${groupId}`);

  try {
    const res = await fetch(`/api/groups/${groupId}/members/${encoded}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (!res.ok) {
      const data = await res.json();
      showFeedback(fb, data.error || 'Error removing dealer', 'err');
      return;
    }
    await loadGroups();
    render();
  } catch (err) {
    showFeedback(fb, err.message, 'err');
  }
}

async function seedDefaults() {
  try {
    const res = await fetch('/api/groups/seed-defaults', {
      method: 'POST',
      credentials: 'include',
    });
    const data = await res.json();
    if (!res.ok) { showGlobalFeedback(data.error || 'Seed failed', 'err'); return; }
    if (data.seeded === 0) {
      showGlobalFeedback('Groups already exist — nothing to seed.', 'ok');
    } else {
      showGlobalFeedback(`Seeded ${data.seeded} default group(s).`, 'ok');
    }
    await loadGroups();
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
  const container = document.getElementById('groupList');
  const div = document.createElement('div');
  div.className = `feedback ${type}`;
  div.textContent = msg;
  container.insertAdjacentElement('beforebegin', div);
  setTimeout(() => div.remove(), 5000);
}

// ── Start ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);

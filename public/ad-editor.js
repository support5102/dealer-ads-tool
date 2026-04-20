/* Ad Editor — inline RSA editing from the Auditor page */

let editorAds = [];
let editorCustomerId = '';

function openAdEditor() {
  const sel = document.getElementById('accountSelect');
  if (!sel || !sel.value) return alert('Select an account first.');
  editorCustomerId = sel.value;
  document.getElementById('adEditorModal').style.display = 'block';
  document.getElementById('editAdsBtn').disabled = true;
  loadAds();
}

function closeAdEditor() {
  document.getElementById('adEditorModal').style.display = 'none';
  document.getElementById('editAdsBtn').disabled = false;
}

async function loadAds() {
  const el = document.getElementById('adEditorContent');
  el.innerHTML = '<p style="color:var(--text3);">Loading ads...</p>';
  try {
    const res = await fetch(`/api/ads?customerId=${editorCustomerId}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load ads');
    editorAds = data.ads;
    renderAdList();
  } catch (err) {
    el.innerHTML = `<p style="color:var(--red);">${esc(err.message)}</p>`;
  }
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function renderAdList() {
  const el = document.getElementById('adEditorContent');
  if (editorAds.length === 0) {
    el.innerHTML = '<p style="color:var(--text3);">No RSA ads found for this account.</p>';
    return;
  }

  // Group by campaign > ad group
  const groups = {};
  for (const ad of editorAds) {
    const key = `${ad.campaignName} > ${ad.adGroupName}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(ad);
  }

  let html = `<p style="color:var(--text3);margin-bottom:16px;">${editorAds.length} RSA ads found across ${Object.keys(groups).length} ad groups</p>`;

  for (const [group, ads] of Object.entries(groups)) {
    html += `<div style="margin-bottom:16px;border:1px solid var(--border);border-radius:8px;overflow:hidden;">`;
    html += `<div style="background:var(--bg3);padding:8px 12px;font-size:12px;color:var(--text2);font-weight:600;">${esc(group)}</div>`;
    for (const ad of ads) {
      const statusColor = ad.status === 'ENABLED' ? 'var(--green)' : 'var(--text3)';
      const previewHeadlines = ad.headlines.slice(0, 3).map(h => esc(h.text)).join(' | ');
      html += `
        <div style="padding:10px 12px;border-top:1px solid var(--border2);display:flex;align-items:center;gap:12px;">
          <span style="color:${statusColor};font-size:11px;min-width:60px;">${esc(ad.status)}</span>
          <span style="flex:1;font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(previewHeadlines)}">${previewHeadlines}</span>
          <span style="font-size:11px;color:var(--text3);">${ad.headlines.length}H / ${ad.descriptions.length}D</span>
          <button data-edit-ad="${esc(ad.adId)}" style="padding:4px 12px;border-radius:4px;border:1px solid var(--blue);background:none;color:var(--blue);font-size:11px;cursor:pointer;">Edit</button>
        </div>`;
    }
    html += `</div>`;
  }

  el.innerHTML = html;

  // Attach edit handlers via event delegation (avoids XSS from inline onclick)
  el.querySelectorAll('[data-edit-ad]').forEach(btn => {
    btn.addEventListener('click', () => openAdEditForm(btn.dataset.editAd));
  });
}

function openAdEditForm(adId) {
  const ad = editorAds.find(a => a.adId === adId);
  if (!ad) return;

  const el = document.getElementById('adEditorContent');

  // Pad to 15 headlines and 4 descriptions (Google Ads max)
  const headlines = [...ad.headlines];
  while (headlines.length < 15) headlines.push({ text: '', pinnedField: null });
  const descriptions = [...ad.descriptions];
  while (descriptions.length < 4) descriptions.push({ text: '', pinnedField: null });

  let html = `
    <div style="margin-bottom:12px;">
      <button onclick="renderAdList()" style="background:none;border:none;color:var(--blue);cursor:pointer;font-size:13px;">&larr; Back to ad list</button>
    </div>
    <div style="font-size:14px;color:var(--text);margin-bottom:4px;font-weight:600;">${esc(ad.campaignName)} &gt; ${esc(ad.adGroupName)}</div>
    <div style="font-size:11px;color:var(--text3);margin-bottom:16px;">Ad ID: ${esc(ad.adId)} &middot; Status: ${esc(ad.status)}</div>

    <div style="font-size:13px;color:var(--text2);font-weight:600;margin-bottom:8px;">Headlines (min 3, max 15, each max 30 chars)</div>
  `;

  for (let i = 0; i < headlines.length; i++) {
    const h = headlines[i];
    const required = i < 3 ? ' *' : '';
    const pinOpts = ['', 'HEADLINE_1', 'HEADLINE_2', 'HEADLINE_3'].map(v => {
      const sel = (h.pinnedField === v || (!h.pinnedField && v === '')) ? ' selected' : '';
      const label = v ? v.replace('HEADLINE_', 'Pin ') : 'No pin';
      return `<option value="${v}"${sel}>${label}</option>`;
    }).join('');

    html += `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">
        <span style="min-width:24px;font-size:11px;color:var(--text3);">${i + 1}${required}</span>
        <input type="text" id="h_${i}" value="${esc(h.text)}" maxlength="30" placeholder="Headline ${i + 1}"
          oninput="updateCharCount(this,'hc_${i}',30)"
          style="flex:1;padding:6px 10px;background:var(--bg3);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:13px;font-family:'DM Mono',monospace;"/>
        <span id="hc_${i}" style="min-width:36px;font-size:11px;color:var(--text3);">${h.text.length}/30</span>
        <select id="hp_${i}" style="padding:4px;background:var(--bg3);border:1px solid var(--border);border-radius:4px;color:var(--text2);font-size:11px;">${pinOpts}</select>
      </div>`;
  }

  html += `<div style="font-size:13px;color:var(--text2);font-weight:600;margin:16px 0 8px;">Descriptions (min 2, max 4, each max 90 chars)</div>`;

  for (let i = 0; i < descriptions.length; i++) {
    const d = descriptions[i];
    const required = i < 2 ? ' *' : '';
    const pinOpts = ['', 'DESCRIPTION_1', 'DESCRIPTION_2'].map(v => {
      const sel = (d.pinnedField === v || (!d.pinnedField && v === '')) ? ' selected' : '';
      const label = v ? v.replace('DESCRIPTION_', 'Pin ') : 'No pin';
      return `<option value="${v}"${sel}>${label}</option>`;
    }).join('');

    html += `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">
        <span style="min-width:24px;font-size:11px;color:var(--text3);">${i + 1}${required}</span>
        <textarea id="d_${i}" maxlength="90" rows="2" placeholder="Description ${i + 1}"
          oninput="updateCharCount(this,'dc_${i}',90)"
          style="flex:1;padding:6px 10px;background:var(--bg3);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:13px;font-family:'DM Mono',monospace;resize:vertical;">${esc(d.text)}</textarea>
        <span id="dc_${i}" style="min-width:36px;font-size:11px;color:var(--text3);">${d.text.length}/90</span>
        <select id="dp_${i}" style="padding:4px;background:var(--bg3);border:1px solid var(--border);border-radius:4px;color:var(--text2);font-size:11px;">${pinOpts}</select>
      </div>`;
  }

  // Store current ad context for the save handler
  window._editingAd = { adId: ad.adId, campaignName: ad.campaignName, adGroupName: ad.adGroupName };

  html += `
    <div style="margin-top:20px;display:flex;gap:12px;">
      <button id="saveAdBtn"
        style="padding:8px 24px;border-radius:6px;border:none;background:var(--green);color:#000;font-weight:600;font-size:13px;cursor:pointer;">
        Save Changes
      </button>
      <button id="cancelAdBtn" style="padding:8px 24px;border-radius:6px;border:1px solid var(--border);background:none;color:var(--text2);font-size:13px;cursor:pointer;">
        Cancel
      </button>
    </div>
    <div id="saveStatus" style="margin-top:12px;font-size:13px;"></div>
  `;

  el.innerHTML = html;

  // Attach event listeners (avoids XSS from inline onclick with user data)
  document.getElementById('saveAdBtn').addEventListener('click', () => {
    const ctx = window._editingAd;
    if (ctx) saveAdChanges(ctx.adId, ctx.campaignName, ctx.adGroupName);
  });
  document.getElementById('cancelAdBtn').addEventListener('click', renderAdList);
}

function updateCharCount(input, countId, max) {
  const el = document.getElementById(countId);
  if (el) {
    el.textContent = `${input.value.length}/${max}`;
    el.style.color = input.value.length > max ? 'var(--red)' : 'var(--text3)';
  }
}

async function saveAdChanges(adId, campaignName, adGroupName) {
  const btn = document.getElementById('saveAdBtn');
  const status = document.getElementById('saveStatus');
  btn.disabled = true;
  btn.textContent = 'Saving...';
  status.innerHTML = '';

  // Collect headlines (skip empty)
  const headlines = [];
  for (let i = 0; i < 15; i++) {
    const input = document.getElementById(`h_${i}`);
    const pin = document.getElementById(`hp_${i}`);
    if (input && input.value.trim()) {
      const h = { text: input.value.trim() };
      if (pin && pin.value) h.pinnedField = pin.value;
      headlines.push(h);
    }
  }

  // Collect descriptions (skip empty)
  const descriptions = [];
  for (let i = 0; i < 4; i++) {
    const input = document.getElementById(`d_${i}`);
    const pin = document.getElementById(`dp_${i}`);
    if (input && input.value.trim()) {
      const d = { text: input.value.trim() };
      if (pin && pin.value) d.pinnedField = pin.value;
      descriptions.push(d);
    }
  }

  // Validate
  if (headlines.length < 3) {
    status.innerHTML = '<span style="color:var(--red);">At least 3 headlines required.</span>';
    btn.disabled = false;
    btn.textContent = 'Save Changes';
    return;
  }
  if (descriptions.length < 2) {
    status.innerHTML = '<span style="color:var(--red);">At least 2 descriptions required.</span>';
    btn.disabled = false;
    btn.textContent = 'Save Changes';
    return;
  }

  // Find the original ad to get finalUrls
  const origAd = editorAds.find(a => a.adId === adId);
  const finalUrls = origAd ? origAd.finalUrls : [];

  try {
    const res = await fetch('/api/ads/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerId: editorCustomerId,
        campaignName,
        adGroupName,
        adId,
        headlines,
        descriptions,
        finalUrls,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save');
    status.innerHTML = `<span style="color:var(--green);">Saved! ${esc(data.message)}</span>`;
    btn.textContent = 'Saved';
    // Reload ads after a moment
    setTimeout(() => loadAds(), 2000);
  } catch (err) {
    status.innerHTML = `<span style="color:var(--red);">Error: ${esc(err.message)}</span>`;
    btn.disabled = false;
    btn.textContent = 'Save Changes';
  }
}

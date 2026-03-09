require('dotenv').config();
const express    = require('express');
const session    = require('express-session');
const axios      = require('axios');
const cors       = require('cors');
const path       = require('path');
const { GoogleAdsApi } = require('google-ads-api');

const app = express();
app.use(express.json());
app.use(cors());
// ─────────────────────────────────────────────────────────────
// SERVE FRONTEND — HTML embedded directly, no public folder needed
// ─────────────────────────────────────────────────────────────
const FRONTEND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Dealer Ads Manager</title>
  <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@400;600;700;800&display=swap" rel="stylesheet"/>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:        #050b14;
      --bg2:       #060d18;
      --bg3:       #0a1220;
      --border:    #1e2d45;
      --border2:   #0d1629;
      --text:      #e2e8f0;
      --text2:     #94a3b8;
      --text3:     #475569;
      --text4:     #334155;
      --blue:      #3b82f6;
      --blue-dark: #1d4ed8;
      --green:     #4ade80;
      --orange:    #fb923c;
      --red:       #f87171;
      --purple:    #a78bfa;
    }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'DM Mono', monospace;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* ── HEADER ── */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 28px;
      border-bottom: 1px solid var(--border2);
      background: rgba(255,255,255,.015);
      flex-shrink: 0;
    }
    .logo {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .logo-icon {
      width: 34px;
      height: 34px;
      background: linear-gradient(135deg, #1d4ed8, #7c3aed);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
    }
    .logo-text {
      font-family: 'Syne', sans-serif;
      font-weight: 800;
      font-size: 16px;
      color: #f1f5f9;
      letter-spacing: -.3px;
    }
    .logo-sub {
      font-size: 10px;
      color: var(--text4);
      margin-top: 1px;
    }
    .header-right {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .connect-btn {
      background: linear-gradient(135deg, #0f4c9e, #1d4ed8);
      border: none;
      color: white;
      padding: 8px 20px;
      font-size: 13px;
      font-family: 'Syne', sans-serif;
      font-weight: 700;
      border-radius: 7px;
      cursor: pointer;
      transition: all .2s;
      box-shadow: 0 0 20px rgba(29,78,216,.3);
    }
    .connect-btn:hover {
      background: linear-gradient(135deg, #1d6fd8, #3b82f6);
      transform: translateY(-1px);
    }
    .connected-badge {
      display: flex;
      align-items: center;
      gap: 7px;
      background: #071a0e;
      border: 1px solid #166534;
      border-radius: 20px;
      padding: 5px 14px;
      font-size: 12px;
      color: var(--green);
    }
    .pulse-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--green);
      animation: pulseDot 2s ease-in-out infinite;
    }
    @keyframes pulseDot {
      0%,100% { opacity:1; transform:scale(1); }
      50%      { opacity:.4; transform:scale(.65); }
    }
    .logout-btn {
      background: none;
      border: 1px solid var(--border);
      color: var(--text3);
      padding: 6px 14px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 11px;
      font-family: 'DM Mono', monospace;
      transition: all .15s;
    }
    .logout-btn:hover { color: var(--text2); border-color: #2d4a6e; }

    /* ── MAIN LAYOUT ── */
    .main {
      display: flex;
      flex: 1;
      overflow: hidden;
      height: calc(100vh - 61px);
    }

    /* ── SIDEBAR ── */
    .sidebar {
      width: 280px;
      flex-shrink: 0;
      border-right: 1px solid var(--border2);
      background: var(--bg2);
      display: flex;
      flex-direction: column;
      overflow-y: auto;
    }
    .sidebar-section {
      padding: 16px 16px 8px;
      border-bottom: 1px solid var(--border2);
    }
    .sidebar-label {
      font-size: 10px;
      color: var(--text4);
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 8px;
    }

    /* Account selector */
    .account-select {
      width: 100%;
      background: var(--bg3);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 9px 12px;
      border-radius: 7px;
      font-size: 12.5px;
      font-family: 'DM Mono', monospace;
      cursor: pointer;
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath fill='%2364748b' d='M1 1l5 5 5-5'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 12px center;
    }
    .account-select:focus { outline: none; border-color: var(--blue); }

    /* Account tree */
    .tree { padding: 8px 0; flex: 1; }
    .tree-campaign {
      border-bottom: 1px solid var(--border2);
    }
    .tree-camp-header {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 7px 16px;
      cursor: pointer;
      transition: background .1s;
      font-size: 12px;
    }
    .tree-camp-header:hover { background: rgba(255,255,255,.025); }
    .tree-camp-header.open { background: #0a1628; }
    .tree-arrow { color: var(--text4); font-size: 9px; width: 10px; flex-shrink: 0; }
    .tree-camp-name { color: var(--text); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .status-dot {
      width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
    }
    .status-dot.enabled  { background: var(--green); }
    .status-dot.paused   { background: var(--orange); }
    .status-dot.removed  { background: var(--red); }
    .tree-budget { font-size: 10px; color: var(--text4); flex-shrink: 0; }

    .tree-ag {
      background: #040a12;
      border-bottom: 1px solid #080f1a;
    }
    .tree-ag-header {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 5px 16px 5px 32px;
      cursor: pointer;
      font-size: 11.5px;
      transition: background .1s;
    }
    .tree-ag-header:hover { background: rgba(255,255,255,.02); }
    .tree-ag-name { color: var(--text2); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tree-kw-count { font-size: 10px; color: var(--text4); flex-shrink: 0; }

    .tree-keywords { background: #020609; }
    .tree-kw {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 4px 16px 4px 52px;
      border-bottom: 1px solid #06090f;
      font-size: 11px;
    }
    .match-badge {
      font-size: 9px;
      padding: 1px 5px;
      border-radius: 3px;
      flex-shrink: 0;
    }
    .match-badge.exact   { background: #1a2e50; color: #60a5fa; border: 1px solid #1d4ed8; }
    .match-badge.phrase  { background: #2d1a50; color: #a78bfa; border: 1px solid #6d28d9; }
    .match-badge.broad   { background: #1a2a1a; color: #6b7280; border: 1px solid #374151; }
    .kw-text { color: #cbd5e1; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* ── CONTENT AREA ── */
    .content {
      flex: 1;
      overflow-y: auto;
      padding: 28px;
    }

    /* Not connected state */
    .not-connected {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      text-align: center;
      gap: 16px;
    }
    .not-connected-icon {
      width: 64px; height: 64px;
      background: var(--bg3);
      border: 1px solid var(--border);
      border-radius: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 28px;
    }
    .not-connected h2 {
      font-family: 'Syne', sans-serif;
      font-weight: 700;
      font-size: 20px;
      color: #f1f5f9;
    }
    .not-connected p {
      font-size: 13px;
      color: var(--text3);
      max-width: 340px;
      line-height: 1.6;
    }

    /* Task area */
    .task-area { max-width: 780px; }
    .section-title {
      font-size: 11px;
      color: var(--text4);
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 10px;
    }

    .task-box {
      background: var(--bg2);
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow: hidden;
      margin-bottom: 14px;
    }
    .task-box-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 16px;
      background: var(--bg3);
      border-bottom: 1px solid var(--border2);
    }
    .task-box-dots {
      display: flex;
      gap: 5px;
    }
    .dot { width: 9px; height: 9px; border-radius: 50%; }
    textarea {
      width: 100%;
      min-height: 180px;
      background: transparent;
      border: none;
      color: var(--text);
      font-size: 13.5px;
      line-height: 1.75;
      padding: 16px 18px;
      resize: vertical;
      font-family: 'DM Mono', monospace;
    }
    textarea:focus { outline: none; }
    textarea::placeholder { color: var(--text4); }

    .btn-row {
      display: flex;
      gap: 10px;
      align-items: center;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }
    .btn-primary {
      background: linear-gradient(135deg, #0f4c9e, #1d4ed8);
      border: none; color: white;
      padding: 12px 26px;
      font-size: 14px;
      font-family: 'Syne', sans-serif;
      font-weight: 700;
      border-radius: 8px;
      cursor: pointer;
      transition: all .2s;
      box-shadow: 0 0 20px rgba(29,78,216,.3);
    }
    .btn-primary:hover:not(:disabled) {
      background: linear-gradient(135deg, #1d6fd8, #3b82f6);
      transform: translateY(-1px);
    }
    .btn-primary:disabled { opacity: .4; cursor: not-allowed; transform: none; }
    .btn-secondary {
      background: none;
      border: 1px solid var(--border);
      color: var(--text3);
      padding: 10px 18px;
      border-radius: 7px;
      cursor: pointer;
      font-size: 12.5px;
      font-family: 'DM Mono', monospace;
      transition: all .15s;
    }
    .btn-secondary:hover { border-color: #2d4a6e; color: var(--text2); }

    /* Plan card */
    .plan-card {
      background: var(--bg2);
      border: 1px solid #1e3a5f;
      border-radius: 10px;
      overflow: hidden;
      margin-bottom: 16px;
      animation: slideUp .3s ease-out;
    }
    @keyframes slideUp {
      from { opacity:0; transform:translateY(10px); }
      to   { opacity:1; transform:translateY(0); }
    }
    .plan-header {
      padding: 14px 18px;
      background: #0a1628;
      border-bottom: 1px solid var(--border2);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .plan-summary {
      font-family: 'Syne', sans-serif;
      font-size: 14px;
      color: #93c5fd;
      font-weight: 500;
      flex: 1;
    }
    .plan-count {
      font-size: 11px;
      color: var(--text4);
      flex-shrink: 0;
    }

    .change-list { padding: 8px 0; }
    .change-item {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 10px 18px;
      border-bottom: 1px solid var(--border2);
      font-size: 12.5px;
    }
    .change-item:last-child { border-bottom: none; }
    .change-type-badge {
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 4px;
      flex-shrink: 0;
      font-weight: 500;
      margin-top: 1px;
    }
    .change-desc { color: var(--text2); line-height: 1.5; }
    .change-campaign { color: var(--text3); font-size: 11px; margin-top: 2px; }

    .warnings-box {
      background: #2a1f0d;
      border: 1px solid #92400e;
      border-radius: 8px;
      padding: 12px 16px;
      margin-bottom: 14px;
    }
    .warnings-title {
      font-size: 11px;
      color: #f59e0b;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 6px;
    }
    .warning-item {
      font-size: 12.5px;
      color: #fbbf24;
      margin-top: 4px;
    }

    /* Apply buttons */
    .apply-row {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
    }
    .btn-dryrun {
      background: #1a2e50;
      border: 1px solid #1d4ed8;
      color: #93c5fd;
      padding: 11px 22px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 13px;
      font-family: 'Syne', sans-serif;
      font-weight: 600;
      transition: all .2s;
    }
    .btn-dryrun:hover { background: #1e3a6a; }
    .btn-apply {
      background: linear-gradient(135deg, #065f46, #059669);
      border: none;
      color: white;
      padding: 11px 26px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 13px;
      font-family: 'Syne', sans-serif;
      font-weight: 700;
      transition: all .2s;
      box-shadow: 0 0 20px rgba(5,150,105,.3);
    }
    .btn-apply:hover { background: linear-gradient(135deg, #047857, #10b981); transform: translateY(-1px); }
    .btn-apply:disabled { opacity: .4; cursor: not-allowed; transform: none; }

    /* Results */
    .results-card {
      background: var(--bg2);
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow: hidden;
      margin-bottom: 14px;
      animation: slideUp .3s ease-out;
    }
    .results-header {
      padding: 12px 18px;
      background: var(--bg3);
      border-bottom: 1px solid var(--border2);
      font-size: 12px;
      color: var(--text3);
    }
    .result-item {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 9px 18px;
      border-bottom: 1px solid var(--border2);
      font-size: 12.5px;
    }
    .result-item:last-child { border-bottom: none; }
    .result-icon { flex-shrink: 0; font-size: 13px; }
    .result-text { color: var(--text2); }

    /* Loading spinner */
    .spinner {
      width: 15px; height: 15px;
      border: 2px solid rgba(255,255,255,.2);
      border-top-color: white;
      border-radius: 50%;
      animation: spin .7s linear infinite;
      display: inline-block;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Empty state for account tree */
    .tree-empty {
      padding: 20px 16px;
      font-size: 12px;
      color: var(--text4);
      line-height: 1.6;
      text-align: center;
    }

    /* No account selected */
    .select-account-prompt {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      gap: 12px;
      text-align: center;
    }
    .select-account-prompt p {
      font-size: 13px;
      color: var(--text3);
      max-width: 300px;
      line-height: 1.6;
    }

    /* Toast */
    .toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: #071a0e;
      border: 1px solid #166534;
      color: var(--green);
      padding: 12px 18px;
      border-radius: 8px;
      font-size: 13px;
      animation: toastIn .3s ease-out;
      z-index: 1000;
    }
    @keyframes toastIn {
      from { opacity:0; transform:translateY(10px); }
      to   { opacity:1; transform:translateY(0); }
    }

    /* Scrollbar */
    ::-webkit-scrollbar { width: 5px; height: 5px; }
    ::-webkit-scrollbar-track { background: var(--bg); }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  </style>
</head>
<body>

<!-- HEADER -->
<div class="header">
  <div class="logo">
    <div class="logo-icon">⚡</div>
    <div>
      <div class="logo-text">Dealer Ads Manager</div>
      <div class="logo-sub">Google Ads API · MCC Connected</div>
    </div>
  </div>
  <div class="header-right" id="headerRight">
    <button class="connect-btn" onclick="connectGoogle()">🔗 Connect Google Ads</button>
  </div>
</div>

<!-- MAIN -->
<div class="main">

  <!-- SIDEBAR -->
  <div class="sidebar">
    <div class="sidebar-section">
      <div class="sidebar-label">Account</div>
      <select class="account-select" id="accountSelect" onchange="selectAccount(this.value)" disabled>
        <option value="">— Connect Google Ads first —</option>
      </select>
    </div>
    <div class="tree" id="accountTree">
      <div class="tree-empty">Connect your Google Ads account to see your campaigns here.</div>
    </div>
  </div>

  <!-- CONTENT -->
  <div class="content" id="content">
    <div class="not-connected" id="notConnected">
      <div class="not-connected-icon">🔗</div>
      <h2>Connect Your Google Ads Account</h2>
      <p>Click "Connect Google Ads" above to sign in. The tool will load all your dealer accounts from your MCC.</p>
      <button class="connect-btn" onclick="connectGoogle()">Connect Google Ads</button>
    </div>

    <div class="task-area" id="taskArea" style="display:none">
      <div class="section-title">Freshdesk Task</div>

      <div class="task-box">
        <div class="task-box-header">
          <div class="task-box-dots">
            <div class="dot" style="background:#f87171"></div>
            <div class="dot" style="background:#fbbf24"></div>
            <div class="dot" style="background:#4ade80"></div>
          </div>
          <span style="font-size:11px;color:#334155">Paste task — any format, plain English</span>
          <span style="font-size:10px;color:#1e3a5f">⌘↩ to analyse</span>
        </div>
        <textarea id="taskInput"
          placeholder="Paste your Freshdesk task here...

Examples:
• Pause Campaign: Honda Civic - Search Florida
• Increase budget to $200/day on Toyota Trucks campaign
• Add negative keyword [free cars] to all campaigns
• Exclude 20mi radius around (30.064250,-90.069620) from main campaigns, create new radius campaign with 30% budget
• Pause all keywords with CPC over $8 in Used Inventory ad group"></textarea>
      </div>

      <div class="btn-row">
        <button class="btn-primary" id="analyseBtn" onclick="analyseTask()" disabled>
          🔍 Analyse Task
        </button>
        <button class="btn-secondary" onclick="clearTask()">Clear</button>
        <span style="font-size:11px;color:#334155;margin-left:4px" id="accountLabel"></span>
      </div>

      <!-- Plan appears here -->
      <div id="planArea"></div>
    </div>
  </div>

</div>

<!-- TOAST -->
<div class="toast" id="toast" style="display:none"></div>

<script>
// ─────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────
let state = {
  connected:   false,
  accounts:    [],
  selectedId:  null,
  selectedName: null,
  structure:   null,
  plan:        null,
  loadingAccounts: false,
  loadingStructure: false,
  loadingTask: false,
  applyingChanges: false,
};

// ─────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  // Check if we just came back from OAuth
  const params = new URLSearchParams(window.location.search);
  if (params.get('connected')) {
    window.history.replaceState({}, '', '/');
    showToast('✅ Google Ads connected!');
  }
  if (params.get('error')) {
    showToast('❌ Connection failed: ' + params.get('error'), 'error');
    window.history.replaceState({}, '', '/');
  }

  await checkAuthStatus();
});

// ─────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────
async function checkAuthStatus() {
  try {
    const res  = await fetch('/api/auth/status');
    const data = await res.json();
    if (data.connected) {
      state.connected = true;
      showConnectedState();
      await loadAccounts();
    }
  } catch(e) {
    console.error('Auth check failed:', e);
  }
}

function connectGoogle() {
  window.location.href = '/auth/google';
}

function logout() {
  window.location.href = '/auth/logout';
}

function showConnectedState() {
  const hr = document.getElementById('headerRight');
  hr.innerHTML = \`
    <div class="connected-badge">
      <div class="pulse-dot"></div>
      Google Ads Connected
    </div>
    <button class="logout-btn" onclick="logout()">Disconnect</button>
  \`;
  document.getElementById('notConnected').style.display  = 'none';
  document.getElementById('taskArea').style.display      = 'block';
}

// ─────────────────────────────────────────────────────────────
// LOAD ACCOUNTS
// ─────────────────────────────────────────────────────────────
async function loadAccounts() {
  const sel = document.getElementById('accountSelect');
  sel.disabled = true;
  sel.innerHTML = '<option>Loading accounts...</option>';

  try {
    const res  = await fetch('/api/accounts');
    const data = await res.json();

    if (data.error) throw new Error(data.error);

    state.accounts = data.accounts || [];
    sel.innerHTML  = '<option value="">— Select a dealer account —</option>';

    state.accounts.forEach(acc => {
      const opt  = document.createElement('option');
      opt.value  = acc.id;
      opt.text   = (acc.isManager ? '🏢 ' : '📍 ') + acc.name;
      if (acc.currency) opt.text += \` (\${acc.currency})\`;
      sel.appendChild(opt);
    });

    sel.disabled = false;

    if (state.accounts.length === 0) {
      sel.innerHTML = '<option>No accounts found</option>';
    }
  } catch (err) {
    sel.innerHTML = '<option>Error loading accounts</option>';
    showToast('❌ ' + err.message, 'error');
  }
}

// ─────────────────────────────────────────────────────────────
// SELECT ACCOUNT → load structure + build tree
// ─────────────────────────────────────────────────────────────
async function selectAccount(id) {
  if (!id) {
    state.selectedId   = null;
    state.selectedName = null;
    state.structure    = null;
    state.plan         = null;
    document.getElementById('accountTree').innerHTML = '<div class="tree-empty">Select an account to see campaigns.</div>';
    document.getElementById('analyseBtn').disabled   = true;
    document.getElementById('accountLabel').textContent = '';
    document.getElementById('planArea').innerHTML    = '';
    return;
  }

  const acc = state.accounts.find(a => a.id === id);
  state.selectedId   = id;
  state.selectedName = acc?.name || id;
  state.plan         = null;
  document.getElementById('planArea').innerHTML = '';
  document.getElementById('accountLabel').textContent = '→ ' + state.selectedName;
  document.getElementById('analyseBtn').disabled = true;

  const tree = document.getElementById('accountTree');
  tree.innerHTML = '<div class="tree-empty" style="color:#334155">Loading account structure...</div>';

  try {
    const res  = await fetch(\`/api/account/\${id}/structure\`);
    const data = await res.json();

    if (data.error) throw new Error(data.error);

    state.structure = data;
    renderTree(data.campaigns);
    document.getElementById('analyseBtn').disabled = false;
    showToast(\`📂 Loaded \${data.stats.campaigns} campaigns · \${data.stats.adGroups} ad groups · \${data.stats.keywords} keywords\`);
  } catch (err) {
    tree.innerHTML = \`<div class="tree-empty" style="color:#f87171">Error: \${err.message}</div>\`;
    showToast('❌ ' + err.message, 'error');
  }
}

// ─────────────────────────────────────────────────────────────
// RENDER ACCOUNT TREE
// ─────────────────────────────────────────────────────────────
function renderTree(campaigns) {
  const tree = document.getElementById('accountTree');
  if (!campaigns || campaigns.length === 0) {
    tree.innerHTML = '<div class="tree-empty">No campaigns found.</div>';
    return;
  }

  tree.innerHTML = '';
  campaigns.forEach(camp => {
    const campDiv = document.createElement('div');
    campDiv.className = 'tree-campaign';

    const statusClass = (String(camp.status || "")).toLowerCase().replace("campaign_status_","");
    campDiv.innerHTML = \`
      <div class="tree-camp-header" onclick="toggleCampaign(this)" data-camp="\${camp.name}">
        <span class="tree-arrow">▶</span>
        <div class="status-dot \${statusClass}"></div>
        <span class="tree-camp-name">\${camp.name}</span>
        <span class="tree-budget">$\${camp.budget}</span>
      </div>
      <div class="tree-ag-list" style="display:none">
        \${camp.adGroups.map(ag => \`
          <div class="tree-ag">
            <div class="tree-ag-header" onclick="toggleAG(this)" data-ag="\${ag.name}">
              <span class="tree-arrow">▶</span>
              <div class="status-dot \${ag.status.toLowerCase()}"></div>
              <span class="tree-ag-name">📁 \${ag.name}</span>
              <span class="tree-kw-count">🔑\${ag.keywords.length}</span>
            </div>
            <div class="tree-keywords" style="display:none">
              \${ag.keywords.slice(0,30).map(kw => {
                const match = String(kw.match||"").toLowerCase().replace("keyword_match_type_","").replace(/_/g,"");
                const matchShort = match === 'exact' ? 'Exact' : match === 'phrase' ? 'Phrase' : 'Broad';
                return \`<div class="tree-kw">
                  <span class="match-badge \${match}">\${matchShort}</span>
                  \${kw.negative ? '<span style="color:#f87171;font-size:9px">NEG</span>' : ''}
                  <span class="kw-text">\${kw.text}</span>
                  \${kw.bid ? \`<span style="font-size:10px;color:#475569">$\${kw.bid}</span>\` : ''}
                </div>\`;
              }).join('')}
              \${ag.keywords.length > 30 ? \`<div class="tree-kw" style="color:#334155;font-size:10px">...and \${ag.keywords.length - 30} more</div>\` : ''}
            </div>
          </div>
        \`).join('')}
        \${camp.adGroups.length === 0 ? '<div style="padding:8px 32px;font-size:11px;color:#334155">(no ad groups)</div>' : ''}
      </div>
    \`;
    tree.appendChild(campDiv);
  });
}

function toggleCampaign(el) {
  const list = el.nextElementSibling;
  const arrow = el.querySelector('.tree-arrow');
  const open  = list.style.display !== 'none';
  list.style.display = open ? 'none' : 'block';
  arrow.textContent  = open ? '▶' : '▼';
  el.classList.toggle('open', !open);
}

function toggleAG(el) {
  const list  = el.nextElementSibling;
  const arrow = el.querySelector('.tree-arrow');
  const open  = list.style.display !== 'none';
  list.style.display = open ? 'none' : 'block';
  arrow.textContent  = open ? '▶' : '▼';
}

// ─────────────────────────────────────────────────────────────
// ANALYSE TASK → call Claude via our backend
// ─────────────────────────────────────────────────────────────
async function analyseTask() {
  const task = document.getElementById('taskInput').value.trim();
  if (!task) return;
  if (!state.selectedId) { showToast('Select an account first', 'error'); return; }

  document.getElementById('analyseBtn').disabled = true;
  document.getElementById('analyseBtn').innerHTML = '<span class="spinner"></span> Analysing...';
  document.getElementById('planArea').innerHTML = '';

  try {
    const res  = await fetch('/api/parse-task', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task,
        customerId:       state.selectedId,
        accountName:      state.selectedName,
        accountStructure: state.structure,
      })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    state.plan = data;
    renderPlan(data);
  } catch (err) {
    showToast('❌ ' + err.message, 'error');
  } finally {
    document.getElementById('analyseBtn').disabled = false;
    document.getElementById('analyseBtn').innerHTML = '🔍 Analyse Task';
  }
}

document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') analyseTask();
});

// ─────────────────────────────────────────────────────────────
// RENDER PLAN
// ─────────────────────────────────────────────────────────────
const TYPE_META = {
  pause_campaign:       { label:'Pause Campaign',    color:'#fb923c', bg:'#3d2a0d', border:'#92400e' },
  enable_campaign:      { label:'Enable Campaign',   color:'#4ade80', bg:'#0d3d1f', border:'#166534' },
  update_budget:        { label:'Budget Change',     color:'#60a5fa', bg:'#1a2e50', border:'#1d4ed8' },
  pause_ad_group:       { label:'Pause Ad Group',    color:'#fb923c', bg:'#3d2a0d', border:'#92400e' },
  enable_ad_group:      { label:'Enable Ad Group',   color:'#4ade80', bg:'#0d3d1f', border:'#166534' },
  pause_keyword:        { label:'Pause Keyword',     color:'#fb923c', bg:'#3d2a0d', border:'#92400e' },
  enable_keyword:       { label:'Enable Keyword',    color:'#4ade80', bg:'#0d3d1f', border:'#166534' },
  add_keyword:          { label:'Add Keyword',       color:'#34d399', bg:'#0d3d2a', border:'#065f46' },
  add_negative_keyword: { label:'Negative Keyword',  color:'#f87171', bg:'#3d0d0d', border:'#991b1b' },
  exclude_radius:       { label:'Exclude Radius',    color:'#f472b6', bg:'#3d0d2a', border:'#9d174d' },
  add_radius:           { label:'Add Radius',        color:'#f472b6', bg:'#3d0d2a', border:'#9d174d' },
  update_bid:           { label:'Update Bid',        color:'#fbbf24', bg:'#3d2a0d', border:'#92400e' },
};

function renderPlan(plan) {
  const area = document.getElementById('planArea');
  const changes = plan.changes || [];
  const warnings = plan.warnings || [];

  let html = \`
    <div class="plan-card">
      <div class="plan-header">
        <div class="plan-summary">\${plan.summary || 'Task parsed'}</div>
        <div class="plan-count">\${changes.length} change\${changes.length !== 1 ? 's' : ''} · \${state.selectedName}</div>
      </div>
      <div class="change-list">
  \`;

  changes.forEach(c => {
    const meta = TYPE_META[c.type] || { label: c.type, color:'#94a3b8', bg:'#1a2035', border:'#334155' };
    let desc = '';
    if (c.type === 'update_budget') desc = \`New budget: $\${c.details?.newBudget}/day\`;
    else if (c.type.includes('keyword')) desc = \`[\${c.details?.matchType || '?'}] "\${c.details?.keyword}"\`;
    else if (c.type.includes('radius')) desc = \`\${c.details?.radius}mi radius around (\${c.details?.lat}, \${c.details?.lng})\`;
    else desc = c.adGroupName ? \`\${c.campaignName} › \${c.adGroupName}\` : (c.campaignName || '');

    html += \`
      <div class="change-item">
        <span class="change-type-badge" style="background:\${meta.bg};color:\${meta.color};border:1px solid \${meta.border}">\${meta.label}</span>
        <div>
          <div class="change-desc">\${desc || '—'}</div>
          <div class="change-campaign">\${c.campaignName || ''}\${c.adGroupName ? ' › ' + c.adGroupName : ''}</div>
        </div>
      </div>
    \`;
  });

  html += \`</div></div>\`;

  if (warnings.length) {
    html += \`<div class="warnings-box">
      <div class="warnings-title">⚠ Review Before Applying</div>
      \${warnings.map(w => \`<div class="warning-item">• \${w}</div>\`).join('')}
    </div>\`;
  }

  html += \`
    <div class="apply-row">
      <button class="btn-dryrun" onclick="applyChanges(true)">🔍 Dry Run (preview only)</button>
      <button class="btn-apply" onclick="confirmApply()">✅ Apply Changes to Google Ads</button>
      <button class="btn-secondary" onclick="clearPlan()">✕ Cancel</button>
    </div>
  \`;

  area.innerHTML = html;
}

// ─────────────────────────────────────────────────────────────
// APPLY CHANGES
// ─────────────────────────────────────────────────────────────
function confirmApply() {
  const count = state.plan?.changes?.length || 0;
  if (confirm(\`Apply \${count} change\${count !== 1 ? 's' : ''} to \${state.selectedName} in Google Ads?\\n\\nThis will make live changes to your account.\`)) {
    applyChanges(false);
  }
}

async function applyChanges(dryRun) {
  if (!state.plan) return;

  const btns = document.querySelectorAll('.btn-apply, .btn-dryrun');
  btns.forEach(b => b.disabled = true);

  const label = dryRun ? 'Running preview...' : 'Applying changes...';
  document.querySelector('.btn-dryrun').innerHTML = dryRun ? \`<span class="spinner"></span> \${label}\` : '🔍 Dry Run';
  document.querySelector('.btn-apply').innerHTML  = !dryRun ? \`<span class="spinner"></span> \${label}\` : '✅ Apply Changes';

  try {
    const res  = await fetch('/api/apply-changes', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        changes:    state.plan.changes,
        customerId: state.selectedId,
        dryRun,
      })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    renderResults(data, dryRun);
    if (!dryRun) {
      showToast(\`✅ \${data.applied} change\${data.applied !== 1 ? 's' : ''} applied to Google Ads\`);
      // Reload structure to reflect changes
      setTimeout(() => selectAccount(state.selectedId), 2000);
    }
  } catch (err) {
    showToast('❌ ' + err.message, 'error');
  } finally {
    btns.forEach(b => b.disabled = false);
    document.querySelector('.btn-dryrun').innerHTML = '🔍 Dry Run (preview only)';
    document.querySelector('.btn-apply').innerHTML  = '✅ Apply Changes to Google Ads';
  }
}

function renderResults(data, dryRun) {
  const area  = document.getElementById('planArea');
  const extra = \`
    <div class="results-card">
      <div class="results-header">
        \${dryRun ? '🔍 Dry Run Results — no changes were made' : \`✅ Applied — \${data.applied} change\${data.applied !== 1 ? 's' : ''} live in Google Ads\`}
        \${data.failed ? \` · ❌ \${data.failed} error\${data.failed !== 1 ? 's' : ''}\` : ''}
      </div>
      \${data.results.map(r => \`
        <div class="result-item">
          <span class="result-icon">\${r.success ? '✓' : '✗'}</span>
          <span class="result-text" style="color:\${r.success ? '#94a3b8' : '#f87171'}">\${r.result}</span>
        </div>
      \`).join('')}
    </div>
  \`;
  area.innerHTML = area.innerHTML + extra;
}

// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────
function clearTask() {
  document.getElementById('taskInput').value = '';
  clearPlan();
}
function clearPlan() {
  state.plan = null;
  document.getElementById('planArea').innerHTML = '';
}

let toastTimer;
function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.display = 'block';
  t.style.background    = type === 'error' ? '#3d0d0d'  : '#071a0e';
  t.style.borderColor   = type === 'error' ? '#991b1b'  : '#166534';
  t.style.color         = type === 'error' ? '#f87171'  : '#4ade80';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.display = 'none'; }, 4000);
}
</script>
</body>
</html>
`;

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(FRONTEND_HTML);
});

// ─────────────────────────────────────────────────────────────
// SESSION (stores the OAuth tokens between requests)
// ─────────────────────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// ─────────────────────────────────────────────────────────────
// GOOGLE ADS CLIENT FACTORY
// Creates a client using the stored OAuth refresh token
// ─────────────────────────────────────────────────────────────
function makeAdsClient(refreshToken) {
  return new GoogleAdsApi({
    client_id:       process.env.GOOGLE_ADS_CLIENT_ID,
    client_secret:   process.env.GOOGLE_ADS_CLIENT_SECRET,
    developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
  }).Customer({
    refresh_token: refreshToken,
    login_customer_id: undefined, // set per-request
  });
}

// ─────────────────────────────────────────────────────────────
// OAUTH ROUTES
// ─────────────────────────────────────────────────────────────

// Step 1: Redirect user to Google to sign in
app.get('/auth/google', (req, res) => {
  const params = new URLSearchParams({
    client_id:     process.env.GOOGLE_ADS_CLIENT_ID,
    redirect_uri:  `${process.env.APP_URL}/auth/callback`,
    response_type: 'code',
    scope:         'https://www.googleapis.com/auth/adwords',
    access_type:   'offline',
    prompt:        'consent',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// Step 2: Google sends user back here with a code — exchange for tokens
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=no_code');

  try {
    const { data } = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id:     process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
      redirect_uri:  `${process.env.APP_URL}/auth/callback`,
      grant_type:    'authorization_code',
    });

    // Store tokens in session (never sent to the browser)
    req.session.tokens = {
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
    };

    res.redirect('/?connected=true');
  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.redirect('/?error=oauth_failed');
  }
});

// Sign out
app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// Check if user is connected
app.get('/api/auth/status', (req, res) => {
  res.json({ connected: !!req.session.tokens?.refresh_token });
});

// ─────────────────────────────────────────────────────────────
// AUTH MIDDLEWARE — protects all /api routes below
// ─────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.tokens?.refresh_token) {
    return res.status(401).json({ error: 'Not authenticated. Please connect your Google Ads account.' });
  }
  next();
}

// ─────────────────────────────────────────────────────────────
// GET ALL ACCOUNTS (MCC + client accounts)
// Returns the full list of accessible accounts for the dropdown
// ─────────────────────────────────────────────────────────────
app.get('/api/accounts', requireAuth, async (req, res) => {
  console.log('--- /api/accounts called ---');
  try {
    const token = req.session.tokens.access_token;
    const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;

    // Helper: make a Google Ads API REST call
    const gadsPost = async (customerId, query, loginId) => {
      const headers = {
        'Authorization': 'Bearer ' + token,
        'developer-token': devToken,
        'Content-Type': 'application/json',
      };
      if (loginId) headers['login-customer-id'] = loginId;
      const resp = await axios.post(
        `https://googleads.googleapis.com/v19/customers/${customerId}/googleAds:search`,
        { query },
        { headers, timeout: 10000 }
      );
      return resp.data.results || [];
    };

    // Step 1: Get accessible customer IDs
    const listResp = await axios.get(
      'https://googleads.googleapis.com/v19/customers:listAccessibleCustomers',
      { headers: { 'Authorization': 'Bearer ' + token, 'developer-token': devToken }, timeout: 10000 }
    );
    const resourceNames = listResp.data.resourceNames || [];
    console.log('Accessible:', resourceNames.length);

    // Step 2: Find MCC — query all in parallel
    const infoResults = await Promise.allSettled(
      resourceNames.map(async rn => {
        const id = rn.replace('customers/', '');
        const rows = await gadsPost(id, 'SELECT customer.id, customer.descriptive_name, customer.manager FROM customer LIMIT 1');
        return { id, info: rows[0]?.customer };
      })
    );

    let mccId = null;
    infoResults.forEach(r => {
      if (r.status === 'fulfilled' && r.value?.info?.manager) {
        mccId = String(r.value.id);
        console.log('Found MCC:', mccId, r.value.info.descriptive_name);
      }
    });

    // Step 3: Get all client accounts from MCC
    let accounts = [];
    if (mccId) {
      req.session.mccId = mccId;
      const rows = await gadsPost(mccId,
        'SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.manager, customer_client.status FROM customer_client WHERE customer_client.level = 1',
        mccId
      );
      console.log('customer_client rows:', rows.length);
      rows.forEach(row => {
        const c = row.customerClient;
        if (c && !c.manager) {
          accounts.push({
            id:       String(c.id),
            name:     c.descriptiveName || 'Account ' + c.id,
            currency: c.currencyCode || '',
            isManager: false,
            mccId,
          });
        }
      });
      console.log('Client accounts:', accounts.length);
    }

    // Fallback
    if (accounts.length === 0) {
      console.log('Fallback mode');
      infoResults.forEach(r => {
        if (r.status === 'fulfilled' && r.value) {
          const { id, info } = r.value;
          accounts.push({ id, name: info?.descriptive_name || 'Account ' + id, currency: '', isManager: info?.manager || false });
        }
      });
    }

    accounts.sort((a, b) => (a.name||'').localeCompare(b.name||''));
    console.log('Returning', accounts.length, 'accounts');
    res.json({ accounts });

  } catch (err) {
    console.error('Accounts error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to load accounts: ' + err.message });
  }
});


app.get('/api/account/:customerId/structure', requireAuth, async (req, res) => {
  const { customerId } = req.params;
  const { mccId } = req.query; // optional MCC login customer id

  try {
    const customerConfig = {
      customer_id:   customerId,
      refresh_token: req.session.tokens.refresh_token,
    };
    if (mccId) customerConfig.login_customer_id = mccId;

    const client = new GoogleAdsApi({
      client_id:       process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret:   process.env.GOOGLE_ADS_CLIENT_SECRET,
      developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    }).Customer(customerConfig);

    // Fetch campaigns (simplified — no budget join to avoid permission issues)
    const campaigns = await client.query(`
      SELECT
        campaign.id,
        campaign.name,
        campaign.status,
        campaign.advertising_channel_type,
        campaign.bidding_strategy_type
      FROM campaign
      WHERE campaign.status != 'REMOVED'
      ORDER BY campaign.name
    `);

    // Fetch ad groups
    const adGroups = await client.query(`
      SELECT
        ad_group.id,
        ad_group.name,
        ad_group.status,
        ad_group.cpc_bid_micros,
        campaign.name
      FROM ad_group
      WHERE campaign.status != 'REMOVED'
        AND ad_group.status != 'REMOVED'
      ORDER BY campaign.name, ad_group.name
    `);

    // Fetch keywords (limit to 500 per account for speed)
    const keywords = await client.query(`
      SELECT
        ad_group_criterion.keyword.text,
        ad_group_criterion.keyword.match_type,
        ad_group_criterion.status,
        ad_group_criterion.cpc_bid_micros,
        ad_group_criterion.negative,
        ad_group.name,
        campaign.name
      FROM ad_group_criterion
      WHERE ad_group_criterion.type = 'KEYWORD'
        AND campaign.status != 'REMOVED'
        AND ad_group.status != 'REMOVED'
        AND ad_group_criterion.status != 'REMOVED'
      ORDER BY campaign.name, ad_group.name
      LIMIT 500
    `);

    // Fetch location targets
    const locations = await client.query(`
      SELECT
        campaign_criterion.location.geo_target_constant,
        campaign_criterion.bid_modifier,
        campaign_criterion.negative,
        campaign.name
      FROM campaign_criterion
      WHERE campaign_criterion.type = 'LOCATION'
        AND campaign.status != 'REMOVED'
      LIMIT 200
    `).catch(() => []);

    // Build structured tree
    const campMap = {};
    campaigns.forEach(row => {
      const c = row.campaign;
      campMap[c.name] = {
        id:       String(c.id),
        name:     c.name,
        status:   c.status,
        type:     c.advertising_channel_type,
        bidding:  c.bidding_strategy_type,
        budget:   '?',
        adGroups: [],
        locations: [],
      };
    });

    adGroups.forEach(row => {
      const camp = campMap[row.campaign.name];
      if (!camp) return;
      camp.adGroups.push({
        id:         String(row.ad_group.id),
        name:       row.ad_group.name,
        status:     row.ad_group.status,
        defaultBid: row.ad_group.cpc_bid_micros
          ? (row.ad_group.cpc_bid_micros / 1_000_000).toFixed(2) : '?',
        keywords:   [],
      });
    });

    keywords.forEach(row => {
      const camp = campMap[row.campaign.name];
      if (!camp) return;
      const ag = camp.adGroups.find(a => a.name === row.ad_group.name);
      if (!ag) return;
      const kw = row.ad_group_criterion;
      ag.keywords.push({
        text:     kw.keyword.text,
        match:    kw.keyword.match_type,
        status:   kw.status,
        bid:      kw.cpc_bid_micros ? (kw.cpc_bid_micros / 1_000_000).toFixed(2) : null,
        negative: kw.negative,
      });
    });

    locations.forEach(row => {
      const camp = campMap[row.campaign.name];
      if (!camp) return;
      camp.locations.push({
        geoTarget: row.campaign_criterion.location?.geo_target_constant || '',
        negative:  row.campaign_criterion.negative,
        bidMod:    row.campaign_criterion.bid_modifier,
      });
    });

    res.json({
      customerId,
      campaigns: Object.values(campMap),
      stats: {
        campaigns: campaigns.length,
        adGroups:  adGroups.length,
        keywords:  keywords.length,
      }
    });

  } catch (err) {
    const errMsg = err?.errors?.[0]?.message || err?.message || JSON.stringify(err) || String(err);
    console.error('Structure error:', errMsg);
    console.error('Structure error details:', JSON.stringify(err?.errors || err?.details || []));
    res.status(500).json({ error: 'Failed to load account structure: ' + errMsg });
  }
});

// ─────────────────────────────────────────────────────────────
// PARSE TASK WITH CLAUDE
// Takes the Freshdesk task + account structure → returns a
// human-readable plan + structured change list
// ─────────────────────────────────────────────────────────────
app.post('/api/parse-task', requireAuth, async (req, res) => {
  const { task, accountStructure, customerId, accountName } = req.body;
  if (!task) return res.status(400).json({ error: 'No task provided' });

  const systemPrompt = buildClaudeSystemPrompt();
  const userMessage  = buildUserMessage(task, accountStructure, accountName);

  try {
    const { data } = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model:      'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: userMessage }],
      },
      { headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } }
    );

    const raw   = data.content?.[0]?.text || '';
    const clean = raw.replace(/```json|```/gi, '').trim();
    const parsed = JSON.parse(clean);
    res.json(parsed);
  } catch (err) {
    console.error('Claude error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to parse task: ' + err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// APPLY CHANGES
// Receives the structured change list and executes each change
// via the Google Ads API
// ─────────────────────────────────────────────────────────────
app.post('/api/apply-changes', requireAuth, async (req, res) => {
  const { changes, customerId, dryRun = true } = req.body;
  if (!changes || !customerId) {
    return res.status(400).json({ error: 'Missing changes or customerId' });
  }

  const results  = [];
  const errors   = [];

  try {
    const client = new GoogleAdsApi({
      client_id:       process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret:   process.env.GOOGLE_ADS_CLIENT_SECRET,
      developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    }).Customer({
      customer_id:       customerId,
      refresh_token:     req.session.tokens.refresh_token,

    });

    for (const change of changes) {
      try {
        const result = await applyChange(client, change, dryRun);
        results.push({ change, result, success: true });
      } catch (err) {
        const msg = err.message || 'Unknown error';
        errors.push({ change, error: msg });
        results.push({ change, result: msg, success: false });
      }
    }

    res.json({
      dryRun,
      applied: results.filter(r => r.success).length,
      failed:  errors.length,
      results,
      errors,
    });

  } catch (err) {
    console.error('Apply error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// CHANGE EXECUTOR
// Handles each change type against the Google Ads API
// ─────────────────────────────────────────────────────────────
async function applyChange(client, change, dryRun) {
  const { type, campaignName, adGroupName, details } = change;

  if (dryRun) {
    return `[DRY RUN] Would ${type} — ${campaignName || ''}${adGroupName ? ' > ' + adGroupName : ''}`;
  }

  // Look up campaign resource name
  const getCampaignId = async (name) => {
    const rows = await client.query(`
      SELECT campaign.id, campaign.name
      FROM campaign
      WHERE campaign.name = '${name.replace(/'/g, "\\'")}'
        AND campaign.status != 'REMOVED'
      LIMIT 1
    `);
    if (!rows.length) throw new Error(`Campaign not found: "${name}"`);
    return String(rows[0].campaign.id);
  };

  const getAdGroupId = async (campName, agName) => {
    const rows = await client.query(`
      SELECT ad_group.id
      FROM ad_group
      WHERE campaign.name = '${campName.replace(/'/g, "\\'")}'
        AND ad_group.name = '${agName.replace(/'/g, "\\'")}'
        AND ad_group.status != 'REMOVED'
      LIMIT 1
    `);
    if (!rows.length) throw new Error(`Ad group not found: "${agName}" in "${campName}"`);
    return String(rows[0].ad_group.id);
  };

  switch (type) {

    case 'pause_campaign': {
      const id = await getCampaignId(campaignName);
      await client.campaigns.update([{ resource_name: `customers/${client.credentials.customer_id}/campaigns/${id}`, status: 'PAUSED' }]);
      return `Paused campaign: ${campaignName}`;
    }

    case 'enable_campaign': {
      const id = await getCampaignId(campaignName);
      await client.campaigns.update([{ resource_name: `customers/${client.credentials.customer_id}/campaigns/${id}`, status: 'ENABLED' }]);
      return `Enabled campaign: ${campaignName}`;
    }

    case 'update_budget': {
      const id = await getCampaignId(campaignName);
      // Get the budget resource name first
      const rows = await client.query(`
        SELECT campaign_budget.resource_name, campaign_budget.amount_micros
        FROM campaign
        WHERE campaign.id = ${id}
        LIMIT 1
      `);
      if (!rows.length) throw new Error('Budget not found');
      const budgetResource = rows[0].campaign_budget.resource_name;
      const newAmountMicros = Math.round(parseFloat(details.newBudget) * 1_000_000);
      await client.campaignBudgets.update([{
        resource_name:  budgetResource,
        amount_micros:  newAmountMicros,
      }]);
      return `Updated budget for "${campaignName}" to $${details.newBudget}/day`;
    }

    case 'pause_ad_group': {
      const campId = await getCampaignId(campaignName);
      const agId   = await getAdGroupId(campaignName, adGroupName);
      await client.adGroups.update([{
        resource_name: `customers/${client.credentials.customer_id}/adGroups/${agId}`,
        status: 'PAUSED'
      }]);
      return `Paused ad group: ${adGroupName} in ${campaignName}`;
    }

    case 'enable_ad_group': {
      const agId = await getAdGroupId(campaignName, adGroupName);
      await client.adGroups.update([{
        resource_name: `customers/${client.credentials.customer_id}/adGroups/${agId}`,
        status: 'ENABLED'
      }]);
      return `Enabled ad group: ${adGroupName} in ${campaignName}`;
    }

    case 'pause_keyword': {
      const rows = await client.query(`
        SELECT ad_group_criterion.resource_name
        FROM ad_group_criterion
        WHERE campaign.name = '${campaignName.replace(/'/g, "\\'")}'
          AND ad_group_criterion.keyword.text = '${details.keyword.replace(/'/g, "\\'")}'
          AND ad_group_criterion.keyword.match_type = '${details.matchType}'
        LIMIT 1
      `);
      if (!rows.length) throw new Error(`Keyword not found: ${details.keyword}`);
      await client.adGroupCriteria.update([{
        resource_name: rows[0].ad_group_criterion.resource_name,
        status: 'PAUSED'
      }]);
      return `Paused keyword: [${details.matchType}] "${details.keyword}"`;
    }

    case 'add_negative_keyword': {
      const campId = await getCampaignId(campaignName);
      await client.campaignCriteria.create([{
        campaign:  `customers/${client.credentials.customer_id}/campaigns/${campId}`,
        negative:  true,
        keyword: {
          text:       details.keyword,
          match_type: details.matchType || 'EXACT',
        }
      }]);
      return `Added negative keyword [${details.matchType}] "${details.keyword}" to ${campaignName}`;
    }

    case 'add_keyword': {
      const agId = await getAdGroupId(campaignName, adGroupName);
      await client.adGroupCriteria.create([{
        ad_group:  `customers/${client.credentials.customer_id}/adGroups/${agId}`,
        status:    'ENABLED',
        keyword: {
          text:       details.keyword,
          match_type: details.matchType || 'BROAD',
        },
        ...(details.cpcBid ? { cpc_bid_micros: Math.round(parseFloat(details.cpcBid) * 1_000_000) } : {}),
      }]);
      return `Added keyword [${details.matchType}] "${details.keyword}" to ${adGroupName}`;
    }

    case 'exclude_radius': {
      const campId = await getCampaignId(campaignName);
      await client.campaignCriteria.create([{
        campaign: `customers/${client.credentials.customer_id}/campaigns/${campId}`,
        negative: true,
        proximity: {
          geo_point: { longitude_in_micro_degrees: Math.round(details.lng * 1_000_000), latitude_in_micro_degrees: Math.round(details.lat * 1_000_000) },
          radius:      details.radius,
          radius_units: details.units || 'MILES',
        }
      }]);
      return `Excluded ${details.radius}mi radius from ${campaignName}`;
    }

    case 'add_radius': {
      const campId = await getCampaignId(campaignName);
      await client.campaignCriteria.create([{
        campaign: `customers/${client.credentials.customer_id}/campaigns/${campId}`,
        negative: false,
        proximity: {
          geo_point: { longitude_in_micro_degrees: Math.round(details.lng * 1_000_000), latitude_in_micro_degrees: Math.round(details.lat * 1_000_000) },
          radius:      details.radius,
          radius_units: details.units || 'MILES',
        }
      }]);
      return `Added ${details.radius}mi radius targeting to ${campaignName}`;
    }

    default:
      throw new Error(`Unknown change type: ${type}`);
  }
}

// ─────────────────────────────────────────────────────────────
// CLAUDE SYSTEM PROMPT BUILDER
// ─────────────────────────────────────────────────────────────
function buildClaudeSystemPrompt() {
  return `You are a Google Ads expert for automotive dealerships. 
Parse Freshdesk tasks and return structured change instructions.

Return ONLY valid JSON, no markdown, no explanation:

{
  "summary": "Plain English summary of all changes",
  "changes": [
    {
      "type": "pause_campaign|enable_campaign|update_budget|pause_ad_group|enable_ad_group|pause_keyword|enable_keyword|add_keyword|add_negative_keyword|exclude_radius|add_radius|update_bid",
      "campaignName": "exact campaign name from account",
      "adGroupName": "exact ad group name if applicable",
      "details": {
        "newBudget": "number string e.g. 150.00",
        "keyword": "keyword text",
        "matchType": "EXACT|PHRASE|BROAD",
        "lat": 30.064250,
        "lng": -90.069620,
        "radius": 20,
        "units": "MILES",
        "cpcBid": "1.50"
      }
    }
  ],
  "warnings": ["anything to verify before applying"],
  "affectedCampaigns": ["list of campaign names being changed"]
}

Rules:
- Use exact campaign/ad group names from the account structure provided
- "all campaigns" = one change entry per campaign
- Budget values: numbers only, no $ sign
- Match types: EXACT, PHRASE, or BROAD (uppercase)
- Radius: always include lat, lng, radius, and units
- If a campaign is not found in the account, add a warning`;
}

function buildUserMessage(task, structure, accountName) {
  if (!structure) return task;

  const campList = structure.campaigns.map(c => {
    const ags = c.adGroups.map(ag =>
      `    📁 "${ag.name}" | ${ag.status} | bid:$${ag.defaultBid} | ${ag.keywords.length} keywords`
    ).join('\n');
    return `  📢 "${c.name}" | ${c.status} | $${c.budget}/day | ${c.type}\n${ags}`;
  }).join('\n');

  return `ACCOUNT: ${accountName}

CURRENT STRUCTURE:
${campList}

FRESHDESK TASK:
${task}`;
}

// ─────────────────────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ─────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n⚡ Dealer Ads Tool running on port ${PORT}`);
  console.log(`   Open: http://localhost:${PORT}\n`);
});

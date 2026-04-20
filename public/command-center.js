/**
 * Command Center — frontend logic for the combined Task Manager + Campaign Builder.
 *
 * Handles: chat UI, message sending, plan display, execution, CSV export,
 * account selection, Freshdesk ticket sidebar, question answering.
 */

// ── State ────────────────────────────────────────────────────────

var ccState = {
  connected: false,
  accounts: [],
  selectedAccount: null,
  selectedMccId: null,
  tickets: [],
  busy: false,
  hasPlan: false,
};

// ── DOM Helpers ──────────────────────────────────────────────────

var $messages = document.getElementById('messages');
var $input = document.getElementById('chatInput');
var $sendBtn = document.getElementById('sendBtn');
var $welcome = document.getElementById('welcome');
var $accountSelect = document.getElementById('accountSelect');
var $ticketList = document.getElementById('ticketList');
var $freshdeskSection = document.getElementById('freshdeskSection');
var $connectionStatus = document.getElementById('connectionStatus');
var $connectBtn = document.getElementById('connectBtn');

function setInput(text) {
  $input.value = text;
  $input.focus();
  $input.select();
}

function handleKey(e) {
  if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); sendMessage(); }
  // Auto-resize textarea
  $input.style.height = 'auto';
  $input.style.height = Math.min($input.scrollHeight, 120) + 'px';
}

function scrollToBottom() {
  $messages.scrollTop = $messages.scrollHeight;
}

// ── Auth & Account Loading ───────────────────────────────────────

async function checkAuth() {
  try {
    var r = await fetch('/api/auth/status');
    var d = await r.json();
    if (d.authenticated || d.connected) {
      ccState.connected = true;
      $connectionStatus.innerHTML = '<span class="cc-status-dot connected"></span>MCC Connected';
      $connectBtn.textContent = 'Connected';
      $connectBtn.href = '#';
      $connectBtn.style.background = '#1a2332';
      $connectBtn.style.borderColor = '#4ade80';
      $connectBtn.style.color = '#4ade80';
      loadAccounts();
    } else {
      $connectionStatus.innerHTML = '<span class="cc-status-dot disconnected"></span>Not connected';
    }
  } catch (e) {
    console.warn('Auth check failed:', e);
  }
}

async function doConnect() {
  window.location.href = '/auth/google';
}

async function loadAccounts() {
  try {
    var r = await fetch('/api/accounts');
    var d = await r.json();
    ccState.accounts = d.accounts || [];
    $accountSelect.innerHTML = '<option value="">-- Select account --</option>';
    ccState.accounts.forEach(function(acc) {
      var opt = document.createElement('option');
      opt.value = acc.id;
      opt.textContent = acc.name + ' (' + acc.id + ')';
      $accountSelect.appendChild(opt);
    });
  } catch (e) {
    console.warn('Failed to load accounts:', e);
  }
}

function selectAccount(id) {
  if (!id) { ccState.selectedAccount = null; return; }
  var acc = ccState.accounts.find(function(a) { return a.id === id; });
  ccState.selectedAccount = id;
  ccState.selectedMccId = acc ? acc.mccId : null;
}

// ── Freshdesk ────────────────────────────────────────────────────

async function checkFreshdesk() {
  try {
    var r = await fetch('/api/freshdesk/status');
    var d = await r.json();
    if (d.configured) {
      $freshdeskSection.style.display = 'block';
      loadTickets();
    }
  } catch (e) {}
}

async function loadTickets() {
  try {
    var r = await fetch('/api/freshdesk/tickets');
    var d = await r.json();
    ccState.tickets = d.tickets || [];
    renderTickets();
  } catch (e) {}
}

function renderTickets() {
  $ticketList.innerHTML = '';
  ccState.tickets.forEach(function(t) {
    var li = document.createElement('li');
    li.className = 'cc-ticket';
    li.onclick = function() { loadTicket(t.id); };
    var pClass = t.priority === 1 ? 'urgent' : t.priority === 2 ? 'high' : t.priority === 3 ? 'medium' : 'low';
    li.innerHTML = '<div class="cc-ticket-priority ' + pClass + '"></div><div><div style="font-weight:500">' +
      escHtml(t.subject || 'No subject') + '</div><div style="color:var(--cc-text-muted);font-size:10px">' +
      escHtml(t.requesterName || '') + '</div></div>';
    $ticketList.appendChild(li);
  });
}

async function loadTicket(id) {
  try {
    var r = await fetch('/api/freshdesk/tickets/' + id);
    if (!r.ok) {
      console.warn('Freshdesk ticket load failed:', r.status);
      $input.value = 'Freshdesk Ticket #' + id + '\nSubject: \nRequester: \nPriority: \n\n(Could not load ticket details - may need to reconnect Google Ads)';
      return;
    }
    var d = await r.json();
    var t = d.ticket || d;
    var text = 'Freshdesk Ticket #' + id + '\nSubject: ' + (t.subject || '') +
      '\nRequester: ' + (t.requesterName || '') +
      '\nPriority: ' + (t.priorityLabel || '') +
      '\n\n' + (t.description || '');
    $input.value = text;
    $input.style.height = 'auto';
    $input.style.height = Math.min($input.scrollHeight, 120) + 'px';
    $input.focus();
  } catch (e) {
    console.warn('Failed to load ticket:', e);
  }
}

// ── Chat ─────────────────────────────────────────────────────────

function addUserMessage(text) {
  if ($welcome) $welcome.style.display = 'none';
  var div = document.createElement('div');
  div.className = 'cc-msg user';
  div.textContent = text;
  $messages.appendChild(div);
  scrollToBottom();
}

function addAssistantMessage(text) {
  var div = document.createElement('div');
  div.className = 'cc-msg assistant';
  div.innerHTML = escHtml(text).replace(/\n/g, '<br>');
  $messages.appendChild(div);
  scrollToBottom();
  return div;
}

function addLoading() {
  var div = document.createElement('div');
  div.className = 'cc-loading';
  div.id = 'loadingIndicator';
  div.innerHTML = '<div class="cc-loading-dots"><span></span><span></span><span></span></div> Thinking...';
  $messages.appendChild(div);
  scrollToBottom();
}

function removeLoading() {
  var el = document.getElementById('loadingIndicator');
  if (el) el.remove();
}

function addQuestionsCard(message, questions) {
  var div = document.createElement('div');
  div.className = 'cc-questions-card';
  var html = '<h4>Questions</h4>';
  html += '<div style="margin-bottom:10px">' + escHtml(message).replace(/\n/g, '<br>') + '</div>';
  questions.forEach(function(q, i) {
    html += '<div class="cc-question-item"><span class="num">' + (i + 1) + '.</span><div style="flex:1">' +
      escHtml(q) + '<input class="cc-question-input" id="qa_' + i + '" placeholder="Your answer..."></div></div>';
  });
  html += '<button class="cc-questions-submit" onclick="submitAnswers(' + questions.length + ')">Submit Answers</button>';
  div.innerHTML = html;
  $messages.appendChild(div);
  scrollToBottom();
}

function addPlanCard(message, plan) {
  ccState.hasPlan = true;
  var div = document.createElement('div');
  div.className = 'cc-plan-card';
  var html = '<h4>Plan Ready</h4>';
  html += '<div class="cc-plan-summary">' + escHtml(message).replace(/\n/g, '<br>') + '</div>';

  var changeList = (plan && plan.changes) ? plan.changes : (Array.isArray(plan) ? plan : []);
  if (changeList.length) {
    html += '<div class="cc-plan-changes">';
    changeList.forEach(function(c) {
      if (!c || typeof c !== 'object') return;
      var type = String(c.type || c.action || 'unknown');
      var badge = getBadgeClass(type);
      var desc = c.campaignName || c.campaign || '';
      if (c.adGroupName || c.adGroup) desc += ' > ' + (c.adGroupName || c.adGroup);
      if (c.keyword) desc += ' [' + (c.matchType || '') + '] ' + c.keyword;
      if (c.details && c.details.keyword) desc += ' [' + (c.details.matchType || '') + '] ' + c.details.keyword;
      if (c.finalUrl) desc += ' → ' + c.finalUrl;
      if (c.budgetName) desc += ' budget: ' + c.budgetName;
      if (c.headlines) desc += ' (' + c.headlines.length + ' headlines)';
      html += '<div class="cc-plan-change"><span class="cc-change-badge ' + badge + '">' +
        escHtml(type.replace(/_/g, ' ')) + '</span><span>' + escHtml(desc) + '</span></div>';
    });
    html += '</div>';
    html += '<div style="font-size:11px;color:var(--cc-text-muted);margin-bottom:8px">' + changeList.length + ' change(s) in plan</div>';
  }

  html += '<div class="cc-plan-actions">';
  if (ccState.connected && ccState.selectedAccount) {
    html += '<button class="cc-btn cc-btn-outline" onclick="executePlan(true)">Dry Run</button>';
    html += '<button class="cc-btn cc-btn-primary" onclick="executePlan(false)">Execute via API</button>';
  }
  html += '<button class="cc-btn cc-btn-secondary" onclick="exportCsv()">Download CSV</button>';
  html += '<button class="cc-btn cc-btn-outline" onclick="editPlan()">Edit</button>';
  html += '</div>';

  div.innerHTML = html;
  $messages.appendChild(div);
  scrollToBottom();
}

function addResultsCard(results, summary) {
  var div = document.createElement('div');
  div.className = 'cc-results-card';
  var html = '<h4 style="font-size:12px;margin-bottom:8px;color:var(--cc-text)">' + escHtml(summary) + '</h4>';
  results.forEach(function(r) {
    var cls = r.success ? 'success' : 'fail';
    var icon = r.success ? '&#10003;' : '&#10007;';
    html += '<div class="cc-result-item ' + cls + '">' + icon + ' ' + escHtml(r.message) + '</div>';
  });
  div.innerHTML = html;
  $messages.appendChild(div);
  scrollToBottom();
}

function getBadgeClass(type) {
  if (!type) return 'create';
  if (type.startsWith('create')) return 'create';
  if (type.startsWith('pause')) return 'pause';
  if (type.startsWith('enable')) return 'enable';
  if (type.includes('budget')) return 'budget';
  if (type.includes('negative')) return 'negative';
  if (type.includes('keyword')) return 'keyword';
  return 'create';
}

// ── Actions ──────────────────────────────────────────────────────

async function sendMessage() {
  var text = $input.value.trim();
  if (!text || ccState.busy) return;

  addUserMessage(text);
  $input.value = '';
  $input.style.height = '42px';
  ccState.busy = true;
  $sendBtn.disabled = true;
  addLoading();

  try {
    var r = await fetch('/api/cc/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        customerId: ccState.selectedAccount || undefined,
      }),
    });
    removeLoading();

    if (!r.ok) {
      try {
        var err = await r.json();
        addAssistantMessage('Error: ' + (err.error || 'Server error ' + r.status));
      } catch (jsonErr) {
        var txt = await r.text().catch(function() { return 'Unknown'; });
        addAssistantMessage('Error: Server returned ' + r.status + ': ' + txt.slice(0, 200));
      }
      return;
    }

    var data = await r.json();

    try {
      if (data.type === 'questions') {
        addQuestionsCard(data.message || '', data.questions || []);
      } else if (data.type === 'plan') {
        addPlanCard(data.message || '', data.plan || {});
      } else {
        addAssistantMessage(data.message || 'Done.');
      }
    } catch (renderErr) {
      console.error('Render error:', renderErr, 'Data:', JSON.stringify(data).slice(0, 500));
      addAssistantMessage('Render error: ' + renderErr.message + '\n\nRaw response:\n' + JSON.stringify(data, null, 2).slice(0, 500));
    }
  } catch (e) {
    removeLoading();
    addAssistantMessage('Error: ' + (e.message || String(e)));
  } finally {
    ccState.busy = false;
    $sendBtn.disabled = false;
  }
}

async function submitAnswers(count) {
  var answers = [];
  for (var i = 0; i < count; i++) {
    var el = document.getElementById('qa_' + i);
    answers.push(el ? el.value : '');
  }
  var text = answers.map(function(a, i) { return (i + 1) + '. ' + a; }).join('\n');
  $input.value = text;
  sendMessage();
}

async function executePlan(dryRun) {
  if (!ccState.selectedAccount) {
    addAssistantMessage('Please select an account first.');
    return;
  }
  if (dryRun === false && !confirm('Execute this plan on the live account? This will make real changes.')) return;

  ccState.busy = true;
  addLoading();

  try {
    var r = await fetch('/api/cc/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerId: ccState.selectedAccount,
        dryRun: !!dryRun,
      }),
    });
    removeLoading();
    var data = await r.json();
    addResultsCard(data.results || [], data.summary || 'Done');
  } catch (e) {
    removeLoading();
    addAssistantMessage('Execution error: ' + e.message);
  } finally {
    ccState.busy = false;
  }
}

async function exportCsv() {
  try {
    var r = await fetch('/api/cc/export-csv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    var data = await r.json();
    if (data.error) { addAssistantMessage('CSV export error: ' + data.error); return; }

    // Download CSV
    var blob = new Blob([data.csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = data.filename || 'export.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function() { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
    addAssistantMessage('Downloaded ' + data.filename + ' (' + data.rowCount + ' rows)');
  } catch (e) {
    addAssistantMessage('CSV export error: ' + e.message);
  }
}

function editPlan() {
  $input.value = "I'd like to modify the plan. ";
  $input.focus();
}

function newChat() {
  fetch('/api/cc/session', { method: 'DELETE' }).then(function() {
    $messages.innerHTML = '';
    ccState.hasPlan = false;
    // Re-add welcome
    var welcome = document.createElement('div');
    welcome.className = 'cc-welcome';
    welcome.id = 'welcome';
    welcome.innerHTML = '<h2>Dealer Ads Command Center</h2>' +
      '<p>Paste a dealer homepage to build a full account, drop a Freshdesk ticket to execute tasks, or type any command. I\'ll ask questions when I\'m unsure.</p>' +
      '<div class="cc-welcome-actions">' +
      '<button class="cc-welcome-action" onclick="setInput(\'Paste a dealer homepage URL here...\')">Build Account</button>' +
      '<button class="cc-welcome-action" onclick="setInput(\'Audit this account\')">Audit Account</button>' +
      '<button class="cc-welcome-action" onclick="setInput(\'Create a new campaign for...\')">Create Campaign</button>' +
      '</div>';
    $messages.appendChild(welcome);
  });
}

// ── Util ─────────────────────────────────────────────────────────

function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Init ─────────────────────────────────────────────────────────

checkAuth();
checkFreshdesk();

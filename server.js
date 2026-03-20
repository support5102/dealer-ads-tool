require('dotenv').config();
const express    = require('express');
const session    = require('express-session');
const axios      = require('axios');
const cors       = require('cors');
const path       = require('path');
const crypto     = require('crypto');
const { GoogleAdsApi } = require('google-ads-api');
const { applyChange } = require('./lib/apply-change');
const { buildClaudeSystemPrompt, buildUserMessage } = require('./lib/claude-prompts');

// ─────────────────────────────────────────────────────────────
// STARTUP VALIDATION — fail fast if required env vars are missing
// ─────────────────────────────────────────────────────────────
const REQUIRED_ENV = [
  'SESSION_SECRET',
  'GOOGLE_ADS_CLIENT_ID',
  'GOOGLE_ADS_CLIENT_SECRET',
  'GOOGLE_ADS_DEVELOPER_TOKEN',
  'ANTHROPIC_API_KEY',
];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`\n❌ Missing required environment variables:\n   ${missing.join('\n   ')}\n\nSee env.example for details.\n`);
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(cors());
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// ─────────────────────────────────────────────────────────────
// SERVE FRONTEND
// ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// SESSION middleware moved to top of file (after cors)

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
      token_expiry:  Date.now() + (data.expires_in || 3600) * 1000,
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
// TOKEN REFRESH HELPER
// Access tokens expire after 1 hour — refresh automatically
// ─────────────────────────────────────────────────────────────
async function getFreshAccessToken(req) {
  const tokens = req.session.tokens;
  // Use cached token if it hasn't expired yet (5-minute buffer)
  if (tokens.access_token && tokens.token_expiry && Date.now() < tokens.token_expiry - 5 * 60 * 1000) {
    return tokens.access_token;
  }
  try {
    const { data } = await axios.post('https://oauth2.googleapis.com/token', {
      client_id:     process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
      grant_type:    'refresh_token',
    });
    req.session.tokens.access_token = data.access_token;
    // Google tokens typically expire in 3600s; use expires_in if provided
    req.session.tokens.token_expiry = Date.now() + (data.expires_in || 3600) * 1000;
    console.log('Token refreshed successfully (cached until expiry)');
    return data.access_token;
  } catch(e) {
    console.error('Token refresh failed:', e.response?.data || e.message);
    return tokens.access_token;
  }
}

// ─────────────────────────────────────────────────────────────
// GET ALL ACCOUNTS (MCC + client accounts)
// Returns the full list of accessible accounts for the dropdown
// ─────────────────────────────────────────────────────────────
app.get('/api/accounts', requireAuth, async (req, res) => {
  console.log('--- /api/accounts called ---');
  try {
    const token = await getFreshAccessToken(req);
    const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;

    const gadsSearch = async (customerId, query, loginId, retries = 1) => {
      const headers = {
        'Authorization': 'Bearer ' + token,
        'developer-token': devToken,
        'Content-Type': 'application/json',
      };
      if (loginId) headers['login-customer-id'] = String(loginId);
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const resp = await axios.post(
            'https://googleads.googleapis.com/v19/customers/' + customerId + '/googleAds:searchStream',
            { query },
            { headers, timeout: 10000 }
          );
          const results = [];
          const data = Array.isArray(resp.data) ? resp.data : [resp.data];
          data.forEach(chunk => { if (chunk.results) results.push(...chunk.results); });
          return results;
        } catch (e) {
          const status = e.response?.status;
          const errMsg = e.response?.data?.error?.message || e.message;
          console.error(`gadsSearch failed for customer ${customerId} (attempt ${attempt + 1}/${retries + 1}):`, errMsg);
          // Retry on transient errors (429 rate limit, 500/503 server errors, network failures)
          const isNetworkError = !e.response && (e.code === 'ECONNABORTED' || e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT' || e.code === 'ENOTFOUND');
          if (attempt < retries && (status === 429 || status === 500 || status === 503 || isNetworkError)) {
            const delay = (attempt + 1) * 1000;
            console.log(`Retrying customer ${customerId} in ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          throw e;
        }
      }
    };

    // Step 1: Get accessible customer IDs via library
    const api = new GoogleAdsApi({
      client_id:       process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret:   process.env.GOOGLE_ADS_CLIENT_SECRET,
      developer_token: devToken,
    });
    const accessible = await Promise.race([
      api.listAccessibleCustomers(req.session.tokens.refresh_token),
      new Promise((_, rej) => setTimeout(() => rej(new Error('listAccessibleCustomers timed out after 15s')), 15000))
    ]);
    const resourceNames = accessible.resource_names || accessible.resourceNames || [];
    console.log('Accessible accounts:', resourceNames.length);

    // Step 2: Try each account as login-customer-id for itself
    // For MCC accounts this works; for child accounts we need MCC id
    // Try all in parallel with login-customer-id = their own id
    const infoResults = await Promise.allSettled(
      resourceNames.map(async rn => {
        const id = rn.replace('customers/', '');
        const rows = await gadsSearch(id,
          'SELECT customer.id, customer.descriptive_name, customer.manager FROM customer LIMIT 1',
          id  // use own id as login id - works for top-level accounts
        );
        const c = rows[0]?.customer;
        return { id, name: c?.descriptiveName || null, isManager: c?.manager || false };
      })
    );

    console.log('Results:', infoResults.map(r => 
      r.status === 'fulfilled' ? (r.value.id + ':' + (r.value.isManager ? 'MCC' : 'client')) : 'failed'
    ).join(', '));

    // Find the MCC — always re-discover from API results, session is only a fallback
    let mccId = null;
    const allMccs = [];
    infoResults.forEach(r => {
      if (r.status === 'fulfilled' && r.value?.isManager) {
        allMccs.push(r.value.id);
      }
    });
    if (allMccs.length > 1) {
      console.warn('Multiple MCC accounts found:', allMccs.join(', '), '— using first one');
    }
    if (allMccs.length > 0) {
      mccId = allMccs[0];
      console.log('Using MCC:', mccId);
    }
    // Fall back to session cache only if API discovery found nothing
    if (!mccId && req.session.mccId) {
      console.log('No MCC found in API results, using cached mccId:', req.session.mccId);
      mccId = req.session.mccId;
    }
    // Update session cache with fresh value
    req.session.mccId = mccId || null;

    // Step 3: Get all client accounts using MCC as login id
    let accounts = [];
    if (mccId) {
      try {
        const rows = await gadsSearch(mccId,
          'SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.manager, customer_client.level FROM customer_client WHERE customer_client.level = 1',
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
        console.log('Client accounts found:', accounts.length);
      } catch(e) {
        console.error('customer_client query failed:', e.response?.data?.error?.message || e.message);
      }
    }

    // Fallback: use whatever info we got
    if (accounts.length === 0) {
      console.log('Using fallback');
      infoResults.forEach((r, idx) => {
        if (r.status === 'fulfilled' && r.value) {
          accounts.push({
            id: r.value.id,
            name: r.value.name || 'Account ' + r.value.id,
            currency: '',
            isManager: r.value.isManager,
            mccId: mccId || null,
          });
        } else {
          // Still add the account even if query failed
          const rn = resourceNames[idx];
          if (rn) {
            const id = rn.replace('customers/', '');
            accounts.push({ id, name: 'Account ' + id, currency: '', isManager: false, mccId: null });
          }
        }
      });
    }

    accounts.sort((a, b) => (a.name||'').localeCompare(b.name||''));
    // Cache accessible account IDs for ownership verification in batch apply
    req.session.accessibleAccounts = accounts.map(a => a.id);
    console.log('Returning', accounts.length, 'accounts');
    res.json({ accounts });

  } catch (err) {
    const errDetail = err.response?.data?.error?.message || err.response?.data?.error || err.message;
    console.error('Accounts error:', errDetail);
    res.status(500).json({ error: 'Failed to load accounts: ' + (typeof errDetail === 'string' ? errDetail : err.message) });
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

    const withTimeout = (promise, ms, label) => {
      let timer;
      return Promise.race([
        promise.finally(() => clearTimeout(timer)),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s`)), ms); })
      ]);
    };

    const timed = async (label, promise, timeoutMs) => {
      const start = Date.now();
      try {
        const result = await withTimeout(promise, timeoutMs, label);
        console.log(`${label}: ${Date.now() - start}ms (${Array.isArray(result) ? result.length + ' rows' : 'done'})`);
        return result;
      } catch (e) {
        console.error(`${label}: failed after ${Date.now() - start}ms — ${e.message}`);
        throw e;
      }
    };

    // Fetch all data in parallel for speed
    const [campaigns, adGroups, budgets, keywords, locations, metrics] = await Promise.all([
      // Campaigns
      timed('Campaigns', client.query(`
        SELECT
          campaign.id,
          campaign.name,
          campaign.status,
          campaign.advertising_channel_type,
          campaign.bidding_strategy_type
        FROM campaign
        WHERE campaign.status != 'REMOVED'
        ORDER BY campaign.name
      `), 15000),

      // Ad groups
      timed('Ad groups', client.query(`
        SELECT
          ad_group.id,
          ad_group.name,
          ad_group.status,
          ad_group.cpc_bid_micros,
          campaign.id,
          campaign.name
        FROM ad_group
        WHERE campaign.status != 'REMOVED'
          AND ad_group.status != 'REMOVED'
        ORDER BY campaign.name, ad_group.name
      `), 15000).catch(e => {
        console.warn('Ad groups query failed (non-fatal):', e.message);
        return [];
      }),

      // Budgets — queried separately to avoid permission issues with JOIN
      timed('Budgets', client.query(`
        SELECT
          campaign.id,
          campaign_budget.amount_micros
        FROM campaign
        WHERE campaign.status != 'REMOVED'
      `), 15000).catch(e => {
        console.warn('Budget query failed (non-fatal):', e.message);
        return [];
      }),

      // Keywords (limit 1000 per account)
      timed('Keywords', client.query(`
        SELECT
          ad_group_criterion.keyword.text,
          ad_group_criterion.keyword.match_type,
          ad_group_criterion.status,
          ad_group_criterion.cpc_bid_micros,
          ad_group_criterion.negative,
          ad_group.name,
          campaign.id,
          campaign.name
        FROM ad_group_criterion
        WHERE ad_group_criterion.type = 'KEYWORD'
          AND campaign.status != 'REMOVED'
          AND ad_group.status != 'REMOVED'
          AND ad_group_criterion.status != 'REMOVED'
        ORDER BY campaign.name, ad_group.name
        LIMIT 1000
      `), 25000),

      // Location targets
      timed('Locations', client.query(`
        SELECT
          campaign_criterion.location.geo_target_constant,
          campaign_criterion.bid_modifier,
          campaign_criterion.negative,
          campaign.id,
          campaign.name
        FROM campaign_criterion
        WHERE campaign_criterion.type = 'LOCATION'
          AND campaign.status != 'REMOVED'
        LIMIT 500
      `), 15000).catch(e => {
        console.warn('Location query failed (non-fatal):', e.message);
        return [];
      }),

      // Performance metrics — last 30 days
      timed('Metrics', client.query(`
        SELECT
          campaign.id,
          segments.date,
          metrics.impressions,
          metrics.clicks,
          metrics.cost_micros,
          metrics.conversions
        FROM campaign
        WHERE campaign.status != 'REMOVED'
          AND segments.date DURING LAST_30_DAYS
      `), 20000).catch(e => {
        console.warn('Metrics query failed (non-fatal):', e.message);
        return [];
      }),
    ]);

    // Build budget lookup by campaign ID
    const budgetMap = {};
    budgets.forEach(row => {
      const campId = String(row.campaign.id);
      const b = row.campaign_budget || row.campaignBudget;
      const micros = b?.amount_micros || b?.amountMicros;
      if (micros) budgetMap[campId] = (micros / 1_000_000).toFixed(2);
    });

    // Build metrics lookup by campaign ID (aggregate across date segments)
    const metricsMap = {};
    metrics.forEach(row => {
      const campId = String(row.campaign.id);
      if (!metricsMap[campId]) {
        metricsMap[campId] = { impressions: 0, clicks: 0, cost: 0, conversions: 0 };
      }
      const m = row.metrics;
      metricsMap[campId].impressions += Number(m.impressions || m.Impressions || 0);
      metricsMap[campId].clicks += Number(m.clicks || m.Clicks || 0);
      metricsMap[campId].cost += Number(m.cost_micros || m.costMicros || 0);
      metricsMap[campId].conversions += Number(m.conversions || m.Conversions || 0);
    });
    // Convert cost from micros to dollars
    Object.values(metricsMap).forEach(m => { m.cost = (m.cost / 1_000_000).toFixed(2); });

    // Build structured tree
    const campMap = {};
    campaigns.forEach(row => {
      const c = row.campaign;
      const campId = String(c.id);
      campMap[campId] = {
        id:       campId,
        name:     c.name,
        status:   c.status,
        type:     c.advertising_channel_type,
        bidding:  c.bidding_strategy_type,
        budget:   budgetMap[campId] || '?',
        metrics:  metricsMap[campId] || null,
        adGroups: [],
        locations: [],
      };
    });

    adGroups.forEach(row => {
      const camp = campMap[String(row.campaign.id)];
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
      const camp = campMap[String(row.campaign.id)];
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
      const camp = campMap[String(row.campaign.id)];
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
        locations: locations.length,
        hasBudgets: budgets.length > 0,
        hasMetrics: metrics.length > 0,
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
// PARSE TASK — MULTI-ACCOUNT
// Accepts task + multiple account structures → returns changes grouped by account
// ─────────────────────────────────────────────────────────────
app.post('/api/parse-task-multi', requireAuth, async (req, res) => {
  const { task, accounts } = req.body;
  if (!task) return res.status(400).json({ error: 'No task provided' });
  if (!accounts || !Array.isArray(accounts) || accounts.length === 0) {
    return res.status(400).json({ error: 'No accounts provided' });
  }
  if (accounts.length > 20) {
    return res.status(400).json({ error: 'Maximum 20 accounts per batch. Got ' + accounts.length });
  }

  const systemPrompt = buildClaudeSystemPrompt(true);

  // Build multi-account structure for Claude
  const accountStructures = accounts.map(a => {
    const campList = (a.structure?.campaigns || []).map(c => {
      const ags = c.adGroups.map(ag => {
        const kwSample = ag.keywords.slice(0, 20).map(k => k.text).join(', ');
        const kwExtra = ag.keywords.length > 20 ? ` (+${ag.keywords.length - 20} more)` : '';
        return `    📁 "${ag.name}" | ${ag.status} | bid:$${ag.defaultBid} | ${ag.keywords.length} keywords: ${kwSample}${kwExtra}`;
      }).join('\n');
      const budgetStr = c.budget !== '?' ? `$${c.budget}/day` : 'budget unknown';
      const metricsStr = c.metrics ? ` | 30d: ${c.metrics.impressions} imp, ${c.metrics.clicks} clk, $${c.metrics.cost} spend` : '';
      return `  📢 "${c.name}" | ${c.status} | ${budgetStr} | ${c.type}${metricsStr}\n${ags}`;
    }).join('\n');
    return `ACCOUNT: ${a.name} (ID: ${a.id})\n${campList}`;
  }).join('\n\n---\n\n');

  const userMessage = `${accountStructures}\n\nFRESHDESK TASK:\n${task}`;

  try {
    const { data } = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model:      'claude-sonnet-4-20250514',
        max_tokens: 16384,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: userMessage }],
      },
      { headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } }
    );

    const raw   = data.content?.[0]?.text || '';
    const clean = raw.replace(/```json|```/gi, '').trim();
    try {
      const parsed = JSON.parse(clean);
      res.json(parsed);
    } catch (parseErr) {
      console.error('Failed to parse Claude multi-account response (possible truncation). Raw length:', raw.length);
      res.status(500).json({ error: 'Claude response was not valid JSON — it may have been truncated. Try fewer accounts.' });
    }
  } catch (err) {
    console.error('Claude multi-account error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to parse multi-account task: ' + err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// APPLY CHANGES — BATCH (multi-account)
// Applies changes across multiple accounts in parallel
// ─────────────────────────────────────────────────────────────
app.post('/api/apply-changes-batch', requireAuth, async (req, res) => {
  const { accountChanges, dryRun = true } = req.body;
  if (!accountChanges || !Array.isArray(accountChanges) || accountChanges.length === 0) {
    return res.status(400).json({ error: 'No account changes provided' });
  }
  if (accountChanges.length > 20) {
    return res.status(400).json({ error: 'Maximum 20 accounts per batch' });
  }

  // Verify all account IDs are accessible to this user
  const accessible = req.session.accessibleAccounts || [];
  if (accessible.length === 0) {
    return res.status(403).json({ error: 'Account list not loaded. Please refresh accounts first.' });
  }
  const unauthorized = accountChanges
    .map(ac => String(ac.accountId))
    .filter(id => !accessible.includes(id));
  if (unauthorized.length > 0) {
    return res.status(403).json({ error: `Unauthorized account IDs: ${unauthorized.join(', ')}` });
  }

  const mccId = req.session.mccId;

  // Concurrency limiter — max 5 accounts processed in parallel
  const CONCURRENCY = 5;
  const queue = [...accountChanges];
  const allResults = [];
  while (queue.length > 0) {
    const batch = queue.splice(0, CONCURRENCY);
    const batchRes = await Promise.allSettled(
      batch.map(async ({ accountId, changes }) => processAccount(req, mccId, accountId, changes, dryRun))
    );
    allResults.push(...batchRes);
  }

  const accountResults = allResults.map(r => r.status === 'fulfilled' ? r.value : { error: r.reason?.message || 'Unknown error', results: [], applied: 0, failed: 0 });

  const response = {
    dryRun,
    accountResults,
    totalApplied: accountResults.reduce((sum, a) => sum + (a.applied || 0), 0),
    totalFailed:  accountResults.reduce((sum, a) => sum + (a.failed || 0), 0),
  };

  // Log batch to session history (skip dry runs)
  if (!dryRun) {
    if (!req.session.history) req.session.history = [];
    accountResults.forEach(ar => {
      if (ar.applied > 0 || ar.failed > 0) {
        req.session.history.unshift({
          timestamp: new Date().toISOString(),
          customerId: ar.accountId,
          accountName: ar.accountId,
          batch: true,
          applied: ar.applied || 0,
          failed: ar.failed || 0,
          total: ar.total || 0,
          changes: (ar.results || []).map(r => ({
            type: r.change?.type,
            campaign: r.change?.campaignName,
            adGroupName: r.change?.adGroupName || null,
            details: r.change?.details || null,
            success: r.success,
            result: r.result,
          })),
        });
      }
    });
    if (req.session.history.length > 50) req.session.history.length = 50;
  }

  res.json(response);
});

async function processAccount(req, mccId, accountId, changes, dryRun) {
  if (!accountId || !/^\d+$/.test(String(accountId))) {
    return { accountId, error: 'Invalid accountId', results: [], applied: 0, failed: changes?.length || 0 };
  }
  if (!Array.isArray(changes) || changes.length === 0) {
    return { accountId, results: [], applied: 0, failed: 0, total: 0 };
  }

  const customerConfig = {
    customer_id:   accountId,
    refresh_token: req.session.tokens.refresh_token,
  };
  if (mccId) customerConfig.login_customer_id = mccId;

  const client = new GoogleAdsApi({
    client_id:       process.env.GOOGLE_ADS_CLIENT_ID,
    client_secret:   process.env.GOOGLE_ADS_CLIENT_SECRET,
    developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
  }).Customer(customerConfig);

  const results = [];
  const errors = [];
  const warnings = [];
  for (const change of changes) {
    try {
      let timer;
      const result = await Promise.race([
        applyChange(client, change, dryRun).finally(() => clearTimeout(timer)),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`Change timed out after 30s: ${change.type}`)), 30000); })
      ]);
      results.push({ change, result, success: true });
      console.log(`Batch [${accountId}] [${dryRun ? 'DRY RUN' : 'LIVE'}]: ${change.type} — ${change.campaignName || 'N/A'}`);
    } catch (err) {
      const msg = err.message || 'Unknown error';
      const isTimeout = msg.includes('timed out');
      console.error(`Batch [${accountId}] failed: ${change.type} — ${msg}`);
      if (isTimeout && !dryRun) {
        warnings.push(`${change.type} on "${change.campaignName || 'unknown'}" timed out — may have still been applied. Verify in Google Ads.`);
      }
      errors.push({ change, error: msg });
      results.push({ change, result: msg, success: false });
    }
  }

  return {
    accountId,
    applied: results.filter(r => r.success).length,
    failed:  errors.length,
    total:   changes.length,
    results,
    errors,
    warnings,
  };
}

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
  if (!Array.isArray(changes) || changes.length === 0) {
    return res.status(400).json({ error: 'Changes must be a non-empty array' });
  }
  if (!/^\d+$/.test(String(customerId))) {
    return res.status(400).json({ error: 'Invalid customerId format' });
  }
  // Verify account ownership
  const accessible = req.session.accessibleAccounts || [];
  if (accessible.length > 0 && !accessible.includes(String(customerId))) {
    return res.status(403).json({ error: 'Unauthorized account ID' });
  }

  const results  = [];
  const errors   = [];

  let client;
  try {
    const mccId = req.session.mccId;
    const customerConfig = {
      customer_id:   customerId,
      refresh_token: req.session.tokens.refresh_token,
    };
    if (mccId) customerConfig.login_customer_id = mccId;

    client = new GoogleAdsApi({
      client_id:       process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret:   process.env.GOOGLE_ADS_CLIENT_SECRET,
      developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    }).Customer(customerConfig);
  } catch (err) {
    console.error('Apply error: failed to initialize Google Ads client:', err.message);
    return res.status(500).json({ error: 'Failed to initialize Google Ads client: ' + err.message });
  }

  const warnings = [];

  for (const change of changes) {
    try {
      let timer;
      let timedOut = false;
      const result = await Promise.race([
        applyChange(client, change, dryRun).finally(() => clearTimeout(timer)),
        new Promise((_, rej) => {
          timer = setTimeout(() => {
            timedOut = true;
            rej(new Error(`Change timed out after 30s: ${change.type}`));
          }, 30000);
        })
      ]);
      results.push({ change, result, success: true });
      console.log(`Change applied [${dryRun ? 'DRY RUN' : 'LIVE'}]: ${change.type} — ${change.campaignName || 'N/A'}`);
    } catch (err) {
      const msg = err.message || 'Unknown error';
      const isTimeout = msg.includes('timed out');
      console.error(`Change failed: ${change.type} — ${change.campaignName || 'N/A'} — ${msg}`);
      if (isTimeout && !dryRun) {
        warnings.push(`${change.type} on "${change.campaignName || 'unknown'}" timed out — the change may have still been applied server-side. Please verify in Google Ads.`);
        console.warn(`TIMEOUT WARNING: ${change.type} on ${change.campaignName} — mutation may have completed despite timeout`);
      }
      errors.push({ change, error: msg });
      results.push({ change, result: msg, success: false });
    }
  }

  const response = {
    dryRun,
    applied: results.filter(r => r.success).length,
    failed:  errors.length,
    total:   changes.length,
    results,
    errors,
    warnings,
  };

  // Log to session history (skip dry runs)
  if (!dryRun) {
    if (!req.session.history) req.session.history = [];
    req.session.history.unshift({
      timestamp: new Date().toISOString(),
      customerId,
      accountName: req.body.accountName || customerId,
      applied: response.applied,
      failed:  response.failed,
      total:   response.total,
      changes: results.map(r => ({
        type: r.change.type,
        campaign: r.change.campaignName,
        adGroupName: r.change.adGroupName || null,
        details: r.change.details || null,
        success: r.success,
        result: r.result,
      })),
    });
    // Cap history at 50 entries
    if (req.session.history.length > 50) req.session.history.length = 50;
  }

  res.json(response);
});

// ─────────────────────────────────────────────────────────────
// CHANGE HISTORY
// ─────────────────────────────────────────────────────────────
app.get('/api/history', requireAuth, (req, res) => {
  res.json({ history: req.session.history || [] });
});

app.post('/api/undo', requireAuth, async (req, res) => {
  const { historyIndex } = req.body;
  const history = req.session.history || [];

  if (historyIndex == null || !Number.isInteger(historyIndex) || historyIndex < 0 || historyIndex >= history.length) {
    return res.status(400).json({ error: 'Invalid history index' });
  }

  const entry = history[historyIndex];
  if (entry.undone) {
    return res.status(400).json({ error: 'This entry has already been undone' });
  }

  const reversible = {
    pause_campaign: 'enable_campaign',
    enable_campaign: 'pause_campaign',
    pause_ad_group: 'enable_ad_group',
    enable_ad_group: 'pause_ad_group',
    pause_keyword: 'enable_keyword',
    enable_keyword: 'pause_keyword',
  };

  const undoChanges = [];
  for (const c of entry.changes) {
    if (!c.success) continue;
    const reverseType = reversible[c.type];
    if (!reverseType) continue;
    undoChanges.push({
      type: reverseType,
      campaignName: c.campaign,
      adGroupName: c.adGroupName || null,
      details: c.details || null,
    });
  }

  if (undoChanges.length === 0) {
    return res.status(400).json({ error: 'No reversible changes found in this history entry' });
  }

  // Apply undo changes
  const mccId = req.session.mccId;
  const customerConfig = {
    customer_id:   entry.customerId,
    refresh_token: req.session.tokens.refresh_token,
  };
  if (mccId) customerConfig.login_customer_id = mccId;

  try {
    const client = new GoogleAdsApi({
      client_id:       process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret:   process.env.GOOGLE_ADS_CLIENT_SECRET,
      developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    }).Customer(customerConfig);

    const results = [];
    for (const change of undoChanges) {
      try {
        const result = await applyChange(client, change, false);
        results.push({ change, result, success: true });
      } catch (err) {
        results.push({ change, result: err.message, success: false });
      }
    }

    // Mark original entry as undone
    entry.undone = true;

    // Log undo to history
    req.session.history.unshift({
      timestamp: new Date().toISOString(),
      customerId: entry.customerId,
      accountName: entry.accountName,
      isUndo: true,
      undoOf: entry.timestamp,
      applied: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      total: results.length,
      changes: results.map(r => ({
        type: r.change.type,
        campaign: r.change.campaignName || r.change.campaign,
        success: r.success,
        result: r.result,
      })),
    });
    if (req.session.history.length > 50) req.session.history.length = 50;

    res.json({
      applied: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results,
    });
  } catch (err) {
    console.error('Undo error:', err.message);
    res.status(500).json({ error: 'Undo failed: ' + err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// SMART SUGGESTIONS — Claude analyses account and flags issues
// ─────────────────────────────────────────────────────────────
app.post('/api/smart-suggestions', requireAuth, async (req, res) => {
  const { accountName, accountStructure } = req.body;
  if (!accountStructure) return res.json({ suggestions: [] });

  try {
    const userMsg = buildUserMessage('Analyse this account for issues.', accountStructure, accountName);
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: `You are a Google Ads expert for automotive dealerships. Analyse the account structure and return a JSON array of actionable suggestions.

Return ONLY valid JSON, no markdown:
{
  "suggestions": [
    {
      "icon": "emoji icon",
      "text": "description of the issue or opportunity",
      "action": "pre-filled task text the user can apply (optional)",
      "actionLabel": "short button label (optional)"
    }
  ]
}

Focus on:
- Paused campaigns that might need re-enabling
- Campaigns with $0 spend or 0 impressions in 30 days
- Very high CPC keywords (>$10)
- Ad groups with no keywords
- Budgets that seem too low or too high relative to performance
- Missing negative keywords for common automotive terms

Return max 5 most impactful suggestions. If account looks healthy, return empty array.`,
      messages: [{ role: 'user', content: userMsg }],
    }, {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: 30000,
    });

    const raw = response.data?.content?.[0]?.text || '{}';
    const parsed = JSON.parse(raw);
    res.json({ suggestions: parsed.suggestions || [] });
  } catch (e) {
    console.warn('Smart suggestions failed:', e.message);
    res.json({ suggestions: [] });
  }
});

// ─────────────────────────────────────────────────────────────
// NATURAL LANGUAGE REPORT — Claude summarises account performance
// ─────────────────────────────────────────────────────────────
app.post('/api/report', requireAuth, async (req, res) => {
  const { accountName, accountStructure } = req.body;
  if (!accountStructure) return res.status(400).json({ error: 'No account structure provided' });

  try {
    const userMsg = buildUserMessage('Generate a performance report.', accountStructure, accountName);
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: `You are a Google Ads expert for automotive dealerships. Generate a concise, actionable performance report for this account.

Return ONLY valid JSON:
{
  "report": "plain text report with line breaks"
}

Include:
- Overall account health summary (1-2 sentences)
- Top performing campaigns by clicks/conversions
- Underperforming campaigns (low CTR, high cost, no conversions)
- Budget utilisation observations
- Keyword health (paused vs active ratio, high-bid keywords)
- 2-3 specific recommendations

Keep it concise — max 300 words. Use plain text with line breaks, no markdown.`,
      messages: [{ role: 'user', content: userMsg }],
    }, {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: 30000,
    });

    const raw = response.data?.content?.[0]?.text || '{}';
    const parsed = JSON.parse(raw);
    res.json({ report: parsed.report || 'Unable to generate report.' });
  } catch (e) {
    console.error('Report generation failed:', e.response?.data || e.message);
    res.status(500).json({ error: 'Failed to generate report: ' + e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// FRESHDESK WEBHOOK — accept tasks from Freshdesk
// ─────────────────────────────────────────────────────────────
app.post('/api/freshdesk-webhook', async (req, res) => {
  const { task, account_id, account_name, api_key } = req.body;

  // Timing-safe API key auth for webhook
  const expectedKey = process.env.FRESHDESK_WEBHOOK_KEY;
  const keyBuf = Buffer.from(String(api_key || ''));
  const expectedBuf = Buffer.from(String(expectedKey || ''));
  if (!expectedKey || !api_key || typeof api_key !== 'string' ||
      keyBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(keyBuf, expectedBuf)) {
    return res.status(401).json({ error: 'Invalid or missing api_key' });
  }
  if (!task) return res.status(400).json({ error: 'Missing task field' });
  if (!account_id) return res.status(400).json({ error: 'Missing account_id field' });
  const cleanAccountId = String(account_id).replace(/-/g, '');
  if (!/^\d+$/.test(cleanAccountId)) return res.status(400).json({ error: 'Invalid account_id format' });

  console.log(`Freshdesk webhook: account ${account_id}, task: ${task.substring(0, 100)}...`);

  try {
    // Build a Google Ads API client using env credentials
    const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
    if (!refreshToken) return res.status(500).json({ error: 'Server not configured with GOOGLE_REFRESH_TOKEN for webhook mode' });

    const api = new GoogleAdsApi({
      client_id:     process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
      developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    });
    const mccId = process.env.GOOGLE_MANAGER_ACCOUNT_ID?.replace(/-/g, '');
    const customerConfig = {
      customer_id: cleanAccountId,
      refresh_token: refreshToken,
    };
    if (mccId) customerConfig.login_customer_id = mccId;
    const client = api.Customer(customerConfig);

    // Parse the task via Claude (dry-run only — returns plan, does not apply)
    const systemPrompt = buildClaudeSystemPrompt();
    const userMsg = `ACCOUNT: ${account_name || account_id}\n\nFRESHDESK TASK:\n${task}`;
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMsg }],
    }, {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: 30000,
    });

    const raw = response.data?.content?.[0]?.text || '{}';
    const parsed = JSON.parse(raw);
    res.json({ status: 'parsed', plan: parsed });
  } catch (e) {
    console.error('Freshdesk webhook error:', e.response?.data || e.message);
    res.status(500).json({ error: 'Failed to process task: ' + e.message });
  }
});

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

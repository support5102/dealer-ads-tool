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
app.use(express.static(path.join(__dirname, 'public')));

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
  try {
    const client = new GoogleAdsApi({
      client_id:       process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret:   process.env.GOOGLE_ADS_CLIENT_SECRET,
      developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    });

    // List all accessible customers using the access token
    const { data } = await axios.get(
      'https://googleads.googleapis.com/v17/customers:listAccessibleCustomers',
      { headers: { Authorization: `Bearer ${req.session.tokens.access_token}` } }
    );

    const resourceNames = data.resourceNames || [];
    const accounts = [];

    for (const resourceName of resourceNames) {
      const customerId = resourceName.replace('customers/', '');
      try {
        const customer = client.Customer({
          customer_id:   customerId,
          refresh_token: req.session.tokens.refresh_token,
        });

        const [info] = await customer.query(`
          SELECT
            customer.id,
            customer.descriptive_name,
            customer.currency_code,
            customer.time_zone,
            customer.manager
          FROM customer
          LIMIT 1
        `);

        if (info) {
          accounts.push({
            id:       String(info.customer.id),
            name:     info.customer.descriptive_name || `Account ${info.customer.id}`,
            currency: info.customer.currency_code,
            timezone: info.customer.time_zone,
            isManager: info.customer.manager,
          });
        }
      } catch (e) {
        // Skip accounts we can't read (permission issues etc)
        console.warn(`Skipping account ${customerId}:`, e.message);
      }
    }

    // Sort: manager accounts first, then alphabetically
    accounts.sort((a, b) => {
      if (a.isManager !== b.isManager) return a.isManager ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    res.json({ accounts });
  } catch (err) {
    console.error('Accounts error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to load accounts: ' + (err.message || 'Unknown error') });
  }
});

// ─────────────────────────────────────────────────────────────
// GET ACCOUNT STRUCTURE (campaigns, ad groups, keywords etc)
// Called when user selects an account — builds the context for Claude
// ─────────────────────────────────────────────────────────────
app.get('/api/account/:customerId/structure', requireAuth, async (req, res) => {
  const { customerId } = req.params;

  try {
    const client = new GoogleAdsApi({
      client_id:       process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret:   process.env.GOOGLE_ADS_CLIENT_SECRET,
      developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    }).Customer({
      customer_id:   customerId,
      refresh_token: req.session.tokens.refresh_token,
      login_customer_id: customerId,
    });

    // Fetch campaigns
    const campaigns = await client.query(`
      SELECT
        campaign.id,
        campaign.name,
        campaign.status,
        campaign.advertising_channel_type,
        campaign.bidding_strategy_type,
        campaign_budget.amount_micros,
        campaign_budget.name,
        campaign_budget.shared_set
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
      const b = row.campaign_budget;
      campMap[c.name] = {
        id:       String(c.id),
        name:     c.name,
        status:   c.status,
        type:     c.advertising_channel_type,
        bidding:  c.bidding_strategy_type,
        budget:   b ? (b.amount_micros / 1_000_000).toFixed(2) : '?',
        budgetName: b?.name || '',
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
    console.error('Structure error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to load account structure: ' + err.message });
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
      login_customer_id: customerId,
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

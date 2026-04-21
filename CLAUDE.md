# Dealer Ads Tool V3 - Development Guidelines

## Quick Reference

| Item | Value |
|------|-------|
| **Repository** | https://github.com/support5102/dealer-ads-tool (branch: V3) |
| **Tech Stack** | JavaScript, Node.js 18+, Express.js, Jest |
| **Machine Mode** | SINGLE |
| **Test Command** | `npm test` |
| **Local Port** | 3000 |
| **Deployment** | Railway (auto-deploy from V3 branch) |

---

## Context Management

### Principles

1. **Selective loading over bulk reading** — Read targeted sections of files, not entire files. Use grep/search to find relevant lines first, then read only what's needed.
2. **Subagents for exploration** — Codebase investigation, dependency tracing, and multi-file searches should use subagents. They run in their own context and return summaries, keeping the main window clean.
3. **Externalize to documentation** — If information is captured in project-state.md or session logs, don't keep the raw working history in context. Trust the docs.
4. **Shorter sessions, cleaner context** — A focused 30-minute session with clean context produces better results than a 3-hour marathon with degraded attention.

### Session Discipline

**Default to short, focused sessions.** A clean 30–45 minute session with fresh context produces dramatically better results than a 2-hour marathon where the last hour runs on compacted summaries.

### File Reading Rules

- For files >200 lines, always use line-range reading (read specific sections, not the whole file)
- Use grep/search to find relevant lines first, then read targeted ranges
- After reading a file for reference, extract what you need into a working plan — don't rely on it staying "fresh" in context
- If a task requires reading more than 5 files, use a subagent to investigate and report back

### Response Discipline

During active implementation (writing code, running tests, fixing bugs):

- **Be concise.** Show the code change and the result. Skip the explanation unless asked or the reasoning is non-obvious.
- **Don't re-explain decisions** that were already made this session.
- **Don't show full file contents after an edit** — show only the changed section and enough surrounding lines for orientation.
- **Don't narrate tool usage.** Just run the command.
- **Batch related operations.** If you need to read 3 sections of the same file, do it in one read with a range, not three separate reads.

---

## Data Flow

```
┌─────────────────────────────────────────────────┐
│  BROWSER (public/app.js)                        │
│                                                 │
│  1. User connects Google Ads (OAuth)            │
│  2. Selects dealer account from MCC dropdown    │
│  3. Pastes Freshdesk task in text area           │
│  4. Reviews AI-generated change plan            │
│  5. Clicks "Dry Run" or "Apply Changes"         │
└──────────────┬──────────────────────────────────┘
               │ HTTP API calls
               ▼
┌─────────────────────────────────────────────────┐
│  EXPRESS SERVER (src/server.js)                  │
│                                                 │
│  Middleware: session, CORS, JSON, errorHandler   │
│                                                 │
│  Routes:                                        │
│  ├── /auth/*           → routes/auth.js         │
│  ├── /api/accounts     → routes/accounts.js     │
│  ├── /api/account/:id  → routes/accounts.js     │
│  ├── /api/parse-task   → routes/changes.js      │
│  └── /api/apply-changes→ routes/changes.js      │
└──────────────┬──────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────┐
│  SERVICES                                       │
│                                                 │
│  google-ads.js:                                 │
│  - Creates API client from OAuth refresh token  │
│  - Runs GAQL queries (campaigns, ad groups, kw) │
│  - Executes mutations (pause, enable, create)   │
│                                                 │
│  claude-parser.js:                              │
│  - Builds system prompt (Google Ads expert)     │
│  - Serializes account structure for context     │
│  - Calls Anthropic API → structured JSON plan   │
│                                                 │
│  change-executor.js:                            │
│  - Handles 10 change types:                     │
│    pause/enable campaign, update budget,        │
│    pause/enable ad group, pause/add keyword,    │
│    add negative keyword, add/exclude radius     │
│  - Each type: lookup entity → mutate via API    │
└─────────────────────────────────────────────────┘
```

---

## Test-Driven Development

### The TDD Cycle

For all new features, follow **Red → Green → Refactor**:

1. **Red**: Write a failing test that defines expected behavior
2. **Green**: Write minimum code to make the test pass
3. **Refactor**: Clean up while keeping tests green

### Test Tiers

| Tier | Name | Location | What It Tests |
|------|------|----------|---------------|
| 1 | Config | `tests/config/` | Env validation, sanitization rules, config defaults |
| 2 | Unit | `tests/unit/` | Claude prompt builder, change executor logic, structure builder |
| 3 | Integration | `tests/integration/` | Express route handlers, end-to-end API flows |

**Tier 1: Config Tests** (run anywhere, no external deps)
- Environment variable validation (required vars present, valid formats)
- GAQL sanitization rules (dangerous inputs blocked)
- Config defaults applied correctly

**Tier 2: Unit Tests** (run anywhere, uses fakes)
- Claude prompt builder produces valid JSON prompts
- Change executor handles all 10 change types
- Account structure builder assembles tree correctly from query results
- Error cases: missing campaigns, invalid change types, malformed AI responses

**Tier 3: Integration Tests** (needs running server)
- OAuth flow redirects correctly
- API routes return correct status codes
- Auth middleware blocks unauthenticated requests
- Parse-task and apply-changes routes handle edge cases

### Test Organization

```
tests/
├── config/
│   ├── test_env_validation.js
│   └── test_sanitize.js
├── unit/
│   ├── test_claude_parser.js
│   ├── test_change_executor.js
│   └── test_structure_builder.js
├── integration/
│   ├── test_auth_routes.js
│   ├── test_account_routes.js
│   └── test_change_routes.js
└── fakes/
    ├── google-ads-fake.js    # In-memory Google Ads client
    └── claude-api-fake.js    # Fake Anthropic API responses
```

### Naming Convention

```javascript
describe('changeExecutor', () => {
  test('pause_campaign with valid name pauses the campaign', () => {
    // Arrange
    // Act
    // Assert
  });

  test('pause_campaign with missing name throws descriptive error', () => {
    // Arrange
    // Act
    // Assert
  });
});
```

### Fakes Over Mocks

**Never use jest.mock() for core logic tests.** Instead, create fakes:

```javascript
// tests/fakes/google-ads-fake.js
class FakeGoogleAdsClient {
  constructor() {
    this.campaigns = [
      { id: '1', name: 'Honda Civic - Search', status: 'ENABLED', budget: 50 },
      { id: '2', name: 'Toyota Trucks', status: 'PAUSED', budget: 100 },
    ];
    this.mutations = []; // Track what was changed
  }

  async query(gaql) {
    // Return fake data based on query pattern
  }

  async update(changes) {
    this.mutations.push(changes);
  }
}
```

### Running Tests

```bash
# All tests
npm test

# By tier
npm run test:config
npm run test:unit
npm run test:integration

# Single file
npx jest tests/unit/test_change_executor.js

# With coverage
npm run test:coverage

# Watch mode during development
npx jest --watch
```

---

## Code Documentation Standards

### The Four Documentation Layers

| Layer | Purpose | When Required |
|-------|---------|---------------|
| Module header | What this file does, who calls it | Every source file |
| JSDoc comments | Function interface contracts | Public functions, complex private functions |
| Inline comments | Why a non-obvious choice was made | Only when the "why" isn't self-evident |
| JSDoc @param/@returns | Data shape documentation | All exported function signatures |

### Module Headers

Every source file starts with a block comment explaining:
1. What this module is responsible for (one sentence)
2. Where it sits in the data flow (what calls it, what it calls)

```javascript
/**
 * Change Executor — applies individual change types against the Google Ads API.
 *
 * Called by: routes/changes.js (POST /api/apply-changes)
 * Calls: services/google-ads.js (GAQL queries + mutations)
 *
 * Each change type (pause_campaign, add_keyword, etc.) is a separate function
 * that looks up the target entity and executes the appropriate mutation.
 */
```

### Function Documentation

```javascript
/**
 * Applies a single change to a Google Ads account.
 *
 * @param {Object} client - Authenticated Google Ads API client
 * @param {Object} change - Structured change from Claude parser
 * @param {string} change.type - One of: pause_campaign, enable_campaign, update_budget, etc.
 * @param {string} change.campaignName - Exact campaign name from account
 * @param {string} [change.adGroupName] - Exact ad group name (if applicable)
 * @param {Object} [change.details] - Type-specific details (budget amount, keyword text, etc.)
 * @param {boolean} dryRun - If true, return description without executing
 * @returns {Promise<string>} Human-readable result message
 * @throws {Error} If campaign/ad group not found or API call fails
 */
async function applyChange(client, change, dryRun) {
```

---

## Project-Specific Sections

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GOOGLE_ADS_DEVELOPER_TOKEN` | (required) | Google Ads API developer token |
| `GOOGLE_ADS_CLIENT_ID` | (required) | OAuth 2.0 client ID |
| `GOOGLE_ADS_CLIENT_SECRET` | (required) | OAuth 2.0 client secret |
| `SESSION_SECRET` | (required) | Express session encryption key |
| `APP_URL` | `http://localhost:3000` | Base URL for OAuth callback |
| `PORT` | `3000` | Server listen port |
| `ANTHROPIC_API_KEY` | (required) | Claude API key for task parsing |
| `CLAUDE_MODEL` | `claude-sonnet-4-20250514` | Claude model for task parsing |
| `PACING_ENGINE_V2_ENABLED` | `false` | Enables daily pacing scheduler + new "since last change" overview columns + Pacing Recommender v2 delegation |
| `CHANGE_ALERTS_ENABLED` | `false` | Enables R8 change-detection alerts — daily scan of Google Ads `change_event` + Freshdesk ticket creation for budget/campaign/ad-group/location changes. Independent of the pacing flag. |
| `USE_DB_GOALS` | `false` | When true, reads dealer goals from Postgres instead of Google Sheets. One-time migration via dealers page Import button; flip flag after verifying. |

### Key Files

| File | Purpose |
|------|---------|
| `src/server.js` | Express app setup, middleware, static serving |
| `src/routes/auth.js` | OAuth flow (connect, callback, logout, status) |
| `src/routes/accounts.js` | MCC account listing, account structure loading |
| `src/routes/changes.js` | Task parsing via Claude, change application |
| `src/services/google-ads.js` | Google Ads API client factory + GAQL queries |
| `src/services/claude-parser.js` | Claude prompt building + API call |
| `src/services/change-executor.js` | 10 change type handlers |
| `src/services/pacing-curve.js` | Pacing Engine v2 — pure-function curve registry (linear, alanJay9505) |
| `src/services/pacing-engine-v2.js` | Pacing Engine v2 — damped daily controller (`proposeAdjustment` + `runForAccount`) |
| `src/services/pacing-engine-runner.js` | Pacing Engine v2 — daily scheduler entry point |
| `src/services/pacing-engine-deps.js` | Pacing Engine v2 — enriches route pacing results with `currentDailyBudget` + `bidStrategyType` for the advisory hook |
| `src/services/pacing-fetcher.js` | Per-account pacing data fetcher (spend, curve target, pacingSinceLastChange). When v2 flag is on, enriches with inventory tier. |
| `src/services/recommender-v2.js` | Pacing Recommender v2 — wraps pacing-engine-v2 + applies R1 direction-invariant, R3 IS targeting, R4 shared-budget-binding, R5 campaign-weight reshape, R7 rationale composition |
| `src/services/diagnostic-analyzer.js` | Pacing Recommender v2 — R6 diagnostic checks (QS, ad disapproval, narrow geo, ad schedule, low bids, negative-keyword block, fall-through) |
| `src/services/savvy-inventory.js` | Savvy Incentive API wrapper — new-VIN count per dealer, 4h cache |
| `src/services/site-id-registry.js` | Dealer → Savvy site_id mapping (DB-backed, normalized fuzzy lookup) |
| `src/services/inventory-baseline-store.js` | Rolling 90-day new-inventory baseline per dealer + tier classifier |
| `src/services/inventory-baseline-runner.js` | Daily scheduled job — samples inventory for all mapped dealers |
| `src/services/change-alerts-runner.js` | R8 change-detection runner — scans Google Ads change_event, creates Freshdesk tickets for budget/campaign/ad-group/location changes |
| `src/services/freshdesk.js` | Freshdesk API client — ticket listing + now `createTicket` for R8 alerts |
| `src/middleware/auth.js` | requireAuth middleware |
| `src/middleware/error-handler.js` | Centralized error response formatting |
| `src/utils/config.js` | Environment variable validation |
| `src/utils/sanitize.js` | GAQL query input sanitization |
| `public/index.html` | Frontend HTML |
| `public/styles.css` | Frontend CSS |
| `public/app.js` | Frontend JavaScript |
| `src/services/dealer-goals-store.js` | Postgres-backed dealer goals store + budget-change audit log (mandatory note) |
| `src/routes/dealers.js` | Dealer admin CRUD + budget-edit with audit + one-time sheet-to-DB import |
| `public/dealers.html` | Dealer admin page (list, add, edit, delete, budget history, import from sheet) |

### External Services

| Service | Purpose | Access |
|---------|---------|--------|
| Google Ads API (v19) | Campaign/ad group/keyword management | OAuth 2.0 + Developer Token |
| Anthropic Claude API | Parse Freshdesk tasks into structured changes | API Key |
| Railway | Hosting + deployment | Git push to V3 branch |

### Change Types Reference

These are the 10 change types the tool can execute against Google Ads:

| Type | What It Does | Required Fields |
|------|-------------|-----------------|
| `pause_campaign` | Set campaign status to PAUSED | campaignName |
| `enable_campaign` | Set campaign status to ENABLED | campaignName |
| `update_budget` | Change campaign daily budget | campaignName, details.newBudget |
| `pause_ad_group` | Set ad group status to PAUSED | campaignName, adGroupName |
| `enable_ad_group` | Set ad group status to ENABLED | campaignName, adGroupName |
| `pause_keyword` | Set keyword status to PAUSED | campaignName, details.keyword, details.matchType |
| `add_keyword` | Add keyword to ad group | campaignName, adGroupName, details.keyword, details.matchType |
| `add_negative_keyword` | Add campaign-level negative | campaignName, details.keyword, details.matchType |
| `exclude_radius` | Add negative radius targeting | campaignName, details.lat, details.lng, details.radius |
| `add_radius` | Add positive radius targeting | campaignName, details.lat, details.lng, details.radius |

---

## Deployment Architecture

### Overview

| Environment | Purpose | URL | Command |
|-------------|---------|-----|---------|
| **Local** | Development + testing | http://localhost:3000 | `npm run dev` |
| **Production** | Live service | Railway URL | `git push origin V3` |

### Railway Configuration

| Setting | Value |
|---------|-------|
| **Platform** | Railway |
| **Build** | Nixpacks (auto-detect Node.js) |
| **Start Command** | `npm start` |
| **Health Check** | `/health` |
| **Branch** | V3 |

### Environment Variables

| Variable | Local Value | Production Value | Purpose |
|----------|-------------|------------------|---------|
| `PORT` | 3000 | Set by Railway | Server port |
| `APP_URL` | http://localhost:3000 | https://[app].up.railway.app | OAuth callback base |
| `SESSION_SECRET` | (from .env) | (Railway Variables tab) | Session encryption |
| `NODE_ENV` | development | production | Environment mode |

### Pre-Deployment Checklist

Before pushing to V3 branch:

- [ ] All tests pass (`npm test`)
- [ ] Changes committed
- [ ] Local server starts and works (`npm run dev`)
- [ ] Environment variables configured in Railway dashboard
- [ ] No secrets in code (all in env vars)

---

## Commit Message Format

```
type: [phase/context] - summary

Types:
- feat: New feature
- fix: Bug fix
- docs: Documentation only
- test: Adding/updating tests
- refactor: Code change that doesn't add feature or fix bug
- chore: Maintenance tasks

Examples:
- feat: Phase 1 - extracted auth routes from monolith
- fix: Phase 2 - sanitized GAQL query inputs
- docs: cleanup - session log and next steps update
- test: Phase 1 - added config validation tests
- refactor: Phase 1 - moved frontend to public directory
```

---

## Checklist Before Committing

- [ ] New logic has tests written first (Red → Green)
- [ ] All Tier 1 + 2 tests pass
- [ ] Test names describe behavior
- [ ] Each test verifies one behavior
- [ ] Module headers present on new/modified source files
- [ ] JSDoc comments on all new/modified exported functions
- [ ] Error messages include what went wrong AND what to fix
- [ ] Data flow section updated if architecture changed
- [ ] Documentation updated if behavior changed

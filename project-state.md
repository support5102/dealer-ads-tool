# Dealer Ads Tool — Project State

## Overview
Node.js/Express app for managing Google Ads campaigns across automotive dealer accounts via an MCC. Integrates Claude AI for natural-language task parsing from Freshdesk tickets. Deployed on Railway.

## Architecture
- **Single file:** `server.js` (~2600 lines) — embedded frontend HTML, all API routes, change executor, Claude prompt builder
- **No database** — stateless, session-only storage for OAuth tokens, MCC ID cache, and change history
- **Stack:** Express, google-ads-api, axios, Anthropic Claude API, express-session

## Endpoints
| Route | Method | Purpose |
|-------|--------|---------|
| `/` | GET | Serves embedded frontend |
| `/health` | GET | Railway health check |
| `/auth/google` | GET | OAuth initiation |
| `/auth/callback` | GET | OAuth callback |
| `/auth/logout` | GET | Destroy session |
| `/api/auth/status` | GET | Connection status |
| `/api/accounts` | GET | List all accessible accounts via MCC |
| `/api/account/:id/structure` | GET | Full account tree (campaigns, ad groups, keywords, locations, budgets, metrics) |
| `/api/parse-task` | POST | Claude parses single-account Freshdesk task → structured JSON changes |
| `/api/parse-task-multi` | POST | Claude parses multi-account task → changes grouped by account |
| `/api/apply-changes` | POST | Execute changes against single Google Ads account |
| `/api/apply-changes-batch` | POST | Execute changes across multiple accounts in parallel |
| `/api/history` | GET | Retrieve change history from session |
| `/api/undo` | POST | Undo a reversible change from history |

## Current Phase: Phase 5 Complete

### Phase 1: Reliability & Error Handling (completed 2026-03-20)
- [x] gadsSearch retry logic (1 retry, backoff on 429/500/503/network errors)
- [x] Per-account error logging with customerId context
- [x] MCC discovery: always re-discover from API, session cache as fallback only, warn on multiple MCCs
- [x] withTimeout wrappers on all structure queries (15-20s), proper timer cleanup
- [x] /api/apply-changes: input validation, separated client init, login_customer_id, per-change logging
- [x] GAQL escaping fix (doubled single quotes)
- [x] Removed dead campId variable in pause_ad_group
- [x] Improved error message extraction

### Phase 2: Budget & Data Gaps (completed 2026-03-20)
- [x] Fix budget display (separate campaign_budget query, mapped by campaign ID)
- [x] Parallelize all 6 structure queries via Promise.all
- [x] Campaign performance metrics (impressions, clicks, cost, conversions — last 30 days)
- [x] Keyword limit increased 500→1000, location limit 200→500
- [x] Per-change 30s timeout in apply-changes
- [x] Query latency instrumentation via timed() wrapper
- [x] Frontend passes mccId to structure endpoint
- [x] Frontend displays budget ($X.XX/day) and metrics inline
- [x] Claude prompt includes budget, metrics, truncated keywords (20/ad group)
- [x] Non-fatal catches on ad groups, budgets, locations, metrics queries
- [x] camelCase fallbacks for google-ads-api field access

### Phase 3: Multi-Account & Batch Operations (completed 2026-03-20)
- [x] Account search/filter input (shows when >5 accounts)
- [x] Multi-account Claude prompt with grouped accountChanges output
- [x] /api/parse-task-multi endpoint (max 20 accounts, 16384 max_tokens)
- [x] /api/apply-changes-batch endpoint with parallel per-account execution
- [x] Frontend: batch analyse, renderBatchPlan, batchApply with per-account results
- [x] XSS escaping via esc() helper across all innerHTML renders
- [x] Batch size cap (20 accounts) on both parse and apply endpoints
- [x] Claude JSON truncation handling
- [x] Button race condition fix (disable both during either operation)

### Phase 4: Audit Trail & History (completed 2026-03-20)
- [x] Session-based change history (capped at 50 entries)
- [x] /api/history endpoint for retrieving change log
- [x] /api/undo endpoint for reversible operations (pause↔enable campaigns/ad groups/keywords)
- [x] Added enable_keyword case to applyChange switch
- [x] History entries include adGroupName and details for undo fidelity
- [x] Undo idempotency via undone flag
- [x] Frontend history panel with undo buttons on reversible entries

### Phase 5: UI & UX Improvements (completed 2026-03-20)
- [x] Session middleware moved before all routes (was registered after / route)
- [x] Token refresh caching with expiry (skip refresh if token still valid, 5-min buffer)
- [x] token_expiry set during initial OAuth callback
- [x] campMap keyed by campaign ID instead of name (prevents duplicate name collisions)
- [x] campaign.id added to ad_group, keyword, and location GAQL queries

### Phase 6: Advanced AI Features (next)
- [ ] Task templates
- [ ] Smart suggestions (Claude flags issues proactively)
- [ ] Natural language reporting
- [ ] Freshdesk integration

## Known Issues
- No test suite
- Session secret has hardcoded fallback (`'change-this-secret'`)
- GAQL queries use string interpolation (parameterized queries preferred long-term)
- Timeout on apply-changes doesn't cancel in-flight API mutation
- Batch apply does not verify account ownership against session
- No concurrency limit on parallel batch API calls
- History is session-only (lost on restart) — needs persistent storage

## Deferred Items
- Account ownership verification in batch apply → future phase
- Concurrency control for batch operations → future phase
- Split monolithic server.js into modules → future phase
- Extract frontend to separate files → future phase
- Extract gadsSearch as reusable module → future phase

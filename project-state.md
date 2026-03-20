# Dealer Ads Tool — Project State

## Overview
Node.js/Express app for managing Google Ads campaigns across automotive dealer accounts via an MCC. Integrates Claude AI for natural-language task parsing from Freshdesk tickets. Deployed on Railway.

## Architecture
- **Single file:** `server.js` (~2400 lines) — embedded frontend HTML, all API routes, change executor, Claude prompt builder
- **No database** — stateless, session-only storage for OAuth tokens and MCC ID cache
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

## Current Phase: Phase 3 Complete

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

### Phase 4: Audit Trail & History (next)
- [ ] Lightweight database for change logs
- [ ] Undo support for reversible operations
- [ ] Daily digest

### Phase 5: UI & UX Improvements
- [ ] Split monolithic server.js into modules
- [ ] Extract frontend to separate files
- [ ] Loading states, keyboard shortcuts, dark mode
- [ ] campMap keyed by campaign ID instead of name (prevents collisions)
- [ ] Extract gadsSearch as reusable module

### Phase 6: Advanced AI Features
- [ ] Task templates
- [ ] Smart suggestions (Claude flags issues proactively)
- [ ] Natural language reporting
- [ ] Freshdesk integration

## Known Issues
- No test suite
- Session secret has hardcoded fallback (`'change-this-secret'`)
- GAQL queries use string interpolation (parameterized queries preferred long-term)
- campMap keyed by campaign name — duplicate names cause collisions
- Session middleware registered after `/` route (latent bug)
- Token refresh on every request (could cache expiry)
- Timeout on apply-changes doesn't cancel in-flight API mutation
- Batch apply does not verify account ownership against session
- No concurrency limit on parallel batch API calls

## Deferred Items
- campMap keyed by name → Phase 5 refactor
- Token refresh caching → Phase 5
- Session middleware ordering → Phase 5
- Account ownership verification in batch apply → Phase 5
- Concurrency control for batch operations → Phase 5

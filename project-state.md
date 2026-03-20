# Dealer Ads Tool — Project State

## Overview
Node.js/Express app for managing Google Ads campaigns across automotive dealer accounts via an MCC. Integrates Claude AI for natural-language task parsing from Freshdesk tickets. Deployed on Railway.

## Architecture
- **Single file:** `server.js` (~2900 lines) — embedded frontend HTML, all API routes, change executor, Claude prompt builder
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
| `/api/smart-suggestions` | POST | Claude analyses account and flags issues proactively |
| `/api/report` | POST | Claude generates natural language performance report |
| `/api/freshdesk-webhook` | POST | Accept tasks from Freshdesk webhooks (API key auth) |

## Current Phase: Phase 6 Complete (All Phases Done)

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

### Phase 6: Advanced AI Features (completed 2026-03-20)
- [x] Task templates (pause campaign, update budget, add negative KW, pause keywords, exclude radius, enable campaign)
- [x] Smart suggestions — Claude analyses account structure proactively, flags issues (paused campaigns, $0 spend, high CPC, empty ad groups)
- [x] Natural language reporting — Claude generates performance summaries on demand
- [x] Freshdesk webhook endpoint with timing-safe API key auth, account_id validation
- [x] XSS fix in suggestions panel (data attributes instead of inline onclick)
- [x] XSS fix in tree error display

### Phase 7: Security Hardening & Reliability (completed 2026-03-20)
- [x] Remove hardcoded session secret fallback — require SESSION_SECRET env var
- [x] Startup validation — exit with clear error if required env vars missing
- [x] Account ownership verification on both single and batch apply endpoints
- [x] Concurrency limit on batch API calls (cap at 5 concurrent via chunked loop)
- [x] gaqlEscape() helper — replaces all inline .replace() calls, validates length/type
- [x] matchType enum validation (EXACT/PHRASE/BROAD)
- [x] Timeout warnings returned to client for timed-out mutations
- [x] Fix env.example (was accidentally HTML)
- [x] Crypto import moved to top-level

### Phase 8: Modularization (next)
- [ ] Extract frontend HTML to public/index.html
- [ ] Extract gadsSearch to lib/gads-search.js
- [ ] Extract applyChange + gaqlEscape to lib/apply-change.js
- [ ] Extract Claude prompt builders to lib/claude-prompts.js
- [ ] Extract route handlers into routes/ directory
- [ ] server.js shrinks to ~50 lines

### Phase 9: Testing & Webhook Improvement
- [ ] Add Jest + Supertest test infrastructure
- [ ] Unit tests for applyChange and gaqlEscape
- [ ] Unit tests for Claude prompt builders
- [ ] Integration tests for route validation
- [ ] Freshdesk webhook: fetch account structure before Claude parse
- [ ] Persistent history with better-sqlite3

## Known Issues
- No test suite
- GAQL queries use string interpolation (parameterized queries preferred long-term)
- Timeout on apply-changes doesn't cancel in-flight API mutation
- History is session-only (lost on restart) — needs persistent storage
- Freshdesk webhook returns plan without account structure context (limited accuracy)

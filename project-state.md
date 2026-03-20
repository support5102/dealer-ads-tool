# Dealer Ads Tool — Project State

## Overview
Node.js/Express app for managing Google Ads campaigns across automotive dealer accounts via an MCC. Integrates Claude AI for natural-language task parsing from Freshdesk tickets. Deployed on Railway.

## Architecture
- **Single file:** `server.js` (~1800 lines) — embedded frontend HTML, all API routes, change executor, Claude prompt builder
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
| `/api/account/:id/structure` | GET | Full account tree (campaigns, ad groups, keywords, locations) |
| `/api/parse-task` | POST | Claude parses Freshdesk task → structured JSON changes |
| `/api/apply-changes` | POST | Execute changes against Google Ads API |

## Current Phase: Phase 1 Complete

### Phase 1: Reliability & Error Handling (completed 2026-03-20)
- [x] gadsSearch retry logic (1 retry, backoff on 429/500/503/network errors)
- [x] Per-account error logging with customerId context
- [x] MCC discovery: always re-discover from API, session cache as fallback only, warn on multiple MCCs
- [x] withTimeout wrappers on all structure queries (15-20s), proper timer cleanup
- [x] /api/apply-changes: input validation, separated client init, login_customer_id, per-change logging
- [x] GAQL escaping fix (doubled single quotes)
- [x] Removed dead campId variable in pause_ad_group
- [x] Improved error message extraction

### Phase 2: Budget & Data Gaps (next)
- [ ] Fix budget display (query campaign_budget separately)
- [ ] Keyword/location pagination instead of hard limits
- [ ] Campaign performance metrics (impressions, clicks, spend)
- [ ] Last-modified timestamps

### Phase 3: Multi-Account & Batch Operations
- [ ] Multi-account task parsing
- [ ] Batch apply across accounts
- [ ] Account selector/filter UI
- [ ] Account groups/labels

### Phase 4: Audit Trail & History
- [ ] Lightweight database for change logs
- [ ] Undo support for reversible operations
- [ ] Daily digest

### Phase 5: UI & UX Improvements
- [ ] Split monolithic server.js into modules
- [ ] Extract frontend to separate files
- [ ] Loading states, keyboard shortcuts, dark mode

### Phase 6: Advanced AI Features
- [ ] Task templates
- [ ] Smart suggestions (Claude flags issues proactively)
- [ ] Natural language reporting
- [ ] Freshdesk integration

## Known Issues
- Budget displays as "?" — permission constraints prevent JOIN
- Keywords capped at 500, locations at 200 (no pagination)
- Structure queries run sequentially (could be parallelized)
- No test suite
- Session secret has hardcoded fallback (`'change-this-secret'`)
- GAQL queries use string interpolation (parameterized queries preferred long-term)

## Deferred from Phase 1 Review
- Parallel structure queries → Phase 2
- Per-change timeout in apply-changes → Phase 2
- Extract gadsSearch as reusable module → Phase 5
- Instrument query latencies → Phase 2

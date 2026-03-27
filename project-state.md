# Dealer Ads Tool V3 - Project State

**Last Updated:** 2026-03-27
**Current Phase:** Phase 13: Smart Budget Auto-Adjuster — Phase 1 COMPLETE

---

## Phase Overview

| Phase | Name | Status | Summary |
|-------|------|--------|---------|
| 0 | Planning | ✅ COMPLETE | V2 audited, tech debt documented, architecture decided |
| 1 | Foundation — Split Monolith | ✅ COMPLETE | Modular architecture, 44 Tier 1 tests, config/sanitize hardened |
| 2 | Unit Tests — Business Logic | ✅ COMPLETE | 88 Tier 2 tests across parser, executor, structure builder |
| 3 | Integration + Hardening | ✅ COMPLETE | 48 Tier 3 tests, server factory refactor, all P0/P1 fixed |
| 4 | Deploy + Production Readiness | ✅ CODE COMPLETE | Production hardening, budget fix — deploy pending |
| 5 | Operational Reliability | ✅ COMPLETE | Audit logging, query timeouts, user identity, keyword limit |
| 6 | Feature Expansion | 📋 PLANNED | Change history UI, email notifications, Facebook Ads |
| 7 | Budget Pacing Dashboard | ✅ COMPLETE | Advisory pacing tool for multi-account budget management |
| 8 | Campaign Builder Integration | ✅ COMPLETE | Campaign Builder + CSV export + shared CSV utils (475 tests) |
| 9 | Audit Foundation | ✅ COMPLETE | New GAQL queries, account iterator, scheduler, audit store (543 tests) |
| 10 | Account Health Auditor | ✅ COMPLETE | 11 strategy-aligned checks, audit routes, dashboard UI (621 tests) |
| 11 | Audit Automation | ✅ COMPLETE | Scheduled MCC-wide audits, token refresh, concurrency guards (651 tests) |
| 12 | Strategy Rules + Deep Scan | ✅ COMPLETE | Rules engine, negative keyword analyzer, ad copy analyzer, deep scanner (764 tests) |
| 13 | Smart Budget Auto-Adjuster | 🔨 IN PROGRESS | Phase 1 complete: detection engine, campaign classifier, adjustment generator (973 tests) |

---

## Current Phase Detail

### Deploy Steps (remaining from Phase 4)

- [x] Commit all Phase 1-5 work to V3 branch (commit `0408b45`)
- [ ] Push to origin (`git push origin V3`)
- [ ] Configure Railway env vars (APP_URL, NODE_ENV=production, etc.)
- [ ] Add Railway callback URL to Google Cloud Console OAuth redirect URIs
- [ ] Deploy V3 to Railway, verify health check
- [ ] Manual smoke test: OAuth flow, account listing, parse task, dry run
- [ ] Update PR #1

### Phase 5: Operational Reliability — COMPLETE

**Goal:** Add observability, safety limits, and operational tooling.

**Deliverables (all complete):**
- [x] User identity: OAuth fetches Google userinfo email, stored in session for audit trail
- [x] Keyword limit raised 500→2000 with `keywordsTruncated` flag + Express JSON limit 2MB
- [x] Structured audit logging to stdout (JSON): parse_task + apply_changes, success + error paths
- [x] Query timeouts via `queryWithTimeout` with `.finally(clearTimeout)` timer cleanup
- [x] Staff review fixes: timer leak, audit log tamper protection, input validation (`Array.isArray`), `dryRun` coercion, error audit logging, email-only-when-connected, deduplicated timeout pattern

**Removed from original plan (after specialist review):**
- Persistent sessions: overengineered for <10 users, session is ~250 bytes
- Rate limiting: non-existent problem for internal tool
- REST→library refactor: high risk, low reward — token refresh is load-bearing for MCC discovery
- File-based audit log: Railway has ephemeral filesystem — stdout JSON is the correct approach

---

## Current Phase Detail

### Phase 8: Campaign Builder Integration

**Goal:** Merge the standalone Google Ads Campaign Builder (React HTML tool) into the Dealer Ads Tool as a unified application, and add CSV export for change plans.

**Phase 1 — Core Integration (COMPLETE):**
- [x] Created `src/routes/builder.js` — `POST /api/builder/ai` proxies Claude calls with server-side API key
- [x] Mounted builder router in `src/server.js`
- [x] Migrated Campaign Builder to `public/builder.html` — all Claude calls now use `/api/builder/ai` proxy
- [x] Eliminated client-side API key exposure (was calling `api.anthropic.com` directly from browser)
- [x] Added nav links across all 3 pages (Task Manager ↔ Pacing Dashboard ↔ Campaign Builder)
- [x] 9 integration tests for builder route (428 total, all green)

**Phase 2 — CSV Export for Changes (COMPLETE):**
- [x] Created `src/utils/ads-editor-columns.js` — shared 176-column COLS array + match type normalizer
- [x] Created `src/services/csv-exporter.js` — `changeToRows()` maps 9 of 10 change types to Ads Editor CSV rows
- [x] Created `POST /api/export-changes-csv` route in `src/routes/changes.js`
- [x] Added "Export as CSV" button in `public/app.js` alongside Dry Run / Apply Changes
- [x] Staff engineer review: fixed 5 issues (wrong state var, CSV injection, null details guard, radius Campaign Status, km unit detection)
- [x] 47 new tests (475 total, all green)
- [x] Note: `exclude_radius` has no CSV encoding — API-only, skipped with warning

**Phase 3 — Shared CSV Infrastructure (COMPLETE):**
- [x] Created `public/csv-utils.js` — browser-side shared module (ADS_COLS, blankAdsRow, buildAdsCSV)
- [x] Updated `builder.html` — removed inline COLS + dead toCSV, uses shared module
- [x] Tab/newline sanitization in browser CSV generation
- [x] Fixed footer encoding label (UTF-16 → UTF-8)

---

## Session Log

### 2026-03-19 (session 6) - CLEAN HANDOFF

**Completed:**
- Fixed security issues + deployed V3 to Railway:
  - OAuth CSRF: crypto.randomBytes state parameter, validated on callback, single-use
  - XSS: escapeHtml on all innerHTML interpolations across app.js, pacing-app.js, audit-app.js
  - Fixed audit-app.js auth routes (/auth/connect → /auth/google, /auth/status → /api/auth/status)
  - Fixed showConnectedState nav links (was missing Auditor + Builder links)
  - V3 deployed to Railway: https://dealer-ads-tool-production.up.railway.app (health check OK, all pages 200)
- Planned full automation roadmap (Phases 12-16, 17 features, 13-15 sessions)
- Implemented Phase 12: Strategy Rules Engine + Deep Scan
  - `strategy-rules.js` — Single source of truth: CPC ranges (with HIGH_DEMAND_MODELS list for new_high classification), match type policy, budget splits, ad schedule template, naming patterns, VLA settings, impression share targets, competing makes (with self-filter fallback), URL patterns by platform, universal negatives
  - `negative-keyword-analyzer.js` — 3 checks: conflict detection (exact/phrase/BROAD match), cannibalization (same keyword in multiple ad groups), traffic sculpting (missing competing-make negatives)
  - `ad-copy-analyzer.js` — 4 checks: stale year references (2020-currentYear-1), missing RSAs per ad group, headline quality (short/all-caps/missing dealer name), pinning overuse
  - `deep-scanner.js` — Orchestrates existing 11 audit checks + 7 new analyzer checks = 18 total
  - 2 new GAQL queries: getCampaignNegatives, getAdGroupAdCounts
  - New route: POST /api/deep-scan?customerId=X
- Staff engineer (Opus) review found 2 P0s + 6 P1s + 1 P2, key fixes:
  1. **P0**: BROAD match negatives silently ignored in doesNegativeBlock — added word-set matching
  2. **P0**: classifyCampaignType never returned 'new_high' — added HIGH_DEMAND_MODELS list (30+ models)
  3. **P1**: checkStaleYearReferences used Date.now() making tests time-dependent — added optional currentYear param
  4. **P2**: getCompetingMakes fallback included dealer's own make — added self-filter with alias handling

**Files Created:**
- `src/services/strategy-rules.js`, `src/services/negative-keyword-analyzer.js`, `src/services/ad-copy-analyzer.js`, `src/services/deep-scanner.js`
- `tests/unit/test_strategy_rules.js` (36 tests), `tests/unit/test_negative_keyword_analyzer.js` (27 tests), `tests/unit/test_ad_copy_analyzer.js` (25 tests), `tests/unit/test_deep_scanner.js` (13 tests), `tests/integration/test_deep_scan_routes.js` (8 tests)

**Files Modified:**
- `src/services/google-ads.js` — added getCampaignNegatives + getAdGroupAdCounts
- `src/routes/audit.js` — added POST /api/deep-scan route
- `src/routes/auth.js` — OAuth CSRF state parameter
- `public/app.js` — escapeHtml + nav links fix
- `public/audit-app.js` — auth route fixes + escapeHtml
- `public/pacing-app.js` — escapeHtml fixes

**Test Count:** 655 → 764 (+109 tests)

**Next Session Focus:**
- Phase 13: Automated Optimization (CPC optimizer, impression share targeting, budget management, recommendation dismissal)

---

### 2026-03-19 (session 5) - CLEAN HANDOFF

**Completed:**
- Fixed 2 high-severity security issues from PR #1 review:
  1. **OAuth CSRF** (auth.js): Added `state` parameter with crypto.randomBytes(32), validated on callback, single-use (replay prevention). 4 new integration tests.
  2. **XSS** (app.js): Added `escapeHtml()` function, applied to all 15+ innerHTML interpolation points — campaign names, keyword text, plan summaries, warnings, error messages, result messages.
- Staff engineer (Opus) review confirmed both target files clean, found P1 in sibling files:
  - `pacing-app.js`: escaped `formatStatus` default branch + `inv.count`
  - `audit-app.js`: escaped summary card numbers (defense-in-depth)

**Files Modified:**
- `src/routes/auth.js` — state parameter generation + validation
- `public/app.js` — escapeHtml + 15+ innerHTML sanitizations
- `public/pacing-app.js` — 2 defensive escapes
- `public/audit-app.js` — 4 defensive escapes
- `tests/integration/test_auth_routes.js` — 4 new CSRF tests (20 total, was 16)

**Test Count:** 651 → 655 (+4 tests)

**Next Session Focus:**
- Deploy V3 to Railway (all security fixes now applied)
- Or: Phase 12+ automation (Freshdesk integration, CPC optimization, factory offers)

---

### 2026-03-19 (session 4) - CLEAN HANDOFF

**Completed:**
- Implemented full Phase 11: Audit Automation
  - `audit-scheduler.js` — orchestrates scheduled MCC-wide audits:
    1. Stores refresh token at schedule-start time
    2. On each cycle: refreshes OAuth token → discovers child accounts → runs audit engine per account → stores results
    3. Concurrency guard prevents overlapping cycles
    4. Interval validation (min 30min, max 24h) prevents DoS
    5. Null-safe state writes handle mid-cycle stop gracefully
  - 3 new routes in `audit.js`: POST /api/audit/schedule/start, POST /stop, GET /status
  - Dashboard: scheduler toggle button + status polling (30s interval)
- Staff engineer (Opus) review found 2 P0s + 3 P1s + 3 P2s, all fixed:
  1. **P0**: No intervalMs validation — allowed 1ms intervals (DoS). Added min/max enforcement
  2. **P0**: Refresh token stored but never updated on rotation — documented limitation, added error detection
  3. **P1**: No concurrency guard on exported `runScheduledAuditCycle` — added `cycleRunning` flag with try/finally
  4. **P1**: O(n²) `indexOf` in account loop — replaced with standard for-loop index
  5. **P1**: Re-entrant start could overwrite state mid-cycle — concurrency guard prevents this
  6. **P2**: Stop during running cycle caused null TypeError — added null guard on state write-back
  7. **P2**: Missing defensive access on `result.summary.total` — added optional chaining

**Files Created:**
- `src/services/audit-scheduler.js`
- `tests/unit/test_audit_scheduler.js` (19 tests)

**Files Modified:**
- `src/routes/audit.js` — added 3 scheduler control routes
- `public/audit.html` — added scheduler controls section
- `public/audit-app.js` — scheduler toggle, status polling, start/stop
- `public/audit-styles.css` — scheduler button styles
- `tests/integration/test_audit_routes.js` — added 11 scheduler route tests (28 total)

**Test Count:** 621 → 651 (+30 tests)

**Next Session Focus:**
- Deploy V3 to Railway with all 5 tools (Task Manager, Pacing, Builder, Auditor, Scheduled Audits)
- Fix high-severity PR findings (XSS in app.js innerHTML, OAuth CSRF in auth.js)
- Phase 12+: Freshdesk integration, CPC optimization, factory offer automation

---

### 2026-03-27 - CLEAN HANDOFF

**Completed:**
- All-accounts pacing overview enhancements:
  - Added "Pacing" column showing budget score (100% = on pace)
  - Default sort by highest pace to lowest pace
  - Added post-change projection column (On Track / Will Over / Will Under)
- Phase 13: Smart Budget Auto-Adjuster — Phase 1 (Detection + Recommendation Engine):
  - `campaign-classifier.js` — classifies campaigns by type (VLA, brand, service, comp, regional, general, model_keyword), extracts model names, computes inventory-weighted priority weights
  - `pacing-detector.js` — flags accounts needing intervention with urgency scoring (critical/high/medium)
  - `adjustment-generator.js` — generates executor-ready budget adjustments using proportional weighted distribution with inventory share multipliers
  - `pacing-fetcher.js` — extracted shared fetchAccountPacing helper from pacing route
  - Two weight tables agreed with user:
    - CUT_WEIGHTS (over-pacing): Regional 1.0 → Service 0.95 → General 0.85 → Comp 0.75 → Low inv KW 0.6 → High inv KW 0.4 → Brand 0.35 → VLA 0.15
    - ADDITION_WEIGHTS (under-pacing): VLA 1.0 → High inv KW 0.8 → Low inv VLA 0.6 → Low inv KW 0.4 → Brand 0.35 → Comp 0.3 → General 0.25 → Service 0.15 → Regional 0.1
  - Inventory proportional to dealer's lot — no arbitrary high/low cutoff
- Staff review (Opus) fixes applied:
  - Fixed shared budget spend lookup (was using budget setting instead of actual campaign spend sum)
  - Reduced BATCH_SIZE to 6 for rate limit safety with 3 parallel API calls
  - Added defensive .catch() on getLastBudgetChange
  - NaN guard on spend reduce
  - Tooltip on projection cells
  - Removed dead "dealership name" pattern, increased min model name length to 3

**Files Created:**
- `src/services/campaign-classifier.js`, `src/services/pacing-detector.js`
- `src/services/adjustment-generator.js`, `src/services/pacing-fetcher.js`
- `tests/unit/test_campaign_classifier.js` (33 tests), `tests/unit/test_pacing_detector.js` (17 tests)
- `tests/unit/test_adjustment_generator.js` (17 tests), `tests/unit/test_projection.js` (9 tests)

**Files Modified:**
- `src/services/pacing-calculator.js` — added calculateProjection() + getProjectionStatus()
- `src/routes/pacing.js` — added projection to /api/pacing/all, extracted fetchAccountPacing
- `public/pacing-overview-app.js` — added Pacing score column, Projection column, sort support
- `tests/integration/test_pacing_overview_routes.js` — added projection tests

**Test Count:** 764 → 973 (+209 tests, 46 suites)

**Next Session Focus:**
- Phase 13 continued — Phase 2: Approval workflow backend (scan route, pending queue, approve/reject endpoints)
- Phase 3: Execution + safety (wire to change-executor.js, capture previous values, staleness check)
- Phase 4: Frontend approval UI (scan button, review table, approve/reject per account)

---

### 2026-03-19 (session 3) - CLEAN HANDOFF

**Completed:**
- Implemented full Phase 10: Account Health Auditor
  - `audit-engine.js` — 11 strategy-aligned health checks:
    1. Non-Manual-CPC bidding (critical)
    2. Enhanced CPC enabled (warning)
    3. Broad match keywords (critical)
    4. Zero-impression keywords (warning)
    5. Disapproved/limited ads (critical/warning)
    6. High CPC above $15 (warning)
    7. Low CTR below 2% (warning)
    8. Pending recommendations (warning)
    9. Missing ad schedules (info)
    10. Zero-spend enabled campaigns (warning)
    11. Low impression share below 75%/50% (warning/critical)
    + Naming convention violations (info)
  - `routes/audit.js` — POST /api/audit/run, GET /api/audit/results, GET /api/audit/results/all
  - Dashboard UI: `audit.html` + `audit-app.js` + `audit-styles.css`
  - Nav links added across all pages
- Staff engineer (Opus) review found 2 P0s + 5 P1s + 4 P2s, all fixed:
  1. **P0**: `getCampaignPerformance` didn't return `biddingStrategy` — bidding check was non-functional. Added `campaign.bidding_strategy_type` + `campaign.manual_cpc.enhanced_cpc_enabled` to GAQL
  2. **P0**: Error messages in query failure findings could leak internal details — sanitized
  3. **P1**: `getCampaignPerformance` had no `.catch()` — entire audit crashed on campaign query failure
  4. **P1**: No customerId format validation — added regex check
  5. **P1**: No whitelist on `checks` array — added against known check names
  6. **P2**: No ECPC check — added as separate warning finding
  7. **P2**: No impression share check despite 75-90% target — added Check 11 (critical <50%, warning <75%)
  8. **P2**: Frontend error parsing crashed on non-JSON responses — added try-catch fallback

**Files Created:**
- `src/services/audit-engine.js`, `src/routes/audit.js`
- `public/audit.html`, `public/audit-app.js`, `public/audit-styles.css`
- `tests/unit/test_audit_engine.js` (60 tests), `tests/integration/test_audit_routes.js` (17 tests)

**Files Modified:**
- `src/services/google-ads.js` — added `bidding_strategy_type` + `enhanced_cpc_enabled` to campaign GAQL
- `src/server.js` — mounted audit router
- `public/index.html`, `public/pacing.html` — added Auditor nav link
- `tests/unit/test_audit_queries.js` — updated expectation for new campaign fields

**Test Count:** 543 → 621 (+78 tests)

**Next Session Focus:**
- Phase 11: Audit automation (wire scheduler to run audits on interval, email/notification on findings)
- Or: Deploy V3 to Railway with all 4 tools (Task Manager, Pacing, Builder, Auditor)
- Or: Fix high-severity PR findings (XSS in app.js innerHTML, OAuth CSRF in auth.js)

---

### 2026-03-19 (session 2) - CLEAN HANDOFF

**Completed:**
- Implemented full Phase 9: Audit Foundation infrastructure
  - 5 new GAQL query functions in `google-ads.js`: getKeywordPerformance, getCampaignPerformance, getAdCopy, getRecommendations, getAdSchedules
  - `account-iterator.js`: batch MCC child account iteration with rate limiting, error isolation, progress callbacks
  - `scheduler.js`: in-memory setInterval-based job scheduler for daily audits
  - `audit-store.js`: in-memory audit result storage with per-account 7-day rolling history
  - `routes/scheduler.js`: GET /api/scheduler/status (authenticated), mounted in server.js
- Staff engineer (Opus) review found 3 P0s + 6 P2s, all fixed:
  1. **P0**: Scheduler route had no auth — added requireAuth (was leaking error info)
  2. **P0**: Dead `refreshAccessToken` import in account-iterator — removed
  3. **P0**: Discovery query used `level <= 1` instead of `status = 'ENABLED'` — aligned with accounts.js, added sub-MCC support
  4. **P2**: Wrapped `onProgress` in try/catch (prevents callback errors from aborting iteration)
  5. **P2**: Default undefined callback results to null (JSON-safe)
  6. **P2**: Added malformed row guard in discoverAccounts (filters rows without id)
  7. **P2**: Added scheduler concurrency guard test

**Files Created:**
- `src/services/account-iterator.js`, `src/services/scheduler.js`, `src/services/audit-store.js`
- `src/routes/scheduler.js`
- `tests/unit/test_audit_queries.js`, `tests/unit/test_account_iterator.js`, `tests/unit/test_scheduler.js`, `tests/unit/test_audit_store.js`
- `tests/integration/test_scheduler_routes.js`

**Files Modified:**
- `src/services/google-ads.js` — added 5 new query functions (getKeywordPerformance, getCampaignPerformance, getAdCopy, getRecommendations, getAdSchedules)
- `src/server.js` — mounted scheduler router

**Test Count:** 475 → 543 (+68 tests)

**Next Session Focus:**
- Phase 10: Account Health Auditor (audit-engine.js, audit routes, audit dashboard UI)

---

### 2026-03-19 (session 1) - CLEAN HANDOFF

**Completed:**
- Fixed production pacing errors (2 bugs):
  1. Null guard on `metrics.cost_micros` — campaigns with no spend returned null, causing NaN in pacing calculations
  2. Removed invalid `campaign_budget.total_amount_micros` from shared budget GAQL query (field doesn't exist in Google Ads API v19)
- Added sub-MCC account discovery for pacing dashboard:
  - `listAccessibleCustomers` now recursively discovers child accounts under sub-MCCs (e.g., Savvy Ford 171-200-3420 under PPC Account MCC)
  - Accounts from sub-MCCs are included in the pacing dashboard account dropdown
  - Updated tests to cover recursive MCC discovery
- Pushed to V3 branch (Railway auto-deployed)

**Files Modified:**
- `src/services/google-ads.js` — null guard on cost_micros, removed invalid GAQL field, recursive sub-MCC discovery
- `src/routes/accounts.js` — pass-through for sub-MCC accounts
- `tests/unit/test_pacing_queries.js` — updated for null metrics handling
- `tests/integration/test_pacing_routes.js` — updated for sub-MCC discovery

**Test Count:** 475 (unchanged)

**Next Session Focus:**
- Verify Savvy Ford sub-MCC accounts appear in pacing dashboard after Railway deploy
- Fix high-severity PR findings (XSS in app.js innerHTML, OAuth CSRF in auth.js)
- Deploy V3 to Railway (env vars + OAuth redirect URI) if not yet done

---

### 2026-03-18 (session 3) - CLEAN HANDOFF

**Completed:**
- Implemented Phase 3: Shared CSV Infrastructure
  - Created `public/csv-utils.js` with ADS_COLS (176 columns), blankAdsRow(), buildAdsCSV()
  - Updated builder.html to load shared module, removed 18 lines of inline COLS/toCSV/bk() duplication
  - Added tab/newline sanitization to browser-side CSV (matching server-side)
  - Fixed stale "UTF-16" footer label → "UTF-8"
- Staff engineer (Opus) review: clean pass, found 2 minor issues (dead alias, stale footer), both fixed
- Pushed V3 branch to GitHub (2 commits: 5393b52 + 0d6143e)
- Phase 8 now fully complete (all 3 phases)

**Files Changed:**
- Created: `public/csv-utils.js`
- Modified: `public/builder.html` (-18 lines, +5 lines)

**Test Count:** 475 (unchanged — Phase 3 was pure refactor)

**Next Session Focus:**
- Deploy V3 to Railway (env vars + OAuth redirect URI)
- Fix high-severity PR findings (XSS in app.js innerHTML, OAuth CSRF in auth.js)

---

### 2026-03-18 (session 2) - CLEAN HANDOFF

**Completed:**
- Implemented Phase 2: CSV Export for Changes
  - `src/utils/ads-editor-columns.js` — 176-column COLS array, match type normalizer (API "EXACT" → CSV "Exact"), blankRow()
  - `src/services/csv-exporter.js` — changeToRows() for 9/10 change types, toCSV() with UTF-8 BOM + tab sanitization
  - `POST /api/export-changes-csv` route — returns JSON with CSV data, filename, rowCount, skipped array
  - "Export as CSV" button in app.js — triggers browser download via Blob
- Staff engineer (Opus) review caught 5 issues, all fixed:
  1. `state.selectedAccountName` → `state.selectedName` (wrong var, filenames always "changes")
  2. Tab/newline sanitization in toCSV() (CSV injection prevention)
  3. Missing `details` guard — 6 change types now skip gracefully instead of TypeError
  4. `add_radius` no longer sets `Campaign Status = Enabled` (prevented re-enabling paused campaigns)
  5. Unit detection handles 'km'/'KM' in addition to 'KILOMETERS'

**Files Changed:**
- Created: `src/utils/ads-editor-columns.js`, `src/services/csv-exporter.js`, `tests/unit/test_ads_editor_columns.js`, `tests/unit/test_csv_exporter.js`
- Modified: `src/routes/changes.js` (export route), `public/app.js` (export button), `tests/integration/test_change_routes.js` (+7 tests)

**Test Count:** 475 (was 428)

**Next Session Focus:**
- Phase 3: Extract shared COLS to module used by both builder.html and csv-exporter
- Or: deploy V3 to Railway

---

### 2026-03-18 (session 1) - CLEAN HANDOFF

**Completed:**
- Reviewed PR #1 (V3 modular rewrite) — identified 2 high-severity issues (XSS via innerHTML, missing OAuth CSRF), 8 medium, 7 low
- Explored integration of standalone Campaign Builder (GoogleAdsCampaignBuilder.html) with Dealer Ads Tool
- Spawned 4 specialist subagents (architecture, data flow, integration, domain) to analyze feasibility
- Produced grounded implementation plan: 3 phases, 14 steps
- Implemented Phase 1 of Campaign Builder Integration:
  - `src/routes/builder.js` — Claude API proxy (no auth required, 60s timeout, 4096 token cap)
  - `public/builder.html` — Campaign Builder migrated, all AI calls proxied through server
  - Cross-navigation between all 3 pages
  - 9 new integration tests (428 total, all green)

**Key Decisions:**
- Campaign Builder does not require Google Ads OAuth (only generates CSV, no API calls)
- Keep CDN React/Babel/Tailwind on builder page only — no build step, no vanilla JS conversion
- API key now server-side only — eliminated security exposure from original standalone tool
- Model controlled by server config (`config.claude.model`) — no hardcoded model in frontend
- 9 of 10 change types can export to Ads Editor CSV; `exclude_radius` is API-only (no CSV encoding for negative lat/lng radius)

**Files Changed:**
- Created: `src/routes/builder.js`, `public/builder.html`, `tests/integration/test_builder_routes.js`
- Modified: `src/server.js` (mount builder router), `public/index.html` (nav link), `public/pacing.html` (nav link)

**Next Session Focus:**
- Phase 2: CSV export for change plans (`csv-exporter.js`, export route, UI button)

---

### 2026-03-10 - CLEAN HANDOFF

**Completed:**
- Cloned V2 repo and performed full codebase audit
- Mapped all 1,816 lines of server.js — identified 6 logical sections (OAuth, accounts, structure, parsing, execution, frontend)
- Documented 6 critical tech debt items, 3 known bugs, 5 architecture debt items
- Mapped 6 key integration connections that must survive the split
- Created all 4 TDD framework files (planning-intake.md, quick-start.md, project-state.md, claude.md)
- Defined 3-phase rebuild plan

**Decisions Made:**
- Keep Express.js (not migrate to NestJS): Problem is monolith structure, not the framework
- Keep JavaScript (not TypeScript): Beginner coder, too much change at once with architectural rebuild
- Use Jest for testing: Node.js standard, good TDD support
- Separate static frontend (not React): Keeps simplicity, no build step needed
- Keep Railway deployment: Already working, no reason to change during rebuild
- Split into routes/services/middleware/utils: Standard Express pattern, testable

**Files Changed:**
- Created `planning-intake.md`: Full project plan with V2 audit
- Created `quick-start.md`: Session orientation document
- Created `project-state.md`: This file
- Created `claude.md`: Development guidelines customized for this project

**Next Session Focus:**
- Begin Phase 1: Initialize new directory structure, configure Jest, create first config tests

---

### 2026-03-11 - CLEAN HANDOFF

**Completed:**
- Committed all V3 scaffold files (23 files, 3,454 lines) as initial commit on V3 branch
- Configured git identity (bprev / support@savvydealer.com) at repo level
- Added GitHub remote (origin → support5102/dealer-ads-tool)
- Merged origin/main into V3 to create shared history (resolved package.json conflict, kept V3 version)
- Pushed V3 branch to GitHub
- Installed GitHub CLI (`gh`) via winget
- Authenticated `gh` with GitHub
- Created PR #1: "V3: Modular architecture rewrite" (V3 → main)

**Environment Notes:**
- Node.js/npm not found in bash PATH — needs install or PATH config before tests can run
- GitHub CLI installed and authenticated

**Files Changed:**
- No source changes — session focused on git/GitHub setup and PR creation

**Next Session Focus:**
- Install Node.js or fix PATH so `npm test` works
- Begin writing Tier 1 tests (config validation, sanitize rules)
- Verify local server starts with `npm run dev`

---

### 2026-03-11 (session 2) - CLEAN HANDOFF

**Completed:**
- Installed Node.js v24.14.0 via winget, ran `npm install`
- Wrote 44 Tier 1 tests across 2 files — all passing
  - `tests/config/test_env_validation.js` (14 tests): env validation, defaults, deep freeze
  - `tests/config/test_sanitize.js` (30 tests): GAQL string/number sanitization, injection prevention
- Found and fixed 4 bugs via staff engineer review:
  1. `sanitizeGaqlNumber` silently converted null→0, boolean→0/1 (data corruption risk)
  2. `sanitizeGaqlString` returned empty string when input was all-dangerous characters
  3. `dotenv` loaded inside config.js utility (production override risk) — moved to server.js
  4. `Object.freeze` was shallow on config (mutation risk) — added deepFreeze
- Verified server boots and health check returns 200
- Created `.env` with placeholder values for local dev

**Files Changed:**
- Created `tests/config/test_env_validation.js`
- Created `tests/config/test_sanitize.js`
- Modified `src/utils/config.js`: removed dotenv, added deepFreeze
- Modified `src/utils/sanitize.js`: null/boolean guard, post-strip empty check
- Modified `src/server.js`: added dotenv loading at entry point
- Created `.env` (gitignored)

**Next Session Focus:**
- Phase 2: Write Tier 2 unit tests (claude-parser, change-executor, structure builder)
- Create fakes (google-ads-fake.js, claude-api-fake.js)

---

### 2026-03-11 (session 3) - CLEAN HANDOFF

**Completed:**
- Created test fakes for both external services:
  - `tests/fakes/google-ads-fake.js`: FakeGoogleAdsClient with GAQL pattern matching, mutation tracking, configurable test data
  - `tests/fakes/claude-api-fake.js`: Response helpers (valid JSON, markdown-wrapped, invalid, empty) + sample change plan
- Wrote 88 Tier 2 unit tests across 3 files using agent team (3 parallel agents):
  - `tests/unit/test_claude_parser.js` (20 tests): prompt builder, message formatter, API caller
  - `tests/unit/test_change_executor.js` (42 tests): all 10 change types, lookup helpers, dry run, error paths
  - `tests/unit/test_structure_builder.js` (26 tests): tree assembly, data transforms, edge cases, locations
- Staff engineer review found and we fixed 3 issues:
  1. **P0 production bug**: System prompt listed `enable_keyword` and `update_bid` as valid types but executor doesn't handle them — removed from prompt
  2. Budget-to-campaign binding in fake was wrong (always returned same budget) — now filters by campaign ID
  3. `enable_ad_group` was under-tested (only happy path) — added error-path tests

**Files Created:**
- `tests/fakes/google-ads-fake.js`
- `tests/fakes/claude-api-fake.js`
- `tests/unit/test_claude_parser.js`
- `tests/unit/test_change_executor.js`
- `tests/unit/test_structure_builder.js`

**Files Modified:**
- `src/services/claude-parser.js`: Removed unsupported `enable_keyword|update_bid` from system prompt type list

**Next Session Focus:**
- Phase 3: Integration tests for Express routes (auth, accounts, changes)
- Error handler and auth middleware tests

---

### 2026-03-11 (session 4) - CLEAN HANDOFF

**Completed:**
- Refactored `src/server.js` into `createApp(config)` factory with `require.main === module` guard for testability
- Installed supertest for HTTP-level integration testing
- Created test infrastructure: `tests/integration/test-helpers.js` (TEST_CONFIG, createTestApp, authenticatedAgent)
- Wrote 48 Tier 3 integration tests across 4 files:
  - `tests/integration/test_middleware.js` (8 tests): requireAuth blocks, error handler formatting
  - `tests/integration/test_auth_routes.js` (12 tests): OAuth redirect, token exchange, logout, status
  - `tests/integration/test_account_routes.js` (8 tests): account listing, structure loading, MCC passthrough
  - `tests/integration/test_change_routes.js` (20 tests): parse-task, apply-changes, dry run, mixed results, health check
- Staff engineer review found and we fixed 6 issues:
  1. **P0**: Module-level router instances shared across createApp calls — moved inside factory functions
  2. **P0**: authenticatedAgent stacked duplicate route handlers — rewrote to use query params
  3. **P1**: dotenv loaded at import time overriding test env — moved inside require.main guard
  4. **P1**: Missing redirect_uri assertion in auth callback test — added
  5. **P1**: Whitespace-only task bypassed validation — added trim check in changes.js route
  6. **P1**: No test for empty changes array — added

**Files Created:**
- `tests/integration/test-helpers.js`
- `tests/integration/test_middleware.js`
- `tests/integration/test_auth_routes.js`
- `tests/integration/test_account_routes.js`
- `tests/integration/test_change_routes.js`

**Files Modified:**
- `src/server.js`: Extracted createApp factory, moved dotenv inside require.main guard
- `src/routes/auth.js`: Moved router inside createAuthRouter factory
- `src/routes/accounts.js`: Moved router inside createAccountsRouter factory
- `src/routes/changes.js`: Moved router inside factory + whitespace task validation

**Next Session Focus:**
- Token refresh optimization
- Deploy V3 to Railway
- Verify production functionality matches V2

---

### 2026-03-11 (session 5) - CLEAN HANDOFF

**Completed:**
- Reviewed Phase 4 plan with 3 specialist subagents (feasibility, dependency, risk)
  - Found token refresh is NOT redundant (REST API calls need raw access tokens) — deferred to Phase 5
  - Found 3 critical deployment blockers: missing trust proxy, insecure cookies, wide-open CORS
  - Found budget fix is likely feasible (change-executor already reads budgets via library client)
- Production hardening in `server.js`:
  - Added `trust proxy` in production for Railway's reverse proxy
  - Restricted CORS to `config.app.url` with `credentials: true`
  - Session cookie: `secure` (production), `httpOnly: true`, `sameSite: 'lax'`
- Budget display fix in `google-ads.js`:
  - Added `campaign_budget.amount_micros` to campaign GAQL query
  - Defensive parsing with `!= null` check (handles zero budgets correctly)
  - Fallback to `'?'` when budget data unavailable
- Staff engineer review found and we fixed 4 issues:
  1. **P0**: Session cookie missing explicit `httpOnly: true` — added
  2. **P1**: Session cookie missing `sameSite` attribute — added `'lax'`
  3. **P1**: Budget `0` micros displayed as `'?'` due to falsy check — fixed with `!= null`
  4. **P1**: No CORS preflight rejection test — added
- Defined Phases 5-6 roadmap (operational reliability + feature expansion)

**Files Modified:**
- `src/server.js`: Trust proxy, CORS restriction, secure cookie config
- `src/services/google-ads.js`: Budget GAQL join + defensive tree builder parsing
- `tests/integration/test_middleware.js`: 7 production hardening tests
- `tests/unit/test_structure_builder.js`: 5 budget display tests (replaced 1 old test)
- `tests/fakes/google-ads-fake.js`: Added budget data to campaign rows

**Next Session Focus:**
- Commit and push all changes to V3 branch
- Configure Railway env vars + Google Cloud Console OAuth redirect URI
- Deploy V3 to Railway and smoke test

---

### 2026-03-11 (session 6) - CLEAN HANDOFF

**Completed:**
- Implemented full Phase 5 (operational reliability) — 4 steps + staff review fixes:
  1. User identity: OAuth callback fetches Google userinfo email, stored in session
  2. Keyword limit raised 500→2000, `keywordsTruncated` flag in stats, Express JSON limit 2MB
  3. Structured audit logging: new `src/utils/audit-log.js`, wired into both routes in changes.js
  4. Query timeouts: `queryWithTimeout` helper with `.finally(clearTimeout)`, refactored `listAccessibleCustomers`
- Staff engineer review found and we fixed 9 issues:
  1. **P0**: `queryWithTimeout` timer leak — added `.finally(() => clearTimeout(timer))`
  2. **P0**: Audit log `_audit`/`timestamp` could be overridden — spread entry first, immutable fields last
  3. **P1**: No input validation on `changes` array — added `Array.isArray(changes)`
  4. **P1**: `dryRun` truthy-coerced — changed to `isDryRun = dryRun !== false`
  5. **P1**: No audit log for parse_task failures — added logAudit in catch block
  6. **P1**: No audit log for apply_changes outer catch — added logAudit in catch block
  7. **P1**: Email exposed on unauthenticated auth status — only return when connected
  8. **P1**: Duplicate `Promise.race` timeout in `listAccessibleCustomers` — refactored to use `queryWithTimeout`
  9. **P1**: Missing test for audit log override protection — added `_audit`/`timestamp` test
- Committed all Phase 1-5 work: `0408b45` (26 files, 8,525 insertions)
- Updated project-state.md and quick-start.md

**Files Created:**
- `src/utils/audit-log.js`: Structured JSON audit logging utility
- `tests/unit/test_audit_log.js`: 7 audit log tests

**Files Modified:**
- `src/routes/auth.js`: Added email scope, userinfo fetch, email-only-when-connected
- `src/routes/changes.js`: Audit logging, `Array.isArray` validation, `isDryRun` coercion, error logging
- `src/services/google-ads.js`: `queryWithTimeout` helper, keyword LIMIT 2000, `keywordsTruncated`, refactored `listAccessibleCustomers`
- `src/server.js`: `express.json({ limit: '2mb' })`
- `tests/unit/test_structure_builder.js`: Truncation tests, timeout tests, updated stats expectations
- `tests/integration/test_auth_routes.js`: Userinfo mock, email scope test, graceful failure test

**Test Count:** 180 → 206 (+26 tests)

**Next Session Focus:**
- Push to origin, configure Railway, deploy, smoke test

---

### 2026-03-16 - CLEAN HANDOFF

**Completed:**
- Explored and planned Budget Pacing Dashboard feature with 4 specialist subagents (integration, architecture, domain/PPC, security/reliability)
- Scoped to advisory-only mode: dashboard shows pacing + recommended adjustments, user manually applies in Google Ads
- Built Phase 7.1: Pacing Calculator service + 73 unit tests
  - Day-of-week weighted pacing (auto dealer traffic patterns)
  - Inventory modifier (adjusts effective budget based on lot inventory vs baseline)
  - Pacing status classification (on_pace/over/under/critical at ±5%/±15% thresholds)
  - Weighted projected month-end spend
  - Required daily rate calculation for remaining days
- Staff engineer review found and we fixed 1 bug + added 8 tests:
  1. **P0**: `projectedSpend` used flat daily average instead of weighted projection — fixed to use `spendToDate * (totalWeight / elapsedWeight)`
  2. Added tests for: floating-point boundaries, day 0, negative spend (refund), large budgets, out-of-bounds todayIndex, projection weighting

**Key decisions made:**
- Advisory-only (no auto-apply) — user manually implements recommendations
- Vehicle inventory from Google Ads `shopping_product` resource (no Merchant Center API needed)
- Feed mapping: `condition` = new/used, `brand` = make, `custom_label1` = model
- Goals from Google Sheets API (existing single source of truth)
- No scheduler/cron needed — user triggers pacing check when logged in

- Built Phase 7.2: Goal Reader service + 50 unit tests
  - Reads dealer monthly goals from Google Sheets API (injected client for testability)
  - Parses messy Sheet data: strips $, commas, whitespace from numbers; normalizes customer IDs
  - Validates minimum viable row (customer ID + name + budget > 0), skips invalid rows
  - Staff engineer review: added error context wrapping on Sheets API failures, tests for duplicates/extra columns/raw numbers

**Files Created:**
- `src/services/pacing-calculator.js` — Pure pacing calculation service
- `tests/unit/test_pacing_calculator.js` — 73 unit tests
- `src/services/goal-reader.js` — Google Sheets goal reader service
- `tests/unit/test_goal_reader.js` — 50 unit tests
- `tests/fakes/google-sheets-fake.js` — Fake Sheets API with 4 data sets

**Test Count:** 206 → 329 (+123 tests)

- Built Phase 7.3: Pacing GAQL query functions + 24 unit tests
  - `getMonthSpend(client)` — MTD spend per campaign, micros→dollars, status normalized
  - `getSharedBudgets(client)` — Shared budgets deduplicated with linked campaign arrays
  - `getImpressionShare(client)` — Search IS + budget lost IS per enabled campaign
  - `getInventory(client)` — Vehicle inventory from shopping_product feed (LIMIT 5000 + truncated flag)
  - Extended FakeGoogleAdsClient with 4 new data stores + query routing patterns
  - Staff engineer review: fixed `||`→`??` for micros (same class as Phase 4 bug), restructured getSharedBudgets to include campaign linkage, added numeric status test, LIMIT + truncated on inventory, documented ENABLED-only filter

**Files Created:**
- `tests/unit/test_pacing_queries.js` — 24 unit tests for pacing queries

**Files Modified:**
- `src/services/google-ads.js` — Added 4 pacing query functions (getMonthSpend, getSharedBudgets, getImpressionShare, getInventory)
- `tests/fakes/google-ads-fake.js` — Extended with pacing data stores + query routing

**Test Count:** 329 → 353 (+24 tests)

- Built Phase 7.4: Budget Recommender service + 38 unit tests
  - `generateRecommendation(params)` — main entry producing full dealer recommendation
  - `calculateBudgetAdjustments(pacing, sharedBudgets)` — proportional daily budget adjustments using flat remaining rate
  - `summarizeImpressionShare(data)` — averages + budget-limited campaign detection
  - `statusToColor(status)` — pacing status → dashboard color mapping (green/yellow/red)
  - Staff engineer review: fixed weighted-for-today rate → flat remaining rate (Google Ads budgets apply daily), null guard on campaignSpend, direction label derived from actual change not status

**Files Created:**
- `src/services/budget-recommender.js` — Budget recommendation engine
- `tests/unit/test_budget_recommender.js` — 38 unit tests

**Test Count:** 353 → 391 (+38 tests)

- Built Phase 7.5: Pacing API route + dashboard frontend + 14 integration tests
  - `GET /api/pacing?customerId=X` — fetches spend, budgets, impression share, inventory, goals in parallel; returns full recommendation
  - Route mounted in server.js via `createPacingRouter(config)` factory
  - Dashboard frontend: `pacing.html` + `pacing-app.js` + `pacing-styles.css`
    - Account selector, pacing status badge (green/yellow/red), metric cards (budget, spend, pacing %, required rate)
    - Budget recommendation cards with current → recommended daily budget and dollar change amounts
    - Impression share bars with budget-limited campaign detection
    - Inventory status with modifier display
    - Race condition guard (request ID) for rapid account switching
  - Nav links added between Task Manager and Pacing Dashboard (both directions)
  - Staff engineer review found and we fixed 4 issues:
    1. **P0**: Crash on missing `inventoryResult.items` — added defensive `|| []` fallback
    2. **P1**: Pacing bar `NaN%` width when `pacingPercent` is null — separated numeric vs display values
    3. **P1**: Stale response race condition on rapid account switching — added `_requestId` counter
    4. **Test gap**: Added tests for missing inventory items + readGoals rejection

**Files Created:**
- `src/routes/pacing.js` — Pacing API route
- `tests/integration/test_pacing_routes.js` — 14 integration tests
- `public/pacing.html` — Dashboard page
- `public/pacing-app.js` — Dashboard frontend logic
- `public/pacing-styles.css` — Dashboard styles

**Files Modified:**
- `src/server.js` — Mounted pacing router
- `public/index.html` — Added nav link to pacing dashboard
- `public/app.js` — Added nav link to pacing dashboard (connected state)
- `public/styles.css` — Added `.nav-link` style

**Test Count:** 391 → 405 (+14 tests)

**Next Session Focus:**
- Deploy V3 to Railway (commit ready, push + configure + smoke test)
- Or Phase 6 feature expansion (change history UI, email notifications)

---

## Design Decisions

### Architecture: Modular Express over Framework Migration

**Context:** V2 is a 1,816-line monolith. Should we migrate to NestJS/Fastify or restructure Express?

**Options Considered:**
1. NestJS: Full structure, TypeScript-first, dependency injection
2. Fastify: Faster, built-in validation
3. Express with modular structure: Keep framework, add organization

**Decision:** Express with modular structure — the problem is lack of organization, not the framework.

**Rejected:**
- NestJS: Too heavy for beginner coder, steep learning curve. Reconsider if team grows.
- Fastify: Migration effort without solving the real problem (monolith). Reconsider for performance needs.

---

### Frontend: Separate Static Files over React SPA

**Context:** ~1,090 lines of HTML/CSS/JS embedded as template literal in server.js.

**Decision:** Move to `public/` as separate `index.html`, `styles.css`, `app.js`. No build step needed.

**Rejected:**
- React SPA: Massive complexity increase (build pipeline, JSX, component architecture) for marginal benefit at current scale. Reconsider when frontend needs multiple pages or complex state.

---

### Testing: Jest with Fakes over Mocks

**Context:** Zero test coverage in V2. Need TDD foundation.

**Decision:** Jest framework, organized in config/unit/integration tiers. Use fake implementations (in-memory doubles) instead of mocks for core business logic tests.

**Rejected:**
- Mocha/Chai: Less integrated, more setup needed. Jest works out of the box.
- unittest.mock-style mocking: Couples tests to implementation. Fakes test behavior, not wiring.

---

## Next Steps

### Immediate (Next Session)
1. [x] Phase 7.1: Pacing Calculator — pure math service
2. [x] Phase 7.2: Goal Reader — read dealer goals from Google Sheets API
3. [x] Phase 7.3: Spend + inventory GAQL queries in google-ads.js
4. [x] Phase 7.4: Budget Recommender — generate recommendations from pacing state
5. [x] Phase 7.5: Pacing API routes + dashboard UI

### Deploy (blocked until Phase 7 complete or V3 base deployed)
1. [ ] Push commit `0408b45` to origin (`git push origin V3`)
2. [ ] Configure Railway env vars (APP_URL, NODE_ENV=production)
3. [ ] Add Railway URL to Google Cloud Console OAuth redirect URIs
4. [ ] Deploy V3 to Railway, verify health check
5. [ ] Manual smoke test: OAuth → account listing → parse task → dry run

### Backlog (Phase 6+)
- [ ] Change history UI
- [ ] Email notifications on apply
- [ ] Facebook Ads integration
- [ ] Lead attribution tracking

---

## Test Status

**Last Run:** 2026-03-19 — 764 passed, 0 failed
**Environment:** Local

| Tier | Passed | Failed | Skipped |
|------|--------|--------|---------|
| Config | 44 | 0 | 0 |
| Unit | 566 | 0 | 0 |
| Integration | 154 | 0 | 0 |

---

## Deployment Log

| Date | Commit | Deployer | Notes |
|------|--------|----------|-------|
| TBD | TBD | TBD | V3 initial deploy to Railway |

**Current Production (V2):**
- **Platform:** Railway
- **Branch:** V2
- **URL:** TBD (check Railway dashboard)

---

## Known Issues

| Issue | Severity | Status | Notes |
|-------|----------|--------|-------|
| Budget always shows "?" | Medium | ✅ Fixed | Library client handles auth correctly; budget GAQL join works in V3 |
| GAQL injection risk | High | ✅ Mitigated | sanitize.js guards all query inputs; 30 tests cover edge cases |
| Session-only auth | Medium | Accepted | Overengineered for <10 users; session is ~250 bytes |
| Token refresh every request | Low | Accepted | Load-bearing for MCC REST discovery; refactor deferred |
| 500 keyword limit | Low | ✅ Fixed | Raised to 2000 with `keywordsTruncated` flag |
| No audit trail | Medium | ✅ Fixed | Structured JSON audit logging to stdout (Railway captures) |
| No query timeouts | Medium | ✅ Fixed | 15s timeout on all GAQL queries with timer cleanup |
| XSS via innerHTML | High | ✅ Fixed | escapeHtml applied to all external data interpolation in app.js, pacing-app.js, audit-app.js |
| OAuth CSRF | High | ✅ Fixed | crypto.randomBytes state parameter, single-use, validated on callback |
| Audit-app wrong auth routes | Medium | ✅ Fixed | /auth/connect → /auth/google, /auth/status → /api/auth/status |
| Missing nav links when connected | Medium | ✅ Fixed | showConnectedState now shows all 3 tool links |

---

## References

- V2 Codebase: https://github.com/support5102/dealer-ads-tool/tree/V2
- Planning intake: `docs/archive/planning-intake.md` (after initialization)
- Google Ads API docs: https://developers.google.com/google-ads/api/docs/start
- google-ads-api npm: https://www.npmjs.com/package/google-ads-api
- Anthropic API docs: https://docs.anthropic.com/en/docs

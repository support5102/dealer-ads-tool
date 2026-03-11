# Dealer Ads Tool V3 - Project State

**Last Updated:** 2026-03-11
**Current Phase:** Phase 4: Deploy + Production Readiness (IN PROGRESS — code complete, deploy pending)

---

## Phase Overview

| Phase | Name | Status | Summary |
|-------|------|--------|---------|
| 0 | Planning | ✅ COMPLETE | V2 audited, tech debt documented, architecture decided |
| 1 | Foundation — Split Monolith | ✅ COMPLETE | Modular architecture, 44 Tier 1 tests, config/sanitize hardened |
| 2 | Unit Tests — Business Logic | ✅ COMPLETE | 88 Tier 2 tests across parser, executor, structure builder |
| 3 | Integration + Hardening | ✅ COMPLETE | 48 Tier 3 tests, server factory refactor, all P0/P1 fixed |
| 4 | Deploy + Production Readiness | 🔨 IN PROGRESS | Production hardening, budget fix, deploy pending |
| 5 | Operational Reliability | 📋 PLANNED | Persistent sessions, REST→library refactor, rate limiting, audit log |
| 6 | Feature Expansion | 📋 PLANNED | Change history UI, email notifications, Facebook Ads |

---

## Current Phase Detail

### Phase 4: Deploy + Production Readiness (IN PROGRESS — code complete)

**Goal:** Get V3 live on Railway, safe and functional.

**Deliverables:**
- [x] Production hardening: trust proxy, secure cookies, CORS restriction, httpOnly, sameSite
- [x] Budget display fix (defensive — fallback to "?" on failure)
- [x] Staff engineer review — all P0/P1 items fixed
- [ ] Commit and push to V3 branch
- [ ] Configure Railway env vars (APP_URL, NODE_ENV=production, etc.)
- [ ] Add Railway callback URL to Google Cloud Console OAuth redirect URIs
- [ ] Deploy V3 to Railway, verify health check
- [ ] Manual smoke test: OAuth flow, account listing, parse task, dry run
- [ ] Update PR #1

**Blockers:** None — code is complete, remaining steps are deploy + config

**Note:** Token refresh optimization was removed from Phase 4 after review found the explicit `refreshAccessToken` call is load-bearing (REST API calls need raw access tokens). Deferred to Phase 5 as "refactor REST calls to use library client."

---

## Session Log

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
1. [ ] Commit and push all changes to V3 branch
2. [ ] Configure Railway env vars (APP_URL, NODE_ENV=production)
3. [ ] Add Railway URL to Google Cloud Console OAuth redirect URIs
4. [ ] Deploy V3 to Railway, verify health check
5. [ ] Manual smoke test: OAuth → account listing → parse task → dry run

### Short Term (Phase 5)
1. [ ] Persistent sessions (connect-redis or connect-pg-simple)
2. [ ] Refactor REST calls to use library client (eliminates manual token refresh)
3. [ ] Rate limiting
4. [ ] Keyword 500 limit fix
5. [ ] Audit log (file-based or SQLite)

### Backlog (Phase 6+)
- [ ] Change history UI
- [ ] Email notifications on apply
- [ ] Facebook Ads integration
- [ ] Lead attribution tracking

---

## Test Status

**Last Run:** 2026-03-11 — 190 passed, 0 failed
**Environment:** Local

| Tier | Passed | Failed | Skipped |
|------|--------|--------|---------|
| Config | 44 | 0 | 0 |
| Unit | 89 | 0 | 0 |
| Integration | 57 | 0 | 0 |

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
| Budget always shows "?" | Medium | Open | Budget join removed in V2 due to permission issues (line 1362) |
| GAQL injection risk | High | Mitigated | sanitize.js guards all query inputs; 30 tests cover edge cases |
| Session-only auth | Medium | Open | In-memory sessions lost on restart, won't scale |
| Token refresh every request | Low | Open | Unnecessary API calls — optimize in Phase 3 |
| 500 keyword limit | Low | Open | Large accounts may show incomplete data |

---

## References

- V2 Codebase: https://github.com/support5102/dealer-ads-tool/tree/V2
- Planning intake: `docs/archive/planning-intake.md` (after initialization)
- Google Ads API docs: https://developers.google.com/google-ads/api/docs/start
- google-ads-api npm: https://www.npmjs.com/package/google-ads-api
- Anthropic API docs: https://docs.anthropic.com/en/docs

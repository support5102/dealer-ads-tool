# Dealer Ads Tool V3 - Project State

**Last Updated:** 2026-03-10
**Current Phase:** Phase 0: Planning - COMPLETE

---

## Phase Overview

| Phase | Name | Status | Summary |
|-------|------|--------|---------|
| 0 | Planning | ✅ COMPLETE | V2 audited, tech debt documented, architecture decided |
| 1 | Foundation — Split Monolith | 📋 PLANNED | Break server.js into modules, move frontend, add config tests |
| 2 | Unit Tests — Business Logic | 📋 PLANNED | TDD coverage on parser, executor, account structure |
| 3 | Integration + Hardening | 📋 PLANNED | Route tests, error handling, token optimization, deploy |

---

## Current Phase Detail

### Phase 1: Foundation — Split Monolith + Config Tests

**Goal:** Same functionality as V2, but in modular files with Tier 1 tests passing.

**Deliverables:**
- [ ] Split server.js into route/service/middleware modules (see architecture in planning-intake.md)
- [ ] Move ~1,090 lines of frontend HTML/CSS/JS to `public/` directory
- [ ] Environment variable validation utility (`src/utils/config.js`) with Tier 1 tests
- [ ] GAQL query sanitization utility (`src/utils/sanitize.js`) with Tier 1 tests
- [ ] Jest configured with tier-based test scripts
- [ ] All 7 API endpoints work identically to V2

**Blockers:** None

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
1. [ ] Create new directory structure (`src/`, `public/`, `tests/`)
2. [ ] Configure Jest with tier-based test scripts
3. [ ] Extract `src/utils/config.js` with environment validation
4. [ ] Write Tier 1 tests for config validation
5. [ ] Extract `src/utils/sanitize.js` for GAQL query safety

### Short Term (This Week)
1. [ ] Extract all routes from server.js into `src/routes/`
2. [ ] Extract all services into `src/services/`
3. [ ] Move frontend to `public/`
4. [ ] Verify all API endpoints still work

### Backlog
- [ ] Add audit log database (Phase 3)
- [ ] Fix budget display bug (Phase 2)
- [ ] Fix keyword 500 limit (Phase 3)
- [ ] Token refresh optimization (Phase 3)
- [ ] Rate limiting (Phase 3)
- [ ] Facebook Ads integration (Future)
- [ ] Lead attribution tracking (Future)

---

## Test Status

**Last Run:** N/A (no tests exist yet)
**Environment:** Local

| Tier | Passed | Failed | Skipped |
|------|--------|--------|---------|
| Config | - | - | - |
| Unit | - | - | - |
| Integration | - | - | - |

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
| GAQL injection risk | High | Open | String interpolation in queries — fix in Phase 2 with sanitize.js |
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

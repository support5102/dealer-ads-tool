# Planning Intake - Dealer Ads Tool V3

> **Purpose:** Capture synthesized planning from V2 audit before rebuilding with TDD.
> **Usage:** Fill this out, then run through the "New Project Checklist" at the bottom.
> **After planning is complete:** This document can be archived or deleted; its content migrates to claude.md and project-state.md.

---

## Project Vision

### One-Liner
This project is a **web-based Google Ads management tool** that **lets digital marketing teams paste Freshdesk support tasks in plain English and have AI translate them into structured Google Ads API changes — with review, dry-run, and one-click apply**.

### Problem Statement
Car dealer digital marketing teams receive ad change requests via Freshdesk tickets (pause campaigns, adjust budgets, add negative keywords, etc.). Manually translating these into Google Ads UI clicks is slow, error-prone, and doesn't scale across dozens of MCC sub-accounts. This tool automates the translation and execution.

### Success Criteria
- All V2 functionality preserved (OAuth, MCC account loading, task parsing, change execution)
- Codebase split into testable modules (no more 1,816-line monolith)
- TDD coverage on all business logic (parsing, change execution, account structure)
- Frontend separated from backend
- Audit trail of changes applied
- Clean deployment pipeline

---

## Requirements

### Must Have (v1.0 — V2 Parity + TDD Foundation)
- [x] Google OAuth flow for Google Ads API access
- [x] MCC account listing and sub-account selection
- [x] Account structure loading (campaigns, ad groups, keywords, locations)
- [x] Freshdesk task parsing via Claude API
- [x] Change plan display with summary, warnings, and per-change detail
- [x] Dry run mode (preview without applying)
- [x] Live apply mode (execute changes against Google Ads API)
- [ ] Modular codebase with separated concerns
- [ ] Test coverage on all business logic
- [ ] Input sanitization on GAQL queries (fix SQL injection risk)
- [ ] Environment variable validation at startup
- [ ] Error handling middleware

### Should Have (v1.x)
- [ ] Change audit log (database — who changed what, when)
- [ ] Budget display fix (currently shows "?" for all campaigns)
- [ ] Keyword limit increase beyond 500 per account
- [ ] Rate limiting on API endpoints
- [ ] Token refresh optimization (currently refreshes every request)
- [ ] Frontend as separate static files (not embedded in server.js)

### Nice to Have (Future)
- [ ] Facebook Ads integration
- [ ] Lead attribution tracking
- [ ] Multi-user support with role-based access
- [ ] Scheduled/recurring changes
- [ ] Change history dashboard
- [ ] Undo/rollback for applied changes

---

## Technical Decisions

### Decision 1: Backend Framework

**Options Considered:**
| Option | Pros | Cons |
|--------|------|------|
| Express.js (keep from V2) | Already working, team familiar, large ecosystem | No built-in structure, easy to create monoliths |
| Fastify | Faster, built-in validation, better DX | Migration effort, smaller ecosystem |
| NestJS | Strong structure, TypeScript-first, DI | Heavy, steep learning curve for beginner coder |

**Selected:** Express.js (keep)

**Reasoning:** V2 already works with Express. The problem isn't the framework — it's the lack of structure. We'll add proper route/service/controller separation while keeping the framework the team already understands. Moving to a new framework adds risk without solving the real problem (monolith architecture).

---

### Decision 2: Language — JavaScript vs TypeScript

**Options Considered:**
| Option | Pros | Cons |
|--------|------|------|
| JavaScript (keep from V2) | No migration, simpler for beginner coder | No type safety, harder to catch bugs |
| TypeScript | Type safety, better IDE support, self-documenting | Migration effort, build step complexity |

**Selected:** JavaScript (keep for V3.0, migrate to TypeScript in V3.x)

**Reasoning:** User is a beginner coder. Adding TypeScript compilation, tsconfig, and type annotations on top of a full architectural rebuild is too much change at once. We'll restructure first with clean JSDoc comments, then consider TypeScript migration when the architecture is stable.

---

### Decision 3: Testing Framework

**Selected:** Jest (Node.js standard)

**Reasoning:** Most popular Node.js testing framework, works well with Express, good mocking support, built-in coverage reporting. Aligns with the TDD framework's tier structure (config/unit/integration).

---

### Decision 4: Frontend Architecture

**Options Considered:**
| Option | Pros | Cons |
|--------|------|------|
| Embedded HTML in server.js (V2 approach) | Simple, single file deploy | 580+ lines of CSS/HTML/JS in server.js, untestable |
| Separate static files (HTML/CSS/JS) | Clean separation, cacheable, editable | Slightly more complex serving |
| React SPA | Component model, modern | Massive complexity increase for beginner coder |

**Selected:** Separate static files served by Express

**Reasoning:** The frontend is ~1,090 lines of HTML/CSS/JS embedded as a template literal. Moving it to `public/` with separate `index.html`, `styles.css`, and `app.js` files makes it editable, cacheable, and removes the biggest single chunk from server.js — all without introducing a build step or framework.

---

### Decision 5: Deployment Platform

**Selected:** Railway (keep from V2)

**Reasoning:** Already configured, already working, railway.json exists. No reason to change platforms during a rebuild.

---

## Architecture Summary

### Tech Stack

| Layer | Choice | Reasoning |
|-------|--------|-----------|
| Language | JavaScript (Node.js 18+) | Keep from V2, beginner-friendly |
| Framework | Express.js | Keep from V2, add structure |
| Testing | Jest | Node.js standard, TDD-friendly |
| AI Integration | Anthropic Claude API | Keep from V2, task parsing |
| Ads API | google-ads-api npm package | Keep from V2 |
| Deployment | Railway (Nixpacks) | Keep from V2 |

### Machine Mode

**Recommendation:** SINGLE

**Reasoning:** This is a web app — no GPU, no heavy compute. Everything runs on a single machine or in Railway's cloud.

### Code Documentation Approach

| Standard | Choice | Notes |
|----------|--------|-------|
| Docstring format | JSDoc | Standard for JavaScript |
| Type hints | JSDoc @param/@returns | Gives IDE support without TypeScript |
| Module headers | Yes — "Called by / Calls" pattern | Critical for a beginner coder to follow data flow |
| Data flow doc | Section in claude.md | Project isn't complex enough for separate file |
| Inline comments | Why-not-what | Comment decisions, not operations |
| Error message style | Problem + fix | Every error tells the user what went wrong and what to do |

### High-Level Structure

```
dealer-ads-tool/
├── src/
│   ├── server.js              # Express app setup + middleware
│   ├── routes/
│   │   ├── auth.js            # OAuth routes (/auth/google, /auth/callback, /auth/logout)
│   │   ├── accounts.js        # Account listing + structure routes
│   │   └── changes.js         # Task parsing + change application routes
│   ├── services/
│   │   ├── google-ads.js      # Google Ads API client factory + queries
│   │   ├── claude-parser.js   # Claude API integration + prompt building
│   │   └── change-executor.js # Individual change type handlers
│   ├── middleware/
│   │   ├── auth.js            # requireAuth middleware
│   │   └── error-handler.js   # Centralized error handling
│   └── utils/
│       ├── config.js          # Environment variable validation
│       └── sanitize.js        # GAQL query sanitization
├── public/
│   ├── index.html             # Frontend HTML
│   ├── styles.css             # Frontend CSS
│   └── app.js                 # Frontend JavaScript
├── tests/
│   ├── config/                # Tier 1: env validation, config checks
│   ├── unit/                  # Tier 2: parser, executor, sanitizer
│   ├── integration/           # Tier 3: API route tests
│   └── fakes/                 # In-memory test doubles
├── .env.example
├── .gitignore
├── package.json
├── jest.config.js
├── railway.json
├── Dockerfile
├── claude.md
├── project-state.md
└── quick-start.md
```

### Data Flow

```
User pastes Freshdesk task in browser
    ↓
POST /api/parse-task — routes/changes.js
    ↓
Build prompt with account structure — services/claude-parser.js
    ↓
Send to Anthropic API → receive structured JSON plan
    ↓
Display plan in browser (summary, changes, warnings)
    ↓
User clicks "Dry Run" or "Apply Changes"
    ↓
POST /api/apply-changes — routes/changes.js
    ↓
Loop through changes — services/change-executor.js
    ↓
Execute each change via Google Ads API — services/google-ads.js
    ↓
Return results to browser
```

### Deployment Configuration

**Target Platform:** Railway (Nixpacks auto-detect)

| Setting | Decision | Reasoning |
|---------|----------|-----------|
| **Local Port** | 3000 | Keep from V2 |
| **Health Check** | /health | Already exists in V2 |
| **Build** | Nixpacks (auto) | Railway default, already working |

**Environment Variables Needed:**
| Variable | Purpose | Secret? |
|----------|---------|---------|
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Google Ads API access | Yes |
| `GOOGLE_ADS_CLIENT_ID` | OAuth client ID | Yes |
| `GOOGLE_ADS_CLIENT_SECRET` | OAuth client secret | Yes |
| `SESSION_SECRET` | Express session encryption | Yes |
| `APP_URL` | OAuth callback URL | No |
| `PORT` | Server port | No |
| `ANTHROPIC_API_KEY` | Claude API for task parsing | Yes |

---

## V2 Tech Debt Audit

### Critical Issues (Fix in V3.0)

| Issue | Severity | What's Wrong | Fix |
|-------|----------|-------------|-----|
| **1,816-line monolith** | High | Everything in one file — CSS, HTML, JS frontend, Express routes, business logic, API calls | Split into modules per architecture above |
| **Zero test coverage** | High | No tests at all | TDD from scratch with Jest |
| **GAQL injection risk** | High | Queries use string interpolation: `campaign.name = '${name.replace(/'/g, "\\'")}'` — single-quote escaping is insufficient | Use parameterized queries or a proper sanitization utility |
| **No env validation** | Medium | Missing env vars cause cryptic runtime errors | Validate all required vars at startup in `utils/config.js` |
| **No error middleware** | Medium | Each route has its own try/catch with inconsistent error formatting | Centralized error handler middleware |
| **Frontend embedded in server** | Medium | ~1,090 lines of HTML/CSS/JS as a template literal | Move to `public/` directory |

### Known Bugs (Fix in V3.0)

| Bug | Impact | Root Cause |
|-----|--------|------------|
| **Budget always shows "?"** | User can't see campaign budgets in sidebar | Budget join query was removed due to permission issues (line 1362 comment) |
| **Session auth won't scale** | Single-server only, sessions lost on restart | In-memory session store — needs persistent store for multi-instance |
| **Token refresh every request** | Unnecessary API calls, slower responses | `getFreshAccessToken()` refreshes on every call instead of checking expiry |

### Architecture Debt (Track for V3.x)

| Issue | Impact | When to Fix |
|-------|--------|-------------|
| No audit log | Can't track what changes were applied when | V3.1 — needs a database |
| 500 keyword limit | Large accounts may show incomplete data | V3.1 — pagination |
| No rate limiting | API endpoints unprotected from abuse | V3.1 |
| Hard-coded Claude model | Can't easily switch models | V3.0 — move to config |
| No MCC ID caching | MCC discovery runs every session | V3.1 — persist in session properly |

---

## Connections That Need Rebuilding

These are the key integration points between V2 components that need to survive the split into modules:

| Connection | V2 Location | V3 Modules Involved | Notes |
|------------|-------------|---------------------|-------|
| **OAuth token flow** | server.js lines 1128-1178 | `routes/auth.js` → session store | Tokens stored in `req.session.tokens` — all downstream routes depend on this |
| **MCC discovery** | server.js lines 1218-1342 | `routes/accounts.js` → `services/google-ads.js` | Complex: lists accessible customers, finds MCC, queries child accounts with fallback |
| **Account structure** | server.js lines 1345-1491 | `routes/accounts.js` → `services/google-ads.js` | 4 separate GAQL queries (campaigns, ad groups, keywords, locations) assembled into tree |
| **Claude prompt building** | server.js lines 1746-1801 | `services/claude-parser.js` | System prompt + user message with account structure serialization |
| **Change execution** | server.js lines 1581-1741 | `services/change-executor.js` → `services/google-ads.js` | 10 change types, each with own GAQL lookups and mutations |
| **Frontend ↔ API** | Inline JS lines 666-1090 | `public/app.js` → all routes | 7 API calls: auth/status, accounts, structure, parse-task, apply-changes, auth/google, auth/logout |

---

## Phased Approach

### Phase 0: Planning ← YOU ARE HERE
- [x] Audit V2 codebase
- [x] Document tech debt and connections
- [x] Complete this intake document
- [ ] Review with Claude for gaps
- [ ] Initialize repository with new structure
- [ ] Create documentation files

### Phase 1: Foundation — Split Monolith + Config Tests
**Goal:** Same functionality as V2, but in modular files with Tier 1 tests.
**Estimated effort:** 2-3 sessions
**Deliverables:**
- [ ] Split server.js into route/service/middleware modules
- [ ] Move frontend to public/ directory
- [ ] Environment validation with tests
- [ ] GAQL sanitization utility with tests
- [ ] All API endpoints work identically to V2

### Phase 2: Unit Tests — Business Logic Coverage
**Goal:** Tier 2 test coverage on Claude parser, change executor, and account structure builder.
**Estimated effort:** 2-3 sessions
**Deliverables:**
- [ ] Claude prompt builder tests (with fake API responses)
- [ ] Change executor tests (all 10 change types with fakes)
- [ ] Account structure builder tests
- [ ] Fix budget display bug
- [ ] Fix GAQL injection vulnerability

### Phase 3: Integration Tests + Hardening
**Goal:** Tier 3 tests, error handling, and production readiness.
**Estimated effort:** 1-2 sessions
**Deliverables:**
- [ ] API route integration tests
- [ ] Centralized error handling
- [ ] Token refresh optimization
- [ ] Rate limiting
- [ ] Deploy to Railway with new structure

---

## Rejected Alternatives

### NestJS Full Rewrite
**What:** Rebuild entire backend using NestJS with TypeScript
**Why rejected:** Too much change for a beginner coder. The problem is monolith structure, not the framework. Express with proper organization solves the real issue.
**Conditions to reconsider:** If team grows beyond 1 person or project gets significantly more complex.

### React Frontend
**What:** Replace vanilla JS frontend with React SPA
**Why rejected:** The current frontend is functional and relatively simple (~1,090 lines). Adding React introduces a build pipeline, JSX compilation, and component architecture — massive complexity for marginal benefit at this scale.
**Conditions to reconsider:** When frontend needs grow (multiple pages, complex state management, shared components).

### Cloud Run Migration
**What:** Move from Railway to Google Cloud Run
**Why rejected:** Railway already works. The TDD framework templates reference Cloud Run, but that's a template default, not a requirement. Changing hosting during an architectural rebuild adds unnecessary risk.
**Conditions to reconsider:** If Railway becomes a cost or scaling concern.

---

## Open Questions

- [ ] Should we add a database (SQLite? PostgreSQL?) in Phase 3 for the audit log, or defer to V3.1?
- [ ] Is the Claude model (`claude-sonnet-4-20250514`) still the right choice, or should we use a newer/different model?
- [ ] Are there any Freshdesk task formats that V2 doesn't handle well that we should address in the rebuild?
- [ ] Should the 500 keyword limit be configurable per-account?
- [ ] Is Railway's free tier sufficient, or are there scaling concerns?

---

## Source Conversations

| AI | Topic | Key Contribution |
|----|-------|------------------|
| Claude (this session) | V2 Codebase Audit | Full audit of 1,816-line server.js, identified tech debt, connections, and rebuild strategy |

---

## New Project Checklist

Run through this with Claude after completing the sections above:

```
Claude, let's initialize this project:

1. [x] Review this planning intake for gaps or concerns
2. [ ] Create repository structure (or restructure existing repo)
3. [ ] Create directory structure per Architecture Summary
4. [ ] Generate claude.md (customize for this project)
5. [ ] Generate project-state.md (populate phases)
6. [ ] Generate quick-start.md
7. [ ] Create jest.config.js
8. [ ] Create package.json with test scripts
9. [ ] Create .env.example with required variables
10. [ ] Create .gitignore
11. [ ] Verify local server starts: npm run dev
12. [ ] Initial commit: git add -A && git commit -m "feat: project initialization — TDD rebuild from V2"
13. [ ] Push: git push -u origin V3
14. [ ] Archive this planning-intake.md (move to docs/archive/)

Ready to start Phase 1!
```

---

*This document is consumed during project setup. After initialization, refer to `claude.md` for development guidelines and `project-state.md` for current status.*

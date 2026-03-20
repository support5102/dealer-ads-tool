# Dealer Ads Tool — Quick Start

## What is this?
Google Ads management tool for automotive dealerships. Paste a Freshdesk task in plain English, Claude AI parses it into structured changes, preview them, then apply to Google Ads.

## Run locally
```bash
cp env.example .env   # fill in credentials
npm install
npm start             # http://localhost:3000
```

## Required env vars
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` — OAuth
- `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_MANAGER_ACCOUNT_ID` — Google Ads
- `ANTHROPIC_API_KEY`, `CLAUDE_MODEL` — Claude AI
- `SESSION_SECRET` — session encryption
- `PORT` (default 3000), `NODE_ENV`

## Deployment
Railway via Nixpacks. Config in `railway.json`. Health check at `/health`.

## Current state
Phase 1 (reliability) complete. Single-file architecture (`server.js`). No test suite yet. See `project-state.md` for full roadmap.

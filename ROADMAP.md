# AutoLander SaaS — Roadmap & Task Tracker

## Architecture

```
┌──────────────────────────────┐         ┌─────────────────────────────────────┐
│  Cloud API (Render)          │  HTTPS  │  Electron Desktop App               │
│  ──────────────────          │◄───────►│  ───────────────────                │
│  Express + PostgreSQL        │   WS    │  React dashboard (full windowed UI) │
│  AI (Claude API calls)       │         │  Puppeteer FB automation (local IP) │
│  Feed URL parsing + sync     │         │  One app for managers + salespeople  │
│  Google Calendar OAuth2      │         │  Auto-updates via electron-updater  │
│  Gmail + Twilio notifications│         │  FB session per salesperson          │
│  Stripe billing (Phase 5)    │         │                                     │
│  ~128MB RAM, no Chrome       │         │                                     │
└──────────────────────────────┘         └─────────────────────────────────────┘
```

## Orchestration Workflow

- **Claude Opus** — Orchestrator: writes task specs, reviews all output, wires things together
- **Codex agents** — All backend code: cloud API, services, DB, Electron main process, workers, adapters, feed parsers
- **Gemini agents** — All UI/UX code: React pages, components, hooks, contexts, styling, Electron renderer

---

## Phase 1: Repo Setup + Cloud API + Electron Shell ✅ COMPLETE

**Goal:** Electron app opens, user registers/logs in via cloud, sees React dashboard.

**What was built (101 files, 12,053 lines):**
- npm workspaces monorepo (shared, cloud, desktop)
- Cloud API: Express + Prisma + PostgreSQL, JWT auth, org scoping, 10 routes, 3 WS gateways, 5 service stubs
- Prisma schema: full multi-tenant with InventoryFeed, FeedSyncLog, OrgSettings
- Electron desktop app: main process, preload IPC bridge, React renderer (HashRouter)
- 9 pages, 13 components, 5 hooks, 3 contexts (Auth, Agent, Realtime)
- Worker layer: agent-client WS, command-router, 3 FB adapters, heartbeat, inbox-polling
- Shared package: protocol, constants, lead-scorer, validators, feed-parser stubs
- 6 battle-tested FB lib files copied unchanged from aximo-ai
- render.yaml for Render deployment

**To test:**
1. `cd C:\Users\Admin\autolander && npm install`
2. Create `.env` in `packages/cloud/` with `DATABASE_URL`
3. `npm run prisma:generate && npm run prisma:push`
4. `npm run cloud:dev` (starts cloud API on port 3000)
5. `npm run desktop:dev` (starts Electron with Vite dev server)
6. Register org → login → see empty dashboard

---

## Phase 2: FB Automation in Electron 🔲 NEXT

**Goal:** Post vehicles, scan inbox, authenticate FB — all via Puppeteer running locally in Electron.

**Who does what:**

| Task | Assigned To | Files |
|------|------------|-------|
| Adapt FB lib data paths to `~/.autolander/data/` | Codex | `desktop/lib/*.js` |
| Wire IPC handlers to real adapters (not stubs) | Codex | `desktop/src/main/ipc-handlers.js` |
| Adapt AssistedPost page for IPC frames | Gemini | `desktop/src/renderer/src/pages/AssistedPost.jsx` |
| Adapt FacebookAuth page for IPC screencast | Gemini | `desktop/src/renderer/src/pages/FacebookAuth.jsx` |
| Wire AgentClient WS to cloud on login | Codex | `desktop/src/worker/agent-client.js`, `ipc-handlers.js` |
| Create inbox-polling scheduler (5-min interval) | Codex | `desktop/src/worker/inbox-polling.js` |
| Test: FB login → post vehicle → inbox scan | Manual | — |

**Test:** FB login in Electron → post a vehicle → see update in cloud DB → scan inbox.

---

## Phase 3: Cloud AI + Notifications + Real-time 🔲

**Goal:** AI listings/replies via Claude. Google Calendar for appointments. Gmail + SMS alerts. Live sync.

**Who does what:**

| Task | Assigned To | Files |
|------|------------|-------|
| Implement ai-service.js (Claude listing gen + AI responder) | Codex | `cloud/src/services/ai-service.js` |
| Implement routes/ai.js (generate-listing, generate-response, score-lead) | Codex | `cloud/src/routes/ai.js` |
| Implement calendar.js (Google Calendar OAuth2 + slots) | Codex | `cloud/src/services/calendar.js` |
| Implement email.js (Gmail SMTP) | Codex | `cloud/src/services/email.js` |
| Implement sms.js (Twilio SMS) | Codex | `cloud/src/services/sms.js` |
| Extend routes/google.js (OAuth2 flow + credential storage in DB) | Codex | `cloud/src/routes/google.js` |
| Extend appointments.js (calendar sync on book/cancel) | Codex | `cloud/src/routes/appointments.js` |
| Extend agent-gateway.js (AI response loop: inbox → AI → send) | Codex | `cloud/src/ws/agent-gateway.js` |
| Extend client-gateway.js (broadcast events) | Codex | `cloud/src/ws/client-gateway.js` |
| Create ws-client.js + RealtimeContext in renderer | Gemini | `desktop/src/renderer/src/api/ws-client.js`, `context/RealtimeContext.jsx` |
| Live-update UI on WS events | Gemini | hooks, pages |

**Test:** Inbox scan → cloud AI reply → Puppeteer sends → manager sees live. Book appointment → Google Calendar.

---

## Phase 4: Feed URL Integration 🔲

**Goal:** Dealers configure feed URLs, cloud fetches/parses on schedule, inventory populates.

**Who does what:**

| Task | Assigned To | Files |
|------|------------|-------|
| Implement CarGurus feed parser | Codex | `shared/feed-parsers/cargurus.js` |
| Implement Cars.com feed parser | Codex | `shared/feed-parsers/carscom.js` |
| Implement AutoTrader ADF/XML parser | Codex | `shared/feed-parsers/autotrader.js` |
| Implement generic HTML/XML/JSON-LD parser | Codex | `shared/feed-parsers/generic.js` |
| Port HTML scraping from http-scraper.js as fallback | Codex | `shared/feed-parsers/generic.js` |
| Implement feed-sync.js (fetch → parse → validate → Prisma upsert) | Codex | `cloud/src/services/feed-sync.js` |
| Complete routes/feeds.js (sync trigger + cron scheduler) | Codex | `cloud/src/routes/feeds.js` |
| Add feed config UI in Settings page | Gemini | `desktop/src/renderer/src/pages/Settings.jsx` |
| Schedule: cloud runs feed sync on cron (default every 6h) | Codex | `cloud/src/index.js` |

**Test:** Paste CarGurus URL → Sync → inventory populates → vehicles visible in dashboard.

---

## Phase 5: Polish + Installer + Auto-Update 🔲

**Goal:** Production-ready desktop app with auto-update and role gating.

**Who does what:**

| Task | Assigned To | Files |
|------|------------|-------|
| electron-updater: check GitHub Releases, silent install | Codex | `desktop/src/main/updater.js` |
| Role-based UI (managers: read-only, salespeople: full, admins: all) | Gemini | `desktop/src/renderer/src/App.jsx`, pages |
| Offline queuing in agent-client (electron-store) | Codex | `desktop/src/worker/agent-client.js` |
| electron-builder config: NSIS installer, icons, code signing | Codex | `desktop/electron-builder.yml` |
| Billing stubs (Stripe prep) | Codex | `cloud/src/routes/billing.js` |
| render.yaml finalize | Codex | `render.yaml` |

**Test:** Install .exe → auto-updates on new GitHub Release. Manager sees read-only view.

---

## Key Data Flows

### Vehicle Posting
```
React "Post" click → IPC fb:post-vehicle
  → Main: GET cloud/api/vehicles/:id
  → Main: POST cloud/api/ai/generate-listing (Claude)
  → FbPosterAdapter: Puppeteer posts to FB Marketplace
  → IPC fb:progress events → React progress UI
  → Main: PUT cloud/api/vehicles/:id { fbPosted: true }
  → Cloud: WS broadcast POST_COMPLETE → all org clients
```

### Inbox AI Response Loop
```
inbox-polling.js (5 min) → FbInboxAdapter.checkInbox()
  → Puppeteer scans inbox, extracts new messages
  → POST cloud/api/conversations/:id/messages { direction: INBOUND }
  → POST cloud/api/ai/generate-response (Claude)
  → Cloud: updates lead score via lead-scorer.js
  → If no [HANDOFF]: Puppeteer sends AI reply via FB
  → POST cloud/api/conversations/:id/messages { direction: OUTBOUND }
  → If [HANDOFF]: cloud sets state HANDOFF_NEEDED + sends email alert
  → Cloud: WS broadcast CONVERSATION_UPDATED → manager sees live
```

### Feed Sync
```
Scheduled (6h) or manual trigger via UI
  → Cloud: feed-sync.js fetches feed URL
  → Parse with CarGurus/Cars.com/AutoTrader/generic parser
  → Validate + normalize each vehicle
  → Prisma upsert by (orgId, VIN) — track price changes in PriceHistory
  → Log results to FeedSyncLog
  → WS broadcast INVENTORY_UPDATED → all connected apps
```

### Appointment Booking
```
Lead conversation → AI suggests slots from Google Calendar
  → Buyer picks slot → POST cloud/api/appointments
  → Cloud: calendar.js creates Google Calendar event
  → Cloud: email.js sends confirmation to buyer
  → Cloud: sms.js sends reminder to salesperson
```

---

## Verification Checklist

- [ ] Register dealership via Electron → org + admin created in cloud DB
- [ ] Admin creates salesperson → salesperson logs in on another machine
- [ ] Salesperson connects FB → session stored locally, cloud shows status
- [ ] Configure feed URL → cloud syncs → inventory populates for all users
- [ ] Click "Post" on vehicle → AI generates listing → Puppeteer posts → marked as posted
- [ ] Inbox scan → buyer message → cloud AI reply → Puppeteer sends → appears in pipeline
- [ ] Manager logs in → sees all activity read-only, real-time updates
- [ ] Book appointment → Google Calendar event created → email confirmation sent
- [ ] Salesperson closes app → nothing happens → reopens → queued items process
- [ ] Push new version → installed app auto-updates silently

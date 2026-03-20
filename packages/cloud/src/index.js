'use strict';

const express = require('express');
const http = require('http');
const { rateLimit } = require('express-rate-limit');
const prisma = require('./db');
const { requireAuth } = require('./middleware/auth');
const { orgScope } = require('./middleware/org-scope');

// Route factories
const { createAuthRouter } = require('./routes/auth');
const createOrgsRouter = require('./routes/orgs');
const createVehiclesRouter = require('./routes/vehicles');
const createConversationsRouter = require('./routes/conversations');
const createAppointmentsRouter = require('./routes/appointments');
const createAgentsRouter = require('./routes/agents');
const createDealerConfigRouter = require('./routes/dealer-config');
const createFeedsRouter = require('./routes/feeds');
const createAiRouter = require('./routes/ai');
const createBillingRouter = require('./routes/billing');
const feedSync = require('./services/feed-sync');

// WebSocket gateways
const { AgentGateway } = require('./ws/agent-gateway');
const { ClientGateway } = require('./ws/client-gateway');
const { CommandDispatcher } = require('./ws/command-dispatcher');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// --- Body parsing ---
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// --- CORS ---
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = (process.env.CORS_ORIGINS || '*').split(',').map(s => s.trim());

  if (allowed.includes('*') || allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// --- Rate limiting ---
const generalLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', generalLimiter);

// --- Health check (no auth) ---
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: require('../package.json').version });
});

// --- Auth routes (no orgScope — first user doesn't have org yet) ---
app.use('/api/auth', createAuthRouter(prisma));

// --- Protected API routes ---
app.use('/api/orgs', requireAuth, createOrgsRouter(prisma));
app.use('/api/vehicles', requireAuth, orgScope, createVehiclesRouter(prisma));
app.use('/api/conversations', requireAuth, orgScope, createConversationsRouter(prisma));
app.use('/api/appointments', requireAuth, orgScope, createAppointmentsRouter(prisma));
app.use('/api/agents', requireAuth, orgScope, createAgentsRouter(prisma));
app.use('/api/dealer-config', requireAuth, orgScope, createDealerConfigRouter(prisma));
app.use('/api/feeds', requireAuth, orgScope, createFeedsRouter(prisma));
app.use('/api/ai', requireAuth, orgScope, createAiRouter(prisma));
app.use('/api/billing', requireAuth, orgScope, createBillingRouter(prisma));

// --- No SPA serving — React runs inside Electron ---

// --- Create HTTP server ---
const server = http.createServer(app);

// --- WebSocket gateways ---
const clientGateway = new ClientGateway();
const agentGateway = new AgentGateway({ prisma, dashboardGateway: clientGateway });
const commandDispatcher = new CommandDispatcher({ agentGateway, dashboardGateway: clientGateway, prisma });

app.set('agentGateway', agentGateway);
app.set('clientGateway', clientGateway);

// Make dispatcher available to route handlers
app.set('commandDispatcher', commandDispatcher);

// Handle WebSocket upgrades
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (pathname === '/ws/agent') {
    agentGateway.handleUpgrade(req, socket, head);
  } else if (pathname === '/ws/dashboard') {
    clientGateway.handleUpgrade(req, socket, head);
  } else {
    socket.destroy();
  }
});

// --- Pending message sweep (every 30 seconds) ---
const { Commands } = require('@autolander/shared/protocol');

setInterval(async () => {
  try {
    // Find PENDING outbound messages older than 30 seconds, max 3 attempts
    const pendingMessages = await prisma.message.findMany({
      where: {
        direction: 'OUTBOUND',
        status: 'PENDING',
        attempts: { lt: 3 },
        createdAt: { lt: new Date(Date.now() - 30000) },
      },
      include: {
        conversation: {
          select: {
            id: true,
            threadId: true,
            orgId: true,
            buyerName: true,
            fbThreadUrl: true,
            vehicle: { select: { year: true, make: true, model: true } },
          },
        },
      },
      take: 10,
      orderBy: { createdAt: 'asc' },
    });

    for (const msg of pendingMessages) {
      const conv = msg.conversation;
      if (!conv) continue;

      const onlineAgents = agentGateway.getOnlineAgents(conv.orgId);
      if (onlineAgents.length === 0) continue;

      const dispatchListingTitle = conv.vehicle
        ? [conv.vehicle.year, conv.vehicle.make, conv.vehicle.model].filter(Boolean).join(' ')
        : '';

      try {
        const result = await commandDispatcher.dispatch(conv.orgId, onlineAgents[0].id, Commands.SEND_MESSAGE, {
          threadId: conv.threadId || conv.id,
          fbThreadUrl: conv.fbThreadUrl || null,
          text: msg.text,
          expectedBuyer: conv.buyerName,
          listingTitle: dispatchListingTitle,
          messageId: msg.id,
        });

        await prisma.message.update({
          where: { id: msg.id },
          data: {
            status: result && result.sent === false ? 'FAILED' : 'SENT',
            attempts: msg.attempts + 1,
          },
        });
        if (result && result.sent === false) {
          console.warn(`[sweep] Agent reported send failure for msg ${msg.id} on conv ${conv.id}`);
        } else {
          console.log(`[sweep] Sent pending msg ${msg.id} for conv ${conv.id} (attempt ${msg.attempts + 1})`);
        }
      } catch (err) {
        const nextAttempts = msg.attempts + 1;
        await prisma.message.update({
          where: { id: msg.id },
          data: {
            attempts: nextAttempts,
            status: nextAttempts >= 3 ? 'FAILED' : 'PENDING',
          },
        });
        console.log(`[sweep] Failed to dispatch msg ${msg.id}, attempt ${nextAttempts}: ${err.message}`);
      }
    }

    // Mark messages with 3+ attempts as FAILED
    await prisma.message.updateMany({
      where: {
        direction: 'OUTBOUND',
        status: 'PENDING',
        attempts: { gte: 3 },
      },
      data: { status: 'FAILED' },
    });
  } catch (err) {
    console.error('[sweep] Error:', err.message);
  }
}, 30000);

// --- Start server ---
server.listen(PORT, () => {
  console.log(`[cloud] AutoLander Cloud API running on port ${PORT}`);
  console.log(`[cloud] Agent gateway at ws://localhost:${PORT}/ws/agent`);
  console.log(`[cloud] Client gateway at ws://localhost:${PORT}/ws/dashboard`);
  console.log(`[cloud] Health check at http://localhost:${PORT}/health`);

  const runFeedSyncCycle = async () => {
    console.log('[feed-scheduler] Starting feed sync cycle');
    try {
      const feeds = await prisma.inventoryFeed.findMany({
        where: { enabled: true },
        orderBy: { createdAt: 'asc' },
      });
      console.log(`[feed-scheduler] Found ${feeds.length} enabled feeds`);

      for (const feed of feeds) {
        try {
          const feedUrl = typeof feed.feedUrl === 'string' ? feed.feedUrl.toLowerCase() : '';
          const requiresBrowserFetch =
            feed.feedType === 'CARSCOM' ||
            feed.feedType === 'CARGURUS' ||
            feedUrl.includes('cars.com') ||
            feedUrl.includes('cargurus.com');

          if (requiresBrowserFetch) {
            console.log(`[feed-scheduler] Skipping ${feed.feedType || 'browser-protected'} feed ${feed.id} (requires browser fetch)`);
            continue;
          }

          const result = await feedSync.syncFeed(feed, prisma);
          console.log(
            `[feed-scheduler] Feed ${feed.id} synced: found=${result.vehiclesFound}, added=${result.vehiclesAdded}, updated=${result.vehiclesUpdated}, errors=${result.errors.length}`
          );

          // Broadcast updated stats to connected dashboard clients
          try {
            const [total, posted, stale] = await Promise.all([
              prisma.vehicle.count({ where: { orgId: feed.orgId, status: 'ACTIVE' } }),
              prisma.vehicle.count({ where: { orgId: feed.orgId, fbPosted: true } }),
              prisma.vehicle.count({ where: { orgId: feed.orgId, fbPosted: true, fbStale: true, status: 'ACTIVE' } }),
            ]);
            clientGateway.broadcast(feed.orgId, {
              type: 'feed_sync_complete',
              feedId: feed.id,
              result: {
                vehiclesFound: result.vehiclesFound,
                vehiclesAdded: result.vehiclesAdded,
                vehiclesUpdated: result.vehiclesUpdated,
              },
              stats: { vehicles: total, posted, stale },
            });
          } catch (broadcastErr) {
            console.error(`[feed-scheduler] Broadcast error for feed ${feed.id}: ${broadcastErr.message}`);
          }
        } catch (feedError) {
          console.error(`[feed-scheduler] Feed ${feed.id} failed: ${feedError.message}`);
        }
      }
    } catch (error) {
      console.error(`[feed-scheduler] Sync cycle failed: ${error.message}`);
    }
  };

  setTimeout(() => {
    runFeedSyncCycle().catch(error => {
      console.error(`[feed-scheduler] Startup sync failed: ${error.message}`);
    });
  }, 30_000);

  setInterval(() => {
    runFeedSyncCycle().catch(error => {
      console.error(`[feed-scheduler] Interval sync failed: ${error.message}`);
    });
  }, 21_600_000);
});

module.exports = { app, server, prisma };

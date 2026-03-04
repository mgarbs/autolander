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
const createGoogleRouter = require('./routes/google');
const createFeedsRouter = require('./routes/feeds');
const createAiRouter = require('./routes/ai');

// WebSocket gateways
const { AgentGateway } = require('./ws/agent-gateway');
const { ClientGateway } = require('./ws/client-gateway');
const { CommandDispatcher } = require('./ws/command-dispatcher');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const app = express();
app.disable('x-powered-by');

// --- Body parsing ---
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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
app.use('/api/google', requireAuth, orgScope, createGoogleRouter(prisma));
app.use('/api/feeds', requireAuth, orgScope, createFeedsRouter(prisma));
app.use('/api/ai', requireAuth, orgScope, createAiRouter(prisma));

// --- No SPA serving — React runs inside Electron ---

// --- Create HTTP server ---
const server = http.createServer(app);

// --- WebSocket gateways ---
const clientGateway = new ClientGateway();
const agentGateway = new AgentGateway({ prisma, dashboardGateway: clientGateway });
const commandDispatcher = new CommandDispatcher({ agentGateway, dashboardGateway: clientGateway, prisma });

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

// --- Start server ---
server.listen(PORT, () => {
  console.log(`[cloud] AutoLander Cloud API running on port ${PORT}`);
  console.log(`[cloud] Agent gateway at ws://localhost:${PORT}/ws/agent`);
  console.log(`[cloud] Client gateway at ws://localhost:${PORT}/ws/dashboard`);
  console.log(`[cloud] Health check at http://localhost:${PORT}/health`);
});

module.exports = { app, server, prisma };

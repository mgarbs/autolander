'use strict';

const express = require('express');
const { requireRole } = require('../middleware/auth');

module.exports = function createBillingRouter(prisma) {
  const router = express.Router();
  void prisma;

  router.use(requireRole('ADMIN'));

  router.get('/status', async (_req, res) => {
    res.json({
      plan: 'free',
      status: 'active',
      features: {
        maxVehicles: 50,
        maxSalespeople: 3,
        aiListings: true,
      },
      message: 'Billing integration coming soon',
    });
  });

  router.get('/plans', async (_req, res) => {
    res.json({
      plans: [
        {
          id: 'free',
          name: 'Starter',
          price: 0,
          features: { maxVehicles: 50, maxSalespeople: 3 },
        },
        {
          id: 'pro',
          name: 'Professional',
          price: 99,
          features: { maxVehicles: 500, maxSalespeople: 10 },
        },
        {
          id: 'enterprise',
          name: 'Enterprise',
          price: 299,
          features: { maxVehicles: -1, maxSalespeople: -1 },
        },
      ],
    });
  });

  router.post('/checkout', async (req, res) => {
    const { planId } = req.body || {};
    void planId;
    res.json({ error: 'Stripe integration not yet configured. Contact support.' });
  });

  router.post('/webhook', async (_req, res) => {
    res.json({ received: true });
  });

  router.get('/invoices', async (_req, res) => {
    res.json({ invoices: [] });
  });

  router.post('/cancel', async (_req, res) => {
    res.json({ error: 'Stripe integration not yet configured.' });
  });

  return router;
};

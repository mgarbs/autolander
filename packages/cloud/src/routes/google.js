'use strict';

const express = require('express');
const { requireRole } = require('../middleware/auth');

module.exports = function createGoogleRouter(prisma) {
  const router = express.Router();

  router.get('/status', (req, res) => {
    const emailConfigured = !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
    res.json({
      calendar: { credentialsUploaded: false, connected: false },
      email: { configured: emailConfigured, address: process.env.GMAIL_USER || null },
    });
  });

  router.put('/email', requireRole('ADMIN', 'MANAGER'), (req, res) => {
    const { address, appPassword } = req.body;
    if (!address || !appPassword) {
      return res.status(400).json({ error: 'address and appPassword are required.' });
    }
    process.env.GMAIL_USER = address;
    process.env.GMAIL_APP_PASSWORD = appPassword;
    res.json({ success: true });
  });

  return router;
};

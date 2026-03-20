'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const {
  generateTokens,
  verifyAccessToken,
  verifyRefreshToken,
  revokeRefreshToken,
  extractToken,
} = require('../middleware/auth');

const SALT_ROUNDS = 10;
const USERNAME_PATTERN = /^[a-z0-9_]{3,30}$/;

function sanitizeUser(user) {
  if (!user) return user;
  const { passwordHash, ...safe } = user;
  return safe;
}

function createAuthRouter(prisma) {
  const router = express.Router();

  router.post('/register', async (req, res) => {
    try {
      const { username, password, displayName, role, orgName, orgSlug } = req.body || {};

      const normalizedUsername = (username || '').trim().toLowerCase();
      if (!USERNAME_PATTERN.test(normalizedUsername)) {
        return res.status(400).json({ error: 'Username must be 3-30 chars: lowercase letters, numbers, underscore.' });
      }
      if (typeof password !== 'string' || password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters.' });
      }
      if (!displayName || typeof displayName !== 'string' || !displayName.trim()) {
        return res.status(400).json({ error: 'Display name is required.' });
      }

      let orgId;
      let userRole;

      // Check if an admin is inviting a team member (has valid token)
      const token = extractToken(req);
      const decoded = token ? verifyAccessToken(token) : null;

      if (decoded && ['ADMIN', 'MANAGER'].includes(decoded.role)) {
        // Admin/manager inviting a team member into their org
        orgId = decoded.orgId;
        userRole = ['ADMIN', 'MANAGER', 'AGENT'].includes(role) ? role : 'AGENT';
      } else {
        // Self-signup: create a new org for this user (isolated dealership)
        const resolvedOrgName = (orgName && orgName.trim()) || `${displayName.trim()}'s Dealership`;
        const slug = (orgSlug || resolvedOrgName).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36);

        const org = await prisma.organization.create({
          data: { name: resolvedOrgName.trim(), slug },
        });
        orgId = org.id;
        userRole = 'ADMIN';
      }

      const existing = await prisma.user.findFirst({
        where: { orgId, username: normalizedUsername },
      });
      if (existing) {
        return res.status(409).json({ error: `Username '${normalizedUsername}' already exists.` });
      }

      const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

      const user = await prisma.user.create({
        data: {
          orgId,
          username: normalizedUsername,
          displayName: displayName.trim(),
          role: userRole,
          passwordHash,
        },
      });

      return res.status(201).json({ user: sanitizeUser(user) });
    } catch (error) {
      console.error('[auth] Register error:', error.message);
      return res.status(400).json({ error: error.message || 'Registration failed.' });
    }
  });

  router.post('/login', async (req, res) => {
    try {
      const { username, password } = req.body || {};
      const normalizedUsername = (username || '').trim().toLowerCase();

      const user = await prisma.user.findFirst({
        where: { username: normalizedUsername },
      });

      if (!user || !user.passwordHash) {
        return res.status(401).json({ error: 'Invalid username or password.' });
      }

      const valid = await bcrypt.compare(password || '', user.passwordHash);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid username or password.' });
      }

      const tokens = await generateTokens(user, prisma);

      return res.json({
        user: sanitizeUser(user),
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
      });
    } catch (error) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
  });

  router.post('/refresh', async (req, res) => {
    try {
      const { refreshToken } = req.body || {};
      const decoded = await verifyRefreshToken(refreshToken, prisma);

      if (!decoded || !decoded.sub) {
        return res.status(401).json({ error: 'Invalid or expired refresh token.' });
      }

      const user = await prisma.user.findUnique({ where: { id: decoded.sub } });
      if (!user) {
        await revokeRefreshToken(refreshToken, prisma);
        return res.status(401).json({ error: 'Invalid or expired refresh token.' });
      }

      await revokeRefreshToken(refreshToken, prisma);
      const tokens = await generateTokens(user, prisma);

      return res.json({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
      });
    } catch (error) {
      return res.status(401).json({ error: 'Invalid or expired refresh token.' });
    }
  });

  router.get('/me', async (req, res) => {
    try {
      const token = extractToken(req);
      const decoded = verifyAccessToken(token);
      if (!decoded || !decoded.sub) {
        return res.status(401).json({ error: 'Authentication required.' });
      }

      const user = await prisma.user.findUnique({ where: { id: decoded.sub } });
      if (!user) {
        return res.status(401).json({ error: 'Authentication required.' });
      }

      return res.json({ user: sanitizeUser(user) });
    } catch (error) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
  });

  router.post('/logout', async (req, res) => {
    try {
      const { refreshToken } = req.body || {};
      await revokeRefreshToken(refreshToken, prisma);
    } catch (_) {}
    return res.json({ success: true });
  });

  router.get('/users', async (req, res) => {
    try {
      const token = extractToken(req);
      const decoded = verifyAccessToken(token);
      if (!decoded || !['ADMIN', 'MANAGER'].includes(decoded.role)) {
        return res.status(403).json({ error: 'Forbidden.' });
      }

      const users = await prisma.user.findMany({
        where: { orgId: decoded.orgId },
        orderBy: { createdAt: 'asc' },
      });

      return res.json({ users: users.map(sanitizeUser) });
    } catch (error) {
      return res.status(403).json({ error: 'Forbidden.' });
    }
  });

  return router;
}

module.exports = { createAuthRouter };

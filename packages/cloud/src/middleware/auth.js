'use strict';

const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const ACCESS_TOKEN_EXPIRY = '24h';
const REFRESH_TOKEN_EXPIRY = '30d';
const ACCESS_TOKEN_EXPIRES_IN_SECONDS = 86400;

function generateEphemeralSecret(envName) {
  const secret = crypto.randomBytes(64).toString('hex');
  console.warn(`[auth] ${envName} not set — using ephemeral secret (will not survive restarts).`);
  return secret;
}

const JWT_SECRET = process.env.JWT_SECRET || generateEphemeralSecret('JWT_SECRET');
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || generateEphemeralSecret('JWT_REFRESH_SECRET');

async function generateTokens(user, prisma) {
  if (!user?.id) throw new TypeError('generateTokens requires user with id');

  const accessPayload = {
    sub: user.id,
    username: user.username,
    role: user.role,
    orgId: user.orgId,
    salespersonId: user.salespersonId || null,
  };
  const refreshPayload = { sub: user.id, type: 'refresh' };

  const accessToken = jwt.sign(accessPayload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
  const refreshToken = jwt.sign(refreshPayload, JWT_REFRESH_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRY });

  await prisma.refreshToken.deleteMany({
    where: { userId: user.id, expiresAt: { lt: new Date() } },
  });

  await prisma.refreshToken.create({
    data: {
      token: refreshToken,
      userId: user.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_EXPIRES_IN_SECONDS };
}

function verifyAccessToken(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

async function verifyRefreshToken(token, prisma) {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, JWT_REFRESH_SECRET);
    const stored = await prisma.refreshToken.findFirst({
      where: { token, expiresAt: { gt: new Date() } },
    });
    if (!stored || String(decoded.sub) !== String(stored.userId)) return null;
    return decoded;
  } catch {
    return null;
  }
}

async function revokeRefreshToken(token, prisma) {
  if (!token) return false;
  const result = await prisma.refreshToken.deleteMany({ where: { token } });
  return result.count > 0;
}

async function revokeAllUserTokens(userId, prisma) {
  if (!userId) return 0;
  const result = await prisma.refreshToken.deleteMany({ where: { userId } });
  return result.count;
}

function extractToken(req) {
  const auth = req.headers?.authorization;
  if (typeof auth !== 'string') return null;
  const [scheme, token] = auth.split(' ');
  return scheme === 'Bearer' && token ? token : null;
}

function requireAuth(req, res, next) {
  const token = extractToken(req);
  const decoded = verifyAccessToken(token);

  if (!decoded) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  req.user = {
    id: decoded.sub,
    username: decoded.username,
    role: decoded.role,
    orgId: decoded.orgId,
    salespersonId: decoded.salespersonId,
  };

  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions.' });
    }
    next();
  };
}

module.exports = {
  generateTokens,
  verifyAccessToken,
  verifyRefreshToken,
  revokeRefreshToken,
  revokeAllUserTokens,
  extractToken,
  requireAuth,
  requireRole,
  JWT_SECRET,
  JWT_REFRESH_SECRET,
};

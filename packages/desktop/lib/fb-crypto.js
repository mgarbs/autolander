/**
 * Facebook session cookie encryption/decryption
 *
 * Uses AES-256-GCM with a key derived from FB_SESSION_SECRET env var.
 * Falls back to plaintext storage if FB_SESSION_SECRET is not set.
 * Handles both new encrypted format and legacy plaintext format.
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';

function getEncryptionKey() {
  const secret = process.env.FB_SESSION_SECRET || '';
  if (!secret) return null;
  // Expect a 64-char hex string (32 bytes). Pad or truncate to be safe.
  return Buffer.from(secret.padEnd(64, '0').slice(0, 64), 'hex');
}

/**
 * Encrypt a cookies array for storage.
 * Returns an object to spread into the session file.
 * If FB_SESSION_SECRET is not set, returns plaintext fallback.
 */
function encryptCookies(cookies) {
  const key = getEncryptionKey();
  if (!key) {
    // No secret configured — store plaintext (legacy behaviour)
    return { encrypted: false, cookies };
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const data = JSON.stringify(cookies);
  const ciphertext = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  return {
    encrypted: true,
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
}

/**
 * Decrypt cookies from a session file object.
 * Handles both new encrypted format and legacy plaintext format.
 */
function decryptCookies(sessionData) {
  if (!sessionData.encrypted) {
    // Legacy plaintext format — cookies stored directly
    return sessionData.cookies || [];
  }
  const key = getEncryptionKey();
  if (!key) {
    throw new Error('FB_SESSION_SECRET is not set — cannot decrypt stored session. Set the env var and re-authenticate.');
  }
  const iv = Buffer.from(sessionData.iv, 'hex');
  const authTag = Buffer.from(sessionData.authTag, 'hex');
  const ciphertext = Buffer.from(sessionData.ciphertext, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

module.exports = { encryptCookies, decryptCookies };

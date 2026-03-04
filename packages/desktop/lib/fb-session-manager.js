/**
 * Facebook Session Manager
 *
 * Validates stored session cookies, runs a periodic refresh loop to keep
 * sessions warm, and exposes a status object consumed by the dashboard API.
 *
 * Handles both the new encrypted session format (written by fb-auth-session.js)
 * and the legacy plaintext format from older sessions.
 */

const fs = require('fs');
const path = require('path');
const { decryptCookies } = require('./fb-crypto');

const DATA_DIR = process.env.AUTO_SALES_DATA_DIR || path.join(__dirname, '../data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const MAX_SESSION_AGE_DAYS = 7;
const DEFAULT_REFRESH_INTERVAL_HOURS = Number(process.env.FB_SESSION_REFRESH_INTERVAL_HOURS) || 6;

class FbSessionManager {
  constructor(salespersonId = 'default') {
    this.salespersonId = salespersonId;
    this.sessionFile = path.join(SESSIONS_DIR, `${salespersonId}_fb_session.json`);
    this._refreshTimer = null;
  }

  _readSessionFile() {
    if (!fs.existsSync(this.sessionFile)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
    } catch (_) {
      return null;
    }
  }

  /**
   * Decrypt and return the raw cookies array, or null if unavailable.
   */
  getCookies() {
    const session = this._readSessionFile();
    if (!session) return null;
    try {
      return decryptCookies(session);
    } catch (e) {
      console.warn(`[fb-session] [${this.salespersonId}] Could not decrypt session: ${e.message}`);
      return null;
    }
  }

  /**
   * Check that the required Facebook auth cookies are present.
   */
  _hasRequiredCookies() {
    const cookies = this.getCookies();
    if (!Array.isArray(cookies)) return false;
    return cookies.some(c => c.name === 'c_user') && cookies.some(c => c.name === 'xs');
  }

  /**
   * Check age and cookie presence. Updates validatedAt on success.
   * Returns { valid: bool, reason?: string, ageDays?: number, daysLeft?: number }
   */
  validateSession() {
    const session = this._readSessionFile();
    if (!session) return { valid: false, reason: 'No session file' };

    const savedAt = new Date(session.savedAt);
    const ageDays = (Date.now() - savedAt.getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays > MAX_SESSION_AGE_DAYS) {
      return { valid: false, reason: 'Session expired (> 7 days old)' };
    }

    if (!this._hasRequiredCookies()) {
      return { valid: false, reason: 'Missing required cookies (c_user / xs)' };
    }

    // Stamp validatedAt so the dashboard can show last-checked time
    session.validatedAt = new Date().toISOString();
    try {
      fs.writeFileSync(this.sessionFile, JSON.stringify(session, null, 2));
    } catch (_) {}

    return {
      valid: true,
      ageDays: Math.floor(ageDays),
      daysLeft: Math.round(MAX_SESSION_AGE_DAYS - ageDays),
    };
  }

  /**
   * Returns a status object suitable for the /api/fb-auth/status response.
   */
  getStatus() {
    const session = this._readSessionFile();
    if (!session) {
      return { connected: false, message: 'Not connected' };
    }
    try {
      const savedAt = new Date(session.savedAt);
      const ageDays = (Date.now() - savedAt.getTime()) / (1000 * 60 * 60 * 24);
      const daysLeft = Math.max(0, Math.round(MAX_SESSION_AGE_DAYS - ageDays));

      if (daysLeft <= 0) {
        return { connected: false, message: 'Session expired — reconnect needed' };
      }
      if (!this._hasRequiredCookies()) {
        return { connected: false, message: 'Session invalid — reconnect needed' };
      }

      return {
        connected: true,
        daysLeft,
        savedAt: savedAt.toLocaleDateString(),
        validatedAt: session.validatedAt
          ? new Date(session.validatedAt).toLocaleDateString()
          : null,
        encrypted: !!session.encrypted,
        message: `Connected (${daysLeft} days remaining)`,
      };
    } catch (_) {
      return { connected: false, message: 'Session file corrupted' };
    }
  }

  /**
   * Delete the stored session file (force re-authentication).
   */
  deleteSession() {
    if (fs.existsSync(this.sessionFile)) {
      fs.unlinkSync(this.sessionFile);
      console.log(`[fb-session] [${this.salespersonId}] Session deleted`);
      return true;
    }
    return false;
  }

  /**
   * Start a periodic validation loop. Keeps validatedAt fresh and logs
   * when the session has expired so operators are notified in logs.
   */
  scheduleRefresh(intervalHours = DEFAULT_REFRESH_INTERVAL_HOURS) {
    if (this._refreshTimer) clearInterval(this._refreshTimer);
    const ms = intervalHours * 60 * 60 * 1000;
    this._refreshTimer = setInterval(() => {
      const result = this.validateSession();
      const tag = `[fb-session] [${this.salespersonId}]`;
      if (result.valid) {
        console.log(`${tag} Session still valid — ${result.daysLeft} days remaining`);
      } else {
        console.warn(`${tag} Session validation failed: ${result.reason}`);
      }
    }, ms);
    console.log(`[fb-session] [${this.salespersonId}] Refresh scheduled every ${intervalHours}h`);
  }

  stopRefresh() {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
  }
}

module.exports = { FbSessionManager };

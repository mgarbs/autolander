const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = path.join(os.homedir(), '.autolander', 'data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const SCREENSHOTS_DIR = path.join(DATA_DIR, 'screenshots');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const TEMP_DIR = path.join(DATA_DIR, 'temp');
// Legacy single profile — kept for backward compat but should not be used
// directly. Use chromeProfileDir(purpose) instead to avoid SingletonLock
// contention between concurrent Puppeteer instances.
const CHROME_PROFILE_DIR = path.join(DATA_DIR, 'chrome-profile');

/**
 * Return an isolated Chrome profile directory for the given purpose.
 *
 * Chrome only allows ONE instance per userDataDir (SingletonLock). The old
 * code shared a single `chrome-profile` dir across auth, poster, and inbox
 * monitor — causing hangs when two tried to run at the same time.
 *
 * Now each consumer gets its own subdirectory:
 *   ~/.autolander/data/chrome-profiles/{salespersonId}/{purpose}
 *
 * This means auth, poster, and inbox can each have a live browser without
 * fighting over the lock, and per-user sessions stay isolated.
 */
function chromeProfileDir(purpose = 'default', salespersonId = 'default') {
  const dir = path.join(DATA_DIR, 'chrome-profiles', salespersonId, purpose);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ensureDirs() {
  [DATA_DIR, SESSIONS_DIR, SCREENSHOTS_DIR, LOGS_DIR, TEMP_DIR, CHROME_PROFILE_DIR].forEach((dir) => {
    fs.mkdirSync(dir, { recursive: true });
  });
}

module.exports = {
  DATA_DIR,
  SESSIONS_DIR,
  SCREENSHOTS_DIR,
  LOGS_DIR,
  TEMP_DIR,
  CHROME_PROFILE_DIR,
  chromeProfileDir,
  ensureDirs,
};

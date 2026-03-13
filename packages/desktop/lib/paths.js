const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = path.join(os.homedir(), '.autolander', 'data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const SCREENSHOTS_DIR = path.join(DATA_DIR, 'screenshots');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const TEMP_DIR = path.join(DATA_DIR, 'temp');
const CHROME_PROFILE_DIR = path.join(DATA_DIR, 'chrome-profile');

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
  ensureDirs,
};

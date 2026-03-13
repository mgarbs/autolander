'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Platform-specific Chrome executable names.
 */
function getChromeExeNames() {
  switch (process.platform) {
    case 'win32':
      return ['chrome.exe'];
    case 'darwin':
      return [
        'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome',
      ];
    default: // linux
      return ['chrome'];
  }
}

/**
 * Recursively search a directory (up to maxDepth) for a Chrome executable.
 */
function findChromeIn(dir, maxDepth = 4, depth = 0) {
  if (depth > maxDepth) return undefined;
  const exeNames = getChromeExeNames();

  for (const name of exeNames) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }

  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const found = findChromeIn(path.join(dir, entry.name), maxDepth, depth + 1);
        if (found) return found;
      }
    }
  } catch (_) {}

  return undefined;
}

/**
 * Get the user-data directory for storing Chrome.
 * In packaged app: next to the app resources
 * In dev: packages/desktop/.chromium
 */
function getChromeDir() {
  try {
    const { app } = require('electron');
    if (app.isPackaged) {
      return path.join(app.getPath('userData'), 'chromium');
    }
  } catch (_) {}
  return path.join(__dirname, '..', '.chromium');
}

/**
 * Download Chrome for Puppeteer if not already present.
 * Returns the path to the Chrome executable.
 */
async function ensureChrome() {
  // 1. Check env var
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  // 2. Check bundled Chrome in resources (packaged app)
  try {
    const { app } = require('electron');
    if (app.isPackaged) {
      const resourcesDir = path.join(process.resourcesPath, 'chromium');
      if (fs.existsSync(resourcesDir)) {
        const found = findChromeIn(resourcesDir);
        if (found) return found;
      }
    }
  } catch (_) {}

  // 3. Check cached Chrome in user data
  const chromeDir = getChromeDir();
  if (fs.existsSync(chromeDir)) {
    const found = findChromeIn(chromeDir);
    if (found) return found;
  }

  // 4. Try Puppeteer's default cache
  try {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({ headless: true });
    const execPath = browser.process().spawnfile;
    await browser.close();
    if (execPath && fs.existsSync(execPath)) return execPath;
  } catch (_) {}

  // 5. Download Chrome via Puppeteer's install API
  console.log('[chrome-path] Chrome not found, downloading...');
  fs.mkdirSync(chromeDir, { recursive: true });
  try {
    // Use @puppeteer/browsers which is bundled with puppeteer
    const { install, Browser, detectBrowserPlatform } = require('@puppeteer/browsers');
    const platform = detectBrowserPlatform();
    const buildId = 'stable';
    const result = await install({
      browser: Browser.CHROME,
      buildId,
      cacheDir: chromeDir,
      platform,
    });
    if (result && result.executablePath && fs.existsSync(result.executablePath)) {
      console.log('[chrome-path] Chrome downloaded to:', result.executablePath);
      return result.executablePath;
    }
    // Fallback: search the cache dir
    const found = findChromeIn(chromeDir);
    if (found) {
      console.log('[chrome-path] Chrome found at:', found);
      return found;
    }
  } catch (err) {
    console.error('[chrome-path] Failed to download Chrome:', err.message);
    // Fallback: try npx in dev mode
    try {
      const { execSync } = require('child_process');
      execSync(`npx puppeteer browsers install chrome --path "${chromeDir}"`, {
        stdio: 'inherit',
        timeout: 5 * 60 * 1000,
      });
      const found = findChromeIn(chromeDir);
      if (found) return found;
    } catch (_) {}
  }

  // 6. Fall back to undefined (Puppeteer will try its own default)
  return undefined;
}

/**
 * Synchronous version — returns cached path or undefined.
 * Use ensureChrome() for the full download-if-missing flow.
 */
function getChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  try {
    const { app } = require('electron');
    if (app.isPackaged) {
      const resourcesDir = path.join(process.resourcesPath, 'chromium');
      if (fs.existsSync(resourcesDir)) {
        const found = findChromeIn(resourcesDir);
        if (found) return found;
      }
    }
  } catch (_) {}

  const chromeDir = getChromeDir();
  if (fs.existsSync(chromeDir)) {
    const found = findChromeIn(chromeDir);
    if (found) return found;
  }

  return undefined;
}

module.exports = { getChromePath, ensureChrome };

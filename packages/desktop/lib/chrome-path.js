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
function findChromeIn(dir, maxDepth = 5, depth = 0) {
  if (depth > maxDepth) return undefined;
  if (!fs.existsSync(dir)) return undefined;
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
 * Find the system-installed Chrome/Chromium browser.
 */
function findSystemChrome() {
  const candidates = [];

  if (process.platform === 'win32') {
    const prefixes = [
      process.env.LOCALAPPDATA,
      process.env['PROGRAMFILES'],
      process.env['PROGRAMFILES(X86)'],
    ].filter(Boolean);
    for (const prefix of prefixes) {
      candidates.push(path.join(prefix, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    candidates.push(path.join(process.env.HOME || '', 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'));
  } else {
    // Linux: check common binary names via well-known paths
    const linuxPaths = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/snap/bin/chromium',
    ];
    candidates.push(...linuxPaths);
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Resolve Chrome executable path for Puppeteer.
 *
 * Priority:
 *   1. PUPPETEER_EXECUTABLE_PATH env var
 *   2. Bundled Chrome in app resources/chromium (packaged Electron)
 *   3. Dev mode .chromium cache
 *   4. Puppeteer's default cache (~/.cache/puppeteer)
 *   5. System-installed Chrome (Program Files, /Applications, /usr/bin)
 *   6. Auto-download via @puppeteer/browsers
 */
async function ensureChrome({ onProgress } = {}) {
  // 1. Env var override
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  // 2. Bundled Chrome in packaged app resources
  try {
    const { app } = require('electron');
    if (app.isPackaged) {
      const resourcesDir = path.join(process.resourcesPath, 'chromium');
      const found = findChromeIn(resourcesDir);
      if (found) {
        console.log('[chrome-path] Found bundled Chrome:', found);
        return found;
      }
    }
  } catch (_) {}

  // 3. Dev mode: .chromium dir next to lib/
  const devChromium = path.join(__dirname, '..', '.chromium');
  const devFound = findChromeIn(devChromium);
  if (devFound) {
    console.log('[chrome-path] Found dev Chrome:', devFound);
    return devFound;
  }

  // 4. Puppeteer's default cache locations
  const defaultCaches = [
    path.join(process.env.HOME || process.env.USERPROFILE || '', '.cache', 'puppeteer'),
    path.join(process.env.LOCALAPPDATA || '', 'puppeteer'),
  ];
  for (const cacheDir of defaultCaches) {
    if (cacheDir) {
      const found = findChromeIn(cacheDir);
      if (found) {
        console.log('[chrome-path] Found cached Chrome:', found);
        return found;
      }
    }
  }

  // 5. System-installed Chrome
  const systemChrome = findSystemChrome();
  if (systemChrome) {
    console.log('[chrome-path] Found system Chrome:', systemChrome);
    return systemChrome;
  }

  // 6. Auto-download Chrome on first use
  try {
    if (onProgress) onProgress('Downloading browser engine (first time only)...');
    console.log('[chrome-path] Chrome not found — downloading...');

    const { install, Browser, detectBrowserPlatform } = require('@puppeteer/browsers');

    const cacheDir = process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'), 'puppeteer')
      : path.join(process.env.HOME || '', '.cache', 'puppeteer');

    const result = await install({
      browser: Browser.CHROME,
      buildId: 'stable',
      cacheDir,
      platform: detectBrowserPlatform(),
    });

    console.log('[chrome-path] Chrome downloaded to:', result.executablePath);
    if (onProgress) onProgress('Browser engine ready.');
    return result.executablePath;
  } catch (err) {
    console.error('[chrome-path] Failed to download Chrome:', err.message);
  }

  // 7. Nothing worked — throw a clear error
  throw new Error(
    'Chrome not found. Please install Google Chrome from https://www.google.com/chrome/ and restart AutoLander.'
  );
}

/**
 * Synchronous version for backward compatibility.
 */
function getChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  try {
    const { app } = require('electron');
    if (app.isPackaged) {
      const resourcesDir = path.join(process.resourcesPath, 'chromium');
      const found = findChromeIn(resourcesDir);
      if (found) return found;
    }
  } catch (_) {}

  const devChromium = path.join(__dirname, '..', '.chromium');
  const devFound = findChromeIn(devChromium);
  if (devFound) return devFound;

  return findSystemChrome() || undefined;
}

module.exports = { getChromePath, ensureChrome };

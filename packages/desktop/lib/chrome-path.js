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
 * Resolve Chrome executable path for Puppeteer.
 * Async version that checks all locations.
 *
 * Priority:
 *   1. PUPPETEER_EXECUTABLE_PATH env var
 *   2. Bundled Chrome in app resources/chromium (packaged Electron)
 *   3. Puppeteer's .chromium cache in the project (dev mode)
 *   4. Puppeteer's default cache (~/.cache/puppeteer)
 *   5. Let Puppeteer resolve it (return undefined)
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

  // 5. Auto-download Chrome on first use
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

  // 6. Return undefined — nothing worked
  console.warn('[chrome-path] Chrome not found in any location');
  return undefined;
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
  return findChromeIn(devChromium) || undefined;
}

module.exports = { getChromePath, ensureChrome };

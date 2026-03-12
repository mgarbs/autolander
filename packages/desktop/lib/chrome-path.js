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

  // Check each candidate name at this level
  for (const name of exeNames) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }

  // Recurse into subdirectories
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
 * Resolve Chromium executable path for Puppeteer.
 * Priority:
 *   1. PUPPETEER_EXECUTABLE_PATH env var
 *   2. Bundled Chrome in app resources (packaged Electron)
 *   3. Puppeteer's own default (dev mode)
 */
function getChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  // In a packaged Electron app, Chrome is in resources/chromium/
  try {
    const { app } = require('electron');
    if (app.isPackaged) {
      const resourcesDir = path.join(process.resourcesPath, 'chromium');
      if (fs.existsSync(resourcesDir)) {
        const found = findChromeIn(resourcesDir);
        if (found) return found;
      }
    }
  } catch (_) {
    // Not in Electron context
  }

  // Dev mode: let puppeteer use its default cache
  return undefined;
}

module.exports = { getChromePath };

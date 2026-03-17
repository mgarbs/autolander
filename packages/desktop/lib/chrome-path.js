'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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
 * Ensure a Chrome binary is executable. On macOS, Puppeteer downloads
 * can lose +x permissions or get quarantined by Gatekeeper, causing
 * EACCES errors on launch.
 */
function ensureExecutable(chromePath) {
  if (process.platform === 'darwin') {
    // On macOS, Puppeteer Chrome lives inside a .app bundle like:
    //   ~/.cache/puppeteer/chrome/mac-xxx/chrome-mac-x64/
    //     Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing
    //
    // Gatekeeper quarantines the ENTIRE download tree and can strip +x
    // from any level. We need to:
    //   1. Remove quarantine from the whole chrome cache subtree
    //   2. chmod +x the binary AND all parent dirs in the .app bundle
    //
    // Find the .app bundle root (if any) and de-quarantine the whole thing
    const appBundleRoot = findAppBundle(chromePath);
    const quarantineTarget = appBundleRoot || path.dirname(chromePath);

    try {
      execSync(`xattr -dr com.apple.quarantine "${quarantineTarget}" 2>/dev/null`);
      console.log('[chrome-path] Removed quarantine from:', quarantineTarget);
    } catch (_) {}

    // chmod the binary and walk up through the .app making dirs executable
    try {
      fs.chmodSync(chromePath, 0o755);
      if (appBundleRoot) {
        // Make Contents/MacOS and any intermediate dirs traversable
        chmodParents(chromePath, appBundleRoot);
      }
      console.log('[chrome-path] Fixed permissions on:', chromePath);
    } catch (err) {
      console.warn('[chrome-path] Cannot chmod:', chromePath, err.message);
      // Don't return false — the binary might still be executable via
      // the quarantine removal above
    }
  }

  // Final check: can we actually execute it?
  try {
    fs.accessSync(chromePath, fs.constants.X_OK);
    return true;
  } catch (_) {
    // Last resort: try chmod one more time (might have been blocked by
    // quarantine on first attempt but not after xattr removal)
    try {
      fs.chmodSync(chromePath, 0o755);
      fs.accessSync(chromePath, fs.constants.X_OK);
      return true;
    } catch (_) {}
    console.warn('[chrome-path] Binary not executable after repair:', chromePath);
    return false;
  }
}

/**
 * Walk up from a file path to find the nearest .app bundle root.
 * Returns the .app directory path, or undefined if not inside a bundle.
 */
function findAppBundle(filePath) {
  let dir = path.dirname(filePath);
  while (dir && dir !== '/' && dir !== '.') {
    if (dir.endsWith('.app')) return dir;
    dir = path.dirname(dir);
  }
  return undefined;
}

/**
 * chmod +x all directories between innerPath and outerPath (inclusive).
 * Makes the directory tree traversable so the binary can be spawned.
 */
function chmodParents(innerPath, outerPath) {
  let dir = path.dirname(innerPath);
  while (dir && dir.length >= outerPath.length) {
    try { fs.chmodSync(dir, 0o755); } catch (_) {}
    if (dir === outerPath) break;
    dir = path.dirname(dir);
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
    // Must be a file, not a directory — ~/.cache/puppeteer/chrome is a
    // DIRECTORY that fs.existsSync matches against the exe name 'chrome',
    // causing Puppeteer to try to spawn a directory → EACCES.
    try {
      if (fs.statSync(candidate).isFile() && ensureExecutable(candidate)) return candidate;
    } catch (_) {}
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
      candidates.push(path.join(prefix, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      candidates.push(path.join(prefix, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'));
    }
  } else if (process.platform === 'darwin') {
    const macBrowsers = [
      'Google Chrome.app/Contents/MacOS/Google Chrome',
      'Chromium.app/Contents/MacOS/Chromium',
      'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
    const macPrefixes = ['/Applications', path.join(process.env.HOME || '', 'Applications')];
    for (const prefix of macPrefixes) {
      for (const browser of macBrowsers) {
        candidates.push(path.join(prefix, browser));
      }
    }
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
    const exists = fs.existsSync(candidate);
    console.log('[chrome-path] Checking:', candidate, exists ? 'FOUND' : 'missing');
    if (exists && ensureExecutable(candidate)) return candidate;
  }

  // Fallback: use OS-level search to find any Chromium-based browser
  try {
    if (process.platform === 'darwin') {
      // macOS Spotlight — finds Chrome no matter where it's installed
      const bundleIds = [
        'com.google.Chrome',
        'org.chromium.Chromium',
        'com.microsoft.edgemac',
        'com.brave.Browser',
      ];
      for (const bid of bundleIds) {
        try {
          const appPath = execSync(`mdfind "kMDItemCFBundleIdentifier == '${bid}'" 2>/dev/null`, { encoding: 'utf8' }).trim().split('\n')[0];
          if (appPath) {
            // Read CFBundleExecutable from the .app to get the real binary name
            try {
              const execName = execSync(`defaults read "${appPath}/Contents/Info" CFBundleExecutable 2>/dev/null`, { encoding: 'utf8' }).trim();
              const binary = path.join(appPath, 'Contents', 'MacOS', execName);
              if (fs.existsSync(binary)) {
                console.log('[chrome-path] Spotlight found:', binary);
                return binary;
              }
            } catch (_) {}
          }
        } catch (_) {}
      }
    } else if (process.platform === 'linux') {
      const cmds = ['which google-chrome', 'which google-chrome-stable', 'which chromium-browser', 'which chromium'];
      for (const cmd of cmds) {
        try {
          const result = execSync(cmd + ' 2>/dev/null', { encoding: 'utf8' }).trim();
          if (result && fs.existsSync(result)) {
            console.log('[chrome-path] which found:', result);
            return result;
          }
        } catch (_) {}
      }
    }
  } catch (_) {}

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
    console.log('[chrome-path] No system browser found — attempting download...');

    const browsers = require('@puppeteer/browsers');
    const { install, detectBrowserPlatform } = browsers;
    const Browser = browsers.Browser;
    const platform = detectBrowserPlatform();

    const cacheDir = process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'), 'puppeteer')
      : path.join(process.env.HOME || '', '.cache', 'puppeteer');

    console.log('[chrome-path] Download target: cacheDir=%s platform=%s', cacheDir, platform);

    // Try Chrome first, fall back to Chromium
    const attempts = [
      { browser: Browser.CHROME, buildId: 'stable' },
      { browser: Browser.CHROMIUM, buildId: 'latest' },
    ];

    for (const attempt of attempts) {
      try {
        console.log('[chrome-path] Trying %s/%s...', attempt.browser, attempt.buildId);
        const result = await install({
          browser: attempt.browser,
          buildId: attempt.buildId,
          cacheDir,
          platform,
        });
        console.log('[chrome-path] Downloaded to:', result.executablePath);
        ensureExecutable(result.executablePath);
        if (onProgress) onProgress('Browser engine ready.');
        return result.executablePath;
      } catch (dlErr) {
        console.error('[chrome-path] %s download failed:', attempt.browser, dlErr.message);
      }
    }
  } catch (err) {
    console.error('[chrome-path] Auto-download failed:', err.message, err.stack);
  }

  // 7. Nothing worked — throw a clear error
  throw new Error(
    'No compatible browser found. Please install Google Chrome, Microsoft Edge, or Brave from https://www.google.com/chrome/ and restart AutoLander.'
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

/**
 * Kill stale Chrome processes that are using the AutoLander profile directory.
 * This prevents "Failed to launch the browser process" errors caused by
 * zombie Chrome processes holding the profile lock from previous sessions.
 */
async function killStaleProfileChrome(profileDir) {
  // Check if SingletonLock exists — if not, nothing to clean up
  const singletonLock = path.join(profileDir, 'SingletonLock');
  if (!fs.existsSync(singletonLock)) return;

  try {
    const { execSync } = require('child_process');

    if (process.platform === 'win32') {
      // Windows: kill stale Chrome processes using wmic, then clean up locks
      const output = execSync(
        'wmic process where "name=\'chrome.exe\'" get CommandLine,ProcessId /format:csv 2>nul',
        { encoding: 'utf8', timeout: 10000 }
      );
      const normalizedProfile = profileDir.replace(/\//g, '\\').toLowerCase();
      for (const line of output.split('\n')) {
        if (!line.toLowerCase().includes(normalizedProfile)) continue;
        const match = line.match(/(\d+)\s*$/);
        if (match) {
          const pid = match[1];
          try {
            process.kill(Number(pid));
            console.log('[chrome-path] Killed stale Chrome PID', pid);
          } catch (_) {}
        }
      }
      // Remove lockfile and SingletonLock after killing processes
      const lockfile = path.join(profileDir, 'lockfile');
      if (fs.existsSync(lockfile)) {
        try { fs.unlinkSync(lockfile); } catch (_) {}
      }
      if (fs.existsSync(singletonLock)) {
        try { fs.unlinkSync(singletonLock); } catch (_) {}
      }
    } else {
      // macOS / Linux: check if any Chrome process is actively using this profile
      try {
        const output = execSync(
          `ps aux | grep -i chrome | grep "${profileDir}" | grep -v grep`,
          { encoding: 'utf8', timeout: 10000 }
        );
        // If we get output, Chrome is still actively using this profile — leave it alone
        if (output.trim().length > 0) {
          console.log('[chrome-path] Chrome is still using profile, leaving SingletonLock:', profileDir);
          return;
        }
      } catch (_) {
        // grep returns exit code 1 when no matches — means no Chrome process found
      }
      // No Chrome process is using this profile — safe to remove stale lock
      try {
        fs.unlinkSync(singletonLock);
        console.log('[chrome-path] Removed stale SingletonLock:', singletonLock);
      } catch (_) {}
    }
  } catch (err) {
    console.warn('[chrome-path] killStaleProfileChrome:', err.message);
  }
}

module.exports = { getChromePath, ensureChrome, killStaleProfileChrome, findChromeIn };

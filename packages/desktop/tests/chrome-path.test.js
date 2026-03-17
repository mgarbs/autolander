'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { findChromeIn, killStaleProfileChrome } = require('../lib/chrome-path');
const { chromeProfileDir } = require('../lib/paths');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-path-test-'));
}

afterEach(() => {
  // cleanup is best-effort; tests use unique tmp dirs
});

describe('findChromeIn', () => {
  test('does NOT match a directory named "chrome"', () => {
    const tmp = makeTempDir();
    // Create a subdirectory named 'chrome' (not a file)
    fs.mkdirSync(path.join(tmp, 'chrome'));
    const result = findChromeIn(tmp);
    expect(result).toBeUndefined();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('DOES match an executable file named "chrome"', () => {
    if (process.platform === 'win32') return; // exe names differ on Windows
    const tmp = makeTempDir();
    const chromeBin = path.join(tmp, 'chrome');
    fs.writeFileSync(chromeBin, '#!/bin/sh\necho hi\n');
    fs.chmodSync(chromeBin, 0o755);
    const result = findChromeIn(tmp);
    expect(result).toBe(chromeBin);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('killStaleProfileChrome', () => {
  test('removes a stale SingletonLock file when no Chrome process is using the profile', async () => {
    if (process.platform === 'win32') return; // wmic tests would need a different approach
    const tmp = makeTempDir();
    const lockFile = path.join(tmp, 'SingletonLock');
    fs.writeFileSync(lockFile, '');
    expect(fs.existsSync(lockFile)).toBe(true);

    await killStaleProfileChrome(tmp);

    expect(fs.existsSync(lockFile)).toBe(false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('chromeProfileDir', () => {
  test('returns unique dirs per purpose (auth vs inbox vs poster)', () => {
    const authDir = chromeProfileDir('auth', 'testuser');
    const inboxDir = chromeProfileDir('inbox', 'testuser');
    const posterDir = chromeProfileDir('poster', 'testuser');

    expect(authDir).not.toBe(inboxDir);
    expect(authDir).not.toBe(posterDir);
    expect(inboxDir).not.toBe(posterDir);
  });

  test('isolates different users', () => {
    const user1 = chromeProfileDir('auth', 'user1');
    const user2 = chromeProfileDir('auth', 'user2');

    expect(user1).not.toBe(user2);
    expect(user1).toContain('user1');
    expect(user2).toContain('user2');
  });
});

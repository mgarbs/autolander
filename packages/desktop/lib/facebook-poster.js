/**
 * Facebook Marketplace Auto-Poster
 *
 * Automates posting vehicle listings to Facebook Marketplace using Puppeteer.
 * Includes session management, human-like behavior, and anti-detection measures.
 *
 * Puppeteer 22+ compatible — no $x() XPath calls.
 *
 * FB Marketplace vehicle form layout (as of Feb 2026, en_GB locale):
 *   DROPDOWNS (label[role="combobox"], NO aria-label, identified by textContent):
 *     Vehicle type: Car/van, Motorcycle, Power sport, Motorhome/caravan, Trailer, Boat, Commercial/Industrial, Other
 *     Year:         2027..1901
 *     Make:         Acura, Alfa Romeo, ..., Toyota, Volkswagen, Volvo (66 options)
 *     Body style:   Coupé, Van, Saloon, Hatchback, 4x4, Convertible, Estate, MPV/People carrier, Small car, Other
 *     Exterior colour: Black, Blue, Brown, Gold, Green, Grey, Pink, Purple, Red, Silver, Orange, White, Yellow, Charcoal, Off white, Tan, Beige, Burgundy, Turquoise
 *     Interior colour: (same as exterior)
 *     Vehicle condition: Excellent, Very good, Good, Fair, Poor
 *     Fuel type:    Diesel, Electric, Petrol, Flex, Hybrid, Plug-in hybrid, Other
 *     Transmission: Manual transmission, Automatic transmission
 *   TEXT INPUTS (input[type="text"], NO aria-label, identified by nearby <span>):
 *     Model, Mileage, Price
 *   TEXTAREA:   Description (no aria-label)
 *   CHECKBOX:   Clean title (aria-label: "This vehicle has a clean title.")
 *   FILE INPUTS: image (accept="image/*,..."), video (accept="video/*")
 *   FLOW:       Progressive form (fields appear after Year→Make selected)
 *               → Fill form → click "Next" → click "Publish"
 *   PHOTOS:     Required (1–20), uploaded via hidden file input
 *   OVERLAYS:   After photo upload, FB shows notification + photo tips dialogs — must dismiss
 *
 * ALL dropdowns are REQUIRED by FB. Defaults when user doesn't specify:
 *   Body style → Saloon, Ext/Int colour → Black, Condition → Good,
 *   Fuel type → Petrol, Transmission → Automatic transmission
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { encryptCookies, decryptCookies } = require('./fb-crypto');
const {
  DATA_DIR,
  SESSIONS_DIR,
  SCREENSHOTS_DIR,
  LOGS_DIR,
  TEMP_DIR,
  ensureDirs
} = require('./paths');
const { SharedBrowser } = require('./shared-browser');

const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
const LOG_DIR = LOGS_DIR;

// Ensure directories exist
ensureDirs();
fs.mkdirSync(PHOTOS_DIR, { recursive: true });

// --- File logger ---
const LOG_FILE = path.join(LOG_DIR, 'fb-poster.log');
let _logStream = null;

function getLogStream() {
  if (!_logStream) {
    _logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  }
  return _logStream;
}

function log(sessionId, level, ...args) {
  const ts = new Date().toISOString();
  const prefix = sessionId ? `[${ts}] [${sessionId}]` : `[${ts}]`;
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  const line = `${prefix} [${level}] ${msg}`;
  console.log(line);
  try { getLogStream().write(line + '\n'); } catch (_) { /* ignore */ }
}

function logInfo(sessionId, ...args)  { log(sessionId, 'INFO', ...args); }
function logWarn(sessionId, ...args)  { log(sessionId, 'WARN', ...args); }
function logError(sessionId, ...args) { log(sessionId, 'ERROR', ...args); }

/**
 * Random delay to mimic human behavior
 * @param {number} min - Minimum ms
 * @param {number} max - Maximum ms
 */
async function humanDelay(min = 1000, max = 3000) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  await new Promise(resolve => setTimeout(resolve, delay));
}

function normalizeUiText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Type text with human-like delays between keystrokes
 * @param {object} page - Puppeteer page
 * @param {string} selector - Input selector
 * @param {string} text - Text to type
 */
async function humanType(page, selector, text) {
  await page.click(selector);
  await humanDelay(200, 500);

  for (const char of text) {
    await page.type(selector, char, { delay: Math.random() * 100 + 50 });
  }
}

/**
 * Move mouse in a human-like way before clicking
 * @param {object} page - Puppeteer page
 * @param {string} selector - Element selector
 */
async function humanClick(page, selector) {
  const element = await page.$(selector);
  if (!element) {
    throw new Error(`Element not found: ${selector}`);
  }

  const box = await element.boundingBox();
  if (!box) {
    throw new Error(`Element not visible: ${selector}`);
  }

  // Move to element with some randomness
  const x = box.x + box.width / 2 + (Math.random() * 10 - 5);
  const y = box.y + box.height / 2 + (Math.random() * 10 - 5);

  await page.mouse.move(x, y, { steps: Math.floor(Math.random() * 10) + 5 });
  await humanDelay(100, 300);
  await page.mouse.click(x, y);
}

/**
 * Facebook Poster class
 */
class FacebookPoster {
  constructor(options = {}) {
    this.sid = `fb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.salespersonId = options.salespersonId;
    this.browser = null;
    this.page = null;
    this.isLoggedIn = false;
    this.sessionFile = path.join(SESSIONS_DIR, `${this.salespersonId || 'default'}_fb_session.json`);
    this.apiUrl = '';
    this.authToken = '';
    this.setCloudCredentials(options.apiUrl, options.authToken);

    // Rate limiting
    this.postsToday = 0;
    this.maxPostsPerDay = options.maxPostsPerDay || 5;
    this.lastPostTime = null;
    this.minPostInterval = options.minPostInterval || 2 * 60 * 60 * 1000; // 2 hours

    logInfo(this.sid, `Constructor: headless=${this.headless} slowMo=${this.slowMo} salesperson=${this.salespersonId || 'default'}`);
  }

  log(...args)  { logInfo(this.sid, ...args); }
  warn(...args) { logWarn(this.sid, ...args); }
  err(...args)  { logError(this.sid, ...args); }

  setCloudCredentials(apiUrl, authToken) {
    this.apiUrl = typeof apiUrl === 'string' ? apiUrl.trim().replace(/\/+$/, '') : '';
    this.authToken = typeof authToken === 'string' ? authToken.trim() : '';
  }

  async _cloudPost(routePath, body) {
    if (!this.apiUrl || !this.authToken) {
      return null;
    }

    let url;
    try {
      url = new URL(routePath, this.apiUrl);
    } catch (error) {
      this.log(` Invalid cloud API URL "${this.apiUrl}": ${error.message}`);
      return null;
    }

    const payload = JSON.stringify(body || {});
    const transport = url.protocol === 'http:' ? http : https;

    return new Promise((resolve) => {
      const req = transport.request(url, {
        method: 'POST',
        timeout: 10000,
        headers: {
          Authorization: `Bearer ${this.authToken}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            this.log(` Cloud POST ${url.pathname} failed with HTTP ${res.statusCode}`);
            return resolve(null);
          }

          try {
            resolve(data ? JSON.parse(data) : null);
          } catch (error) {
            this.log(` Cloud POST ${url.pathname} returned invalid JSON: ${error.message}`);
            resolve(null);
          }
        });
      });

      req.on('error', (error) => {
        this.log(` Cloud POST ${url.pathname} failed: ${error.message}`);
        resolve(null);
      });
      req.on('timeout', () => {
        req.destroy(new Error('Request timed out'));
      });

      req.write(payload);
      req.end();
    });
  }

  /**
   * Initialize browser via SharedBrowser.
   * Acquires the shared Chrome instance and opens a poster tab.
   */
  async init() {
    if (SharedBrowser.isAuthActive(this.salespersonId || 'default')) {
      throw new Error('Login in progress — please wait for auth to complete');
    }

    this.log('Initializing browser via SharedBrowser...');

    const spId = this.salespersonId || 'default';
    const slot = await SharedBrowser.acquire(spId);
    this.browser = slot.browser;

    this.page = await SharedBrowser.getPage(spId, 'poster');

    // Log page JS errors
    this.page.on('pageerror', (error) => {
      this.err(`Page JS error: ${error.message}`);
    });

    // Load saved cookies as fallback for fresh profiles
    await this.loadSession();

    this.log('Browser initialized and ready (shared)');
    return this;
  }

  /**
   * Save session cookies
   */
  async saveSession() {
    if (!this.page) return;

    const cookies = await this.page.cookies();
    const encrypted = encryptCookies(cookies);
    const sessionData = {
      ...encrypted,
      savedAt: new Date().toISOString(),
      validatedAt: new Date().toISOString(),
      salespersonId: this.salespersonId,
    };

    fs.writeFileSync(this.sessionFile, JSON.stringify(sessionData, null, 2));
    this.log('Session saved');
  }

  /**
   * Load session cookies
   */
  async loadSession() {
    if (!fs.existsSync(this.sessionFile)) {
      this.log('No saved session found');
      return false;
    }

    try {
      const sessionData = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));

      // Check if session is recent (less than 7 days old)
      const savedAt = new Date(sessionData.savedAt);
      const daysSince = (Date.now() - savedAt.getTime()) / (1000 * 60 * 60 * 24);

      if (daysSince > 7) {
        this.log('Session expired, need fresh login');
        return false;
      }

      const cookies = decryptCookies(sessionData);
      await this.page.setCookie(...cookies);
      this.log('Session loaded');
      return true;
    } catch (e) {
      this.log('Failed to load session:', e.message);
      return false;
    }
  }

  /**
   * Run a function while holding the navigation mutex.
   * Ensures only one module navigates the shared browser at a time.
   */
  async _withMutex(fn, maxHoldMs) {
    const spId = this.salespersonId || 'default';
    const unlock = await SharedBrowser.lockNavigation(spId, 'poster', maxHoldMs);
    try {
      return await fn();
    } finally {
      unlock();
    }
  }

  /**
   * Check if currently logged in
   */
  async checkLoginStatus() {
    return this._withMutex(async () => {
      try {
        await this.page.goto('https://www.facebook.com', { waitUntil: 'networkidle2' });
        await humanDelay(2000, 4000);

        // Check for login form vs user menu
        const loginForm = await this.page.$('input[name="email"]');
        const userMenu = await this.page.$('[aria-label="Your profile"]');

        this.isLoggedIn = !loginForm && !!userMenu;
        this.log(` Login status: ${this.isLoggedIn ? 'logged in' : 'not logged in'}`);

        return this.isLoggedIn;
      } catch (e) {
        this.err('Error checking login status:', e.message);
        return false;
      }
    });
  }

  /**
   * Login to Facebook
   * @param {string} email - Facebook email
   * @param {string} password - Facebook password
   */
  async login(email, password) {
    this.log('Attempting login...');

    await this.page.goto('https://www.facebook.com/login', { waitUntil: 'networkidle2' });
    await humanDelay(2000, 4000);

    // Enter email
    await humanType(this.page, '#email', email);
    await humanDelay(500, 1000);

    // Enter password
    await humanType(this.page, '#pass', password);
    await humanDelay(500, 1000);

    // Click login button
    await humanClick(this.page, 'button[name="login"]');

    // Wait for navigation or 2FA prompt
    await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => { });
    await humanDelay(3000, 5000);

    // Check for 2FA
    const twoFactorInput = await this.page.$('input[name="approvals_code"]');
    if (twoFactorInput) {
      this.log('2FA required - waiting for manual entry...');
      await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 120000 }).catch(() => { });
    }

    // Verify login succeeded
    this.isLoggedIn = await this.checkLoginStatus();

    if (this.isLoggedIn) {
      await this.saveSession();
      this.log('Login successful');
    } else {
      this.err('Login failed');
    }

    return this.isLoggedIn;
  }

  /**
   * Find a clickable element by its visible text content.
   * Puppeteer 22+ compatible — uses evaluateHandle instead of $x().
   * @param {string} text - Text to search for (case-insensitive partial match)
   * @param {string} tag - Optional CSS tag filter (e.g., 'span', 'div')
   * @returns {ElementHandle|null}
   */
  async findByText(text, tag = '*') {
    const el = await this.page.evaluateHandle((searchText, tagFilter) => {
      const lower = searchText.toLowerCase();
      const elements = document.querySelectorAll(tagFilter);
      for (const el of elements) {
        const content = el.textContent?.trim().toLowerCase() || '';
        if (content.includes(lower) && el.offsetParent !== null) {
          return el;
        }
      }
      return null;
    }, text, tag);
    return el && el.asElement() ? el.asElement() : null;
  }

  /**
   * Find an input/textarea near a label with the given text.
   * Uses multiple strategies for resilience against DOM changes.
   *
   * FB Marketplace (2026) DOM structure:
   *   Dropdowns  → <label role="combobox"> with textContent "Year", "Make" etc (NO aria-label)
   *   Text inputs → <input type="text"> with NO aria-label, NO placeholder, identified
   *                 by nearby <span> ancestors containing "Model", "Price", "Mileage"
   *   Textarea    → <textarea> near <span> "Description"
   *
   * @param {string} labelText - Label text to search for
   * @returns {ElementHandle|null}
   */
  async findFieldByLabel(labelText) {
    // Strategy 1: exact aria-label
    let el = await this.page.$(`[aria-label="${labelText}"]`);
    if (el) {
      this.log(`   Found "${labelText}" via aria-label`);
      return el;
    }

    // Strategy 2: <label role="combobox"> whose textContent starts with the label
    // FB uses <label role="combobox"> for dropdowns — the text is the label text (e.g. "Year", "MakeToyota")
    el = await this.page.evaluateHandle((text) => {
      const labels = document.querySelectorAll('label[role="combobox"]');
      const lower = text.toLowerCase();
      for (const label of labels) {
        if (label.offsetParent === null) continue;
        const content = label.textContent?.trim().toLowerCase() || '';
        // Match if textContent starts with label OR equals it (before any selected value)
        if (content === lower || content.startsWith(lower)) return label;
      }
      return null;
    }, labelText);
    if (el && el.asElement()) {
      this.log(`   Found "${labelText}" via label[role=combobox] textContent`);
      return el.asElement();
    }

    // Strategy 3: aria-label case-insensitive partial match
    el = await this.page.evaluateHandle((text) => {
      const all = document.querySelectorAll('input, textarea, select, [role="combobox"], [role="textbox"], [contenteditable="true"]');
      for (const el of all) {
        const label = el.getAttribute('aria-label') || '';
        if (label.toLowerCase().includes(text.toLowerCase())) return el;
      }
      return null;
    }, labelText);
    if (el && el.asElement()) {
      this.log(`   Found "${labelText}" via aria-label partial match`);
      return el.asElement();
    }

    // Strategy 4: Find by placeholder text
    el = await this.page.evaluateHandle((text) => {
      const all = document.querySelectorAll('input, textarea');
      for (const el of all) {
        const ph = el.getAttribute('placeholder') || '';
        if (ph.toLowerCase().includes(text.toLowerCase())) return el;
      }
      return null;
    }, labelText);
    if (el && el.asElement()) {
      this.log(`   Found "${labelText}" via placeholder`);
      return el.asElement();
    }

    // Strategy 5: Find nearby <span> text, walk up to find the input/textarea
    // FB puts label text in <span> siblings near the input
    el = await this.page.evaluateHandle((text) => {
      const lower = text.toLowerCase();
      const spans = document.querySelectorAll('span');
      for (const span of spans) {
        const t = span.textContent?.trim().toLowerCase();
        if (t !== lower) continue;
        if (span.offsetParent === null) continue;
        // Walk up from span to find a sibling input/textarea
        let parent = span.parentElement;
        for (let i = 0; i < 6; i++) {
          if (!parent) break;
          const input = parent.querySelector('input[type="text"], textarea');
          if (input && input.offsetParent !== null) {
            // Verify this input doesn't already have a known role (like Search)
            const ariaLabel = input.getAttribute('aria-label') || '';
            if (!ariaLabel.includes('Search') && !ariaLabel.includes('Location')) {
              return input;
            }
          }
          parent = parent.parentElement;
        }
      }
      return null;
    }, labelText);
    if (el && el.asElement()) {
      this.log(`   Found "${labelText}" via span-context walk`);
      return el.asElement();
    }

    // Strategy 6: TreeWalker fallback (original approach)
    el = await this.page.evaluateHandle((text) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (walker.currentNode.textContent.trim().toLowerCase().includes(text.toLowerCase())) {
          let parent = walker.currentNode.parentElement;
          for (let i = 0; i < 6; i++) {
            if (!parent) break;
            const input = parent.querySelector('input, textarea, [role="combobox"], [role="textbox"], [contenteditable="true"]');
            if (input) return input;
            parent = parent.parentElement;
          }
        }
      }
      return null;
    }, labelText);
    if (el && el.asElement()) {
      this.log(`   Found "${labelText}" via text-walk`);
      return el.asElement();
    }

    this.log(`   WARNING: Could not find field "${labelText}"`);
    return null;
  }

  /**
   * Determine the FB Marketplace vehicle type from user-provided vehicle data.
   *
   * FB vehicle types: Car/van, Motorcycle, Power sport, Motorhome/caravan,
   *                   Trailer, Boat, Commercial/Industrial, Other
   *
   * @param {object} vehicle - Vehicle object
   * @returns {string} FB vehicle type to select
   */
  resolveVehicleType(vehicle) {
    const typeMap = {
      // Car/van
      'car': 'Car/van', 'car/van': 'Car/van', 'van': 'Car/van',
      'sedan': 'Car/van', 'suv': 'Car/van', 'truck': 'Car/van',
      'pickup': 'Car/van', 'coupe': 'Car/van', 'wagon': 'Car/van',
      'hatchback': 'Car/van', 'convertible': 'Car/van', 'minivan': 'Car/van',
      'crossover': 'Car/van', 'estate': 'Car/van', 'saloon': 'Car/van',
      'pickup truck': 'Car/van', '4x4': 'Car/van',
      // Motorcycle
      'motorcycle': 'Motorcycle', 'bike': 'Motorcycle', 'motorbike': 'Motorcycle',
      // Power sport
      'power sport': 'Power sport', 'powersport': 'Power sport',
      'atv': 'Power sport', 'utv': 'Power sport', 'quad': 'Power sport',
      'snowmobile': 'Power sport', 'jet ski': 'Power sport',
      'side-by-side': 'Power sport', 'go-kart': 'Power sport',
      'dirtbike': 'Power sport', 'dirt bike': 'Power sport',
      'scooter': 'Power sport',
      // Motorhome/caravan
      'motorhome': 'Motorhome/caravan', 'caravan': 'Motorhome/caravan',
      'motorhome/caravan': 'Motorhome/caravan', 'rv': 'Motorhome/caravan',
      'camper': 'Motorhome/caravan', 'campervan': 'Motorhome/caravan',
      // Trailer
      'trailer': 'Trailer', 'flatbed': 'Trailer', 'utility trailer': 'Trailer',
      'cargo trailer': 'Trailer', 'horse trailer': 'Trailer',
      // Boat
      'boat': 'Boat', 'yacht': 'Boat', 'pontoon': 'Boat', 'sailboat': 'Boat',
      'kayak': 'Boat', 'canoe': 'Boat', 'jet boat': 'Boat',
      // Commercial/Industrial
      'commercial': 'Commercial/Industrial', 'industrial': 'Commercial/Industrial',
      'commercial/industrial': 'Commercial/Industrial',
      'box truck': 'Commercial/Industrial', 'dump truck': 'Commercial/Industrial',
      'semi': 'Commercial/Industrial', 'tractor': 'Commercial/Industrial',
      // Other
      'other': 'Other'
    };

    // 1. Check explicit vehicle_type first (may not exist in DB but support it anyway)
    const vt = (vehicle.vehicle_type || vehicle.vehicleType || '').toLowerCase().trim();
    if (vt && typeMap[vt]) return typeMap[vt];

    // 2. Check bodyStyle (the field that actually exists in the DB - camelCase)
    const bs = (vehicle.bodyStyle || vehicle.body_style || '').toLowerCase().trim();
    if (bs && typeMap[bs]) return typeMap[bs];

    // 3. Default: Car/van (most common for dealerships)
    return 'Car/van';
  }

  /**
   * Match a vehicle color string to the closest Facebook Marketplace dropdown option
   * using the cloud AI API.
   *
   * FB colour options: Black, Blue, Brown, Gold, Green, Grey, Pink, Purple, Red,
   *   Silver, Orange, White, Yellow, Charcoal, Off white, Tan, Beige, Burgundy, Turquoise
   *
   * @param {string} colorInput - The vehicle's color (e.g., "Oxford White", "Midnight Blue Metallic")
   * @returns {string} The closest FB dropdown color value
   */
  async matchColorToFB(colorInput) {
    if (!colorInput) return 'Black';

    const fbColors = [
      'Black', 'Blue', 'Brown', 'Gold', 'Green', 'Grey', 'Pink', 'Purple',
      'Red', 'Silver', 'Orange', 'White', 'Yellow', 'Charcoal', 'Off white',
      'Tan', 'Beige', 'Burgundy', 'Turquoise'
    ];

    // Check for exact match first (case-insensitive)
    const exact = fbColors.find(c => c.toLowerCase() === colorInput.toLowerCase().trim());
    if (exact) return exact;

    // Fast local heuristic mapping (works without the cloud API)
    const normalized = normalizeUiText(colorInput);
    const colorKeywords = [
      { key: 'off white', value: 'Off white' },
      { key: 'charcoal', value: 'Charcoal' },
      { key: 'burgundy', value: 'Burgundy' },
      { key: 'turquoise', value: 'Turquoise' },
      { key: 'beige', value: 'Beige' },
      { key: 'tan', value: 'Tan' },
      { key: 'silver', value: 'Silver' },
      { key: 'gray', value: 'Grey' },
      { key: 'grey', value: 'Grey' },
      { key: 'white', value: 'White' },
      { key: 'black', value: 'Black' },
      { key: 'blue', value: 'Blue' },
      { key: 'red', value: 'Red' },
      { key: 'green', value: 'Green' },
      { key: 'yellow', value: 'Yellow' },
      { key: 'orange', value: 'Orange' },
      { key: 'gold', value: 'Gold' },
      { key: 'brown', value: 'Brown' },
      { key: 'purple', value: 'Purple' },
      { key: 'pink', value: 'Pink' },
    ];
    const heuristic = colorKeywords.find(c => normalized.includes(c.key));
    if (heuristic) {
      this.log(` Color heuristic match: "${colorInput}" -> "${heuristic.value}"`);
      return heuristic.value;
    }

    const response = await this._cloudPost('/api/ai/match-color', {
      color: colorInput,
      options: fbColors,
    });
    const match = typeof response?.match === 'string' ? response.match.trim() : '';
    const validated = fbColors.find(c => c.toLowerCase() === match.toLowerCase());
    if (validated) {
      this.log(` Color matched: "${colorInput}" -> "${validated}"`);
      return validated;
    }

    this.log(` Cloud color match unavailable for "${colorInput}", defaulting to Black`);
    return 'Black';

  }

  /**
   * Navigate to Facebook Marketplace create listing page and select the appropriate vehicle type.
   * @param {object} vehicle - Vehicle object (used to determine vehicle type)
   */
  async goToCreateListing(vehicle = {}) {
    return this._withMutex(async () => {
    this.log('Navigating to Marketplace...');

    await this.page.goto('https://www.facebook.com/marketplace/create/vehicle', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    await humanDelay(2000, 4000);
    await this.takeScreenshot('debug_01_page_loaded');

    // Determine the right vehicle type
    const targetType = this.resolveVehicleType(vehicle);
    this.log(` Selecting vehicle type: ${targetType}...`);

    // Select vehicle type with robust option finding
    const vehicleTypeDropdown = await this.findFieldByLabel('Vehicle type');
    if (vehicleTypeDropdown) {
      // Click to open the dropdown
      await vehicleTypeDropdown.click();
      await humanDelay(2000, 3000);

      // Try multiple strategies to find and click the option
      const selected = await this.page.evaluate((target) => {
        const lower = target.toLowerCase();

        // Strategy 1: role="option" (standard)
        const optionSelectors = [
          '[role="option"]',
          '[role="menuitemradio"]',
          '[role="menuitem"]',
          '[role="listbox"] [role="option"]',
          '[role="menu"] [role="menuitemradio"]',
          '[role="menu"] [role="menuitem"]'
        ];

        for (const sel of optionSelectors) {
          for (const o of document.querySelectorAll(sel)) {
            const text = (o.textContent || '').trim();
            if (text.toLowerCase() === lower) {
              o.scrollIntoView({ block: 'center' });
              o.click();
              return text;
            }
          }
        }

        // Strategy 2: partial match on any of those selectors
        for (const sel of optionSelectors) {
          for (const o of document.querySelectorAll(sel)) {
            const text = (o.textContent || '').trim();
            if (text.toLowerCase().includes(lower) || lower.includes(text.toLowerCase())) {
              o.scrollIntoView({ block: 'center' });
              o.click();
              return text;
            }
          }
        }

        // Strategy 3: Find any visible element in a popup/overlay/listbox whose text matches
        // FB often renders dropdown popups as floating divs at the end of the body
        const popupContainers = document.querySelectorAll('[role="listbox"], [role="menu"], [role="dialog"], [data-visualcompletion="ignore-dynamic"]');
        for (const container of popupContainers) {
          if (container.offsetParent === null) continue;
          const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const nodeText = walker.currentNode.textContent.trim();
            if (nodeText.toLowerCase() === lower) {
              // Click the closest clickable parent
              let el = walker.currentNode.parentElement;
              for (let i = 0; i < 5; i++) {
                if (!el) break;
                if (el.getAttribute('role') || el.tagName === 'A' || el.onclick || el.style?.cursor === 'pointer') {
                  el.scrollIntoView({ block: 'center' });
                  el.click();
                  return nodeText;
                }
                el = el.parentElement;
              }
              // Just click the direct parent span/div
              walker.currentNode.parentElement.click();
              return nodeText;
            }
          }
        }

        return null;
      }, targetType);

      if (selected) {
        this._selectedVehicleType = selected;
        this.log(` Selected vehicle type: "${selected}"`);
      } else {
        // Strategy 4: Try keyboard navigation - type the first few chars to filter
        this.log(` Option "${targetType}" not found via click, trying keyboard...`);
        // Type enough chars to distinguish "Car/van" from "Caravan"/"Camper"
        await this.page.keyboard.type(targetType.substring(0, 5), { delay: 100 });
        await humanDelay(1000, 1500);
        await this.page.keyboard.press('Enter');
        await humanDelay(1000, 1500);

        // Check if it worked by looking at the dropdown text
        const currentText = await this.page.evaluate(() => {
          const vt = [...document.querySelectorAll('label[role="combobox"]')]
            .find(l => l.textContent.trim().toLowerCase().includes('vehicle type') || l.textContent.trim().toLowerCase().startsWith('vehicle type'));
          return vt ? vt.textContent.trim() : '';
        });

        if (currentText && currentText.toLowerCase() !== 'vehicle type') {
          this._selectedVehicleType = currentText.replace(/vehicle type/i, '').trim() || 'Car/van';
          this.log(` Selected vehicle type via keyboard: "${this._selectedVehicleType}"`);
        } else {
          this.log(' WARNING: Could not select vehicle type, defaulting to Car/van');
          this._selectedVehicleType = 'Car/van';
        }
      }

      await humanDelay(2000, 3000);

      // Verify selection worked: check if additional form fields appeared
      const fieldCount = await this.page.evaluate(() => {
        return [...document.querySelectorAll('label[role="combobox"]')].filter(l => l.offsetParent !== null).length;
      });
      this.log(` Form fields after vehicle type selection: ${fieldCount}`);

      if (fieldCount <= 2) {
        this.log(' WARNING: Vehicle type may not have been selected (only 2 fields visible). Retrying with Car/van...');
        // Retry: click dropdown again and explicitly find "Car/van"
        await vehicleTypeDropdown.click();
        await humanDelay(2000, 3000);
        await this.page.evaluate(() => {
          const selectors = ['[role="option"]', '[role="menuitemradio"]', '[role="menuitem"]'];
          for (const sel of selectors) {
            for (const o of document.querySelectorAll(sel)) {
              const text = (o.textContent || '').trim().toLowerCase();
              if (text === 'car/van' || text === 'car / van' || text.startsWith('car')) {
                o.scrollIntoView({ block: 'center' });
                o.click();
                return;
              }
            }
          }
          // Last resort: click the first option
          for (const sel of selectors) {
            const first = document.querySelector(sel);
            if (first) { first.click(); return; }
          }
        });
        this._selectedVehicleType = 'Car/van';
        await humanDelay(2000, 3000);
      }
    } else {
      this._selectedVehicleType = 'Car/van';
      this.log('Vehicle type dropdown not found (may already be set)');
    }

    await this.takeScreenshot('debug_02_vehicle_type_selected');

    // Scroll down to reveal the form fields
    await this.page.evaluate(() => window.scrollBy(0, 400));
    await humanDelay(1000, 2000);

    this.log('On create listing page');
    return true;
    });
  }

  async goToEditListing(listingUrl) {
    this.log('Navigating to edit listing...');
    // Facebook edit URL pattern: append /edit to the listing URL
    // e.g., https://www.facebook.com/marketplace/item/123 -> .../item/123/edit
    const editUrl = listingUrl.replace(/\/?$/, '') + '/edit';
    await this.page.goto(editUrl, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });
    await humanDelay(2000, 4000);
    await this.takeScreenshot('debug_edit_listing_loaded');
    this.log('Edit listing page loaded');
  }

  async markListingAsSold(listingUrl) {
    return this._withMutex(async () => {
    this.log('Navigating to listing to mark as sold...');
    await this.page.goto(listingUrl, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });
    await humanDelay(2000, 4000);

    // Look for "Mark as Sold" or "Mark as sold" button/link
    const sold = await this.page.evaluate(() => {
      const selectors = ['[aria-label*="sold" i]', '[aria-label*="Sold" i]'];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) { el.click(); return true; }
      }
      // Fallback: find by text content
      const allButtons = [...document.querySelectorAll('[role="button"], button')];
      for (const btn of allButtons) {
        if ((btn.textContent || '').toLowerCase().includes('mark as sold')) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (sold) {
      await humanDelay(2000, 3000);
      // Confirm the "sold" dialog if one appears
      await this.page.evaluate(() => {
        const confirmBtns = [...document.querySelectorAll('[role="button"], button')];
        for (const btn of confirmBtns) {
          const text = (btn.textContent || '').toLowerCase().trim();
          if (text === 'confirm' || text === 'mark as sold' || text === 'yes') {
            btn.click();
            return true;
          }
        }
        return false;
      });
      await humanDelay(1000, 2000);
      this.log('Marked listing as sold');
    } else {
      this.log('Could not find "Mark as Sold" button');
    }

    return { success: sold, listingUrl };
    });
  }

  async renewListing(listingUrl) {
    return this._withMutex(async () => {
    this.log('Navigating to listing to renew...');
    await this.page.goto(listingUrl, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });
    await humanDelay(2000, 4000);

    // Look for "Renew" or "Relist" button
    const renewed = await this.page.evaluate(() => {
      const allButtons = [...document.querySelectorAll('[role="button"], button')];
      for (const btn of allButtons) {
        const text = (btn.textContent || '').toLowerCase().trim();
        if (text === 'renew' || text === 'renew listing' || text === 'relist') {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (renewed) {
      await humanDelay(2000, 3000);
      this.log('Renewed listing');
    } else {
      this.log('Could not find "Renew" button');
    }

    return { success: renewed, listingUrl };
    });
  }

  /**
   * Post a vehicle listing to Facebook Marketplace
   * @param {object} vehicle - Vehicle with generated_content
   * @returns {object} Result with success status and post URL
   */
  async postVehicle(vehicle) {
    return this._withMutex(async () => {
    // Rate limiting check
    if (this.postsToday >= this.maxPostsPerDay) {
      return {
        success: false,
        error: 'Daily post limit reached',
        postsToday: this.postsToday
      };
    }

    if (this.lastPostTime) {
      const timeSinceLastPost = Date.now() - this.lastPostTime;
      if (timeSinceLastPost < this.minPostInterval) {
        const waitMinutes = Math.ceil((this.minPostInterval - timeSinceLastPost) / 60000);
        return {
          success: false,
          error: `Rate limited. Wait ${waitMinutes} minutes before next post.`,
          nextPostTime: new Date(this.lastPostTime + this.minPostInterval).toISOString()
        };
      }
    }

    this.log(`=== START postVehicle: ${vehicle.year} ${vehicle.make} ${vehicle.model} (VIN=${vehicle.vin || 'none'}) ===`);
    this.log(`  Price=${vehicle.price} Mileage=${vehicle.mileage || 'N/A'} Color=${vehicle.exterior_color || 'N/A'} Photos=${(vehicle.photos || []).length}`);

    try {
      // Ensure logged in
      if (!this.isLoggedIn) {
        const loggedIn = await this.checkLoginStatus();
        if (!loggedIn) {
          return { success: false, error: 'Not logged in. Run login() first.' };
        }
      }

      // Auto-discover photos from data/photos/<VIN>/ if not already set
      if ((!vehicle.photos || vehicle.photos.length === 0) && vehicle.vin) {
        vehicle.photos = this.findPhotosForVehicle(vehicle.vin);
      }

      // Navigate to create listing
      await this.goToCreateListing(vehicle);

      // Upload photos FIRST (FB shows the photo upload area at the top, and it's required)
      if (vehicle.photos && vehicle.photos.length > 0) {
        await this.uploadPhotos(vehicle.photos);
      } else {
        this.log('WARNING: No photos found — FB requires at least 1 photo!');
        this.log(` Put photos in: ${path.join(PHOTOS_DIR, vehicle.vin || 'VIN')}/`);
      }

      // Fill in vehicle details
      await this.fillVehicleForm(vehicle);

      // Review and get confirmation
      const previewResult = await this.reviewListing(vehicle);

      if (previewResult.needsConfirmation) {
        this.log('Listing ready for review. Waiting for confirmation...');
        return {
          success: false,
          status: 'pending_confirmation',
          previewScreenshot: previewResult.screenshot,
          message: 'Listing ready. Call confirmPost() to publish.'
        };
      }

      // Publish (two-step: Next → Publish)
      const postResult = await this.publishListing();

      if (postResult.draft) {
        // Form was filled but couldn't proceed — draft saved
        return {
          success: false,
          status: 'draft_saved',
          error: postResult.error,
          draftScreenshot: postResult.screenshot,
          missingFields: postResult.missingFields,
          message: `Draft saved. ${postResult.error} DO NOT RETRY — fix the missing fields first.`
        };
      }

      // Update tracking
      this.postsToday++;
      this.lastPostTime = Date.now();

      this.log(`=== SUCCESS postVehicle: ${vehicle.year} ${vehicle.make} ${vehicle.model} → ${postResult.url || 'no URL'} ===`);
      return {
        success: true,
        postUrl: postResult.url,
        postId: postResult.id,
        postedAt: new Date().toISOString(),
        postsToday: this.postsToday
      };

    } catch (e) {
      this.err(`=== FAILED postVehicle: ${vehicle.year} ${vehicle.make} ${vehicle.model} — ${e.message} ===`);
      this.err(`Stack: ${e.stack}`);
      await this.takeScreenshot('post_error_' + (vehicle.vin || 'unknown'));

      return {
        success: false,
        error: e.message,
        screenshot: `post_error_${vehicle.vin || 'unknown'}.png`,
        message: 'Post failed. DO NOT RETRY automatically — check the error and screenshot.'
      };
    }
    });
  }

  /**
   * Find photos for a vehicle in data/photos/<VIN>/ directory
   * @param {string} vin - Vehicle VIN
   * @returns {string[]} Array of absolute file paths
   */
  findPhotosForVehicle(vin) {
    const vinDir = path.join(PHOTOS_DIR, vin);
    if (!fs.existsSync(vinDir)) {
      return [];
    }

    const imageExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    const photos = fs.readdirSync(vinDir)
      .filter(f => imageExts.includes(path.extname(f).toLowerCase()))
      .sort()
      .map(f => path.join(vinDir, f));

    if (photos.length > 0) {
      this.log(` Found ${photos.length} photos in ${vinDir}`);
    }

    return photos;
  }

  /**
   * Type into an input field with human-like behavior
   * @param {ElementHandle} element - The input element
   * @param {string} value - Value to type
   */
  async typeIntoField(element, value) {
    await element.click({ clickCount: 3 }); // Select existing text
    await humanDelay(200, 400);
    await element.type(value.toString(), { delay: Math.random() * 50 + 30 });
  }

  /**
   * Dismiss any overlay dialogs (notifications prompt, photo tips, etc.)
   * that FB shows after photo upload or page load.
   * These overlays block clicks on the form underneath.
   */
  async dismissOverlays() {
    const dismissed = await this.page.evaluate(() => {
      const closed = [];
      // Close any visible dialogs by clicking their close/dismiss buttons
      for (const dialog of document.querySelectorAll('[role="dialog"]')) {
        if (dialog.offsetParent === null) continue;
        // Look for close buttons: [aria-label="Close"], "Not now", "Close", "Skip", "X"
        for (const btn of dialog.querySelectorAll('[role="button"], button, [aria-label="Close"]')) {
          const text = btn.textContent?.trim().toLowerCase() || '';
          const label = btn.getAttribute('aria-label')?.toLowerCase() || '';
          if (label === 'close' || text === 'close' || text === 'not now' ||
              text === 'skip' || text === 'x' || text === 'dismiss' ||
              text === 'got it' || text === 'ok') {
            btn.click();
            closed.push(text || label);
            break;
          }
        }
      }
      return closed;
    });
    if (dismissed.length > 0) {
      this.log(` Dismissed overlays: ${dismissed.join(', ')}`);
      await new Promise(r => setTimeout(r, 500));
    }

    // Press Escape as fallback to close any remaining overlays
    await this.page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 300));

    // Click the form area to ensure focus is on the form, not an overlay
    await this.page.mouse.click(180, 400);
    await new Promise(r => setTimeout(r, 300));
  }

  /**
   * Generate a compelling FB Marketplace description through the cloud AI API.
   */
  async generateDescription(vehicle) {
    if (!this.apiUrl || !this.authToken) {
      this.log('Cloud AI credentials not configured, skipping AI description');
      return null;
    }

    const response = await this._cloudPost('/api/ai/generate-fb-description', {
      vehicle: {
        year: vehicle.year,
        make: vehicle.make,
        model: vehicle.model,
        trim: vehicle.trim,
        price: vehicle.price,
        mileage: vehicle.mileage,
        color: vehicle.color || vehicle.exteriorColor || vehicle.exterior_color,
        bodyStyle: vehicle.bodyStyle || vehicle.body_style,
        transmission: vehicle.transmission,
        fuelType: vehicle.fuelType || vehicle.fuel_type,
        vin: vehicle.vin,
      },
    });
    const desc = typeof response?.description === 'string' ? response.description.trim() : '';
    if (!desc) {
      this.log(' AI description generation failed via cloud API');
      return null;
    }

    this.log(` AI description generated (${desc.length} chars)`);
    return desc;
  }

  /**
   * Fill in the vehicle listing form.
   *
   * Adapts dynamically to whichever vehicle type was selected — different types
   * show different fields. Instead of hardcoding the Car/van layout, we detect
   * which dropdowns/inputs are present on the page and fill them accordingly.
   *
   * Field presence by vehicle type (Feb 2026):
   *   Car/van:              Year(dd), Make(dd), Model, Mileage, Price, Body style, Ext/Int colour, Condition, Fuel, Transmission, Clean title, Description
   *   Motorcycle:           Year(dd), Make(dd/397), Model, Mileage, Price, Ext colour, Fuel, Transmission, Description
   *   Power sport:          Year(dd), Make(text), Model, Price, Ext/Int colour, Fuel, Description
   *   Motorhome/caravan:    Year(dd), Make(text), Model, Price, Ext/Int colour, Fuel, Description
   *   Boat:                 Year(dd), Make(text), Model, Price, Ext/Int colour, Fuel, Description
   *   Commercial/Industrial:Year(dd), Make(text), Model, Price, Ext/Int colour, Fuel, Description
   *   Trailer:              Year(dd), Make(text), Model, Price, Ext/Int colour, Description
   *   Other:                Year(dd), Make(text), Model, Price, Description
   *
   * @param {object} vehicle - Vehicle object
   */
  async fillVehicleForm(vehicle) {
    this.log('Filling vehicle form...');
    const vtype = this._selectedVehicleType || 'Car/van';
    this.log(` Vehicle type: ${vtype}`);
    let fieldsFound = 0;
    let fieldsMissed = 0;

    // Dismiss any overlay dialogs (notifications, photo tips) that block the form
    await this.dismissOverlays();

    // Detect which dropdowns are present on the page
    const presentDropdowns = await this.page.evaluate(() => {
      return [...document.querySelectorAll('label[role="combobox"]')]
        .filter(l => l.offsetParent !== null)
        .map(l => l.textContent?.trim().substring(0, 30));
    });
    this.log(` Dropdowns present: ${presentDropdowns.join(', ')}`);

    // Value mappings — GB locale options first (Coupé, Van, Saloon, Hatchback,
    // 4x4, Convertible, Estate, MPV/People carrier, Small car, Other),
    // then US variants as fallback
    const suvValues = ['4x4', 'SUV', 'SUV/Crossover', 'Other'];
    const truckValues = ['4x4', 'Van', 'Truck', 'Pickup Truck', 'Other'];
    const bodyStyleMap = {
      'sedan': ['Saloon', 'Sedan', 'Other'],
      'saloon': ['Saloon', 'Sedan', 'Other'],
      'coupe': ['Coupé', 'Coupe', 'Other'],
      'coupé': ['Coupé', 'Coupe', 'Other'],
      'hatchback': ['Hatchback', 'Other'],
      'suv': suvValues,
      'crossover': suvValues,
      'sport utility': suvValues,
      'sport utility vehicle': suvValues,
      'sport utility vehicle 4d': suvValues,
      '4d sport utility': suvValues,
      '2d sport utility': suvValues,
      'convertible': ['Convertible', 'Other'],
      'wagon': ['Estate', 'Wagon', 'Station Wagon', 'Other'],
      'station wagon': ['Estate', 'Wagon', 'Station Wagon', 'Other'],
      'estate': ['Estate', 'Wagon', 'Station Wagon', 'Other'],
      'van': ['Van', 'Other'],
      'minivan': ['MPV/People carrier', 'Minivan', 'Van', 'Other'],
      'mini van': ['MPV/People carrier', 'Minivan', 'Van', 'Other'],
      'mpv': ['MPV/People carrier', 'Minivan', 'Other'],
      'people carrier': ['MPV/People carrier', 'Minivan', 'Other'],
      'pickup': truckValues,
      'pickup truck': truckValues,
      'truck': truckValues,
      'crew cab': truckValues,
      'extended cab': truckValues,
      'regular cab': truckValues,
      'small car': ['Small car', 'Hatchback', 'Other'],
      'compact': ['Small car', 'Hatchback', 'Other'],
      'subcompact': ['Small car', 'Hatchback', 'Other'],
      '4x4': ['4x4', 'SUV', 'Other'],
      'other': ['Other'],
    };
    const conditionMap = {
      'new': ['Excellent'],
      'like new': ['Excellent'],
      'excellent': ['Excellent'],
      'very good': ['Very good'],
      'used': ['Good'],
      'good': ['Good'],
      'fair': ['Fair'],
      'poor': ['Poor'],
      'certified': ['Excellent'],
      'certified pre-owned': ['Excellent']
    };
    const fuelMap = {
      'gasoline': ['Gasoline', 'Petrol'],
      'gas': ['Gasoline', 'Petrol'],
      'petrol': ['Petrol', 'Gasoline'],
      'diesel': ['Diesel'],
      'electric': ['Electric'],
      'hybrid': ['Hybrid'],
      'plug-in hybrid': ['Plug-in hybrid'],
      'flex': ['Flex', 'Other']
    };
    const transMap = {
      'automatic': ['Automatic', 'Automatic transmission'],
      'auto': ['Automatic', 'Automatic transmission'],
      'cvt': ['Automatic', 'Automatic transmission'],
      'continuously variable': ['Automatic', 'Automatic transmission'],
      'continuously variable transmission': ['Automatic', 'Automatic transmission'],
      'manual': ['Manual', 'Manual transmission'],
      'stick': ['Manual', 'Manual transmission'],
      'standard': ['Manual', 'Manual transmission']
    };

    // Helper: check if a dropdown label exists on the page (supports locale variants)
    const hasDropdown = (...labels) => {
      const normalizedLabels = labels.map(normalizeUiText);
      return presentDropdowns.some(d => {
        const normalizedValue = normalizeUiText(d);
        return normalizedLabels.some(l => normalizedValue === l || normalizedValue.startsWith(l));
      });
    };

    // --- DROPDOWN: Year (all types) ---
    this.log('Setting Year...');
    if (await this.selectDropdown('Year', vehicle.year.toString())) {
      fieldsFound++;
    } else { fieldsMissed++; }
    await humanDelay(1000, 2000);

    // --- MAKE ---
    // Car/van and Motorcycle have Make as a dropdown; others have Make as text input
    this.log('Setting Make...');
    if (hasDropdown('Make')) {
      // Dropdown Make (Car/van, Motorcycle)
      if (await this.selectDropdown('Make', vehicle.make)) {
        fieldsFound++;
      } else { fieldsMissed++; }
    } else {
      // Text input Make (Power sport, Motorhome, Boat, Commercial, Trailer, Other)
      const makeField = await this.findFieldByLabel('Make');
      if (makeField) {
        await this.typeIntoField(makeField, vehicle.make);
        fieldsFound++;
      } else { fieldsMissed++; }
    }
    await humanDelay(1000, 2000);

    // --- TEXT INPUT: Model (all types) ---
    this.log('Typing Model...');
    const modelField = await this.findFieldByLabel('Model');
    if (modelField) {
      const modelWithTrim = vehicle.trim
        ? `${vehicle.model} ${vehicle.trim}`
        : vehicle.model;
      await this.typeIntoField(modelField, modelWithTrim);
      fieldsFound++;
    } else { fieldsMissed++; }
    await humanDelay(800, 1500);

    await this.takeScreenshot('debug_03_after_year_make_model');

    // --- TEXT INPUT: Mileage (Car/van and Motorcycle only) ---
    if (vehicle.mileage) {
      const mileageField = await this.findFieldByLabel('Mileage') ||
                            await this.findFieldByLabel('Kilometres') ||
                            await this.findFieldByLabel('Kilometers');
      if (mileageField) {
        this.log('Typing Mileage...');
        await this.typeIntoField(mileageField, vehicle.mileage.toString());
        fieldsFound++;
      }
      await humanDelay(500, 1000);
    }

    // Scroll down to reveal Price and more fields
    await this.page.evaluate(() => window.scrollBy(0, 300));
    await humanDelay(500, 1000);

    // --- TEXT INPUT: Price (all types) ---
    this.log('Typing Price...');
    const priceField = await this.findFieldByLabel('Price');
    if (priceField) {
      await this.typeIntoField(priceField, vehicle.price.toString());
      fieldsFound++;
    } else { fieldsMissed++; }
    await humanDelay(500, 1000);

    await this.takeScreenshot('debug_04_after_price_mileage');

    // Scroll down to reveal dropdowns
    await this.page.evaluate(() => window.scrollBy(0, 300));
    await humanDelay(500, 1000);

    // --- DROPDOWN: Body style (Car/van only) ---
    if (hasDropdown('Body style', 'Body type')) {
      this.log('Setting Body style...');
      const rawBody = vehicle.bodyStyle || vehicle.body_style || 'Sedan';
      const normBody = normalizeUiText(rawBody);
      let bodyVal = bodyStyleMap[normBody] || [rawBody];
      if (!bodyStyleMap[normBody]) {
        if (normBody.includes('suv') || normBody.includes('crossover') || normBody.includes('sport utility') || normBody.includes('utility')) {
          bodyVal = suvValues;
        }
        else if (normBody.includes('pickup') || normBody.includes('truck') || normBody.includes('crew cab') || normBody.includes('extended cab')) bodyVal = truckValues;
        else if (normBody.includes('wagon')) bodyVal = ['Estate', 'Wagon', 'Other'];
        else if (normBody.includes('sedan') || normBody.includes('saloon')) bodyVal = ['Saloon', 'Sedan', 'Other'];
        else if (normBody.includes('coupe') || normBody.includes('coupé')) bodyVal = ['Coupé', 'Coupe', 'Other'];
        else if (normBody.includes('van')) bodyVal = ['Van', 'MPV/People carrier', 'Other'];
        else if (normBody.includes('hatch')) bodyVal = ['Hatchback', 'Other'];
        else if (normBody.includes('convert')) bodyVal = ['Convertible', 'Other'];
      }
      if (await this.selectDropdown(['Body style', 'Body type'], bodyVal)) {
        fieldsFound++;
      } else { fieldsMissed++; }
      await humanDelay(500, 1000);
    }

    // --- DROPDOWN: Exterior colour (most types except Other) ---
    if (hasDropdown('Exterior colour', 'Exterior color')) {
      this.log('Setting Exterior color...');
      const extColor = await this.matchColorToFB(vehicle.exteriorColor || vehicle.exterior_color || vehicle.color);
      if (await this.selectDropdown(['Exterior colour', 'Exterior color'], extColor)) {
        fieldsFound++;
      } else { fieldsMissed++; }
      await humanDelay(500, 1000);
    }

    // --- DROPDOWN: Interior colour (Car/van, Power sport, Motorhome, Trailer, Boat, Commercial) ---
    if (hasDropdown('Interior colour', 'Interior color')) {
      this.log('Setting Interior color...');
      const intColor = await this.matchColorToFB(vehicle.interiorColor || vehicle.interior_color || 'Black');
      if (await this.selectDropdown(['Interior colour', 'Interior color'], intColor)) {
        fieldsFound++;
      } else { fieldsMissed++; }
      await humanDelay(500, 1000);
    }

    // Scroll down more
    await this.page.evaluate(() => window.scrollBy(0, 300));
    await humanDelay(500, 1000);

    // --- CHECKBOX: Clean title (Car/van only) ---
    const cleanTitleCheck = await this.page.$('[aria-label="This vehicle has a clean title."]');
    if (cleanTitleCheck) {
      const isChecked = await cleanTitleCheck.evaluate(el => el.checked);
      if (!isChecked) {
        this.log('Checking Clean title...');
        await cleanTitleCheck.click();
        await humanDelay(300, 600);
      }
    }

    // --- DROPDOWN: Vehicle condition (Car/van only) ---
    // Condition is already computed by the feed parser (inferCondition in
    // schema.js) based on year + mileage. The poster just maps it to the
    // FB dropdown value. Falls back to 'Good' if somehow missing.
    if (hasDropdown('Vehicle condition', 'Condition')) {
      this.log('Setting Vehicle condition...');
      const rawCondition = (vehicle.condition || 'Good').trim();
      const condVal = conditionMap[rawCondition.toLowerCase()] || [rawCondition];
      this.log(` Condition: ${condVal[0]} (from vehicle.condition="${rawCondition}")`);

      if (await this.selectDropdown(['Vehicle condition', 'Condition'], condVal)) {
        fieldsFound++;
      } else { fieldsMissed++; }
      await humanDelay(500, 1000);
    }

    // --- DROPDOWN: Fuel type (all except Trailer and Other) ---
    if (hasDropdown('Fuel type')) {
      this.log('Setting Fuel type...');
      const rawFuel = vehicle.fuelType || vehicle.fuel_type || 'Gasoline';
      const fuelVal = fuelMap[rawFuel.toLowerCase()] || [rawFuel];
      if (await this.selectDropdown('Fuel type', fuelVal)) {
        fieldsFound++;
      } else { fieldsMissed++; }
      await humanDelay(500, 1000);
    }

    // --- DROPDOWN: Transmission (Car/van and Motorcycle) ---
    if (hasDropdown('Transmission')) {
      const rawTrans = vehicle.transmission || 'automatic';
      const normTrans = normalizeUiText(rawTrans);
      let transVal = transMap[normTrans] || [rawTrans];
      if (!transMap[normTrans] && (normTrans.includes('continuously variable') || normTrans.includes('cvt'))) {
        transVal = ['Automatic', 'Automatic transmission'];
      }
      this.log('Setting Transmission...');
      if (await this.selectDropdown('Transmission', transVal)) {
        fieldsFound++;
      }
      await humanDelay(500, 1000);
    }

    await this.takeScreenshot('debug_05_after_dropdowns');

    // Scroll down for description
    await this.page.evaluate(() => window.scrollBy(0, 300));
    await humanDelay(500, 1000);

    // --- TEXTAREA: Description (all types) ---
    this.log('Generating AI description...');
    const descField = await this.findFieldByLabel('Description') ||
                       await this.page.$('textarea');
    if (descField) {
      // Try AI-generated description first, then fallbacks
      let desc = vehicle.generatedDescription || vehicle.generated_content?.description || null;
      if (!desc) {
        desc = await this.generateDescription(vehicle);
      }
      if (!desc) {
        desc = vehicle.description || '';
      }
      if (!desc) {
        const price = vehicle.price ? `$${Number(vehicle.price).toLocaleString()}` : 'Great price';
        const miles = vehicle.mileage ? `${Number(vehicle.mileage).toLocaleString()} miles` : '';
        const parts = [
          `Clean ${vehicle.year || ''} ${vehicle.make || ''} ${vehicle.model || ''}`.trim(),
          miles,
          price,
          'Financing available. Trade-ins welcome.',
          vehicle.vin ? `VIN: ${vehicle.vin}` : '',
        ].filter(Boolean);
        desc = parts.join('\n');
      }
      this.log(` Description length: ${desc.length}`);
      if (desc) {
        await descField.click();
        await humanDelay(300, 600);
        for (let i = 0; i < desc.length; i += 50) {
          const chunk = desc.slice(i, i + 50);
          await descField.type(chunk, { delay: 10 });
          await humanDelay(50, 150);
        }
        fieldsFound++;
      }
    } else { fieldsMissed++; }
    await humanDelay(500, 1000);

    // Scroll back up and take final screenshot
    await this.page.evaluate(() => window.scrollTo(0, 0));
    await humanDelay(500, 1000);
    await this.takeScreenshot('debug_06_form_complete');

    this.log(` Form filled — ${fieldsFound} fields set, ${fieldsMissed} missed`);
  }

  /**
   * Select a dropdown option.
   *
   * FB Marketplace (2026) dropdowns are <label role="combobox"> elements.
   * Clicking them opens a list of [role="option"] items.
   *
   * Uses the proven pattern from diagnostic scripts:
   *   1. element.click() (not mouse.click — more reliable on FB labels)
   *   2. flat delay (not waitForSelector chains that can timeout cumulatively)
   *   3. single evaluateHandle call to find+click options (avoids stale refs)
   *
   * @param {string} label - Dropdown label (e.g., "Year", "Make")
   * @param {string} value - Value to select
   * @returns {boolean} Whether selection succeeded
   */
  async selectDropdown(label, value) {
    try {
      const labels = Array.isArray(label) ? label.filter(Boolean) : [label];
      const values = (Array.isArray(value) ? value : [value])
        .filter(v => v !== undefined && v !== null)
        .map(v => String(v).trim())
        .filter(Boolean);
      if (labels.length === 0 || values.length === 0) {
        return false;
      }

      // Close any previously open dropdown first
      await this.page.keyboard.press('Escape');
      await new Promise(r => setTimeout(r, 300));

      // Find the dropdown element (supports alternate spellings/locale labels)
      let dropdown = null;
      let resolvedLabel = labels[0];
      for (const candidateLabel of labels) {
        dropdown = await this.findFieldByLabel(candidateLabel);
        if (dropdown) {
          resolvedLabel = candidateLabel;
          break;
        }
      }
      if (!dropdown) {
        this.log(`   SKIP: Dropdown not found for labels ${JSON.stringify(labels)}`);
        return false;
      }

      // Scroll element into view first
      await dropdown.evaluate(el => el.scrollIntoView({ block: 'center' }));
      await new Promise(r => setTimeout(r, 400));

      // Click to open — use element.click() first (proven reliable in diagnostics),
      // fall back to boundingBox mouse.click, then evaluate .click()
      try {
        await dropdown.click();
      } catch (clickErr) {
        try {
          const box = await dropdown.boundingBox();
          if (box) {
            await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          } else {
            await dropdown.evaluate(el => el.click());
          }
        } catch (e2) {
          await dropdown.evaluate(el => el.click());
        }
      }

      // Fixed delay — FB needs time to render the options popup
      await new Promise(r => setTimeout(r, 1500));

      // Try to find and click the matching option in a single page-context call
      // This avoids race conditions from sequential $$() + evaluate() calls
      const matched = await this.page.evaluate((candidateValues) => {
        const normalize = (s) => (s || '')
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9]+/g, ' ')
          .trim();
        const candidates = candidateValues.map(normalize).filter(Boolean);
        const options = document.querySelectorAll('[role="option"]');
        const optionRows = [];
        for (const o of options) {
          const text = o.textContent?.trim() || '';
          optionRows.push({ node: o, text, norm: normalize(text) });
        }

        // Pass 1: Exact match
        for (const candidate of candidates) {
          for (const row of optionRows) {
            if (row.norm === candidate) {
              row.node.click();
              return { found: true, text: row.text, method: 'exact' };
            }
          }
        }

        // Pass 2: Partial/contains match
        for (const candidate of candidates) {
          for (const row of optionRows) {
            if (row.norm.includes(candidate) || candidate.includes(row.norm)) {
              row.node.click();
              return { found: true, text: row.text, method: 'partial' };
            }
          }
        }

        // Collect first few options for debugging
        const samples = [];
        for (let i = 0; i < Math.min(optionRows.length, 8); i++) {
          samples.push(optionRows[i].text.substring(0, 40));
        }
        return { found: false, total: optionRows.length, samples };
      }, values);

      if (matched.found) {
        this.log(`   Selected "${resolvedLabel}" = "${matched.text}" (${matched.method})`);
        await humanDelay(800, 1500);
        return true;
      }

      if (matched.total > 0) {
        this.log(`   ${matched.total} options visible but no match for ${JSON.stringify(values)}. Samples: ${JSON.stringify(matched.samples)}`);
      }

      // Fallback: type-to-search (works for searchable dropdowns like Year, Make)
      for (const candidate of values) {
        this.log(`   Trying type-to-search for "${candidate}"...`);
        await this.page.keyboard.down('Control');
        await this.page.keyboard.press('A');
        await this.page.keyboard.up('Control');
        await this.page.keyboard.press('Backspace');
        await this.page.keyboard.type(candidate, { delay: 60 });
        await new Promise(r => setTimeout(r, 1200));

        const afterType = await this.page.evaluate((val) => {
          const normalize = (s) => (s || '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, ' ')
            .trim();
          const target = normalize(val);
          const options = document.querySelectorAll('[role="option"]');
          for (const o of options) {
            const text = o.textContent?.trim() || '';
            const norm = normalize(text);
            if (norm === target || norm.includes(target) || target.includes(norm)) {
              o.click();
              return { found: true, text };
            }
          }
          const samples = [];
          for (let i = 0; i < Math.min(options.length, 5); i++) {
            samples.push(options[i].textContent?.trim().substring(0, 40));
          }
          return { found: false, total: options.length, samples };
        }, candidate);

        if (afterType.found) {
          this.log(`   Selected "${resolvedLabel}" = "${afterType.text}" (type-to-search)`);
          await humanDelay(800, 1500);
          return true;
        }

        if (afterType.total > 0) {
          this.log(`   After typing: ${afterType.total} options, samples: ${JSON.stringify(afterType.samples)}`);
        }
      }

      // Close dropdown
      await this.page.keyboard.press('Escape');
      await new Promise(r => setTimeout(r, 300));
      this.log(`   FAILED: Could not select labels=${JSON.stringify(labels)} values=${JSON.stringify(values)}`);
      return false;

    } catch (e) {
      this.log(`   ERROR selecting dropdown ${JSON.stringify(label)}: ${e.message}`);
      await this.page.keyboard.press('Escape').catch(() => {});
      return false;
    }
  }

  /**
   * Upload photos to the listing.
   *
   * FB Marketplace (2026) uses React synthetic events — the hidden
   * file input's uploadFile() doesn't trigger FB's handler.
   * Instead, we click the "Add photos" button and use Puppeteer's
   * fileChooser API to intercept the OS file dialog.
   *
   * @param {string[]} photoPaths - Array of absolute file paths to images
   */
  /**
   * Download a remote photo URL to a local file
   */
  _downloadPhoto(url, destPath) {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;
      const request = (reqUrl, redirects = 0) => {
        if (redirects > 5) return reject(new Error('Too many redirects'));
        client.get(reqUrl, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return request(res.headers.location, redirects + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          const stream = fs.createWriteStream(destPath);
          res.pipe(stream);
          stream.on('finish', () => { stream.close(); resolve(destPath); });
          stream.on('error', reject);
        }).on('error', reject);
      };
      request(url);
    });
  }

  async uploadPhotos(photoPaths) {
    this.log(` Uploading ${photoPaths.length} photo(s)...`);

    // Resolve photos: download remote URLs to local files, keep existing local paths
    const validPhotos = [];
    for (let i = 0; i < photoPaths.length; i++) {
      const p = photoPaths[i];
      if (p.startsWith('http')) {
        // Download to a temp file in TEMP_DIR
        const ext = (p.match(/\.(jpe?g|png|webp)/i) || ['.jpg'])[0];
        const localPath = path.join(TEMP_DIR, `_dl_${Date.now()}_${i}${ext.startsWith('.') ? ext : '.' + ext}`);
        try {
          await this._downloadPhoto(p, localPath);
          this.log(`   Downloaded photo ${i + 1}: ${p.substring(0, 80)}...`);
          validPhotos.push(localPath);
        } catch (e) {
          this.log(`   Failed to download photo: ${e.message}`);
        }
      } else if (fs.existsSync(p)) {
        validPhotos.push(p);
      } else {
        this.log(`   Skipping missing file: ${p}`);
      }
    }

    if (validPhotos.length === 0) {
      this.log('No valid photos to upload');
      return;
    }

    const toUpload = validPhotos.slice(0, 20);

    // Strategy 1: Use fileChooser API (intercept the OS dialog)
    // Click the "Add photos" area and catch the file chooser
    try {
      // Find the "Add photos" clickable area
      const addPhotosArea = await this.page.evaluateHandle(() => {
        // Look for the "Add photos" button/div
        for (const el of document.querySelectorAll('[role="button"]')) {
          const text = el.textContent?.trim().toLowerCase();
          if (text && text.includes('add photo') && el.offsetParent !== null) return el;
        }
        return null;
      });

      if (addPhotosArea && addPhotosArea.asElement()) {
        // Set up file chooser listener BEFORE clicking
        const [fileChooser] = await Promise.all([
          this.page.waitForFileChooser({ timeout: 5000 }),
          addPhotosArea.asElement().click()
        ]);

        // Accept files through the file chooser
        await fileChooser.accept(toUpload);
        this.log(` Uploaded ${toUpload.length} photo(s) via file chooser`);

        // Wait for photos to process
        await humanDelay(5000, 10000);

        // Verify upload succeeded
        const photoCount = await this.page.evaluate(() => {
          const text = document.body.innerText;
          const match = text.match(/Photos?\s*\n?\s*[·:]\s*(\d+)/i);
          return match ? parseInt(match[1]) : 0;
        });

        if (photoCount > 0) {
          this.log(` Photo upload confirmed: ${photoCount} photo(s) showing`);
        } else {
          this.log('WARNING: Photo count still 0 after upload — checking for errors...');
          // Check for error dialogs
          const errorDialog = await this.page.evaluate(() => {
            for (const d of document.querySelectorAll('[role="dialog"]')) {
              const t = d.textContent?.trim();
              if (t && (t.includes("Can't read") || t.includes("couldn't be uploaded"))) return t.substring(0, 200);
            }
            return null;
          });
          if (errorDialog) {
            this.log(` Upload error: ${errorDialog}`);
            // Close error dialog
            const closeBtn = await this.page.$('[aria-label="Close"]');
            if (closeBtn) { await closeBtn.click(); await humanDelay(500, 1000); }
          }
        }

        await this.takeScreenshot('debug_photos_uploaded');
        return;
      }
    } catch (e) {
      this.log(` File chooser approach failed: ${e.message}`);
    }

    // Strategy 2: Fallback to direct uploadFile on hidden input
    this.log('Falling back to direct file input upload...');
    let fileInput = await this.page.$('input[type="file"][accept*="image"]');
    if (!fileInput) {
      fileInput = await this.page.$('input[type="file"]');
    }

    if (fileInput) {
      await fileInput.uploadFile(...toUpload);
      this.log(` Uploaded ${toUpload.length} photo(s) via file input`);
      await humanDelay(5000, 10000);
    } else {
      this.log('WARNING: No upload mechanism found');
    }

    await this.takeScreenshot('debug_photos_uploaded');
  }

  /**
   * Review the listing before publishing
   * @param {object} vehicle - Vehicle object
   * @returns {object} Review result
   */
  async reviewListing(vehicle) {
    this.log('Reviewing listing...');

    // Scroll to top for review screenshot
    await this.page.evaluate(() => window.scrollTo(0, 0));
    await humanDelay(500, 1000);
    const screenshotPath = await this.takeScreenshot(`review_${vehicle.vin || 'unknown'}`);

    // Auto-publish — confirmation is handled at the CLI/bot level
    return {
      needsConfirmation: false,
      screenshot: screenshotPath
    };
  }

  /**
   * Two-step publish flow:
   *   Step 1: Click "Next" button on the form page
   *   Step 2: Click "Publish" button on the review page
   *
   * Puppeteer 22+ compatible — uses evaluateHandle instead of $x().
   * @returns {object} Post result with URL
   */
  async publishListing() {
    this.log('Publishing listing (Next → Publish)...');

    // --- STEP 1: Click "Next" ---
    await this.takeScreenshot('debug_07_pre_next');

    // Scroll down to make Next button visible
    await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await humanDelay(1000, 2000);

    const nextButton = await this._findButtonByText('Next');
    if (!nextButton) {
      await this.takeScreenshot('debug_next_button_not_found');
      throw new Error('"Next" button not found on form page');
    }

    // Check if Next is disabled (FB disables it when required fields are missing)
    const nextState = await nextButton.evaluate(el => ({
      ariaDisabled: el.getAttribute('aria-disabled'),
      cursor: window.getComputedStyle(el).cursor
    }));
    if (nextState.ariaDisabled === 'true' || nextState.cursor === 'not-allowed') {
      // Check for validation alerts
      const alerts = await this.page.evaluate(() => {
        const a = [];
        document.querySelectorAll('[role="alert"]').forEach(el => {
          const t = el.textContent?.trim();
          if (t) a.push(t);
        });
        return a;
      });

      // Check which required dropdowns are still unset
      const missingFields = await this.page.evaluate(() => {
        const missing = [];
        for (const label of document.querySelectorAll('label[role="combobox"]')) {
          if (label.offsetParent === null) continue;
          const text = label.textContent?.trim() || '';
          // If the dropdown text is JUST the label (no selected value appended), it's unset
          if (['Year', 'Make', 'Body style', 'Body type', 'Exterior colour', 'Exterior color', 'Interior colour', 'Interior color', 'Vehicle condition', 'Condition', 'Fuel type'].includes(text)) {
            missing.push(text);
          }
        }
        // Check if photos are missing
        const photoMatch = document.body.innerText.match(/Photos?\s*\n?\s*[·:]\s*(\d+)/i);
        const photoCount = photoMatch ? parseInt(photoMatch[1]) : 0;
        if (photoCount === 0) missing.unshift('Photos (required)');
        return missing;
      });

      const alertText = alerts.length > 0 ? ` Validation: ${alerts.join('; ')}` : '';
      const missingText = missingFields.length > 0 ? ` Missing: ${missingFields.join(', ')}` : '';
      this.log(` "Next" button is disabled.${missingText}${alertText}`);

      // Save draft screenshot
      const draftScreenshot = await this.takeScreenshot('draft_saved');
      this.log('Draft saved — form state preserved in screenshot');

      // Return draft result instead of throwing (prevents retry loops)
      return {
        draft: true,
        error: `Next button disabled.${missingText}${alertText}`,
        missingFields,
        screenshot: draftScreenshot
      };
    }

    await this._clickElement(nextButton);
    this.log('Clicked "Next" button');
    await humanDelay(3000, 5000);

    await this.takeScreenshot('debug_08_after_next');

    // Wait for the review/publish page to load
    await this.page.waitForFunction(
      () => document.body.innerText.includes('Publish') || document.body.innerText.includes('publish'),
      { timeout: 15000 }
    ).catch(() => {
      this.log('WARNING: "Publish" text not found after clicking Next');
    });

    await humanDelay(1000, 2000);

    // --- STEP 2: Click "Publish" ---
    await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await humanDelay(500, 1000);

    const publishButton = await this._findButtonByText('Publish');
    if (!publishButton) {
      await this.takeScreenshot('debug_publish_button_not_found');
      throw new Error('"Publish" button not found on review page');
    }

    await this._clickElement(publishButton);
    this.log('Clicked "Publish" button');
    await humanDelay(3000, 5000);

    await this.takeScreenshot('debug_09_after_publish');

    // Wait for navigation or page update
    await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => { });
    await humanDelay(2000, 3000);

    // Try to get the post URL
    const currentUrl = this.page.url();
    await this.takeScreenshot('debug_10_final_result');

    this.log(` Final page URL: ${currentUrl}`);

    return {
      url: currentUrl,
      id: this.extractPostId(currentUrl)
    };
  }

  /**
   * Find a button by its text content (no XPath/$x).
   * Checks role="button" divs, <button> elements, and aria-label matches.
   * @param {string} text - Button text to find
   * @returns {ElementHandle|null}
   */
  async _findButtonByText(text) {
    const MAX_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Scroll both document.body AND any scrollable form containers into view
      await this.page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
        // FB Marketplace form is often inside a scrollable dialog/modal
        for (const el of document.querySelectorAll('[role="dialog"], [role="main"], form')) {
          if (el.scrollHeight > el.clientHeight) {
            el.scrollTop = el.scrollHeight;
          }
        }
      });
      await new Promise(r => setTimeout(r, 500));

      // Strategy 1: aria-label exact match
      let btn = await this.page.$(`[aria-label="${text}"]`);
      if (btn) {
        this.log(`   Found "${text}" button via aria-label (attempt ${attempt})`);
        return btn;
      }

      // Strategy 2: role="button" containing a span with the text
      btn = await this.page.evaluateHandle((searchText) => {
        const lower = searchText.toLowerCase();
        const buttons = document.querySelectorAll('[role="button"], button');
        for (const btn of buttons) {
          const spans = btn.querySelectorAll('span');
          for (const span of spans) {
            if (span.textContent?.trim().toLowerCase() === lower) {
              return btn;
            }
          }
          if (btn.textContent?.trim().toLowerCase() === lower) {
            return btn;
          }
        }
        return null;
      }, text);
      if (btn && btn.asElement()) {
        this.log(`   Found "${text}" button via text content (attempt ${attempt})`);
        return btn.asElement();
      }

      // Strategy 3: broad text search
      btn = await this.findByText(text, 'span');
      if (btn) {
        this.log(`   Found "${text}" button via findByText (attempt ${attempt})`);
        return btn;
      }

      if (attempt < MAX_ATTEMPTS) {
        this.log(`   Button "${text}" not found (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in 2s...`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    this.log(`   WARNING: Button "${text}" not found after ${MAX_ATTEMPTS} attempts`);
    return null;
  }

  /**
   * Click an element handle reliably (boundingBox → mouse, fallback to .click())
   * @param {ElementHandle} element
   */
  async _clickElement(element) {
    const box = await element.boundingBox();
    if (box) {
      const x = box.x + box.width / 2 + (Math.random() * 4 - 2);
      const y = box.y + box.height / 2 + (Math.random() * 4 - 2);
      await this.page.mouse.click(x, y);
    } else {
      await element.click();
    }
  }

  /**
   * Extract post ID from URL
   * @param {string} url - Post URL
   * @returns {string|null} Post ID
   */
  extractPostId(url) {
    const match = url.match(/\/item\/(\d+)/);
    return match ? match[1] : null;
  }

  /**
   * Take a screenshot for debugging/review
   * @param {string} name - Screenshot name
   * @returns {string} Screenshot path
   */
  async takeScreenshot(name) {
    try {
      const filename = `${name}_${Date.now()}.png`;
      const filepath = path.join(SCREENSHOTS_DIR, filename);
      const url = this.page.url();
      await this.page.screenshot({ path: filepath, fullPage: true });
      this.log(`Screenshot: ${filename} (url=${url})`);
      return filepath;
    } catch (e) {
      this.err(`Screenshot failed (${name}): ${e.message}`);
      return null;
    }
  }

  /**
   * Release the poster page — do NOT close the shared browser.
   */
  async close() {
    const spId = this.salespersonId || 'default';
    this.log('Releasing poster page...');
    await SharedBrowser.releasePage(spId, 'poster').catch(() => {});
    this.browser = null;
    this.page = null;
    this.log('Poster page released');
  }

  /**
   * Get posting stats
   */
  getStats() {
    return {
      postsToday: this.postsToday,
      maxPostsPerDay: this.maxPostsPerDay,
      lastPostTime: this.lastPostTime ? new Date(this.lastPostTime).toISOString() : null,
      nextPostAvailable: this.lastPostTime
        ? new Date(this.lastPostTime + this.minPostInterval).toISOString()
        : 'now',
      isLoggedIn: this.isLoggedIn
    };
  }
}

/**
 * Post multiple vehicles with rate limiting
 * @param {array} vehicles - Array of vehicles to post
 * @param {object} options - Poster options
 * @returns {object} Results summary
 */
async function postBatch(vehicles, options = {}) {
  const poster = new FacebookPoster(options);
  await poster.init();

  const results = {
    successful: [],
    failed: [],
    skipped: []
  };

  for (const vehicle of vehicles) {
    // Check if already posted
    if (vehicle.listings?.facebook_marketplace?.posted) {
      results.skipped.push({
        vin: vehicle.vin,
        reason: 'Already posted'
      });
      continue;
    }

    const result = await poster.postVehicle(vehicle);

    if (result.success) {
      results.successful.push({
        vin: vehicle.vin,
        postUrl: result.postUrl,
        postedAt: result.postedAt
      });
    } else if (result.status === 'pending_confirmation') {
      results.skipped.push({
        vin: vehicle.vin,
        reason: 'Awaiting confirmation',
        screenshot: result.previewScreenshot
      });
    } else {
      results.failed.push({
        vin: vehicle.vin,
        error: result.error
      });
    }

    // Add extra delay between posts
    await humanDelay(5000, 10000);
  }

  await poster.close();

  return {
    ...results,
    summary: {
      total: vehicles.length,
      posted: results.successful.length,
      failed: results.failed.length,
      skipped: results.skipped.length
    }
  };
}

module.exports = {
  FacebookPoster,
  postBatch,
  humanDelay
};

'use strict';

const cargurus = require('./cargurus');
const carscom = require('./carscom');
const autotrader = require('./autotrader');
const generic = require('./generic');

const PARSERS = {
  CARGURUS: cargurus,
  CARSCOM: carscom,
  AUTOTRADER: autotrader,
  GENERIC_XML: generic,
  HTML_SCRAPE: generic,
};

/**
 * Auto-detect feed type from URL
 */
function detectFeedType(url) {
  const lower = url.toLowerCase();
  if (lower.includes('cargurus.com')) return 'CARGURUS';
  if (lower.includes('cars.com')) return 'CARSCOM';
  if (lower.includes('autotrader')) return 'AUTOTRADER';
  if (lower.endsWith('.xml')) return 'GENERIC_XML';
  return 'HTML_SCRAPE';
}

/**
 * Get parser for feed type
 */
function getParser(feedType) {
  return PARSERS[feedType] || generic;
}

/**
 * Parse a feed URL and return normalized vehicles
 */
async function parseFeed(feedUrl, feedType) {
  const type = feedType || detectFeedType(feedUrl);
  const parser = getParser(type);
  return parser.parse(feedUrl);
}

function parseFeedHtml(html, feedUrl, feedType) {
  const type = feedType || detectFeedType(feedUrl);
  const parser = getParser(type);
  if (typeof parser.parseHtml === 'function') {
    return parser.parseHtml(html, feedUrl);
  }
  // Fallback: use generic HTML parsing
  return generic.parseHtml ? generic.parseHtml(html, feedUrl) : [];
}

module.exports = { detectFeedType, getParser, parseFeed, parseFeedHtml };

'use strict';

/**
 * Verify the drip crawler works in the packaged app:
 * - cheerio is installed and loads
 * - photo extraction logic works correctly
 * - crawler module instantiates
 *
 * Does NOT hit Cars.com (avoids rate limits and network flakes in CI).
 * Uses mock HTML that mirrors a real Cars.com detail page structure.
 */

const MOCK_DETAIL_HTML = `
<html><body>
  <img src="https://platform.cstatic-images.com/xxlarge/in/v2/abc/def/photo1.jpg" />
  <img src="https://platform.cstatic-images.com/xxlarge/in/v2/abc/def/photo2.jpg" />
  <img src="https://platform.cstatic-images.com/xxlarge/in/v2/abc/def/photo3.jpg" />
  <img src="https://platform.cstatic-images.com/large/in/v2/abc/def/photo4.jpg" />
  <img src="https://platform.cstatic-images.com/xxlarge/in/v2/abc/def/photo1.jpg" /><!-- duplicate -->
  <img src="https://platform.cstatic-images.com/static/app-images/logo.png" /><!-- should skip -->
  <img src="https://platform.cstatic-images.com/dealer_media/banner.jpg" /><!-- should skip -->
  <img src="https://platform.cstatic-images.com/icons/thing.svg" /><!-- should skip -->
  <img src="https://other-domain.com/photo.jpg" /><!-- should skip - wrong domain -->
</body></html>
`;

(async () => {
  console.log('--- Drip Crawler Verification ---');

  // 1. cheerio loads
  const cheerio = require('cheerio');
  console.log('✓ cheerio loaded');

  // 2. Photo extraction works correctly
  const $ = cheerio.load(MOCK_DETAIL_HTML);
  const imgs = [];
  const seen = new Set();
  $('img[src*="cstatic-images.com"]').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (!src || seen.has(src)) return;
    if (src.includes('dealer_media')) return;
    if (src.includes('static/app-images')) return;
    if (/\.svg(?:\?|#|$)/i.test(src)) return;
    seen.add(src);
    imgs.push(src);
  });

  if (imgs.length !== 4) {
    throw new Error(`Expected 4 photos, got ${imgs.length}: ${JSON.stringify(imgs)}`);
  }
  console.log(`✓ extracted ${imgs.length} photos (skipped duplicates, SVGs, dealer_media, app-images)`);

  // 3. Crawler module loads and instantiates
  const { FeedDripCrawler } = require('./src/main/feed-drip-crawler');
  const crawler = new FeedDripCrawler();
  console.log('✓ FeedDripCrawler instantiated');

  // 4. Node fetch is available (used by crawler)
  if (typeof fetch !== 'function') {
    throw new Error('Node fetch not available');
  }
  console.log('✓ Node fetch available');

  console.log('--- All tests passed ---');
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});

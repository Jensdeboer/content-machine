'use strict';
// Playwright wrapper: one Chromium, one page per slide, screenshots at
// deviceScaleFactor 2 so a 1080x1350 design lands as 2160x2700.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const INPAGE = require('./inpage');
const { FONTS_DIR, ORIGIN } = require('./html');

const FONT_LOADS = ['800 100px Sora', '700 100px Sora', "400 100px 'IBM Plex Sans'", "italic 300 100px 'IBM Plex Sans'", "500 100px 'IBM Plex Mono'"];

async function launch() {
  const browser = await chromium.launch();
  return {
    browser,
    async newPage(tokens, scale = 2) {
      const page = await browser.newPage({ viewport: { width: tokens.canvas.width, height: tokens.canvas.height }, deviceScaleFactor: scale });
      // Serve the current document and the vendored fonts from one local origin.
      await page.route(`${ORIGIN}/**`, (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === '/slide.html') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: page.__html || '' });
        if (url.pathname.startsWith('/fonts/')) {
          const file = path.join(FONTS_DIR, path.basename(url.pathname));
          if (fs.existsSync(file)) return route.fulfill({ contentType: 'font/ttf', body: fs.readFileSync(file) });
        }
        return route.fulfill({ status: 404, body: '' });
      });
      return page;
    },
    close: () => browser.close(),
  };
}

// Load a full HTML document, wait for fonts and images, inject the in-page lib.
async function show(page, html) {
  page.__html = html;
  await page.goto(`${ORIGIN}/slide.html`, { waitUntil: 'load' });
  await page.evaluate(async (fonts) => {
    await Promise.all(fonts.map((f) => document.fonts.load(f)));
    await document.fonts.ready;
    await Promise.all([...document.images].map((img) => (img.complete ? Promise.resolve() : img.decode().catch(() => {}))));
  }, FONT_LOADS);
  await page.addScriptTag({ content: INPAGE });
}

async function screenshotJpeg(page, file, quality) {
  await page.screenshot({ path: file, type: 'jpeg', quality, fullPage: false, clip: { x: 0, y: 0, width: page.viewportSize().width, height: page.viewportSize().height } });
}

module.exports = { launch, show, screenshotJpeg };

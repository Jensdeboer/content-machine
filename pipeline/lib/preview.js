'use strict';
// A preview-sized copy of a cover, for the morning summary's photo messages.
//
// The renderer writes one size only — 2160x2700, the file that gets posted —
// and the summary wants something to glance at on a phone, not the delivery
// copy. Telegram's sendPhoto re-compresses whatever it is given, so sending
// the full cover spends the upload and gets a twice-compressed picture back.
// Downsizing here costs nothing and keeps the posting copy untouched.
//
// Playwright is already the renderer's dependency (pipeline/render/lib/
// browser.js); the pipeline takes no second one for an image. One Chromium
// for the whole loop: open(), cover() per deck, close().
//
// A preview is a convenience, never a reason a night fails: if Chromium will
// not start or a file will not decode, cover() returns null and the caller
// sends the full-size file instead.
const fs = require('fs');
const os = require('os');
const path = require('path');

const WIDTH = 1080;      // half the rendered width; a phone shows no more
const QUALITY = 0.72;

// Drawn in a canvas rather than screenshotted: no layout, no fonts, no
// viewport, just decode and re-encode at the smaller size.
// Playwright passes one argument into the page, so the three arrive as one
// array. Everything in this function runs in Chromium, not in node.
function downsizeInPage([dataUri, width, quality]) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error('the browser could not decode the cover'));
    img.onload = () => {
      const scale = Math.min(1, width / img.naturalWidth);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.src = dataUri;
  });
}

async function open({ log = () => {} } = {}) {
  let browser = null;
  let page = null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-preview-'));
  const made = [];

  const start = async () => {
    if (page) return page;
    const { chromium } = require('playwright');
    browser = await chromium.launch();
    page = await browser.newPage();
    return page;
  };

  return {
    // The preview file for one cover, or null when it could not be made.
    async cover(file) {
      try {
        const p = await start();
        const uri = `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}`;
        const out = await p.evaluate(downsizeInPage, [uri, WIDTH, QUALITY]);
        const small = path.join(dir, `${path.basename(path.dirname(file))}-${path.basename(file)}`);
        fs.writeFileSync(small, Buffer.from(out.split(',')[1], 'base64'));
        made.push(small);
        return small;
      } catch (e) {
        log(`preview: ${path.basename(file)} not downsized (${e.message}); sending the full-size cover`);
        return null;
      }
    },
    async close() {
      if (browser) await browser.close().catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
      return made.length;
    },
  };
}

module.exports = { open, WIDTH, QUALITY };

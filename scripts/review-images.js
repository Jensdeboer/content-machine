#!/usr/bin/env node
'use strict';
// Throwaway review helper. Sends every image in a directory to the Telegram
// chat as a photo, one message each, captioned with the filename so the
// treatment and sample are readable from the notification.
//
//   node scripts/review-images.js                          # out/test/caption-treatments
//   node scripts/review-images.js out/test/variety/PV-06    # any other folder
//
// Not part of the pipeline: nothing imports it, the nightly never calls it, and
// it writes nothing. It reuses lib/config.js for the credential env NAMES and
// lib/telegram.js for the sending, so no token, chat id or endpoint is repeated
// here. With the credentials unset Telegram.sendPhoto prints instead of sending,
// which is what makes this safe to run dry.
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../pipeline/lib/config');
const { Telegram } = require('../pipeline/lib/telegram');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DIR = path.join(ROOT, 'out', 'test', 'caption-treatments');
const IMAGE = /\.(jpe?g|png|webp)$/i;

// Same .env handling as packet.js: Node reads it natively, no dependency.
function loadEnvFile() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file) || typeof process.loadEnvFile !== 'function') return;
  try { process.loadEnvFile(file); } catch (e) { console.error(`could not read .env: ${e.message}`); }
}

async function main() {
  const arg = process.argv[2];
  const dir = arg ? path.resolve(arg) : DEFAULT_DIR;
  if (!fs.existsSync(dir)) { console.error(`no such directory: ${dir}`); process.exit(1); }

  const files = fs.readdirSync(dir).filter((f) => IMAGE.test(f)).sort()
    .map((f) => path.join(dir, f));
  if (!files.length) { console.error(`no images in ${dir}`); process.exit(1); }

  loadEnvFile();
  const cfg = loadConfig(ROOT, 'pacevector');
  const tg = new Telegram(cfg.telegram);
  console.log(`${files.length} image(s) in ${path.relative(ROOT, dir)}/`);
  console.log(`telegram: ${tg.enabled ? `enabled (${cfg.telegram.tokenEnv}/${cfg.telegram.chatEnv} set)` : `DISABLED — ${cfg.telegram.tokenEnv}/${cfg.telegram.chatEnv} unset, printing instead of sending`}\n`);

  let sent = 0;
  const failed = [];
  for (const file of files) {
    const name = path.basename(file);
    const res = await tg.sendPhoto(file, { caption: name });
    if (res && res.ok) { sent++; console.log(`  sent    ${name}`); }
    else { failed.push({ name, reason: (res && res.reason) || 'unknown' }); console.log(`  FAILED  ${name} — ${(res && res.reason) || 'unknown'}`); }
  }

  console.log(`\n${sent} of ${files.length} sent${failed.length ? `, ${failed.length} failed` : ''}`);
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error(e.stack || e); process.exit(1); });

'use strict';
// Telegram notifier. Credentials come from the env names config.md documents,
// never from the repo. With them unset the run still completes: messages go to
// stdout and are recorded on the run row, because a missing notifier must never
// be the reason a night fails.
//
// This module only ever sends. Reading the bot's updates lives in
// pipeline/inbox.js and nowhere else: two pollers on one bot token silently
// steal each other's updates, so exactly one process reads them, and
// inbox.js asserts at startup that it is the only file that does.
const https = require('https');
const path = require('path');
const fs = require('fs');
const { build, contentTypeFor } = require('./multipart');

class Telegram {
  constructor({ tokenEnv, chatEnv, env = process.env }) {
    this.token = env[tokenEnv];
    this.chatId = env[chatEnv];
    this.enabled = !!(this.token && this.chatId);
    this.sent = [];
    this.tokenEnv = tokenEnv;
    this.chatEnv = chatEnv;
  }

  async send(text) {
    const message = String(text).trim();
    this.sent.push(message);
    if (!this.enabled) return this.offline(message);
    const body = JSON.stringify({ chat_id: this.chatId, text: message, disable_web_page_preview: true });
    return this.call('sendMessage', { 'content-type': 'application/json' }, Buffer.from(body), message);
  }

  // Slides go as documents, never as photos: sendPhoto re-compresses, and the
  // cover is already a jpg, so a photo message would post a twice-compressed
  // cover. A document arrives as the exact file the renderer wrote.
  async sendDocument(file, { caption } = {}) {
    const label = `document ${path.basename(file)}`;
    this.sent.push(label);
    if (!this.enabled) return this.offline(`${label} (${file})`);
    const parts = [
      { name: 'chat_id', value: this.chatId },
      { name: 'disable_content_type_detection', value: 'true' },
      ...(caption ? [{ name: 'caption', value: caption }] : []),
      { name: 'document', filename: path.basename(file), contentType: contentTypeFor(file), data: fs.readFileSync(file) },
    ];
    const { contentType, body } = build(parts);
    return this.call('sendDocument', { 'content-type': contentType }, body, label, 60000);
  }

  // A photo, for the morning summary: preview quality is the point there,
  // one glance per cover. Slides that get posted still go as documents.
  async sendPhoto(file, { caption } = {}) {
    const label = `photo ${path.basename(file)}${caption ? ` "${caption}"` : ''}`;
    this.sent.push(label);
    if (!this.enabled) return this.offline(`${label} (${file})`);
    const parts = [
      { name: 'chat_id', value: this.chatId },
      ...(caption ? [{ name: 'caption', value: caption }] : []),
      { name: 'photo', filename: path.basename(file), contentType: contentTypeFor(file), data: fs.readFileSync(file) },
    ];
    const { contentType, body } = build(parts);
    return this.call('sendPhoto', { 'content-type': contentType }, body, label, 60000);
  }

  offline(what) {
    console.log(`[telegram: ${this.tokenEnv}/${this.chatEnv} unset, not sent]\n${what}`);
    return { ok: false, reason: 'credentials unset', offline: true };
  }

  async call(method, headers, body, what, timeout = 15000) {
    try {
      return await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.telegram.org',
          path: `/bot${this.token}/${method}`,
          method: 'POST',
          timeout,
          headers: { ...headers, 'content-length': body.length },
        }, (res) => {
          let out = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { out += c; });
          res.on('end', () => resolve(res.statusCode === 200 ? { ok: true } : { ok: false, reason: `HTTP ${res.statusCode}: ${out.slice(0, 200)}` }));
        });
        req.on('timeout', () => req.destroy(new Error(`telegram timeout after ${timeout}ms`)));
        req.on('error', reject);
        req.end(body);
      });
    } catch (e) {
      console.log(`[telegram failed: ${e.message}]\n${what}`);
      return { ok: false, reason: e.message };
    }
  }
}

module.exports = { Telegram };

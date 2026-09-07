'use strict';
// Telegram notifier. Credentials come from the env names config.md documents,
// never from the repo. With them unset the run still completes: messages go to
// stdout and are recorded on the run row, because a missing notifier must never
// be the reason a night fails.
const https = require('https');

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
    if (!this.enabled) {
      console.log(`[telegram: ${this.tokenEnv}/${this.chatEnv} unset, not sent]\n${message}`);
      return { ok: false, reason: 'credentials unset' };
    }
    const body = JSON.stringify({ chat_id: this.chatId, text: message, disable_web_page_preview: true });
    try {
      return await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.telegram.org',
          path: `/bot${this.token}/sendMessage`,
          method: 'POST',
          timeout: 15000,
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        }, (res) => {
          let out = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { out += c; });
          res.on('end', () => resolve(res.statusCode === 200 ? { ok: true } : { ok: false, reason: `HTTP ${res.statusCode}: ${out.slice(0, 200)}` }));
        });
        req.on('timeout', () => req.destroy(new Error('telegram timeout')));
        req.on('error', reject);
        req.end(body);
      });
    } catch (e) {
      console.log(`[telegram failed: ${e.message}]\n${message}`);
      return { ok: false, reason: e.message };
    }
  }
}

module.exports = { Telegram };

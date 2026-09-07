#!/usr/bin/env node
'use strict';
// Did the nightly run at all?
//
//   node pipeline/deadman.js pacevector
//
// Every other alarm in the pipeline is raised by something that ran. This one
// covers the case nothing raises: the run that never started, because cron was
// not running, the box was down, or the crontab was lost. A silent night looks
// exactly like a night with nothing to say.
//
// It sends nothing itself. It prints the reason and exits non-zero, and
// pipeline/cron.sh turns that into the Telegram alert with the last 20 log
// lines, so there is one alert path on the box rather than two.
const path = require('path');

const { loadConfig } = require('./lib/config');
const { State } = require('./lib/db');

const ROOT = path.resolve(__dirname, '..');

// The local calendar date, which is the one the schedule is written in:
// state.db stores UTC, and 02:00 in Amsterdam is the day before in UTC for
// half the year.
const localDate = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function main() {
  const brand = process.argv[2];
  if (!brand) {
    console.error('usage: node pipeline/deadman.js <brand>   e.g. node pipeline/deadman.js pacevector');
    process.exit(2);
  }

  const cfg = loadConfig(ROOT, brand);
  const state = new State(path.join(ROOT, cfg.run.stateDb));
  const today = localDate(new Date());
  const runs = state.recentRuns(brand, 20);
  const todays = runs.filter((r) => localDate(new Date(r.started_at)) === today);
  state.close();

  if (!todays.length) {
    const last = runs[0];
    console.error(`${brand}: no run row for ${today}. The nightly did not start.`);
    console.error(last
      ? `The last run was ${last.started_at} (${last.status}).`
      : 'There is no run row at all in state.db.');
    console.error('Check that cron is running and that the crontab is installed: systemctl status cron, crontab -l.');
    process.exit(1);
  }

  // A run that started and failed has already sent its own Telegram; the
  // deadman only answers whether one happened.
  const r = todays[todays.length - 1];
  console.log(`${brand}: run ${r.id} started ${r.started_at} (${r.status}${r.finished_at ? `, finished ${r.finished_at}` : ', still running'}).`);
  process.exit(0);
}

if (require.main === module) main();

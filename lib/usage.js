'use strict';
// Opt-in usage count. Off unless you say yes (stet init asks once, or: stet telemetry on).
// When on, at most once a day it sends: a random install ID, the Stet version, the command name and the OS.
// Never your code, file names, repo name, paths, git data or anything you type.
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const DAY = 24 * 60 * 60 * 1000;
const APP = '6af6a6272aa6ecc48fe08a58';
const URL_ = () => process.env.STET_USAGE_URL || `https://getstet.dev/api/apps/${APP}/entities/UsagePing`;
const file = () => path.join(process.env.STET_CONFIG_DIR || path.join(os.homedir(), '.config', 'stet'), 'usage.json');
const read = () => { try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return {}; } };
const write = (o) => { try { fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(o, null, 2) + '\n'); } catch {} };

// Environment always wins: these turn it off whatever was chosen.
function blocked() {
  const e = process.env;
  return !!(['0', 'false', 'off'].includes(String(e.STET_TELEMETRY || '').toLowerCase()) || e.DO_NOT_TRACK === '1' || e.CI || e.CONTINUOUS_INTEGRATION || e.GITHUB_ACTIONS);
}
const enabled = () => !blocked() && read().enabled === true;
const undecided = () => read().enabled === undefined;

function set(on) {
  const cur = read();
  write({ ...cur, enabled: !!on, id: on ? cur.id || crypto.randomUUID() : undefined, decidedAt: new Date().toISOString() });
}

// What gets sent, so `stet telemetry` can show it exactly.
function payload(cmd, version) {
  return { install_id: read().id || '(created when you turn it on)', version, command: String(cmd || '').slice(0, 30), os: process.platform };
}

function post(body, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let u; try { u = new URL(URL_()); } catch { return resolve(false); }
    const data = JSON.stringify(body);
    const lib = u.protocol === 'http:' ? require('http') : https;
    const req = lib.request(u, { method: 'POST', timeout: timeoutMs, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-app-id': APP } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode < 300)); });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end(data);
  });
}

// Called after a command. Never throws, never slows a command by more than the short timeout.
async function ping(cmd, version) {
  try {
    if (!enabled()) return false;
    const cur = read();
    if (cur.lastPing && Date.now() - cur.lastPing < DAY) return false;
    write({ ...cur, lastPing: Date.now() });
    return await post(payload(cmd, version));
  } catch { return false; }
}

// stet init asks once, only a person at a terminal.
async function askOnce(c, { interactive } = {}) {
  const tty = interactive !== undefined ? interactive : !!(process.stdout.isTTY && process.stdin.isTTY);
  if (!tty || blocked() || !undecided()) return null;
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise((resolve) => rl.question(
    `\n${c.bold('One question.')} Stet is built by one developer. Help him count real users?\n` +
    `  Once a day it would send a random ID, the Stet version, the command name and your OS. Never code, file names or repo data.\n` +
    `  Share anonymous usage? ${c.dim('[y/N]')} `, (x) => { rl.close(); resolve(String(x || '').trim().toLowerCase()); }));
  const yes = a === 'y' || a === 'yes';
  set(yes);
  return yes;
}

function status(c, version) {
  const on = enabled(), why = blocked() ? ' (turned off by STET_TELEMETRY, DO_NOT_TRACK or CI)' : '';
  return [`Anonymous usage count: ${on ? c.green('on') : c.dim('off')}${why}`,
    on ? c.dim(`  Sends at most once a day: ${JSON.stringify(payload('<command>', version))}`) : c.dim('  Nothing is sent.'),
    c.dim(`  Change it: stet telemetry ${on ? 'off' : 'on'}   ·   Always off: STET_TELEMETRY=0`)].join('\n');
}

module.exports = { ping, askOnce, set, enabled, blocked, undecided, status, payload, post };

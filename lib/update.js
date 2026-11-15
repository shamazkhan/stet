'use strict';
// Update notice: at most one npm lookup a day, only for a person at a terminal.
// Sends nothing about your code or repo: it is the same request as `npm view stet-cli version`.
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const cp = require('child_process');

const DAY = 24 * 60 * 60 * 1000;
const cacheFile = () => path.join(process.env.STET_CONFIG_DIR || path.join(os.homedir(), '.config', 'stet'), 'update.json');
const readCache = () => { try { return JSON.parse(fs.readFileSync(cacheFile(), 'utf8')); } catch { return {}; } };
const writeCache = (o) => { try { fs.mkdirSync(path.dirname(cacheFile()), { recursive: true }); fs.writeFileSync(cacheFile(), JSON.stringify(o) + '\n'); } catch {} };

// 1.2.10 > 1.2.9; pre-releases ("0.7.0-beta.1") are never offered.
function newer(a, b) {
  if (!a || /-/.test(a)) return false;
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}

function fetchLatest(timeoutMs = 1500) {
  if (process.env.STET_TEST_LATEST) return Promise.resolve(process.env.STET_TEST_LATEST); // tests only
  return new Promise((resolve) => {
    const req = https.get('https://registry.npmjs.org/stet-cli/latest', { timeout: timeoutMs, headers: { accept: 'application/json' } }, (res) => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy(); });
      res.on('end', () => { try { resolve(JSON.parse(body).version || null); } catch { resolve(null); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

function disabled(fl = {}) {
  const e = process.env;
  return !!(e.STET_NO_UPDATE_CHECK || e.NO_UPDATE_NOTIFIER || e.CI || e.CONTINUOUS_INTEGRATION || e.GITHUB_ACTIONS || fl['no-update-check'] || fl.json);
}

// How was this copy started? npx copies are thrown away, so "update" means "use @latest next time".
function viaNpx() { return /[\\/]_npx[\\/]/.test(__dirname) || process.env.npm_command === 'exec'; }

// Latest known version: cached for a day, refreshed with a short timeout. Never throws.
async function latest({ force } = {}) {
  const cache = readCache();
  if (!force && cache.checkedAt && Date.now() - cache.checkedAt < DAY) return { latest: cache.latest, cache };
  const v = await fetchLatest();
  const next = { ...cache, checkedAt: Date.now(), latest: v || cache.latest || null };
  writeCache(next);
  return { latest: next.latest, cache: next };
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); resolve(String(a || '').trim().toLowerCase()); });
  });
}

function install(log) {
  log('Running: npm install -g stet-cli@latest');
  const p = cp.spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '-g', 'stet-cli@latest'], { stdio: 'inherit' });
  if (p.status === 0) { log('✓ Updated. Run stet --version to confirm.'); return true; }
  log(`✗ The update didn't finish. If it was a permissions error, run: sudo npm install -g stet-cli@latest`);
  return false;
}

// Called after every command. Prints at most one notice and asks once per new version.
async function notify(current, { fl = {}, c, interactive } = {}) {
  if (disabled(fl)) return;
  const tty = interactive !== undefined ? interactive : !!(process.stdout.isTTY && process.stdin.isTTY);
  if (!tty) return;
  const { latest: v, cache } = await latest();
  if (!newer(v, current)) return;
  const log = (s) => process.stderr.write(s + '\n');
  const line = `${c.yellow('!')} Stet ${c.bold(v)} is available (you have ${current}). What's new: ${c.cyan('getstet.dev/changelog')}`;
  if (viaNpx()) { log(line + c.dim(`\n  You're running through npx: use ${c.cyan('npx stet-cli@latest')} to get it.`)); return; }
  if (cache.askedFor === v) {
    if (!cache.remindedAt || Date.now() - cache.remindedAt > DAY) { log(line + c.dim('  Update: stet update')); writeCache({ ...cache, remindedAt: Date.now() }); }
    return;
  }
  log(line);
  writeCache({ ...cache, askedFor: v, remindedAt: Date.now() });
  const a = await ask(`  Update now? ${c.dim('[y/N]')} `);
  if (a === 'y' || a === 'yes') install(log);
  else log(c.dim('  Skipped. Update any time with: stet update   (stop these checks: STET_NO_UPDATE_CHECK=1)'));
}

// `stet update`: check now and install if there is something newer.
async function update(current, { c, yes } = {}) {
  const { latest: v } = await latest({ force: true });
  if (!v) return { code: 1, text: `${c.yellow('!')} Couldn't reach npm to check for updates. Try again, or run: npm install -g stet-cli@latest` };
  if (!newer(v, current)) return { code: 0, text: `${c.green('✓')} You're on the latest Stet (${current}).` };
  if (viaNpx()) return { code: 0, text: `${c.yellow('!')} Stet ${v} is available. You're running through npx, so use: npx stet-cli@latest` };
  const log = (s) => process.stderr.write(s + '\n');
  log(`${c.yellow('!')} Stet ${c.bold(v)} is available (you have ${current}). What's new: ${c.cyan('getstet.dev/changelog')}`);
  const go = yes || (process.stdin.isTTY && ['y', 'yes'].includes(await ask(`  Update now? ${c.dim('[y/N]')} `)));
  if (!go) return { code: 0, text: c.dim('Not updated. Run: npm install -g stet-cli@latest') };
  return { code: install(log) ? 0 : 1, text: '' };
}

// For `stet status`: what we know without a network call.
function cachedLatest() { return readCache().latest || null; }

module.exports = { notify, update, latest, newer, cachedLatest, fetchLatest, disabled };

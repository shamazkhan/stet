'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { PassThrough } = require('stream');

const BIN = path.join(__dirname, '..', 'bin', 'stet.js');
const core = require('../lib/core');

function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stet-'));
  const g = (...a) => cp.execFileSync('git', a, { cwd: d });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 'T');
  fs.mkdirSync(path.join(d, 'src/auth'), { recursive: true }); fs.mkdirSync(path.join(d, 'src/export'), { recursive: true });
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node -e "process.exit(0)"', dev: 'node .' }, dependencies: { express: '1' } }));
  fs.writeFileSync(path.join(d, 'src/auth/login.js'), 'module.exports = () => true;\n');
  fs.writeFileSync(path.join(d, 'src/export/csv.js'), '// todo\n');
  fs.writeFileSync(path.join(d, '.env.example'), 'DATABASE_URL=\nSTRIPE_KEY=\n');
  g('add', '-A'); g('commit', '-qm', 'initial');
  return { d, g };
}
const stet = (d, ...a) => { const p = cp.spawnSync(process.execPath, [BIN, ...a, '--no-color'], { cwd: d, encoding: 'utf8' }); return { out: p.stdout + p.stderr, code: p.status }; };

test('glob matching', () => {
  assert.ok(core.matches('src/auth/login.js', ['src/auth/**']));
  assert.ok(core.matches('src/auth/a/b.ts', ['src/**/*.ts']));
  assert.ok(core.matches('src/a.ts', ['src/**/*.ts']));
  assert.ok(core.matches('migrations/001.sql', ['migrations']));
  assert.ok(core.matches('README.md', ['*.md']));
  assert.ok(!core.matches('docs/README.md', ['*.md']));
  assert.ok(!core.matches('src/billing/x.js', ['src/auth/**']));
});

test('init detects stack and writes AGENTS.md + CLAUDE.md', () => {
  const { d } = repo();
  const r = stet(d, 'init', '--name', 'Demo');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /JavaScript, Express/);
  const agents = fs.readFileSync(path.join(d, 'AGENTS.md'), 'utf8');
  assert.match(agents, /Working agreement for AI coding agents — Demo/);
  assert.match(agents, /\| L1 \| Full test suite passes \| `npm test`/);
  assert.match(fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf8'), /@AGENTS\.md/);
  // idempotent and preserves user text outside the block
  fs.appendFileSync(path.join(d, 'AGENTS.md'), '\n## My own notes\nkeep me\n');
  assert.strictEqual(stet(d, 'init').code, 0);
  stet(d, 'decide', 'Use Postgres', '--why', 'relational data');
  const a2 = fs.readFileSync(path.join(d, 'AGENTS.md'), 'utf8');
  assert.match(a2, /keep me/); assert.match(a2, /D-002\*\* \(.*\) Use Postgres/);
});

test('scope + guard catches drift across commits and protected paths', () => {
  const { d, g } = repo();
  stet(d, 'init');
  assert.strictEqual(stet(d, 'scope', 'set', 'CSV export', '--allow', 'src/export/**').code, 0);
  fs.writeFileSync(path.join(d, 'src/export/csv.js'), 'module.exports = 1;\n');
  let r = stet(d, 'guard');
  assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /All changes are inside scope/);
  // agent "helpfully" edits auth and commits it: still caught because guard compares to scope base
  fs.writeFileSync(path.join(d, 'src/auth/login.js'), 'module.exports = () => false;\n');
  g('add', '-A'); g('commit', '-qm', 'agent refactor');
  r = stet(d, 'guard');
  assert.strictEqual(r.code, 1, r.out); assert.match(r.out, /src\/auth\/login\.js\s+out of scope/);
  assert.strictEqual(stet(d, 'guard', '--warn').code, 0);
  // protected path
  const cfg = JSON.parse(fs.readFileSync(path.join(d, '.stet/config.json')));
  cfg.protect = ['src/export/**']; fs.writeFileSync(path.join(d, '.stet/config.json'), JSON.stringify(cfg));
  r = stet(d, 'guard'); assert.match(r.out, /src\/export\/csv\.js\s+protected/);
});

test('locks: check passes, then catches a regression', () => {
  const { d } = repo();
  stet(d, 'init');
  fs.writeFileSync(path.join(d, 'check-login.js'), 'process.exit(require("./src/auth/login.js")() ? 0 : 1)');
  let r = stet(d, 'lock', 'add', 'Login works', '--cmd', 'node check-login.js', '--protect', 'src/auth/**');
  assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /Locked L2/);
  r = stet(d, 'check'); assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /All locked behaviours pass/);
  fs.writeFileSync(path.join(d, 'src/auth/login.js'), 'module.exports = () => false;\n');
  r = stet(d, 'check'); assert.strictEqual(r.code, 1); assert.match(r.out, /✗ L2/); assert.match(r.out, /Fix the change, not the check/);
  r = stet(d, 'guard'); assert.match(r.out, /affects L2/);
  r = stet(d, 'lock', 'list'); assert.match(r.out, /✗ L2/);
  assert.match(stet(d, 'lock', 'rm', 'L2').out, /Removed L2/);
  stet(d, 'lock', 'add', 'Bad lock', '--cmd', 'npm run nope');
  r = stet(d, 'check', '--only', 'L2,L3'); assert.strictEqual(r.code, 1); assert.match(r.out, /proof command itself can't run/); assert.doesNotMatch(r.out, /Fix the change/);
});

test('context pack is git-synced and includes requested files', () => {
  const { d } = repo();
  stet(d, 'init');
  stet(d, 'scope', 'set', 'CSV export', '--allow', 'src/export/**');
  fs.writeFileSync(path.join(d, 'src/export/csv.js'), 'export const toCsv = rows => rows.join("\\n");\n');
  const r = stet(d, 'context', '--stdout', '--files', 'src/auth/**', '--changed', '--diff');
  assert.strictEqual(r.code, 0, r.out);
  for (const re of [/# Context pack/, /branch `main`/, /\*\*Task:\*\* CSV export/, /### src\/auth\/login\.js/, /### src\/export\/csv\.js/, /```diff/, /toCsv/, /initial/, /src\/\n  auth\//]) assert.match(r.out, re);
  assert.doesNotMatch(r.out, /node_modules/);
});

test('handoff pack', () => {
  const { d } = repo();
  stet(d, 'init', '--name', 'Demo');
  stet(d, 'decide', 'Server-rendered pages, no SPA', '--why', 'small team, SEO');
  const r = stet(d, 'handoff', '--stdout');
  for (const re of [/# Handoff — Demo/, /DATABASE_URL/, /STRIPE_KEY/, /npm run dev/, /D-002 · .* · Server-rendered/, /small team, SEO/, /`src\/` \| 2/, /First day checklist/]) assert.match(r.out, re);
});

test('pre-commit hook blocks out-of-scope commits', () => {
  const { d, g } = repo();
  stet(d, 'init');
  stet(d, 'scope', 'set', 'CSV export', '--allow', 'src/export/**');
  assert.match(stet(d, 'hook', 'install').out, /hook installed/);
  // make `stet` resolvable inside the hook
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stetbin-'));
  fs.writeFileSync(path.join(binDir, 'stet'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: binDir + path.delimiter + process.env.PATH };
  fs.writeFileSync(path.join(d, 'src/auth/login.js'), 'x\n');
  g('add', '-A');
  const p = cp.spawnSync('git', ['commit', '-qm', 'sneaky'], { cwd: d, env, encoding: 'utf8' });
  assert.notStrictEqual(p.status, 0); assert.match(p.stdout + p.stderr, /commit blocked/);
  assert.match(stet(d, 'hook', 'uninstall').out, /Removed/);
});

test('MCP server: initialize, list, call', async () => {
  const { d } = repo();
  stet(d, 'init');
  process.env.STET_ROOT = d;
  const mcp = require('../lib/mcp');
  const inp = new PassThrough(), outp = new PassThrough();
  const got = [];
  outp.on('data', (b) => String(b).split('\n').filter(Boolean).forEach((l) => got.push(JSON.parse(l))));
  mcp.serve(inp, outp);
  inp.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) + '\n');
  inp.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  inp.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  inp.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'stet_context', arguments: {} } }) + '\n');
  inp.write(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'stet_decide', arguments: { decision: 'Keep REST', why: 'clients' } } }) + '\n');
  inp.write(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'stet_check', arguments: {} } }) + '\n');
  await new Promise((res) => setTimeout(res, 1500));
  const by = (id) => got.find((m) => m.id === id);
  assert.strictEqual(by(1).result.serverInfo.name, 'stet');
  assert.strictEqual(got.filter((m) => m.id === undefined).length, 0);
  assert.deepStrictEqual(by(2).result.tools.map((t) => t.name), ['stet_context', 'stet_guard', 'stet_check', 'stet_scope', 'stet_decide']);
  assert.match(by(3).result.content[0].text, /# Context pack/);
  assert.doesNotMatch(by(3).result.content[0].text, /\x1b\[/);
  assert.match(by(4).result.content[0].text, /Logged D-002/);
  assert.strictEqual(by(5).result.isError, false);
  inp.end();
});

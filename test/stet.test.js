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
  assert.match(stet(d, 'hook', 'install').out, /hooks installed/);
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
  assert.deepStrictEqual(by(2).result.tools.map((t) => t.name), ['stet_context', 'stet_guard', 'stet_check', 'stet_scope', 'stet_pr', 'stet_study', 'stet_decide']);
  assert.match(by(3).result.content[0].text, /# Context pack/);
  assert.doesNotMatch(by(3).result.content[0].text, /\x1b\[/);
  assert.match(by(4).result.content[0].text, /Logged D-002/);
  assert.strictEqual(by(5).result.isError, false);
  inp.end();
});

test('detects Python and JS in subfolders (monorepo)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stet-mono-'));
  const g = (...a) => cp.execFileSync('git', a, { cwd: d });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 'T');
  fs.mkdirSync(path.join(d, 'backend/tests'), { recursive: true }); fs.mkdirSync(path.join(d, 'frontend/src'), { recursive: true });
  fs.writeFileSync(path.join(d, 'backend/requirements.txt'), 'fastapi==0.110\npytest\n');
  fs.writeFileSync(path.join(d, 'backend/main.py'), 'print(1)\n');
  fs.writeFileSync(path.join(d, 'frontend/package.json'), JSON.stringify({ name: 'web', scripts: { test: 'vitest run', build: 'vite build' }, dependencies: { react: '18' }, devDependencies: { typescript: '5', vite: '5' } }));
  fs.writeFileSync(path.join(d, 'docker-compose.yml'), 'services: {}\n');
  g('add', '-A'); g('commit', '-qm', 'init');
  const r = stet(d, 'init');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /Python \(backend\/\)/); assert.match(r.out, /TypeScript \(frontend\/\)/); assert.match(r.out, /FastAPI/); assert.match(r.out, /Docker/);
  const locks = JSON.parse(fs.readFileSync(path.join(d, '.stet/locks.json')));
  assert.deepStrictEqual(locks.map((l) => l.cmd), ['cd backend && pytest -q', 'cd frontend && npm test']);
  assert.match(locks[0].name, /backend\//);
});

test('falls back to file extensions when no manifest', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stet-ext-'));
  const g = (...a) => cp.execFileSync('git', a, { cwd: d });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 'T');
  fs.writeFileSync(path.join(d, 'package.json'), '{"name":"x","dependencies":{"express":"4"}}');
  fs.mkdirSync(path.join(d, 'scripts'));
  for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(d, `scripts/${n}.py`), 'x=1\n');
  g('add', '-A'); g('commit', '-qm', 'init');
  const r = stet(d, 'init');
  assert.match(r.out, /JavaScript, Python, Express/);
});

test('ticket ID: picked up from the task or --ticket, shown in AGENTS.md and scope', () => {
  const { d } = repo();
  stet(d, 'init');
  let r = stet(d, 'scope', 'set', 'LIN-142 Add CSV export', '--allow', 'src/export/**');
  assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /LIN-142 Add CSV export/);
  const sc = JSON.parse(fs.readFileSync(path.join(d, '.stet/scope.json')));
  assert.strictEqual(sc.ticket, 'LIN-142'); assert.strictEqual(sc.task, 'Add CSV export');
  assert.match(fs.readFileSync(path.join(d, 'AGENTS.md'), 'utf8'), /\*\*Ticket:\*\* LIN-142/);
  assert.strictEqual(stet(d, 'scope', 'ticket').out.trim(), 'LIN-142');
  r = stet(d, 'scope', 'set', 'Fix rounding', '--allow', 'src/**', '--ticket', 'eng-7');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(d, '.stet/scope.json'))).ticket, 'ENG-7');
  assert.strictEqual(stet(d, 'scope', 'set', 'X', '--allow', 'src/**', '--ticket', 'nope').code, 1);
});

test('stet pr: commit message and PR text from diff, scope, checks and decisions', () => {
  const { d, g } = repo();
  stet(d, 'init');
  stet(d, 'scope', 'set', 'LIN-142 Add CSV export', '--allow', 'src/export/**,test/**');
  fs.writeFileSync(path.join(d, 'src/export/csv.js'), 'module.exports = (rows) => rows.join("\\n");\n');
  fs.mkdirSync(path.join(d, 'test'), { recursive: true });
  fs.writeFileSync(path.join(d, 'test/csv.test.js'), 'a\nb\n');
  g('add', 'src/export/csv.js'); g('commit', '-qm', 'wip');
  stet(d, 'decide', 'CSV uses comma separator', '--why', 'Excel default');
  let r = stet(d, 'pr', '--check', '--stdout');
  assert.strictEqual(r.code, 0, r.out);
  for (const re of [/## LIN-142: Add CSV export/, /\| `src\/export\/csv\.js` \| modified \|/, /\| `test\/csv\.test\.js` \| added \| \+2 −0 \|/, /✅ All changes are inside the agreed scope/, /✅ \*\*L1\*\* Full test suite passes/, /\*\*D-002\*\* CSV uses comma separator — Excel default/]) assert.match(r.out, re);
  assert.doesNotMatch(r.out, /AGENTS\.md|\.stet\//);
  const commit = fs.readFileSync(path.join(d, '.stet/.cache/commit.txt'), 'utf8');
  assert.match(commit, /^LIN-142: Add CSV export\n\n- update src\/export\/csv\.js\n- add test\/csv\.test\.js\n$/);
  // out-of-scope change is reported, not hidden
  fs.writeFileSync(path.join(d, 'src/auth/login.js'), 'x\n');
  r = stet(d, 'pr', '--stdout');
  assert.match(r.out, /⚠️ 1 file is outside the agreed scope/); assert.match(r.out, /- `src\/auth\/login\.js`/);
});

test('stet pr without a check run says so', () => {
  const { d } = repo();
  stet(d, 'init');
  stet(d, 'scope', 'set', 'Tidy', '--allow', 'src/**');
  const r = stet(d, 'pr', '--stdout');
  assert.match(r.out, /`stet check` has not been run/);
  assert.match(r.out, /## Tidy/);
});

test('prepare-commit-msg hook adds the ticket ID once', () => {
  const { d, g } = repo();
  stet(d, 'init');
  stet(d, 'scope', 'set', 'LIN-9 Export', '--allow', 'src/export/**');
  stet(d, 'hook', 'install');
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stetbin-'));
  fs.writeFileSync(path.join(binDir, 'stet'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: binDir + path.delimiter + process.env.PATH };
  const commit = (m) => { const p = cp.spawnSync('git', ['commit', '-qm', m], { cwd: d, env, encoding: 'utf8' }); assert.strictEqual(p.status, 0, p.stderr); return cp.execFileSync('git', ['log', '-1', '--format=%s'], { cwd: d, encoding: 'utf8' }).trim(); };
  fs.writeFileSync(path.join(d, 'src/export/csv.js'), '1\n'); g('add', '-A');
  assert.strictEqual(commit('Add export'), 'LIN-9: Add export');
  fs.writeFileSync(path.join(d, 'src/export/csv.js'), '2\n'); g('add', '-A');
  assert.strictEqual(commit('LIN-9: tweak'), 'LIN-9: tweak');
  assert.match(stet(d, 'hook', 'uninstall').out, /Removed/);
  assert.doesNotMatch(fs.readFileSync(path.join(d, '.git/hooks/prepare-commit-msg'), 'utf8'), /stet/);
});

// ---- Linear (against a local fake Linear API) ----
const http = require('http');
function fakeLinear() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ auth: req.headers.authorization, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.headers.authorization !== 'lin_api_test') { res.statusCode = 401; return res.end('{}'); }
      const id = JSON.parse(body).variables.id;
      if (id !== 'LIN-142') return res.end(JSON.stringify({ data: { issue: null }, errors: [{ message: 'Entity not found' }] }));
      res.end(JSON.stringify({ data: { issue: {
        identifier: 'LIN-142', title: 'Add CSV export of invoices', url: 'https://linear.app/acme/issue/LIN-142',
        description: 'Customers need to export invoices to CSV.\n\n- Include net, VAT and gross\n- Do not change VAT rounding',
        priorityLabel: 'High', state: { name: 'In Progress' }, assignee: { name: 'Shamaz' }, project: null, labels: { nodes: [{ name: 'feature' }] },
      } } }));
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, calls, url: `http://127.0.0.1:${server.address().port}/graphql` })));
}
function stetEnv(d, env, ...a) {
  return new Promise((ok) => {
    const p = cp.spawn(process.execPath, [BIN, ...a, '--no-color'], { cwd: d, env: { ...process.env, ...env } });
    let out = ''; p.stdout.on('data', (b) => (out += b)); p.stderr.on('data', (b) => (out += b));
    p.on('close', (code) => ok({ out, code }));
  });
}

test('Linear: scope set LIN-142 fetches the ticket into context and PR', async () => {
  const L = await fakeLinear();
  try {
    const { d } = repo();
    stet(d, 'init');
    const env = { LINEAR_API_KEY: 'lin_api_test', STET_LINEAR_URL: L.url };
    let r = await stetEnv(d, env, 'scope', 'set', 'LIN-142', '--allow', 'src/export/**');
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /LIN-142 Add CSV export of invoices/); assert.match(r.out, /Linear: Add CSV export of invoices · In Progress/);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(d, '.stet/scope.json'))).task, 'Add CSV export of invoices');
    assert.ok(fs.existsSync(path.join(d, '.stet/.cache/tickets/LIN-142.json')));
    assert.match(L.calls[0].body, /"id":"LIN-142"/); assert.doesNotMatch(L.calls[0].body, /login|module\.exports/); // only the ID is sent
    r = await stetEnv(d, {}, 'context', '--stdout');
    assert.match(r.out, /## Ticket LIN-142: Add CSV export of invoices/); assert.match(r.out, /Do not change VAT rounding/); assert.match(r.out, /Status: In Progress · Priority: High/);
    r = await stetEnv(d, {}, 'pr', '--stdout');
    assert.match(r.out, /\*\*Ticket:\*\* \[LIN-142\]\(https:\/\/linear\.app\/acme\/issue\/LIN-142\)/);
    r = await stetEnv(d, env, 'ticket');
    assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /LIN-142 Add CSV export of invoices/); assert.match(r.out, /included in stet context/);
  } finally { L.server.close(); }
});

test('Linear: clear errors, and scope still works when Linear fails', async () => {
  const L = await fakeLinear();
  try {
    const { d } = repo();
    stet(d, 'init');
    let r = await stetEnv(d, { LINEAR_API_KEY: 'lin_api_test', STET_LINEAR_URL: L.url }, 'ticket', 'LIN-999');
    assert.strictEqual(r.code, 1); assert.match(r.out, /LIN-999: Entity not found/);
    r = await stetEnv(d, { LINEAR_API_KEY: 'wrong', STET_LINEAR_URL: L.url }, 'ticket', 'LIN-142');
    assert.strictEqual(r.code, 1); assert.match(r.out, /rejected the API key/);
    r = await stetEnv(d, { LINEAR_API_KEY: '' }, 'ticket', 'LIN-142');
    assert.strictEqual(r.code, 1); assert.match(r.out, /LINEAR_API_KEY is not set/);
    r = await stetEnv(d, { LINEAR_API_KEY: 'wrong', STET_LINEAR_URL: L.url }, 'scope', 'set', 'LIN-142 Export', '--allow', 'src/**');
    assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /Linear: .*\(scope set anyway\)/);
  } finally { L.server.close(); }
});

// ---- snapshot locks ----
test('snapshot lock: approve, catch a change, approve on purpose, mask volatile output', () => {
  const { d } = repo();
  stet(d, 'init');
  fs.writeFileSync(path.join(d, 'export.js'), 'console.log("id,net,vat\\n1,100,5\\nrun " + Date.now());\n');
  let r = stet(d, 'lock', 'add', 'Export format is stable', '--snapshot', 'node export.js', '--mask', 'run \\d+', '--protect', 'export.js');
  assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /snapshot of node export\.js/);
  assert.strictEqual(fs.readFileSync(path.join(d, '.stet/snapshots/L2.txt'), 'utf8'), 'id,net,vat\n1,100,5\n<masked>\n');
  r = stet(d, 'check', '--only', 'L2'); assert.strictEqual(r.code, 0, r.out);
  assert.match(fs.readFileSync(path.join(d, 'AGENTS.md'), 'utf8'), /must match the approved snapshot/);
  // behaviour change: column order
  fs.writeFileSync(path.join(d, 'export.js'), 'console.log("id,vat,net\\n1,5,100\\nrun " + Date.now());\n');
  r = stet(d, 'check', '--only', 'L2');
  assert.strictEqual(r.code, 1); assert.match(r.out, /- id,net,vat/); assert.match(r.out, /\+ id,vat,net/); assert.match(r.out, /stet lock approve L2/);
  // intended change
  r = stet(d, 'lock', 'approve', 'L2', '--why', 'VAT before net, PRO-91');
  assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /Approved new output for L2/);
  assert.strictEqual(stet(d, 'check', '--only', 'L2').code, 0);
  assert.match(fs.readFileSync(path.join(d, '.stet/decisions.md'), 'utf8'), /Approved new snapshot for L2 Export format is stable\nVAT before net, PRO-91/);
  assert.match(stet(d, 'lock', 'list').out, /L2 +Export format is stable  \[snapshot\]/);
});

test('snapshot lock: guard flags hand-edited snapshots; bad commands are refused', () => {
  const { d } = repo();
  stet(d, 'init');
  fs.writeFileSync(path.join(d, 'routes.js'), 'console.log("GET /invoices\\nPOST /export");\n');
  stet(d, 'lock', 'add', 'API routes unchanged', '--snapshot', 'node routes.js');
  assert.match(stet(d, 'guard').out, /All changes are inside scope|No changes yet/);
  fs.appendFileSync(path.join(d, '.stet/snapshots/L2.txt'), 'GET /sneaky\n');
  const g = stet(d, 'guard');
  assert.strictEqual(g.code, 1); assert.match(g.out, /\.stet\/snapshots\/L2\.txt  edited outside stet lock approve/);
  assert.strictEqual(stet(d, 'lock', 'add', 'Bad', '--snapshot', 'node -e "process.exit(3)"').code, 1);
  assert.match(stet(d, 'lock', 'add', 'Empty', '--snapshot', 'node -e ""').out, /printed nothing/);
  assert.match(stet(d, 'lock', 'approve', 'L1').out, /command lock, not a snapshot/);
});

// ---- stet study ----
function reconRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stet-study-'));
  const g = (...a) => cp.execFileSync('git', a, { cwd: d });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 'T');
  const w = (f, t) => { fs.mkdirSync(path.join(d, path.dirname(f)), { recursive: true }); fs.writeFileSync(path.join(d, f), t); };
  w('package.json', '{"name":"r","dependencies":{"express":"4"}}');
  w('src/money/round.js', 'const round2 = (x) => Math.round(x * 100) / 100;\nmodule.exports = { round2 };\n');
  w('src/recon/rules.js', 'function isMatch(b, l) { return b.amount === l.amount; }\nmodule.exports = { isMatch };\n');
  w('src/recon/engine.js', "const { isMatch } = require('./rules');\nconst { round2 } = require('../money/round');\nfunction reconcile(bank, ledger) { return bank.filter((b) => ledger.some((l) => isMatch(b, l))); }\nmodule.exports = { reconcile };\n");
  w('src/routes/recon.js', "const router = require('express').Router();\nconst { reconcile } = require('../recon/engine');\nrouter.post('/reconcile', (req, res) => res.json(reconcile(req.body.bank, req.body.ledger)));\nrouter.get('/health', (req, res) => res.send('ok'));\nmodule.exports = router;\n");
  w('src/billing/invoice.js', 'function invoice() { return 1; }\nmodule.exports = { invoice };\n');
  w('tests/recon.test.js', "const { reconcile } = require('../src/recon/engine');\n");
  w('api/recon_service.py', 'def reconcile_statement(lines):\n    return lines\n');
  w('api/main.py', 'from fastapi import APIRouter\nfrom api.recon_service import reconcile_statement\nrouter = APIRouter()\n@router.post("/statements/reconcile")\ndef run(lines):\n    return reconcile_statement(lines)\n');
  g('add', '-A'); g('commit', '-qm', 'init');
  return d;
}

test('stet study maps key files, supporting files, routes, flow, tests and protection', () => {
  const d = reconRepo();
  stet(d, 'init');
  stet(d, 'lock', 'add', 'Recon rules', '--cmd', 'node -e 0', '--protect', 'src/recon/rules.js');
  const r = stet(d, 'study', 'reconciliation');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /docs\/flows\/reconciliation\.md/);
  const doc = fs.readFileSync(path.join(d, 'docs/flows/reconciliation.md'), 'utf8');
  assert.match(doc, /\| `src\/recon\/engine\.js` \| defines reconcile/);
  assert.match(doc, /\| `src\/recon\/rules\.js` \| `isMatch` \|/);               // supporting file found via imports
  assert.match(doc, /\| POST \| `\/reconcile` \| `src\/routes\/recon\.js` \|/);
  assert.match(doc, /\| POST \| `\/statements\/reconcile` \| `api\/main\.py` \|/); // Python / FastAPI route
  assert.doesNotMatch(doc, /\/health/);                                          // unrelated route left out
  assert.doesNotMatch(doc, /billing\/invoice/);                                  // unrelated code left out
  assert.match(doc, /```mermaid\nflowchart LR/); assert.match(doc, /n\d+ --> n\d+/);
  assert.match(doc, /- `tests\/recon\.test\.js`/);
  assert.match(doc, /✅ `src\/recon\/rules\.js` — L1/); assert.match(doc, /⚠️ `src\/recon\/engine\.js` — not protected/);
  assert.match(doc, /--cmd "node --test tests\/recon\.test\.js"/);
  assert.match(doc, /stet context --flow reconciliation/);
});

test('stet study keeps your notes, tracks drift, and feeds stet context --flow', () => {
  const d = reconRepo();
  stet(d, 'init');
  stet(d, 'study', 'reconciliation');
  const f = path.join(d, 'docs/flows/reconciliation.md');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/## How it works\n.*\n/, '## How it works\nAmounts must match exactly.\n'));
  assert.match(stet(d, 'study').out, /up to date/);
  fs.appendFileSync(path.join(d, 'src/recon/rules.js'), '// changed\n');
  let r = stet(d, 'study');
  assert.match(r.out, /1 key file changed since written \(src\/recon\/rules\.js\)/);
  assert.match(stet(d, 'status').out, /1 out of date: reconciliation/);
  r = stet(d, 'study', 'reconciliation');
  assert.match(r.out, /refreshed; your notes kept/);
  assert.match(fs.readFileSync(f, 'utf8'), /Amounts must match exactly\./);
  assert.match(stet(d, 'study').out, /up to date/);
  r = stet(d, 'context', '--flow', 'reconciliation', '--stdout');
  assert.match(r.out, /## Flow: Reconciliation/); assert.match(r.out, /### src\/recon\/rules\.js/); assert.match(r.out, /Amounts must match exactly/);
  assert.match(stet(d, 'handoff', '--stdout').out, /\*\*reconciliation\*\* — \[`docs\/flows\/reconciliation\.md`\]/);
  assert.strictEqual(stet(d, 'study', 'zzzqqq').code, 1);
  assert.strictEqual(stet(d, 'context', '--flow', 'nope', '--stdout').code, 1);
});

// ---------- 0.6.1: carried files, scope done, duplicate locks ----------
test('scope set carries uncommitted earlier work; guard ignores it until it changes again', () => {
  const { d } = repo();
  stet(d, 'init');
  // Task 1 left work uncommitted (a modified file and a new one).
  fs.writeFileSync(path.join(d, 'src/auth/login.js'), 'module.exports = () => false;\n');
  fs.writeFileSync(path.join(d, 'src/auth/new.js'), '1;\n');
  let r = stet(d, 'scope', 'set', 'CSV export', '--allow', 'src/export/**');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /2 uncommitted files from earlier work\. Carried/);
  fs.writeFileSync(path.join(d, 'src/export/csv.js'), 'module.exports = 1;\n');
  r = stet(d, 'guard');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /2 carried files from earlier work, unchanged/);
  assert.match(r.out, /All changes are inside scope/);
  assert.match(stet(d, 'scope').out, /Carried .*src\/auth\/login\.js/);
  // The agent touches a carried file during this task: that is a real catch.
  fs.writeFileSync(path.join(d, 'src/auth/login.js'), 'module.exports = () => null;\n');
  r = stet(d, 'guard');
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /src\/auth\/login\.js\s+carried from earlier work, changed during this task/);
});

test('scope set --strict refuses a dirty tree', () => {
  const { d } = repo();
  stet(d, 'init');
  fs.writeFileSync(path.join(d, 'src/auth/login.js'), 'x;\n');
  const r = stet(d, 'scope', 'set', 'CSV export', '--allow', 'src/export/**', '--strict');
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /--strict: 1 uncommitted file from earlier work/);
  assert.match(stet(d, 'scope').out, /No scope set/);
});

test('guard hints at leftovers; scope carry --all marks them as earlier work', () => {
  const { d } = repo();
  stet(d, 'init');
  // An old uncommitted file that existed before the scope but wasn't carried (e.g. scope set on 0.6.0).
  const f = path.join(d, 'src/auth/old.js');
  fs.writeFileSync(f, 'old;\n');
  stet(d, 'scope', 'set', 'CSV export', '--allow', 'src/export/**');
  const s = JSON.parse(fs.readFileSync(path.join(d, '.stet/scope.json'), 'utf8'));
  s.carried = []; fs.writeFileSync(path.join(d, '.stet/scope.json'), JSON.stringify(s));
  const past = new Date(Date.now() - 3600e3); fs.utimesSync(f, past, past);
  let r = stet(d, 'guard');
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /These look like leftovers from before this scope was set\. If so: stet scope carry --all/);
  r = stet(d, 'scope', 'carry', '--all');
  assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /Carried 1 file as earlier work/);
  r = stet(d, 'guard');
  assert.strictEqual(r.code, 0, r.out);
  // Carry by path, and a path with no changes is refused.
  assert.strictEqual(stet(d, 'scope', 'carry', 'src/nope.js').code, 1);
});

test('scope done --commit commits only the task files and closes the scope', () => {
  const { d, g } = repo();
  stet(d, 'init'); g('add', '-A'); g('commit', '-qm', 'stet');
  fs.writeFileSync(path.join(d, 'src/auth/login.js'), 'leftover;\n'); // earlier work, stays uncommitted
  stet(d, 'scope', 'set', 'CSV export', '--allow', 'src/export/**');
  fs.writeFileSync(path.join(d, 'src/export/csv.js'), 'module.exports = 2;\n');
  const r = stet(d, 'scope', 'done', '--commit');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /Committed 1 file/); assert.match(r.out, /Scope closed/);
  const last = cp.execFileSync('git', ['show', '--name-only', '--format=%s', 'HEAD'], { cwd: d, encoding: 'utf8' });
  assert.match(last, /src\/export\/csv\.js/); assert.doesNotMatch(last, /login\.js/);
  assert.match(cp.execFileSync('git', ['status', '--porcelain'], { cwd: d, encoding: 'utf8' }), /src\/auth\/login\.js/);
  assert.match(stet(d, 'scope').out, /No scope set/);
});

test('scope done refuses while out of scope, unless --force', () => {
  const { d } = repo();
  stet(d, 'init');
  stet(d, 'scope', 'set', 'CSV export', '--allow', 'src/export/**');
  fs.writeFileSync(path.join(d, 'src/auth/login.js'), 'drift;\n');
  let r = stet(d, 'scope', 'done');
  assert.strictEqual(r.code, 1, r.out); assert.match(r.out, /Not finished: out-of-scope changes/);
  assert.match(stet(d, 'scope').out, /CSV export/);
  r = stet(d, 'scope', 'done', '--force');
  assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /Scope closed\. \(forced\)/);
});

test('init lists the locks it created; lock add refuses duplicate commands', () => {
  const { d } = repo();
  const i = stet(d, 'init');
  assert.match(i.out, /locked:\s+L1 Full test suite passes \(npm test\)/);
  assert.match(i.out, /Your test suite is already locked \(L1\)/);
  let r = stet(d, 'lock', 'add', 'Tests pass', '--cmd', 'npm   test');
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /L1 "Full test suite passes" already runs `npm test`\. Not added\./);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(d, '.stet/locks.json'), 'utf8')).length, 1);
  r = stet(d, 'lock', 'rename', 'L1', 'Tests pass');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(fs.readFileSync(path.join(d, 'AGENTS.md'), 'utf8'), /\| L1 \| Tests pass \|/);
  r = stet(d, 'lock', 'add', 'Tests again', '--cmd', 'npm test', '--force');
  assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /Locked L2/);
});

test('pr leaves carried earlier work out of the change list', () => {
  const { d } = repo();
  stet(d, 'init');
  fs.writeFileSync(path.join(d, 'src/auth/login.js'), 'leftover;\n');
  stet(d, 'scope', 'set', 'CSV export', '--allow', 'src/export/**');
  fs.writeFileSync(path.join(d, 'src/export/csv.js'), 'module.exports = 3;\n');
  stet(d, 'pr');
  const md = fs.readFileSync(path.join(d, '.stet/.cache/pr.md'), 'utf8');
  assert.match(md, /src\/export\/csv\.js/); assert.doesNotMatch(md, /login\.js/);
});

// ---------- 0.6.4: badge and links ----------
test('stet badge prints markdown; --add inserts once into the README', () => {
  const { d } = repo();
  stet(d, 'init');
  assert.match(stet(d, 'badge').out, /\[!\[guarded by stet\]\(https:\/\/img\.shields\.io\/badge\/guarded%20by-stet-FFF01F\?labelColor=0E1116\)\]\(https:\/\/getstet\.dev\)/);
  assert.strictEqual(stet(d, 'badge', '--add').code, 1); // no README yet
  fs.writeFileSync(path.join(d, 'README.md'), '# Demo\n\n[![ci](https://x/ci.svg)](https://x)\n\nHello\n');
  let r = stet(d, 'badge', '--add');
  assert.strictEqual(r.code, 0, r.out);
  const readme = fs.readFileSync(path.join(d, 'README.md'), 'utf8');
  assert.match(readme, /^\[!\[ci\].*\) \[!\[guarded by stet\]/m); // joins the existing badge row
  r = stet(d, 'badge', '--add');
  assert.match(r.out, /already has the Stet badge/);
  assert.strictEqual(fs.readFileSync(path.join(d, 'README.md'), 'utf8'), readme);
});

test('init --badge adds the badge under the title; AGENTS.md and PR text link to getstet.dev', () => {
  const { d } = repo();
  fs.writeFileSync(path.join(d, 'README.md'), '# Demo\n\nHello\n');
  const r = stet(d, 'init', '--badge');
  assert.match(r.out, /Added the Stet badge to README\.md/);
  assert.match(fs.readFileSync(path.join(d, 'README.md'), 'utf8'), /^# Demo\n\n\[!\[guarded by stet\]/);
  assert.match(fs.readFileSync(path.join(d, 'AGENTS.md'), 'utf8'), /Kept in sync by \[Stet\]\(https:\/\/getstet\.dev\)/);
  stet(d, 'scope', 'set', 'CSV export', '--allow', 'src/export/**');
  fs.writeFileSync(path.join(d, 'src/export/csv.js'), 'module.exports = 4;\n');
  stet(d, 'pr');
  assert.match(fs.readFileSync(path.join(d, '.stet/.cache/pr.md'), 'utf8'), /Generated by \[Stet\]\(https:\/\/getstet\.dev\)/);
});

// ---------- 0.6.5: update notice ----------
test('update: version compare, stet update, quiet when not a terminal or in CI', () => {
  const u = require('../lib/update');
  assert.ok(u.newer('0.6.10', '0.6.9')); assert.ok(!u.newer('0.6.4', '0.6.4')); assert.ok(!u.newer('0.7.0-beta.1', '0.6.4'));
  const { d } = repo();
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'stetcfg-'));
  const env = { ...process.env, STET_CONFIG_DIR: cfg, STET_TEST_LATEST: '99.0.0' };
  delete env.CI; delete env.GITHUB_ACTIONS; delete env.STET_NO_UPDATE_CHECK; delete env.NO_UPDATE_NOTIFIER;
  const run = (...a) => { const p = cp.spawnSync(process.execPath, [BIN, ...a, '--no-color'], { cwd: d, encoding: 'utf8', env }); return { out: p.stdout + p.stderr, code: p.status }; };
  // Not a terminal (as here): commands never print the notice or wait for input.
  const r = run('init');
  assert.strictEqual(r.code, 0); assert.doesNotMatch(r.out, /is available/);
  // stet update reports the newer version and, without a terminal, doesn't install.
  const up = run('update');
  assert.match(up.out, /Stet 99\.0\.0 is available \(you have /); assert.match(up.out, /Not updated/);
  // status shows it from the daily cache, with no network call.
  assert.match(run('status').out, /version\s+\S+\s+99\.0\.0 available: stet update/);
  // Up to date.
  env.STET_TEST_LATEST = core.VERSION;
  assert.match(run('update').out, /You're on the latest Stet/);
  // CI and opt-out switch it off entirely.
  process.env.CI = '1'; assert.ok(u.disabled({})); delete process.env.CI;
  assert.ok(u.disabled({ json: true }));
});

test('stet init --mcp pins the MCP server to the latest release', () => {
  const { d } = repo();
  stet(d, 'init', '--mcp');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(d, '.mcp.json'), 'utf8')).mcpServers.stet.args, ['-y', 'stet-cli@latest', 'mcp']);
});

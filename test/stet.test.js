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
  assert.deepStrictEqual(by(2).result.tools.map((t) => t.name), ['stet_context', 'stet_guard', 'stet_check', 'stet_scope', 'stet_pr', 'stet_pr_lint', 'stet_study', 'stet_decide']);
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
  assert.match(r.out, /2 files were already changed before this scope, so guard will ignore them/);
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

test('scope add widens an open scope without resetting it; remove narrows it', () => {
  const { d, g } = repo();
  stet(d, 'init');
  fs.writeFileSync(path.join(d, 'src/auth/login.js'), 'earlier work\n'); // uncommitted before the scope: carried
  stet(d, 'scope', 'set', 'CSV export', '--allow', 'src/export/**');
  const before = JSON.parse(fs.readFileSync(path.join(d, '.stet/scope.json'), 'utf8'));
  fs.writeFileSync(path.join(d, 'package.json'), '{"name":"demo2"}');
  assert.strictEqual(stet(d, 'guard').code, 1);
  let r = stet(d, 'scope', 'add', 'package.json');
  assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /Added to scope: package\.json/);
  const after = JSON.parse(fs.readFileSync(path.join(d, '.stet/scope.json'), 'utf8'));
  assert.deepStrictEqual(after.allow, ['src/export/**', 'package.json']);
  assert.strictEqual(after.base, before.base); assert.strictEqual(after.set, before.set); assert.deepStrictEqual(after.carried, before.carried);
  r = stet(d, 'guard'); assert.strictEqual(r.code, 0, r.out);
  assert.match(fs.readFileSync(path.join(d, 'AGENTS.md'), 'utf8'), /- `package\.json`/);
  assert.match(stet(d, 'scope', 'add', 'package.json').out, /Already in scope/);
  assert.match(stet(d, 'pr', '--stdout').out, /Scope widened during the task: `package\.json`/);
  r = stet(d, 'scope', 'remove', 'package.json'); assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(stet(d, 'guard').code, 1);
  assert.notStrictEqual(stet(d, 'scope', 'remove', 'src/export/**').code, 0); // can't empty it
  assert.notStrictEqual(stet(d, 'scope', 'clear').code === 0 && stet(d, 'scope', 'add', 'x').code, 0); // no scope → error
});

function withRemote() {
  const { d, g } = repo();
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'stet-remote-'));
  cp.execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  g('remote', 'add', 'origin', bare); g('push', '-q', '-u', 'origin', 'main');
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'stet-other-'));
  cp.execFileSync('git', ['clone', '-q', bare, other]);
  const o = (...a) => cp.execFileSync('git', a, { cwd: other });
  o('config', 'user.email', 'o@o'); o('config', 'user.name', 'O');
  const teammatePush = (file) => { o('pull', '-q', '--rebase', 'origin', 'main'); fs.writeFileSync(path.join(other, file), 'teammate\n'); o('add', '-A'); o('commit', '-qm', 'teammate ' + file); o('push', '-q', 'origin', 'main'); };
  return { d, g, teammatePush };
}

test('remote base: fetch origin/main, warn when behind, PR compares with the up-to-date remote', () => {
  const { d, g, teammatePush } = withRemote();
  stet(d, 'init'); g('add', '-A'); g('commit', '-qm', 'stet'); g('push', '-q', 'origin', 'main');
  teammatePush('teammate1.js');
  let r = stet(d, 'scope', 'set', 'CSV export', '--allow', 'src/export/**');
  assert.match(r.out, /Starting 1 commit behind origin\/main/);
  g('pull', '-q', '--rebase', '--autostash', 'origin', 'main');
  g('switch', '-q', '-c', 'feature');
  stet(d, 'scope', 'set', 'CSV export', '--allow', 'src/export/**');
  fs.writeFileSync(path.join(d, 'src/export/csv.js'), 'module.exports = 1;\n'); g('add', '-A'); g('commit', '-qm', 'csv');
  teammatePush('teammate2.js');
  fs.rmSync(path.join(d, '.stet/.cache/fetch.json'), { force: true });
  r = stet(d, 'guard');
  assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /This branch is 1 commit behind origin\/main/);
  r = stet(d, 'pr', '--stdout');
  assert.match(r.out, /Compared with `origin\/main`/);
  assert.match(r.out, /\| `src\/export\/csv\.js` \| modified \|/);
  assert.doesNotMatch(r.out, /teammate2/); // their work isn't counted as ours
  // local main is stale: --base main uses origin/main instead
  r = stet(d, 'guard', '--base', 'main');
  assert.match(r.out, /Local main is 1 commit behind origin\/main\. Compared with origin\/main instead/);
  assert.doesNotMatch(r.out, /teammate1/);
  // --no-fetch and STET_NO_FETCH skip the network
  assert.strictEqual(stet(d, 'guard', '--no-fetch').code, 0);
});

test('PR format: --what fills it, lint rejects missing, unwritten or hand-edited sections, custom template', () => {
  const { d, g } = repo();
  stet(d, 'init');
  stet(d, 'scope', 'set', 'LIN-7 Add CSV export', '--allow', 'src/export/**');
  fs.writeFileSync(path.join(d, 'src/export/csv.js'), 'module.exports = 1;\n');
  const pr = path.join(d, '.stet/.cache/pr.md');
  stet(d, 'pr');
  let r = stet(d, 'pr', 'lint', pr);
  assert.strictEqual(r.code, 1); assert.match(r.out, /"### What and why" is not written yet/);
  r = stet(d, 'pr', '--what', 'Users can download their rows as CSV.');
  assert.match(fs.readFileSync(pr, 'utf8'), /### What and why\nUsers can download their rows as CSV\.\n/);
  r = stet(d, 'pr', 'lint', pr); assert.strictEqual(r.code, 0, r.out);
  // an agent rewrites the scope section
  const edited = fs.readFileSync(pr, 'utf8').replace(/✅ All changes are inside the agreed scope.*/, 'Looks fine to me.');
  fs.writeFileSync(path.join(d, 'edited.md'), edited);
  r = stet(d, 'pr', 'lint', 'edited.md'); assert.strictEqual(r.code, 1); assert.match(r.out, /"### Scope" was edited by hand/);
  fs.writeFileSync(path.join(d, 'own.md'), '## My PR\n\nI changed some stuff.\n');
  r = stet(d, 'pr', 'lint', 'own.md'); assert.strictEqual(r.code, 1);
  assert.match(r.out, /Missing section: ### What and why/); assert.match(r.out, /Missing section: ### Locked behaviours/); assert.match(r.out, /footer was removed/);
  // stdin
  const p = cp.spawnSync(process.execPath, [BIN, 'pr', 'lint', '-', '--no-color'], { cwd: d, input: fs.readFileSync(pr), encoding: 'utf8' });
  assert.strictEqual(p.status, 0, p.stdout + p.stderr);
  // custom template
  assert.strictEqual(stet(d, 'pr', 'template').code, 0);
  const tp = path.join(d, '.stet/pr-template.md');
  fs.writeFileSync(tp, fs.readFileSync(tp, 'utf8').replace('### What and why\n{{what}}\n', '### Summary\n{{what}}\n\n### How to test\n- [ ] Tested locally\n'));
  stet(d, 'pr', '--what', 'CSV export.');
  const out = fs.readFileSync(pr, 'utf8');
  assert.match(out, /### Summary\nCSV export\.\n\n### How to test\n- \[ \] Tested locally/);
  assert.strictEqual(stet(d, 'pr', 'lint', pr).code, 0);
  r = stet(d, 'pr', 'lint', 'edited.md'); assert.match(r.out, /Missing section: ### Summary/);
  // MCP: stet_pr takes what; stet_pr_lint checks a body
  const mcp = require('../lib/mcp');
  assert.ok(mcp.TOOLS.find((t) => t.name === 'stet_pr').inputSchema.properties.what);
});

test('stet ci writes a pull request workflow with the PR format check; init --ci too', () => {
  const { d } = repo();
  fs.writeFileSync(path.join(d, 'package-lock.json'), '{}');
  stet(d, 'init');
  // 0.8.0: the PR format check is opt-in.
  let r = stet(d, 'ci');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /PR descriptions are not checked/);
  const f = path.join(d, '.github/workflows/stet.yml');
  let y = fs.readFileSync(f, 'utf8');
  for (const re of [/types: \[opened, synchronize, reopened\]/, /- run: npm ci/, /uses: shamazkhan\/stet-action@v1/, /fetch-depth: 0/]) assert.match(y, re);
  assert.doesNotMatch(y, /pr-format/);
  assert.match(stet(d, 'ci').out, /already exists/);
  r = stet(d, 'ci', '--force', '--pr-format');
  y = fs.readFileSync(f, 'utf8');
  assert.match(y, /pr-format: true/); assert.match(y, /edited/);
  const { d: d2 } = repo();
  r = stet(d2, 'init', '--ci');
  assert.match(r.out, /Wrote .*\.github\/workflows\/stet\.yml/);
  assert.ok(fs.existsSync(path.join(d2, '.github/workflows/stet.yml')));
});

test('agent hook: blocks Claude Code PRs in their own format, lets the stet format through', () => {
  const { d } = repo();
  stet(d, 'init');
  fs.mkdirSync(path.join(d, '.claude'));
  fs.writeFileSync(path.join(d, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }));
  let r = stet(d, 'agent');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /Agent hook installed/);
  stet(d, 'agent'); // twice: still one entry
  let j = JSON.parse(fs.readFileSync(path.join(d, '.claude/settings.json'), 'utf8'));
  assert.deepStrictEqual(j.permissions, { allow: ['Bash(npm test)'] });
  assert.strictEqual(j.hooks.PreToolUse.length, 1);
  assert.match(j.hooks.PreToolUse[0].matcher, /Bash/);
  assert.match(j.hooks.PreToolUse[0].hooks[0].command, /agent-hook/);
  assert.match(stet(d, 'status').out, /agent hook on/);

  stet(d, 'scope', 'set', 'Add CSV export', '--allow', 'src/export/**');
  fs.writeFileSync(path.join(d, 'src/export/csv.js'), 'module.exports = 1;\n');
  const hook = (input) => { const p = cp.spawnSync(process.execPath, [BIN, 'agent-hook'], { cwd: d, input: JSON.stringify({ cwd: d, ...input }), encoding: 'utf8' }); return { code: p.status, err: p.stderr }; };
  const bash = (command) => hook({ tool_name: 'Bash', tool_input: { command } });

  // not a PR command
  assert.strictEqual(bash('npm test && git push').code, 0);
  // Claude's usual heredoc form, in its own format
  r = bash(`git push -u origin HEAD && gh pr create --title "Add CSV export" --body "$(cat <<'EOF'\n## Summary\n- Added "CSV" export\n\n## Test plan\n- [x] npm test\nEOF\n)"`);
  assert.strictEqual(r.code, 2); assert.match(r.err, /blocked/); assert.match(r.err, /Missing section: ### What and why/); assert.match(r.err, /stet pr --create --what/);
  // --fill, no body, --web, stdin, a body built at run time
  for (const cmd of ['gh pr create --fill', 'gh pr create --title x', 'gh pr create --web', 'gh pr create -t x -F -', 'gh pr create -t x --body "$BODY"']) assert.strictEqual(bash(cmd).code, 2, cmd);
  // gh pr edit without a body change is fine; with an own body it is blocked
  assert.strictEqual(bash('gh pr edit 12 --add-label bug').code, 0);
  assert.strictEqual(bash("gh pr edit 12 --body 'quick fix'").code, 2);
  // the stet format passes
  stet(d, 'pr', '--what', 'Users can download their rows as CSV.');
  assert.strictEqual(bash('gh pr create --title "Add CSV export" --body-file .stet/.cache/pr.md').code, 0);
  const body = fs.readFileSync(path.join(d, '.stet/.cache/pr.md'), 'utf8');
  assert.strictEqual(bash(`gh pr create --title t --body "$(cat <<'EOF'\n${body}\nEOF\n)"`).code, 0);
  // a hand-edited fact section is caught
  assert.strictEqual(bash(`gh pr create -t t --body-file=edited.md`).code, 2);
  fs.writeFileSync(path.join(d, 'edited.md'), body.replace(/✅ All changes are inside the agreed scope.*/, 'Fine.'));
  r = bash('gh pr create -t t --body-file=edited.md'); assert.strictEqual(r.code, 2); assert.match(r.err, /"### Scope" was edited by hand/);
  // GitHub MCP tools
  assert.strictEqual(hook({ tool_name: 'mcp__github__create_pull_request', tool_input: { title: 't', body: 'my words' } }).code, 2);
  assert.strictEqual(hook({ tool_name: 'mcp__github__create_pull_request', tool_input: { title: 't', body } }).code, 0);
  assert.strictEqual(hook({ tool_name: 'mcp__github__update_pull_request', tool_input: { title: 'new title' } }).code, 0);
  // bad input or a repo without Stet never blocks
  assert.strictEqual(cp.spawnSync(process.execPath, [BIN, 'agent-hook'], { cwd: d, input: 'not json' }).status, 0);
  const { d: plain } = repo();
  assert.strictEqual(cp.spawnSync(process.execPath, [BIN, 'agent-hook'], { cwd: plain, input: JSON.stringify({ cwd: plain, tool_name: 'Bash', tool_input: { command: 'gh pr create --fill' } }) }).status, 0);
  // guard ignores the settings file; uninstall keeps the user's settings
  assert.doesNotMatch(stet(d, 'guard').out, /settings\.json/);
  assert.match(stet(d, 'agent', '--uninstall').out, /Removed/);
  j = JSON.parse(fs.readFileSync(path.join(d, '.claude/settings.json'), 'utf8'));
  assert.deepStrictEqual(j, { permissions: { allow: ['Bash(npm test)'] } });
  // AGENTS.md says it too; init --agent installs it
  assert.match(fs.readFileSync(path.join(d, 'AGENTS.md'), 'utf8'), /never run `gh pr create`/);
  const { d: d2 } = repo();
  assert.match(stet(d2, 'init', '--agent').out, /Agent hook installed/);
  assert.ok(core.agentInstalled(new core.Repo(d2)));
});

test('0.7.3: TypeScript compiles is locked; lock suggest; guard skips generated files and suggests scope add', () => {
  const { d, g } = repo();
  fs.mkdirSync(path.join(d, 'apps/web/src/lib'), { recursive: true });
  fs.writeFileSync(path.join(d, 'apps/web/package.json'), JSON.stringify({ name: 'web', devDependencies: { typescript: '5' } }));
  fs.writeFileSync(path.join(d, 'apps/web/tsconfig.json'), '{}');
  fs.writeFileSync(path.join(d, 'apps/web/src/lib/api.ts'), 'export const a = 1;\n');
  g('add', '-A'); g('commit', '-qm', 'web');
  let r = stet(d, 'init');
  assert.match(r.out, /locked: +L\d TypeScript compiles \(apps\/web\/\) \(cd apps\/web && npx tsc --noEmit\)/);
  assert.match(stet(d, 'lock', 'suggest').out, /already locked/);
  // an older setup without it
  const L = JSON.parse(fs.readFileSync(path.join(d, '.stet/locks.json'), 'utf8')).filter((l) => !/TypeScript/.test(l.name));
  fs.writeFileSync(path.join(d, '.stet/locks.json'), JSON.stringify(L));
  r = stet(d, 'lock', 'suggest');
  assert.match(r.out, /stet lock add "TypeScript compiles \(apps\/web\/\)" --cmd "cd apps\/web && npx tsc --noEmit"/);
  r = stet(d, 'lock', 'suggest', '--add'); assert.match(r.out, /Locked L\d+: TypeScript compiles/);
  assert.match(stet(d, 'lock', 'suggest').out, /already locked/);
  // guard: generated files skipped, out-of-scope ones get a scope add hint
  stet(d, 'scope', 'set', 'Rounding', '--allow', 'src/export/**');
  fs.writeFileSync(path.join(d, 'src/export/csv.js'), 'x\n');
  fs.writeFileSync(path.join(d, 'apps/web/tsconfig.tsbuildinfo'), '{}');
  fs.mkdirSync(path.join(d, 'backend'));
  fs.writeFileSync(path.join(d, 'backend/test_app.db'), 'x');
  fs.writeFileSync(path.join(d, 'apps/web/src/lib/api.ts'), 'export const a = 2;\n');
  fs.writeFileSync(path.join(d, 'apps/web/src/lib/constants.ts'), 'export const b = 2;\n');
  r = stet(d, 'guard');
  assert.strictEqual(r.code, 1);
  assert.doesNotMatch(r.out, /✓ apps\/web\/tsconfig\.tsbuildinfo/);
  assert.match(r.out, /2 generated or ignored files not checked: (apps\/web\/tsconfig\.tsbuildinfo · backend\/test_app\.db|backend\/test_app\.db · apps\/web\/tsconfig\.tsbuildinfo)/);
  assert.match(r.out, /If that was on purpose: stet scope add "apps\/web\/src\/lib\/\*\*"/);
  // protected paths are always checked; guardGenerated checks everything
  const cfgP = path.join(d, '.stet/config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgP, 'utf8'));
  fs.writeFileSync(cfgP, JSON.stringify({ ...cfg, protect: ['backend/**'] }));
  assert.match(stet(d, 'guard').out, /backend\/test_app\.db.*protected/);
  fs.writeFileSync(cfgP, JSON.stringify({ ...cfg, guardGenerated: true }));
  assert.match(stet(d, 'guard').out, /apps\/web\/tsconfig\.tsbuildinfo/);
  stet(d, 'scope', 'add', 'apps/web/src/lib/**');
  fs.writeFileSync(cfgP, JSON.stringify(cfg));
  assert.strictEqual(stet(d, 'guard').code, 0);
});

test('0.7.3: usage count is opt-in, sends only id/version/command/os once a day, and is off in CI', async () => {
  const http = require('http');
  const got = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (x) => { b += x; }); req.on('end', () => { got.push({ h: req.headers, body: JSON.parse(b) }); res.end('{}'); }); });
  await new Promise((ok) => srv.listen(0, ok));
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stet-cfg-'));
  const env = { ...process.env, STET_CONFIG_DIR: cfgDir, STET_USAGE_URL: `http://127.0.0.1:${srv.address().port}/ping`, CI: '', GITHUB_ACTIONS: '', CONTINUOUS_INTEGRATION: '', STET_TELEMETRY: '', DO_NOT_TRACK: '', STET_NO_UPDATE_CHECK: '1' };
  delete env.CI; delete env.GITHUB_ACTIONS; delete env.CONTINUOUS_INTEGRATION;
  const run = (d, ...a) => new Promise((ok) => { const p = cp.spawn(process.execPath, [BIN, ...a, '--no-color'], { cwd: d, env }); let o = ''; p.stdout.on('data', (x) => { o += x; }); p.on('close', () => ok(o)); });
  const { d } = repo();
  await run(d, 'init');            // not a terminal: no question, nothing sent
  await run(d, 'status');
  assert.strictEqual(got.length, 0);
  assert.match(await run(d, 'telemetry'), /usage count: off/);
  assert.match(await run(d, 'telemetry', 'on'), /usage count: on/);
  await run(d, 'status');
  await run(d, 'guard');           // same day: no second ping
  assert.strictEqual(got.length, 1);
  assert.deepStrictEqual(Object.keys(got[0].body).sort(), ['command', 'install_id', 'os', 'version']);
  assert.strictEqual(got[0].body.command, 'status');
  assert.strictEqual(got[0].body.version, core.VERSION);
  assert.match(got[0].body.install_id, /^[0-9a-f-]{36}$/);
  assert.doesNotMatch(JSON.stringify(got[0]), new RegExp(path.basename(d)));
  // a day later, but in CI or with STET_TELEMETRY=0: nothing
  const f = path.join(cfgDir, 'usage.json');
  const u = JSON.parse(fs.readFileSync(f, 'utf8')); u.lastPing = 0; fs.writeFileSync(f, JSON.stringify(u));
  env.CI = 'true'; await run(d, 'status'); delete env.CI;
  env.STET_TELEMETRY = '0'; await run(d, 'status'); env.STET_TELEMETRY = '';
  assert.strictEqual(got.length, 1);
  await run(d, 'status');
  assert.strictEqual(got.length, 2);
  assert.match(await run(d, 'telemetry', 'off'), /usage count: off/);
  u.lastPing = 0; fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), lastPing: 0 }));
  await run(d, 'status');
  assert.strictEqual(got.length, 2);
  // the question, answered no, sends nothing and is not asked again
  const usage = require('../lib/usage');
  process.env.STET_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stet-cfg-'));
  assert.ok(usage.undecided());
  usage.set(false);
  assert.strictEqual(await usage.askOnce(core.c, { interactive: true }), null);
  delete process.env.STET_CONFIG_DIR;
  srv.close();
});

// ---------- 0.8.0: tester feedback ----------
test('0.8.0: pytest lock uses the project virtualenv; lock suggest fixes old locks; lock cmd', () => {
  const { d, g } = repo();
  fs.mkdirSync(path.join(d, 'backend/tests'), { recursive: true });
  fs.mkdirSync(path.join(d, 'backend/.venv/bin'), { recursive: true });
  fs.writeFileSync(path.join(d, 'backend/pyproject.toml'), '[project]\nname="api"\ndependencies=["fastapi"]\n');
  fs.writeFileSync(path.join(d, 'backend/.venv/bin/python'), '#!/bin/sh\n');
  g('add', 'backend/pyproject.toml'); g('commit', '-qm', 'backend');
  let r = stet(d, 'init');
  assert.match(r.out, /Test suite passes \(backend\/\) \(cd backend && \.venv\/bin\/python -m pytest -q\)/);
  // an older setup with plain pytest
  const L = JSON.parse(fs.readFileSync(path.join(d, '.stet/locks.json'), 'utf8'));
  const i = L.findIndex((l) => /pytest/.test(l.cmd)); const id = L[i].id;
  L[i].cmd = 'cd backend && pytest -q'; fs.writeFileSync(path.join(d, '.stet/locks.json'), JSON.stringify(L));
  r = stet(d, 'lock', 'suggest');
  assert.match(r.out, new RegExp(`stet lock cmd ${id} "cd backend && \\.venv/bin/python -m pytest -q"`));
  r = stet(d, 'lock', 'cmd', id, 'cd backend && python3 -m pytest');
  assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /now: cd backend && python3 -m pytest/);
  assert.notStrictEqual(stet(d, 'lock', 'cmd', 'L99', 'x').code, 0);
});

test('0.8.0: scope set warns about --allow paths that match nothing; --include-current; scope belongs to its branch', () => {
  const { d, g } = repo();
  stet(d, 'init'); g('add', '-A'); g('commit', '-qm', 'stet');
  fs.writeFileSync(path.join(d, 'src/auth/login.js'), 'module.exports = () => 2;\n'); // made before the scope
  let r = stet(d, 'scope', 'set', 'Styles', '--allow', 'src/export/**,login.js,src/styles/global.css');
  assert.match(r.out, /--allow "login\.js" matches no file yet\.\s+Did you mean src\/auth\/login\.js\?/);
  assert.match(r.out, /--allow "src\/styles\/global\.css" matches no file yet\. Fine if the task creates it/);
  assert.doesNotMatch(r.out, /"src\/export\/\*\*" matches no file/);
  assert.match(r.out, /already changed before this scope.*\n.*\n.*--include-current/);
  assert.strictEqual(stet(d, 'guard').code, 0); // carried
  r = stet(d, 'scope', 'set', 'Styles', '--allow', 'src/export/**', '--include-current');
  assert.match(r.out, /counted as part of this task/);
  assert.strictEqual(stet(d, 'guard').code, 1); // now it counts, and it's out of scope
  // the scope was set on main; on another branch it doesn't apply (the hook won't block unrelated work)
  g('switch', '-q', '-c', 'other');
  fs.writeFileSync(path.join(d, 'src/auth/login.js'), 'module.exports = () => 3;\n'); g('add', 'src/auth/login.js');
  r = stet(d, 'guard', '--staged');
  assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /belongs to branch main/);
  g('switch', '-q', '-f', 'main');
  r = stet(d, 'guard'); assert.doesNotMatch(r.out, /belongs to branch/);
});

test('0.8.0: init refuses a second .stet when origin/main already has one; --force overrides', () => {
  const { d, g } = withRemote();
  stet(d, 'init'); g('add', '-A'); g('commit', '-qm', 'stet'); g('push', '-q', 'origin', 'main');
  // a teammate's clone made before Stet landed, with no .stet/
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'stet-mate-'));
  cp.execFileSync('git', ['clone', '-q', '--depth', '1', fs.realpathSync(cp.execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: d, encoding: 'utf8' }).trim())], { cwd: other });
  const mate = path.join(other, fs.readdirSync(other)[0]);
  fs.rmSync(path.join(mate, '.stet'), { recursive: true, force: true }); // as if their checkout predates it
  let r = stet(mate, 'init');
  assert.notStrictEqual(r.code, 0); assert.match(r.out, /already set up on origin\/main/); assert.match(r.out, /git pull origin main/);
  assert.ok(!fs.existsSync(path.join(mate, '.stet/config.json')));
  r = stet(mate, 'init', '--force'); assert.strictEqual(r.code, 0, r.out);
});

test('0.8.0: check re-runs failures on origin/main and separates old breaks from new ones', () => {
  const { d, g } = withRemote();
  stet(d, 'init');
  fs.writeFileSync(path.join(d, 'state.txt'), 'bad\n');
  fs.writeFileSync(path.join(d, 'ok.txt'), 'ok\n');
  g('add', '-A'); g('commit', '-qm', 'stet'); g('push', '-q', 'origin', 'main');
  const cmd = (f) => `node -e "process.exit(require('fs').readFileSync('${f}','utf8').trim()==='ok'?0:1)"`;
  stet(d, 'lock', 'add', 'State is ok', '--cmd', cmd('state.txt'));   // already broken on main
  stet(d, 'lock', 'add', 'Other is ok', '--cmd', cmd('ok.txt'));      // fine on main
  g('switch', '-q', '-c', 'feature');
  fs.writeFileSync(path.join(d, 'src/export/csv.js'), 'x\n');
  let r = stet(d, 'check', '--no-fetch');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /L\d+\s+already failing on origin\/main, not caused by this change/);
  assert.match(r.out, /Nothing this change broke/);
  assert.strictEqual(stet(d, 'check', '--no-fetch', '--no-baseline').code, 1);
  // now the change breaks something that works on main
  fs.writeFileSync(path.join(d, 'ok.txt'), 'broken\n');
  r = stet(d, 'check', '--no-fetch');
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /passes on origin\/main: broken by this change/);
  // strict teams can fail on old breaks too
  const cfgP = path.join(d, '.stet/config.json');
  fs.writeFileSync(path.join(d, 'ok.txt'), 'ok\n');
  fs.writeFileSync(cfgP, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgP, 'utf8')), failOnPreexisting: true }));
  assert.strictEqual(stet(d, 'check', '--no-fetch').code, 1);
  // no stray worktrees left behind
  assert.strictEqual(cp.execFileSync('git', ['worktree', 'list'], { cwd: d, encoding: 'utf8' }).trim().split('\n').length, 1);
});

test('0.8.0: PR title from a descriptive single commit, or --title', () => {
  const { d, g } = repo();
  stet(d, 'init'); g('add', '-A'); g('commit', '-qm', 'stet');
  stet(d, 'scope', 'set', 'LIN-9 CSV export', '--allow', 'src/export/**');
  fs.writeFileSync(path.join(d, 'src/export/csv.js'), 'x\n'); g('add', '-A'); g('commit', '-qm', 'LIN-9: Download rows as a CSV file');
  let r = stet(d, 'pr', '--stdout', '--base', 'HEAD~1');
  assert.match(r.out, /## LIN-9: Download rows as a CSV file/);
  r = stet(d, 'pr', '--stdout', '--base', 'HEAD~1', '--title', 'Custom title here');
  assert.match(r.out, /## Custom title here/);
});

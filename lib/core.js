'use strict';
// Stet core: every command returns { text, code } so the CLI and the MCP server share one implementation.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const os = require('os');
const VERSION = require('../package.json').version;

// ---------- output helpers ----------
let COLOR = (!!process.stdout.isTTY || process.env.STET_COLOR === '1') && !process.env.NO_COLOR;
const setColor = (v) => { COLOR = !!v; };
const paint = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = { bold: paint(1), dim: paint(2), red: paint(31), green: paint(32), yellow: paint(33), cyan: paint(36), violet: paint(35) };
const OK = () => c.green('✓'), BAD = () => c.red('✗'), WARN = () => c.yellow('!');
const today = () => new Date().toISOString().slice(0, 10);
const out = (text, code = 0, data) => ({ text, code, data });

class StetError extends Error { constructor(m, code = 1) { super(m); this.code = code; } }

// ---------- git + fs ----------
function sh(cmd, args, cwd) { return cp.spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }); }
function git(args, cwd) {
  const r = sh('git', args, cwd);
  if (r.error || r.status !== 0) throw new StetError(((r.stderr || '') + '').trim() || `git ${args.join(' ')} failed`);
  return r.stdout;
}
function tgit(args, cwd, d = '') { try { return git(args, cwd); } catch { return d; } }
const nonEmpty = (s) => String(s || '').split('\n').filter((x) => x.trim() !== '');
const names = (s) => nonEmpty(s).map((x) => x.trim());

function findRoot(start = process.cwd()) {
  let d = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(d, '.stet'))) return d;
    const p = path.dirname(d);
    if (p === d) break;
    d = p;
  }
  return tgit(['rev-parse', '--show-toplevel'], start).trim() || path.resolve(start);
}

class Repo {
  constructor(root) { this.root = root; this.dir = path.join(root, '.stet'); }
  p(...a) { return path.join(this.dir, ...a); }
  has() { return fs.existsSync(this.dir); }
  need() { if (!this.has()) throw new StetError('No .stet/ folder found. Run `stet init` in your project first.'); }
  isGit() { return !!tgit(['rev-parse', '--git-dir'], this.root).trim(); }
  read(f, d = '') { try { return fs.readFileSync(this.p(f), 'utf8'); } catch { return d; } }
  write(f, s) { fs.mkdirSync(path.dirname(this.p(f)), { recursive: true }); fs.writeFileSync(this.p(f), s); }
  json(f, d) { try { return JSON.parse(this.read(f)); } catch { return d; } }
  wjson(f, o) { this.write(f, JSON.stringify(o, null, 2) + '\n'); }
  get config() { return { name: path.basename(this.root), protect: [], ignore: [], maxFileKB: 64, checkTimeoutSec: 600, ...this.json('config.json', {}) }; }
  get locks() { return this.json('locks.json', []); }
  get scope() { return this.json('scope.json', {}); }
  tgit(a, d = '') { return tgit(a, this.root, d); }
  head(full) { return this.tgit(['rev-parse', ...(full ? [] : ['--short']), 'HEAD']).trim(); }
  branch() { return this.head() ? this.tgit(['rev-parse', '--abbrev-ref', 'HEAD']).trim() : '(no commits yet)'; }
  rootFile(f) { try { return fs.readFileSync(path.join(this.root, f), 'utf8'); } catch { return null; } }
}

// ---------- globs ----------
function globRe(g) {
  g = String(g).trim().replace(/^\.\//, '');
  if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '*') {
      if (g[i + 1] === '*') { i++; if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}
function matches(file, globs) {
  return (globs || []).some((g) => globRe(g).test(file) || (!/[*?]/.test(g) && file.startsWith(String(g).replace(/^\.\//, '').replace(/\/$/, '') + '/')));
}
const splitList = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((s) => s.trim()).filter(Boolean);

// ---------- stack detection ----------
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage', '__pycache__', '.venv', 'venv', 'env', 'vendor', 'target', '.stet', '.idea', '.vscode']);
const MANIFESTS = ['package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile', 'go.mod', 'Cargo.toml', 'Gemfile', 'pom.xml', 'build.gradle', 'composer.json', 'pubspec.yaml'];
const EXT_LANG = { py: 'Python', ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', go: 'Go', rs: 'Rust', rb: 'Ruby', java: 'Java', kt: 'Kotlin', swift: 'Swift', php: 'PHP', cs: 'C#', dart: 'Dart' };

// Folders (root + up to 2 levels deep) that contain a project manifest, e.g. "", "backend", "apps/web".
function projectDirs(root) {
  const out = [];
  const walk = (rel, depth) => {
    const abs = path.join(root, rel);
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.isFile() && MANIFESTS.includes(e.name))) out.push(rel);
    if (depth >= 2) return;
    for (const e of entries) if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(rel ? rel + '/' + e.name : e.name, depth + 1);
  };
  walk('', 0);
  return out;
}

function detectIn(root, rel, s) {
  const ex = (f) => fs.existsSync(path.join(root, rel, f));
  const rd = (f) => { try { return fs.readFileSync(path.join(root, rel, f), 'utf8'); } catch { return ''; } };
  const where = rel ? ` (${rel}/)` : '';
  const cd = (cmd) => (rel ? `cd ${rel} && ${cmd}` : cmd);
  const addLang = (l) => { if (!s.langs.includes(l + where)) s.langs.push(l + where); };
  const addFw = (f) => { if (!s.frameworks.includes(f)) s.frameworks.push(f); };
  const addTest = (cmd) => { if (!s.tests.includes(cd(cmd))) s.tests.push(cd(cmd)); };
  const p = (f) => (rel ? rel + '/' + f : f);
  if (ex('package.json')) {
    let pj = {}; try { pj = JSON.parse(rd('package.json')); } catch {}
    const deps = { ...(pj.dependencies || {}), ...(pj.devDependencies || {}) };
    s.deps.push(...Object.keys(pj.dependencies || {}));
    const emptyWorkspaceRoot = !rel && !Object.keys(deps).length && !Object.keys(pj.scripts || {}).length;
    if (!emptyWorkspaceRoot) addLang(deps.typescript || ex('tsconfig.json') ? 'TypeScript' : 'JavaScript');
    for (const [k, n] of [['next', 'Next.js'], ['react', 'React'], ['vue', 'Vue'], ['svelte', 'Svelte'], ['express', 'Express'], ['@nestjs/core', 'NestJS'], ['fastify', 'Fastify'], ['hono', 'Hono'], ['vite', 'Vite'], ['prisma', 'Prisma'], ['drizzle-orm', 'Drizzle'], ['@supabase/supabase-js', 'Supabase'], ['stripe', 'Stripe'], ['tailwindcss', 'Tailwind']]) if (deps[k]) addFw(n);
    const rootEx = (f) => ex(f) || fs.existsSync(path.join(root, f));
    const pm = rootEx('pnpm-lock.yaml') ? 'pnpm' : rootEx('yarn.lock') ? 'yarn' : rootEx('bun.lockb') || rootEx('bun.lock') ? 'bun' : 'npm';
    const sc = pj.scripts || {};
    if (sc.test && !/no test specified/.test(sc.test)) addTest(`${pm} test`);
    // TypeScript: lock "it compiles" too. Type errors often crash only at runtime, on a click nobody tested.
    if (deps.typescript || ex('tsconfig.json')) {
      const tc = sc.typecheck ? `${pm} run typecheck` : ex('tsconfig.json') ? 'npx tsc --noEmit' : null;
      if (tc && !s.typechecks.includes(cd(tc))) s.typechecks.push(cd(tc));
    }
    for (const k of ['dev', 'start', 'build', 'lint', 'typecheck']) if (sc[k]) s.run.push(cd(`${pm} run ${k}`));
    if (pj.main) s.entry.push(p(pj.main));
    if (pj.bin) s.entry.push(...(typeof pj.bin === 'string' ? [pj.bin] : Object.values(pj.bin)).map(p));
  }
  if (ex('pyproject.toml') || ex('requirements.txt') || ex('setup.py') || ex('Pipfile')) {
    addLang('Python');
    const txt = (rd('pyproject.toml') + '\n' + rd('requirements.txt') + '\n' + rd('Pipfile')).toLowerCase();
    for (const [k, n] of [['django', 'Django'], ['fastapi', 'FastAPI'], ['flask', 'Flask'], ['sqlalchemy', 'SQLAlchemy'], ['pydantic', 'Pydantic'], ['pandas', 'pandas'], ['celery', 'Celery']]) if (txt.includes(k)) addFw(n);
    s.deps.push(...nonEmpty(rd('requirements.txt')).filter((l) => !l.trim().startsWith('#') && !l.trim().startsWith('-')).map((l) => l.trim().split(/[=<>~! ;\[]/)[0]));
    // Use the project's virtualenv if it has one, so the lock runs without an activated venv.
    const venv = ['.venv', 'venv', 'env'].find((d) => ex(`${d}/bin/python`) || ex(`${d}/Scripts/python.exe`));
    const py = venv ? (ex(`${venv}/bin/python`) ? `${venv}/bin/python` : `${venv}\\Scripts\\python.exe`) : null;
    if (ex('tests') || ex('test') || ex('pytest.ini') || ex('conftest.py') || txt.includes('[tool.pytest')) addTest(py ? `${py} -m pytest -q` : 'pytest -q');
    if (ex('manage.py')) { s.run.push(cd('python manage.py runserver')); s.entry.push(p('manage.py')); }
  }
  if (ex('go.mod')) { addLang('Go'); addTest('go test ./...'); }
  if (ex('Cargo.toml')) { addLang('Rust'); addTest('cargo test'); }
  if (ex('Gemfile')) addLang('Ruby');
  if (ex('pom.xml') || ex('build.gradle')) addLang('Java');
  if (ex('composer.json')) addLang('PHP');
  if (ex('pubspec.yaml')) addLang('Dart');
  if (ex('Dockerfile') || ex('docker-compose.yml') || ex('docker-compose.yaml') || ex('compose.yaml')) addFw('Docker');
  for (const f of ['main.py', 'app.py', 'server.js', 'index.js', 'src/server.js', 'src/server.ts', 'src/app.js', 'src/index.ts', 'src/main.ts', 'src/index.js', 'src/app.ts', 'app/main.py', 'app/page.tsx', 'src/main.tsx', 'main.go', 'src/main.rs']) if (ex(f) && !s.entry.includes(p(f))) s.entry.push(p(f));
  if (!rel && ex('Makefile')) s.run.push(...nonEmpty(rd('Makefile')).filter((l) => /^[a-zA-Z][\w-]*:/.test(l)).slice(0, 6).map((l) => 'make ' + l.split(':')[0]));
}

function detect(root) {
  const s = { langs: [], frameworks: [], tests: [], typechecks: [], test: null, run: [], deps: [], entry: [] };
  for (const rel of projectDirs(root)) detectIn(root, rel, s);
  if (!s.frameworks.includes('Docker') && ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml'].some((f) => fs.existsSync(path.join(root, f)))) s.frameworks.push('Docker');
  // Fallback: languages with real source files but no manifest we recognise.
  const files = names(tgit(['ls-files', '--cached', '--others', '--exclude-standard'], root));
  const count = {};
  for (const f of files) {
    if (f.split('/').some((seg) => SKIP_DIRS.has(seg))) continue;
    const l = EXT_LANG[f.split('.').pop().toLowerCase()];
    if (l) count[l] = (count[l] || 0) + 1;
  }
  for (const [l, n] of Object.entries(count)) if (n >= 3 && !s.langs.some((x) => x.split(' (')[0] === l)) s.langs.push(l);
  s.deps = [...new Set(s.deps.filter(Boolean))];
  s.test = s.tests.length ? s.tests.join(' && ') : null;
  return s;
}

const NOISE = [/(^|\/)node_modules\//, /(^|\/)\.git\//, /(^|\/)(dist|build|\.next|out|coverage|__pycache__|\.venv|venv)\//, /\.(png|jpe?g|gif|webp|ico|pdf|zip|woff2?|ttf|mp4|mov|lock)$/i, /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/, /^\.stet\/(\.cache|context\.md)/];
function listFiles(r) {
  let files;
  if (r.isGit()) files = names(r.tgit(['ls-files', '--cached', '--others', '--exclude-standard']));
  else {
    files = [];
    const walk = (d, rel) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (['node_modules', '.git', 'dist', 'build', '.venv', 'venv'].includes(e.name)) continue;
        const rp = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) walk(path.join(d, e.name), rp); else files.push(rp);
        if (files.length > 20000) return;
      }
    };
    walk(r.root, '');
  }
  const ign = r.config.ignore;
  return files.filter((f) => !NOISE.some((re) => re.test(f)) && !matches(f, ign)).sort();
}

function changedFiles(r, { base, staged } = {}) {
  if (!r.isGit()) return [];
  if (staged) return names(r.tgit(['diff', '--cached', '--name-only']));
  const set = new Set();
  if (r.head()) {
    const b = base && r.tgit(['rev-parse', '--verify', '--quiet', base + '^{commit}']).trim() ? base : 'HEAD';
    names(r.tgit(['diff', '--name-only', b])).forEach((f) => set.add(f));
  } else names(r.tgit(['diff', '--cached', '--name-only'])).forEach((f) => set.add(f));
  names(r.tgit(['ls-files', '--others', '--exclude-standard'])).forEach((f) => set.add(f));
  return [...set].sort();
}
// Build output and local data, not code: guard skips these unless they're in protected paths
// (or "guardGenerated": true in .stet/config.json). Your own "ignore" globs are skipped too.
const GENERATED = ['**/*.tsbuildinfo', '**/*.db', '**/*.sqlite', '**/*.sqlite3', '**/*.db-journal', '**/.DS_Store', '**/*.pyc', '**/__pycache__/**', '**/.pytest_cache/**', '**/.mypy_cache/**', '**/.ruff_cache/**', '**/*.log', '**/.next/**', '**/dist/**', '**/build/**', '**/coverage/**', '**/.turbo/**', '**/node_modules/**', '**/.vercel/**'];
const STET_OWNED = ['.stet/**', 'AGENTS.md', 'CLAUDE.md', 'HANDOFF.md', '.mcp.json', '.claude/settings.json'];

// ---------- templates ----------
function charterTemplate(name, st) {
  const stack = [...st.langs, ...st.frameworks].join(', ') || 'Describe your stack here';
  return `# ${name}

## What this is
<!-- One paragraph: what the product does, for whom, and what stage it is at. -->
${name} is ...

## Stack
- ${stack}
${st.tests.length ? `- Tests: ${st.tests.map((x) => '`' + x + '`').join(', ')}\n` : ''}${st.run.length ? `- Run: ${st.run.map((x) => '`' + x + '`').join(', ')}\n` : ''}
## Always
- Read this charter, the current scope and the locked behaviours before changing code.
- Make the smallest change that solves the task. Match the existing style and patterns.
- Keep changes inside the current scope. If the task needs more, stop and ask.
- Run \`stet check\` before saying a task is done, and report the result honestly.
- Record any architectural decision with \`stet decide\`.

## Never
- Never rewrite, rename or "clean up" working code outside the task.
- Never delete or weaken a test, check or validation to make something pass.
- Never add a dependency, service or env var without saying why.
- Never invent APIs, files, tables or config. If you are unsure, ask.
- Never commit secrets, keys or customer data.

## Notes for agents
<!-- Anything an AI keeps getting wrong in this repo: naming, folders, gotchas. -->
`;
}

// ---------- AGENTS.md / CLAUDE.md sync ----------
const BEGIN = '<!-- stet:begin -->', END = '<!-- stet:end -->';
function decisionsList(r) {
  const md = r.read('decisions.md');
  const out = [];
  const re = /^## (D-\d+) · (\S+) · (.+)$/gm; let m;
  while ((m = re.exec(md))) out.push({ id: m[1], date: m[2], title: m[3].trim() });
  return out;
}
function scopeBlock(r) {
  const s = r.scope;
  if (!s.task) return 'No scope is set. Before making broad changes, ask the human what the task is, or ask them to run `stet scope set`.';
  return `${s.ticket ? `**Ticket:** ${s.ticket}\n` : ''}**Task:** ${s.task}\n\nYou may change only:\n${s.allow.map((g) => `- \`${g}\``).join('\n')}\n\nIf the task needs a change outside this list, stop and ask. Do not tidy up, refactor or reformat other files.`;
}
function locksBlock(r) {
  const L = r.locks;
  if (!L.length) return 'No locked behaviours yet. The human adds them with `stet lock add`.';
  return `These already work and must keep working:\n\n| ID | Behaviour | Proof (must pass) | Files that affect it |\n|---|---|---|---|\n${L.map((l) => `| ${l.id} | ${l.name} | ${l.snapshot ? 'output of ' : ''}\`${l.cmd}\`${l.snapshot ? ' must match the approved snapshot' : ''} | ${(l.protect || []).map((g) => '`' + g + '`').join(', ') || '—'} |`).join('\n')}\n\nBefore saying any task is done, run \`stet check\`. If a check fails, fix your change. Never edit the test or weaken the check to make it pass.${L.some((l) => l.snapshot) ? ' Never edit files in `.stet/snapshots/` and never run `stet lock approve`: only the human approves a changed output.' : ''}`;
}
function agentsBlock(r) {
  const charter = r.read('charter.md').replace(/^# .*\n+/, '').replace(/<!--[\s\S]*?-->\n?/g, '').trim();
  const prot = r.config.protect;
  const ds = decisionsList(r).slice(-15);
  return `${BEGIN}
<!-- Generated by Stet from .stet/. Edit .stet/charter.md or use stet commands. Text outside this block is yours and is kept. -->
# Working agreement for AI coding agents — ${r.config.name}

This is the source of truth for any AI agent working in this repo (Claude Code, Cursor, Codex, Copilot, Windsurf or a chat assistant). Read all of it before changing code. If anything said earlier in a chat conflicts with this file, this file wins.

## Project charter
${charter.replace(/^## /gm, '### ')}

## Current task scope
${scopeBlock(r)}

## Locked behaviours
${locksBlock(r)}

## Protected paths
${prot.length ? `Do not modify these without explicit approval from the human:\n${prot.map((g) => `- \`${g}\``).join('\n')}` : 'None set.'}

## Decisions already made
${ds.length ? `Do not reopen these unless the human asks:\n${ds.map((d) => `- **${d.id}** (${d.date}) ${d.title}`).join('\n')}` : 'None yet.'}

## Workflow
1. Load the current repo state with \`stet context\` (or the MCP tool \`stet_context\`). Trust it over older chat history.
2. Work only inside the scope above.
3. Run \`stet guard\` to confirm you only changed in-scope files.
4. Run \`stet check\` to confirm every locked behaviour still passes.
5. Record new architectural decisions with \`stet decide "<decision>" --why "<reason>"\`.
6. For the commit message and pull request, run \`stet pr --what "<1–2 sentences: what changes and why>"\` (or the MCP tool \`stet_pr\` with \`what\`) and use its output exactly. Do not write your own PR description or edit its sections: \`stet pr lint\` rejects one that doesn't follow this repo's format. \`stet pr --create\` opens the PR for you; never run \`gh pr create\` or \`gh pr edit --body\` with a description you wrote.
7. Finish with a short summary: what changed, which files, check results and anything you were unsure about.

<sub>Kept in sync by [Stet](https://getstet.dev): guardrails for AI coding agents.</sub>
${END}`;
}
function sync(r) {
  r.need();
  const block = agentsBlock(r);
  const ap = path.join(r.root, 'AGENTS.md');
  const cur = r.rootFile('AGENTS.md');
  let next;
  if (cur == null) next = block + '\n';
  else if (cur.includes(BEGIN) && cur.includes(END)) next = cur.slice(0, cur.indexOf(BEGIN)) + block + cur.slice(cur.indexOf(END) + END.length);
  else next = block + '\n\n' + cur;
  const changed = next !== cur;
  if (changed) fs.writeFileSync(ap, next);
  const cl = r.rootFile('CLAUDE.md');
  if (cl == null) fs.writeFileSync(path.join(r.root, 'CLAUDE.md'), '# Claude Code\n\nThe working agreement for this repo lives in AGENTS.md (maintained by Stet):\n\n@AGENTS.md\n');
  else if (!cl.includes('@AGENTS.md')) fs.writeFileSync(path.join(r.root, 'CLAUDE.md'), cl.replace(/\s*$/, '') + '\n\n@AGENTS.md\n');
  return out(changed ? `${OK()} AGENTS.md updated` : `${OK()} AGENTS.md already in sync`, 0, { changed });
}

// ---------- init ----------
function init(r, { name, mcp, badge: addBadge, ci, agent, force } = {}) {
  // Stet already set up on the remote base, but not here: pulling is the fix, a second copy is the problem.
  if (r.isGit() && !fs.existsSync(r.p('config.json')) && !force) {
    const rs = remoteStet(r);
    if (rs) throw new StetError(`Stet is already set up on ${rs.ref}. Don't init again: a second .stet/ is what makes git pull fail.\n  Get the shared setup instead:  git pull ${rs.remote} ${rs.branch}\n  (Really start fresh? stet init --force)`);
  }
  const st = detect(r.root);
  const nm = name || r.config.name;
  const made = [], kept = [];
  const put = (f, s) => { if (fs.existsSync(r.p(f))) kept.push(f); else { r.write(f, s); made.push(f); } };
  put('config.json', JSON.stringify({ name: nm, version: 1, protect: [], ignore: [], maxFileKB: 64, checkTimeoutSec: 600 }, null, 2) + '\n');
  put('charter.md', charterTemplate(nm, st));
  put('locks.json', JSON.stringify(suggestedLocks(st).map((x, i) => ({ id: 'L' + (i + 1), name: x.name, cmd: x.cmd, protect: [], added: today() })), null, 2) + '\n');
  put('scope.json', '{}\n');
  put('decisions.md', `# Decision log — ${nm}\n\nOne entry per decision. Newest at the bottom. Managed with \`stet decide\`.\n\n## D-001 · ${today()} · Adopted Stet to keep AI agents in scope\nAI agents read AGENTS.md. Locked behaviours are checked with \`stet check\` before work is called done.\n`);
  put('.gitignore', '.cache/\ncontext.md\n');
  sync(r);
  const lines = [`${OK()} Stet initialised in ${c.bold(r.root)}`];
  if (!r.isGit()) lines.push(`${WARN()} This folder is not a git repo. guard, context and handoff work best with git.`);
  if (stetIgnored(r)) lines.push(IGNORED_NOTE(r));
  lines.push(`  stack:   ${[...st.langs, ...st.frameworks].join(', ') || 'not detected'}`);
  lines.push(`  created: ${made.map((f) => '.stet/' + f).join(', ') || 'nothing new'}${kept.length ? c.dim(`  (kept ${kept.length} existing)`) : ''}`);
  lines.push(`  wrote:   AGENTS.md, CLAUDE.md`);
  const auto = made.includes('locks.json') ? r.locks : [];
  for (const l of auto) lines.push(`  locked:  ${c.bold(l.id)} ${l.name} ${c.dim('(' + l.cmd + ')')}`);
  if (mcp) lines.push(mcpInstall(r).text);
  if (addBadge) { try { lines.push(badge(r, { add: true }).text); } catch (e) { lines.push(`${WARN()} ${e.message}`); } }
  if (ci) lines.push(ciWorkflow(r, { prFormat: ci === 'pr-format' }).text);
  if (agent) lines.push(agentInstall(r).text);
  lines.push('', c.bold('Next:'),
    `  1. Edit ${c.cyan('.stet/charter.md')} — one paragraph on what this is, plus your rules.`,
    `  2. ${auto.length ? `Your test suite is already locked (${auto.map((l) => l.id).join(', ')}). Lock 1–2 specific behaviours:` : 'Lock what already works:'}  ${c.cyan('stet lock add "Login works" --cmd "npm test -- auth" --protect "src/auth/**"')}`,
    `  3. Before each AI task:      ${c.cyan('stet scope set "Add CSV export" --allow "src/export/**,tests/export/**"')}`,
    `  4. After the AI is done:     ${c.cyan('stet guard && stet check')}`,
    `     Task finished:            ${c.cyan('stet scope done --commit')}  ${c.dim('(one task, one commit)')}`,
    `  5. Commit .stet/, AGENTS.md and CLAUDE.md once, on main, so every agent, teammate and CI run gets the same rules:`,
    `     ${c.cyan('git add .stet AGENTS.md CLAUDE.md && git commit -m "Add Stet"')}  ${c.dim('(teammates then git pull; they don\'t run init)')}`,
    ...(addBadge ? [] : [`  6. Optional: show contributors AI changes are guarded:  ${c.cyan('stet badge --add')}`]),
    ...(ci ? [] : [`  ${addBadge ? 6 : 7}. Optional: run the checks on every pull request:  ${c.cyan('stet ci')}`]),
    ...(agent ? [] : [`  ${6 + !addBadge + !ci}. Optional: block Claude Code from opening PRs in its own format:  ${c.cyan('stet agent')}`]));
  return out(lines.join('\n'));
}

// ---------- CI workflow ----------
// Writes .github/workflows/stet.yml: guard + check on every pull request, plus the PR format check.
function ciWorkflow(r, { force, prFormat = false } = {}) {
  r.need();
  const rel = '.github/workflows/stet.yml';
  const file = path.join(r.root, rel);
  if (fs.existsSync(file) && !force) return out(`${OK()} ${rel} already exists. Use --force to rewrite it.`, 0, { file: rel, written: false });
  const has = (f) => fs.existsSync(path.join(r.root, f));
  const setup = [];
  if (has('package.json')) {
    if (has('pnpm-lock.yaml')) setup.push('      - run: corepack enable && pnpm install --frozen-lockfile');
    else if (has('yarn.lock')) setup.push('      - run: corepack enable && yarn install --frozen-lockfile');
    else if (has('package-lock.json') || has('npm-shrinkwrap.json')) setup.push('      - run: npm ci');
    else setup.push('      - run: npm install');
  }
  if (has('requirements.txt') || has('pyproject.toml')) {
    setup.push('      - uses: actions/setup-python@v5', "        with: { python-version: '3.12' }");
    if (has('requirements.txt')) setup.push('      - run: pip install -r requirements.txt');
    else setup.push('      - run: pip install -e .');
  }
  const yml = [
    '# Stet: guardrails for AI coding agents (https://getstet.dev)',
    '# On every pull request: files outside the task scope, locked behaviours' + (prFormat ? ' and the PR description format.' : '.'),
    'name: Stet',
    'on:',
    '  pull_request:',
    `    types: [opened, ${prFormat ? 'edited, ' : ''}synchronize, reopened]`,
    'permissions:',
    '  contents: read',
    'jobs:',
    '  stet:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '        with: { fetch-depth: 0 }',
    '      - uses: actions/setup-node@v4',
    '        with: { node-version: 20 }',
    ...setup,
    '      - uses: shamazkhan/stet-action@v1',
    ...(prFormat ? ['        with:', '          pr-format: true'] : []),
    '',
  ].join('\n');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yml);
  return out([`${OK()} Wrote ${c.cyan(rel)}: stet guard and stet check on every pull request${prFormat ? ', and PR descriptions must follow the stet pr format' : ''}.`,
    ...(prFormat ? [] : [`  ${c.dim('PR descriptions are not checked. To require the stet pr format: stet ci --pr-format --force')}`]),
    ...(stetIgnored(r) ? [IGNORED_NOTE(r)] : []),
    setup.length ? `  ${c.dim('Installs dependencies first so your locks can run. Check the steps match your build.')}` : `  ${c.dim('No package.json or requirements.txt found: add your install step before the Stet step if your locks need one.')}`,
    `  Commit it: ${c.cyan(`git add ${rel} && git commit -m "Add Stet checks"`)}`].join('\n'), 0, { file: rel, written: true });
}

// ---------- decisions ----------
function decide(r, title, { why } = {}) {
  r.need();
  if (!title) throw new StetError('Usage: stet decide "<decision>" [--why "<reason>"]');
  const ds = decisionsList(r);
  const n = ds.length ? Math.max(...ds.map((d) => +d.id.slice(2))) + 1 : 1;
  const id = 'D-' + String(n).padStart(3, '0');
  const md = r.read('decisions.md').replace(/\s*$/, '\n');
  r.write('decisions.md', `${md}\n## ${id} · ${today()} · ${title.replace(/\n/g, ' ')}\n${why ? why.trim() + '\n' : ''}`);
  sync(r);
  return out(`${OK()} Logged ${c.bold(id)}: ${title}`, 0, { id });
}
function decisions(r, { all } = {}) {
  r.need();
  const ds = decisionsList(r);
  if (!ds.length) return out('No decisions logged yet.');
  return out((all ? ds : ds.slice(-10)).map((d) => `${c.violet(d.id)}  ${c.dim(d.date)}  ${d.title}`).join('\n'));
}

// ---------- locks ----------
// ---------- snapshot locks ----------
// A snapshot lock runs a command that prints some behaviour (an export, a route list, a mapped payload)
// and compares its output with an approved copy in .stet/snapshots/. Any difference fails stet check.
const crypto = require('crypto');
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 16);
function runLockCmd(r, cmd, cwd) {
  const t0 = Date.now();
  const p = cp.spawnSync(cmd, { cwd: cwd || r.root, shell: true, encoding: 'utf8', timeout: r.config.checkTimeoutSec * 1000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CI: process.env.CI || '1', FORCE_COLOR: '0', NO_COLOR: '1' } });
  return { p, ms: Date.now() - t0 };
}
// Normalise output so harmless differences don't fail: colours, CRLF, trailing spaces, trailing blank lines.
// --mask "<regex>" replaces volatile parts (timestamps, generated IDs) with <masked>.
function normalise(text, masks = []) {
  let t = String(text || '').replace(/\x1b\[[0-9;]*m/g, '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '');
  for (const m of masks) t = t.replace(new RegExp(m, 'g'), '<masked>');
  return t + '\n';
}
// Small line diff (LCS) for readable failures; falls back to "first difference" for very large outputs.
function lineDiff(a, b, max = 24) {
  const A = a.split('\n'), B = b.split('\n');
  if (A.length * B.length > 4e6) {
    let i = 0; while (i < A.length && i < B.length && A[i] === B[i]) i++;
    return [`@@ first difference at line ${i + 1} @@`, `- ${A[i] ?? '(end of output)'}`, `+ ${B[i] ?? '(end of output)'}`];
  }
  const n = A.length, m = B.length, L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const outL = []; let i = 0, j = 0, last = -10;
  while ((i < n || j < m) && outL.length < max) {
    if (i < n && j < m && A[i] === B[j]) { i++; j++; continue; }
    if (i - last > 1) outL.push(`@@ line ${i + 1} @@`);
    if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) { outL.push(`- ${A[i]}`); i++; } else { outL.push(`+ ${B[j]}`); j++; }
    last = i;
  }
  if (outL.length >= max) outL.push('… (more differences)');
  return outL;
}
const snapPath = (r, l) => r.p(l.snapshot);

// Locks Stet can set up from the stack: each test suite, and "TypeScript compiles" for each TS project.
function suggestedLocks(st) {
  const where = (cmd) => { const m = cmd.match(/^cd (\S+) && /); return m ? ` (${m[1]}/)` : ''; };
  return [...st.tests.map((cmd) => ({ name: where(cmd) ? `Test suite passes${where(cmd)}` : 'Full test suite passes', cmd })),
    ...(st.typechecks || []).map((cmd) => ({ name: `TypeScript compiles${where(cmd)}`, cmd }))];
}
function lockSuggest(r, { add } = {}) {
  r.need();
  const norm = (x) => String(x || '').trim().replace(/\s+/g, ' ');
  const have = new Set(r.locks.map((l) => norm(l.cmd)));
  const sugg = suggestedLocks(detect(r.root));
  // An old "pytest -q" lock in a project that has a virtualenv: point it at the venv instead of adding a duplicate.
  const fixes = [];
  for (const x of sugg) {
    const m = x.cmd.match(/^(cd \S+ && )?(\S+python(?:\.exe)?) -m pytest -q$/);
    if (!m) continue;
    const old = r.locks.find((l) => norm(l.cmd) === norm(`${m[1] || ''}pytest -q`));
    if (old) fixes.push({ id: old.id, cmd: x.cmd });
  }
  const todo = sugg.filter((x) => !have.has(norm(x.cmd)) && !fixes.some((f) => f.cmd === x.cmd));
  if (fixes.length && !add) return out([c.bold('Use your virtualenv, so these run without activating it:'), ...fixes.map((f) => `  ${c.cyan(`stet lock cmd ${f.id} "${f.cmd}"`)}`),
    ...(todo.length ? ['', c.bold(`And ${todo.length} more you could lock:`), ...todo.map((x) => `  ${c.cyan(`stet lock add "${x.name}" --cmd "${x.cmd}"`)}`)] : []), c.dim('  Do all of it: stet lock suggest --add')].join('\n'), 0, { fixes, suggested: todo });
  if (fixes.length && add) { for (const f of fixes) lockCmd(r, f.id, f.cmd); if (!todo.length) return out(fixes.map((f) => `${OK()} ${f.id} now runs: ${f.cmd}`).join('\n'), 0, { fixes }); }
  if (!todo.length) return out(`${OK()} Every test suite and type check Stet can find is already locked.`);
  if (add) return out(todo.map((x) => lockAdd(r, x.name, { cmd: x.cmd }).text).join('\n'), 0, { added: todo });
  return out([c.bold(`Stet found ${todo.length} behaviour${todo.length > 1 ? 's' : ''} you could lock:`),
    ...todo.map((x) => `  ${c.cyan(`stet lock add "${x.name}" --cmd "${x.cmd}"`)}`), c.dim('  Add them all: stet lock suggest --add')].join('\n'), 0, { suggested: todo });
}
function lockCmd(r, id, cmd) {
  r.need();
  if (!id || !cmd) throw new StetError('Usage: stet lock cmd L1 "<new command>"');
  const L = r.locks, l = L.find((x) => x.id.toLowerCase() === String(id).toLowerCase());
  if (!l) throw new StetError(`No lock ${id}. See: stet lock list`);
  if (l.snapshot) throw new StetError(`${l.id} is a snapshot lock: its output is approved as-is. Remove it and add it again with the new command.`);
  const was = l.cmd; l.cmd = cmd;
  r.wjson('locks.json', L); sync(r);
  return out(`${OK()} ${l.id} ${l.name}\n  was: ${c.dim(was)}\n  now: ${c.cyan(cmd)}`, 0, { id: l.id, cmd });
}
function lockRename(r, id, name) {
  r.need();
  if (!id || !name) throw new StetError('Usage: stet lock rename L1 "<behaviour>"');
  const L = r.locks; const l = L.find((x) => x.id.toLowerCase() === String(id).toLowerCase());
  if (!l) throw new StetError(`No lock with id ${id}. See: stet lock list`);
  const was = l.name; l.name = name; r.wjson('locks.json', L); sync(r);
  return out(`${OK()} Renamed ${c.bold(l.id)}: ${c.dim(was)} → ${name}`);
}
function lockAdd(r, name, { cmd, protect, snapshot, mask, force } = {}) {
  r.need();
  const useSnap = typeof snapshot === 'string' && snapshot.trim();
  if (!name || !(cmd || useSnap)) throw new StetError('Usage: stet lock add "<behaviour>" --cmd "<command that proves it>" [--protect "glob,glob"]\n   or: stet lock add "<behaviour>" --snapshot "<command that prints the behaviour>" [--mask "<regex>"]');
  const L = r.locks;
  // Same proof twice is noise (init already locks the test suite). Say which lock has it instead.
  const norm = (x) => String(x || '').trim().replace(/\s+/g, ' ');
  const want = norm(useSnap ? snapshot : cmd);
  const dup = L.find((x) => norm(x.cmd) === want && !!x.snapshot === !!useSnap);
  if (dup && !force) throw new StetError(`${dup.id} "${dup.name}" already ${useSnap ? 'snapshots' : 'runs'} \`${dup.cmd}\`. Not added.\n  Rename it: stet lock rename ${dup.id} "<behaviour>"   ·   add anyway: --force`);
  const n = L.length ? Math.max(...L.map((l) => +String(l.id).slice(1) || 0)) + 1 : 1;
  const l = { id: 'L' + n, name, cmd: useSnap ? snapshot.trim() : cmd, protect: splitList(protect), added: today() };
  if (useSnap) {
    const masks = splitList(mask);
    masks.forEach((m) => { try { new RegExp(m); } catch { throw new StetError(`--mask "${m}" is not a valid regular expression.`); } });
    const { p } = runLockCmd(r, l.cmd);
    if (p.status !== 0) throw new StetError(`The snapshot command failed (exit ${p.status}), so there's nothing to approve yet:\n${((p.stderr || '') + (p.stdout || '')).trim().split('\n').slice(-8).join('\n')}`);
    const body = normalise(p.stdout, masks);
    if (!body.trim()) throw new StetError('The snapshot command printed nothing. It should print the behaviour to lock (an export, a list of routes, mapped data…).');
    l.snapshot = `snapshots/${l.id}.txt`; l.mask = masks; l.snapshotHash = sha(body); l.approved = new Date().toISOString();
    r.write(l.snapshot, body);
  }
  L.push(l); r.wjson('locks.json', L); sync(r);
  return out(`${OK()} Locked ${c.bold(l.id)}: ${name}\n  ${useSnap ? 'snapshot of' : 'proof:'} ${c.cyan(l.cmd)}${useSnap ? c.dim(`  → .stet/${l.snapshot} (${l.snapshotHash ? normaliseLines(r, l) : 0} lines)`) : ''}${l.protect.length ? `\n  watches: ${l.protect.join(', ')}` : ''}${useSnap ? `\n  ${c.dim('Commit .stet/snapshots/ so your team checks against the same approved output.')}` : ''}`, 0, l);
}
const normaliseLines = (r, l) => { try { return fs.readFileSync(snapPath(r, l), 'utf8').split('\n').length - 1; } catch { return 0; } };

// Accept an intended change: re-run the command, save the new output as approved, and log why.
function lockApprove(r, id, { why } = {}) {
  r.need();
  const L = r.locks; const l = L.find((x) => x.id.toLowerCase() === String(id || '').toLowerCase());
  if (!l) throw new StetError(`No lock with id ${id}. See: stet lock list`);
  if (!l.snapshot) throw new StetError(`${l.id} is a command lock, not a snapshot. Fix the code or the test instead.`);
  const { p } = runLockCmd(r, l.cmd);
  if (p.status !== 0) throw new StetError(`The snapshot command failed (exit ${p.status}); nothing approved.`);
  const body = normalise(p.stdout, l.mask);
  let old = ''; try { old = fs.readFileSync(snapPath(r, l), 'utf8'); } catch {}
  if (old === body) return out(`${OK()} ${l.id} output is unchanged; nothing to approve.`);
  const diff = lineDiff(old, body, 12);
  r.write(l.snapshot, body); l.snapshotHash = sha(body); l.approved = new Date().toISOString();
  r.wjson('locks.json', L);
  decide(r, `Approved new snapshot for ${l.id} ${l.name}`, { why: why || 'Intended change (no reason given).' });
  return out(`${OK()} Approved new output for ${c.bold(l.id)} ${l.name}\n${c.dim(diff.map((x) => '     │ ' + x).join('\n'))}\n  Logged as a decision. Commit .stet/snapshots/ with your change.`);
}
function lockList(r) {
  r.need();
  const L = r.locks;
  if (!L.length) return out('No locked behaviours. Add one with: stet lock add "<behaviour>" --cmd "<command>"');
  const last = r.json('.cache/last-check.json', { results: [] });
  return out(L.map((l) => {
    const res = last.results.find((x) => x.id === l.id);
    const mark = !res ? c.dim('·') : res.ok ? OK() : BAD();
    return `${mark} ${c.bold(l.id.padEnd(4))} ${l.name}${l.snapshot ? c.dim('  [snapshot]') : ''}\n     ${c.dim('$')} ${c.cyan(l.cmd)}${l.protect && l.protect.length ? c.dim('  watches ' + l.protect.join(', ')) : ''}`;
  }).join('\n'));
}
function lockRm(r, id) {
  r.need();
  const L = r.locks; const i = L.findIndex((l) => l.id.toLowerCase() === String(id).toLowerCase());
  if (i < 0) throw new StetError(`No lock with id ${id}. See: stet lock list`);
  const [l] = L.splice(i, 1); r.wjson('locks.json', L); sync(r);
  return out(`${OK()} Removed ${l.id}: ${l.name}`);
}
// ---------- baseline: was it already failing on main? ----------
// Re-runs only the failing locks on the base commit (merge-base with the remote base branch) in a temporary
// git worktree that shares this checkout's installed dependencies (node_modules, .venv, .env files).
const SHARED_DEPS = ['node_modules', '.venv', 'venv', 'env', '.env', '.env.local', '.env.test', '.env.development'];
function baselineRun(r, locks, { noFetch } = {}) {
  if (!r.isGit() || !r.head()) return null;
  const bs = baseStatus(r, { noFetch: noFetch || !!process.env.GITHUB_ACTIONS });
  const sha = bs && !bs.missing && bs.mergeBase ? bs.mergeBase : r.head(true);
  const label = bs && !bs.missing ? bs.ref : 'HEAD';
  // On the base itself with nothing changed there is nothing to compare: a failure is simply a failure.
  if (sha === r.head(true) && !dirtyFiles(r).length) return null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stet-base-'));
  const res = {};
  try {
    const add = cp.spawnSync('git', ['worktree', 'add', '--detach', '--quiet', tmp, sha], { cwd: r.root, encoding: 'utf8' });
    if (add.status !== 0) return null;
    for (const rel of ['', ...projectDirs(r.root).filter(Boolean)]) {
      for (const d of SHARED_DEPS) {
        const src = path.join(r.root, rel, d), dst = path.join(tmp, rel, d);
        if (fs.existsSync(src) && !fs.existsSync(dst) && fs.existsSync(path.dirname(dst))) {
          try { fs.symlinkSync(src, dst, fs.statSync(src).isDirectory() ? 'junction' : 'file'); } catch {}
        }
      }
    }
    for (const l of locks) {
      const { p } = runLockCmd(r, l.cmd, tmp);
      let ok = p.status === 0;
      if (ok && l.snapshot) { let approved = null; try { approved = fs.readFileSync(snapPath(r, l), 'utf8'); } catch {} ok = approved != null && normalise(p.stdout, l.mask) === approved; }
      // Couldn't even run on the base (the check file is new, a script is missing...): no verdict either way.
      const txt = (p.stderr || '') + (p.stdout || '');
      const cantRun = !ok && (p.status === 127 || /Cannot find module|MODULE_NOT_FOUND|ENOENT|No such file or directory|command not found|Missing script:|is not recognized as an internal|can't open file|file or directory not found/i.test(txt));
      res[l.id] = cantRun ? null : ok;
    }
  } finally {
    cp.spawnSync('git', ['worktree', 'remove', '--force', tmp], { cwd: r.root });
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    cp.spawnSync('git', ['worktree', 'prune'], { cwd: r.root });
  }
  return { sha, label, res };
}

function check(r, { only, baseline, noFetch } = {}) {
  r.need();
  let L = r.locks;
  if (only) { const ids = splitList(only).map((s) => s.toLowerCase()); L = L.filter((l) => ids.includes(l.id.toLowerCase())); }
  if (!L.length) return out(`${WARN()} Nothing to check. Lock a behaviour first: stet lock add "<behaviour>" --cmd "<command>"`);
  const lines = [c.bold(`Checking ${L.length} locked behaviour${L.length > 1 ? 's' : ''}`)];
  const results = [];
  for (const l of L) {
    const { p, ms } = runLockCmd(r, l.cmd);
    if (l.snapshot) {
      let approved = null; try { approved = fs.readFileSync(snapPath(r, l), 'utf8'); } catch {}
      const ran = p.status === 0;
      const now = ran ? normalise(p.stdout, l.mask) : null;
      const same = ran && approved != null && now === approved;
      const cantRun = !ran && (p.status === 127 || /Missing script:|command not found|is not recognized as an internal|ENOENT/i.test((p.stderr || '') + (p.stdout || '')));
      results.push({ id: l.id, name: l.name, ok: same, ms, exit: p.status, cantRun, snapshot: true });
      lines.push(`${same ? OK() : cantRun ? WARN() : BAD()} ${c.bold(l.id.padEnd(4))} ${l.name} ${c.dim(`(${(ms / 1000).toFixed(1)}s, snapshot)`)}${cantRun ? c.yellow('  snapshot command cannot run') : ''}`);
      if (approved == null) lines.push(c.dim(`     │ approved snapshot .stet/${l.snapshot} is missing — re-add the lock or restore the file`));
      else if (!ran) lines.push(c.dim(((p.stderr || '') + (p.stdout || '')).trim().split('\n').slice(-6).map((x) => '     │ ' + x).join('\n')));
      else if (!same) lines.push(c.dim(['output differs from the approved snapshot (- approved, + now):', ...lineDiff(approved, now)].map((x) => '     │ ' + x).join('\n')), c.dim(`     │ intended? approve it: stet lock approve ${l.id} --why "<reason>"`));
      continue;
    }
    const ok = p.status === 0;
    const all = ((p.stdout || '') + (p.stderr || '')).replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n');
    const KEY = /(not ok|fail(ed|ure)?\b|error|expected|actual|assert|✗|×|panic|traceback|exception)/i;
    const SKIP = /^\s*#\s*(fail|pass|tests|suites)\s+\d+|failureType|duration_ms|^\s*code:|^\s*\.\.\.$|^\s*error:\s*\|-?\s*$|^\s*name:\s*'?AssertionError'?\s*$|^\s*operator:/i;
    const hits = all.filter((x) => KEY.test(x) && !SKIP.test(x)).map((x) => x.trim()).filter((x, i, a) => a.indexOf(x) === i).slice(0, 10);
    const tail = (hits.length ? hits : all.slice(-12)).join('\n');
    const cantRun = !ok && (p.status === 127 || /Missing script:|command not found|is not recognized as an internal|ENOENT|No such file or directory.*(\.js|\.py)/i.test(all.join('\n')));
    results.push({ id: l.id, name: l.name, ok, ms, exit: p.status, cantRun, timedOut: !!(p.error && p.error.code === 'ETIMEDOUT') });
    lines.push(`${ok ? OK() : cantRun ? WARN() : BAD()} ${c.bold(l.id.padEnd(4))} ${l.name} ${c.dim(`(${(ms / 1000).toFixed(1)}s)`)}${cantRun ? c.yellow('  proof command cannot run') : ''}`);
    if (!ok) lines.push(c.dim(tail.split('\n').map((x) => '     │ ' + x).join('\n')));
  }
  let failed = results.filter((x) => !x.ok);
  // Baseline: re-run what failed on the base. Failing there too = already broken on main, not this change.
  let base = null;
  const toCompare = failed.filter((x) => !x.cantRun);
  if (toCompare.length && baseline !== false && r.config.baseline !== false) {
    base = baselineRun(r, L.filter((l) => toCompare.some((x) => x.id === l.id)), { noFetch });
    if (base) for (const x of toCompare) if (base.res[x.id] === false) x.preexisting = true;
  }
  const pre = failed.filter((x) => x.preexisting);
  const broken = failed.filter((x) => !x.cantRun && !x.preexisting), bad = failed.filter((x) => x.cantRun);
  r.wjson('.cache/last-check.json', { at: new Date().toISOString(), head: r.head(), results, baseline: base ? { sha: base.sha, ref: base.label } : null });
  if (base) {
    lines.push('', c.dim(`Compared failures with ${base.label} (${base.sha.slice(0, 7)}):`));
    for (const x of toCompare) {
      const v = base.res[x.id];
      lines.push(`  ${x.preexisting ? WARN() : v === null ? c.dim('·') : BAD()} ${c.bold(x.id.padEnd(4))} ${x.preexisting ? c.yellow(`already failing on ${base.label}, not caused by this change`) : v === null ? c.dim(`can't run on ${base.label} (new check?), so no comparison`) : c.red(`passes on ${base.label}: broken by this change`)}`);
    }
  }
  // Breaks that were already on main don't fail your check (set "failOnPreexisting": true to make them).
  const strictPre = r.config.failOnPreexisting === true;
  failed = failed.filter((x) => !x.preexisting || strictPre);
  lines.push('');
  if (pre.length) lines.push(`${WARN()} ${c.yellow(`${pre.map((f) => f.id).join(', ')} ${pre.length > 1 ? 'were' : 'was'} already failing on ${base.label}.`)} Not this change${strictPre ? '' : ', so it doesn\'t fail this check'}. Worth fixing on ${base.label} separately.`);
  if (bad.length) lines.push(`${WARN()} ${c.yellow(`${bad.map((f) => f.id).join(', ')}: the proof command itself can't run (missing script or command).`)} Fix it: ${c.cyan(`stet lock cmd ${bad[0].id} "<a command that works>"`)}${L.some((l) => bad.some((b) => b.id === l.id) && /(^|&& )pytest\b/.test(l.cmd)) ? `\n  ${c.dim('pytest not found? Your virtualenv probably isn\'t active. See: stet lock suggest')}` : ''}`);
  if (broken.length) lines.push(`${BAD()} ${c.red(`${broken.length} locked behaviour${broken.length > 1 ? 's' : ''} broken: ${broken.map((f) => f.id).join(', ')}.`)} Fix the change, not the check.`);
  if (!failed.length) lines.push(`${OK()} ${c.green(pre.length ? 'Nothing this change broke.' : 'All locked behaviours pass.')}`);
  return out(lines.join('\n'), failed.length ? 1 : 0, { results, baseline: base ? { ref: base.label, sha: base.sha, preexisting: pre.map((x) => x.id) } : null });
}

// ---------- scope + guard ----------
// Ticket IDs look like LIN-142, ENG-7, PROJ-1203 (Linear, Jira, Shortcut style).
// ---------- remote base ----------
// The branch PRs go into (origin/main by default). Stet fetches it (at most once a minute, 10s timeout)
// so comparisons use the up-to-date remote, and warns when the local branch is behind it.
function remoteBase(r) {
  if (!r.isGit() || !r.head()) return null;
  const remotes = names(r.tgit(['remote']));
  if (!remotes.length) return null;
  const remote = remotes.includes('origin') ? 'origin' : remotes[0];
  const cfg = String(r.config.baseBranch || '').trim();
  let branch = cfg.replace(new RegExp(`^${remote}/`), '');
  if (!branch) branch = r.tgit(['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]).trim().replace(new RegExp(`^${remote}/`), '');
  if (!branch) for (const b of ['main', 'master', 'develop']) if (r.tgit(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${b}`]).trim()) { branch = b; break; }
  if (!branch) branch = 'main';
  return { remote, branch, ref: `${remote}/${branch}` };
}
const fetchOff = (r, noFetch) => noFetch || process.env.STET_NO_FETCH === '1' || r.config.fetch === false;
function fetchBase(r, rb, { noFetch } = {}) {
  if (fetchOff(r, noFetch)) return { skipped: true };
  const cache = r.json('.cache/fetch.json', {});
  if (cache[rb.ref] && Date.now() - cache[rb.ref] < 60 * 1000) return { ok: true, cached: true };
  const p = cp.spawnSync('git', ['fetch', '--quiet', '--no-tags', rb.remote, rb.branch], { cwd: r.root, encoding: 'utf8', timeout: 10000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  // Remember failures too, so an offline laptop doesn't wait on every guard run.
  cache[rb.ref] = Date.now(); try { r.wjson('.cache/fetch.json', cache); } catch {}
  if (p.status !== 0) return { error: p.error ? 'timed out' : (p.stderr || 'fetch failed').trim().split('\n').pop() };
  return { ok: true };
}
const refOk = (r, ref) => !!r.tgit(['rev-parse', '--verify', '--quiet', ref + '^{commit}']).trim();
const count = (r, range) => +r.tgit(['rev-list', '--count', range]).trim() || 0;
// Where this branch stands against the remote base: commits behind/ahead, and whether a local copy of the base is stale.
function baseStatus(r, { noFetch } = {}) {
  const rb = remoteBase(r);
  if (!rb) return null;
  const fetch = fetchBase(r, rb, { noFetch });
  if (!refOk(r, rb.ref)) return { ...rb, fetch, missing: true };
  const st = { ...rb, fetch, mergeBase: r.tgit(['merge-base', 'HEAD', rb.ref]).trim(), behind: count(r, `HEAD..${rb.ref}`), ahead: count(r, `${rb.ref}..HEAD`), localBehind: 0 };
  if (refOk(r, `refs/heads/${rb.branch}`)) st.localBehind = count(r, `refs/heads/${rb.branch}..${rb.ref}`);
  return st;
}
function baseWarnings(bs, { starting } = {}) {
  if (!bs) return [];
  const w = [];
  if (bs.fetch && bs.fetch.error) w.push(`${WARN()} Couldn't fetch ${bs.ref} (${bs.fetch.error}). Comparing with the last fetched copy.`);
  if (bs.missing) return w;
  if (bs.behind) w.push(`${WARN()} ${c.yellow(`${starting ? 'Starting' : 'This branch is'} ${bs.behind} commit${bs.behind > 1 ? 's' : ''} behind ${bs.ref}.`)} ${starting ? 'Pull first so the agent works on current code' : 'Update it before opening a PR'}: git pull --rebase ${bs.remote} ${bs.branch}`);
  return w;
}
// An explicit --base naming the remote base's branch ("main") uses the up-to-date remote copy if the local one is behind.
function resolveBase(r, want, bs) {
  if (!want || !bs || bs.missing) return { base: want, note: null };
  if ((want === bs.branch || want === `refs/heads/${bs.branch}`) && bs.localBehind) {
    return { base: bs.mergeBase || bs.ref, note: `${WARN()} Local ${bs.branch} is ${bs.localBehind} commit${bs.localBehind > 1 ? 's' : ''} behind ${bs.ref}. Compared with ${bs.ref} instead.` };
  }
  if (want === bs.ref || want === bs.branch) return { base: bs.mergeBase || want, note: null };
  return { base: want, note: null };
}

// Is Stet already set up on the remote base branch? (Two people running init separately is what makes git pull fail.)
function remoteStet(r, { noFetch } = {}) {
  const rb = remoteBase(r);
  if (!rb) return null;
  // Fetch directly (not through the once-a-minute cache, so later commands still fetch fresh).
  if (!fetchOff(r, noFetch)) cp.spawnSync('git', ['fetch', '--quiet', '--no-tags', rb.remote, rb.branch], { cwd: r.root, timeout: 10000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const bs = baseStatus(r, { noFetch: true });
  if (!bs || bs.missing) return null;
  return r.tgit(['ls-tree', '--name-only', bs.ref, '.stet/config.json']).trim() ? bs : null;
}
const stetIgnored = (r) => r.isGit() && cp.spawnSync('git', ['check-ignore', '-q', '.stet/config.json'], { cwd: r.root }).status === 0;
const stetTracked = (r) => !!r.tgit(['ls-files', '.stet/config.json']).trim();
const IGNORED_NOTE = (r) => `${WARN()} ${c.yellow('Your .gitignore ignores .stet/.')} Teammates and CI can't see your locks or scope, so the PR check passes with warnings. Remove it from .gitignore and commit .stet/ (Stet already keeps its own cache out of git).`;
// Globs in --allow that match no file. Fine for a file the task will create, but often a typo: say so, and suggest a match.
function unmatchedGlobs(r, globs) {
  const files = r.isGit() ? names(r.tgit(['ls-files', '--cached', '--others', '--exclude-standard'])) : listFiles(r);
  const res = [];
  for (const g of globs) {
    if (files.some((f) => matches(f, [g]))) continue;
    const base = g.split('/').pop().replace(/\*+/g, '');
    const near = base && base.length > 2 ? files.filter((f) => f.split('/').pop() === base).slice(0, 2) : [];
    res.push({ glob: g, near });
  }
  return res;
}
const unmatchedNote = (um) => um.map((u) => `${WARN()} ${c.yellow(`--allow "${u.glob}" matches no file yet.`)} ${u.near.length ? `Did you mean ${u.near.map((n) => c.cyan(n)).join(' or ')}?` : 'Fine if the task creates it; otherwise check the path.'}`);

const TICKET_RE = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/;
// Files already uncommitted when a scope starts are "carried": earlier work, not the agent's.
// Each is fingerprinted so guard ignores it while untouched and flags it if it changes again.
const fileHash = (r, f) => { try { return sha(fs.readFileSync(path.join(r.root, f))); } catch { return 'deleted'; } };
const dirtyFiles = (r) => (r.isGit() ? changedFiles(r, { base: 'HEAD' }).filter((f) => !matches(f, STET_OWNED)) : []);
const fmtList = (fs_, n = 6) => fs_.slice(0, n).join(' · ') + (fs_.length > n ? c.dim(` +${fs_.length - n} more`) : '');

function scopeSet(r, task, { allow, ticket, strict, includeCurrent } = {}) {
  r.need();
  const a = splitList(allow);
  if (!task || !a.length) throw new StetError('Usage: stet scope set "<task>" --allow "src/feature/**,tests/feature/**" [--ticket LIN-142] [--strict]');
  const dirty = dirtyFiles(r);
  if (dirty.length && strict) throw new StetError(`--strict: ${dirty.length} uncommitted file${dirty.length > 1 ? 's' : ''} from earlier work:\n  ${fmtList(dirty, 10)}\nCommit or stash them first, or drop --strict to carry them into this scope.`);
  // Ticket: explicit --ticket wins, otherwise taken from the task text ("LIN-142 Add CSV export").
  let t = typeof ticket === 'string' ? ticket.trim().toUpperCase() : (task.match(TICKET_RE) || [])[1] || null;
  if (t && !TICKET_RE.test(t)) throw new StetError(`"${ticket}" doesn't look like a ticket ID (expected something like LIN-142).`);
  const cleanTask = t ? task.replace(new RegExp(`^\\s*${t}\\s*[:\\-–—]?\\s*`), '').trim() || task : task;
  const decided = decisionsList(r);
  // --include-current: changes already made count as part of this task (checked like any other change).
  const carried = includeCurrent ? [] : dirty.map((file) => ({ file, hash: fileHash(r, file) }));
  const branch = r.tgit(['rev-parse', '--abbrev-ref', 'HEAD']).trim() || null;
  r.wjson('scope.json', { ticket: t, task: cleanTask, allow: a, base: r.head(true) || null, branch: branch === 'HEAD' ? null : branch, set: new Date().toISOString(), decisionsBefore: decided.length, carried });
  sync(r);
  const behind = baseWarnings(baseStatus(r), { starting: true });
  const carriedNote = carried.length
    ? `\n${WARN()} ${c.yellow(`${carried.length} file${carried.length > 1 ? 's were' : ' was'} already changed before this scope, so guard will ignore ${carried.length > 1 ? 'them' : 'it'} unless ${carried.length > 1 ? 'they change' : 'it changes'} again:`)}\n  ${fmtList(dirty)}\n  ${c.dim(`Part of this task? Re-run with --include-current. Earlier work? Commit it first (stet scope done --commit). Refuse next time: --strict.`)}`
    : includeCurrent && dirty.length ? `\n  ${c.dim(`${dirty.length} file${dirty.length > 1 ? 's' : ''} already changed are counted as part of this task (--include-current).`)}` : '';
  const um = unmatchedGlobs(r, a);
  return out(`${OK()} Scope set: ${t ? c.violet(t) + ' ' : ''}${c.bold(cleanTask)}\n  allowed: ${a.map((g) => c.cyan(g)).join(', ')}\n  base:    ${r.head() || '(no commits)'} — guard compares everything changed since here${t ? `\n  ticket:  ${t} is added to commit messages (stet hook install) and PR text (stet pr)` : ''}${carriedNote}${um.length ? '\n' + unmatchedNote(um).join('\n') : ''}${behind.length ? '\n' + behind.join('\n') : ''}`, 0, { carried, unmatched: um.map((u) => u.glob) });
}

// Widen (or narrow) an open scope without resetting it: the task, base and carried files stay as they are.
function scopeAdd(r, globs) {
  r.need();
  const s = r.scope;
  if (!s.task) throw new StetError('No scope set. Start one first: stet scope set "<task>" --allow "<globs>"');
  const add = splitList(globs);
  if (!add.length) throw new StetError('Usage: stet scope add "<glob,glob>"   e.g. stet scope add "src/api/export.ts,tests/api/**"');
  const fresh = add.filter((g) => !s.allow.includes(g));
  if (!fresh.length) return out(`${OK()} Already in scope: ${add.map((g) => c.cyan(g)).join(', ')}`);
  s.allow = [...s.allow, ...fresh];
  s.changes = [...(s.changes || []), { added: fresh, at: new Date().toISOString() }];
  r.wjson('scope.json', s); sync(r);
  const um = unmatchedGlobs(r, fresh);
  return out([`${OK()} Added to scope: ${fresh.map((g) => c.cyan(g)).join(', ')}\n  allowed: ${s.allow.map((g) => c.cyan(g)).join(', ')}\n  ${c.dim('Task, base and carried files are unchanged. The PR text notes that the scope was widened.')}`, ...unmatchedNote(um)].join('\n'), 0, { allow: s.allow, added: fresh, unmatched: um.map((u) => u.glob) });
}
function scopeRemove(r, globs) {
  r.need();
  const s = r.scope;
  if (!s.task) throw new StetError('No scope set.');
  const rm = splitList(globs);
  if (!rm.length) throw new StetError('Usage: stet scope remove "<glob,glob>"');
  const gone = rm.filter((g) => s.allow.includes(g));
  if (!gone.length) throw new StetError(`Not in scope: ${rm.join(', ')}. Allowed: ${s.allow.join(', ')}`);
  if (gone.length === s.allow.length) throw new StetError('That would leave the scope empty. Use stet scope clear to close it.');
  s.allow = s.allow.filter((g) => !gone.includes(g));
  s.changes = [...(s.changes || []), { removed: gone, at: new Date().toISOString() }];
  r.wjson('scope.json', s); sync(r);
  return out(`${OK()} Removed from scope: ${gone.map((g) => c.cyan(g)).join(', ')}\n  allowed: ${s.allow.map((g) => c.cyan(g)).join(', ')}`, 0, { allow: s.allow, removed: gone });
}

// Mark files as earlier work after the fact (e.g. guard flagged leftovers from a previous task).
// With no files and --all, carries every file guard currently reports as out of scope.
function scopeCarry(r, files, { all } = {}) {
  r.need();
  const s = r.scope;
  if (!s.task) throw new StetError('No scope set. Carrying only applies to an open scope: stet scope set "<task>" --allow "<globs>"');
  const changed = changedFiles(r, { base: s.base }).filter((f) => !matches(f, STET_OWNED));
  let pick;
  if (all) pick = changed.filter((f) => !matches(f, s.allow));
  else {
    const globs = splitList(files);
    if (!globs.length) throw new StetError('Usage: stet scope carry <file|glob,…>   or: stet scope carry --all   (all current out-of-scope files)');
    pick = changed.filter((f) => globs.includes(f) || matches(f, globs));
    const missing = globs.filter((g) => !changed.some((f) => f === g || matches(f, [g])));
    if (missing.length && !pick.length) throw new StetError(`Nothing to carry: ${missing.join(', ')} ${missing.length > 1 ? 'have' : 'has'} no changes since the scope was set.`);
  }
  if (!pick.length) return out(`${OK()} Nothing to carry: no out-of-scope changes.`);
  const map = new Map((s.carried || []).map((x) => [x.file, x]));
  for (const f of pick) map.set(f, { file: f, hash: fileHash(r, f), late: true });
  s.carried = [...map.values()].sort((a, b) => a.file.localeCompare(b.file));
  r.wjson('scope.json', s);
  return out(`${OK()} Carried ${pick.length} file${pick.length > 1 ? 's' : ''} as earlier work. Guard ignores ${pick.length > 1 ? 'them' : 'it'} unless ${pick.length > 1 ? 'they change' : 'it changes'} again:\n  ${fmtList(pick, 10)}`, 0, { carried: pick });
}

// Close a task: guard + check, then (optionally) commit the task's files and clear the scope.
function scopeDone(r, { commit, force } = {}) {
  r.need();
  const s = r.scope;
  if (!s.task) throw new StetError('No scope is open. Nothing to finish.');
  const g = guard(r, { warn: true });
  const ch = r.locks.length ? check(r) : null;
  const lines = [c.bold(`Finishing: ${s.ticket ? s.ticket + ' ' : ''}${s.task}`), '', g.text];
  if (ch) lines.push('', ch.text);
  const okGuard = !g.data.violations.length, okCheck = !ch || ch.code === 0;
  lines.push('');
  if ((!okGuard || !okCheck) && !force) {
    lines.push(`${BAD()} ${c.red('Not finished:')} ${[!okGuard && 'out-of-scope changes', !okCheck && 'a locked behaviour is failing'].filter(Boolean).join(' and ')}. The scope stays open.`, c.dim('  Fix it, or close anyway with: stet scope done --force'));
    return out(lines.join('\n'), 1, { guard: g.data, check: ch && ch.data });
  }
  const taskFiles = g.data.files.filter((f) => !g.data.violations.includes(f));
  if (commit && taskFiles.length) {
    const msg = pr(r, {}).data.commit;
    r.tgit(['add', '-A', '--', ...taskFiles]);
    // --no-verify: guard and check just ran on exactly these files, so the pre-commit hook would only repeat them.
    const p =cp.spawnSync('git', ['commit', '-q', '--no-verify', '-F', '-'], { cwd: r.root, input: msg, encoding: 'utf8' });
    if (p.status !== 0) throw new StetError(`git commit failed: ${((p.stderr || '') + (p.stdout || '')).trim()}`);
    lines.push(`${OK()} Committed ${taskFiles.length} file${taskFiles.length > 1 ? 's' : ''} as ${c.bold(r.head())}: ${msg.split('\n')[0]}`);
  } else if (taskFiles.length) {
    lines.push(`${WARN()} ${taskFiles.length} task file${taskFiles.length > 1 ? 's are' : ' is'} not committed yet. Commit them before the next task:`, c.dim(`  git add ${taskFiles.slice(0, 4).join(' ')}${taskFiles.length > 4 ? ' …' : ''} && git commit   (or: stet scope done --commit)`));
  }
  r.wjson('scope.json', {}); sync(r);
  lines.push(`${OK()} Scope closed.${!okGuard || !okCheck ? c.yellow(' (forced)') : ''}`);
  return out(lines.join('\n'), 0, { committed: commit ? taskFiles : [] });
}
function scopeShow(r) {
  r.need(); const s = r.scope;
  if (!s.task) return out('No scope set. Set one before an AI task: stet scope set "<task>" --allow "<globs>"');
  const cr = (s.carried || []).map((x) => x.file);
  return out(`${s.ticket ? `${c.bold('Ticket:')} ${s.ticket}\n` : ''}${c.bold('Task:')} ${s.task}\n${c.bold('Allowed:')} ${s.allow.join(', ')}${cr.length ? `\n${c.bold('Carried')} (earlier work, ignored unless changed again): ${cr.join(', ')}` : ''}${(s.changes || []).length ? `\n${c.bold('Changed')}: ${s.changes.map((x) => (x.added ? '+' + x.added.join(', +') : '−' + x.removed.join(', −'))).join('; ')}` : ''}\n${c.dim(`Set ${s.set} at ${s.base ? s.base.slice(0, 7) : 'no commit'}`)}`);
}
// Prints only the ticket ID (or nothing). Used by the prepare-commit-msg hook.
function scopeTicket(r) { r.need(); return out(r.scope.ticket || ''); }
function scopeClear(r) { r.need(); r.wjson('scope.json', {}); sync(r); return out(`${OK()} Scope cleared.`); }

function guard(r, { base, staged, warn, noFetch, remote } = {}) {
  r.need();
  if (!r.isGit()) throw new StetError('stet guard needs a git repo.');
  let s = r.scope; const cfg = r.config, L = r.locks;
  // A scope belongs to the branch it was set on. On another branch (main, a teammate's branch) only
  // protected paths and locks apply, so the commit hook doesn't block unrelated work.
  const here = r.tgit(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const otherBranch = s.task && s.branch && here && here !== 'HEAD' && here !== s.branch && !process.env.GITHUB_ACTIONS;
  if (otherBranch) s = { ...s, allow: [], task: null, carried: [] };
  // In GitHub Actions the workflow has already fetched and passes --base, so skip the network.
  const bs = staged || remote === false ? null : baseStatus(r, { noFetch: noFetch || !!process.env.GITHUB_ACTIONS });
  const rv = resolveBase(r, base, bs);
  base = rv.base;
  const all = changedFiles(r, { base: base || s.base, staged }).filter((f) => !matches(f, STET_OWNED));
  const skipped = all.filter((f) => !matches(f, cfg.protect) && (matches(f, cfg.ignore) || (cfg.guardGenerated !== true && matches(f, GENERATED))));
  const { untouched, retouched } = carriedState(r, s, all);
  const files = all.filter((f) => !untouched.includes(f) && !skipped.includes(f));
  const outScope = [], protectedHits = [], lockHits = [];
  for (const f of files) {
    if (s.allow && s.allow.length && !matches(f, s.allow)) outScope.push(f);
    if (matches(f, cfg.protect)) protectedHits.push(f);
    for (const l of L) if (matches(f, l.protect)) lockHits.push({ f, l });
  }
  const lines = [];
  const what = staged ? 'staged files' : `changes since ${(base || s.base || 'HEAD').slice(0, 7)}`;
  lines.push(c.bold(`Guarding ${files.length} changed file${files.length === 1 ? '' : 's'}`) + c.dim(` (${what})`) + (s.task ? c.dim(` · ${s.ticket ? s.ticket + ' ' : 'task: '}${s.task}`) : ''));
  if (otherBranch) lines.push(c.dim(`  · The open scope belongs to branch ${r.scope.branch}; on ${here} only protected paths and locks are checked.`));
  else if (!s.task && !staged) lines.push(`${WARN()} No scope set, so only protected paths and locks are checked. Set one: stet scope set "<task>" --allow "<globs>"`);
  if (rv.note) lines.push(rv.note);
  const behindLines = baseWarnings(bs);
  for (const f of files) {
    const bad = outScope.includes(f) || protectedHits.includes(f);
    const lk = lockHits.filter((x) => x.f === f).map((x) => x.l.id);
    const re = retouched.includes(f) && (outScope.includes(f) || protectedHits.includes(f));
    lines.push(`  ${bad ? BAD() : lk.length ? WARN() : OK()} ${f}${outScope.includes(f) ? c.red(re ? '  carried from earlier work, changed during this task' : '  out of scope') : ''}${protectedHits.includes(f) ? c.red('  protected') : ''}${lk.length ? c.yellow(`  affects ${lk.join(', ')}`) : ''}`);
  }
  if (skipped.length) lines.push(c.dim(`  · ${skipped.length} generated or ignored file${skipped.length > 1 ? 's' : ''} not checked: ${fmtList(skipped, 3)}`));
  if (untouched.length) lines.push(c.dim(`  · ${untouched.length} carried file${untouched.length > 1 ? 's' : ''} from earlier work, unchanged: ${fmtList(untouched, 4)}`));
  // Approved snapshots may only change through `stet lock approve` (it records a hash).
  const tampered = L.filter((l) => l.snapshot && l.snapshotHash).filter((l) => { try { return sha(fs.readFileSync(snapPath(r, l), 'utf8')) !== l.snapshotHash; } catch { return true; } });
  for (const l of tampered) lines.push(`  ${BAD()} .stet/${l.snapshot}${c.red('  edited outside stet lock approve')}`);
  const violations = [...new Set([...outScope, ...protectedHits, ...tampered.map((l) => '.stet/' + l.snapshot)])];
  const lockIds = [...new Set(lockHits.map((x) => x.l.id))];
  lines.push('');
  if (violations.length) {
    lines.push(`${BAD()} ${c.red(`${violations.length} file${violations.length > 1 ? 's' : ''} outside scope or protected.`)} Revert, or widen the scope on purpose.`);
    // Leftovers from an earlier task look like drift. Point at the fix instead of leaving people to work it out.
    const early = s.set && !staged ? outScope.filter((f) => !retouched.includes(f) && modifiedBefore(r, f, s.set)) : [];
    if (outScope.length && s.task && early.length < outScope.length) lines.push(`  If that was on purpose: ${c.cyan(`stet scope add "${widenGlobs(outScope.filter((f) => !early.includes(f))).join(',')}"`)}`);
    if (early.length) lines.push(`${WARN()} ${c.yellow(`${early.length === outScope.length ? 'These look' : `${early.length} of these look`} like leftovers from before this scope was set.`)} If so: stet scope carry ${early.length === outScope.length ? '--all' : early.slice(0, 3).join(',')}`);
  }
  if (lockIds.length) lines.push(`${WARN()} Changes touch locked behaviour ${lockIds.join(', ')}. Run: stet check --only ${lockIds.join(',')}`);
  if (!violations.length) lines.push(`${OK()} ${c.green(files.length ? 'All changes are inside scope.' : untouched.length ? 'No changes yet in this task.' : 'No changes yet.')}`);
  lines.push(...behindLines);
  return out(lines.join('\n'), violations.length && !warn ? 1 : 0, { files, violations, lockIds, carried: untouched, behind: bs && !bs.missing ? bs.behind : 0, remote: bs ? bs.ref : null });
}
// The narrowest globs that would let these files in: their folders, or the file itself at the root.
function widenGlobs(files) {
  let dirs = [...new Set(files.map((f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : f)))];
  dirs = dirs.filter((d) => !dirs.some((o) => o !== d && d.startsWith(o + '/')));
  if (dirs.length > 4) {
    const parts = dirs.map((d) => d.split('/'));
    const common = [];
    for (let i = 0; parts.every((p) => p[i] !== undefined && p[i] === parts[0][i]); i++) common.push(parts[0][i]);
    if (common.length) dirs = [common.join('/')];
  }
  return dirs.map((d) => (files.includes(d) ? d : d + '/**'));
}
// Which carried files are untouched (same fingerprint as when the scope was set) and which changed again.
function carriedState(r, s, changed) {
  const untouched = [], retouched = [];
  for (const x of s.carried || []) {
    if (!changed.includes(x.file)) continue;
    (fileHash(r, x.file) === x.hash ? untouched : retouched).push(x.file);
  }
  return { untouched, retouched };
}
// True if the file's last change on disk is older than the scope (a leftover, not the agent's work).
function modifiedBefore(r, f, iso) {
  try { return fs.statSync(path.join(r.root, f)).mtimeMs < Date.parse(iso) - 1000; } catch { return false; }
}

// ---------- badge ----------
// A README badge: a backlink for Stet and a signal to contributors that AI changes here are guarded.
const BADGE_URL = 'https://img.shields.io/badge/guarded%20by-stet-FFF01F?labelColor=0E1116';
const BADGE_MD = `[![guarded by stet](${BADGE_URL})](https://getstet.dev)`;
function badge(r, { add } = {}) {
  if (!add) return out(`${BADGE_MD}\n\n${c.dim('Add it to your README automatically: stet badge --add')}`, 0, { markdown: BADGE_MD });
  const f = ['README.md', 'readme.md', 'Readme.md'].find((x) => fs.existsSync(path.join(r.root, x)));
  if (!f) throw new StetError('No README.md found in the project root. Copy the badge from: stet badge');
  const fp = path.join(r.root, f);
  const text = fs.readFileSync(fp, 'utf8');
  if (text.includes('guarded%20by-stet')) return out(`${OK()} ${f} already has the Stet badge.`);
  const lines = text.split('\n');
  const badgeLine = lines.findIndex((l, i) => i < 15 && /^\s*\[!\[/.test(l)); // an existing row of badges near the top
  if (badgeLine >= 0) lines[badgeLine] = lines[badgeLine].replace(/\s*$/, '') + ' ' + BADGE_MD;
  else if (/^#\s/.test(lines[0] || '')) lines.splice(1, 0, '', BADGE_MD);
  else lines.unshift(BADGE_MD, '');
  fs.writeFileSync(fp, lines.join('\n'));
  return out(`${OK()} Added the Stet badge to ${f}.\n  ${c.dim(BADGE_MD)}`);
}

// ---------- context pack ----------
function readCapped(r, f, maxKB) {
  try {
    const full = path.join(r.root, f);
    const st = fs.statSync(full);
    if (!st.isFile()) return null;
    const buf = fs.readFileSync(full);
    if (buf.includes(0)) return '(binary file skipped)';
    const s = buf.toString('utf8');
    return s.length > maxKB * 1024 ? s.slice(0, maxKB * 1024) + `\n… (truncated at ${maxKB} KB)` : s;
  } catch { return null; }
}
function tree(files, cap = 400) {
  const shown = files.slice(0, cap);
  const outL = []; let prev = [];
  for (const f of shown) {
    const parts = f.split('/');
    let i = 0; while (i < parts.length - 1 && prev[i] === parts[i]) i++;
    for (let j = i; j < parts.length - 1; j++) outL.push('  '.repeat(j) + parts[j] + '/');
    outL.push('  '.repeat(parts.length - 1) + parts[parts.length - 1]);
    prev = parts;
  }
  if (files.length > cap) outL.push(`… and ${files.length - cap} more files`);
  return outL.join('\n');
}
const fence = (f) => ({ ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', py: 'python', go: 'go', rs: 'rust', rb: 'ruby', json: 'json', md: 'md', yml: 'yaml', yaml: 'yaml', sql: 'sql', css: 'css', html: 'html', sh: 'bash' }[f.split('.').pop()] || '');
function context(r, { files, changed, diff, maxKB, flow } = {}) {
  r.need();
  const cfg = r.config; maxKB = +maxKB || cfg.maxFileKB;
  const all = listFiles(r);
  const g = r.isGit();
  const status = g ? nonEmpty(r.tgit(['status', '--short'])).filter((l) => !/\.stet\/(\.cache|context\.md)/.test(l)) : [];
  const parts = [];
  parts.push(`# Context pack — ${cfg.name}`);
  parts.push(`Generated by Stet ${VERSION} on ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC · branch \`${g ? r.branch() : 'n/a'}\` · commit \`${g ? r.head() || 'none' : 'n/a'}\` · ${status.length} uncommitted change${status.length === 1 ? '' : 's'} · ${all.length} files`);
  parts.push(`> **For the AI reading this:** this is the live state of the repository right now. It replaces any code, file list or assumption from earlier in this conversation. Follow the working agreement below. Do not invent files that are not in the tree. If you need a file's contents, ask for it by path.`);
  // The Linear ticket (if fetched with `stet ticket` / `stet scope set LIN-142`) goes first: it is the task.
  const tk = r.scope.ticket && require('./linear').cachedIssue(r, r.scope.ticket);
  if (tk) parts.push(require('./linear').issueMd(tk));
  // A studied flow (stet study) brings its doc, and its key files are included below.
  let flowFiles = [];
  if (flow) {
    const fl = require('./study').flowFor(r, flow);
    flowFiles = fl.files;
    parts.push(`${fl.drift.length ? `> Note: ${fl.drift.length} key file(s) changed since this flow doc was written; trust the code below over the doc.\n\n` : ''}${fl.doc.replace(/<!-- stet:study:(begin|end) -->\n?/g, '').replace(/^## /gm, '### ').replace(/^# /m, '## ')}`);
  }
  parts.push(agentsBlock(r).replace(BEGIN, '').replace(END, '').replace(/^<!--.*-->$/m, '').replace(/^### /gm, '#### ').replace(/^# Working agreement.*$/m, '## Working agreement').replace(/^## (?!Working)/gm, '### ').trim());
  if (g && r.head()) parts.push(`## Recent commits\n\`\`\`\n${r.tgit(['log', '--oneline', '--no-decorate', '-15']).trim()}\n\`\`\``);
  if (status.length) parts.push(`## Uncommitted changes\n\`\`\`\n${status.join('\n')}\n\`\`\``);
  parts.push(`## File tree\n\`\`\`\n${tree(all)}\n\`\`\``);
  let pick = [];
  if (files) pick = all.filter((f) => matches(f, splitList(files)));
  if (flowFiles.length) pick = [...new Set([...pick, ...flowFiles.filter((f) => all.includes(f))])];
  if (changed) pick = [...new Set([...pick, ...changedFiles(r, { base: r.scope.base }).filter((f) => !matches(f, STET_OWNED))])];
  if (pick.length) {
    let budget = 400 * 1024;
    const blocks = [];
    for (const f of pick) {
      const s = readCapped(r, f, maxKB);
      if (s == null) { blocks.push(`### ${f}\n(deleted or unreadable)`); continue; }
      if (budget - s.length < 0) { blocks.push(`### ${f}\n(skipped: context size budget reached)`); continue; }
      budget -= s.length;
      blocks.push(`### ${f}\n\`\`\`${fence(f)}\n${s.replace(/\s*$/, '')}\n\`\`\``);
    }
    parts.push(`## File contents\n${blocks.join('\n\n')}`);
  }
  if (diff && g) {
    let d = r.head() ? r.tgit(['diff', r.scope.base || 'HEAD']) : '';
    if (d.length > 200 * 1024) d = d.slice(0, 200 * 1024) + '\n… (diff truncated)';
    parts.push(`## Diff since scope was set\n\`\`\`diff\n${d.trim() || '(no changes)'}\n\`\`\``);
  }
  return out(parts.join('\n\n') + '\n', 0, { files: all.length, included: pick.length });
}
function copyToClipboard(text) {
  const tries = process.platform === 'darwin' ? [['pbcopy', []]] : process.platform === 'win32' ? [['clip', []]] : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  for (const [cmd, args] of tries) { const p = cp.spawnSync(cmd, args, { input: text }); if (!p.error && p.status === 0) return true; }
  return false;
}

// ---------- handoff ----------
function handoff(r) {
  r.need();
  const cfg = r.config, st = detect(r.root), all = listFiles(r), g = r.isGit() && r.head();
  const ext = {}; for (const f of all) { const e = f.includes('.') ? f.split('.').pop().toLowerCase() : '(none)'; ext[e] = (ext[e] || 0) + 1; }
  const top = {}; for (const f of all) { const t = f.includes('/') ? f.split('/')[0] + '/' : '(root files)'; top[t] = (top[t] || 0) + 1; }
  const envEx = ['.env.example', '.env.sample', '.env.template'].map((f) => r.rootFile(f)).find((x) => x != null);
  const envKeys = envEx ? nonEmpty(envEx).filter((l) => /^[A-Z_][A-Z0-9_]*=/.test(l.trim())).map((l) => l.trim().split('=')[0]) : [];
  const hot = {};
  if (g) for (const f of names(r.tgit(['log', '-200', '--name-only', '--pretty=format:']))) if (all.includes(f) && !matches(f, STET_OWNED)) hot[f] = (hot[f] || 0) + 1;
  const charter = r.read('charter.md').replace(/<!--[\s\S]*?-->\n?/g, '').replace(/^# .*\n+/, '').replace(/^## /gm, '### ').trim();
  const ds = decisionsList(r);
  const decMd = r.read('decisions.md').split(/\n(?=## D-)/).slice(1).map((b) => b.replace(/^## /, '#### ').trim()).join('\n\n');
  const L = r.locks, s = r.scope;
  const sorted = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
  const md = `# Handoff — ${cfg.name}

Generated by [Stet](https://getstet.dev) ${VERSION} on ${today()}. Regenerate any time with \`stet handoff\`; it is built from the repo, not from memory.

| | |
|---|---|
| Repository | ${g ? (r.tgit(['remote', 'get-url', 'origin']).trim() || 'no remote set') : 'not a git repo'} |
| Branch / commit | ${g ? `\`${r.branch()}\` @ \`${r.head()}\`` : '—'} |
| History | ${g ? `${r.tgit(['rev-list', '--count', 'HEAD']).trim()} commits since ${r.tgit(['log', '--reverse', '--format=%as']).split('\n')[0]} · ${nonEmpty(r.tgit(['shortlog', '-sn', 'HEAD'])).length} contributor(s)` : '—'} |
| Stack | ${[...st.langs, ...st.frameworks].join(', ') || 'not detected'} |
| Size | ${all.length} tracked files |

## 1. Product charter
${charter}

## 2. Run it
${st.run.length || st.tests.length ? [...st.run, ...st.tests.map((t) => t + '   # tests')].map((x) => '- `' + x + '`').join('\n') : '- No run scripts detected. Add them to the charter.'}
${envKeys.length ? `\nEnvironment variables needed (names only, from the example env file):\n${envKeys.map((k) => '`' + k + '`').join(' · ')}` : ''}

## 3. Architecture at a glance
**Entry points:** ${st.entry.length ? st.entry.map((x) => '`' + x + '`').join(', ') : 'not detected'}

**Top-level layout**
| Folder | Files |
|---|---|
${sorted(top, 20).map(([k, v]) => `| \`${k}\` | ${v} |`).join('\n')}

**Languages by file count:** ${sorted(ext, 8).map(([k, v]) => `${k} ${v}`).join(' · ')}
${st.deps.length ? `\n**Key dependencies:** ${st.deps.slice(0, 30).map((x) => '`' + x + '`').join(', ')}` : ''}
${Object.keys(hot).length ? `\n**Most-changed files (last 200 commits)** — where the active work and the risk are:\n${sorted(hot, 10).map(([k, v]) => `- \`${k}\` — ${v} change${v === 1 ? '' : 's'}`).join('\n')}` : ''}

## 4. What must not break
${L.length ? `| ID | Behaviour | Proof | Watches |\n|---|---|---|---|\n${L.map((l) => `| ${l.id} | ${l.name} | \`${l.cmd}\` | ${(l.protect || []).join(', ') || '—'} |`).join('\n')}\n\nRun them all with \`stet check\`.` : 'No locked behaviours recorded yet.'}
${cfg.protect.length ? `\n**Protected paths:** ${cfg.protect.map((x) => '`' + x + '`').join(', ')}` : ''}

## 5. Decisions and why (${ds.length})
${decMd || 'None recorded.'}

## 6. How the main flows work
${(() => { const fl = r.json('flows.json', {}); const k = Object.keys(fl); return k.length ? k.map((x) => `- **${fl[x].topic}** — [\`${fl[x].doc}\`](${fl[x].doc})`).join('\n') : 'No flows documented yet. Map one with `stet study "<topic>"`, e.g. `stet study "checkout"`.'; })()}

## 7. Work in progress
${s.task ? `Current task: **${s.task}** (allowed: ${s.allow.map((x) => '`' + x + '`').join(', ')})` : 'No task scope is open.'}
${g ? `\nRecent commits:\n\`\`\`\n${r.tgit(['log', '--oneline', '--no-decorate', '-12']).trim()}\n\`\`\`` : ''}

## 8. First day checklist for a new engineer or CTO
- [ ] Read sections 1, 4 and 5 of this document (charter, what must not break, decisions).
- [ ] Get it running locally with the commands in section 2.
- [ ] Run \`stet check\` and confirm every locked behaviour passes on your machine.
- [ ] Read \`AGENTS.md\`. It is what the AI agents follow, so it is also the team's working agreement.
- [ ] Skim the most-changed files in section 3.
- [ ] Note anything here that is wrong or missing and record it with \`stet decide\` or in the charter.
`;
  return out(md);
}

// ---------- PR / commit text ----------
// Builds a commit message and PR description from facts only: the diff since the scope was set,
// the scope and its ticket, guard results, the last stet check, and decisions logged during the task.
// The one thing Stet can't know — the "why" in plain words — is left as a marked line for you or your AI.
const PR_TEMPLATE = `## {{title}}

{{ticket}}

### What and why
{{what}}

### Changes · {{stats}}
{{changes}}

### Scope
{{scope}}

### Locked behaviours
{{locks}}

{{decisions}}

---
<sub>Generated by [Stet](https://getstet.dev) from the git diff, the task scope and check results.</sub>
`;
const WHAT_PLACEHOLDER = '<!-- Replace this line with 1–2 sentences: what changes for the user, and why. -->';
const FACT_TOKENS = ['changes', 'scope', 'locks', 'decisions'];
const prTemplate = (r) => r.read('pr-template.md') || PR_TEMPLATE;
// Fill {{tokens}}. A line that is only an empty token is dropped, with the blank line after it.
function renderTemplate(tpl, vals) {
  const lines = tpl.replace(/\r\n/g, '\n').split('\n'), outL = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(/^\{\{(\w+)\}\}$/);
    if (m && !String(vals[m[1]] ?? '').trim()) { if (lines[i + 1] !== undefined && !lines[i + 1].trim()) i++; continue; }
    outL.push(lines[i].replace(/\{\{(\w+)\}\}/g, (_, k) => String(vals[k] ?? '')));
  }
  return outL.join('\n').replace(/\n{3,}/g, '\n\n');
}
// Split markdown into [{heading, body}] on heading lines.
function sections(md) {
  const outS = [{ heading: '', body: [] }];
  for (const l of md.replace(/\r\n/g, '\n').split('\n')) {
    if (/^#{1,6} /.test(l)) outS.push({ heading: l.trim(), body: [] }); else outS[outS.length - 1].body.push(l);
  }
  return outS.map((x) => ({ heading: x.heading, body: x.body.join('\n').trim() }));
}
const tplLineRe = (l) => new RegExp('^' + l.trim().split(/\{\{\w+\}\}/).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+') + '$');
// Which template headings hold facts (filled by Stet) and which hold the author's words.
function templateShape(tpl) {
  const secs = sections(tpl).filter((x) => x.heading);
  return secs.map((x) => {
    const toks = [...x.body.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
    return { heading: x.heading, re: tplLineRe(x.heading), what: toks.includes('what'), fact: toks.some((t) => FACT_TOKENS.includes(t)) };
  });
}

function pr(r, { base, runCheck, what, noFetch, title: titleIn } = {}) {
  r.need();
  if (!r.isGit() || !r.head()) throw new StetError('stet pr needs a git repo with at least one commit.');
  const s = r.scope;
  // Default: compare with the up-to-date remote base (what the PR will show), else where the scope was set.
  const bs = baseStatus(r, { noFetch });
  let want, against = null;
  if (base) { const rv = resolveBase(r, base, bs); want = rv.base; if (rv.note) against = bs.ref; }
  else if (bs && !bs.missing && bs.mergeBase) { want = bs.mergeBase; against = bs.ref; }
  else want = s.base || 'HEAD';
  const b = refOk(r, want) ? want : 'HEAD';
  const warnings = baseWarnings(bs).map((w) => w.replace(/\x1b\[[0-9;]*m/g, ''));

  // What changed (committed + staged + unstaged since base, plus new untracked files).
  const status = {}, lines = {};
  for (const l of nonEmpty(r.tgit(['diff', '--name-status', '-M', b]))) {
    const [code, ...paths] = l.split('\t');
    const f = paths[paths.length - 1];
    status[f] = code[0] === 'A' ? 'added' : code[0] === 'D' ? 'deleted' : code[0] === 'R' ? `renamed from \`${paths[0]}\`` : 'modified';
  }
  for (const l of nonEmpty(r.tgit(['diff', '--numstat', '-M', b]))) {
    const [add, del, ...rest] = l.split('\t');
    // Renames show as "old => new" or "dir/{a => b}/file"; keep the new path.
    const f = rest.join('\t').replace(/\{[^}]* => ([^}]*)\}/, '$1').replace(/^.* => /, '').replace(/\/\//g, '/');
    lines[f] = add === '-' ? null : [+add, +del];
  }
  for (const f of names(r.tgit(['ls-files', '--others', '--exclude-standard']))) {
    status[f] = 'added';
    try { const t = fs.readFileSync(path.join(r.root, f)); lines[f] = t.includes(0) ? null : [t.toString('utf8').split('\n').length - (t.toString('utf8').endsWith('\n') ? 1 : 0), 0]; } catch { lines[f] = null; }
  }
  const carriedUntouched = carriedState(r, s, Object.keys(status)).untouched; // earlier work, not this change
  const files = Object.keys(status).filter((f) => !matches(f, STET_OWNED) && !carriedUntouched.includes(f)).sort();
  const plus = files.reduce((n, f) => n + ((lines[f] || [0])[0] || 0), 0);
  const minus = files.reduce((n, f) => n + ((lines[f] || [0, 0])[1] || 0), 0);

  // Scope is judged on the task's own changes (since the scope was set); without a scope, on the whole diff.
  const g = guard(r, { base: s.task && s.base ? s.base : b, warn: true, remote: false }).data;
  let checkRes = null, checkNote = '';
  if (runCheck) { checkRes = check(r, {}).data.results; checkNote = `ran just now at commit \`${r.head()}\``; }
  else {
    const last = r.json('.cache/last-check.json', null);
    if (last) {
      checkRes = last.results;
      checkNote = `last run ${last.at.slice(0, 16).replace('T', ' ')} UTC at commit \`${last.head}\`${last.head !== r.head() ? ' — older than the latest commit, rerun `stet check`' : ''}`;
    }
  }
  const newDecisions = s.task ? decisionsList(r).slice(s.decisionsBefore || 0) : [];
  const decMd = r.read('decisions.md');
  const why = (id) => { const m = decMd.match(new RegExp(`^## ${id} · .*\\n([^#][\\s\\S]*?)(?=\\n## |$)`, 'm')); return m ? m[1].trim().split('\n')[0] : ''; };

  // Title: --title, else the one commit's subject (what was actually done), else the task.
  const subjects = nonEmpty(r.tgit(['log', '--no-merges', '--format=%s', `${b}..HEAD`]));
  const tkp = s.ticket ? s.ticket + ': ' : '';
  const goodSubject = (x) => x.split(/\s+/).length >= 3 && !/^(wip|tmp|temp|fix|fixes|update|updates|changes?|stuff|misc|test|commit)\b/i.test(x);
  const strip = (x) => (s.ticket ? x.replace(new RegExp(`^\\s*${s.ticket}\\s*[:\\-–—]?\\s*`), '') : x).trim();
  const title = String(titleIn || '').trim()
    || (subjects.length === 1 && goodSubject(strip(subjects[0])) ? tkp + strip(subjects[0])
      : s.task ? tkp + s.task : subjects.length ? strip(subjects[subjects.length - 1]) : 'Describe this change');
  const MAX = 30;

  // Commit message: title, blank line, one bullet per file.
  const commit = [title, '', ...files.slice(0, 15).map((f) => `- ${status[f].startsWith('renamed') ? 'rename' : status[f] === 'added' ? 'add' : status[f] === 'deleted' ? 'remove' : 'update'} ${f}`), ...(files.length > 15 ? [`- and ${files.length - 15} more files`] : [])].join('\n') + '\n';

  const tk = s.ticket && require('./linear').cachedIssue(r, s.ticket);
  const changes = [];
  if (files.length) {
    changes.push('| File | Change | Lines |', '|---|---|---|');
    for (const f of files.slice(0, MAX)) changes.push(`| \`${f}\` | ${status[f]} | ${lines[f] ? `+${lines[f][0]} −${lines[f][1]}` : 'binary'} |`);
    if (files.length > MAX) changes.push(`| … | ${files.length - MAX} more files | |`);
  } else changes.push('No changes since the base commit yet.');
  if (against) changes.push('', `<sub>Compared with \`${against}\` at \`${b.slice(0, 7)}\`.</sub>`);
  const scope = [];
  if (!s.task) scope.push('⚠️ No scope was set for this change.');
  else if (g.violations.length) scope.push(`⚠️ ${g.violations.length} file${g.violations.length > 1 ? 's are' : ' is'} outside the agreed scope or in protected paths:`, ...g.violations.map((f) => `- \`${f}\``), `Agreed scope: ${s.allow.map((x) => '`' + x + '`').join(', ')}`);
  else scope.push(`✅ All changes are inside the agreed scope: ${s.allow.map((x) => '`' + x + '`').join(', ')}`);
  for (const ch of (s.task && s.changes) || []) scope.push(`- Scope ${ch.added ? `widened during the task: ${ch.added.map((x) => '`' + x + '`').join(', ')}` : `narrowed during the task: removed ${ch.removed.map((x) => '`' + x + '`').join(', ')}`} (${ch.at.slice(0, 16).replace('T', ' ')} UTC)`);
  const locks = [];
  if (!checkRes || !checkRes.length) locks.push(r.locks.length ? '⚠️ `stet check` has not been run for this change yet.' : 'No locked behaviours in this repo yet.');
  else {
    for (const x of checkRes) locks.push(`- ${x.ok ? '✅' : x.cantRun ? '⚠️' : '❌'} **${x.id}** ${x.name}${x.ok ? '' : x.cantRun ? ' — proof command could not run' : ' — failing'}`);
    locks.push('', `<sub>stet check ${checkNote}</sub>`);
  }
  if (g.lockIds.length) locks.push('', `Touches files watched by ${g.lockIds.join(', ')}.`);
  const decisions = newDecisions.length ? ['### Decisions made in this change', ...newDecisions.map((d) => { const w = why(d.id); return `- **${d.id}** ${d.title}${w ? ` — ${w}` : ''}`; })].join('\n') : '';
  const whatText = String(what || '').trim() || `${WHAT_PLACEHOLDER}\n${s.task ? `${s.task}.` : ''}`;

  const prText = renderTemplate(prTemplate(r), {
    title, ticket: s.ticket ? `**Ticket:** ${tk && tk.url ? `[${s.ticket}](${tk.url})` : s.ticket}` : '', what: whatText,
    stats: `${files.length} file${files.length === 1 ? '' : 's'}, +${plus} −${minus}`, changes: changes.join('\n'), scope: scope.join('\n'), locks: locks.join('\n'), decisions,
  }).replace(/\s*$/, '\n');
  r.write('.cache/pr.md', prText);
  r.write('.cache/commit.txt', commit);
  r.wjson('.cache/pr.json', { at: new Date().toISOString(), head: r.head(true), facts: factSections(r, prText) });
  return out(prText, 0, { title, commit, pr: prText, files: files.length, violations: g.violations, checks: checkRes, base: b, against, warnings, whatFilled: !!String(what || '').trim() });
}
function factSections(r, md) {
  const shape = templateShape(prTemplate(r));
  const fx = {};
  for (const x of sections(md)) {
    const sh = shape.find((y) => y.re.test(x.heading));
    if ((sh && sh.fact) || /^### Decisions made in this change$/.test(x.heading)) fx[x.heading.replace(/ · .*$/, '')] = x.body;
  }
  return fx;
}

// Check a PR description against the repo's PR format: every section in order, "What and why" written,
// the Stet footer kept and (when this commit's stet pr output is cached) the fact sections unedited.
function prLint(r, body) {
  r.need();
  if (!String(body || '').trim()) throw new StetError('Usage: stet pr lint <file>   or pipe it: gh pr view --json body -q .body | stet pr lint -');
  const tpl = prTemplate(r), shape = templateShape(tpl), secs = sections(body);
  const problems = [], notes = [];
  let at = 0;
  for (const sh of shape) {
    const i = secs.findIndex((x, k) => k >= at && sh.re.test(x.heading));
    if (i < 0) { problems.push(`Missing section: ${sh.heading.replace(/\{\{\w+\}\}/g, '…')}`); continue; }
    at = i + 1;
    if (sh.what) {
      const txt = secs[i].body.replace(/<!--[\s\S]*?-->/g, '').trim();
      if (secs[i].body.includes(WHAT_PLACEHOLDER) || !txt) problems.push(`"${sh.heading}" is not written yet: replace the placeholder with 1–2 sentences.`);
    }
  }
  const foot = tpl.split('\n').find((l) => /Generated by \[Stet\]/.test(l));
  if (foot && !body.includes('Generated by [Stet]')) problems.push('The Stet footer was removed.');
  const cache = r.json('.cache/pr.json', null);
  if (cache && cache.head === r.head(true)) {
    const now = factSections(r, body);
    for (const [h, want] of Object.entries(cache.facts || {})) {
      if (now[h] === undefined) continue; // already reported as missing
      if (now[h].replace(/\s+/g, ' ').trim() !== want.replace(/\s+/g, ' ').trim()) problems.push(`"${h}" was edited by hand. It must match stet pr exactly (rerun stet pr if the change moved on).`);
    }
  } else notes.push(`${c.dim('· Fact sections not compared: no stet pr output cached for this commit.')}`);
  const lines = problems.length
    ? [`${BAD()} ${c.red(`PR description does not follow this repo's format (${problems.length} problem${problems.length > 1 ? 's' : ''}):`)}`, ...problems.map((p) => `  - ${p}`), c.dim('  Generate it instead: stet pr --what "<1–2 sentences>"')]
    : [`${OK()} PR description follows this repo's format.`];
  return out([...lines, ...notes].join('\n'), problems.length ? 1 : 0, { problems });
}

function prTemplateInit(r) {
  r.need();
  if (r.read('pr-template.md')) return out(`${OK()} .stet/pr-template.md already exists. Edit it to change the PR format.`);
  r.write('pr-template.md', PR_TEMPLATE);
  return out(`${OK()} Wrote .stet/pr-template.md (the default format). Edit headings and order; keep the {{tokens}} where Stet should fill in facts.\n  ${c.dim('Tokens: {{title}} {{ticket}} {{what}} {{stats}} {{changes}} {{scope}} {{locks}} {{decisions}}. stet pr lint checks PRs against it.')}`);
}

// Open the PR with GitHub CLI using Stet's title and description, so nobody writes their own.
function prCreate(r, { what, base, draft, noFetch, title } = {}) {
  r.need();
  const gh = sh('gh', ['--version'], r.root);
  if (gh.error || gh.status !== 0) throw new StetError('stet pr --create needs the GitHub CLI (gh). Install it from https://cli.github.com, then run gh auth login.');
  if (!String(what || '').trim()) throw new StetError('Write the "What and why" first: stet pr --create --what "<1–2 sentences: what changes for the user, and why>"');
  const dirty = nonEmpty(r.tgit(['status', '--porcelain'])).filter((l) => !/\s(\.stet\/|AGENTS\.md|CLAUDE\.md)/.test(l));
  if (dirty.length) throw new StetError(`${dirty.length} uncommitted change${dirty.length > 1 ? 's' : ''}. Commit first so the PR has them: git add -A && git commit -F .stet/.cache/commit.txt`);
  const bs = baseStatus(r, { noFetch });
  const target = base || (bs ? bs.branch : 'main');
  const branch = r.branch();
  if (branch === target || branch === 'HEAD') throw new StetError(`You're on ${branch}. Create a branch for this change first: git switch -c <branch>`);
  const p = pr(r, { base, what, noFetch, title });
  const lint = prLint(r, p.data.pr);
  if (lint.code) throw new StetError(lint.text.replace(/\x1b\[[0-9;]*m/g, ''));
  const remote = bs ? bs.remote : 'origin';
  if (!r.tgit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).trim()) {
    const push = sh('git', ['push', '-u', remote, 'HEAD'], r.root);
    if (push.status !== 0) throw new StetError(`git push failed: ${(push.stderr || '').trim()}`);
  }
  const args = ['pr', 'create', '--title', p.data.title, '--body-file', r.p('.cache/pr.md'), '--base', target, ...(draft ? ['--draft'] : [])];
  const res = sh('gh', args, r.root);
  if (res.status !== 0) throw new StetError(`gh pr create failed: ${((res.stderr || '') + (res.stdout || '')).trim()}`);
  const url = (res.stdout || '').trim().split('\n').pop();
  return out([`${OK()} Opened ${draft ? 'draft ' : ''}PR: ${c.bold(p.data.title)}`, `  ${url}`, ...p.data.warnings.map((w) => '  ' + c.yellow(w))].join('\n'), 0, { url, title: p.data.title });
}

// ---------- status ----------
function status(r) {
  r.need();
  const cfg = r.config, s = r.scope, L = r.locks, ds = decisionsList(r);
  const last = r.json('.cache/last-check.json', null);
  const lines = [c.bold(`Stet · ${cfg.name}`) + c.dim(`  ${r.isGit() ? r.branch() + ' @ ' + (r.head() || 'no commits') : 'not a git repo'}`)];
  const lt = require('./update').cachedLatest();
  lines.push(`  version    ${VERSION}${lt ? (require('./update').newer(lt, VERSION) ? c.yellow(`  ${lt} available: stet update`) : c.dim('  latest')) : ''}`);
  lines.push(`  scope      ${s.task ? s.task + c.dim('  (' + s.allow.join(', ') + ')' + (s.branch ? ' on ' + s.branch : '')) : c.dim('none set')}`);
  if (stetIgnored(r)) lines.push('  ' + IGNORED_NOTE(r));
  else if (r.isGit() && !stetTracked(r)) lines.push(`  ${WARN()} ${c.yellow('.stet/ is not committed yet.')} Commit it once on main so teammates and CI share it: git add .stet AGENTS.md CLAUDE.md && git commit -m "Add Stet"`);
  lines.push(`  locks      ${L.length}${last ? `  last check ${last.results.every((x) => x.ok) ? c.green('passed') : c.red('failed: ' + last.results.filter((x) => !x.ok).map((x) => x.id).join(', '))} ${c.dim(last.at.slice(0, 16).replace('T', ' ') + (last.head && last.head !== r.head() ? ' (older commit)' : ''))}` : c.dim('  never checked')}`);
  lines.push(`  decisions  ${ds.length}${ds.length ? c.dim('  latest: ' + ds[ds.length - 1].title) : ''}`);
  const ag = r.rootFile('AGENTS.md') || '';
  const flows = r.json('flows.json', {});
  if (Object.keys(flows).length) {
    const stale = Object.values(flows).filter((e) => require('./study').driftOf(r, e).length);
    lines.push(`  flows      ${Object.keys(flows).length}${stale.length ? c.yellow(`  ${stale.length} out of date: ${stale.map((e) => e.topic).join(', ')} (stet study)`) : c.dim('  all up to date')}`);
  }
  lines.push(`  AGENTS.md  ${ag.includes(agentsBlock(r)) ? c.green('in sync') : c.yellow('out of date — run stet sync')}`);
  lines.push(`  agent hook ${agentInstalled(r) ? c.green('on') + c.dim('  (Claude Code PRs must use the stet format)') : c.dim('off — stet agent')}`);
  if (r.isGit() && s.task) { const gd = guard(r, { warn: true }); lines.push(`  guard      ${gd.data.violations.length ? c.red(gd.data.violations.length + ' out-of-scope file(s)') : c.green(gd.data.files.length + ' changed, all in scope')}${gd.data.carried.length ? c.dim(` · ${gd.data.carried.length} carried`) : ''}`); }
  return out(lines.join('\n'));
}

// ---------- git hook ----------
const HOOK_BEG = '# >>> stet >>>', HOOK_END = '# <<< stet <<<';
const STET_BIN = 'if command -v stet >/dev/null 2>&1; then STET="stet"; else STET="npx --no-install stet-cli"; fi';
function writeHook(hp, block) {
  let cur = fs.existsSync(hp) ? fs.readFileSync(hp, 'utf8') : '';
  if (cur.includes(HOOK_BEG)) cur = cur.slice(0, cur.indexOf(HOOK_BEG)) + cur.slice(cur.indexOf(HOOK_END) + HOOK_END.length + 1);
  if (block == null) { if (fs.existsSync(hp)) fs.writeFileSync(hp, cur); return; }
  const next = (cur.trim() ? cur.replace(/\s*$/, '\n') : '#!/bin/sh\n') + block;
  fs.mkdirSync(path.dirname(hp), { recursive: true });
  fs.writeFileSync(hp, next); fs.chmodSync(hp, 0o755);
}
function hook(r, { uninstall, withCheck } = {}) {
  r.need();
  const gitDir = r.tgit(['rev-parse', '--git-path', 'hooks']).trim();
  if (!gitDir) throw new StetError('Not a git repo.');
  const pre = path.resolve(r.root, gitDir, 'pre-commit');
  const msg = path.resolve(r.root, gitDir, 'prepare-commit-msg');
  if (uninstall) { writeHook(pre, null); writeHook(msg, null); return out(`${OK()} Removed Stet from the git hooks.`); }
  // pre-commit: block commits that stage out-of-scope or protected files.
  writeHook(pre, `${HOOK_BEG}
${STET_BIN}
$STET guard --staged || { echo "stet: commit blocked. Out-of-scope or protected files are staged. Bypass on purpose with: git commit --no-verify"; exit 1; }
${withCheck ? '$STET check || { echo "stet: commit blocked. A locked behaviour is failing."; exit 1; }\n' : 'if [ "$STET_CHECK" = "1" ]; then $STET check || exit 1; fi\n'}${HOOK_END}
`);
  // prepare-commit-msg: prefix the ticket ID ("LIN-142: ...") unless the message already has it.
  // $2 is empty (editor) or "message" (-m); merges, squashes and amends are left alone.
  writeHook(msg, `${HOOK_BEG}
case "$2" in ""|message|template)
  ${STET_BIN}
  T=$($STET scope ticket --no-color 2>/dev/null)
  if [ -n "$T" ] && ! grep -q "$T" "$1"; then { printf '%s: ' "$T"; cat "$1"; } > "$1.stet" && mv "$1.stet" "$1"; fi
  ;;
esac
${HOOK_END}
`);
  return out(`${OK()} Git hooks installed:\n  pre-commit          blocks commits that stage out-of-scope or protected files${withCheck ? ' and runs stet check' : ' (STET_CHECK=1 also runs stet check)'}\n  prepare-commit-msg  adds the scope's ticket ID to commit messages, e.g. "LIN-142: …"`);
}

// ---------- agent hook (Claude Code) ----------
// A PreToolUse hook in .claude/settings.json. Before Claude Code runs `gh pr create`, `gh pr edit --body…`
// or a GitHub MCP pull-request tool, Stet lints the description; a PR in its own format is blocked (exit 2)
// and Claude is told to use `stet pr --create`. Fails open: an error in Stet never blocks the agent.
const AGENT_HOOK_CMD = "sh -c 'if command -v stet >/dev/null 2>&1; then exec stet agent-hook; else exec npx --no-install stet-cli agent-hook; fi'";
const AGENT_MATCHER = 'Bash|mcp__.*pull_request.*';
const isStetHook = (h) => /\bagent-hook\b/.test((h && h.command) || '');
function agentInstall(r, { uninstall } = {}) {
  r.need();
  const fp = path.join(r.root, '.claude', 'settings.json');
  let j = {};
  if (fs.existsSync(fp)) { try { j = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { throw new StetError('.claude/settings.json is not valid JSON. Fix it, then run stet agent again.'); } }
  const hooks = j.hooks || {};
  const pre = (hooks.PreToolUse || []).map((e) => ({ ...e, hooks: (e.hooks || []).filter((h) => !isStetHook(h)) })).filter((e) => e.hooks.length);
  if (!uninstall) pre.push({ matcher: AGENT_MATCHER, hooks: [{ type: 'command', command: AGENT_HOOK_CMD, timeout: 30 }] });
  if (pre.length) hooks.PreToolUse = pre; else delete hooks.PreToolUse;
  if (Object.keys(hooks).length) j.hooks = hooks; else delete j.hooks;
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(j, null, 2) + '\n');
  if (uninstall) return out(`${OK()} Removed the Stet hook from .claude/settings.json.`);
  return out([`${OK()} Agent hook installed in ${c.cyan('.claude/settings.json')} (Claude Code).`,
    '  Before Claude opens or edits a PR (gh pr create, gh pr edit --body, GitHub MCP tools), Stet checks the description.',
    "  One that doesn't follow this repo's PR format is blocked, and Claude is told to run stet pr --create instead.",
    c.dim('  Commit .claude/settings.json so everyone on the repo gets it. Remove with: stet agent --uninstall')].join('\n'));
}
const agentInstalled = (r) => { try { return JSON.stringify(JSON.parse(fs.readFileSync(path.join(r.root, '.claude', 'settings.json'), 'utf8')).hooks.PreToolUse).includes('agent-hook'); } catch { return false; } };

// Split a shell command into words, stopping at the first unquoted ; & | or newline.
// Returns { words, dynamic } — dynamic is true when a word uses $(…), `…` or $VAR, which Stet can't evaluate.
function shellWords(src) {
  const words = []; let w = null, dynamic = false, i = 0;
  const push = () => { if (w !== null) words.push(w); w = null; };
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'") { const j = src.indexOf("'", i + 1); w = (w || '') + src.slice(i + 1, j < 0 ? src.length : j); i = j < 0 ? src.length : j + 1; continue; }
    if (ch === '"') {
      let j = i + 1, buf = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length && '"\\$`\n'.includes(src[j + 1])) { buf += src[j + 1]; j += 2; continue; }
        if (src[j] === '`' || (src[j] === '$' && /[({A-Za-z_]/.test(src[j + 1] || ''))) dynamic = true;
        buf += src[j++];
      }
      w = (w || '') + buf; i = j + 1; continue;
    }
    if (ch === '\\' && i + 1 < src.length) { w = (w || '') + src[i + 1]; i += 2; continue; }
    if (/[;&|\n]/.test(ch)) break;
    if (/\s/.test(ch)) { push(); i++; continue; }
    if (ch === '`' || (ch === '$' && /[({A-Za-z_]/.test(src[i + 1] || ''))) dynamic = true;
    w = (w || '') + ch; i++;
  }
  push();
  return { words, dynamic };
}
// Find the PR description a `gh pr create|edit` command would send.
// → null (not a PR body change), or { body } / { problem }.
function ghPrBody(command, cwd) {
  const m = String(command || '').match(/\bgh\s+pr\s+(create|edit)\b/);
  if (!m) return null;
  let seg = command.slice(m.index);
  // Claude Code's usual form: --body "$(cat <<'EOF' … EOF)". Pull heredocs out before splitting words.
  const docs = [];
  seg = seg.replace(/"?\$\(\s*cat\s*<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*\n?\s*\)"?/g, (_, q, tag, text) => { docs.push(text); return ` __STET_DOC_${docs.length - 1}__ `; });
  const { words, dynamic } = shellWords(seg);
  const val = (i, a) => (a.includes('=') ? a.slice(a.indexOf('=') + 1) : words[i + 1]);
  let body, bodyFile, fill = false, web = false;
  for (let i = 3; i < words.length; i++) {
    const a = words[i];
    if (a === '-b' || a === '--body' || a.startsWith('--body=')) body = val(i, a);
    else if (a === '-F' || a === '--body-file' || a.startsWith('--body-file=')) bodyFile = val(i, a);
    else if (/^(-f|--fill(-first|-verbose)?|-T|--template)/.test(a)) fill = true;
    else if (a === '-w' || a === '--web') web = true;
  }
  const doc = (v) => { const d = String(v || '').match(/^__STET_DOC_(\d+)__$/); return d ? docs[+d[1]] : null; };
  if (body !== undefined) {
    if (doc(body) != null) return { body: doc(body) };
    if (dynamic || body === true) return { problem: "Stet can't read a PR description that is built when the command runs." };
    return { body };
  }
  if (bodyFile !== undefined) {
    if (bodyFile === '-' || bodyFile === true || dynamic) return { problem: "Stet can't read a PR description piped in on stdin." };
    try { return { body: fs.readFileSync(path.resolve(cwd, bodyFile), 'utf8') }; } catch { return { problem: `The body file ${bodyFile} doesn't exist.` }; }
  }
  if (m[1] === 'edit') return null; // title, labels, reviewers… no description change
  return { problem: web ? 'Opening the PR in the browser skips the PR format check.' : fill ? 'gh fills in the description from the commits, not in this repo\'s PR format.' : 'No PR description was given.' };
}
function agentHook(r, input) {
  const allow = out('', 0);
  try { r.need(); } catch { return allow; } // not a Stet repo
  const tool = String((input && input.tool_name) || ''), ti = (input && input.tool_input) || {};
  let found = null;
  if (tool === 'Bash') found = ghPrBody(ti.command, input.cwd || r.root);
  else if (/pull_request/i.test(tool)) {
    if (typeof ti.body === 'string') found = { body: ti.body };
    else if (/create/i.test(tool)) found = { problem: 'No PR description was given.' };
  }
  if (!found) return allow;
  let problems = [];
  if (found.problem) problems = [found.problem];
  else { const l = prLint(r, found.body); if (!l.code) return allow; problems = l.data.problems; }
  return out(["stet: blocked. This repo requires its PR format, and this description doesn't follow it:",
    ...problems.map((p) => `  - ${p}`), '',
    'Do this instead (do not write the description yourself):',
    '  stet pr --create --what "<1–2 sentences: what changes for the user, and why>"',
    'Or, to open the PR yourself: stet pr --what "<…>", then gh pr create --title "<title>" --body-file .stet/.cache/pr.md',
    'To update an open PR: stet pr --what "<…>", then gh pr edit --body-file .stet/.cache/pr.md'].join('\n'), 2, { problems });
}

// ---------- MCP config ----------
function mcpInstall(r) {
  const fp = path.join(r.root, '.mcp.json');
  let j = {}; try { j = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch {}
  j.mcpServers = { ...(j.mcpServers || {}), stet: { command: 'npx', args: ['-y', 'stet-cli@latest', 'mcp'] } };
  fs.writeFileSync(fp, JSON.stringify(j, null, 2) + '\n');
  return out(`${OK()} Wrote .mcp.json. Claude Code picks up the Stet tools in this project.\n  Cursor: add the same "stet" entry to .cursor/mcp.json.\n  Anywhere else: command \`npx -y stet-cli@latest mcp\` (stdio).`);
}

module.exports = { lockCmd, baselineRun, unmatchedGlobs, remoteStet, lockSuggest, suggestedLocks, widenGlobs, GENERATED, agentInstall, agentHook, agentInstalled, ghPrBody, shellWords, VERSION, Repo, StetError, findRoot, setColor, c, init, badge, BADGE_MD, sync, decide, decisions, lockAdd, lockList, lockRm, lockRename, scopeCarry, scopeDone, check, scopeSet, scopeShow, scopeClear, guard, context, copyToClipboard, handoff, status, hook, mcpInstall, pr, prLint, prCreate, ciWorkflow, prTemplateInit, PR_TEMPLATE, scopeAdd, scopeRemove, baseStatus, scopeTicket, lockApprove, normalise, lineDiff, nonEmptyLines: nonEmpty, globRe, matches, detect, listFiles, changedFiles };

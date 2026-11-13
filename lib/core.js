'use strict';
// Stet core: every command returns { text, code } so the CLI and the MCP server share one implementation.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
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
    for (const k of ['dev', 'start', 'build', 'lint', 'typecheck']) if (sc[k]) s.run.push(cd(`${pm} run ${k}`));
    if (pj.main) s.entry.push(p(pj.main));
    if (pj.bin) s.entry.push(...(typeof pj.bin === 'string' ? [pj.bin] : Object.values(pj.bin)).map(p));
  }
  if (ex('pyproject.toml') || ex('requirements.txt') || ex('setup.py') || ex('Pipfile')) {
    addLang('Python');
    const txt = (rd('pyproject.toml') + '\n' + rd('requirements.txt') + '\n' + rd('Pipfile')).toLowerCase();
    for (const [k, n] of [['django', 'Django'], ['fastapi', 'FastAPI'], ['flask', 'Flask'], ['sqlalchemy', 'SQLAlchemy'], ['pydantic', 'Pydantic'], ['pandas', 'pandas'], ['celery', 'Celery']]) if (txt.includes(k)) addFw(n);
    s.deps.push(...nonEmpty(rd('requirements.txt')).filter((l) => !l.trim().startsWith('#') && !l.trim().startsWith('-')).map((l) => l.trim().split(/[=<>~! ;\[]/)[0]));
    if (ex('tests') || ex('test') || ex('pytest.ini') || ex('conftest.py') || txt.includes('[tool.pytest')) addTest('pytest -q');
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
  const s = { langs: [], frameworks: [], tests: [], test: null, run: [], deps: [], entry: [] };
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
const STET_OWNED = ['.stet/**', 'AGENTS.md', 'CLAUDE.md', 'HANDOFF.md', '.mcp.json'];

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
  return `**Task:** ${s.task}\n\nYou may change only:\n${s.allow.map((g) => `- \`${g}\``).join('\n')}\n\nIf the task needs a change outside this list, stop and ask. Do not tidy up, refactor or reformat other files.`;
}
function locksBlock(r) {
  const L = r.locks;
  if (!L.length) return 'No locked behaviours yet. The human adds them with `stet lock add`.';
  return `These already work and must keep working:\n\n| ID | Behaviour | Proof (must pass) | Files that affect it |\n|---|---|---|---|\n${L.map((l) => `| ${l.id} | ${l.name} | \`${l.cmd}\` | ${(l.protect || []).map((g) => '`' + g + '`').join(', ') || '—'} |`).join('\n')}\n\nBefore saying any task is done, run \`stet check\`. If a check fails, fix your change. Never edit the test or weaken the check to make it pass.`;
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
6. Finish with a short summary: what changed, which files, check results and anything you were unsure about.
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
function init(r, { name, mcp } = {}) {
  const st = detect(r.root);
  const nm = name || r.config.name;
  const made = [], kept = [];
  const put = (f, s) => { if (fs.existsSync(r.p(f))) kept.push(f); else { r.write(f, s); made.push(f); } };
  put('config.json', JSON.stringify({ name: nm, version: 1, protect: [], ignore: [], maxFileKB: 64, checkTimeoutSec: 600 }, null, 2) + '\n');
  put('charter.md', charterTemplate(nm, st));
  put('locks.json', JSON.stringify(st.tests.map((cmd, i) => {
    const m = cmd.match(/^cd (\S+) && /);
    return { id: 'L' + (i + 1), name: m ? `Test suite passes (${m[1]}/)` : 'Full test suite passes', cmd, protect: [], added: today() };
  }), null, 2) + '\n');
  put('scope.json', '{}\n');
  put('decisions.md', `# Decision log — ${nm}\n\nOne entry per decision. Newest at the bottom. Managed with \`stet decide\`.\n\n## D-001 · ${today()} · Adopted Stet to keep AI agents in scope\nAI agents read AGENTS.md. Locked behaviours are checked with \`stet check\` before work is called done.\n`);
  put('.gitignore', '.cache/\ncontext.md\n');
  sync(r);
  const lines = [`${OK()} Stet initialised in ${c.bold(r.root)}`];
  if (!r.isGit()) lines.push(`${WARN()} This folder is not a git repo. guard, context and handoff work best with git.`);
  lines.push(`  stack:   ${[...st.langs, ...st.frameworks].join(', ') || 'not detected'}`);
  lines.push(`  created: ${made.map((f) => '.stet/' + f).join(', ') || 'nothing new'}${kept.length ? c.dim(`  (kept ${kept.length} existing)`) : ''}`);
  lines.push(`  wrote:   AGENTS.md, CLAUDE.md`);
  if (mcp) lines.push(mcpInstall(r).text);
  lines.push('', c.bold('Next:'),
    `  1. Edit ${c.cyan('.stet/charter.md')} — one paragraph on what this is, plus your rules.`,
    `  2. Lock what already works:  ${c.cyan('stet lock add "Login works" --cmd "npm test -- auth" --protect "src/auth/**"')}`,
    `  3. Before each AI task:      ${c.cyan('stet scope set "Add CSV export" --allow "src/export/**,tests/export/**"')}`,
    `  4. After the AI is done:     ${c.cyan('stet guard && stet check')}`,
    `  5. Commit .stet/, AGENTS.md and CLAUDE.md so every agent and teammate gets the same rules.`);
  return out(lines.join('\n'));
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
function lockAdd(r, name, { cmd, protect } = {}) {
  r.need();
  if (!name || !cmd) throw new StetError('Usage: stet lock add "<behaviour>" --cmd "<command that proves it>" [--protect "glob,glob"]');
  const L = r.locks;
  const n = L.length ? Math.max(...L.map((l) => +String(l.id).slice(1) || 0)) + 1 : 1;
  const l = { id: 'L' + n, name, cmd, protect: splitList(protect), added: today() };
  L.push(l); r.wjson('locks.json', L); sync(r);
  return out(`${OK()} Locked ${c.bold(l.id)}: ${name}\n  proof: ${c.cyan(cmd)}${l.protect.length ? `\n  watches: ${l.protect.join(', ')}` : ''}`, 0, l);
}
function lockList(r) {
  r.need();
  const L = r.locks;
  if (!L.length) return out('No locked behaviours. Add one with: stet lock add "<behaviour>" --cmd "<command>"');
  const last = r.json('.cache/last-check.json', { results: [] });
  return out(L.map((l) => {
    const res = last.results.find((x) => x.id === l.id);
    const mark = !res ? c.dim('·') : res.ok ? OK() : BAD();
    return `${mark} ${c.bold(l.id.padEnd(4))} ${l.name}\n     ${c.dim('$')} ${c.cyan(l.cmd)}${l.protect && l.protect.length ? c.dim('  watches ' + l.protect.join(', ')) : ''}`;
  }).join('\n'));
}
function lockRm(r, id) {
  r.need();
  const L = r.locks; const i = L.findIndex((l) => l.id.toLowerCase() === String(id).toLowerCase());
  if (i < 0) throw new StetError(`No lock with id ${id}. See: stet lock list`);
  const [l] = L.splice(i, 1); r.wjson('locks.json', L); sync(r);
  return out(`${OK()} Removed ${l.id}: ${l.name}`);
}
function check(r, { only } = {}) {
  r.need();
  let L = r.locks;
  if (only) { const ids = splitList(only).map((s) => s.toLowerCase()); L = L.filter((l) => ids.includes(l.id.toLowerCase())); }
  if (!L.length) return out(`${WARN()} Nothing to check. Lock a behaviour first: stet lock add "<behaviour>" --cmd "<command>"`);
  const lines = [c.bold(`Checking ${L.length} locked behaviour${L.length > 1 ? 's' : ''}`)];
  const results = [];
  for (const l of L) {
    const t0 = Date.now();
    const p = cp.spawnSync(l.cmd, { cwd: r.root, shell: true, encoding: 'utf8', timeout: r.config.checkTimeoutSec * 1000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CI: process.env.CI || '1', FORCE_COLOR: '0' } });
    const ms = Date.now() - t0;
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
  const failed = results.filter((x) => !x.ok);
  const broken = failed.filter((x) => !x.cantRun), bad = failed.filter((x) => x.cantRun);
  r.wjson('.cache/last-check.json', { at: new Date().toISOString(), head: r.head(), results });
  lines.push('');
  if (bad.length) lines.push(`${WARN()} ${c.yellow(`${bad.map((f) => f.id).join(', ')}: the proof command itself can't run (missing script or command).`)} Fix the lock: stet lock rm ${bad[0].id}, then add it with a command that works (see: npm run).`);
  if (broken.length) lines.push(`${BAD()} ${c.red(`${broken.length} locked behaviour${broken.length > 1 ? 's' : ''} broken: ${broken.map((f) => f.id).join(', ')}.`)} Fix the change, not the check.`);
  if (!failed.length) lines.push(`${OK()} ${c.green('All locked behaviours pass.')}`);
  return out(lines.join('\n'), failed.length ? 1 : 0, { results });
}

// ---------- scope + guard ----------
function scopeSet(r, task, { allow } = {}) {
  r.need();
  const a = splitList(allow);
  if (!task || !a.length) throw new StetError('Usage: stet scope set "<task>" --allow "src/feature/**,tests/feature/**"');
  r.wjson('scope.json', { task, allow: a, base: r.head(true) || null, set: new Date().toISOString() }); sync(r);
  return out(`${OK()} Scope set: ${c.bold(task)}\n  allowed: ${a.map((g) => c.cyan(g)).join(', ')}\n  base:    ${r.head() || '(no commits)'} — guard compares everything changed since here`);
}
function scopeShow(r) {
  r.need(); const s = r.scope;
  if (!s.task) return out('No scope set. Set one before an AI task: stet scope set "<task>" --allow "<globs>"');
  return out(`${c.bold('Task:')} ${s.task}\n${c.bold('Allowed:')} ${s.allow.join(', ')}\n${c.dim(`Set ${s.set} at ${s.base ? s.base.slice(0, 7) : 'no commit'}`)}`);
}
function scopeClear(r) { r.need(); r.wjson('scope.json', {}); sync(r); return out(`${OK()} Scope cleared.`); }

function guard(r, { base, staged, warn } = {}) {
  r.need();
  if (!r.isGit()) throw new StetError('stet guard needs a git repo.');
  const s = r.scope, cfg = r.config, L = r.locks;
  const files = changedFiles(r, { base: base || s.base, staged }).filter((f) => !matches(f, STET_OWNED));
  const outScope = [], protectedHits = [], lockHits = [];
  for (const f of files) {
    if (s.allow && s.allow.length && !matches(f, s.allow)) outScope.push(f);
    if (matches(f, cfg.protect)) protectedHits.push(f);
    for (const l of L) if (matches(f, l.protect)) lockHits.push({ f, l });
  }
  const lines = [];
  const what = staged ? 'staged files' : `changes since ${(base || s.base || 'HEAD').slice(0, 7)}`;
  lines.push(c.bold(`Guarding ${files.length} changed file${files.length === 1 ? '' : 's'}`) + c.dim(` (${what})`) + (s.task ? c.dim(` · task: ${s.task}`) : ''));
  if (!s.task) lines.push(`${WARN()} No scope set, so only protected paths and locks are checked. Set one: stet scope set "<task>" --allow "<globs>"`);
  for (const f of files) {
    const bad = outScope.includes(f) || protectedHits.includes(f);
    const lk = lockHits.filter((x) => x.f === f).map((x) => x.l.id);
    lines.push(`  ${bad ? BAD() : lk.length ? WARN() : OK()} ${f}${outScope.includes(f) ? c.red('  out of scope') : ''}${protectedHits.includes(f) ? c.red('  protected') : ''}${lk.length ? c.yellow(`  affects ${lk.join(', ')}`) : ''}`);
  }
  const violations = [...new Set([...outScope, ...protectedHits])];
  const lockIds = [...new Set(lockHits.map((x) => x.l.id))];
  lines.push('');
  if (violations.length) lines.push(`${BAD()} ${c.red(`${violations.length} file${violations.length > 1 ? 's' : ''} outside scope or protected.`)} Revert, or widen the scope on purpose.`);
  if (lockIds.length) lines.push(`${WARN()} Changes touch locked behaviour ${lockIds.join(', ')}. Run: stet check --only ${lockIds.join(',')}`);
  if (!violations.length) lines.push(`${OK()} ${c.green(files.length ? 'All changes are inside scope.' : 'No changes yet.')}`);
  return out(lines.join('\n'), violations.length && !warn ? 1 : 0, { files, violations, lockIds });
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
function context(r, { files, changed, diff, maxKB } = {}) {
  r.need();
  const cfg = r.config; maxKB = +maxKB || cfg.maxFileKB;
  const all = listFiles(r);
  const g = r.isGit();
  const status = g ? nonEmpty(r.tgit(['status', '--short'])).filter((l) => !/\.stet\/(\.cache|context\.md)/.test(l)) : [];
  const parts = [];
  parts.push(`# Context pack — ${cfg.name}`);
  parts.push(`Generated by Stet ${VERSION} on ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC · branch \`${g ? r.branch() : 'n/a'}\` · commit \`${g ? r.head() || 'none' : 'n/a'}\` · ${status.length} uncommitted change${status.length === 1 ? '' : 's'} · ${all.length} files`);
  parts.push(`> **For the AI reading this:** this is the live state of the repository right now. It replaces any code, file list or assumption from earlier in this conversation. Follow the working agreement below. Do not invent files that are not in the tree. If you need a file's contents, ask for it by path.`);
  parts.push(agentsBlock(r).replace(BEGIN, '').replace(END, '').replace(/^<!--.*-->$/m, '').replace(/^### /gm, '#### ').replace(/^# Working agreement.*$/m, '## Working agreement').replace(/^## (?!Working)/gm, '### ').trim());
  if (g && r.head()) parts.push(`## Recent commits\n\`\`\`\n${r.tgit(['log', '--oneline', '--no-decorate', '-15']).trim()}\n\`\`\``);
  if (status.length) parts.push(`## Uncommitted changes\n\`\`\`\n${status.join('\n')}\n\`\`\``);
  parts.push(`## File tree\n\`\`\`\n${tree(all)}\n\`\`\``);
  let pick = [];
  if (files) pick = all.filter((f) => matches(f, splitList(files)));
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

Generated by Stet ${VERSION} on ${today()}. Regenerate any time with \`stet handoff\`; it is built from the repo, not from memory.

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

## 6. Work in progress
${s.task ? `Current task: **${s.task}** (allowed: ${s.allow.map((x) => '`' + x + '`').join(', ')})` : 'No task scope is open.'}
${g ? `\nRecent commits:\n\`\`\`\n${r.tgit(['log', '--oneline', '--no-decorate', '-12']).trim()}\n\`\`\`` : ''}

## 7. First day checklist for a new engineer or CTO
- [ ] Read sections 1, 4 and 5 of this document (charter, what must not break, decisions).
- [ ] Get it running locally with the commands in section 2.
- [ ] Run \`stet check\` and confirm every locked behaviour passes on your machine.
- [ ] Read \`AGENTS.md\`. It is what the AI agents follow, so it is also the team's working agreement.
- [ ] Skim the most-changed files in section 3.
- [ ] Note anything here that is wrong or missing and record it with \`stet decide\` or in the charter.
`;
  return out(md);
}

// ---------- status ----------
function status(r) {
  r.need();
  const cfg = r.config, s = r.scope, L = r.locks, ds = decisionsList(r);
  const last = r.json('.cache/last-check.json', null);
  const lines = [c.bold(`Stet · ${cfg.name}`) + c.dim(`  ${r.isGit() ? r.branch() + ' @ ' + (r.head() || 'no commits') : 'not a git repo'}`)];
  lines.push(`  scope      ${s.task ? s.task + c.dim('  (' + s.allow.join(', ') + ')') : c.dim('none set')}`);
  lines.push(`  locks      ${L.length}${last ? `  last check ${last.results.every((x) => x.ok) ? c.green('passed') : c.red('failed: ' + last.results.filter((x) => !x.ok).map((x) => x.id).join(', '))} ${c.dim(last.at.slice(0, 16).replace('T', ' ') + (last.head && last.head !== r.head() ? ' (older commit)' : ''))}` : c.dim('  never checked')}`);
  lines.push(`  decisions  ${ds.length}${ds.length ? c.dim('  latest: ' + ds[ds.length - 1].title) : ''}`);
  const ag = r.rootFile('AGENTS.md') || '';
  lines.push(`  AGENTS.md  ${ag.includes(agentsBlock(r)) ? c.green('in sync') : c.yellow('out of date — run stet sync')}`);
  if (r.isGit() && s.task) { const gd = guard(r, { warn: true }); lines.push(`  guard      ${gd.data.violations.length ? c.red(gd.data.violations.length + ' out-of-scope file(s)') : c.green(gd.data.files.length + ' changed, all in scope')}`); }
  return out(lines.join('\n'));
}

// ---------- git hook ----------
function hook(r, { uninstall, withCheck } = {}) {
  r.need();
  const gitDir = r.tgit(['rev-parse', '--git-path', 'hooks']).trim();
  if (!gitDir) throw new StetError('Not a git repo.');
  const hp = path.resolve(r.root, gitDir, 'pre-commit');
  const BEG = '# >>> stet >>>', FIN = '# <<< stet <<<';
  let cur = fs.existsSync(hp) ? fs.readFileSync(hp, 'utf8') : '';
  if (cur.includes(BEG)) cur = cur.slice(0, cur.indexOf(BEG)) + cur.slice(cur.indexOf(FIN) + FIN.length + 1);
  if (uninstall) { fs.writeFileSync(hp, cur); return out(`${OK()} Removed Stet from the pre-commit hook.`); }
  const block = `${BEG}
if command -v stet >/dev/null 2>&1; then STET="stet"; else STET="npx --no-install stet"; fi
$STET guard --staged || { echo "stet: commit blocked. Out-of-scope or protected files are staged. Bypass on purpose with: git commit --no-verify"; exit 1; }
${withCheck ? '$STET check || { echo "stet: commit blocked. A locked behaviour is failing."; exit 1; }\n' : 'if [ "$STET_CHECK" = "1" ]; then $STET check || exit 1; fi\n'}${FIN}
`;
  const next = (cur.trim() ? cur.replace(/\s*$/, '\n') : '#!/bin/sh\n') + block;
  fs.mkdirSync(path.dirname(hp), { recursive: true });
  fs.writeFileSync(hp, next); fs.chmodSync(hp, 0o755);
  return out(`${OK()} Pre-commit hook installed: blocks commits that stage out-of-scope or protected files${withCheck ? ' and runs stet check' : ' (set STET_CHECK=1 to also run stet check)'}.`);
}

// ---------- MCP config ----------
function mcpInstall(r) {
  const fp = path.join(r.root, '.mcp.json');
  let j = {}; try { j = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch {}
  j.mcpServers = { ...(j.mcpServers || {}), stet: { command: 'npx', args: ['-y', 'stet-cli', 'mcp'] } };
  fs.writeFileSync(fp, JSON.stringify(j, null, 2) + '\n');
  return out(`${OK()} Wrote .mcp.json. Claude Code picks up the Stet tools in this project.\n  Cursor: add the same "stet" entry to .cursor/mcp.json.\n  Anywhere else: command \`npx -y stet-cli mcp\` (stdio).`);
}

module.exports = { VERSION, Repo, StetError, findRoot, setColor, c, init, sync, decide, decisions, lockAdd, lockList, lockRm, check, scopeSet, scopeShow, scopeClear, guard, context, copyToClipboard, handoff, status, hook, mcpInstall, globRe, matches, detect, listFiles, changedFiles };

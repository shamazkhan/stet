'use strict';
// stet study "<topic>": map how a part of the codebase works, from the code itself.
// Finds the key files, entry points (routes), the import flow between them, the tests that cover
// them and what protects them, then writes docs/flows/<topic>.md with a diagram. Re-running it
// refreshes the generated block and keeps your own notes. `stet study` alone lists flows and
// whether their code changed since the doc was written.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('./core');
const { StetError, c } = core;

const SRC_RE = /\.(js|jsx|ts|tsx|mjs|cjs|py|go|rb|java|kt|php|cs)$/;
const TEST_RE = /(^|\/)(tests?|__tests__|spec|specs)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/;
const MAX_READ = 300 * 1024;
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 16);
const slugify = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'flow';
const BEGIN = '<!-- stet:study:begin -->', END = '<!-- stet:study:end -->';

function stems(topic) {
  const words = String(topic).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  if (!words.length) throw new StetError('Usage: stet study "<topic>"   e.g. stet study "reconciliation"');
  // "reconciliation" → "reconcil" also matches reconcile, reconciled, reconciler.
  return [...new Set(words.map((w) => (w.length > 6 ? w.slice(0, Math.max(5, Math.ceil(w.length * 0.55))) : w)))];
}

function read(r, f) {
  try { const b = fs.readFileSync(path.join(r.root, f)); return b.includes(0) ? '' : b.slice(0, MAX_READ).toString('utf8'); } catch { return ''; }
}

// ---------- imports ----------
const JS_EXT = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
function resolveJs(from, spec, set) {
  let base;
  if (spec.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  else if (spec.startsWith('@/')) base = 'src/' + spec.slice(2);
  else if (spec.startsWith('~/')) base = spec.slice(2);
  else return null;
  for (const e of JS_EXT) if (set.has(base + e)) return base + e;
  return null;
}
function resolvePy(from, mod, set) {
  let parts;
  if (mod.startsWith('.')) {
    const dots = mod.match(/^\.+/)[0].length;
    let dir = path.posix.dirname(from);
    for (let i = 1; i < dots; i++) dir = path.posix.dirname(dir);
    parts = [dir, ...mod.slice(dots).split('.').filter(Boolean)];
  } else parts = mod.split('.');
  const base = parts.filter((p) => p && p !== '.').join('/');
  for (const cand of [base + '.py', base + '/__init__.py', 'src/' + base + '.py', 'app/' + base + '.py']) if (set.has(cand)) return cand;
  return null;
}
function importsOf(f, text, set) {
  const out = new Set();
  if (/\.py$/.test(f)) {
    for (const m of text.matchAll(/^\s*from\s+([.\w]+)\s+import\s+([\w*, ()]+)/gm)) {
      const hit = resolvePy(f, m[1], set); if (hit) out.add(hit);
      // "from app import recon" → app/recon.py
      for (const name of m[2].replace(/[()]/g, '').split(',').map((x) => x.trim().split(/\s+/)[0]).filter(Boolean)) {
        const sub = resolvePy(f, (m[1].endsWith('.') ? m[1] : m[1] + '.') + name, set); if (sub) out.add(sub);
      }
    }
    for (const m of text.matchAll(/^\s*import\s+([\w.]+)/gm)) { const hit = resolvePy(f, m[1], set); if (hit) out.add(hit); }
  } else if (/\.(js|jsx|ts|tsx|mjs|cjs)$/.test(f)) {
    for (const m of text.matchAll(/(?:\bimport\s[^'"`;]*?\bfrom\s*|\bimport\s*\(\s*|\brequire\(\s*|^\s*import\s+)['"`]([^'"`]+)['"`]/gm)) {
      const hit = resolveJs(f, m[1], set); if (hit) out.add(hit);
    }
  }
  out.delete(f);
  return [...out];
}

// ---------- routes and symbols ----------
function routesIn(text) {
  const out = [];
  // Keep the route's source plus the next few lines (decorated Python handlers live on the following lines).
  const ctx = (i) => text.slice(i, i + 400).split('\n').slice(0, 4).join('\n');
  const add = (m, p, i) => out.push({ method: m.toUpperCase() === 'ROUTE' || m.toUpperCase() === 'ALL' ? 'ANY' : m.toUpperCase(), path: p, line: ctx(i) });
  for (const m of text.matchAll(/\b(?:app|router|server|api|fastify|r|route|routes|v1|v2)\.(get|post|put|patch|delete|all)\(\s*['"`]([^'"`]+)['"`]/gi)) add(m[1], m[2], m.index);
  for (const m of text.matchAll(/@\w+\.(get|post|put|patch|delete|route|api_route)\(\s*['"]([^'"]+)['"]/gi)) add(m[1], m[2], m.index);
  for (const m of text.matchAll(/@(Get|Post|Put|Patch|Delete)\(\s*['"]([^'"]*)['"]\s*\)/g)) add(m[1], '/' + m[2].replace(/^\//, ''), m.index);
  for (const m of text.matchAll(/\bpath\(\s*['"]([^'"]+)['"]\s*,/g)) add('ANY', '/' + m[1].replace(/^\//, ''), m.index);
  return out;
}
function symbolsIn(f, text) {
  const out = [];
  const re = /\.py$/.test(f)
    ? /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)|^\s*class\s+([A-Za-z_]\w*)/gm
    : /(?:^|\s)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|(?:^|\s)(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)|(?:^|\s)(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of text.matchAll(re)) { const n = m[1] || m[2] || m[3]; if (n && !n.startsWith('_') && !out.includes(n)) out.push(n); }
  return out;
}

// ---------- the study ----------
function analyse(r, topic, { max = 12 } = {}) {
  const st = stems(topic);
  const any = new RegExp(st.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
  const anyG = new RegExp(any.source, 'gi');
  const files = core.listFiles(r).filter((f) => SRC_RE.test(f) && !/\.min\.js$/.test(f));
  const set = new Set(files);
  const text = {}, score = {}, why = {};
  for (const f of files) {
    const t = read(r, f); text[f] = t;
    let s = 0; const reasons = [];
    const pathHits = st.filter((x) => f.toLowerCase().includes(x)).length;
    if (pathHits) { s += 10 * pathHits; reasons.push('name'); }
    const defs = symbolsIn(f, t).filter((n) => any.test(n));
    if (defs.length) { s += 5 * Math.min(defs.length, 6); reasons.push(`defines ${defs.slice(0, 3).join(', ')}`); }
    const hits = Math.min((t.match(anyG) || []).length, 40);
    if (hits) { s += hits; if (!defs.length && !pathHits) reasons.push(`${hits} mention${hits > 1 ? 's' : ''}`); }
    if (s) { score[f] = TEST_RE.test(f) ? s / 4 : s; why[f] = reasons; }
  }
  const imports = {}, importers = {};
  for (const f of files) { imports[f] = importsOf(f, text[f], set); for (const d of imports[f]) (importers[d] = importers[d] || []).push(f); }

  const key = Object.keys(score).filter((f) => !TEST_RE.test(f)).sort((a, b) => score[b] - score[a]).slice(0, max);
  if (!key.length) return { topic, st, key: [], files };
  // Flow = key files + their direct imports and importers (source only), capped.
  const flow = new Set(key);
  for (const f of key) for (const n of [...(imports[f] || []), ...(importers[f] || [])]) if (!TEST_RE.test(n) && flow.size < max + 14) flow.add(n);
  const edges = [];
  for (const a of flow) for (const b of imports[a] || []) if (flow.has(b)) edges.push([a, b]);
  // Supporting files: what the key files use (e.g. the rules module behind the engine). They hold logic too.
  const supporting = [...new Set(key.flatMap((f) => imports[f] || []))].filter((f) => !key.includes(f) && !TEST_RE.test(f)).slice(0, 12);
  const keySymbols = new Set(key.flatMap((f) => symbolsIn(f, text[f])));

  // Entry points: routes defined in flow files, or in files that import a key file.
  const routeFiles = new Set([...flow, ...key.flatMap((f) => importers[f] || [])].filter((f) => !TEST_RE.test(f)));
  const routes = [];
  for (const f of routeFiles) for (const rt of routesIn(text[f])) {
    // A route counts if its path mentions the topic or its handler calls into the key files.
    const relevant = any.test(rt.path) || any.test(rt.line) || [...keySymbols].some((n) => new RegExp(`\\b${n.replace(/[$]/g, '\\$')}\\b`).test(rt.line));
    if (relevant && !routes.some((x) => x.method === rt.method && x.path === rt.path && x.file === f)) routes.push({ ...rt, file: f });
  }
  routes.sort((a, b) => (any.test(b.path) - any.test(a.path)) || a.path.localeCompare(b.path));
  const tests = files.filter((f) => TEST_RE.test(f) && ((imports[f] || []).some((d) => flow.has(d)) || any.test(f) || (score[f] || 0) >= 3));
  const symbols = {};
  for (const f of [...key, ...supporting]) { const all = symbolsIn(f, text[f]); symbols[f] = [...all.filter((n) => any.test(n)), ...all.filter((n) => !any.test(n))].slice(0, 6); }

  const cfg = r.config, locks = r.locks;
  const protection = [...key, ...supporting].map((f) => ({ f, locks: locks.filter((l) => core.matches(f, l.protect)).map((l) => l.id), protected: core.matches(f, cfg.protect) }));
  const recent = r.isGit() && r.head() ? core.nonEmptyLines(r.tgit(['log', '--format=%h %as %s', '-12', '--', ...key])) : [];
  const decisions = decisionsMatching(r, any);
  return { topic, st, files, key, supporting, flow: [...flow], edges, routes: routes.slice(0, 20), tests: tests.slice(0, 15), symbols, why, protection, recent, decisions, imports, importers };
}
function decisionsMatching(r, re) {
  const md = r.read('decisions.md');
  return [...md.matchAll(/^## (D-\d+) · (\S+) · (.+)$/gm)].filter((m) => re.test(m[3])).map((m) => `${m[1]} (${m[2]}) ${m[3]}`);
}

// ---------- rendering ----------
function commonDir(files) {
  const parts = files.map((f) => f.split('/').slice(0, -1));
  if (!parts.length) return '';
  const out = []; for (let i = 0; ; i++) { const seg = parts[0][i]; if (seg === undefined || parts.some((p) => p[i] !== seg)) break; out.push(seg); }
  return out.join('/');
}
// Suggest globs that cover the core: a whole folder when every source file in it belongs to the flow, else the file.
function guessGlobs(flowFiles, all) {
  const out = [];
  for (const f of flowFiles) {
    const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
    const inDir = all.filter((x) => SRC_RE.test(x) && !TEST_RE.test(x) && (dir ? x.startsWith(dir + '/') && !x.slice(dir.length + 1).includes('/') : !x.includes('/')));
    const g = dir && inDir.every((x) => flowFiles.includes(x)) ? `${dir}/**` : f;
    if (!out.includes(g)) out.push(g);
  }
  return out.slice(0, 6);
}
const testCmd = (tests) => {
  const py = tests.filter((t) => t.endsWith('.py')), js = tests.filter((t) => !t.endsWith('.py'));
  return [js.length && `node --test ${js.slice(0, 3).join(' ')}`, py.length && `pytest -q ${py.slice(0, 3).join(' ')}`].filter(Boolean).join(' && ');
};

function mermaid(a) {
  const id = new Map(); let n = 0;
  const node = (f) => { if (!id.has(f)) id.set(f, 'n' + n++); return id.get(f); };
  const label = (f) => { const p = f.split('/'); return (p.length > 1 ? p[p.length - 2] + '/' : '') + p[p.length - 1]; };
  const lines = ['flowchart LR'];
  a.routes.slice(0, 8).forEach((rt, i) => { lines.push(`  r${i}["${rt.method} ${rt.path.replace(/"/g, "'")}"] --> ${node(rt.file)}`); });
  for (const [x, y] of a.edges.slice(0, 40)) lines.push(`  ${node(x)} --> ${node(y)}`);
  for (const f of a.key) node(f);
  for (const [f, i] of id) lines.push(`  ${i}["${label(f)}"]`);
  const keyIds = a.key.map((f) => id.get(f)).filter(Boolean);
  if (keyIds.length) lines.push(`  classDef key fill:#ede9ff,stroke:#7c5cff,color:#1b1530`, `  class ${keyIds.join(',')} key`);
  if (a.routes.length) lines.push(`  classDef route fill:#e7f7ee,stroke:#2fbf71,color:#0b2a19`, `  class ${a.routes.slice(0, 8).map((_, i) => 'r' + i).join(',')} route`);
  return lines.join('\n');
}

function render(r, a, slug) {
  const coreFiles = [...a.key, ...a.supporting];
  const gaps = a.protection.filter((p) => !p.locks.length && !p.protected);
  const glob = guessGlobs(gaps.map((p) => p.f), a.files).join(',');
  const L = [];
  L.push(BEGIN);
  L.push(`> Generated by [Stet](https://getstet.dev) ${core.VERSION} on ${new Date().toISOString().slice(0, 10)} from commit \`${r.head() || 'none'}\`. Run \`stet study "${a.topic}"\` to refresh this block; your sections below it are kept.`, '');
  L.push('## At a glance');
  L.push(`- **${a.key.length}** key files and **${a.supporting.length}** supporting file${a.supporting.length === 1 ? '' : 's'} they use, **${a.routes.length}** entry point${a.routes.length === 1 ? '' : 's'}, **${a.tests.length}** test file${a.tests.length === 1 ? '' : 's'}`);
  L.push(`- **${coreFiles.length - gaps.length} of these ${coreFiles.length} files** ${coreFiles.length - gaps.length === 1 ? 'is' : 'are'} covered by a lock or a protected path`, '');
  L.push('## Entry points');
  if (a.routes.length) { L.push('| Method | Path | Handled in |', '|---|---|---|'); for (const rt of a.routes) L.push(`| ${rt.method} | \`${rt.path}\` | \`${rt.file}\` |`); }
  else L.push('No HTTP routes found for this topic. It may be called from jobs, scripts or other modules — see the flow below.');
  L.push('');
  L.push('## Flow', 'Arrows point from a file to what it uses. Highlighted: the key files.', '', '```mermaid', mermaid(a), '```', '');
  L.push('## Key files', '| File | Why it matters | Key functions |', '|---|---|---|');
  for (const f of a.key) L.push(`| \`${f}\` | ${(a.why[f] || []).join('; ') || 'related'} | ${(a.symbols[f] || []).map((s) => '`' + s + '`').join(', ') || '—'} |`);
  if (a.supporting.length) {
    L.push('', '**Supporting files** (used by the key files — often where the rules live)', '', '| File | Functions |', '|---|---|');
    for (const f of a.supporting) L.push(`| \`${f}\` | ${(a.symbols[f] || []).map((s) => '`' + s + '`').join(', ') || '—'} |`);
  }
  L.push('');
  L.push('## Tests that cover it');
  L.push(a.tests.length ? a.tests.map((t) => `- \`${t}\``).join('\n') : '⚠️ No tests found that touch these files. Consider a snapshot lock (below).');
  L.push('');
  L.push('## What protects it');
  for (const p of a.protection) L.push(`- ${p.locks.length || p.protected ? '✅' : '⚠️'} \`${p.f}\`${p.locks.length ? ` — ${p.locks.join(', ')}` : ''}${p.protected ? ' — protected path' : ''}${!p.locks.length && !p.protected ? ' — not protected' : ''}`);
  if (gaps.length) {
    L.push('', 'Suggested:', '```bash',
      a.tests.length ? `stet lock add "${cap(a.topic)} works" --cmd "${testCmd(a.tests)}" --protect "${glob}"` : `stet lock add "${cap(a.topic)} output is stable" --snapshot "<script that prints a sample ${a.topic} result>" --protect "${glob}"`,
      `# and lock the output, so behaviour changes are caught even where tests are thin:`,
      `stet lock add "${cap(a.topic)} output is stable" --snapshot "<script that prints a sample ${a.topic} result>"`,
      `# for code that must never change casually, add it to "protect" in .stet/config.json`, '```');
  }
  L.push('');
  if (a.recent.length) L.push('## Recent changes', '```', ...a.recent, '```', '');
  if (a.decisions.length) L.push('## Decisions', ...a.decisions.map((d) => `- ${d}`), '');
  L.push('## Understand it with your AI',
    `1. Run \`stet context --flow ${slug}\` (this document + the key files, copied to your clipboard).`,
    '2. Paste it into ChatGPT or Claude with:',
    '', `> Using only the code provided, explain how **${a.topic}** works, step by step, from the entry points to the result. Name the files and functions for each step, list the business rules and edge cases you can see, and flag anything that looks risky or untested. Don't guess about code you haven't been shown.`, '',
    '3. Paste the answer into **How it works** below. Stet keeps that section when it refreshes this file.');
  L.push(END);
  return L.join('\n');
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- commands ----------
function study(r, topic, { out, max } = {}) {
  r.need();
  const a = analyse(r, topic, { max: +max || 12 });
  if (!a.key.length) throw new StetError(`Nothing in the source files mentions "${topic}" (searched for: ${a.st.join(', ')}). Try a word that appears in file or function names.`);
  const slug = slugify(topic);
  const rel = out || `docs/flows/${slug}.md`;
  const full = path.join(r.root, rel);
  let prev = null; try { prev = fs.readFileSync(full, 'utf8'); } catch {}
  const block = render(r, a, slug);
  let doc;
  if (prev && prev.includes(BEGIN) && prev.includes(END)) doc = prev.slice(0, prev.indexOf(BEGIN)) + block + prev.slice(prev.indexOf(END) + END.length);
  else doc = `# Flow: ${cap(topic)}\n\n${block}\n\n## How it works\n<!-- Paste your AI's explanation here, or write your own. Stet keeps this section. -->\n\n## Notes\n<!-- Gotchas, owners, links. Kept on refresh. -->\n`;
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, doc);
  const flows = r.json('flows.json', {});
  flows[slug] = { topic, doc: rel, at: new Date().toISOString(), commit: r.head() || null, files: Object.fromEntries([...a.key, ...a.supporting].map((f) => [f, sha(read(r, f))])) };
  r.wjson('flows.json', flows);
  const gaps = a.protection.filter((p) => !p.locks.length && !p.protected).length;
  const total = a.protection.length;
  const lines = [
    `${c.green('✓')} Studied ${c.bold(`"${topic}"`)} → ${c.cyan(rel)}${prev ? c.dim('  (refreshed; your notes kept)') : ''}`,
    `  ${a.key.length} key files · ${a.supporting.length} supporting · ${a.routes.length} entry points · ${a.tests.length} tests · flow diagram (mermaid)`,
    ...a.key.slice(0, 5).map((f) => c.dim(`    ${f}`)),
    gaps ? `  ${c.yellow('!')} ${gaps} of ${total} files in this flow aren't protected by a lock — suggestions are in the doc.` : `  ${c.green('✓')} every file in this flow is covered by a lock or protected path`,
    `  Next: ${c.cyan(`stet context --flow ${slug}`)} and ask your AI to explain it (prompt in the doc).`,
  ];
  return { text: lines.join('\n'), code: 0, data: { ...a, slug, doc: rel, markdown: doc } };
}

function driftOf(r, entry) {
  return Object.entries(entry.files || {}).filter(([f, h]) => sha(read(r, f)) !== h).map(([f]) => f);
}
function list(r) {
  r.need();
  const flows = r.json('flows.json', {});
  const keys = Object.keys(flows);
  if (!keys.length) return { text: 'No flows studied yet. Try: stet study "<topic>"   e.g. stet study "reconciliation"', code: 0 };
  return { code: 0, text: keys.map((k) => {
    const e = flows[k], d = driftOf(r, e);
    return `${d.length ? c.yellow('!') : c.green('✓')} ${c.bold(e.topic)}  ${c.dim(e.doc)}\n     ${d.length ? c.yellow(`${d.length} key file${d.length > 1 ? 's' : ''} changed since written (${d.slice(0, 3).join(', ')}) — refresh: stet study "${e.topic}"`) : c.dim(`up to date · written ${e.at.slice(0, 10)}`)}`;
  }).join('\n') };
}
// Used by `stet context --flow <slug>`: the flow doc plus the key files.
function flowFor(r, slugOrTopic) {
  const flows = r.json('flows.json', {});
  const e = flows[slugOrTopic] || flows[slugify(slugOrTopic)];
  if (!e) throw new StetError(`No flow "${slugOrTopic}". Create it first: stet study "${slugOrTopic}"`);
  let doc = ''; try { doc = fs.readFileSync(path.join(r.root, e.doc), 'utf8'); } catch {}
  return { entry: e, doc, files: Object.keys(e.files || {}), drift: driftOf(r, e) };
}

module.exports = { study, list, flowFor, analyse, driftOf, slugify };

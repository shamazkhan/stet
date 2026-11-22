#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const core = require('../lib/core');
const { c } = core;

const BOOL = new Set(['help', 'h', 'version', 'v', 'staged', 'warn', 'diff', 'changed', 'stdout', 'copy', 'all', 'mcp', 'uninstall', 'check', 'json', 'no-color', 'cached', 'no-update-check', 'yes', 'create', 'draft', 'no-fetch', 'ci', 'no-pr-format', 'agent', 'add']);
function parse(argv) {
  const pos = [], fl = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') || (a.startsWith('-') && a.length === 2)) {
      let k = a.replace(/^--?/, ''), v;
      if (k.includes('=')) [k, v] = [k.slice(0, k.indexOf('=')), k.slice(k.indexOf('=') + 1)];
      else if (BOOL.has(k)) v = true;
      else v = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      fl[k] = v;
    } else pos.push(a);
  }
  return { pos, fl };
}

const HELP = `${c.bold('stet')} ${c.dim(core.VERSION)} — keep AI coding agents from breaking what already works

${c.bold('Setup')}
  stet init [--name X] [--mcp] [--badge] [--ci] [--agent]   Create .stet/, AGENTS.md and CLAUDE.md (detects your stack)
  stet agent [--uninstall]            Claude Code hook: block PRs that don't follow this repo's PR format
  stet ci [--no-pr-format] [--force]  Write .github/workflows/stet.yml: guard, check and PR format on every PR
  stet badge [--add]                  README badge: "guarded by stet" (--add inserts it)
  stet sync                           Regenerate AGENTS.md from .stet/

${c.bold('Before an AI task')}
  stet scope set "<task>" --allow "src/x/**,tests/x/**" [--ticket LIN-142] [--strict]
                                      A ticket ID at the start of the task ("LIN-142 Add export") is picked up too.
                                      Uncommitted earlier work is carried (ignored unless it changes); --strict refuses instead
  stet scope add "<glob,glob>"        Widen the open scope without resetting it (stet scope remove narrows it)
  stet scope carry <file,…> | --all   Mark files guard flagged as leftovers from before the scope
  stet scope [show|clear|ticket]
  stet context [--files "glob,glob"] [--changed] [--diff] [--copy|--stdout|--out file]
                                      Git-synced context pack for any AI chat (no more uploading src/)

${c.bold('After an AI task')}
  stet guard [--staged] [--base ref] [--warn]   Flag changes outside scope or in protected paths
                                      Warns when the branch is behind origin/main (fetched; --no-fetch to skip)
  stet check [--only L1,L2]                      Run locked behaviours; non-zero exit if any broke
  stet scope done [--commit] [--force]           Guard + check, then commit the task's files and close the scope

${c.bold('Understand the code')}
  stet study "<topic>" [--out file] [--max 12]   Map a flow: key files, routes, diagram, tests, what protects it
                                      Writes docs/flows/<topic>.md; your notes in it are kept on refresh
  stet study                          List studied flows and which are out of date
  stet context --flow <topic>         The flow doc + its key files, for your AI

${c.bold('Linear')}  (optional · needs LINEAR_API_KEY in your shell)
  stet ticket LIN-142 [--stdout|--json]   Fetch a ticket; it goes into stet context and stet pr
  stet scope set LIN-142 --allow "<globs>"  Uses the Linear title as the task

${c.bold('Shipping')}
  stet pr [--what "<why>"] [--base main] [--check] [--stdout]
                                      Commit message + PR description from the diff, scope, checks and decisions
                                      Compares with the up-to-date origin/main by default
                                      Then: git commit -F .stet/.cache/commit.txt
  stet pr --create --what "<why>" [--draft]   Push and open the PR with gh, in this repo's format
  stet pr lint <file|->               Fail a PR description that doesn't follow the format (for CI)
  stet pr template                    Write .stet/pr-template.md to customise the format

${c.bold('Memory')}
  stet lock add "<behaviour>" --cmd "<proof command>" [--protect "glob,glob"]
  stet lock add "<behaviour>" --snapshot "<command that prints it>" [--mask "<regex>"]
                                      Locks the output itself (an export, a route list…); any change fails stet check
  stet lock approve L3 --why "<reason>"         Accept an intended output change (logged as a decision)
  stet lock suggest [--add]           Lock what Stet finds: test suites and "TypeScript compiles"
  stet lock [list|rm L2|rename L1 "<behaviour>"]   (add refuses a duplicate command; --force to override)
  stet decide "<decision>" [--why "<reason>"]   Append to the decision log
  stet decisions [--all]

${c.bold('Team')}
  stet handoff [--out HANDOFF.md]     Onboarding pack for a new dev or CTO, built from the repo
  stet hook install [--check] | stet hook uninstall
  stet update [--yes]                 Check for a newer Stet and install it (asks first unless --yes)
  stet status
  stet telemetry [on|off]             Opt-in anonymous usage count (off by default; never sends code)
  stet mcp                            Run as an MCP server (Claude Code, Cursor, any MCP client)
  stet mcp install                    Write .mcp.json for this project

Docs: https://getstet.dev/docs`;

async function main() {
  const { pos, fl } = parse(process.argv.slice(2));
  if (fl['no-color']) core.setColor(false);
  const [cmd, sub, ...rest] = pos;
  if (fl.version || fl.v) return console.log(core.VERSION);
  if (!cmd || cmd === 'help' || fl.help || fl.h) return console.log(HELP);
  if (cmd === 'mcp' && !sub) { require('../lib/usage').ping('mcp', core.VERSION); return require('../lib/mcp').serve(); }
  if (cmd === 'agent-hook') {
    // Called by Claude Code with the tool call on stdin. Exit 2 blocks it; anything unexpected lets it through.
    try {
      const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
      core.setColor(false);
      const h = core.agentHook(new core.Repo(core.findRoot(input.cwd || process.cwd())), input);
      if (h.code) process.stderr.write(h.text + '\n');
      process.exitCode = h.code;
    } catch { process.exitCode = 0; }
    return;
  }

  const root = core.findRoot(process.cwd());
  const r = new core.Repo(root);
  let res;
  switch (cmd) {
    case 'init': res = core.init(r, { name: fl.name, mcp: fl.mcp, badge: fl.badge, ci: fl.ci ? (fl['no-pr-format'] ? 'no-pr-format' : true) : false, agent: fl.agent }); break;
    case 'agent': res = core.agentInstall(r, { uninstall: fl.uninstall || sub === 'uninstall' }); break;
    case 'ci': res = core.ciWorkflow(r, { force: fl.force, prFormat: !fl['no-pr-format'] }); break;
    case 'badge': res = core.badge(r, { add: fl.add }); break;
    case 'sync': res = core.sync(r); break;
    case 'decide': res = core.decide(r, [sub, ...rest].filter(Boolean).join(' '), { why: fl.why }); break;
    case 'decisions': res = core.decisions(r, { all: fl.all }); break;
    case 'lock': case 'locks':
      if (!sub || sub === 'list' || sub === 'ls') res = core.lockList(r);
      else if (sub === 'add') res = core.lockAdd(r, rest.join(' '), { cmd: fl.cmd, protect: fl.protect, snapshot: fl.snapshot, mask: fl.mask, force: fl.force });
      else if (sub === 'suggest') res = core.lockSuggest(r, { add: fl.add });
      else if (sub === 'rename') res = core.lockRename(r, rest[0], rest.slice(1).join(' '));
      else if (sub === 'approve') res = core.lockApprove(r, rest[0], { why: fl.why });
      else if (sub === 'rm' || sub === 'remove') res = core.lockRm(r, rest[0]);
      else throw new core.StetError('Usage: stet lock [list|add|suggest|rm|rename|approve]');
      break;
    case 'check': res = core.check(r, { only: fl.only }); break;
    case 'scope':
      if (!sub || sub === 'show') res = core.scopeShow(r);
      else if (sub === 'set') {
        let task = rest.join(' ');
        const id = (typeof fl.ticket === 'string' ? fl.ticket : (task.match(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/) || [])[0] || '').toUpperCase();
        const notes = [];
        // With LINEAR_API_KEY set, fetch the ticket so its title and description reach the context pack.
        if (id && process.env.LINEAR_API_KEY) {
          try {
            const linear = require('../lib/linear');
            const issue = await linear.fetchIssue(id);
            linear.saveIssue(r, issue);
            if (task.trim().toUpperCase() === id) task = `${id} ${issue.title}`; // "stet scope set LIN-142" → use the Linear title
            notes.push(`${c.green('✓')} Linear: ${issue.title}${issue.state ? c.dim(' · ' + issue.state.name) : ''}`);
          } catch (e) { notes.push(c.yellow(`! Linear: ${e.message.split('\n')[0]} (scope set anyway)`)); }
        }
        res = core.scopeSet(r, task, { allow: fl.allow, ticket: fl.ticket, strict: fl.strict });
        if (notes.length) res.text += '\n' + notes.map((n) => '  ' + n).join('\n');
      }
      else if (sub === 'ticket') res = core.scopeTicket(r);
      else if (sub === 'clear') res = core.scopeClear(r);
      else if (sub === 'add' || sub === 'allow') res = core.scopeAdd(r, [...rest, typeof fl.allow === 'string' ? fl.allow : ''].join(','));
      else if (sub === 'remove' || sub === 'rm') res = core.scopeRemove(r, rest.join(','));
      else if (sub === 'carry') res = core.scopeCarry(r, rest.join(','), { all: fl.all });
      else if (sub === 'done') res = core.scopeDone(r, { commit: fl.commit, force: fl.force });
      else throw new core.StetError('Usage: stet scope [show|set|add|remove|carry|done|clear|ticket]');
      break;
    case 'guard': res = core.guard(r, { staged: fl.staged, base: fl.base, warn: fl.warn, noFetch: fl['no-fetch'] }); break;
    case 'context': case 'ctx': {
      core.setColor(false);
      const ctx = core.context(r, { files: fl.files, changed: fl.changed, diff: fl.diff, maxKB: fl['max-kb'], flow: fl.flow });
      core.setColor((process.stdout.isTTY || process.env.STET_COLOR === '1') && !process.env.NO_COLOR && !fl['no-color']);
      if (fl.stdout) { process.stdout.write(ctx.text); return; }
      const file = fl.out ? path.resolve(fl.out) : r.p('context.md');
      fs.writeFileSync(file, ctx.text);
      const copied = fl.copy || !fl.out ? core.copyToClipboard(ctx.text) : false;
      const kb = (Buffer.byteLength(ctx.text) / 1024).toFixed(1);
      res = { code: 0, text: `${c.green('✓')} Context pack: ${c.bold(path.relative(process.cwd(), file) || file)} ${c.dim(`(${kb} KB, ~${Math.round(Buffer.byteLength(ctx.text) / 4).toLocaleString()} tokens, ${ctx.data.files} files in tree, ${ctx.data.included} with contents)`)}\n  ${copied ? 'Copied to clipboard. Paste it at the top of your AI chat.' : 'Attach or paste this file at the top of your AI chat.'}` };
      break;
    }
    case 'handoff': {
      const h = core.handoff(r);
      if (fl.stdout) { process.stdout.write(h.text); return; }
      const file = path.resolve(fl.out || path.join(root, 'HANDOFF.md'));
      fs.writeFileSync(file, h.text);
      res = { code: 0, text: `${c.green('✓')} Handoff pack written to ${c.bold(path.relative(process.cwd(), file) || file)}` };
      break;
    }
    case 'pr': {
      if (sub === 'lint' || sub === 'check') {
        const src = rest[0] || fl.file;
        if (!src) throw new core.StetError('Usage: stet pr lint <file>   or: gh pr view --json body -q .body | stet pr lint -');
        const body = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(src), 'utf8');
        res = core.prLint(r, body); break;
      }
      if (sub === 'template') { res = core.prTemplateInit(r); break; }
      if (sub) throw new core.StetError('Usage: stet pr [--what "…"] [--base main] [--check] [--stdout] [--create [--draft]] | stet pr lint <file|-> | stet pr template');
      const what = typeof fl.what === 'string' ? fl.what : undefined;
      if (fl.create) { res = core.prCreate(r, { what, base: fl.base, draft: fl.draft, noFetch: fl['no-fetch'] }); break; }
      core.setColor(false);
      const p = core.pr(r, { base: fl.base, runCheck: fl.check, what, noFetch: fl['no-fetch'] });
      core.setColor((process.stdout.isTTY || process.env.STET_COLOR === '1') && !process.env.NO_COLOR && !fl['no-color']);
      if (fl.stdout) { process.stdout.write(p.text); return; }
      const copied = core.copyToClipboard(p.data.pr);
      const warn = [];
      if (p.data.violations.length) warn.push(c.yellow(`! ${p.data.violations.length} file(s) outside scope or protected — listed in the PR text.`));
      for (const w of p.data.warnings) warn.push(c.yellow(w));
      if (!p.data.checks) warn.push(c.yellow('! stet check has not been run for this change. Run it, or use stet pr --check.'));
      else if (p.data.checks.some((x) => !x.ok)) warn.push(c.red('✗ A locked behaviour is failing — listed in the PR text.'));
      res = { code: 0, text: [
        `${c.green('✓')} ${c.bold(p.data.title)}  ${c.dim(`(${p.data.files} files)`)}`,
        `  commit message  .stet/.cache/commit.txt   →  ${c.cyan('git commit -F .stet/.cache/commit.txt')}`,
        `  PR description  .stet/.cache/pr.md        →  ${copied ? 'copied to clipboard' : 'open the file, or run: stet pr --stdout'}`,
        ...warn.map((w) => '  ' + w),
        p.data.whatFilled ? c.dim(`  Open it: stet pr --create --what "…"   (or gh pr create --body-file .stet/.cache/pr.md)`) : c.dim('  Add the "What and why": stet pr --what "<1–2 sentences>"   (stet pr lint rejects a PR without it)'),
        p.data.against ? c.dim(`  Compared with ${p.data.against} (${p.data.base.slice(0, 7)}).`) : '',
      ].filter(Boolean).join('\n') };
      break;
    }
    case 'ticket': {
      const linear = require('../lib/linear');
      r.need();
      const id = (sub || r.scope.ticket || '').toUpperCase();
      if (!id) throw new core.StetError('Usage: stet ticket LIN-142   (or set a scope with a ticket ID first)');
      let issue = fl.cached ? linear.cachedIssue(r, id) : null;
      if (!issue) { issue = await linear.fetchIssue(id); linear.saveIssue(r, issue); }
      if (fl.stdout) { process.stdout.write(linear.issueMd(issue) + '\n'); return; }
      const body = linear.issueMd(issue).split('\n');
      res = { code: 0, text: [
        `${c.green('✓')} ${c.violet(issue.identifier)} ${c.bold(issue.title)}`,
        ...body.slice(1, 3).filter(Boolean).map((l) => '  ' + c.dim(l)),
        '', ...body.slice(3).join('\n').trim().split('\n').slice(0, 12).map((l) => '  ' + l),
      ].join('\n'), data: issue };
      res.text += '\n' + [
        '', c.dim(`  Saved for this repo. ${r.scope.ticket === issue.identifier ? 'It is included in stet context and stet pr.' : `Start work on it: stet scope set ${issue.identifier} --allow "<globs>"`}`),
      ].join('\n');
      break;
    }
    case 'study': {
      const study = require('../lib/study');
      const topic = [sub, ...rest].filter(Boolean).join(' ');
      if (!topic) { res = study.list(r); break; }
      core.setColor(false);
      const st = study.study(r, topic, { out: fl.out, max: fl.max });
      core.setColor((process.stdout.isTTY || process.env.STET_COLOR === '1') && !process.env.NO_COLOR && !fl['no-color']);
      if (fl.stdout) { process.stdout.write(st.data.markdown); return; }
      res = { code: 0, text: st.text.replace(/\x1b\[[0-9;]*m/g, ''), data: { doc: st.data.doc, key: st.data.key, routes: st.data.routes } };
      if (process.stdout.isTTY && !fl['no-color']) res.text = st.text;
      break;
    }
    case 'status': case 'st': res = core.status(r); break;
    case 'hook':
      if (sub === 'install') res = core.hook(r, { withCheck: fl.check });
      else if (sub === 'uninstall') res = core.hook(r, { uninstall: true });
      else throw new core.StetError('Usage: stet hook install [--check] | stet hook uninstall');
      break;
    case 'mcp':
      if (sub === 'install') res = core.mcpInstall(r); else throw new core.StetError('Usage: stet mcp | stet mcp install');
      break;
    case 'telemetry': case 'usage': {
      const usage = require('../lib/usage');
      if (sub === 'on' || sub === 'off') usage.set(sub === 'on');
      else if (sub) throw new core.StetError('Usage: stet telemetry [on|off]');
      res = { code: 0, text: usage.status(c, core.VERSION) };
      break;
    }
    case 'update': case 'upgrade': {
      const u = await require('../lib/update').update(core.VERSION, { c, yes: fl.yes });
      if (u.text) console.log(u.text);
      process.exitCode = u.code;
      return;
    }
    default: throw new core.StetError(`Unknown command "${cmd}". Run stet help.`);
  }
  if (fl.json) console.log(JSON.stringify({ code: res.code, data: res.data, text: res.text.replace(/\x1b\[[0-9;]*m/g, '') }, null, 2));
  else console.log(res.text);
  process.exitCode = res.code;
  if (cmd === 'init' && !fl.json) { try { await require('../lib/usage').askOnce(c); } catch {} }
  if (cmd !== 'telemetry' && cmd !== 'usage') { try { await require('../lib/usage').ping(cmd, core.VERSION); } catch {} }
  // Once a day at most: tell a person at a terminal about a newer release and offer to install it.
  try { await require('../lib/update').notify(core.VERSION, { fl, c }); } catch {}
}

main().catch((e) => {
  if (e instanceof core.StetError) { console.error(c.red('stet: ') + e.message); process.exitCode = e.code || 1; }
  else { console.error(e); process.exitCode = 2; }
});

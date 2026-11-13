#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const core = require('../lib/core');
const { c } = core;

const BOOL = new Set(['help', 'h', 'version', 'v', 'staged', 'warn', 'diff', 'changed', 'stdout', 'copy', 'all', 'mcp', 'uninstall', 'check', 'json', 'no-color']);
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
  stet init [--name X] [--mcp]        Create .stet/, AGENTS.md and CLAUDE.md (detects your stack)
  stet sync                           Regenerate AGENTS.md from .stet/

${c.bold('Before an AI task')}
  stet scope set "<task>" --allow "src/x/**,tests/x/**"
  stet scope [show|clear]
  stet context [--files "glob,glob"] [--changed] [--diff] [--copy|--stdout|--out file]
                                      Git-synced context pack for any AI chat (no more uploading src/)

${c.bold('After an AI task')}
  stet guard [--staged] [--base ref] [--warn]   Flag changes outside scope or in protected paths
  stet check [--only L1,L2]                      Run locked behaviours; non-zero exit if any broke

${c.bold('Memory')}
  stet lock add "<behaviour>" --cmd "<proof command>" [--protect "glob,glob"]
  stet lock [list|rm L2]
  stet decide "<decision>" [--why "<reason>"]   Append to the decision log
  stet decisions [--all]

${c.bold('Team')}
  stet handoff [--out HANDOFF.md]     Onboarding pack for a new dev or CTO, built from the repo
  stet hook install [--check] | stet hook uninstall
  stet status
  stet mcp                            Run as an MCP server (Claude Code, Cursor, any MCP client)
  stet mcp install                    Write .mcp.json for this project

Docs: https://stet-8fe08a58.base44.app`;

function main() {
  const { pos, fl } = parse(process.argv.slice(2));
  if (fl['no-color']) core.setColor(false);
  const [cmd, sub, ...rest] = pos;
  if (fl.version || fl.v) return console.log(core.VERSION);
  if (!cmd || cmd === 'help' || fl.help || fl.h) return console.log(HELP);
  if (cmd === 'mcp' && !sub) return require('../lib/mcp').serve();

  const root = core.findRoot(process.cwd());
  const r = new core.Repo(root);
  let res;
  switch (cmd) {
    case 'init': res = core.init(r, { name: fl.name, mcp: fl.mcp }); break;
    case 'sync': res = core.sync(r); break;
    case 'decide': res = core.decide(r, [sub, ...rest].filter(Boolean).join(' '), { why: fl.why }); break;
    case 'decisions': res = core.decisions(r, { all: fl.all }); break;
    case 'lock': case 'locks':
      if (!sub || sub === 'list' || sub === 'ls') res = core.lockList(r);
      else if (sub === 'add') res = core.lockAdd(r, rest.join(' '), { cmd: fl.cmd, protect: fl.protect });
      else if (sub === 'rm' || sub === 'remove') res = core.lockRm(r, rest[0]);
      else throw new core.StetError('Usage: stet lock [list|add|rm]');
      break;
    case 'check': res = core.check(r, { only: fl.only }); break;
    case 'scope':
      if (!sub || sub === 'show') res = core.scopeShow(r);
      else if (sub === 'set') res = core.scopeSet(r, rest.join(' '), { allow: fl.allow });
      else if (sub === 'clear') res = core.scopeClear(r);
      else throw new core.StetError('Usage: stet scope [show|set|clear]');
      break;
    case 'guard': res = core.guard(r, { staged: fl.staged, base: fl.base, warn: fl.warn }); break;
    case 'context': case 'ctx': {
      core.setColor(false);
      const ctx = core.context(r, { files: fl.files, changed: fl.changed, diff: fl.diff, maxKB: fl['max-kb'] });
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
    case 'status': case 'st': res = core.status(r); break;
    case 'hook':
      if (sub === 'install') res = core.hook(r, { withCheck: fl.check });
      else if (sub === 'uninstall') res = core.hook(r, { uninstall: true });
      else throw new core.StetError('Usage: stet hook install [--check] | stet hook uninstall');
      break;
    case 'mcp':
      if (sub === 'install') res = core.mcpInstall(r); else throw new core.StetError('Usage: stet mcp | stet mcp install');
      break;
    default: throw new core.StetError(`Unknown command "${cmd}". Run stet help.`);
  }
  if (fl.json) console.log(JSON.stringify({ code: res.code, data: res.data, text: res.text.replace(/\x1b\[[0-9;]*m/g, '') }, null, 2));
  else console.log(res.text);
  process.exitCode = res.code;
}

try { main(); } catch (e) {
  if (e instanceof core.StetError) { console.error(c.red('stet: ') + e.message); process.exitCode = e.code || 1; }
  else { console.error(e); process.exitCode = 2; }
}

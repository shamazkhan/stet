'use strict';
// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0). No dependencies.
const core = require('./core');

const TOOLS = [
  { name: 'stet_context', description: 'Get the live state of this repository: working agreement (charter, scope, locked behaviours, decisions), recent commits, uncommitted changes and the file tree. Call this at the start of every task and whenever you are unsure what exists. Optionally include file contents.',
    inputSchema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' }, description: 'Paths or globs whose contents to include, e.g. ["src/auth/**"]' }, changed: { type: 'boolean', description: 'Include contents of files changed since the scope was set' }, diff: { type: 'boolean', description: 'Include the diff since the scope was set' } } } },
  { name: 'stet_guard', description: 'Check that every file changed so far is inside the agreed task scope and outside protected paths. Run after making changes and before reporting a task as done.', inputSchema: { type: 'object', properties: {} } },
  { name: 'stet_check', description: 'Run the locked behaviours (the commands that prove existing features still work). Run before reporting a task as done. If one fails, fix your change; never edit the test or weaken the check.', inputSchema: { type: 'object', properties: { only: { type: 'array', items: { type: 'string' }, description: 'Lock IDs to run, e.g. ["L2"]. Default: all.' } } } },
  { name: 'stet_scope', description: 'Read the current task scope: the task and the file globs you may change. Only the human can change the scope.', inputSchema: { type: 'object', properties: {} } },
  { name: 'stet_decide', description: 'Record an architectural or product decision in the decision log so future sessions and teammates do not reopen it.', inputSchema: { type: 'object', properties: { decision: { type: 'string' }, why: { type: 'string' } }, required: ['decision'] } },
];

function callTool(name, a = {}) {
  const r = new core.Repo(core.findRoot(process.env.STET_ROOT || process.cwd()));
  switch (name) {
    case 'stet_context': return core.context(r, { files: a.files, changed: a.changed, diff: a.diff });
    case 'stet_guard': return core.guard(r, {});
    case 'stet_check': return core.check(r, { only: a.only });
    case 'stet_scope': return core.scopeShow(r);
    case 'stet_decide': return core.decide(r, a.decision, { why: a.why });
    default: throw new core.StetError('Unknown tool: ' + name);
  }
}

function serve(input = process.stdin, output = process.stdout) {
  core.setColor(false);
  const send = (m) => output.write(JSON.stringify(m) + '\n');
  let buf = '';
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
      handle(msg, send);
    }
  });
}

function handle(msg, send) {
  const { id, method, params = {} } = msg;
  const reply = (result) => id !== undefined && send({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message } });
  try {
    if (method === 'initialize') return reply({ protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stet', version: core.VERSION }, instructions: 'Stet keeps you inside the human\'s agreed scope. Call stet_context at the start of a task, stet_guard and stet_check before saying it is done.' });
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: TOOLS });
    if (method === 'tools/call') {
      try { const r = callTool(params.name, params.arguments || {}); return reply({ content: [{ type: 'text', text: r.text }], isError: r.code !== 0 }); }
      catch (e) { return reply({ content: [{ type: 'text', text: 'stet: ' + e.message }], isError: true }); }
    }
    if (method && method.startsWith('notifications/')) return;
    return fail(-32601, 'Method not found: ' + method);
  } catch (e) { return fail(-32603, e.message); }
}

module.exports = { serve, handle, TOOLS };

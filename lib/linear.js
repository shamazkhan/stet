'use strict';
// Optional Linear integration.
// The only network call Stet makes: when you ask for a ticket and LINEAR_API_KEY is set,
// it fetches that one issue from Linear. Nothing about your code is ever sent.
const fs = require('fs');
const path = require('path');
const { StetError } = require('./core');

const LINEAR_URL = process.env.STET_LINEAR_URL || 'https://api.linear.app/graphql';
const ID_RE = /^[A-Z][A-Z0-9]{1,9}-\d+$/;

const QUERY = `query StetIssue($id: String!) {
  issue(id: $id) {
    identifier title description url priorityLabel
    state { name } assignee { name } project { name }
    labels { nodes { name } }
  }
}`;

function apiKey() {
  const k = (process.env.LINEAR_API_KEY || '').trim();
  if (!k) {
    throw new StetError(
      'LINEAR_API_KEY is not set.\n' +
      '  1. In Linear: Settings → Security & access → Personal API keys → New key (read access is enough)\n' +
      '  2. Add it to your shell, not to the repo:  echo \'export LINEAR_API_KEY=lin_api_...\' >> ~/.zshrc && source ~/.zshrc'
    );
  }
  return k;
}

// Personal API keys go in the header as-is; OAuth tokens need "Bearer".
const authHeader = (k) => (k.startsWith('lin_oauth') ? `Bearer ${k}` : k);

async function fetchIssue(id) {
  id = String(id || '').trim().toUpperCase();
  if (!ID_RE.test(id)) throw new StetError(`"${id}" doesn't look like a Linear ticket ID (expected something like LIN-142).`);
  const key = apiKey();
  let res;
  try {
    res = await fetch(LINEAR_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authHeader(key) },
      body: JSON.stringify({ query: QUERY, variables: { id } }),
    });
  } catch (e) {
    throw new StetError(`Couldn't reach Linear (${e.cause?.code || e.message}). Check your internet connection.`);
  }
  if (res.status === 401 || res.status === 403) throw new StetError('Linear rejected the API key. Check LINEAR_API_KEY (Settings → Security & access → Personal API keys).');
  let body;
  try { body = await res.json(); } catch { throw new StetError(`Linear returned an unexpected response (HTTP ${res.status}).`); }
  const issue = body && body.data && body.data.issue;
  if (!issue) {
    const msg = (body && body.errors && body.errors[0] && body.errors[0].message) || 'not found';
    throw new StetError(`Linear ticket ${id}: ${msg}. Check the ID and that your key's workspace can see it.`);
  }
  return issue;
}

// Cache lives in .stet/.cache (gitignored), so ticket text never ends up in the repo.
const cachePath = (r, id) => r.p('.cache', 'tickets', `${id}.json`);
function saveIssue(r, issue) {
  const f = cachePath(r, issue.identifier);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ ...issue, fetchedAt: new Date().toISOString() }, null, 2) + '\n');
}
function cachedIssue(r, id) {
  if (!id) return null;
  try { return JSON.parse(fs.readFileSync(cachePath(r, id), 'utf8')); } catch { return null; }
}

// Markdown block used in the context pack and `stet ticket` output.
function issueMd(issue, { maxChars = 8000 } = {}) {
  const meta = [
    issue.state && issue.state.name && `Status: ${issue.state.name}`,
    issue.priorityLabel && issue.priorityLabel !== 'No priority' && `Priority: ${issue.priorityLabel}`,
    issue.assignee && issue.assignee.name && `Assignee: ${issue.assignee.name}`,
    issue.project && issue.project.name && `Project: ${issue.project.name}`,
    issue.labels && issue.labels.nodes && issue.labels.nodes.length && `Labels: ${issue.labels.nodes.map((l) => l.name).join(', ')}`,
  ].filter(Boolean).join(' · ');
  let desc = (issue.description || '').trim() || '_No description in Linear._';
  if (desc.length > maxChars) desc = desc.slice(0, maxChars) + '\n\n… (ticket description truncated)';
  return `## Ticket ${issue.identifier}: ${issue.title}\n${meta ? meta + '\n' : ''}${issue.url ? `Link: ${issue.url}\n` : ''}\n${desc}`;
}

module.exports = { fetchIssue, saveIssue, cachedIssue, issueMd, ID_RE };

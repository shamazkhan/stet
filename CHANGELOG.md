# Changelog

## 0.4.0 — 2026-11-14
- Snapshot locks: `stet lock add "<behaviour>" --snapshot "<command>"` saves the command's output as the approved version in `.stet/snapshots/`. `stet check` fails with a line diff when the output changes (export column order, routes, mapped data…).
- `stet lock approve L3 --why "…"` accepts an intended change and logs it as a decision.
- `--mask "<regex>"` hides volatile output such as timestamps and generated IDs.
- `stet guard` flags snapshot files edited by hand; AGENTS.md and the MCP tools tell agents never to approve snapshots.

## 0.3.0 — 2026-11-14
- Linear integration (optional, needs `LINEAR_API_KEY`): `stet ticket LIN-142` fetches a ticket; `stet scope set LIN-142 --allow …` uses the Linear title as the task.
- The ticket (title, status, priority, labels, link, description) is included at the top of `stet context`, so one paste gives your AI the ticket and the code.
- `stet pr` links the ticket ID to Linear.
- Privacy: only the ticket ID is sent to Linear; tickets are cached in `.stet/.cache/` (gitignored).

## 0.2.0 — 2026-11-14
- New `stet pr`: writes the commit message and PR description from facts — the diff since the scope was set, the ticket ID, scope result, `stet check` results and decisions logged during the task. `--check` runs the locks first, `--base main` compares against a branch.
- Ticket IDs: `stet scope set "LIN-142 Add CSV export" …` (or `--ticket LIN-142`) stores the ticket. It appears in AGENTS.md, context packs, guard output and PR text.
- `stet hook install` now also adds a prepare-commit-msg hook that prefixes commit messages with the ticket ID ("LIN-142: …"), never twice.
- New MCP tool `stet_pr` so Claude Code and Cursor can draft the PR text.
- The pre-commit hook falls back to `npx stet-cli` when stet isn't installed globally.

## 0.1.3 — 2026-11-14
- Stack detection now finds projects in subfolders (e.g. backend/, frontend/, apps/web) and languages from file types, so monorepos with Python + JavaScript are detected correctly.
- stet init creates one test lock per sub-project (e.g. `cd backend && pytest -q`).

## 0.1.2 — 2026-11-13
- Published on npm as stet-cli (the command is still `stet`).

## 0.1.1 — 2026-11-13
- stet check now says when a proof command cannot run (missing script, command not found) instead of reporting a regression.

## 0.1.0 — 2026-11-13
First release: init, sync, scope, guard, lock, check, context, decide, handoff, hook, status, mcp.

# Changelog

## 0.6.5 — 2026-11-15
- **Update notice.** Once a day, when you run Stet in a terminal, it checks npm for a newer release. If there is one, it says so, links to the changelog and asks "Update now? [y/N]". Answer N and it won't ask again for that version (one short reminder a day at most). Silent in CI, in the MCP server, with `--json`, or with `STET_NO_UPDATE_CHECK=1` / `NO_UPDATE_NOTIFIER=1`. Sends nothing about your code or repo.
- New `stet update [--yes]`: check now and install the latest release.
- `stet status` shows your version and whether a newer one is out.
- `stet init --mcp` now pins the MCP server to `stet-cli@latest`, so Claude Code and Cursor pick up new releases when they restart.

## 0.6.4 — 2026-11-15
- New `stet badge`: prints a "guarded by stet" README badge; `stet badge --add` inserts it into your README (joins an existing badge row, never twice). `stet init --badge` does it during setup.
- GitHub Action: [`shamazkhan/stet-action`](https://github.com/shamazkhan/stet-action) runs `stet guard` and `stet check` on every pull request against the merge base and writes the results to the job summary.
- AGENTS.md, PR descriptions, handoff packs and flow docs now link to getstet.dev.

## 0.6.2 — 2026-11-15
- Docs only: clearer npm description and keywords, README rewritten around "guardrails for AI coding agents", generic examples, more FAQ answers and links to the new guides at getstet.dev/guides. No code changes.
- Listed in the official MCP Registry as `io.github.shamazkhan/stet` (`server.json`, `mcpName` in package.json).

## 0.6.1 — 2026-11-15
Fixes from early-tester feedback (thank you!).
- **Carried files.** `stet scope set` now notices uncommitted work from an earlier task and carries it: guard ignores those files while they stay unchanged, and flags them clearly ("carried from earlier work, changed during this task") if the agent touches them again. Previously they were reported as out of scope.
- `--strict` on `stet scope set` refuses to start a scope until the working tree is clean, for teams that want one task per commit.
- `stet scope carry <file,…>` / `stet scope carry --all` marks files as earlier work after the fact. Guard now suggests it when out-of-scope files look like leftovers from before the scope was set.
- New `stet scope done [--commit]`: runs guard and check, commits only the task's files with the `stet pr` message, and closes the scope. Refuses while something is out of scope or failing (`--force` to close anyway).
- `stet pr` leaves carried earlier work out of the change list.
- `stet lock add` refuses a command that is already locked and names the existing lock (`--force` to add anyway). New `stet lock rename L1 "<behaviour>"`.
- `stet init` lists the locks it created (your test suite) so they aren't added twice.

## 0.6.0 — 2026-11-14
- New `stet study "<topic>"`: maps how a part of the codebase works from the code itself — key files, the supporting files they use, entry points (routes in Express, Fastify, FastAPI, Flask, NestJS, Django), a Mermaid flow diagram, covering tests, what protects it (with suggested locks for gaps), recent changes and related decisions. Writes `docs/flows/<topic>.md`.
- Re-running `stet study` refreshes the generated block and keeps your **How it works** and **Notes** sections.
- Drift detection: `stet study` (no topic) and `stet status` flag flows whose code changed since the doc was written.
- `stet context --flow <topic>` packs the flow doc with all its files for your AI; the doc includes a ready "explain this" prompt.
- `stet handoff` lists documented flows; new MCP tool `stet_study`.
- `stet help` links to getstet.dev/docs.

## 0.5.0 — 2026-11-14
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

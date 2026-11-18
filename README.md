# Stet: guardrails for AI coding agents

[![npm](https://img.shields.io/npm/v/stet-cli)](https://www.npmjs.com/package/stet-cli) [![licence: MIT](https://img.shields.io/badge/licence-MIT-black)](LICENSE) [![node](https://img.shields.io/badge/node-%3E%3D18-black)](https://nodejs.org) [![guarded by stet](https://img.shields.io/badge/guarded%20by-stet-FFF01F?labelColor=0E1116)](https://getstet.dev)

**Stop AI coding agents from breaking what already works.**  ·  Website and docs: [getstet.dev](https://getstet.dev)  ·  [Guides](https://getstet.dev/guides/index.html)

Stet is a free, open-source CLI and MCP server for teams using **Claude Code, Cursor, Codex, GitHub Copilot, Windsurf, Gemini CLI, ChatGPT or Claude**. You set the scope of each AI task, lock the behaviours that must keep working, and Stet blocks any change that goes outside the task or breaks a lock. It works the same with every tool, and the agent can read the rules but can't rewrite them.

```bash
npx stet-cli init      # in any git repo; Node 18+
```

**Use it when** your AI agent "tidies" files outside the task, breaks a feature you thought was safe, quietly edits a failing test, ignores your `AGENTS.md` / `CLAUDE.md` / Cursor rules, or forgets the project between chats.

- **Charter → `AGENTS.md`.** Write your product context and do's and don'ts once in `.stet/charter.md`. Stet keeps `AGENTS.md` (read by Codex, Cursor, Copilot and others) and `CLAUDE.md` in sync.
- **Locked behaviours.** Lock what already works, each with a command that proves it. `stet check` runs them all. If one fails, the AI fixes its change, not the test.
- **Snapshot locks.** Lock the *output* of a command (an export file, a list of API routes, mapped integration data). If it changes, `stet check` fails with a diff; `stet lock approve` accepts an intended change and logs why. No test file needed.
- **Scope guard.** Agree the task and the files it may touch. `stet guard` flags every file changed outside scope or in protected paths, even if the agent already committed it.
- **Git-synced context.** `stet context` builds a context pack from the live repo (charter, scope, locks, decisions, commits, uncommitted changes, file tree and the files you choose). Paste it into any chat instead of uploading your `src` folder.
- **Decision log.** `stet decide` records "we chose X because Y", so the next session doesn't reopen it.
- **Linear tickets.** `stet scope set LIN-142 --allow "…"` pulls the ticket's title and description from Linear into the context pack, so your AI gets the ticket and the code in one paste.
- **Ticket-aware PRs.** Put the ticket ID in the scope (`LIN-142 Add CSV export`) and `stet pr` writes the commit message and PR description from the real diff, scope, check results and decisions. The git hook adds the ticket ID to every commit.
- **Repo study.** `stet study "checkout"` maps how a part of the code works: key files, the files they depend on, entry points (routes), an import-flow diagram, the tests that cover it and what protects it. It writes `docs/flows/checkout.md`, keeps your own notes on refresh, and tells you when the code has changed since.
- **Handoff pack.** `stet handoff` writes an onboarding document for a new developer or CTO, built from the repo.
- **MCP server.** `stet mcp` exposes all of this as tools to Claude Code, Cursor and any MCP client.

No account. No telemetry. Your code never leaves your machine. Zero dependencies. Node 18+.
Network calls are limited to two: once a day, when you run Stet in a terminal, it asks npm for the latest version number so it can offer an update (no code or repo information is sent; off in CI, or with `STET_NO_UPDATE_CHECK=1`). And if you set `LINEAR_API_KEY`, `stet ticket` fetches the Linear ticket you name (only the ticket ID is sent).

## Install

```bash
npm install -g stet-cli        # or run any command with: npx stet-cli <command>
cd your-project
stet init
```

`stet init` detects your stack and test command, then creates:

```
.stet/
  charter.md      what this is, stack, always / never rules   ← edit this
  config.json     name, protected paths, ignore globs
  locks.json      locked behaviours
  scope.json      current task scope
  decisions.md    decision log
AGENTS.md         generated working agreement (your own text outside the stet block is kept)
CLAUDE.md         imports AGENTS.md for Claude Code
```

Commit `.stet/`, `AGENTS.md` and `CLAUDE.md`. Every agent and teammate then works from the same rules.

## The loop

```bash
# once: lock what already works
stet lock add "Login works" --cmd "node --test test/auth.test.js" --protect "src/auth/**"

# before each AI task (the ticket ID is optional)
stet scope set "LIN-142 Add CSV export" --allow "src/export/**,test/export*"
stet context --files "src/export/**"     # copied to clipboard; paste into your chat

# after the AI says it's done
stet guard        # anything outside scope or in protected paths?
stet check        # do all locked behaviours still pass?

# ship it
stet pr                                   # commit message + PR description (PR copied to clipboard)
git commit -F .stet/.cache/commit.txt     # "LIN-142: Add CSV export" + file list
```

Example output:

```
$ stet guard
Guarding 4 changed files (changes since 12b672b) · task: Add CSV export
  ✗ migrations/002_export.sql  out of scope  protected
  ✓ src/export/csv.js
  ✗ src/auth/session.js  out of scope  affects L2
  ✓ test/export.test.js

✗ 2 files outside scope or protected. Revert, or widen the scope on purpose.
! Changes touch locked behaviour L2. Run: stet check --only L2

$ stet check
Checking 2 locked behaviours
✗ L2   Login works (0.1s)
     │ not ok 1 - session expires after 30 minutes
     │ expected: 1800
     │ actual: 0

✗ 1 locked behaviour broken: L2. Fix the change, not the check.
```

## Snapshot locks

Many regressions are behaviour changes nobody wrote a test for: an export's column order, a renamed route, a mapping that shifted. Snapshot locks catch them with a tiny script that **prints** the behaviour:

```bash
stet lock add "Export format is stable" --snapshot "node scripts/export-sample.js" --protect "src/exports/**"
stet lock add "API routes unchanged"   --snapshot "node scripts/print-routes.js"
stet lock add "Report totals"          --snapshot "python scripts/report.py" --mask "\d{4}-\d\d-\d\dT[\d:.]+Z"
```

Stet saves the output to `.stet/snapshots/` as the approved version (commit it). From then on:

```
$ stet check
✗ L3   Export format is stable (0.2s, snapshot)
     │ output differs from the approved snapshot (- approved, + now):
     │ @@ line 1 @@
     │ - id,name,email
     │ + id,email,name
     │ intended? approve it: stet lock approve L3 --why "<reason>"
```

- **Intended change?** `stet lock approve L3 --why "PRO-91: email column first"` saves the new output and logs a decision.
- **Volatile output** (timestamps, generated IDs)? Add `--mask "<regex>"`; matches become `<masked>`.
- **Tampering:** `stet guard` flags any snapshot file edited by hand instead of through `stet lock approve`, and AGENTS.md tells agents never to approve snapshots themselves.
- Keep snapshot scripts deterministic: fixed sample data, sorted output, no network.

## Commands

| Command | What it does |
|---|---|
| `stet init [--name X] [--mcp]` | Set up `.stet/`, `AGENTS.md` and `CLAUDE.md`. `--mcp` also writes `.mcp.json`. Safe to re-run. |
| `stet sync` | Regenerate the Stet block in `AGENTS.md` (other commands do this automatically). |
| `stet scope set "<task>" --allow "<globs>" [--ticket LIN-142]` | Agree the task and the files it may touch. Records the current commit as the base. A ticket ID at the start of the task is picked up automatically. |
| `stet scope set … --strict` | Refuse to start a scope while there are uncommitted files. Without it, earlier uncommitted work is *carried*: guard ignores it unless it changes again. |
| `stet scope add "<globs>"` / `stet scope remove "<globs>"` | Widen or narrow the open scope without resetting it (task, base and carried files are kept). |
| `stet scope carry <file,…>` / `--all` | Mark files guard flagged as leftovers from before the scope. |
| `stet scope done [--commit] [--force]` | Run guard and check, commit only the task's files (with the `stet pr` message) and close the scope. |
| `stet scope [show\|clear\|ticket]` | Show or clear the scope, or print just the ticket ID. |
| `stet guard [--staged] [--base ref] [--warn] [--no-fetch]` | Check changes since the scope base (committed, staged, unstaged and untracked). Exits 1 on violations unless `--warn`. Warns when your branch is behind the up-to-date `origin/main`. |
| `stet lock add "<behaviour>" --cmd "<cmd>" [--protect "<globs>"]` | Lock a behaviour. `--protect` tells guard which files affect it. A command that is already locked is refused (`--force` to add anyway). |
| `stet lock rename L1 "<behaviour>"` | Rename a lock, e.g. the test-suite lock `stet init` creates. |
| `stet lock add "<behaviour>" --snapshot "<cmd>" [--mask "<regex>"]` | Lock a command's output as an approved snapshot in `.stet/snapshots/`. |
| `stet lock approve L3 --why "<reason>"` | Accept a changed snapshot on purpose; logged as a decision. |
| `stet lock [list\|rm L2]` | List locks with their last result, or remove one. |
| `stet check [--only L1,L2]` | Run locked behaviours. Exits 1 if any fail and shows the failing lines. |
| `stet context [--files "<globs>"] [--changed] [--diff] [--copy\|--stdout\|--out f]` | Build the context pack. By default it writes `.stet/context.md` and copies it to the clipboard. |
| `stet decide "<decision>" [--why "<reason>"]` | Add to the decision log. |
| `stet decisions [--all]` | List decisions. |
| `stet ticket [LIN-142] [--stdout] [--cached]` | Fetch a Linear ticket (needs `LINEAR_API_KEY`). It is included in `stet context` and linked in `stet pr`. With no ID, shows the current scope's ticket. |
| `stet pr [--what "…"] [--base main] [--check] [--stdout]` | Write `.stet/.cache/commit.txt` and `.stet/.cache/pr.md`: ticket, changed files, scope result, `stet check` results and decisions logged during the task. `--what` fills in "What and why", the only part you write. Compares with the up-to-date `origin/main` by default. `--check` runs the locks first. |
| `stet pr --create --what "…" [--draft]` | Push the branch and open the PR with the GitHub CLI, in this repo's format. |
| `stet pr lint <file\|->` | Fail a PR description that doesn't follow the format: missing sections, unwritten "What and why", hand-edited facts. Use it in CI. |
| `stet pr template` | Write `.stet/pr-template.md` to set your own PR sections. |
| `stet study "<topic>" [--out file] [--max 12]` | Map a flow: key and supporting files, routes, Mermaid diagram, tests, protection gaps. Writes `docs/flows/<topic>.md`. |
| `stet study` | List studied flows and which are out of date. |
| `stet context --flow <topic>` | Context pack with the flow doc and all its files. |
| `stet handoff [--out HANDOFF.md] [--stdout]` | Generate the onboarding pack. |
| `stet hook install [--check]` | Add git hooks: pre-commit blocks commits that stage out-of-scope or protected files (`--check` also runs `stet check`); prepare-commit-msg adds the ticket ID to commit messages. |
| `stet update [--yes]` | Check for a newer release and install it (asks first unless `--yes`). |
| `stet badge [--add]` | Print the "guarded by stet" README badge, or add it to your README. |
| `stet status` | One-screen summary. |
| `stet mcp` / `stet mcp install` | Run the MCP server over stdio, or write `.mcp.json`. |

Add `--json` to any command for machine-readable output.

## Repo study

Took over a codebase, or about to change a part you don't know well?

```bash
stet study "checkout"
```

Writes `docs/flows/checkout.md` from the code itself:

- **Entry points:** routes that lead into it (Express, Fastify, FastAPI, Flask, NestJS, Django `path()`)
- **Flow:** a Mermaid diagram of which file uses which (GitHub renders it)
- **Key files** and the **supporting files** they depend on, with their main functions
- **Tests** that cover it, and **what protects it** (locks, protected paths), with suggested `stet lock` commands for the gaps
- **Recent changes** and related **decisions**

Then get the explanation from your AI:

```bash
stet context --flow checkout   # the flow doc + all its files, copied to your clipboard
```

The doc includes a ready prompt. Paste the answer into its **How it works** section: Stet keeps that section and your **Notes** when you refresh the doc. `stet study` on its own lists your flows and flags the ones whose code changed since they were written; `stet status` and `stet handoff` include them too.

Works best with JavaScript/TypeScript and Python (imports and routes are understood); other languages get key files, symbols and tests.

## Linear

1. In Linear: **Settings → Security & access → Personal API keys → New key** (read access is enough).
2. Put it in your shell, never in the repo:

```bash
echo 'export LINEAR_API_KEY=lin_api_...' >> ~/.zshrc && source ~/.zshrc
```

3. Work from tickets:

```bash
stet scope set LIN-142 --allow "src/export/**,tests/export/**"   # task = the Linear title
stet context --files "src/export/**"   # ticket + rules + code, ready to paste into ChatGPT
stet ticket                            # show the current ticket again (stet ticket LIN-150 for another)
stet pr                                # PR text links back to the Linear ticket
```

Tickets are cached in `.stet/.cache/` (gitignored). Only the ticket ID is sent to Linear; nothing about your code is.

## Use with your AI tools

**Claude Code:** run `stet init --mcp`, or `claude mcp add stet -- npx -y stet-cli@latest mcp`. Claude Code reads `CLAUDE.md`, which imports `AGENTS.md`.

**Cursor:** add this to `.cursor/mcp.json`:

```json
{ "mcpServers": { "stet": { "command": "npx", "args": ["-y", "stet-cli@latest", "mcp"] } } }
```

**Codex, Copilot, Windsurf, Gemini CLI:** they read `AGENTS.md` directly.

**ChatGPT, Claude.ai, Gemini (chat):** run `stet context --files "<what you're working on>"` and paste the result.

MCP tools: `stet_context`, `stet_guard`, `stet_check`, `stet_scope` (read-only; only the human sets scope), `stet_pr`, `stet_study` and `stet_decide`.

## Configuration

`.stet/config.json`:

```json
{
  "name": "my-app",
  "protect": ["migrations/**", ".github/**"],
  "ignore": ["fixtures/**"],
  "maxFileKB": 64,
  "checkTimeoutSec": 600
}
```

Globs support `*`, `**` and `?`. A bare folder name like `migrations` matches everything inside it.

## In CI (GitHub Action)

Fail pull requests where an agent strayed outside the task, touched protected paths or broke a lock:

```yaml
# .github/workflows/stet.yml
name: Stet
on: [pull_request]
jobs:
  stet:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - uses: shamazkhan/stet-action@v1
```

Inputs, monorepo use and warn-only mode: [shamazkhan/stet-action](https://github.com/shamazkhan/stet-action). Any other CI: `npx -y stet-cli guard --base origin/main` and `npx -y stet-cli check`.

## Badge

Show contributors that AI changes here are guarded:

```bash
stet badge --add      # or copy the markdown from: stet badge
```

[![guarded by stet](https://img.shields.io/badge/guarded%20by-stet-FFF01F?labelColor=0E1116)](https://getstet.dev)

## FAQ

**Does Stet send my code anywhere?** No. It's a local CLI with no telemetry. It makes two kinds of network call: a once-a-day check of the latest version number on npm (terminal only; off in CI or with `STET_NO_UPDATE_CHECK=1`), and the optional Linear fetch, which sends just the ticket ID you ask for.

**How do I stay up to date?** Stet tells you when a new release is out and asks whether to install it (`[y/N]`). Or run `stet update` any time. With npx, use `npx stet-cli@latest`. `stet init --mcp` pins the MCP server to `stet-cli@latest`, so Claude Code and Cursor pick up new releases on restart.

**Is this just AGENTS.md?** `AGENTS.md` tells the agent the rules. Stet keeps those rules current, and `guard` and `check` verify the agent actually followed them.

**How is it different from AI code review bots?** Review bots comment on a pull request after the fact. Stet checks the agreed scope and locked behaviours deterministically, before the change is committed, so review starts from a diff that is already in scope.

**Does it work with ChatGPT or Claude in the browser?** Yes: `stet context` copies the rules, scope and code to paste in; then run `stet guard` and `stet check` on the result.

**What if a locked behaviour has to change on purpose?** Change it deliberately: update the test, then `stet lock rm` / `stet lock add`, and record why with `stet decide`.

## Guides

- [How to stop AI coding agents from breaking working code](https://getstet.dev/guides/stop-ai-coding-agents-breaking-code.html)
- [How to keep Claude Code, Cursor and Codex inside the task](https://getstet.dev/guides/keep-ai-agents-in-scope.html)
- [AGENTS.md, CLAUDE.md and Cursor rules are not enforcement](https://getstet.dev/guides/rules-files-are-not-enforcement.html)
- [Guardrails for AI coding: approaches compared](https://getstet.dev/guides/ai-coding-guardrails-compared.html)

## Licence

MIT

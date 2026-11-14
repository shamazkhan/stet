# stet

**Stop AI coding agents from breaking what already works.**  ·  Docs: [getstet.dev/docs](https://getstet.dev/docs)

Stet is a small, free command-line tool that gives every AI coding tool (Claude Code, Cursor, Codex, Copilot, Windsurf or a plain chat) the same rules, the same up-to-date picture of your repo, and a hard check before work is called done.

- **Charter → `AGENTS.md`.** Write your product context and do's and don'ts once in `.stet/charter.md`. Stet keeps `AGENTS.md` (read by Codex, Cursor, Copilot and others) and `CLAUDE.md` in sync.
- **Locked behaviours.** Lock what already works, each with a command that proves it. `stet check` runs them all. If one fails, the AI fixes its change, not the test.
- **Snapshot locks.** Lock the *output* of a command (an export file, a list of API routes, mapped integration data). If it changes, `stet check` fails with a diff; `stet lock approve` accepts an intended change and logs why. No test file needed.
- **Scope guard.** Agree the task and the files it may touch. `stet guard` flags every file changed outside scope or in protected paths, even if the agent already committed it.
- **Git-synced context.** `stet context` builds a context pack from the live repo (charter, scope, locks, decisions, commits, uncommitted changes, file tree and the files you choose). Paste it into any chat instead of uploading your `src` folder.
- **Decision log.** `stet decide` records "we chose X because Y", so the next session doesn't reopen it.
- **Linear tickets.** `stet scope set LIN-142 --allow "…"` pulls the ticket's title and description from Linear into the context pack, so your AI gets the ticket and the code in one paste.
- **Ticket-aware PRs.** Put the ticket ID in the scope (`LIN-142 Add CSV export`) and `stet pr` writes the commit message and PR description from the real diff, scope, check results and decisions. The git hook adds the ticket ID to every commit.
- **Handoff pack.** `stet handoff` writes an onboarding document for a new developer or CTO, built from the repo.
- **MCP server.** `stet mcp` exposes all of this as tools to Claude Code, Cursor and any MCP client.

No account. No telemetry. Your code never leaves your machine. Zero dependencies. Node 18+.
The only network call is optional: if you set `LINEAR_API_KEY`, `stet ticket` fetches the Linear ticket you name (only the ticket ID is sent).

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
stet lock add "UAE VAT maths is correct" --cmd "node --test test/vat.test.js" --protect "src/vat/**"

# before each AI task (the ticket ID is optional)
stet scope set "LIN-142 Add CSV export of invoices" --allow "src/export/**,test/export*"
stet context --files "src/invoices/**"     # copied to clipboard; paste into your chat

# after the AI says it's done
stet guard        # anything outside scope or in protected paths?
stet check        # do all locked behaviours still pass?

# ship it
stet pr                                   # commit message + PR description (PR copied to clipboard)
git commit -F .stet/.cache/commit.txt     # "LIN-142: Add CSV export of invoices" + file list
```

Example (real output from a sample accounting app):

```
$ stet guard
Guarding 4 changed files (changes since 12b672b) · task: Add CSV export of invoices
  ✗ migrations/002_export.sql  out of scope  protected
  ✓ src/export/csv.js
  ✗ src/vat/vat.js  out of scope  affects L2
  ✓ test/export.test.js

✗ 2 files outside scope or protected. Revert, or widen the scope on purpose.
! Changes touch locked behaviour L2. Run: stet check --only L2

$ stet check
Checking 2 locked behaviours
✗ L2   UAE VAT maths is correct (0.1s)
     │ not ok 1 - 5% standard VAT, rounded to fils
     │ expected: 10
     │ actual: 9.99

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
     │ - id,net,vat
     │ + id,vat,net
     │ intended? approve it: stet lock approve L3 --why "<reason>"
```

- **Intended change?** `stet lock approve L3 --why "PRO-91: VAT before net"` saves the new output and logs a decision.
- **Volatile output** (timestamps, generated IDs)? Add `--mask "<regex>"`; matches become `<masked>`.
- **Tampering:** `stet guard` flags any snapshot file edited by hand instead of through `stet lock approve`, and AGENTS.md tells agents never to approve snapshots themselves.
- Keep snapshot scripts deterministic: fixed sample data, sorted output, no network.

## Commands

| Command | What it does |
|---|---|
| `stet init [--name X] [--mcp]` | Set up `.stet/`, `AGENTS.md` and `CLAUDE.md`. `--mcp` also writes `.mcp.json`. Safe to re-run. |
| `stet sync` | Regenerate the Stet block in `AGENTS.md` (other commands do this automatically). |
| `stet scope set "<task>" --allow "<globs>" [--ticket LIN-142]` | Agree the task and the files it may touch. Records the current commit as the base. A ticket ID at the start of the task is picked up automatically. |
| `stet scope [show\|clear\|ticket]` | Show or clear the scope, or print just the ticket ID. |
| `stet guard [--staged] [--base ref] [--warn]` | Check changes since the scope base (committed, staged, unstaged and untracked). Exits 1 on violations unless `--warn`. |
| `stet lock add "<behaviour>" --cmd "<cmd>" [--protect "<globs>"]` | Lock a behaviour. `--protect` tells guard which files affect it. |
| `stet lock add "<behaviour>" --snapshot "<cmd>" [--mask "<regex>"]` | Lock a command's output as an approved snapshot in `.stet/snapshots/`. |
| `stet lock approve L3 --why "<reason>"` | Accept a changed snapshot on purpose; logged as a decision. |
| `stet lock [list\|rm L2]` | List locks with their last result, or remove one. |
| `stet check [--only L1,L2]` | Run locked behaviours. Exits 1 if any fail and shows the failing lines. |
| `stet context [--files "<globs>"] [--changed] [--diff] [--copy\|--stdout\|--out f]` | Build the context pack. By default it writes `.stet/context.md` and copies it to the clipboard. |
| `stet decide "<decision>" [--why "<reason>"]` | Add to the decision log. |
| `stet decisions [--all]` | List decisions. |
| `stet ticket [LIN-142] [--stdout] [--cached]` | Fetch a Linear ticket (needs `LINEAR_API_KEY`). It is included in `stet context` and linked in `stet pr`. With no ID, shows the current scope's ticket. |
| `stet pr [--base main] [--check] [--stdout]` | Write `.stet/.cache/commit.txt` and `.stet/.cache/pr.md` from the diff since the scope was set: ticket, changed files, scope result, `stet check` results and decisions logged during the task. `--check` runs the locks first. |
| `stet handoff [--out HANDOFF.md] [--stdout]` | Generate the onboarding pack. |
| `stet hook install [--check]` | Add git hooks: pre-commit blocks commits that stage out-of-scope or protected files (`--check` also runs `stet check`); prepare-commit-msg adds the ticket ID to commit messages. |
| `stet status` | One-screen summary. |
| `stet mcp` / `stet mcp install` | Run the MCP server over stdio, or write `.mcp.json`. |

Add `--json` to any command for machine-readable output.

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

**Claude Code:** run `stet init --mcp`, or `claude mcp add stet -- npx -y stet-cli mcp`. Claude Code reads `CLAUDE.md`, which imports `AGENTS.md`.

**Cursor:** add this to `.cursor/mcp.json`:

```json
{ "mcpServers": { "stet": { "command": "npx", "args": ["-y", "stet-cli", "mcp"] } } }
```

**Codex, Copilot, Windsurf, Gemini CLI:** they read `AGENTS.md` directly.

**ChatGPT, Claude.ai, Gemini (chat):** run `stet context --files "<what you're working on>"` and paste the result.

MCP tools: `stet_context`, `stet_guard`, `stet_check`, `stet_scope` (read-only; only the human sets scope), `stet_pr` and `stet_decide`.

## Configuration

`.stet/config.json`:

```json
{
  "name": "Ledgerly",
  "protect": ["migrations/**", ".github/**"],
  "ignore": ["fixtures/**"],
  "maxFileKB": 64,
  "checkTimeoutSec": 600
}
```

Globs support `*`, `**` and `?`. A bare folder name like `migrations` matches everything inside it.

## In CI

```yaml
- run: npx -y stet-cli guard --base origin/main --warn
- run: npx -y stet-cli check
```

## FAQ

**Does Stet send my code anywhere?** No. It's a local CLI with no telemetry. Its only network call is the optional Linear fetch, which sends just the ticket ID you ask for.

**Is this just AGENTS.md?** `AGENTS.md` tells the agent the rules. Stet keeps those rules current, and `guard` and `check` verify the agent actually followed them.

**What if a locked behaviour has to change on purpose?** Change it deliberately: update the test, then `stet lock rm` / `stet lock add`, and record why with `stet decide`.

## Licence

MIT

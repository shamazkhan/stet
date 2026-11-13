# stet

**Stop AI coding agents from breaking what already works.**

Stet is a small, free command-line tool that gives every AI coding tool (Claude Code, Cursor, Codex, Copilot, Windsurf or a plain chat) the same rules, the same up-to-date picture of your repo, and a hard check before work is called done.

- **Charter → `AGENTS.md`.** Write your product context and do's and don'ts once in `.stet/charter.md`. Stet keeps `AGENTS.md` (read by Codex, Cursor, Copilot and others) and `CLAUDE.md` in sync.
- **Locked behaviours.** Lock what already works, each with a command that proves it. `stet check` runs them all. If one fails, the AI fixes its change, not the test.
- **Scope guard.** Agree the task and the files it may touch. `stet guard` flags every file changed outside scope or in protected paths, even if the agent already committed it.
- **Git-synced context.** `stet context` builds a context pack from the live repo (charter, scope, locks, decisions, commits, uncommitted changes, file tree and the files you choose). Paste it into any chat instead of uploading your `src` folder.
- **Decision log.** `stet decide` records "we chose X because Y", so the next session doesn't reopen it.
- **Handoff pack.** `stet handoff` writes an onboarding document for a new developer or CTO, built from the repo.
- **MCP server.** `stet mcp` exposes all of this as tools to Claude Code, Cursor and any MCP client.

No account. No telemetry. Your code never leaves your machine. Zero dependencies. Node 18+.

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

# before each AI task
stet scope set "Add CSV export of invoices" --allow "src/export/**,test/export*"
stet context --files "src/invoices/**"     # copied to clipboard; paste into your chat

# after the AI says it's done
stet guard        # anything outside scope or in protected paths?
stet check        # do all locked behaviours still pass?
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

## Commands

| Command | What it does |
|---|---|
| `stet init [--name X] [--mcp]` | Set up `.stet/`, `AGENTS.md` and `CLAUDE.md`. `--mcp` also writes `.mcp.json`. Safe to re-run. |
| `stet sync` | Regenerate the Stet block in `AGENTS.md` (other commands do this automatically). |
| `stet scope set "<task>" --allow "<globs>"` | Agree the task and the files it may touch. Records the current commit as the base. |
| `stet scope [show\|clear]` | Show or clear the scope. |
| `stet guard [--staged] [--base ref] [--warn]` | Check changes since the scope base (committed, staged, unstaged and untracked). Exits 1 on violations unless `--warn`. |
| `stet lock add "<behaviour>" --cmd "<cmd>" [--protect "<globs>"]` | Lock a behaviour. `--protect` tells guard which files affect it. |
| `stet lock [list\|rm L2]` | List locks with their last result, or remove one. |
| `stet check [--only L1,L2]` | Run locked behaviours. Exits 1 if any fail and shows the failing lines. |
| `stet context [--files "<globs>"] [--changed] [--diff] [--copy\|--stdout\|--out f]` | Build the context pack. By default it writes `.stet/context.md` and copies it to the clipboard. |
| `stet decide "<decision>" [--why "<reason>"]` | Add to the decision log. |
| `stet decisions [--all]` | List decisions. |
| `stet handoff [--out HANDOFF.md] [--stdout]` | Generate the onboarding pack. |
| `stet hook install [--check]` | Add a git pre-commit hook that blocks commits staging out-of-scope or protected files. `--check` also runs `stet check`. |
| `stet status` | One-screen summary. |
| `stet mcp` / `stet mcp install` | Run the MCP server over stdio, or write `.mcp.json`. |

Add `--json` to any command for machine-readable output.

## Use with your AI tools

**Claude Code:** run `stet init --mcp`, or `claude mcp add stet -- npx -y stet-cli mcp`. Claude Code reads `CLAUDE.md`, which imports `AGENTS.md`.

**Cursor:** add this to `.cursor/mcp.json`:

```json
{ "mcpServers": { "stet": { "command": "npx", "args": ["-y", "stet-cli", "mcp"] } } }
```

**Codex, Copilot, Windsurf, Gemini CLI:** they read `AGENTS.md` directly.

**ChatGPT, Claude.ai, Gemini (chat):** run `stet context --files "<what you're working on>"` and paste the result.

MCP tools: `stet_context`, `stet_guard`, `stet_check`, `stet_scope` (read-only; only the human sets scope) and `stet_decide`.

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

**Does Stet send my code anywhere?** No. It's a local CLI with no network calls and no telemetry.

**Is this just AGENTS.md?** `AGENTS.md` tells the agent the rules. Stet keeps those rules current, and `guard` and `check` verify the agent actually followed them.

**What if a locked behaviour has to change on purpose?** Change it deliberately: update the test, then `stet lock rm` / `stet lock add`, and record why with `stet decide`.

## Licence

MIT

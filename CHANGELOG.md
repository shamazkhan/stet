# Changelog

## 0.1.3 — 2026-11-14
- Stack detection now finds projects in subfolders (e.g. backend/, frontend/, apps/web) and languages from file types, so monorepos with Python + JavaScript are detected correctly.
- stet init creates one test lock per sub-project (e.g. `cd backend && pytest -q`).

## 0.1.2 — 2026-11-13
- Published on npm as stet-cli (the command is still `stet`).

## 0.1.1 — 2026-11-13
- stet check now says when a proof command cannot run (missing script, command not found) instead of reporting a regression.

## 0.1.0 — 2026-11-13
First release: init, sync, scope, guard, lock, check, context, decide, handoff, hook, status, mcp.

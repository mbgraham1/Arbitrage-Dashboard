---
name: Merge clobber recovery
description: What to check when a task merge reverts uncommitted main-agent work
---
Task merges commit/reset the working tree; uncommitted main-agent work can be silently reverted mid-turn (seen as: missing exports, unmounted routers, reverted openapi.yaml while the generated client survives, parallel subagents reporting "my edits were reverted").

**How to recover:** `git stash list` — the merge stashes the pre-merge working tree as `stash@{0}`; restore individual files with `git show stash@{0}:path > path`. Diff stash vs HEAD before restoring so genuinely merged changes aren't lost.

**How to detect early:** after any merge notification, run per-artifact `tsc --noEmit` and smoke-curl recently added endpoints (a running tsx server may still serve OLD code from memory — a working endpoint does NOT prove the source file is intact). Also re-check router mounts (routes/index.ts) and openapi.yaml sections for recent additions.

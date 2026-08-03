# mbuckaway/kimi-code — fork guide

Public, long-lived fork of [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code).
This document describes the fork's branching, release, and update design.
Track individual changes in [PATCHES.md](PATCHES.md).

## Branches

- **`main`** — pristine mirror of `upstream/main`. Protected: PR-only, no
  reviews required, rebase-merge only (stays byte-identical to upstream).
  Never commit to it directly.
- **`fork/main`** — the fork mainline: upstream + all fork changes. Protected:
  PR-only, no reviews required. Releases are cut from this branch.

Both protections are GitHub rulesets (`pristine-main`, `fork-mainline`) with
no bypass actors — everything, including automation, lands via PR.

## Sync automation (`.github/workflows/fork-sync.yml`)

Every 6 hours (and on demand):

1. `main`: opens a PR from `upstream/main` and auto-merges with `--rebase`
   (always a fast-forward, never conflicts).
2. `fork/main`: merges `upstream/main` into a sync branch, opens a PR, and
   auto-merges. On conflict the run fails and opens a tracking issue; resolve
   manually on a sync branch (the open PR updates in place).

Requires the `FORK_SYNC_PAT` secret (PAT with `contents`, `pull_requests`,
`workflows` scopes) — `GITHUB_TOKEN`-created PRs don't trigger CI and can't
carry upstream workflow-file changes.

## Releases (`.github/workflows/fork-release.yml`)

- Version format: **`<upstream-base>-MB.<x>.<y>`** (e.g. `0.31.1-MB.1.0`).
  Dots, not hyphens, inside the prerelease — the updater compares versions
  with `semver.gt`, and `MB-10` would sort before `MB-2` lexically. The MB
  counter resets automatically when the upstream base version (read from
  `main`'s `apps/kimi-code/package.json`) moves.
- Every push to `fork/main` opens a `chore: release <version>` PR and
  auto-merges it; the merge tags `v<version>` (no slashes, so release asset
  URLs stay clean), creates a GitHub Release, builds unsigned native binaries
  for the 6 targets, uploads zips + `manifest.json`, and refreshes the
  `gh-pages` update channel.
- `workflow_dispatch` with `bump: major` bumps `MB.x.0` instead of the minor.
- macOS binaries are **unsigned** (no Apple secrets on the fork): users must
  remove the quarantine attribute on first run.

## Update channel (gh-pages)

The CLI's updater polls `KIMI_CODE_CDN_BASE` (patched in
`apps/kimi-code/src/constant/app.ts` to `https://mbuckaway.github.io/kimi-code`):

- `latest` — plain-text semver
- `latest.json` — `{version, publishedAt, rollout: []}` (empty rollout =
  immediate full rollout; schema in `apps/kimi-code/src/cli/update/cdn.ts`)
- `install.sh` — native installer (below)
- `sha256/<target>.sha256` — per-platform checksums

Native installs self-update by re-running the channel's `install.sh`
(`apps/kimi-code/src/cli/update/preflight.ts`), so no separate update logic
is needed.

## Installing the fork

```bash
curl -fsSL https://mbuckaway.github.io/kimi-code/install.sh | bash
```

Installs `~/.kimi-code/bin/kimi`. Windows (`install.ps1`) and npm
(`@mbuckaway/kimi-code`) distribution are not wired up yet.

## Daily workflow

- New upstreamable work: branch off `main`, PR to `MoonshotAI/kimi-code`,
  and also PR the change into `fork/main` (with a PATCHES.md row).
- Fork-only work: branch off `fork/main`, PR back to `fork/main`.
- Local rebase: `git fetch upstream && git rebase upstream/main`. Lockfile
  conflicts: take upstream's `pnpm-lock.yaml`, run `pnpm install`, never
  delete/regenerate it.
- Global git config assumed: `pull.rebase`, `rebase.autoStash`,
  `rebase.updateRefs`, `rerere.enabled` (all true).

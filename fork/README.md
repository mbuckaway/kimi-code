# mbuckaway/kimi-code — fork guide

Public, long-lived fork of [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code).
This document describes the fork's branching, release, and update design.
Track individual changes in [PATCHES.md](PATCHES.md).

## Branches

- **`main`** — pristine mirror of `upstream/main` (byte-identical by
  definition). Protected by the `pristine-main` ruleset (deletion and
  non-fast-forward blocked), but with a repository-admin bypass so
  `fork-sync.yml` can push `upstream/main` to it directly. Nothing else may
  commit to it.
- **`fork/main`** — the fork mainline: upstream + all fork changes. Protected:
  PR-only, no reviews required. Releases are cut from this branch.

Both protections are GitHub rulesets (`pristine-main`, `fork-mainline`).
`pristine-main` allows repository admins (and the sync PAT) to push the
upstream mirror directly; `fork-mainline` has no bypass — every change to
`fork/main`, including the release version bump, lands via PR. The repo's
**default branch is `fork/main`** (required so the scheduled `fork-sync.yml`
runs — GitHub only fires cron workflows from the default branch).

## Sync automation (`.github/workflows/fork-sync.yml`)

Every ~48 hours (`23 7 */2 * *` — cron has no true 48-hour field) and on demand:

1. `main`: fast-forwards `upstream/main` into the mirror with a direct push
   (falling back to a force-with-lease reset if the mirror ever diverged).
2. `fork/main`: merges `upstream/main` into a sync branch, opens a PR, and
   waits for a human merge. On conflict the run fails and opens (or comments
   on) a tracking issue listing the conflicting files; a later conflict-free
   sync closes the issue. Resolve manually on a sync branch and PR it.

Requires the `FORK_SYNC_PAT` secret (PAT with `contents`, `pull_requests`,
`workflows` scopes) — `GITHUB_TOKEN`-created PRs don't trigger CI and can't
carry upstream workflow-file changes.

## Releases (`.github/workflows/fork-release.yml`)

- Version format: **`<base>-MB.<x>.<y>`** (e.g. `0.31.1-MB.1.0`). Dots, not
  hyphens, inside the prerelease — the updater compares versions with
  `semver.gt`, and `MB-10` would sort before `MB-2` lexically. The base is
  read from the fork's OWN `apps/kimi-code/package.json`, so releases never
  depend on the upstream mirror; the MB counter is **continuous across bases**
  (`0.33.0-MB.1.3` → `0.34.0-MB.1.4`) because the fork keeps carrying its own
  changes when upstream moves — a reset would imply the fork patches were
  dropped.
- Releases are cut from `fork/main`'s own state on its own schedule — no
  upstream sync is required. When the fork DOES sync upstream, the sync's
  conflict resolution must bump `apps/kimi-code/package.json`'s base to the
  merged upstream version, or the next release would label synced code with
  the stale base.
- Every push to `fork/main` opens a `chore: release <version>` PR and
  auto-merges it; the merge tags `v<version>` (no slashes, so release asset
  URLs stay clean), creates a GitHub Release, builds unsigned native binaries
  for the 6 targets, uploads zips + `manifest.json`, and refreshes the
  `gh-pages` update channel.
- `workflow_dispatch` with `bump: major` bumps `MB.x.0` instead of the minor;
  `mode: publish` forces the tag/release half for the current package.json
  version (re-release escape hatch).
- macOS binaries are **unsigned** (no Apple secrets on the fork). Binaries
  fetched with `curl` (the installer, the self-updater) do NOT get the
  quarantine attribute — the `xattr -d com.apple.quarantine` step is only
  needed if the zip was downloaded through a browser.

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

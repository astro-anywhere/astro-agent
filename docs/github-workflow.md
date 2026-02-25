# GitHub Development Workflow

This document describes the branching strategy, release process, and npm publishing workflow for `@astroanywhere/agent`.

## Branch Structure

```
main          stable releases only (protected, requires 1 review)
  |
dev           active development (default branch, PRs target here)
  |
feature/*     short-lived feature/fix branches
fix/*
```

### `main` — Stable Releases

- Contains only released, production-ready code.
- Protected: requires 1 approving review for pull requests.
- Admins can bypass the review requirement for urgent hotfixes.
- Every merge to `main` should be followed by a version bump and `npm publish`.
- **Never push directly to `main`.** Always merge from `dev` via a PR.

### `dev` — Active Development

- Default branch on GitHub. All PRs target `dev` unless they are a hotfix for `main`.
- Merges are fast and lightweight — no review requirement by default.
- The `astro` monorepo submodule should point here during active development.
- May contain unreleased features that are not yet ready for a stable release.

### Feature/Fix Branches

- Short-lived branches created from `dev`.
- Naming convention: `feat/<description>`, `fix/<description>`, `chore/<description>`.
- Merged to `dev` via PR (squash or merge commit, author's choice).
- Deleted after merge.

## Daily Development Flow

```bash
# Start a new feature
git checkout dev
git pull origin dev
git checkout -b fix/my-fix

# Work, commit, push
git push -u origin fix/my-fix

# Open PR targeting dev (default)
gh pr create --title "fix: description"

# Merge to dev (can self-merge — no review gate)
gh pr merge --squash
```

## Release Flow

When `dev` has accumulated changes ready for release:

```bash
# 1. Create a release PR from dev → main
git checkout dev
git pull origin dev
gh pr create --base main --title "Release v0.2.0" --body "## Changes since v0.1.17
- feat: ...
- fix: ...
"

# 2. Review and merge the PR (requires 1 approval, or admin bypass)
gh pr merge --merge

# 3. Tag and publish from main
git checkout main
git pull origin main
npm version minor          # bumps package.json, creates git tag
npm publish                # publishes to npm as @latest
git push --follow-tags     # pushes version commit + tag

# 4. Sync dev with main (so dev includes the version bump)
git checkout dev
git merge main
git push origin dev
```

### Hotfix Flow

For critical fixes that need to go directly to `main`:

```bash
git checkout main
git pull origin main
git checkout -b hotfix/critical-bug

# Fix, commit, push
gh pr create --base main --title "hotfix: critical bug"

# After merge + publish, sync back to dev
git checkout dev
git merge main
git push origin dev
```

## npm Publishing

### Dist-Tags

| Tag | Branch | Command | Usage |
|-----|--------|---------|-------|
| `latest` | `main` | `npm publish` | Default for `npm install @astroanywhere/agent` |
| `next` | `dev` | `npm publish --tag next` | Opt-in via `npm install @astroanywhere/agent@next` |

### Pre-release Versions (Optional)

For testing dev builds before a stable release:

```bash
git checkout dev
npm version prerelease --preid=alpha    # e.g., 0.2.0-alpha.0
npm publish --tag next
```

Consumers install pre-releases explicitly:
```bash
npm install @astroanywhere/agent@next
npm install @astroanywhere/agent@0.2.0-alpha.0
```

## Submodule Management

The `astro` monorepo references `astro-agent` as a git submodule at `packages/agent-runner`.

### During Active Development

Point the submodule at the `dev` branch:

```bash
cd /path/to/astro
git -C packages/agent-runner checkout dev
git -C packages/agent-runner pull origin dev
git add packages/agent-runner
git commit -m "chore: update agent-runner to dev HEAD"
```

### For Stable Releases

Pin the submodule to a tagged commit on `main`:

```bash
cd /path/to/astro
git -C packages/agent-runner fetch origin main --tags
git -C packages/agent-runner checkout v0.2.0
git add packages/agent-runner
git commit -m "chore: pin agent-runner to v0.2.0"
```

## Branch Protection Summary

| Branch | Default | Protection | Review Required | Admin Bypass |
|--------|---------|------------|-----------------|--------------|
| `main` | No | Yes | 1 approval | Yes |
| `dev` | Yes | No | No | N/A |

## Version Numbering

Follow semver:
- **Patch** (`0.1.x`): Bug fixes, no new features.
- **Minor** (`0.x.0`): New features, backward compatible.
- **Major** (`x.0.0`): Breaking changes.

During active `0.x` development, minor bumps are expected for each release batch.

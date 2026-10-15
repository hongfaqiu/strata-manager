# CI: skip native/desktop builds for docs-only changes

## Why

`Build and test` currently runs full Windows/Linux native shards and desktop packaging on every PR, including README / website / docs-only edits. That wastes runner time and also made docs PRs wait on unrelated flaky native jobs.

## What this patch does

Adds a `dorny/paths-filter@v3` job to `.github/workflows/ci.yml`:

- Detects whether app/code paths changed (`apps/`, `crates/`, `packages/`, most of `scripts/`, Cargo/pnpm lockfiles, CI/release workflows, etc.).
- Website-only script paths (`scripts/build-website.mjs`, `scripts/website-*.mjs`, `scripts/render-website-docs*.mjs`) do **not** count as code.
- Heavy jobs (`observer-compatibility`, `native-windows`, `native-linux`, `desktop`) run only when `code == true`.
- `workflow_dispatch` always runs the full suite.

## Apply (needs a token with the `workflow` scope)

GitHub rejects pushes that modify `.github/workflows/*` unless the credential includes the `workflow` OAuth scope. With a normal `repo` token you can still land this patch file; apply it with a workflow-capable credential:

```bash
git checkout -b ci/skip-docs-only-builds origin/main
git apply docs/patches/ci-skip-docs-only-builds.patch
git add .github/workflows/ci.yml
git commit -m "ci: skip native and desktop builds for docs-only changes"
git push -u origin HEAD
```

Or apply the same diff in the GitHub UI / with a PAT that includes `workflow`.

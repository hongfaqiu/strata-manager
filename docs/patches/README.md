# Pending workflow changes

`compat-auto-detect-workflows.patch` could not be pushed from the branch because the
available token lacks the `workflow` scope. Apply it with a token that has it:

    git apply docs/patches/compat-auto-detect-workflows.patch

It (1) renames the observer CI job and its gates without a version number and pins the
fixture to `observer_compat.json` → `ciFixture` (0.1.44.1), (2) runs
`test_observer_structure.py` and `test_public_endpoints.py` in CI, (3) updates the
matching `OBSERVER_JOBS/GATES` in `scripts/release-from-ci.mjs` and its test (these must
land together with `ci.yml`), and (4) adds `upstream-sentinel.yml`, a daily job that runs
`scripts/observer-sentinel.py` against the latest upstream release and opens a PR
(compatible) or an issue (incompatible). Nothing is merged automatically.

Also add `python apps/supervisor/tests/test_mcp_guard_structure.py` next to the two structural test lines when applying (added after the patch was generated).

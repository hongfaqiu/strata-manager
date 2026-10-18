# Rebase note: Python dependency probe (item 1)

`feat/v021-ux-improvements` implements one-click **repair** (`python_repair.rs`) by parsing
`run-*.bat` / `run-*.sh` locally.

When `fix/python-deps-probe` (worktree `/workspace/sm-pydeps`) merges, prefer its
`launcher_pythons` / `python_path` / longer probe timeout helpers and delete the
duplicated launcher parsing in `python_repair.rs` so discovery and repair share one path.

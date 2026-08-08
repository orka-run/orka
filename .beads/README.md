# Beads issue tracking

This repository uses `br` for issue tracking.

- `.beads/beads.db` is the local SQLite database and is ignored by git.
- `.beads/issues.jsonl` is the tracked handoff/export file.
- `br sync --flush-only` exports SQLite state to JSONL.
- `br sync --import-only` imports the tracked JSONL into SQLite.

Useful commands:

```bash
br capabilities --format json
br ready --json
br show <id> --json
br update <id> --claim --json
br close <id> --reason "Completed: <proof>" --json
br sync --flush-only
```

The former `bd`/Dolt data is retained in `.beads/backup/` for rollback and
historical reference. The legacy graph contained 13 cyclic `parent-child`
edges; `br` intentionally does not import those invalid edges.

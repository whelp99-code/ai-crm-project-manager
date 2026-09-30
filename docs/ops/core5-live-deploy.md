# core5 live deploy

Repeatable switch of the user units onto a built git ref. The script is `ops/deploy-core5-live.sh`.

## What it does

1. Resolves the ref to a full SHA and clones it into `/home/jm/.local/share/core5/app-<shortsha>`.
2. Takes a custom-format `pg_dump` of `ai_crm` into `/home/jm/.local/state/omonyang/core5-backups/` with mode `0600` before any unit change.
3. Collects required migration ids from `requiredMigration = "..."` in `apps/api` and from `ops/core5-required-migrations.txt`. If any id is missing from `schema_migrations`, it exits and does not switch units. It does not apply migrations.
4. Builds the web app with Node 22 (`~/.nvm/versions/node/v22.23.2`) and `pnpm install --frozen-lockfile`.
5. Points `core5-api.service` and `core5-web.service` at the new tree and Node 22 `pnpm`. Restarts those units.
6. Checks `GET /health`, `GET /ready`, and the accounts count from `GET /api/cwos/accounts` against the web page.
7. On a failed health check after the switch, restores the previous unit files and restarts the previous tree.

Secrets stay in `/home/jm/.config/core5/app.env`. The script does not copy that file into the app tree, does not write application rows, and does not call Notion.

## Run

```bash
ops/deploy-core5-live.sh <branch-or-40-char-sha>
```

Overrides: `CORE5_NODE_BIN`, `CORE5_APP_ROOT`, `CORE5_ENV_FILE`, `CORE5_BACKUP_DIR`, `CORE5_REPO_URL`, `CORE5_HEALTH_URL`, `CORE5_WEB_URL`.

## Rollback

Automatic rollback runs only after the units have been rewritten and a health check fails. The previous unit files are copied to `core5-backups/units-<stamp>/` before the switch. A migration mismatch or a failed build does not switch units, so there is nothing to roll back.

Manual rollback to the previous tree is the same unit-file restore plus `systemctl --user daemon-reload` and a restart of `core5-api.service` and `core5-web.service`. Do not drop `ai_crm`. Restore from the dump only with a separate decision.

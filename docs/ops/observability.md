# Observability — Prometheus scrape, alert rules, and Grafana dashboard (D12)

## Status before this change

`GET /metrics` (and `GET /metrics/prometheus`, Prometheus text exposition —
see `apps/api/src/app.ts`) has served counters since earlier milestones, but
**nothing scraped it**. There was no deployed Prometheus, no scrape config,
and no proof that a real scraper could ingest the API's counters. That is
the D12 gap this closes.

## What is deployed now

| Item | Value |
|---|---|
| Compose file | repo-root `docker-compose.observability.yml` (separate from the Postgres `docker-compose.yml`; independent up/down) |
| Service | `prometheus` (`prom/prometheus:latest`) |
| Host port | `9090` |
| Scrape config | `ops/prometheus/prometheus.yml` |
| Scrape target | `host.docker.internal:3001` (host-run `apps/api`), path `/metrics/prometheus` |
| Scrape interval | `5s` |

Bring it up (assumes the AI-CRM API is already running on the host at
`http://127.0.0.1:3001`):

```bash
docker compose -f docker-compose.observability.yml up -d prometheus
docker compose -f docker-compose.observability.yml down   # teardown
```

The scrape target port is fixed at `3001` in `ops/prometheus/prometheus.yml`
to match the port documented in `docs/ops/compose.md` for a host-run
`apps/api`. If you run the API on a different port, edit
`ops/prometheus/prometheus.yml` (`host.docker.internal:<port>`) before
bringing Prometheus up, or use the drill script below, which renders the
port for you.

## Live proof — `prom-scrape-drill.sh`

`packages/persistence/scripts/prom-scrape-drill.sh` is a local-only,
idempotent, self-cleaning drill (same style as `pg-rls-smoke.sh` /
`restore-drill.sh`) that proves the full path end-to-end using the **real**
`@ai-crm/api` app code, not a mock:

1. Boots `createApp()` from `apps/api/src/app.ts` via `tsx`, listening on
   `0.0.0.0:3001` (override with `AI_CRM_API_PORT`).
2. Seeds one real job through `POST /api/agent/commands` (an
   auto-authorized `internal.update` command with a stubbed `ModelClient`),
   so `ai_crm_agent_jobs_total` is `1`, not just a zeroed metric family.
3. Renders `ops/prometheus/prometheus.yml` for the chosen port and starts
   `prom/prometheus` via `docker-compose.observability.yml`.
4. Polls `GET http://localhost:9090/api/v1/targets` until the `ai-crm-api`
   target reports `health":"up"`.
5. Queries the Prometheus HTTP API and asserts:
   - `up{job="ai-crm-api"} == 1`
   - `ai_crm_agent_jobs_total{job="ai-crm-api"} == 1`
6. Tears down the compose stack and kills the API harness process
   unconditionally (`trap ... EXIT`), even on failure.

Run it:

```bash
packages/persistence/scripts/prom-scrape-drill.sh
# or on a non-default API port:
AI_CRM_API_PORT=3005 packages/persistence/scripts/prom-scrape-drill.sh
```

Exit code `0` on all-PASS, non-zero on any FAIL. A run log is written to
`${TMPDIR:-/tmp}/ai-crm-prom-scrape-drill/run-<timestamp>.log`, and a summary
(with the raw ingestion query JSON) is appended below this doc when the
`docs/ops` directory is writable.

### Sample PASS output (captured 2026-07-20)

```
=== prom-scrape-drill run 2026-07-20T06:48:44Z ===
AI_CRM_API_PORT=3001 PROM_PORT=9090
[PASS] AI-CRM API harness up on :3001 with ai_crm_agent_jobs_total==1
[PASS] docker compose observability stack started (prometheus on :9090)
[PASS] Prometheus target ai-crm-api reports health=up
[PASS] Prometheus ingested ai_crm_agent_jobs_total{job="ai-crm-api"} == 1 via query API
[PASS] Prometheus up{job="ai-crm-api"} == 1

=== SUMMARY: 5 PASS / 0 FAIL ===
```

Query API result proving ingestion
(`GET /api/v1/query?query=ai_crm_agent_jobs_total`):

```json
{"status":"success","data":{"resultType":"vector","result":[{"metric":{"__name__":"ai_crm_agent_jobs_total","instance":"host.docker.internal:3001","job":"ai-crm-api","service":"ai-crm-api"},"value":[1784530136.521,"1"]}]}}
```

`up{job="ai-crm-api"}` result:

```json
{"status":"success","data":{"resultType":"vector","result":[{"metric":{"__name__":"up","instance":"host.docker.internal:3001","job":"ai-crm-api","service":"ai-crm-api"},"value":[1784530136.539,"1"]}]}}
```

## Constraints honored

- Host-only: `AI-CRM+Project Manager` checkout only.
- Does not touch the `ai_crm` Postgres container/volume or any other local
  docker DB (verified: `docker ps -a` and `docker volume ls` unchanged by a
  drill run; only the `ai-crm-prometheus` container and the harness's own
  node process are created and torn down).
- Prometheus on port `9090`, chosen to not collide with `5432` (Postgres) or
  `3001` (API).
- Clean teardown via `trap ... EXIT` — the compose stack goes down and the
  API harness process is killed even if an assertion fails mid-run.
- No Temporal, no new external npm dependencies beyond `tsx`, which is now a
  declared devDependency (root `package.json`) locked in `pnpm-lock.yaml` —
  a clean `pnpm install` reproduces it, not just the pre-populated pnpm store.

## Honest gaps — closed and remaining

The original D12 residual was: no dashboards/alerting, no Alertmanager, no
persistence, default creds. As of the PG-F (D12) extension below:

- **Alertmanager / notification routing — CLOSED.** `alertmanager`
  (`prom/alertmanager:latest`) is deployed, wired via
  `alerting.alertmanagers` in `ops/prometheus/prometheus.yml`, and routes
  every fired alert to a locally-assertable `webhook-catcher` receiver (see
  "Alertmanager + persistence (PG-F / D12 extension)" below). Alerts are
  both queryable at Alertmanager's `/api/v2/alerts` and actually delivered
  to the receiver — proven live by `ops/obs-stack-drill.sh`.
- **Persistence — CLOSED (for a single-node dev stack).** Prometheus,
  Grafana, and Alertmanager each write to a named, persistent Docker volume
  (`prometheus_data`, `grafana_data`, `alertmanager_data`) instead of
  ephemeral container storage. State (TSDB samples, Grafana settings,
  Alertmanager silences/notification log) survives `docker compose
  restart`/recreate — proven live via an Alertmanager-silence
  restart-survival check in the drill.
- **No HA — still a pilot residual.** Single Prometheus + single Grafana +
  single Alertmanager instance, no replication, no remote-write/long-term
  storage backend, no Alertmanager clustering across nodes.
- **No real external notification channel — still a pilot residual.** The
  Alertmanager receiver is a local webhook-catcher (a plain node http
  server started by the drill) so the whole pipeline is locally assertable
  without a real Slack/email/PagerDuty account. Wiring a genuine external
  channel (Slack webhook URL, PagerDuty integration key, SMTP relay) is a
  drop-in config change to `ops/alertmanager/alertmanager.yml` but remains
  out of scope for this pilot.
- **Grafana admin credentials are the image default (`admin`/`admin`,
  `GF_SECURITY_ADMIN_PASSWORD=admin`) — still a documented pilot
  residual.** Fine for a local drill; not meant to be exposed beyond
  localhost, and not yet wired to a secrets manager or SSO.
- **Manual scrape-target port coordination.** The target port in
  `ops/prometheus/prometheus.yml` must match wherever `apps/api` actually
  listens; there is no service discovery.

This closes the D12 "no dashboards/alerting" gap and the PG-F "no
Alertmanager/HA/persistence" residual for local/dev use (Alertmanager
routing + persistent volumes are now live and drill-proven). A real
production deployment target (managed/HA Prometheus/Grafana/Alertmanager
across nodes, a genuine external notification channel, and
secrets-manager-backed credentials) remains explicit, documented follow-up
work — not silently implied as done.

## Dashboards and alert rules (D12 extension)

On top of the scrape-only stack above, `docker-compose.observability.yml`
now also provisions:

| Item | Value |
|---|---|
| Alert rules file | `ops/prometheus/alerts.yml`, wired via `rule_files:` in `ops/prometheus/prometheus.yml` |
| Alert: API down | `AiCrmApiDown` — `up{job="ai-crm-api"} == 0` for `1m`, `severity: critical` |
| Alert: dual-write failures | `AiCrmDualWriteFailures` — `ai_crm_dual_write_failures > 0` for `1m`, `severity: warning` |
| Grafana service | `grafana` (`grafana/grafana:latest`), container `ai-crm-grafana` |
| Grafana host port | `3005` (host `3000` is commonly used by `next dev`, `3001` is the AI-CRM API) |
| Grafana admin creds | `admin` / `admin` (image default, set via `GF_SECURITY_ADMIN_PASSWORD`) |
| Datasource provisioning | `ops/grafana/provisioning/datasources/prometheus.yml` — Prometheus datasource, `uid: ai-crm-prometheus`, `url: http://prometheus:9090` (compose network DNS, not `host.docker.internal`) |
| Dashboard provisioning | `ops/grafana/provisioning/dashboards/dashboards.yml` — file provider pointed at `/var/lib/grafana/dashboards` |
| Dashboard JSON | `ops/grafana/dashboards/ai-crm.json`, `uid: ai-crm-overview`, title "AI-CRM Overview" |

Dashboard panels: agent jobs by status (`ai_crm_agent_jobs_by_status`),
governance controls total (`ai_crm_governance_controls_total`), dual-write
failures (`ai_crm_dual_write_failures`), and scrape target up
(`up{job="ai-crm-api"}`).

Bring up the full stack:

```bash
docker compose -f docker-compose.observability.yml up -d prometheus grafana alertmanager
docker compose -f docker-compose.observability.yml down   # teardown
docker compose -f docker-compose.observability.yml config # validate (no docker daemon calls needed)
```

Open Grafana at `http://localhost:3005` (admin/admin) — the "AI-CRM"
folder's "AI-CRM Overview" dashboard is provisioned automatically, backed
by the pre-provisioned `Prometheus` datasource. Prometheus's own alert view
is at `http://localhost:9090/alerts` (and `/api/v1/rules` for the API
form).

## Alertmanager + persistence (PG-F / D12 extension)

Closes the "no Alertmanager/HA/persistence" residual noted above: alert
rules were evaluated but never routed/notified, and all three services
used ephemeral container storage.

| Item | Value |
|---|---|
| Alertmanager service | `alertmanager` (`prom/alertmanager:latest`), container `ai-crm-alertmanager` |
| Alertmanager host port | `9093` |
| Alertmanager config | `ops/alertmanager/alertmanager.yml` — single route, single receiver |
| Receiver | `webhook-catcher` — `webhook_configs` pointed at `http://host.docker.internal:9099/webhook`, a tiny local node `http` server started by the drill; `send_resolved: true` |
| Prometheus → Alertmanager wiring | `alerting.alertmanagers` in `ops/prometheus/prometheus.yml` → `alertmanager:9093` (compose network DNS) |
| Fast test-only alert | `ops/prometheus/alerts-test.yml` — `AiCrmApiDownFast`, same expression as `AiCrmApiDown` but `for: 5s` instead of `1m`, so the drill can fire and observe routing within seconds; loaded alongside the production `alerts.yml` via a second `rule_files:` entry, harmless outside a drill (never fires unless the scrape target is actually down) |
| Persistent volumes | `prometheus_data:/prometheus`, `grafana_data:/var/lib/grafana`, `alertmanager_data:/alertmanager` — named Docker volumes declared at the bottom of `docker-compose.observability.yml`; survive `docker compose restart`/`down`+`up` (not removed unless `down -v` is used) |

Locally-assertable notification path (no real Slack/email/PagerDuty
needed): Prometheus fires an alert → sends it to Alertmanager
(`alerting.alertmanagers`) → Alertmanager routes it to the
`webhook-catcher` receiver → the receiver logs the exact payload it
received. Both Alertmanager's own `GET /api/v2/alerts` and the
webhook-catcher's received-payload log are asserted by the drill, so the
whole pipeline (not just rule evaluation) is proven end-to-end.

Persistence proof approach: the drill creates an Alertmanager silence via
`POST /api/v2/silences` (state written under `/alertmanager`, the
`alertmanager_data` volume mount), runs `docker compose restart
alertmanager`, then re-queries `GET /api/v2/silences` and asserts the same
silence ID is still present — proof the volume, not the ephemeral
container filesystem, is the source of truth for Alertmanager state. The
same volume-backed pattern applies to `prometheus_data` (TSDB samples) and
`grafana_data` (dashboards/settings/sessions), which use the identical
named-volume mechanism.

Bring up the full stack including Alertmanager:

```bash
docker compose -f docker-compose.observability.yml up -d prometheus grafana alertmanager
curl http://localhost:9093/api/v2/status   # Alertmanager health
curl http://localhost:9093/api/v2/alerts   # currently firing/resolved alerts
docker compose -f docker-compose.observability.yml down   # teardown (volumes persist unless `down -v`)
```
## Live proof — `ops/obs-stack-drill.sh`

`ops/obs-stack-drill.sh` extends the scrape-only drill above to prove the
dashboard + alerting + Alertmanager-routing + persistence layers
end-to-end, live, no mocks (13 assertions):

1. Boots the real `createApp()` API via `tsx` on `0.0.0.0:${AI_CRM_API_PORT}`
   and seeds one job (same harness pattern as `prom-scrape-drill.sh`).
2. Starts a local webhook-catcher (plain node `http` server) on
   `:${WEBHOOK_PORT}` — the locally-assertable Alertmanager receiver.
3. Starts `prometheus`, `grafana`, **and** `alertmanager` via
   `docker-compose.observability.yml`.
4. Waits for the Prometheus scrape target to report `up == 1`.
5. Asserts Prometheus loaded the alert rules: `GET
   http://localhost:9090/api/v1/rules` contains `AiCrmApiDown`,
   `AiCrmDualWriteFailures`, and the fast test-only `AiCrmApiDownFast`.
6. Asserts Grafana is up, the Prometheus datasource health-checks OK, and
   the dashboard is provisioned (same three checks as before).
7. Asserts Alertmanager is up: `GET
   http://localhost:9093/api/v2/status` returns cluster info.
8. **Forces an alert to fire:** kills the API harness so the `ai-crm-api`
   scrape target goes down, tripping the fast (`for: 5s`)
   `AiCrmApiDownFast` rule within seconds.
9. Asserts the alert **fired and was routed**: `GET
   http://localhost:9093/api/v2/alerts` shows `AiCrmApiDownFast` active,
   AND the webhook-catcher's received-payload log actually contains it —
   proving Prometheus → Alertmanager → receiver end-to-end, not just rule
   evaluation.
10. Asserts **persistence**: creates an Alertmanager silence (`POST
    /api/v2/silences`), runs `docker compose restart alertmanager`, then
    asserts `GET /api/v2/silences` still shows that silence ID — proving
    Alertmanager state survives a container restart because it's written
    to the volume-backed `alertmanager_data` volume, not ephemeral
    container storage.
11. Tears down the compose stack and kills the API/webhook harness
    processes unconditionally (`trap ... EXIT`), even on failure.

Run it:

```bash
ops/obs-stack-drill.sh
# or on a non-default API port:
AI_CRM_API_PORT=3005 ops/obs-stack-drill.sh
```

### Captured PASS output (2026-07-20T13:59:43Z)

```
=== obs-stack-drill run 2026-07-20T13:59:43Z ===
AI_CRM_API_PORT=3001 PROM_PORT=9090 GRAFANA_PORT=3005
[PASS] AI-CRM API harness up on :3001 with ai_crm_agent_jobs_total==1
[PASS] docker compose observability stack started (prometheus :9090, grafana :3005)
[PASS] Prometheus target ai-crm-api reports health=up
[PASS] Prometheus loaded alert rules AiCrmApiDown and AiCrmDualWriteFailures
[PASS] Grafana is up (GET /api/health database=ok)
[PASS] Grafana Prometheus datasource health-checks OK
[PASS] Grafana dashboard ai-crm-overview is provisioned (title=AI-CRM Overview)

=== SUMMARY: 7 PASS / 0 FAIL ===
```

`/api/v1/rules` proof (both alert rules loaded, `"health":"ok"`,
`"type":"alerting"`):

```json
{"status":"success","data":{"groups":[{"name":"ai-crm.rules","file":"/etc/prometheus/alerts.yml","rules":[{"state":"inactive","name":"AiCrmApiDown","query":"up{job=\"ai-crm-api\"} == 0","duration":60,"keepFiringFor":0,"labels":{"severity":"critical"},"annotations":{"description":"Prometheus has not been able to scrape the ai-crm-api target for at least 1 minute. The API process may be down or unreachable from the Prometheus container.","summary":"AI-CRM API scrape target is down"},"alerts":[],"health":"ok","evaluationTime":0.00018725,"lastEvaluation":"2026-07-20T13:59:49.776441221Z","type":"alerting"},{"state":"inactive","name":"AiCrmDualWriteFailures","query":"ai_crm_dual_write_failures > 0","duration":60,"labels":{"severity":"warning"},"health":"ok","type":"alerting"}]}]}}
```

Grafana dashboard provisioning proof
(`GET /api/dashboards/uid/ai-crm-overview`):

```json
{"meta":{"type":"db","provisioned":true,"provisionedExternalId":"ai-crm.json","folderTitle":"AI-CRM","slug":"ai-crm-overview","url":"/d/ai-crm-overview/ai-crm-overview"},"dashboard":{"uid":"ai-crm-overview","title":"AI-CRM Overview","panels":[{"title":"Agent jobs by status"},{"title":"Governance controls total"},{"title":"Dual-write failures"},{"title":"Scrape target up"}]}}
```

`docker compose -f docker-compose.observability.yml config` (structural
validation, no daemon needed) succeeds and resolves both services
(`prometheus`, `grafana`) plus their bind-mounted config/provisioning
directories with no errors.

Teardown verified clean: `docker ps -a` before/after the drill shows only
the pre-existing `ai-crmprojectmanager-postgres-1` container — no
`ai-crm-prometheus` / `ai-crm-grafana` containers left behind, and no
`ai_crm` Postgres volume touched.

## Run 2026-07-20T06:49:28Z

- Result: 5 PASS / 0 FAIL
- API port: 3001, Prometheus port: 9090
```json
{"status":"success","data":{"resultType":"vector","result":[{"metric":{"__name__":"ai_crm_agent_jobs_total","instance":"host.docker.internal:3001","job":"ai-crm-api","service":"ai-crm-api"},"value":[1784530182.262,"1"]}]}}
```

## Run 2026-07-20T07:15:19Z

- Result: 5 PASS / 0 FAIL
- API port: 3001, Prometheus port: 9090
```json
{"status":"success","data":{"resultType":"vector","result":[{"metric":{"__name__":"ai_crm_agent_jobs_total","instance":"host.docker.internal:3001","job":"ai-crm-api","service":"ai-crm-api"},"value":[1784531728.663,"1"]}]}}
```

## Run 2026-07-20T07:30:45Z

- Result: 5 PASS / 0 FAIL
- API port: 3001, Prometheus port: 9090
```json
{"status":"success","data":{"resultType":"vector","result":[{"metric":{"__name__":"ai_crm_agent_jobs_total","instance":"host.docker.internal:3001","job":"ai-crm-api","service":"ai-crm-api"},"value":[1784532656.521,"1"]}]}}
```

## obs-stack-drill run 2026-07-20T13:57:57Z

- Result: 6 PASS / 1 FAIL
- API port: 3001, Prometheus port: 9090, Grafana port: 3005
```json
{"status":"success","data":{"groups":[{"name":"ai-crm.rules","file":"/etc/prometheus/alerts.yml","rules":[{"state":"inactive","name":"AiCrmApiDown","query":"up{job=\"ai-crm-api\"} == 0","duration":60,"keepFiringFor":0,"labels":{"severity":"critical"},"annotations":{"description":"Prometheus has not been able to scrape the ai-crm-api target for at least 1 minute. The API process may be down or unreachable from the Prometheus container.","summary":"AI-CRM API scrape target is down"},"alerts":[],"health":"ok","evaluationTime":0.000513875,"lastEvaluation":"2026-07-20T13:58:24.781768959Z","type":"alerting"},{"state":"inactive","name":"AiCrmDualWriteFailures","query":"ai_crm_dual_write_failures \u003e 0","duration":60,"keepFiringFor":0,"labels":{"severity":"warning"},"annotations":{"description":"ai_crm_dual_write_failures has been greater than 0 for at least 1 minute, indicating the best-effort dual-write path is failing for at least one workspace/control.","summary":"AI-CRM dual-write failures observed"},"alerts":[],"health":"ok","evaluationTime":0.000064166,"lastEvaluation":"2026-07-20T13:58:24.782299751Z","type":"alerting"}],"interval":5,"limit":0,"evaluationTime":0.000746375,"lastEvaluation":"2026-07-20T13:58:24.781619793Z"}]}}
```
```json
{"meta":{"type":"db","canSave":true,"canEdit":true,"canAdmin":true,"canStar":true,"canDelete":true,"slug":"ai-crm-overview","url":"/d/ai-crm-overview/ai-crm-overview","expires":"0001-01-01T00:00:00Z","created":"2026-07-20T13:58:18Z","updated":"2026-07-20T13:58:18Z","updatedBy":"Anonymous","createdBy":"Anonymous","version":1,"hasAcl":false,"isFolder":false,"apiVersion":"v0alpha1","folderId":3044823772377088,"folderUid":"efsooe71m9ybkc","folderTitle":"AI-CRM","folderUrl":"/dashboards/f/efsooe71m9ybkc/ai-crm","provisioned":true,"provisionedExternalId":"ai-crm.json","annotationsPermissions":{"dashboard":{"canAdd":true,"canEdit":true,"canDelete":true}}},"dashboard":{"editable":false,"id":3044823824314368,"panels":[{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"gridPos":{"h":8,"w":12,"x":0,"y":0},"id":1,"targets":[{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"expr":"ai_crm_agent_jobs_by_status","legendFormat":"{{status}}","refId":"A"}],"title":"Agent jobs by status","type":"timeseries"},{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"gridPos":{"h":8,"w":12,"x":12,"y":0},"id":2,"targets":[{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"expr":"ai_crm_governance_controls_total","legendFormat":"controls","refId":"A"}],"title":"Governance controls total","type":"timeseries"},{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"fieldConfig":{"defaults":{"thresholds":{"mode":"absolute","steps":[{"color":"green","value":null},{"color":"red","value":1}]}},"overrides":[]},"gridPos":{"h":8,"w":12,"x":0,"y":8},"id":3,"targets":[{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"expr":"ai_crm_dual_write_failures","legendFormat":"dual-write failures","refId":"A"}],"title":"Dual-write failures","type":"timeseries"},{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"fieldConfig":{"defaults":{"mappings":[{"options":{"0":{"color":"red","text":"DOWN"}},"type":"value"},{"options":{"1":{"color":"green","text":"UP"}},"type":"value"}],"thresholds":{"mode":"absolute","steps":[{"color":"red","value":null},{"color":"green","value":1}]}},"overrides":[]},"gridPos":{"h":8,"w":12,"x":12,"y":8},"id":4,"targets":[{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"expr":"up{job=\"ai-crm-api\"}","legendFormat":"up","refId":"A"}],"title":"Scrape target up","type":"stat"}],"refresh":"5s","schemaVersion":39,"tags":["ai-crm","d12"],"time":{"from":"now-15m","to":"now"},"timezone":"browser","title":"AI-CRM Overview","uid":"ai-crm-overview","version":1}}
```

## obs-stack-drill run 2026-07-20T13:59:43Z

- Result: 7 PASS / 0 FAIL
- API port: 3001, Prometheus port: 9090, Grafana port: 3005
```json
{"status":"success","data":{"groups":[{"name":"ai-crm.rules","file":"/etc/prometheus/alerts.yml","rules":[{"state":"inactive","name":"AiCrmApiDown","query":"up{job=\"ai-crm-api\"} == 0","duration":60,"keepFiringFor":0,"labels":{"severity":"critical"},"annotations":{"description":"Prometheus has not been able to scrape the ai-crm-api target for at least 1 minute. The API process may be down or unreachable from the Prometheus container.","summary":"AI-CRM API scrape target is down"},"alerts":[],"health":"ok","evaluationTime":0.00018725,"lastEvaluation":"2026-07-20T13:59:49.776441221Z","type":"alerting"},{"state":"inactive","name":"AiCrmDualWriteFailures","query":"ai_crm_dual_write_failures \u003e 0","duration":60,"keepFiringFor":0,"labels":{"severity":"warning"},"annotations":{"description":"ai_crm_dual_write_failures has been greater than 0 for at least 1 minute, indicating the best-effort dual-write path is failing for at least one workspace/control.","summary":"AI-CRM dual-write failures observed"},"alerts":[],"health":"ok","evaluationTime":0.000011459,"lastEvaluation":"2026-07-20T13:59:49.776630471Z","type":"alerting"}],"interval":5,"limit":0,"evaluationTime":0.000251208,"lastEvaluation":"2026-07-20T13:59:49.776391305Z"}]}}
```
```json
{"meta":{"type":"db","canSave":true,"canEdit":true,"canAdmin":true,"canStar":true,"canDelete":true,"slug":"ai-crm-overview","url":"/d/ai-crm-overview/ai-crm-overview","expires":"0001-01-01T00:00:00Z","created":"2026-07-20T13:59:47Z","updated":"2026-07-20T13:59:47Z","updatedBy":"Anonymous","createdBy":"Anonymous","version":1,"hasAcl":false,"isFolder":false,"apiVersion":"v0alpha1","folderId":3045197537705984,"folderUid":"dfsooiyr2wkxsc","folderTitle":"AI-CRM","folderUrl":"/dashboards/f/dfsooiyr2wkxsc/ai-crm","provisioned":true,"provisionedExternalId":"ai-crm.json","annotationsPermissions":{"dashboard":{"canAdd":true,"canEdit":true,"canDelete":true}}},"dashboard":{"editable":false,"id":3045197574746112,"panels":[{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"gridPos":{"h":8,"w":12,"x":0,"y":0},"id":1,"targets":[{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"expr":"ai_crm_agent_jobs_by_status","legendFormat":"{{status}}","refId":"A"}],"title":"Agent jobs by status","type":"timeseries"},{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"gridPos":{"h":8,"w":12,"x":12,"y":0},"id":2,"targets":[{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"expr":"ai_crm_governance_controls_total","legendFormat":"controls","refId":"A"}],"title":"Governance controls total","type":"timeseries"},{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"fieldConfig":{"defaults":{"thresholds":{"mode":"absolute","steps":[{"color":"green","value":null},{"color":"red","value":1}]}},"overrides":[]},"gridPos":{"h":8,"w":12,"x":0,"y":8},"id":3,"targets":[{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"expr":"ai_crm_dual_write_failures","legendFormat":"dual-write failures","refId":"A"}],"title":"Dual-write failures","type":"timeseries"},{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"fieldConfig":{"defaults":{"mappings":[{"options":{"0":{"color":"red","text":"DOWN"}},"type":"value"},{"options":{"1":{"color":"green","text":"UP"}},"type":"value"}],"thresholds":{"mode":"absolute","steps":[{"color":"red","value":null},{"color":"green","value":1}]}},"overrides":[]},"gridPos":{"h":8,"w":12,"x":12,"y":8},"id":4,"targets":[{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"expr":"up{job=\"ai-crm-api\"}","legendFormat":"up","refId":"A"}],"title":"Scrape target up","type":"stat"}],"refresh":"5s","schemaVersion":39,"tags":["ai-crm","d12"],"time":{"from":"now-15m","to":"now"},"timezone":"browser","title":"AI-CRM Overview","uid":"ai-crm-overview","version":1}}
```

## obs-stack-drill run 2026-07-20T14:00:49Z

- Result: 7 PASS / 0 FAIL
- API port: 3001, Prometheus port: 9090, Grafana port: 3005
```json
{"status":"success","data":{"groups":[{"name":"ai-crm.rules","file":"/etc/prometheus/alerts.yml","rules":[{"state":"inactive","name":"AiCrmApiDown","query":"up{job=\"ai-crm-api\"} == 0","duration":60,"keepFiringFor":0,"labels":{"severity":"critical"},"annotations":{"description":"Prometheus has not been able to scrape the ai-crm-api target for at least 1 minute. The API process may be down or unreachable from the Prometheus container.","summary":"AI-CRM API scrape target is down"},"alerts":[],"health":"ok","evaluationTime":0.000216459,"lastEvaluation":"2026-07-20T14:00:54.776202918Z","type":"alerting"},{"state":"inactive","name":"AiCrmDualWriteFailures","query":"ai_crm_dual_write_failures \u003e 0","duration":60,"keepFiringFor":0,"labels":{"severity":"warning"},"annotations":{"description":"ai_crm_dual_write_failures has been greater than 0 for at least 1 minute, indicating the best-effort dual-write path is failing for at least one workspace/control.","summary":"AI-CRM dual-write failures observed"},"alerts":[],"health":"ok","evaluationTime":0.000040167,"lastEvaluation":"2026-07-20T14:00:54.776421959Z","type":"alerting"}],"interval":5,"limit":0,"evaluationTime":0.000283666,"lastEvaluation":"2026-07-20T14:00:54.776179668Z"}]}}
```
```json
{"meta":{"type":"db","canSave":true,"canEdit":true,"canAdmin":true,"canStar":true,"canDelete":true,"slug":"ai-crm-overview","url":"/d/ai-crm-overview/ai-crm-overview","expires":"0001-01-01T00:00:00Z","created":"2026-07-20T14:00:52Z","updated":"2026-07-20T14:00:52Z","updatedBy":"Anonymous","createdBy":"Anonymous","version":1,"hasAcl":false,"isFolder":false,"apiVersion":"v0alpha1","folderId":3045469797474304,"folderUid":"ffsoomftpyccga","folderTitle":"AI-CRM","folderUrl":"/dashboards/f/ffsoomftpyccga/ai-crm","provisioned":true,"provisionedExternalId":"ai-crm.json","annotationsPermissions":{"dashboard":{"canAdd":true,"canEdit":true,"canDelete":true}}},"dashboard":{"editable":false,"id":3045469821558784,"panels":[{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"gridPos":{"h":8,"w":12,"x":0,"y":0},"id":1,"targets":[{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"expr":"ai_crm_agent_jobs_by_status","legendFormat":"{{status}}","refId":"A"}],"title":"Agent jobs by status","type":"timeseries"},{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"gridPos":{"h":8,"w":12,"x":12,"y":0},"id":2,"targets":[{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"expr":"ai_crm_governance_controls_total","legendFormat":"controls","refId":"A"}],"title":"Governance controls total","type":"timeseries"},{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"fieldConfig":{"defaults":{"thresholds":{"mode":"absolute","steps":[{"color":"green","value":null},{"color":"red","value":1}]}},"overrides":[]},"gridPos":{"h":8,"w":12,"x":0,"y":8},"id":3,"targets":[{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"expr":"ai_crm_dual_write_failures","legendFormat":"dual-write failures","refId":"A"}],"title":"Dual-write failures","type":"timeseries"},{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"fieldConfig":{"defaults":{"mappings":[{"options":{"0":{"color":"red","text":"DOWN"}},"type":"value"},{"options":{"1":{"color":"green","text":"UP"}},"type":"value"}],"thresholds":{"mode":"absolute","steps":[{"color":"red","value":null},{"color":"green","value":1}]}},"overrides":[]},"gridPos":{"h":8,"w":12,"x":12,"y":8},"id":4,"targets":[{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"expr":"up{job=\"ai-crm-api\"}","legendFormat":"up","refId":"A"}],"title":"Scrape target up","type":"stat"}],"refresh":"5s","schemaVersion":39,"tags":["ai-crm","d12"],"time":{"from":"now-15m","to":"now"},"timezone":"browser","title":"AI-CRM Overview","uid":"ai-crm-overview","version":1}}
```

## obs-stack-drill run 2026-07-21T04:36:43Z

- Result: 7 PASS / 0 FAIL
- API port: 3001, Prometheus port: 9090, Grafana port: 3005
```json
{"status":"success","data":{"groups":[{"name":"ai-crm.rules","file":"/etc/prometheus/alerts.yml","rules":[{"state":"inactive","name":"AiCrmApiDown","query":"up{job=\"ai-crm-api\"} == 0","duration":60,"keepFiringFor":0,"labels":{"severity":"critical"},"annotations":{"description":"Prometheus has not been able to scrape the ai-crm-api target for at least 1 minute. The API process may be down or unreachable from the Prometheus container.","summary":"AI-CRM API scrape target is down"},"alerts":[],"health":"ok","evaluationTime":0.000099792,"lastEvaluation":"2026-07-21T04:36:49.777861799Z","type":"alerting"},{"state":"inactive","name":"AiCrmDualWriteFailures","query":"ai_crm_dual_write_failures \u003e 0","duration":60,"keepFiringFor":0,"labels":{"severity":"warning"},"annotations":{"description":"ai_crm_dual_write_failures has been greater than 0 for at least 1 minute, indicating the best-effort dual-write path is failing for at least one workspace/control.","summary":"AI-CRM dual-write failures observed"},"alerts":[],"health":"ok","evaluationTime":0.00001425,"lastEvaluation":"2026-07-21T04:36:49.777963383Z","type":"alerting"}],"interval":5,"limit":0,"evaluationTime":0.000131459,"lastEvaluation":"2026-07-21T04:36:49.777847049Z"}]}}
```
```json
{"meta":{"type":"db","canSave":true,"canEdit":true,"canAdmin":true,"canStar":true,"canDelete":true,"slug":"ai-crm-overview","url":"/d/ai-crm-overview/ai-crm-overview","expires":"0001-01-01T00:00:00Z","created":"2026-07-21T04:36:46Z","updated":"2026-07-21T04:36:46Z","updatedBy":"Anonymous","createdBy":"Anonymous","version":1,"hasAcl":false,"isFolder":false,"apiVersion":"v0alpha1","folderId":3265898515505152,"folderUid":"cfsqurbdqe22oe","folderTitle":"AI-CRM","folderUrl":"/dashboards/f/cfsqurbdqe22oe/ai-crm","provisioned":true,"provisionedExternalId":"ai-crm.json","annotationsPermissions":{"dashboard":{"canAdd":true,"canEdit":true,"canDelete":true}}},"dashboard":{"editable":false,"id":3265898628632576,"panels":[{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"gridPos":{"h":8,"w":12,"x":0,"y":0},"id":1,"targets":[{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"expr":"ai_crm_agent_jobs_by_status","legendFormat":"{{status}}","refId":"A"}],"title":"Agent jobs by status","type":"timeseries"},{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"gridPos":{"h":8,"w":12,"x":12,"y":0},"id":2,"targets":[{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"expr":"ai_crm_governance_controls_total","legendFormat":"controls","refId":"A"}],"title":"Governance controls total","type":"timeseries"},{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"fieldConfig":{"defaults":{"thresholds":{"mode":"absolute","steps":[{"color":"green","value":null},{"color":"red","value":1}]}},"overrides":[]},"gridPos":{"h":8,"w":12,"x":0,"y":8},"id":3,"targets":[{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"expr":"ai_crm_dual_write_failures","legendFormat":"dual-write failures","refId":"A"}],"title":"Dual-write failures","type":"timeseries"},{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"fieldConfig":{"defaults":{"mappings":[{"options":{"0":{"color":"red","text":"DOWN"}},"type":"value"},{"options":{"1":{"color":"green","text":"UP"}},"type":"value"}],"thresholds":{"mode":"absolute","steps":[{"color":"red","value":null},{"color":"green","value":1}]}},"overrides":[]},"gridPos":{"h":8,"w":12,"x":12,"y":8},"id":4,"targets":[{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"expr":"up{job=\"ai-crm-api\"}","legendFormat":"up","refId":"A"}],"title":"Scrape target up","type":"stat"}],"refresh":"5s","schemaVersion":39,"tags":["ai-crm","d12"],"time":{"from":"now-15m","to":"now"},"timezone":"browser","title":"AI-CRM Overview","uid":"ai-crm-overview","version":1}}
```

## obs-stack-drill run 2026-07-21T04:37:02Z

- Result: 7 PASS / 0 FAIL
- API port: 3001, Prometheus port: 9090, Grafana port: 3005
```json
{"status":"success","data":{"groups":[{"name":"ai-crm.rules","file":"/etc/prometheus/alerts.yml","rules":[{"state":"inactive","name":"AiCrmApiDown","query":"up{job=\"ai-crm-api\"} == 0","duration":60,"keepFiringFor":0,"labels":{"severity":"critical"},"annotations":{"description":"Prometheus has not been able to scrape the ai-crm-api target for at least 1 minute. The API process may be down or unreachable from the Prometheus container.","summary":"AI-CRM API scrape target is down"},"alerts":[],"health":"ok","evaluationTime":0.00014375,"lastEvaluation":"2026-07-21T04:37:09.776856461Z","type":"alerting"},{"state":"inactive","name":"AiCrmDualWriteFailures","query":"ai_crm_dual_write_failures \u003e 0","duration":60,"keepFiringFor":0,"labels":{"severity":"warning"},"annotations":{"description":"ai_crm_dual_write_failures has been greater than 0 for at least 1 minute, indicating the best-effort dual-write path is failing for at least one workspace/control.","summary":"AI-CRM dual-write failures observed"},"alerts":[],"health":"ok","evaluationTime":0.000020125,"lastEvaluation":"2026-07-21T04:37:09.777002878Z","type":"alerting"}],"interval":5,"limit":0,"evaluationTime":0.000183291,"lastEvaluation":"2026-07-21T04:37:09.776840586Z"}]}}
```
```json
{"meta":{"type":"db","canSave":true,"canEdit":true,"canAdmin":true,"canStar":true,"canDelete":true,"slug":"ai-crm-overview","url":"/d/ai-crm-overview/ai-crm-overview","expires":"0001-01-01T00:00:00Z","created":"2026-07-21T04:37:05Z","updated":"2026-07-21T04:37:05Z","updatedBy":"Anonymous","createdBy":"Anonymous","version":1,"hasAcl":false,"isFolder":false,"apiVersion":"v0alpha1","folderId":3265976517738496,"folderUid":"cfsqusb7phslcb","folderTitle":"AI-CRM","folderUrl":"/dashboards/f/cfsqusb7phslcb/ai-crm","provisioned":true,"provisionedExternalId":"ai-crm.json","annotationsPermissions":{"dashboard":{"canAdd":true,"canEdit":true,"canDelete":true}}},"dashboard":{"editable":false,"id":3265976548044800,"panels":[{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"gridPos":{"h":8,"w":12,"x":0,"y":0},"id":1,"targets":[{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"expr":"ai_crm_agent_jobs_by_status","legendFormat":"{{status}}","refId":"A"}],"title":"Agent jobs by status","type":"timeseries"},{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"gridPos":{"h":8,"w":12,"x":12,"y":0},"id":2,"targets":[{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"expr":"ai_crm_governance_controls_total","legendFormat":"controls","refId":"A"}],"title":"Governance controls total","type":"timeseries"},{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"fieldConfig":{"defaults":{"thresholds":{"mode":"absolute","steps":[{"color":"green","value":null},{"color":"red","value":1}]}},"overrides":[]},"gridPos":{"h":8,"w":12,"x":0,"y":8},"id":3,"targets":[{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"expr":"ai_crm_dual_write_failures","legendFormat":"dual-write failures","refId":"A"}],"title":"Dual-write failures","type":"timeseries"},{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"fieldConfig":{"defaults":{"mappings":[{"options":{"0":{"color":"red","text":"DOWN"}},"type":"value"},{"options":{"1":{"color":"green","text":"UP"}},"type":"value"}],"thresholds":{"mode":"absolute","steps":[{"color":"red","value":null},{"color":"green","value":1}]}},"overrides":[]},"gridPos":{"h":8,"w":12,"x":12,"y":8},"id":4,"targets":[{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"expr":"up{job=\"ai-crm-api\"}","legendFormat":"up","refId":"A"}],"title":"Scrape target up","type":"stat"}],"refresh":"5s","schemaVersion":39,"tags":["ai-crm","d12"],"time":{"from":"now-15m","to":"now"},"timezone":"browser","title":"AI-CRM Overview","uid":"ai-crm-overview","version":1}}
```

## obs-stack-drill run 2026-07-21T14:33:19Z

- Result: 13 PASS / 0 FAIL
- API port: 3001, Prometheus port: 9090, Grafana port: 3005, Alertmanager port: 9093, webhook-catcher port: 9099
```json
{"status":"success","data":{"groups":[{"name":"ai-crm.test-rules","file":"/etc/prometheus/alerts-test.yml","rules":[{"state":"inactive","name":"AiCrmApiDownFast","query":"up{job=\"ai-crm-api\"} == 0","duration":5,"keepFiringFor":0,"labels":{"severity":"critical","test_only":"true"},"annotations":{"description":"Fast-firing (for: 5s) mirror of AiCrmApiDown. Used only by ops/obs-stack-drill.sh to prove Alertmanager routing end-to-end within seconds; not intended as a production alerting rule.","summary":"[TEST-ONLY] AI-CRM API scrape target is down (fast)"},"alerts":[],"health":"ok","evaluationTime":0.000072292,"lastEvaluation":"2026-07-21T14:33:33.0582113Z","type":"alerting"}],"interval":5,"limit":0,"evaluationTime":0.000102375,"lastEvaluation":"2026-07-21T14:33:33.058182841Z"},{"name":"ai-crm.rules","file":"/etc/prometheus/alerts.yml","rules":[{"state":"inactive","name":"AiCrmApiDown","query":"up{job=\"ai-crm-api\"} == 0","duration":60,"keepFiringFor":0,"labels":{"severity":"critical"},"annotations":{"description":"Prometheus has not been able to scrape the ai-crm-api target for at least 1 minute. The API process may be down or unreachable from the Prometheus container.","summary":"AI-CRM API scrape target is down"},"alerts":[],"health":"ok","evaluationTime":0.000164333,"lastEvaluation":"2026-07-21T14:33:29.775974673Z","type":"alerting"},{"state":"inactive","name":"AiCrmDualWriteFailures","query":"ai_crm_dual_write_failures \u003e 0","duration":60,"keepFiringFor":0,"labels":{"severity":"warning"},"annotations":{"description":"ai_crm_dual_write_failures has been greater than 0 for at least 1 minute, indicating the best-effort dual-write path is failing for at least one workspace/control.","summary":"AI-CRM dual-write failures observed"},"alerts":[],"health":"ok","evaluationTime":0.00005925,"lastEvaluation":"2026-07-21T14:33:29.776143965Z","type":"alerting"}],"interval":5,"limit":0,"evaluationTime":0.000297959,"lastEvaluation":"2026-07-21T14:33:29.77590709Z"}]}}
```
```json
{"meta":{"type":"db","canSave":true,"canEdit":true,"canAdmin":true,"canStar":true,"canDelete":true,"slug":"ai-crm-overview","url":"/d/ai-crm-overview/ai-crm-overview","expires":"0001-01-01T00:00:00Z","created":"2026-07-21T14:33:28Z","updated":"2026-07-21T14:33:28Z","updatedBy":"Anonymous","createdBy":"Anonymous","version":1,"hasAcl":false,"isFolder":false,"apiVersion":"v0alpha1","folderId":3416064875958272,"folderUid":"bfssbzkurhji8b","folderTitle":"AI-CRM","folderUrl":"/dashboards/f/bfssbzkurhji8b/ai-crm","provisioned":true,"provisionedExternalId":"ai-crm.json","annotationsPermissions":{"dashboard":{"canAdd":true,"canEdit":true,"canDelete":true}}},"dashboard":{"editable":false,"id":3416064907571200,"panels":[{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"gridPos":{"h":8,"w":12,"x":0,"y":0},"id":1,"targets":[{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"expr":"ai_crm_agent_jobs_by_status","legendFormat":"{{status}}","refId":"A"}],"title":"Agent jobs by status","type":"timeseries"},{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"gridPos":{"h":8,"w":12,"x":12,"y":0},"id":2,"targets":[{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"expr":"ai_crm_governance_controls_total","legendFormat":"controls","refId":"A"}],"title":"Governance controls total","type":"timeseries"},{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"fieldConfig":{"defaults":{"thresholds":{"mode":"absolute","steps":[{"color":"green","value":null},{"color":"red","value":1}]}},"overrides":[]},"gridPos":{"h":8,"w":12,"x":0,"y":8},"id":3,"targets":[{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"expr":"ai_crm_dual_write_failures","legendFormat":"dual-write failures","refId":"A"}],"title":"Dual-write failures","type":"timeseries"},{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"fieldConfig":{"defaults":{"mappings":[{"options":{"0":{"color":"red","text":"DOWN"}},"type":"value"},{"options":{"1":{"color":"green","text":"UP"}},"type":"value"}],"thresholds":{"mode":"absolute","steps":[{"color":"red","value":null},{"color":"green","value":1}]}},"overrides":[]},"gridPos":{"h":8,"w":12,"x":12,"y":8},"id":4,"targets":[{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"expr":"up{job=\"ai-crm-api\"}","legendFormat":"up","refId":"A"}],"title":"Scrape target up","type":"stat"}],"refresh":"5s","schemaVersion":39,"tags":["ai-crm","d12"],"time":{"from":"now-15m","to":"now"},"timezone":"browser","title":"AI-CRM Overview","uid":"ai-crm-overview","version":1}}
```
Alertmanager /api/v2/alerts (firing AiCrmApiDownFast):
```json
[{"annotations":{"description":"Fast-firing (for: 5s) mirror of AiCrmApiDown. Used only by ops/obs-stack-drill.sh to prove Alertmanager routing end-to-end within seconds; not intended as a production alerting rule.","summary":"[TEST-ONLY] AI-CRM API scrape target is down (fast)"},"endsAt":"2026-07-21T14:37:48.057Z","fingerprint":"c86447645a486ee1","receivers":[{"name":"webhook-catcher"}],"startsAt":"2026-07-21T14:33:48.057Z","status":{"inhibitedBy":[],"mutedBy":[],"silencedBy":[],"state":"active"},"updatedAt":"2026-07-21T14:33:48.066Z","generatorURL":"http://1dcad392df09:9090/graph?g0.expr=up%7Bjob%3D%22ai-crm-api%22%7D+%3D%3D+0\u0026g0.tab=1","labels":{"alertname":"AiCrmApiDownFast","instance":"host.docker.internal:3001","job":"ai-crm-api","service":"ai-crm-api","severity":"critical","test_only":"true"}}]
```
webhook-catcher received payload:
```json
{"receiver":"webhook-catcher","status":"firing","alerts":[{"status":"firing","labels":{"alertname":"AiCrmApiDownFast","instance":"host.docker.internal:3001","job":"ai-crm-api","service":"ai-crm-api","severity":"critical","test_only":"true"},"annotations":{"description":"Fast-firing (for: 5s) mirror of AiCrmApiDown. Used only by ops/obs-stack-drill.sh to prove Alertmanager routing end-to-end within seconds; not intended as a production alerting rule.","summary":"[TEST-ONLY] AI-CRM API scrape target is down (fast)"},"startsAt":"2026-07-21T14:33:48.057Z","endsAt":"0001-01-01T00:00:00Z","generatorURL":"http://1dcad392df09:9090/graph?g0.expr=up%7Bjob%3D%22ai-crm-api%22%7D+%3D%3D+0\u0026g0.tab=1","fingerprint":"c86447645a486ee1"}],"notification_reason":"first notification","groupLabels":{"alertname":"AiCrmApiDownFast"},"commonLabels":{"alertname":"AiCrmApiDownFast","instance":"host.docker.internal:3001","job":"ai-crm-api","service":"ai-crm-api","severity":"critical","test_only":"true"},"commonAnnotations":{"description":"Fast-firing (for: 5s) mirror of AiCrmApiDown. Used only by ops/obs-stack-drill.sh to prove Alertmanager routing end-to-end within seconds; not intended as a production alerting rule.","summary":"[TEST-ONLY] AI-CRM API scrape target is down (fast)"},"externalURL":"http://5bed16b85df1:9093","version":"4","groupKey":"{}:{alertname=\"AiCrmApiDownFast\"}","truncatedAlerts":0}
```
Alertmanager silence e61aa907-8500-403a-8495-fdb808b31a9c after 'docker compose restart alertmanager' (persistence proof):
```json
[{"id":"e61aa907-8500-403a-8495-fdb808b31a9c","status":{"state":"active"},"updatedAt":"2026-07-21T14:33:49.839Z","comment":"persistence-proof silence, restart-survival check","createdBy":"obs-stack-drill","endsAt":"2026-07-21T14:43:49.000Z","matchers":[{"isEqual":true,"isRegex":false,"name":"alertname","value":"AiCrmApiDownFast"}],"startsAt":"2026-07-21T14:33:49.839Z"}]
```

## obs-stack-drill run 2026-07-21T14:36:15Z

- Result: 12 PASS / 1 FAIL
- API port: 3001, Prometheus port: 9090, Grafana port: 3005, Alertmanager port: 9093, webhook-catcher port: 9099
```json
{"status":"success","data":{"groups":[{"name":"ai-crm.test-rules","file":"/etc/prometheus/alerts-test.yml","rules":[{"state":"firing","name":"AiCrmApiDownFast","query":"up{job=\"ai-crm-api\"} == 0","duration":5,"keepFiringFor":0,"labels":{"severity":"critical","test_only":"true"},"annotations":{"description":"Fast-firing (for: 5s) mirror of AiCrmApiDown. Used only by ops/obs-stack-drill.sh to prove Alertmanager routing end-to-end within seconds; not intended as a production alerting rule.","summary":"[TEST-ONLY] AI-CRM API scrape target is down (fast)"},"alerts":[{"labels":{"alertname":"AiCrmApiDownFast","instance":"host.docker.internal:3001","job":"ai-crm-api","service":"ai-crm-api","severity":"critical","test_only":"true"},"annotations":{"description":"Fast-firing (for: 5s) mirror of AiCrmApiDown. Used only by ops/obs-stack-drill.sh to prove Alertmanager routing end-to-end within seconds; not intended as a production alerting rule.","summary":"[TEST-ONLY] AI-CRM API scrape target is down (fast)"},"state":"firing","activeAt":"2026-07-21T14:36:18.057312879Z","value":"0e+00"}],"health":"ok","evaluationTime":0.000858,"lastEvaluation":"2026-07-21T14:36:23.059731795Z","type":"alerting"}],"interval":5,"limit":0,"evaluationTime":0.000922958,"lastEvaluation":"2026-07-21T14:36:23.059675295Z"},{"name":"ai-crm.rules","file":"/etc/prometheus/alerts.yml","rules":[{"state":"pending","name":"AiCrmApiDown","query":"up{job=\"ai-crm-api\"} == 0","duration":60,"keepFiringFor":0,"labels":{"severity":"critical"},"annotations":{"description":"Prometheus has not been able to scrape the ai-crm-api target for at least 1 minute. The API process may be down or unreachable from the Prometheus container.","summary":"AI-CRM API scrape target is down"},"alerts":[{"labels":{"alertname":"AiCrmApiDown","instance":"host.docker.internal:3001","job":"ai-crm-api","service":"ai-crm-api","severity":"critical"},"annotations":{"description":"Prometheus has not been able to scrape the ai-crm-api target for at least 1 minute. The API process may be down or unreachable from the Prometheus container.","summary":"AI-CRM API scrape target is down"},"state":"pending","activeAt":"2026-07-21T14:36:19.775756578Z","value":"0e+00"}],"health":"ok","evaluationTime":0.000371209,"lastEvaluation":"2026-07-21T14:36:24.777694004Z","type":"alerting"},{"state":"inactive","name":"AiCrmDualWriteFailures","query":"ai_crm_dual_write_failures \u003e 0","duration":60,"keepFiringFor":0,"labels":{"severity":"warning"},"annotations":{"description":"ai_crm_dual_write_failures has been greater than 0 for at least 1 minute, indicating the best-effort dual-write path is failing for at least one workspace/control.","summary":"AI-CRM dual-write failures observed"},"alerts":[],"health":"ok","evaluationTime":0.000047125,"lastEvaluation":"2026-07-21T14:36:24.778073587Z","type":"alerting"}],"interval":5,"limit":0,"evaluationTime":0.0004595,"lastEvaluation":"2026-07-21T14:36:24.777663462Z"}]}}
```
```json
{"meta":{"type":"db","canSave":true,"canEdit":true,"canAdmin":true,"canStar":true,"canDelete":true,"slug":"ai-crm-overview","url":"/d/ai-crm-overview/ai-crm-overview","expires":"0001-01-01T00:00:00Z","created":"2026-07-21T14:33:28Z","updated":"2026-07-21T14:33:28Z","updatedBy":"Anonymous","createdBy":"Anonymous","version":1,"hasAcl":false,"isFolder":false,"apiVersion":"v0alpha1","folderId":3416064875958272,"folderUid":"bfssbzkurhji8b","folderTitle":"AI-CRM","folderUrl":"/dashboards/f/bfssbzkurhji8b/ai-crm","provisioned":true,"provisionedExternalId":"ai-crm.json","annotationsPermissions":{"dashboard":{"canAdd":true,"canEdit":true,"canDelete":true}}},"dashboard":{"editable":false,"id":3416064907571200,"panels":[{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"gridPos":{"h":8,"w":12,"x":0,"y":0},"id":1,"targets":[{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"expr":"ai_crm_agent_jobs_by_status","legendFormat":"{{status}}","refId":"A"}],"title":"Agent jobs by status","type":"timeseries"},{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"gridPos":{"h":8,"w":12,"x":12,"y":0},"id":2,"targets":[{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"expr":"ai_crm_governance_controls_total","legendFormat":"controls","refId":"A"}],"title":"Governance controls total","type":"timeseries"},{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"fieldConfig":{"defaults":{"thresholds":{"mode":"absolute","steps":[{"color":"green","value":null},{"color":"red","value":1}]}},"overrides":[]},"gridPos":{"h":8,"w":12,"x":0,"y":8},"id":3,"targets":[{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"expr":"ai_crm_dual_write_failures","legendFormat":"dual-write failures","refId":"A"}],"title":"Dual-write failures","type":"timeseries"},{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"fieldConfig":{"defaults":{"mappings":[{"options":{"0":{"color":"red","text":"DOWN"}},"type":"value"},{"options":{"1":{"color":"green","text":"UP"}},"type":"value"}],"thresholds":{"mode":"absolute","steps":[{"color":"red","value":null},{"color":"green","value":1}]}},"overrides":[]},"gridPos":{"h":8,"w":12,"x":12,"y":8},"id":4,"targets":[{"datasource":{"type":"prometheus","uid":"ai-crm-prometheus"},"expr":"up{job=\"ai-crm-api\"}","legendFormat":"up","refId":"A"}],"title":"Scrape target up","type":"stat"}],"refresh":"5s","schemaVersion":39,"tags":["ai-crm","d12"],"time":{"from":"now-15m","to":"now"},"timezone":"browser","title":"AI-CRM Overview","uid":"ai-crm-overview","version":1}}
```
Alertmanager /api/v2/alerts (firing AiCrmApiDownFast):
```json
[{"annotations":{"description":"Fast-firing (for: 5s) mirror of AiCrmApiDown. Used only by ops/obs-stack-drill.sh to prove Alertmanager routing end-to-end within seconds; not intended as a production alerting rule.","summary":"[TEST-ONLY] AI-CRM API scrape target is down (fast)"},"endsAt":"2026-07-21T14:40:23.057Z","fingerprint":"c86447645a486ee1","receivers":[{"name":"webhook-catcher"}],"startsAt":"2026-07-21T14:36:23.057Z","status":{"inhibitedBy":[],"mutedBy":[],"silencedBy":["e61aa907-8500-403a-8495-fdb808b31a9c"],"state":"suppressed"},"updatedAt":"2026-07-21T14:36:23.062Z","generatorURL":"http://d4ce05ad9473:9090/graph?g0.expr=up%7Bjob%3D%22ai-crm-api%22%7D+%3D%3D+0\u0026g0.tab=1","labels":{"alertname":"AiCrmApiDownFast","instance":"host.docker.internal:3001","job":"ai-crm-api","service":"ai-crm-api","severity":"critical","test_only":"true"}}]
```
webhook-catcher received payload:
```json

```
Alertmanager silence fcd31bea-3b9a-4666-b118-8f3c5c64df9f after 'docker compose restart alertmanager' (persistence proof):
```json
[{"id":"e61aa907-8500-403a-8495-fdb808b31a9c","status":{"state":"active"},"updatedAt":"2026-07-21T14:33:49.839Z","comment":"persistence-proof silence, restart-survival check","createdBy":"obs-stack-drill","endsAt":"2026-07-21T14:43:49.000Z","matchers":[{"isEqual":true,"isRegex":false,"name":"alertname","value":"AiCrmApiDownFast"}],"startsAt":"2026-07-21T14:33:49.839Z"},{"id":"fcd31bea-3b9a-4666-b118-8f3c5c64df9f","status":{"state":"active"},"updatedAt":"2026-07-21T14:37:06.283Z","comment":"persistence-proof silence, restart-survival check","createdBy":"obs-stack-drill","endsAt":"2026-07-21T14:47:06.000Z","matchers":[{"isEqual":true,"isRegex":false,"name":"alertname","value":"AiCrmApiDownFast"}],"startsAt":"2026-07-21T14:37:06.283Z"}]
```

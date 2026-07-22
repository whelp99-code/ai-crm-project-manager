# Pilot hardening runbook (Q3): bring up ONE pilot instance safely

This is the operator-facing, start-to-finish runbook for bringing up a
**single** AI-CRM pilot instance. It does not introduce any new mechanism —
every contract referenced here is already implemented and documented
elsewhere (`docs/ops/runtime-dsn.md`, `docs/ops/sor-persistence.md`,
`docs/ops/authn.md`, `docs/ops/observability.md`, `docs/ops/live-model.md`,
`docs/ops/eventing.md`, `docs/ops/worker.md`). This doc's job is to
consolidate those into one honest checklist and state, explicitly, what is
**not** yet pilot-ready.

**Read this whole document before bringing up a pilot. Do not skip to a
section.** Sections build on each other, and the "Known residuals" section at
the end is load-bearing, not boilerplate.

Run `packages/persistence/scripts/pilot-preflight.sh` (see "Preflight script"
below) before every pilot bring-up. It automates a subset of the checks in
this runbook and exits non-zero on any gap.

---

## (a) Single-instance constraint — MUST run exactly ONE api instance, ONE worker instance

Three pieces of pilot-critical state live **in-process**, not in Postgres,
not in any shared/distributed store:

1. **`withWorkspaceMutex`** (`apps/api/src/app.ts`) — an in-process
   `Map<workspaceId, Promise-chain>` that serializes the entire
   preview→PG-write→commit critical section for governance
   (authorize/decide/consume) and ledger (draft/verify/post/reverse) routes,
   per workspace. See `docs/ops/sor-persistence.md` ("P6-b G002 (PG-D)").
   This is what prevents same-workspace concurrent requests from producing a
   lost update in memory or a double-consumed single-use control. It is
   **per-process**: two API replicas each hold their own independent `Map`
   and do not know about each other's in-flight critical sections for the
   same workspace. Reconciliation/daily-gate flows that build on the same
   preview/PG-write/commit shape inherit the identical constraint.
2. **The `AzureOpenAiClient` circuit breaker** (`docs/ops/live-model.md`,
   "Resilience") — a per-client-instance, in-process failure counter and
   open/half-open/closed state machine. It "resets on process restart and
   does not coordinate across multiple API process instances/replicas" (the
   doc's own words). Two replicas each have their own breaker state; one
   replica can be open while another is closed for the same failing
   provider.
3. **In-process `EventHub` + PG outbox drain/consumer ticks**
   (`docs/ops/eventing.md`, `docs/ops/worker.md`) — the live SSE fan-out hub
   is a per-process `Map`; the `PgNotifyBridge` mitigates cross-process SSE
   delivery but is best-effort, not ordering-authoritative. Separately, and
   more seriously for a multi-**worker** deployment: `apps/worker`'s outbox
   drain (`runDurableOutboxDrainTick`) and outbox consumer
   (`runDurableOutboxConsumerTick`) ticks are each a single loop reading a
   shared PG table — running two worker processes both draining/consuming
   the same outbox concurrently is safe from double-*publish* (drain uses
   `FOR UPDATE SKIP LOCKED`) but was designed and tested (`docs/ops/worker.md`)
   as a single active worker's responsibility; running N workers multiplies
   consumer-tick overhead with no corresponding scaling benefit and is
   untested at N>1.

**Pilot posture: run exactly ONE `apps/api` process and exactly ONE
`apps/worker` process.** No horizontal scaling, no second replica "for
redundancy," no blue/green pair both serving live traffic simultaneously.
Concretely: one container (or one host process) per app, behind at most a
passthrough reverse proxy — not a load balancer fanning out to N backends.

**What lifting this later requires (NOT done, explicitly out of scope for
this pilot):**

- Replace `withWorkspaceMutex`'s in-process `Map` with a distributed lock
  (e.g. Postgres advisory locks keyed by workspace id, or a Redis-backed
  mutex) so multiple API replicas serialize the same workspace's critical
  section.
- Replace the per-instance circuit breaker with a shared/coordinated one
  (the live-model doc already names this: "a shared/distributed breaker
  (e.g. backed by Redis) is further work if this ever runs multi-replica").
- Partition outbox consumption across workers (e.g. consumer-group-style
  partitioning by workspace hash) instead of running a single active drain
  loop, if worker throughput ever needs horizontal scaling.

None of this exists today. Treat "can I run 2 replicas" as a hard "no" for
this pilot, not a tuning question.

---

## (b) Production DSN split — runtime role vs admin role vs model-gateway role

Full contract: `docs/ops/runtime-dsn.md` and `docs/ops/sor-persistence.md`.
This section is the exact env block a pilot operator must fill in — **every
value below is a placeholder the operator supplies; nothing here is a real
credential**.

```bash
# --- Runtime pool: MUST be the NOBYPASSRLS role, never the docker/bootstrap
# superuser. Every per-request, workspace-scoped read/write runs under this
# role; FORCE RLS on orch_*/crm_*/finance_*/pm_* tables is what actually
# isolates workspaces on this connection. Proven live by
# packages/persistence/scripts/pg-rls-smoke.sh and (structurally) by check #2
# of packages/persistence/scripts/pilot-preflight.sh.
DATABASE_URL=postgres://ai_crm_runtime_api:CHANGE_ME@CHANGE_ME_HOST:5432/ai_crm

# --- Admin pool: a SEPARATE, dedicated cross-workspace-capable (BYPASSRLS)
# role, used ONLY for hydrate-on-boot (listAllControls/listAllIntents/
# listJobSnapshots/listAllReports/listAllEntries/listAllInvocations) and
# apps/worker's outbox drain/claim. Never the same credentials as
# DATABASE_URL above, and never used for per-request traffic. In dev this
# defaults (falls back) to the docker `ai_crm` superuser — a pilot MUST set
# this explicitly to a dedicated role, not rely on that fallback.
ADMIN_DATABASE_URL=postgres://CHANGE_ME_ADMIN_ROLE:CHANGE_ME@CHANGE_ME_HOST:5432/ai_crm

# --- Model-gateway pool (ADR-010 disjoint-principal boundary, Q2/D2): MUST
# point at ai_crm_runtime_model_gateway and MUST be a DISTINCT DSN from
# DATABASE_URL above. createApp() is fail-closed on this in production
# (MODEL_GATEWAY_DSN_REQUIRED_IN_PROD): with NODE_ENV=production and a model
# provider configured, boot refuses to start unless this is set to a DSN
# distinct from DATABASE_URL (ALLOW_INSECURE_PROD=1 is an audited escape
# hatch only, not a pilot default).
MODEL_GATEWAY_DATABASE_URL=postgres://ai_crm_runtime_model_gateway:CHANGE_ME@CHANGE_ME_HOST:5432/ai_crm

# --- apps/worker's own DATABASE_URL: point at ai_crm_runtime_worker
# (NOBYPASSRLS), distinct from the api's DATABASE_URL above. Set
# ADMIN_DATABASE_URL for the worker process too (same admin role as above,
# or another dedicated BYPASSRLS role) — see docs/ops/worker.md "Durable
# governance SoR (G-02)". Leaving the worker's ADMIN_DATABASE_URL unset means
# its hydrate/outbox-drain reads run under whatever role its own
# DATABASE_URL names.
```

Checklist before go-live:

- [ ] `DATABASE_URL` (api) points at `ai_crm_runtime_api`, verified `NOBYPASSRLS`
      (see "Preflight script" below, or run `pg-rls-smoke.sh` manually).
- [ ] `ADMIN_DATABASE_URL` (api) is set explicitly to a distinct, dedicated
      cross-workspace role — not left to fall back to `DATABASE_URL`.
- [ ] `apps/worker`'s `DATABASE_URL` points at `ai_crm_runtime_worker`
      (NOBYPASSRLS), and its `ADMIN_DATABASE_URL` is set explicitly.
- [ ] `MODEL_GATEWAY_DATABASE_URL` is set and is a **different** DSN string
      from `DATABASE_URL` (the preflight script checks string inequality,
      not merely "is set").
- [ ] None of the four DSNs above are left as the shipped dev value
      (`postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm`).

---

## (c) Real Alertmanager receiver + Grafana credential rotation

**What ships today is a drill harness, not a real alert channel.**
`ops/alertmanager/alertmanager.yml` routes every alert to a receiver named
`webhook-catcher` pointed at `http://host.docker.internal:9099/webhook` — a
tiny local HTTP server started by `ops/obs-stack-drill.sh` purely so the
"Prometheus rule fires → Alertmanager routes → receiver gets notified"
pipeline is locally assertable with **no real Slack/email/PagerDuty account**.
See `docs/ops/observability.md` for the full drill narrative. **This is not
wired to any human-facing channel today.** If a pilot goes live with this
config unchanged, alerts fire into a receiver nobody is watching.

**Before any real pilot, replace the receiver block** in
`ops/alertmanager/alertmanager.yml` with a real destination. Example shapes
(pick one; every value is a placeholder the operator supplies — **do not
commit a real webhook URL/API key to this file**):

```yaml
# Slack
receivers:
  - name: "pilot-slack"
    slack_configs:
      - api_url: "CHANGE_ME_SLACK_WEBHOOK_URL"
        channel: "#CHANGE_ME_CHANNEL"
        send_resolved: true

# Or email
receivers:
  - name: "pilot-email"
    email_configs:
      - to: "CHANGE_ME_ONCALL_ADDRESS"
        from: "CHANGE_ME_SENDER_ADDRESS"
        smarthost: "CHANGE_ME_SMTP_HOST:587"
        auth_username: "CHANGE_ME"
        auth_password: "CHANGE_ME"
        send_resolved: true

# Or PagerDuty
receivers:
  - name: "pilot-pagerduty"
    pagerduty_configs:
      - service_key: "CHANGE_ME_PAGERDUTY_INTEGRATION_KEY"
        send_resolved: true
```

Update `route.receiver` to name the new receiver, and treat the
`webhook-catcher` receiver/route as a dev/drill-only artifact — either remove
it or keep it only behind a drill-specific compose profile, never as the
production route target. `packages/persistence/scripts/pilot-preflight.sh`
WARNs (does not FAIL, since it cannot verify the replacement is a real
channel) whenever `alertmanager.yml` still references
`host.docker.internal:9099`.

**Grafana**: `docker-compose.observability.yml` ships
`GF_SECURITY_ADMIN_USER=admin` / `GF_SECURITY_ADMIN_PASSWORD=admin` — a
publicly-known default credential pair. **MANDATORY before any real pilot**:
rotate `GF_SECURITY_ADMIN_PASSWORD` (and consider rotating the username too)
to an operator-supplied secret, e.g.:

```bash
# In the environment/secrets store used to run docker-compose.observability.yml,
# NOT committed to the compose file itself:
export GF_SECURITY_ADMIN_USER=CHANGE_ME
export GF_SECURITY_ADMIN_PASSWORD=CHANGE_ME
```

Both of these (real receiver, rotated Grafana password) are **user-supplied
and currently NOT wired** in this repo. Nothing in this codebase can
fabricate a real Slack webhook or a rotated password on the operator's
behalf — that is the point of this section.

---

## (d) Model provider + secrets

`MODEL_PROVIDER` (`docs/ops/live-model.md`) gates whether `apps/api` wires a
real, network-calling model client at all. Default (unset/`mock`/`none`) is
offline/fail-closed — no secrets required, no network calls made. Setting
`MODEL_PROVIDER=azure` or `openai_compatible` requires real secrets:

```bash
MODEL_PROVIDER=CHANGE_ME            # azure | openai_compatible
AZURE_OPENAI_ENDPOINT=CHANGE_ME     # real Azure resource or OpenAI-compatible gateway base URL
AZURE_OPENAI_API_KEY=CHANGE_ME      # never commit; env-only
AZURE_OPENAI_AUTH_MODE=api-key      # api-key | openai_compatible | azure_ad
AZURE_OPENAI_DEPLOYMENT=CHANGE_ME   # set explicitly outside the pilot's own dev default
```

Secret management posture (operator responsibility, not automated by this
repo):

- **Env-only.** These values are read from `process.env` only; the client
  never logs the key/bearer token (see `docs/ops/live-model.md` "Resilience"
  and the secret-free-error-messages test). Never bake them into a Dockerfile
  layer, image, or committed `.env` file.
- **Never commit.** `.env` is (and must stay) gitignored; only `.env.example`
  with commented-out placeholders is committed.
- **Rotate on suspected exposure** the same as any API credential; the
  circuit breaker/retry config (`AZURE_OPENAI_CIRCUIT_BREAKER_*`,
  `AZURE_OPENAI_MAX_RETRIES`, `AZURE_OPENAI_TIMEOUT_MS`) is unrelated to
  secret rotation and does not need to change when a key is rotated.
- **`MODEL_GATEWAY_DATABASE_URL` prod guard** — see section (b) above; this
  is the DSN-boundary guard, not a model-provider secret, but it only becomes
  load-bearing once a real `MODEL_PROVIDER` is configured (a model provider
  actually writing to `model_invocations`).

---

## Preflight script

`packages/persistence/scripts/pilot-preflight.sh` (chmod +x) automates a
subset of the checks above and exits non-zero on any FAIL:

```bash
packages/persistence/scripts/pilot-preflight.sh
```

It checks, against the calling shell's env and the live Postgres
`DATABASE_URL` points at:

1. `DATABASE_URL` / `ADMIN_DATABASE_URL` / `MODEL_GATEWAY_DATABASE_URL` /
   an auth-key var / `MODEL_PROVIDER` (+ `AZURE_OPENAI_*` if a provider is
   set) are present and not left as `CHANGE_ME` placeholders.
2. **Connects live** and asserts `ai_crm_runtime_api`'s `rolbypassrls` is
   `false` (proves the NOBYPASSRLS contract holds for the role name itself),
   and separately asserts `DATABASE_URL`'s own `current_user` also has
   `rolbypassrls = false` (proves the DSN actually in use isn't a
   superuser/admin role, which the role-name check alone cannot catch).
3. `MODEL_GATEWAY_DATABASE_URL` is a different DSN string from `DATABASE_URL`
   (ADR-010 disjoint-principal boundary).
4. Grafana admin password env var, if present in the shell, is not the
   literal default `admin` (SKIPped, not fabricated, when no such var is in
   the shell's env — the script never queries Grafana's API to guess this).
5. `ops/alertmanager/alertmanager.yml` still referencing the drill
   webhook-catcher endpoint (WARN, not FAIL — replacing it with a real
   receiver is a config change this script cannot verify from the file
   alone).
6. Prints the single-instance operator acknowledgment from section (a).

It prints `PREFLIGHT: n PASS, m FAIL, k WARN` and **exits 1 if any check
FAILed**. Run it in every environment before bringing up a pilot instance,
including dev — **against local dev it is EXPECTED to FAIL/WARN** (dev
deliberately uses the docker `ai_crm` superuser DSN for all three roles, the
drill webhook-catcher, and Grafana `admin`/`admin`). A clean run (0 FAIL)
only happens once the operator has actually completed sections (b)/(c)/(d)
above for the target environment.

---

## Known residuals — NOT production-ready

This pilot posture is deliberately narrow. The following are honest, current
gaps, not oversights to paper over:

- **Multi-instance is unsupported.** See section (a). No distributed lock,
  no shared circuit breaker, no partitioned outbox consumer exists. Running
  more than one `apps/api` or `apps/worker` process is silently unsafe
  (ordering violations, double drains, split breaker state), not merely
  unoptimized.
- **No real alert channel wired by default.** `ops/alertmanager/alertmanager.yml`
  ships pointed at a local drill webhook-catcher. Until an operator replaces
  it (section (c)), alerts fire into a receiver nobody is watching.
- **Grafana ships with default credentials.** `admin`/`admin` until an
  operator rotates `GF_SECURITY_ADMIN_PASSWORD` (section (c)).
- **Model provider secrets are entirely operator-supplied.** This repo
  contains no real `AZURE_OPENAI_*` values anywhere, by design; a pilot with
  `MODEL_PROVIDER` unset stays fully offline (`MODEL_UNAVAILABLE`) until an
  operator wires real secrets.
- **`ADMIN_DATABASE_URL` dev fallback exists and is dangerous if left
  implicit.** If unset, both `apps/api` and `apps/worker` silently fall back
  to `DATABASE_URL` for admin/hydrate/outbox-drain reads — safe in dev
  (docker superuser), a role-separation regression in prod if left unset.
- **Best-effort dual-write residuals remain** for every governance-audit
  surface OTHER than authorize/decide/consume and ledger
  draft/verify/post/reverse (`docs/ops/sor-persistence.md`,
  "Every OTHER governance-audit-bearing surface…"): notification routes and
  agent-command/job-cancel/work-item-completion mutations still call
  `dualWriteAudit` best-effort, with failures swallowed
  (`[DUALWRITE_FAILED]`) and memory staying authoritative. This is an
  accepted, already-documented scope split, not new to this runbook, but it
  remains true at pilot time.
- **NOTIFY/eventing cross-process delivery is best-effort, not a second
  source of truth** (`docs/ops/eventing.md` "Honest residual") — acceptable
  for a single-instance pilot (section (a)) since there is only one process,
  but this residual becomes directly relevant the moment multi-instance is
  ever revisited.
- **Outbox consumer has no retention/pruning** (`docs/ops/worker.md`,
  "Residual trade-off") — the anti-join scan cost grows with unconsumed
  backlog size, not wall-clock recency. Acceptable at pilot scale; watch it
  if backlog grows unboundedly.
- **Model resilience is per-instance, not fleet-wide** (`docs/ops/live-model.md`,
  "Honest scope") — single-provider adapter, no cross-provider fallback,
  circuit breaker resets on restart. Consistent with the single-instance
  posture above; would need rework alongside any multi-instance effort.

**This runbook does not claim the pilot is production-ready. It claims: if
every checklist item in (a)–(d) is completed and `pilot-preflight.sh` exits
0, the instance is safe to bring up as a single-instance pilot with the
residuals above still open.**

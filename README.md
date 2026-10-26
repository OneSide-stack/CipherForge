# CipherForge Academy

A self-hosted, hands-on cybersecurity training platform: 22 catalogued labs, 16 runnable,
12 of them backed by a real attacking surface (a live target service per session) and 4
workspace-forensics labs. Learners get an authenticated browser terminal, a per-user lab
session, real flags issued by the lab, server-side validation and a remediation step that
must actually work against the running target.

Everything in this repository is synthetic. Organizations, people, credentials, keys and
flags are invented for training. Do not point these labs at real systems.

---

## 1. What is in the box

| Area | Location | Notes |
| --- | --- | --- |
| Web app (React + Vite) | `apps/web` | Catalog, lab detail, terminal, profile, admin, QA |
| Platform API (Node + Express + TS) | `apps/api` | Auth, sessions, flags, XP, hints, admin, QA |
| Lab runner (Node + TS) | `apps/runner` | Owns session lifecycle and the isolated runtimes |
| Sandbox supervisor | `apps/runner/sandbox/init.mjs` | Builds the jail, runs the target, serves the PTY broker |
| Lab definitions | `labs/<id>/` | Template, target app, provisioner, validators |
| Shared lab toolkit | `labs/_shared/` | `appkit.mjs`, validators, pcap reader, provision helpers |
| QA suites | `scripts/qa/` | `run-qa.mjs`, `api-e2e.mjs`, `lab-e2e.mjs`, `smoke-sandbox.mjs` |
| Migrations | `apps/api/migrations/` | `001_core.sql`, `002_labs.sql`, `003_qa.sql` |
| Dev orchestration | `scripts/dev/` | Embedded PostgreSQL, migrations, seed, runner + API + web |

### Lab catalog (22 entries)

Interactive (published, real target service per session):

1. `http-header-hunt` — Nimbus Freight portal, missing security headers + leaked build token.
2. `idor-invoice-hunt` — Lumen Health invoices, broken object-level authorisation.
3. `path-traversal-vault` — Atlas Logistics document viewer, `../` traversal.
4. `jwt-none-forge` — Aurora Pay partner API, `alg: none` token forgery.
5. `cloud-bucket-exposure` — Vela Retail backup bucket, anonymous read.
6. `sqli-orders-portal` — Beacon Outfitters order filter, string-concatenated query.
7. `brute-force-gate` — Meridian Logistics admin PIN, no attempt limit.
8. `ssrf-metadata-hunt` — Halcyon Freight importer → loopback metadata service.
9. `cmdi-netcheck` — Torrential ISP diagnostics, shell interpolation.
10. `open-redirect-oauth` — Kestrel Identity broker, unvalidated `redirect_uri`.
11. `mass-assignment-profile` — Solstice HR profile update, role escalation.
12. `xxe-document-parser` — Arclight Billing XML intake, external entity expansion.

Workspace-only (published, real files in a real jailed shell, no target service):

13. `log-forensics` — triage an overnight intrusion from JSON access logs.
14. `linux-permissions` — repair drifted file modes and document the audit.
15. `phishing-email-triage` — analyse a lookalike-domain lure and decode its attachment.
16. `pcap-dns-exfil` — recover a token tunnelled through DNS queries (real libpcap file).

Coming soon (catalogued, clearly marked, cannot be started):

17. `k8s-rbac-escape` (Container Security) 18. `race-condition-coupon` (API Security)
19. `s3-policy-privesc` (Cloud Security) 20. `windows-ad-kerberoast` (Identity & Access, Windows guests required)
21. `nginx-request-smuggling` (Web Security) 22. `android-apk-reverse` (Malware Analysis)

Priority eight: `http-header-hunt`, `idor-invoice-hunt`, `path-traversal-vault`,
`jwt-none-forge`, `cloud-bucket-exposure`, `sqli-orders-portal`, `brute-force-gate`,
`ssrf-metadata-hunt`.

---

## 2. Quick start (local development)

Requirements: Node.js ≥ 20 (`node -v`), npm ≥ 10, Linux with unprivileged user namespaces
(the sandbox driver needs `unshare --user --map-root-user`). No Docker is required for the
sandbox driver; Docker is required only if you want the Docker driver.

```bash
git clone <this repo> cipherforge && cd cipherforge
npm install
npm run setup:sandbox      # one-off: builds the 645 MB sandbox rootfs + assets in ~/.cache/cipherforge
npm run dev                # embedded PostgreSQL :54329, runner :7100, API :5000, web build
```

Then open <http://127.0.0.1:5000>. Development accounts (override with `CF_SEED_*` envs):

| Role | Email | Password |
| --- | --- | --- |
| Admin | `admin@cipherforge.dev` | `AdminForge!2024` |
| Learner | `learner@cipherforge.dev` | `CipherForge!2024` |

Useful variants:

```bash
node scripts/dev/dev.mjs --skip-web   # API + runner only (web/dist must already exist)
npm run build                         # production build of shared + api + runner + web
npm run qa                            # full QA suite (real checks; Docker checks report BLOCKED)
node scripts/qa/run-qa.mjs --quick    # skip the slow end-to-end lab matrix
node scripts/qa/lab-e2e.mjs http-header-hunt   # one lab, exploit → flag → fix → validation
```

The preview URL for this environment is
`https://<sandbox-port-5000>.e2b.app` — the API binds `0.0.0.0:5000` and serves the built SPA
plus `/api`, `/ws`.

---

## 3. Architecture

```
browser ──HTTP/WS──▶ API (Express) ──signed HMAC──▶ lab-runner ──▶ sandbox supervisor ──▶ target app
                       │                                │                │
                       ├─ PostgreSQL (Drizzle-free SQL)   ├─ queue, quotas │  isolated mount/pid/net/ipc/uts
                       └─ WS terminal proxy               ├─ reaper        │  namespaces, overlay rootfs,
                                                          └─ drivers      │  no host fs, no egress
```

* **The web/API tier never touches the container runtime.** Only the runner can start lab
  runtimes, and only from templates that passed `validateTemplate` (approved lab IDs, no
  learner-supplied Docker config, forbidden keys such as `privileged`, `capAdd`, `binds`,
  `devices`, `pidMode`, `command`).
* **Runner authentication** is HMAC-SHA256 over `METHOD\npath\ntimestamp\nnonce` with a 60 s
  skew (`apps/runner/src/auth.ts`). The API signs each call; the terminal WebSocket is signed
  separately and bound to the authenticated user.
* **Gateway**: learners never see a container IP. `GET /api/sessions/:id/target/:name/*`
  proxies through the runner to a Unix socket bridge inside the session, rewriting
  `Location` and cookie `Path` so lab sessions work through the gateway.
* **Flags** are derived per session with `HMAC(sessionSecret, "flag:<lab>:<objective>")`, handed to
  the runner once, hashed with HMAC by the API and never stored in plaintext. Objective
  submission compares hashes only.
* **Status** transitions `queued → provisioning → starting → ready → stopping → stopped`, plus
  `failed`/`expired`. `ready` is only reported after the supervisor's health probes and the
  driver's second verification through the gateway socket.

### Session lifecycle

`POST /api/labs/:id/sessions` (CSRF + quota) → runner `/sessions` → supervisor boot →
provisioner → services + health → readiness → `ready`. Then `stop`, `reset`, `extend`,
`GET /api/sessions/:id`, and SSE/WebSocket status. Expiry is enforced by the API, the runner
watchdog and the supervisor's own TTL timer; the runner reaps orphans at startup.

---

## 4. Isolation and the security model

Sandbox driver, per session (`apps/runner/sandbox/init.mjs`):

* `unshare --user --map-root-user --mount --pid --net --uts --ipc --fork` (setpriv adds
  `--no-new-privs` when available).
* Fresh overlay rootfs (read-only lower, per-session upper); `/proc`, `/dev` (new devpts),
  `/dev/shm`, `/tmp`, `/var/tmp`, `/run` are fresh tmpfs instances. Host filesystems are not
  reachable after `pivot_root`; `/lab` and `/opt/cf` are read-only binds.
* The learner home is a tmpfs; the workspace and the PTY broker live on session-private
  mounts (`/run/cf`, `/run/cfsock`), so one session cannot read another's files.
* Resource caps: CPU share, RSS watchdog (kills the session after two strikes), PID count,
  TTL and idle timeout, all enforced in the supervisor with distinct exit codes.
* No outbound network by default: sessions start with only loopback up. Templates that need
  egress must declare `network.outbound: allow` (none of the shipped labs do).
* The PTY is a real `node-pty` shell inside the jail, bound to the authenticated user and
  session; it cannot be attached to another user's session (the runner verifies ownership
  before opening the broker channel).

Honest limits:

* The sandbox driver isolates with **namespaces**, not a VM or a separate kernel. It is
  appropriate for single-tenant or trusted-classroom deployments. For multi-tenant
  production, run the Docker driver on a dedicated worker host, or move to microVMs.
* The Docker driver (`apps/runner/src/drivers/docker-driver.ts`) implements the same contract
  against the Docker API (no socket in the API container, `no-new-privileges`, dropped caps,
  read-only rootfs, pinned images). **It could not be exercised on this host** — Docker is not
  installed — so it is reported `BLOCKED` by QA, never `PASS`.
* Learners inside a session share the session's network namespace; a lab's internal services
  are reachable from that session's shell (this is normal for this class of platform).

---

## 5. Full lab-runner deployment (separate host)

The runner is designed to run on a dedicated worker, never beside the public API.

1. Provision a worker host with Docker (or unprivileged namespaces for the sandbox driver).
2. Create a shared secret and configure the worker:

   ```bash
   export CF_RUNNER_SECRET="$(openssl rand -hex 32)"
   export CF_RUNNER_PORT=7100
   export CF_RUNNER_BIND=0.0.0.0
   export CF_DRIVER=docker            # or sandbox
   export CF_RUNTIME_DIR=/var/lib/cipherforge
   node apps/runner/dist/index.js
   ```

3. Configure the API tier with the same secret and the worker URL:

   ```bash
   export CF_RUNNER_URL=https://runner.internal:7100
   export CF_RUNNER_SECRET=<same secret>
   ```

4. Network policy: the runner endpoint must only be reachable from the API tier (mTLS or a
   private network). **Never** expose the Docker socket over TCP; the runner talks to Docker
   over the local socket, and only the runner process reads it.
5. Runner hardening: dedicate the host to this workload, keep images pinned by digest, run
   the runner as a non-root user in the `docker` group (not root), and enable the orphan
   reaper (on by default at startup and on stop).

The Docker driver's security flags (see `docker-driver.ts`): `--network` per session,
`--memory`, `--cpus`, `--pids-limit`, `--read-only`, `--cap-drop ALL`,
`--security-opt no-new-privileges`, `--security-opt seccomp=<profile>`, non-root user,
no bind mounts from the host, no published ports (all traffic goes through the socket bridge).

---

## 6. QA

`npm run qa` executes real checks against the running stack and writes
`artifacts/qa-report.json`; `--persist` also stores the run in `qa_runs` so the admin QA screen
shows it. The admin screen can trigger the same suite with **Run QA**.

Checking philosophy: a check that cannot run on this host is recorded as **BLOCKED** with the
reason (for example “Docker is not available in this environment”), never as PASS.

Latest full run on this machine (sandbox driver, Docker absent):

```
pass=190  fail=0  blocked=1  total=191   (sandbox driver, 16 labs driven end to end)
BLOCKED environment/docker engine reachable :: Docker is not available in this environment
```

Suites: `environment`, `catalog`, `platform-api`, `data-protection`, `api-e2e`, `lab-e2e`
(the last one drives every runnable lab end to end: attack → flag → remediation → live
validator → completion).

---

## 7. Configuration

Copy `.env.example` to `.env` for local overrides. Important variables:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `CF_APP_SECRET` | Session/cookie signing and seed derivation |
| `CF_RUNNER_SECRET` | HMAC secret shared by API and runner |
| `CF_RUNNER_URL` | Runner base URL |
| `CF_DRIVER` | `sandbox` or `docker` |
| `CF_PROVISION_PER_HOUR` | Per-learner session quota (default 12) |
| `CF_MAX_SESSIONS` | Runner capacity |
| `CF_SEED_ADMIN_EMAIL` / `CF_SEED_ADMIN_PASSWORD` | Bootstrap admin account |

Never commit real secrets. The development seed credentials exist only to make `npm run dev`
usable; change them before exposing the app.

---

## 8. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `sandbox prerequisites missing` | Unprivileged user namespaces disabled. Check `cat /proc/sys/kernel/unprivileged_userns_clone` (must be 1) and that `npm run setup:sandbox` completed. |
| Session `failed` with `provisioning-failed` | Read the session logs on the API (`GET /api/sessions/:id/logs`) — the supervisor's startup error is surfaced there. Use `CF_KEEP_FAILED_SESSIONS=1` on the runner to keep runtime dirs for inspection. |
| `429 rate_limited` when starting labs | Per-learner provisioning quota (`CF_PROVISION_PER_HOUR`, default 12/hour). The QA harness rotates accounts on purpose instead of raising the limit. |
| Login blocked after failed attempts | Ten failed sign-ins per email or IP in 15 minutes triggers a lockout. Wait or clear `login_attempts`. |
| Terminal shows no prompt | The session must be `ready`; the runner exposes the PTY only after the health gate. Check `GET /api/sessions/:id`. |
| Lab target returns 502 through the gateway | The target died after readiness; the supervisor tears the session down (`service-crash`). Restart the session. |
| Ports already in use | `CF_PORT` (API), `CF_RUNNER_PORT`, `CF_PG_PORT` override the defaults 5000/7100/54329. |
| Docker driver never becomes ready | Check `docker info` on the worker; QA reports this as BLOCKED until an engine is reachable. |

---

## 9. Tests

* `npm run qa` — full suite (see §6).
* `node scripts/qa/api-e2e.mjs` — API contract, auth, RBAC, CSRF, rate limits, quotas, SSE.
* `node scripts/qa/lab-e2e.mjs [lab ...]` — per-lab exploit/verify matrix.
* `node scripts/qa/smoke-sandbox.mjs` — sandbox isolation smoke test (namespaces, mounts,
  resource caps, PTY, teardown).
* `npm test` — unit suites (`apps/api/test`, `apps/web/test`): crypto, rate limiting,
  template validation/catalog floor, UI formatting. 15 tests, all passing.

---

## 10. Known limitations

* Docker-backed labs are implemented but **not verified** on this host (no Docker engine);
  QA reports them `BLOCKED`.
* The sandbox driver is a namespace jail, not a hardware boundary.
* `windows-ad-kerberoast` and `android-apk-reverse` are catalogued as unavailable/coming
  soon because they need Windows guests and an Android emulator respectively.
* Email delivery, password reset and OAuth/SSO for the platform itself are out of scope; the
  seeded accounts and session cookies are the only sign-in paths.

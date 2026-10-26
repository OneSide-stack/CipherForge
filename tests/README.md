# Tests

Three layers, all runnable locally without external services except PostgreSQL (embedded via
`npm run dev`) and a Linux host with user namespaces for the sandbox driver.

## 1. Unit tests (`npm test`)

`node:test` suites compiled with TypeScript:

* `apps/api/test/crypto.test.ts` — scrypt password hashing/verification, HMAC determinism,
  timing-safe comparison.
* `apps/api/test/ratelimit.test.ts` — in-process limiter burst and per-key scoping.
* `apps/api/test/templates.test.ts` — every shipped template validates, the catalog meets the
  product floor (≥20 entries, ≥12 interactive), and forbidden runtime keys / missing
  resources / duplicate objectives are rejected.
* `apps/web/test/format.test.ts` — pure UI helpers (tones, labels, countdown formatting).

```bash
npm test                       # both workspaces
npm run test -w @cipherforge/api
npm run test -w @cipherforge/web
```

## 2. Integration / end-to-end (`scripts/qa`)

Require the stack running (`npm run dev`):

```bash
node scripts/qa/run-qa.mjs            # full suite + artifacts/qa-report.json
node scripts/qa/run-qa.mjs --quick    # skip the slow lab matrix
node scripts/qa/run-qa.mjs --persist  # store the run for the admin QA screen
node scripts/qa/run-qa.mjs --only=catalog,platform-api
node scripts/qa/api-e2e.mjs           # API contract, auth, RBAC, CSRF, quotas, SSE
node scripts/qa/lab-e2e.mjs           # every runnable lab: attack → flag → fix → validate
node scripts/qa/lab-e2e.mjs idor-invoice-hunt
node scripts/qa/probe-target.mjs <labId> [paths...]   # debug a lab's gateway routes
```

`lab-e2e` performs the real attack through the authenticated gateway or the real PTY
terminal, submits the flag the lab issued, applies the remediation policy with `labctl`, runs
the live server-side validator and checks the lab is marked complete.

## 3. Isolation smoke test

```bash
node scripts/qa/smoke-sandbox.mjs
```

Starts a runner on a spare port, provisions `http-header-hunt`, and asserts namespace/mount
isolation, read-only lab assets, resource accounting, PTY behaviour and idempotent teardown.
It does not need the API or the database.

## Reporting rules

* A check that cannot execute on this host is `BLOCKED` with the reason (e.g. Docker absent).
* A check that fails is `FAIL`; nothing is coerced to `PASS`.
* The QA suite persists the raw check list, so the admin screen shows exactly what ran.

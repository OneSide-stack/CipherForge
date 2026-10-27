# Troubleshooting

## Sessions

**`failed` / `provisioning-failed`.** The sandbox supervisor could not finish starting the
lab. `GET /api/sessions/:id/logs` returns the supervisor log and the `startup-error.json`
payload, which names the exact cause (missing provisioner file, non-zero provisioner exit,
health check failure). On the runner set `CF_KEEP_FAILED_SESSIONS=1` to keep runtime
directories under `$CF_RUNTIME_DIR/sessions/<id>` for inspection.

**`failed` / `service-crash`.** A target service exited after readiness. The supervisor tears
the session down so a dead lab is never advertised as ready. Restart the lab; if it repeats,
read `$CF_RUNTIME_DIR/sessions/<id>/logs/<service>.log`.

**`failed` / `resource-limit`.** RSS or PID cap exceeded. Raise the template's
`resources.memoryMb` / `resources.pids` (platform maximums: 4096 MB, 1024 PIDs, 4 CPUs).

**`expired`.** Either the TTL (`maxMinutes`) or the idle timeout expired. Learners can
extend a session from the UI (`POST /api/sessions/:id/extend`).

**`429 rate_limited` on start.** Per-learner provisioning quota (`CF_PROVISION_PER_HOUR`,
default 12/hour) or runner capacity. The QA harness rotates accounts rather than raising the
limit, because the limit is a product feature.

## Terminal

* No prompt: the session is not `ready` yet. Check `GET /api/sessions/:id`.
* WebSocket closes with 4401/4403: the session cookie is missing or the session belongs to
  another user. Sign in again from the same browser profile.
* Garbled output: the PTY is a real shell with bracketed paste enabled; use the paste
  affordance rather than middle-click in some browsers.

## Gateway / target

* `502 target_unreachable`: the target is not answering on its bridge socket. Usually a
  crashed service (see above) or a template that declares the wrong port.
* `409 The lab is not ready yet`: the session is still provisioning.
* Login redirects in a lab that does not stick: lab cookies are scoped to
  `/api/sessions/<id>/target/<name>/`; a browser extension that rewrites cookies can break
  this.

## Database and startup

* `npm run dev` fails at migrations: check `DATABASE_URL` and that embedded PostgreSQL can
  bind its port (`CF_PG_PORT`, default 54329).
* “ports already in use”: stop the stale process or set `CF_PORT` / `CF_RUNNER_PORT`.
* Seed fails with `Invalid lab template: unknown category …`: the category must be one of the
  values in `packages/shared/src/types.ts` (`CATEGORIES`).

## QA

* `BLOCKED docker engine reachable`: the host has no Docker; the Docker driver cannot be
  exercised, so the check is reported blocked instead of passing.
* The QA run needs a live stack (`npm run dev`). Without it, platform suites report failures
  with the connection error instead of pretending to pass.

## Sandbox prerequisites

```bash
cat /proc/sys/kernel/unprivileged_userns_clone      # must be 1
grep overlay /proc/filesystems                      # overlayfs available
node -e "require('node-pty')"                       # native module built
```

If the native module is missing, rebuild with `npm rebuild node-pty --build-from-source`.

### `npm install` fails while building node-pty

Symptom: `gyp http fetch GET https://nodejs.org/download/release/.../node-vX-headers.tar.gz
... ECONNRESET` and `gyp ERR! configure error`. `node-pty` compiles against Node headers,
and node-gyp downloads them when it cannot find a local copy.

Fix: reuse the headers that ship with the installed Node build.

```bash
npm_config_nodedir=/usr/local npm install     # typical for Node installed under /usr/local
# or point at the right prefix: npm_config_nodedir=$(dirname $(dirname $(which node)))
node -e "require('node-pty'); console.log('node-pty ok')"
```

Then re-run `npm run setup:sandbox` so the module is copied into the lab asset tree
(`~/.cache/cipherforge/assets/node_modules/node-pty`).

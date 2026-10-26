# Lab runner: deployment and security model

The runner is the only component that starts lab runtimes. It is intentionally a separate
service with its own credential and its own network position.

```
API  ──HMAC-signed HTTPS──▶  runner  ──▶  driver (docker | sandbox)  ──▶  session runtime
```

## 1. Trust boundaries

| Component | Can it start a lab? | Sees the Docker socket? | Holds raw flags? |
| --- | --- | --- | --- |
| Browser | no | no | no |
| Web/API tier | no (only asks the runner) | no | briefly (hashes immediately) |
| Runner | yes, only from approved templates | yes (docker driver only) | briefly (one-shot handoff) |
| Target app inside a session | no | no | yes, only the flags it is meant to reveal |

* The API never mounts a container runtime socket and never accepts learner-supplied image
  names, Dockerfiles, compose files, bind mounts or commands. Templates are validated by
  `validateTemplate()`; forbidden keys include `privileged`, `capAdd`, `devices`, `binds`,
  `volumes`, `mounts`, `pidMode`, `ipcMode`, `networkMode`, `hostConfig`, `dockerfile`,
  `compose` and `command`.
* Runner calls are HMAC-signed over `METHOD\npath\ntimestamp\nnonce` with a 60-second skew and
  a nonce cache (`apps/runner/src/auth.ts`). The terminal WebSocket uses the same signature
  plus the authenticated `userId`.
* The runner binds to a private interface only. Never expose it to the internet and never
  expose the Docker API over TCP.

## 2. Deploying the runner on a worker host

```bash
# 1. host prep (Docker driver)
sudo install -d -o runner -g docker -m 0750 /var/lib/cipherforge
# 2. secrets
export CF_RUNNER_SECRET="$(openssl rand -hex 32)"     # identical on the API tier
# 3. runner
export CF_DRIVER=docker
export CF_RUNTIME_DIR=/var/lib/cipherforge
export CF_MAX_SESSIONS=20
export CF_RUNNER_PORT=7100
export CF_RUNNER_BIND=10.0.5.20
node apps/runner/dist/index.js
```

The API tier then gets:

```bash
export CF_RUNNER_URL=http://10.0.5.20:7100
export CF_RUNNER_SECRET=<same secret>
```

Health: `GET /health` on the runner reports driver availability, capacity and checks.
Readiness gates (namespaces/overlay for sandbox, engine + pinned images for Docker) are
reported to the admin screen; a runner that cannot meet them refuses to start sessions
instead of silently falling back.

### Sandbox driver (no Docker)

```bash
npm run setup:sandbox        # builds ~/.cache/cipherforge/rootfs and assets once
export CF_DRIVER=sandbox
node apps/runner/dist/index.js
```

Requirements: Linux, `unshare` with user namespaces enabled
(`/proc/sys/kernel/unprivileged_userns_clone = 1`), overlayfs, `node-pty` built for the
installed Node version. This driver isolates by namespaces and is suitable for a single
trusted tenant or classroom; it is not a VM boundary.

### Docker driver flags

The driver creates one network per session and starts each service as a container with:

* `--network cf-<session>` (no default bridge, no published ports; the runner bridges traffic
  through a Unix socket),
* `--memory`, `--cpus`, `--pids-limit`, `--storage-opt size=<writableDiskMb>M`,
* `--read-only` root filesystem with a small writable tmpfs,
* `--cap-drop ALL`, `--security-opt no-new-privileges`, seccomp profile,
* non-root UID, no host bind mounts, no devices, no host namespaces,
* images pinned by digest, `network.outbound: deny` enforced by the per-session network.

## 3. Session lifecycle and cleanup

`queued → provisioning → starting → ready → stopping → stopped`, with `failed` and `expired`
as terminal states. `ready` requires the supervisor's HTTP health probes **and** the driver's
own probe through the gateway bridge, so a service that dies immediately after starting is
never reported ready.

Cleanup is idempotent and layered:

1. API expiry sweep (session TTL),
2. runner reaper (stale sessions every 30 s, orphans at startup),
3. supervisor TTL/idle timers with distinct exit codes (5 = TTL, 6 = idle),
4. driver removal of networks, containers, sockets and runtime directories.

The supervisor also kills every remaining process in its PID namespace before exiting, so a
stopped session leaves nothing behind.

## 4. Resource controls

| Control | Where | Default |
| --- | --- | --- |
| CPU shares | template `resources.cpus` | 0.5 |
| Memory | template + supervisor RSS watchdog (2 strikes) | 320 MB |
| PIDs | template + supervisor process count | 96 |
| Writable disk | template `resources.writableDiskMb` | 64 MB |
| Session TTL | template + supervisor timer | 45 min |
| Idle timeout | template + supervisor timer | 20 min |
| Per-user concurrent sessions | API + runner quota | 2 |
| Per-user provisions/hour | API persistent limiter | 12 |
| Runner capacity | `CF_MAX_SESSIONS` | 8 |

## 5. What the runner will not do

* Start an arbitrary image or command.
* Mount anything from the host into a session other than the read-only lab assets.
* Attach a terminal to a session owned by another user (ownership is checked on both the API
  and the runner before the broker channel is opened).
* Report `ready` for a session whose target failed its health gate.
* Hand raw flags to the learner-visible workspace: provisioners emit flags over stdout, the
  supervisor writes them to a host-only file (`0600`) that the runner reads once and deletes.

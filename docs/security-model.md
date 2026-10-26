# Security model

## Accounts and authorisation

* Session cookies are `HttpOnly`, `SameSite=Lax`, signed with `CF_APP_SECRET`; state-changing
  requests require a CSRF token issued on the first authenticated response (`x-csrf-token`).
* Roles: `learner` and `admin`. Admin routes are guarded by `requireAdmin` and every attempt
  is written to `audit_log`. A learner calling an admin route receives `403`.
* Login has a persistent limiter: 10 failed attempts per email **or** IP in 15 minutes.
* Passwords are hashed (scrypt) and compared in constant time; the hash is stored in
  `users.password_hash`, never in a plaintext column.

## Sessions and ownership

* Every session row carries `user_id`; all reads/writes go through `requireOwnedSession`,
  which returns `404` for other users' sessions (no ID enumeration signal).
* The runner independently checks ownership before attaching a terminal, so a stolen session
  ID plus a valid cookie from a different user still fails.
* The gateway (`/api/sessions/:id/target/:name/*`) is authenticated; no container IP or port
  is ever exposed to the browser.

## Flags and scoring

* Flags are derived per session: `CF{HMAC(secret, "flag:<lab>:<objective>")[0:32]}`. The
  learner-facing workspace never contains them (workspace-only labs instead validate real
  filesystem/report state).
* The API hashes candidate submissions with HMAC and stores only hashes
  (`session_flags.flag_hmac`, 64 hex chars). Submissions are rate limited and every attempt is
  recorded in `flag_attempts`.
* XP, walkthrough penalties and hint costs are computed server-side; the client cannot send a
  score.

## Isolation

* Sandbox driver: user/mount/pid/net/uts/ipc namespaces, overlay rootfs, fresh `/proc`,
  `/dev`, `/dev/shm`, `/tmp`, `/var/tmp`, `/run`, read-only lab assets, `no_new_privs`,
  loopback-only networking by default, RSS/PID/TTL/idle watchdogs.
* Docker driver: per-session network, dropped capabilities, `no-new-privileges`, seccomp,
  read-only root, non-root user, pinned digests, no host mounts, no published ports.
* The API/web tier never has access to a container runtime.
* Honest limitation: the sandbox driver is a namespace jail on a shared kernel; it is not a
  VM boundary. Multi-tenant production deployments should use the Docker driver on a
  dedicated worker or microVMs.

## Logging and secrets

* The runner logs are passed through `sanitize()`, which strips flag-shaped values and
  secrets before writing.
* Flags are never logged by the API; only objective IDs, hashes and outcomes appear.
* `CF_SESSION_SECRET` exists only inside the supervisor process; target apps get a derived
  `CF_APP_SEED` and only the flags their service is supposed to reveal.

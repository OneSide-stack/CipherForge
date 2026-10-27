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

## Browser hardening and preview embeddings

The API serves the SPA with Helmet defaults plus a strict CSP: `default-src 'self'`, no
inline scripts, `frame-ancestors 'self'`, `X-Frame-Options: SAMEORIGIN`, HSTS in production,
COOP/CORP, and `cache-control: no-store` on `/api/*`. Lab target responses never inherit
these headers; the gateway strips framing and cookie headers from target traffic.

Cloud preview environments embed the app inside *their* document, which the strict framing
policy would block. That relaxation is host-scoped and explicit:

| Setting | Effect |
| --- | --- |
| `CF_PREVIEW_FRAME_HOSTS` | Comma-separated hostname suffixes (default `.e2b.app` outside production). Only requests whose `Host` matches get the relaxed policy. |
| `CF_PREVIEW_FRAME_ANCESTORS` | Extra ancestor sources added for those hosts; `*` (development default) allows an unknown console origin to embed the preview. |

Every other host — including anything reached by IP or a real domain — keeps
`frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`. In production, leave
`CF_PREVIEW_FRAME_HOSTS` empty so no host can frame the app at all, or list only the console
host you actually use. Clickjacking exposure is limited even on preview hosts because every
state change requires a cookie session *plus* the per-session CSRF token and an accepted
`Origin`.

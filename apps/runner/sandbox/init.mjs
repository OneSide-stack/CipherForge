/**
 * CipherForge sandbox session supervisor.
 *
 * Runs INSIDE a fresh user+mount+pid+net+uts+ipc namespace, created by the
 * lab-runner with `unshare(1)`. It builds a private root filesystem from an
 * overlay of the shared read-only base rootfs, pivots into it, provisions the
 * approved lab artifacts, starts the approved service entrypoints, waits for
 * real health checks, then exposes:
 *
 *   - one unix-socket TCP bridge per published target port (host -> target)
 *   - a control/terminal broker socket (host -> PTY / approved validators)
 *
 * The process never touches the host filesystem or Docker socket. All learner
 * visible state is inside the jail's mount namespace and dies with this process.
 *
 * NOTE: this file is executed by the host node binary before pivot_root, and
 * keeps running after the pivot. Child processes (targets, validators, shells)
 * use the node/python binaries of the base rootfs.
 */
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SESSION_DIR = process.argv[2];
// The config lives OUTSIDE the bind-mounted shared dir: it carries the session
// HMAC secret, which must never be reachable from inside the learner's jail.
const CONFIG_PATH = process.argv[3] ?? path.join(SESSION_DIR, 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
try {
  // One-shot: the supervisor keeps it in memory only.
  fs.rmSync(CONFIG_PATH, { force: true });
} catch {}

// Directory FD captured before pivot_root: lets the supervisor write host-only
// files (provision results, flags) that are never visible inside the jail.
let HOST_DIR_FD = null;
try {
  HOST_DIR_FD = fs.openSync(SESSION_DIR, 'r');
} catch {}
const hostOnlyPath = (name) => (HOST_DIR_FD === null ? path.join(SESSION_DIR, name) : `/proc/self/fd/${HOST_DIR_FD}/${name}`);

const log = (...args) => {
  // Host-visible log until the shared mount exists; then the same path is
  // reachable inside the jail at /run/cf/logs.
  const file = fs.existsSync('/run/cf/logs') ? '/run/cf/logs/supervisor.log' : path.join(SESSION_DIR, 'logs', 'supervisor.log');
  try {
    fs.appendFileSync(file, `${new Date().toISOString()} ${args.join(' ')}\n`);
  } catch {
    process.stderr.write(`${args.join(' ')}\n`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class StartupError extends Error {
  constructor(code, message, detail = '') {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

const children = [];
const sockets = [];
const bridges = [];
let shuttingDown = false;
let exitCode = 0;

function run(cmd, args, opts = {}) {
  const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  return out;
}
function tryRun(cmd, args, opts = {}) {
  try {
    return { ok: true, out: run(cmd, args, opts) };
  } catch (err) {
    return { ok: false, out: String(err.stderr || err.message) };
  }
}

function mustRun(cmd, args, what) {
  const res = tryRun(cmd, args);
  if (!res.ok) throw new StartupError('mount-failed', `sandbox setup failed: ${what}`, res.out.trim().slice(0, 600));
}

function sharedPath(name) {
  // Before pivot the shared dir is a host path; afterwards it is mounted at /run/cf.
  const jailShared = '/run/cf';
  const dir = fs.existsSync(jailShared) ? jailShared : path.join(SESSION_DIR, 'shared');
  return path.join(dir, name);
}

function writeShared(name, data) {
  const target = sharedPath(name);
  fs.writeFileSync(target, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  return target;
}

function writeHostOnly(name, data) {
  const target = hostOnlyPath(name);
  fs.writeFileSync(target, typeof data === 'string' ? data : JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(target, 0o600);
  } catch {}
  return target;
}

function fail(err) {
  const payload = {
    state: 'failed',
    code: err.code ?? 'provisioning-failed',
    message: err.message ?? 'unknown sandbox failure',
    detail: String(err.detail ?? '').slice(0, 4000),
    at: new Date().toISOString(),
  };
  try {
    writeShared('startup-error.json', payload);
  } catch {}
  log('STARTUP FAILED', payload.code, payload.message, payload.detail);
  cleanup(1);
}

async function main() {
  const r = config.resources;
  const merged = path.join(SESSION_DIR, 'merged');
  const lower = config.rootfsDir;
  fs.mkdirSync(path.join(SESSION_DIR, 'shared'), { recursive: true });
  fs.mkdirSync(path.join(SESSION_DIR, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(SESSION_DIR, 'home'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(merged, { recursive: true });

  const mp = (p) => {
    const full = path.join(merged, p);
    fs.mkdirSync(full, { recursive: true });
    return full;
  };

  // ------------------------------------------------------------------ mounts
  mustRun('mount', ['--make-rprivate', '/'], 'make / private');
  mustRun(
    'mount',
    [
      '-t',
      'overlay',
      'overlay',
      '-o',
      `lowerdir=${lower},upperdir=${path.join(SESSION_DIR, 'upper')},workdir=${path.join(SESSION_DIR, 'work')}`,
      merged,
    ],
    'create session overlay root',
  );

  for (const d of ['proc', 'sys', 'dev', 'dev/pts', 'dev/shm', 'tmp', 'run', 'run/cf', 'run/cfsock', 'home/learner', 'var/tmp', 'lab', 'opt/cf']) mp(d);
  mustRun('mount', ['-t', 'proc', 'proc', mp('proc')], 'mount /proc');
  mustRun('mount', ['-t', 'tmpfs', 'tmpfs', '-o', 'size=4m,mode=755', mp('sys')], 'mount /sys');
  mustRun('mount', ['--rbind', '/dev', mp('dev')], 'bind /dev');
  mustRun('mount', ['-t', 'devpts', 'devpts', mp('dev/pts'), '-o', 'newinstance,ptmxmode=0666,mode=0620'], 'mount devpts');
  mustRun('mount', ['-t', 'tmpfs', 'tmpfs', '-o', 'size=8m,mode=1777', mp('dev/shm')], 'mount /dev/shm');
  const writable = `${Math.max(16, r.writableDiskMb)}m`;
  mustRun('mount', ['-t', 'tmpfs', 'tmpfs', '-o', `size=${writable},mode=1777`, mp('tmp')], 'mount bounded /tmp');
  mustRun('mount', ['-t', 'tmpfs', 'tmpfs', '-o', `size=${writable},mode=1777`, mp('var/tmp')], 'mount bounded /var/tmp');
  mustRun('mount', ['-t', 'tmpfs', 'tmpfs', '-o', 'size=8m,mode=755', mp('run')], 'mount /run');
  mustRun('mount', ['--bind', path.join(SESSION_DIR, 'shared'), mp('run/cf')], 'bind shared dir');
  mustRun('mount', ['--bind', path.join(SESSION_DIR, 'sock'), mp('run/cfsock')], 'bind socket dir');
  mustRun('mount', ['-t', 'tmpfs', 'tmpfs', '-o', `size=${writable},mode=0700`, mp('home/learner')], 'mount bounded home');
  // Approved lab assets are mounted read-only. The template registry is the
  // only source of these paths; learner input can never influence them.
  mustRun('mount', ['--bind', config.labsDir, mp('lab')], 'bind approved lab assets');
  mustRun('mount', ['-o', 'remount,bind,ro', mp('lab')], 'make lab assets read-only');
  mustRun('mount', ['--bind', config.assetsDir, mp('opt/cf')], 'bind platform assets');
  mustRun('mount', ['-o', 'remount,bind,ro', mp('opt/cf')], 'make platform assets read-only');

  // -------------------------------------------------------------- pivot root
  process.chdir(merged);
  fs.mkdirSync(path.join(merged, '.oldroot'), { recursive: true });
  tryRun('/usr/sbin/pivot_root', ['.', '.oldroot']);
  process.chdir('/');
  tryRun('/usr/sbin/umount', ['-l', '/.oldroot']);
  try {
    fs.rmdirSync('/.oldroot');
  } catch {}

  // Jail identity + resolver (no outbound network => no DNS).
  fs.writeFileSync('/etc/hostname', `${config.hostname}\n`);
  tryRun('hostname', [config.hostname]);
  fs.writeFileSync('/etc/hosts', `127.0.0.1 localhost ${config.hostname}\n::1 localhost\n`);
  fs.writeFileSync('/etc/resolv.conf', '# CipherForge lab session: outbound network and DNS are denied by policy.\n');
  const passwd = fs.readFileSync('/etc/passwd', 'utf8').split('\n').filter((l) => l && !l.startsWith('learner:'));
  passwd.push('learner:x:0:0:Lab Learner:/home/learner:/bin/bash');
  passwd.push('root:x:0:0:root:/root:/bin/bash');
  fs.writeFileSync('/etc/passwd', `${passwd.join('\n')}\n`);
  fs.writeFileSync('/etc/group', 'root:x:0:\nlearner:x:0:\nnogroup:x:65534:\n');

  tryRun('/sbin/ip', ['link', 'set', 'lo', 'up']);
  tryRun('/usr/sbin/ip', ['link', 'set', 'lo', 'up']);
  tryRun('/sbin/sysctl', ['-q', 'net.ipv4.ip_unprivileged_port_start=0']);

  fs.mkdirSync('/home/learner', { recursive: true, mode: 0o700 });
  fs.mkdirSync('/home/learner/work', { recursive: true });
  fs.writeFileSync(
    '/etc/profile.d/10-cipherforge.sh',
    [
      'export HOME=/home/learner',
      'export TERM=${TERM:-xterm-256color}',
      'export PATH=/opt/cf/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      'export PYTHONPATH=/opt/cf/py:${PYTHONPATH}',
      'export PS1="\\[\\e[38;5;45m\\]learner@' + config.hostname + '\\[\\e[0m\\]:\\[\\e[38;5;214m\\]\\w\\[\\e[0m\\]$ "',
      'cd /home/learner 2>/dev/null || true',
      config.envExports ?? '',
    ].join('\n') + '\n',
  );
  fs.writeFileSync('/etc/motd', config.motd ?? '');
  fs.writeFileSync('/home/learner/README.md', config.briefing ?? '# CipherForge lab\n');
  for (const [rel, content] of Object.entries(config.files ?? {})) {
    const target = path.join('/home/learner', rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  for (const secret of config.secretFiles ?? []) {
    const target = path.join('/home/learner', secret.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, secret.content, { mode: secret.mode ?? 0o600 });
    fs.chmodSync(target, secret.mode ?? 0o600);
  }

  fs.mkdirSync('/run/cf/logs', { recursive: true });
  fs.mkdirSync('/run/cfsock', { recursive: true });
  log('jail ready', config.hostname, 'uid', process.getuid?.(), 'files', fs.readdirSync('/home/learner').join(','));
  writeShared('phase.json', { phase: 'starting', at: new Date().toISOString() });

  // ------------------------------------------------------------ provisioner
  let provisionResult;
  // Derived, least-privilege runtime material. The session HMAC secret (used to
  // hash flags for storage) is deliberately absent from every long-lived process.
  const derive = (purpose, len = 48) => crypto.createHmac('sha256', config.sessionSecret).update(purpose).digest('hex').slice(0, len);
  const adminToken = derive('admin-token');
  const appSeed = derive('app-seed:' + config.labId, 64);

  // Environment shared with target apps, terminals and validators.
  const env = {
    PATH: '/opt/cf/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: '/home/learner',
    CF_SESSION_ID: config.sessionId,
    CF_LAB_ID: config.labId,
    CF_LAB_VERSION: config.labVersion,
    CF_HOSTNAME: config.hostname,
    CF_LAB_DIR: '/lab',
    CF_TARGET_URL: config.targetUrl ?? '',
    CF_WORKSPACE: '/home/learner',
    PYTHONPATH: '/opt/cf/py',
    TZ: 'UTC',
  };
  const provisionerEnv = { ...env, CF_SESSION_SECRET: config.sessionSecret, CF_APP_SEED: appSeed, CF_ADMIN_TOKEN: adminToken };
  if (config.provisioner) {
    log('running provisioner', config.provisioner);
    const prov = await spawnCapture(
      'node',
      ['/lab/' + config.provisioner],
      provisionerEnv,
      config.provisionTimeoutMs ?? 60000,
      'provisioner',
    );
    const line = prov.stdout
      .split('\n')
      .reverse()
      .find((l) => l.startsWith('CF_RESULT:'));
    if (prov.code !== 0 || !line) {
      throw new StartupError(
        'provisioning-failed',
        'lab provisioning script did not complete successfully',
        `exit=${prov.code}\n${prov.stdout.slice(-1500)}\n${prov.stderr.slice(-2500)}`,
      );
    }
    let result;
    try {
      result = JSON.parse(line.slice('CF_RESULT:'.length));
    } catch (err) {
      throw new StartupError('provisioning-failed', 'provisioner returned malformed result', String(err));
    }
    // The raw flags are handed to the runner once via a host-only directory
    // (never the shared mount) which hashes them immediately and deletes the file.
    provisionResult = result;
    // Host-only handoff: /run/cf is visible to the learner, so raw flags never
    // touch it. The runner reads this through the host directory and deletes it.
    writeHostOnly('provision-result.json', result);
    fs.writeFileSync('/home/learner/.lab-session.json', JSON.stringify({ sessionId: config.sessionId, lab: config.labId, startedAt: new Date().toISOString() }));
    log('provisioner ok; artifacts', fs.readdirSync('/home/learner').join(','));
  }

  writeShared('phase.json', { phase: 'starting-services', at: new Date().toISOString() });

  // --------------------------------------------------------------- services
  const servicePorts = new Map();
  for (const svc of config.services) {
    if (svc.role === 'workspace') continue;
    const port = svc.ports.find((p) => p.published)?.port ?? svc.ports[0]?.port;
    if (!port) throw new StartupError('invalid-template', `service ${svc.name} has no port`);
    const svcEnv = {
      ...env,
      PORT: String(port),
      CF_SERVICE: svc.name,
      CF_PUBLIC_URL: `http://127.0.0.1:${port}`,
      // Only the flags this specific service is supposed to reveal are passed,
      // along with the admin credential the learner already holds in ~/.lab.
      CF_ADMIN_TOKEN: adminToken,
      CF_APP_SEED: appSeed,
      CF_FLAGS_JSON: JSON.stringify(
        Object.fromEntries((svc.flagObjectives ?? []).map((id) => [id, provisionResult?.flags?.[id]]).filter(([, v]) => v)),
      ),
      ...(svc.env ?? {}),
    };
    const out = fs.openSync(`/run/cf/logs/${svc.name}.log`, 'a');
    const child = spawn('node', ['/lab/' + svc.app], { env: svcEnv, stdio: ['ignore', out, out], cwd: '/opt/cf' });
    child.on('exit', (code, signal) => {
      log('service exited', svc.name, 'code', code, 'signal', signal);
      if (!shuttingDown && code !== 0) {
        // A target crash after readiness is a real failure: tear down the session
        // so the platform never reports a dead lab as ready.
        writeShared('service-crash.json', { service: svc.name, code, signal, at: new Date().toISOString() });
        cleanup(4);
      }
    });
    children.push({ name: svc.name, child });
    servicePorts.set(svc.name, port);
    log('service started', svc.name, 'pid', child.pid, 'port', port);
  }

  // ------------------------------------------------------------ health checks
  const healthDeadline = Date.now() + (config.healthTimeoutMs ?? 30000);
  const health = [];
  for (const svc of config.services) {
    if (svc.role === 'workspace') continue;
    const port = servicePorts.get(svc.name);
    const h = svc.health ?? { kind: 'tcp' };
    let ok = false;
    let detail = '';
    while (Date.now() < healthDeadline) {
      if (h.kind === 'none') {
        ok = true;
        break;
      }
      if (h.kind === 'tcp') {
        ok = await tcpProbe(port);
        detail = ok ? `tcp ${port} reachable` : `tcp ${port} not reachable`;
      } else {
        const res = await httpProbe(`http://127.0.0.1:${port}${h.path ?? '/'}`, h.expectStatus ?? 200, h.expectBody, h.timeoutSeconds ?? 3);
        ok = res.ok;
        detail = res.detail;
      }
      if (ok) break;
      await sleep(400);
    }
    health.push({ service: svc.name, ok, detail });
    if (!ok) throw new StartupError('healthcheck-failed', `service ${svc.name} failed its health check`, detail);
    log('health ok', svc.name, detail);
  }
  writeShared('health.json', { ok: health.every((h) => h.ok), checks: health, at: new Date().toISOString() });

  // ------------------------------------------------------------ target bridges
  for (const svc of config.services) {
    if (svc.role === 'workspace') continue;
    for (const p of svc.ports.filter((x) => x.published)) {
      const sockPath = `/run/cfsock/pub-${p.name}.sock`;
      const server = net.createServer((client) => {
        const upstream = net.connect({ host: '127.0.0.1', port: p.port });
        client.on('error', () => upstream.destroy());
        upstream.on('error', () => client.destroy());
        client.pipe(upstream);
        upstream.pipe(client);
        client.on('close', () => upstream.destroy());
        upstream.on('close', () => client.destroy());
      });
      server.on('error', (err) => log('bridge error', p.name, err.message));
      await new Promise((resolve, reject) => {
        server.listen(sockPath, () => resolve());
        server.on('error', reject);
      });
      fs.chmodSync(sockPath, 0o600);
      bridges.push(server);
      sockets.push(server);
      log('target bridge ready', p.name, sockPath, '=>', p.port);
    }
  }

  // --------------------------------------------------------------- broker
  await startBroker(env);

  // -------------------------------------------------------------- watchdog
  startWatchdog();

  writeShared('phase.json', { phase: 'ready', at: new Date().toISOString() });
  log('SESSION READY', config.hostname);

  // Emergency kill switch: if the runner disappears, the session must not
  // linger forever. TTL is enforced independently here as well.
  const ttlMs = Math.max(60, config.ttlSeconds ?? 3600) * 1000;
  setTimeout(() => {
    log('ttl reached; shutting down');
    exitCode = 5;
    cleanup(5);
  }, ttlMs).unref?.();

  process.on('SIGTERM', () => {
    log('SIGTERM received');
    cleanup(0);
  });
  process.on('SIGINT', () => cleanup(0));
}

async function tcpProbe(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1500, () => done(false));
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
  });
}

async function httpProbe(url, expectStatus, expectBody, timeoutSeconds) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
    const res = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    clearTimeout(timer);
    const body = await res.text();
    if (res.status !== expectStatus) return { ok: false, detail: `expected HTTP ${expectStatus}, got ${res.status}` };
    if (expectBody && !body.includes(expectBody)) return { ok: false, detail: `response body missing expected marker` };
    return { ok: true, detail: `HTTP ${res.status} verified` };
  } catch (err) {
    return { ok: false, detail: `probe failed: ${err.message}` };
  }
}

function spawnCapture(cmd, args, env, timeoutMs, label) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], cwd: '/opt/cf' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
      if (stdout.length > 200_000) stdout = stdout.slice(-100_000);
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    const timer = setTimeout(() => {
      log(label, 'timed out; killing');
      try {
        child.kill('SIGKILL');
      } catch {}
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + err.message });
    });
  });
}

// --------------------------------------------------------------------- broker
function encode(msg) {
  return JSON.stringify(msg) + '\n';
}

async function startBroker(env) {
  const sockPath = '/run/cfsock/broker.sock';
  const server = net.createServer((socket) => {
    let buffer = '';
    let pty;
    let closed = false;
    const send = (msg) => {
      if (closed) return;
      try {
        socket.write(encode(msg));
      } catch {}
    };
    const closePty = () => {
      if (pty) {
        try {
          pty.kill('SIGHUP');
        } catch {}
        pty = undefined;
      }
    };
    socket.on('error', () => {});
    socket.on('close', () => {
      closed = true;
      closePty();
    });
    socket.on('data', async (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 4_000_000) {
        socket.destroy();
        return;
      }
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          send({ t: 'error', message: 'malformed control message' });
          continue;
        }
        if (msg.t === 'hello') {
          send({ t: 'welcome', session: config.sessionId, host: config.hostname });
        } else if (msg.t === 'pty') {
          if (pty) {
            send({ t: 'error', message: 'pty already open on this channel' });
            continue;
          }
          try {
            const ptyMod = await import(pathToFileURL('/opt/cf/node_modules/node-pty/lib/index.js').href);
            const spawnPty = ptyMod.spawn ?? ptyMod.default?.spawn;
            pty = spawnPty('/bin/bash', ['-l'], {
              name: 'xterm-256color',
              cols: clampInt(msg.cols, 20, 300, 100),
              rows: clampInt(msg.rows, 5, 120, 30),
              cwd: '/home/learner',
              env: {
                ...env,
                TERM: 'xterm-256color',
                HOME: '/home/learner',
                USER: 'learner',
                LOGNAME: 'learner',
                SHELL: '/bin/bash',
              },
            });
            pty.onData((data) => send({ t: 'data', d: Buffer.from(data, 'utf8').toString('base64') }));
            pty.onExit(({ exitCode }) => {
              send({ t: 'exit', code: exitCode });
              closePty();
              socket.end();
            });
            send({ t: 'ready' });
            touchActivity();
          } catch (err) {
            send({ t: 'error', message: `terminal backend unavailable: ${err.message}` });
            socket.end();
          }
        } else if (msg.t === 'input') {
          if (pty) {
            try {
              pty.write(Buffer.from(msg.d ?? '', 'base64').toString('utf8'));
              touchActivity();
            } catch {}
          }
        } else if (msg.t === 'resize') {
          if (pty) {
            try {
              pty.resize(clampInt(msg.cols, 20, 300, 100), clampInt(msg.rows, 5, 120, 30));
            } catch {}
          }
        } else if (msg.t === 'exec') {
          const file = String(msg.file ?? '');
          if (!/^[a-z0-9][a-z0-9-]*\/validators\/[a-z0-9-]+\.mjs$/.test(file)) {
            send({ t: 'error', message: 'exec target not permitted' });
            continue;
          }
          const child = spawn('node', ['/lab/' + file], {
            env: {
              ...env,
              CF_META: JSON.stringify(msg.meta ?? {}),
              CF_OBJECTIVE: String(msg.objectiveId ?? ''),
              CF_EVIDENCE: JSON.stringify(msg.evidence ?? {}),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd: '/home/learner',
          });
          let out = '';
          let errOut = '';
          let done = false;
          const timer = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {}
          }, clampInt(msg.timeoutMs, 1000, 60000, 30000));
          child.stdout.on('data', (d) => (out += d.toString()));
          child.stderr.on('data', (d) => (errOut += d.toString()));
          child.on('close', (code) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            touchActivity();
            let result;
            const line = out
              .split('\n')
              .reverse()
              .find((l) => l.startsWith('CF_VALIDATOR:'));
            if (line) {
              try {
                result = JSON.parse(line.slice('CF_VALIDATOR:'.length));
              } catch {}
            }
            send({
              t: 'exec-result',
              code,
              result: result ?? null,
              stdout: out.slice(-4000),
              stderr: errOut.slice(-4000),
            });
          });
        } else if (msg.t === 'ping') {
          send({ t: 'pong' });
        }
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.listen(sockPath, () => resolve());
    server.on('error', reject);
  });
  fs.chmodSync(sockPath, 0o600);
  sockets.push(server);
  log('broker ready', sockPath);
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

let lastActivity = Date.now();
function touchActivity() {
  lastActivity = Date.now();
  try {
    fs.writeFileSync('/run/cf/activity', String(lastActivity));
  } catch {}
}

// --------------------------------------------------------------------- watchdog
function startWatchdog() {
  const memLimitBytes = config.resources.memoryMb * 1024 * 1024;
  const pidLimit = config.resources.pids;
  const idleMs = Math.max(30, config.resources.idleTimeoutMinutes ?? 20) * 60_000;
  let strikes = 0;
  setInterval(() => {
    if (shuttingDown) return;
    let count = 0;
    let rss = 0;
    let cpuTicks = 0;
    let procs = 0;
    try {
      for (const dir of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(dir)) continue;
        const pid = Number(dir);
        if (pid === 1 || pid === process.pid) continue;
        try {
          const statm = fs.readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ');
          rss += Number(statm[1] ?? 0) * 4096;
          count += 1;
          const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
          const parts = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
          cpuTicks += Number(parts[11] ?? 0) + Number(parts[12] ?? 0);
          procs += 1;
        } catch {}
      }
    } catch {}
    if (rss > memLimitBytes) {
      strikes += 1;
      log('memory limit exceeded', Math.round(rss / 1024 / 1024), 'MB of', config.resources.memoryMb, 'strike', strikes);
      if (strikes >= 2) {
        writeShared('oom.json', { at: new Date().toISOString(), rssMb: Math.round(rss / 1024 / 1024) });
        killAllUserProcesses();
        exitCode = 3;
        cleanup(3);
      }
    } else strikes = 0;
    if (procs > pidLimit) {
      log('pid limit exceeded', procs, '>', pidLimit);
      killAllUserProcesses();
      writeShared('pid-limit.json', { at: new Date().toISOString(), procs });
      exitCode = 3;
      cleanup(3);
    }
    try {
      fs.writeFileSync(
        '/run/cf/metrics.json',
        JSON.stringify({ processes: count, rssMb: Math.round(rss / 1024 / 1024), cpuTicks, at: new Date().toISOString() }),
      );
    } catch {}
    const last = Math.max(lastActivity, statActivity());
    if (Date.now() - last > idleMs) {
      log('idle timeout reached', Math.round((Date.now() - last) / 1000), 's');
      exitCode = 6;
      cleanup(6);
    }
  }, 2000).unref?.();
}

function statActivity() {
  try {
    return fs.statSync('/run/cf/activity').mtimeMs;
  } catch {
    return lastActivity;
  }
}

function killAllUserProcesses() {
  for (const entry of children) {
    try {
      entry.child.kill('SIGKILL');
    } catch {}
  }
  try {
    for (const dir of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(dir)) continue;
      const pid = Number(dir);
      if (pid === 1 || pid === process.pid) continue;
      process.kill(pid, 'SIGKILL');
    }
  } catch {}
}

function cleanup(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    writeShared('phase.json', { phase: 'stopping', at: new Date().toISOString(), exitCode: code });
  } catch {}
  for (const entry of children) {
    try {
      entry.child.kill('SIGTERM');
      setTimeout(() => {
        try {
          entry.child.kill('SIGKILL');
        } catch {}
      }, 1200).unref?.();
    } catch {}
  }
  killAllUserProcesses();
  for (const server of sockets) {
    try {
      server.close();
    } catch {}
  }
  for (const server of bridges) {
    try {
      server.close();
    } catch {}
  }
  setTimeout(() => process.exit(code ?? 0), 300).unref?.();
}

main().catch((err) => fail(err instanceof StartupError ? err : new StartupError('internal-error', err.message, String(err.stack ?? ''))));

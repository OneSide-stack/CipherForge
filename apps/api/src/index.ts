import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { createApp } from './app.js';
import { config } from './config.js';
import { log } from './lib/logger.js';
import { ping, query } from './db/index.js';
import { reapExpiredSessions } from './services/sessions.js';
import { terminalRunnerUrl, runner } from './services/runner-client.js';

const app = createApp();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function originAllowed(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients still need a valid session cookie
  try {
    const originHost = new URL(origin).host;
    const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0]?.trim();
    return originHost === host;
  } catch {
    return false;
  }
}

server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const match = /^\/ws\/terminal\/([0-9a-f-]{20,40})$/.exec(url.pathname);
  const reject = (status: number, message: string) => {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nconnection: close\r\n\r\n`);
    socket.destroy();
  };
  if (!match) return reject(404, 'Not Found');
  if (!originAllowed(req)) return reject(403, 'Forbidden');
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.cf_session;
  if (!token) return reject(401, 'Unauthorized');
  const crypto = await import('node:crypto');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const row = await query<{ user_id: string; expires_at: Date; revoked_at: Date | null; disabled: boolean; status: string }>(
    `SELECT s.user_id, s.expires_at, s.revoked_at, u.disabled, u.status
     FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1`,
    [tokenHash],
  ).catch(() => null);
  const auth = row?.rows[0];
  if (!auth || auth.revoked_at || new Date(auth.expires_at) < new Date() || auth.disabled || auth.status !== 'active') {
    return reject(401, 'Unauthorized');
  }
  const sessionId = match[1]!;
  const session = await query<{ user_id: string; state: string }>('SELECT user_id, state FROM lab_sessions WHERE id = $1', [sessionId]).catch(() => null);
  const sess = session?.rows[0];
  if (!sess) return reject(404, 'Not Found');
  if (sess.user_id !== auth.user_id) return reject(403, 'Forbidden');
  if (sess.state !== 'ready') return reject(409, 'Lab Not Ready');

  wss.handleUpgrade(req, socket, head, (client) => {
    const upstream = new WebSocket(terminalRunnerUrl(sessionId, auth.user_id), { maxPayload: 256 * 1024 });
    let ready = false;
    const pending: string[] = [];
    const closeBoth = (code = 1000, reason = '') => {
      try {
        if (client.readyState === WebSocket.OPEN) client.close(code, reason.slice(0, 120));
      } catch {}
      try {
        upstream.close();
      } catch {}
    };
    upstream.on('open', () => {
      ready = true;
      for (const msg of pending.splice(0)) upstream.send(msg);
    });
    upstream.on('message', (data) => {
      if (client.readyState === WebSocket.OPEN) client.send(data.toString());
    });
    upstream.on('close', (_code, reason) => closeBoth(1000, reason?.toString()));
    upstream.on('error', () => closeBoth(1011, 'lab worker terminal unavailable'));
    client.on('message', (raw) => {
      const text = raw.toString();
      if (text.length > 64 * 1024) return;
      try {
        const msg = JSON.parse(text);
        if (!['input', 'resize', 'ping'].includes(msg.type)) return;
      } catch {
        return;
      }
      if (ready && upstream.readyState === WebSocket.OPEN) upstream.send(text);
      else if (pending.length < 100) pending.push(text);
    });
    client.on('close', () => {
      try {
        upstream.close();
      } catch {}
    });
    client.on('error', () => {
      try {
        upstream.close();
      } catch {}
    });
    // Keep intermediaries from closing an idle terminal.
    const ping = setInterval(() => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.ping();
        } catch {}
      }
    }, 25_000);
    client.on('close', () => clearInterval(ping));
  });
});

async function main() {
  const dbOk = await ping();
  if (!dbOk) {
    console.error('FATAL: cannot connect to PostgreSQL at the configured DATABASE_URL');
    process.exit(1);
  }
  server.listen(config.port, config.bind, () => {
    log.info('api listening', { port: config.port, bind: config.bind, env: config.env, runner: config.runnerUrl });
  });
  setInterval(() => {
    void reapExpiredSessions().catch((err) => log.warn('expiry sweep failed', { error: (err as Error).message }));
  }, 60_000).unref();
  setInterval(() => {
    void runner
      .health()
      .then((h) => log.info('lab worker heartbeat', { mode: h.mode, ok: h.ok, active: h.capacity.activeSessions, max: h.capacity.maxSessions }))
      .catch((err) => log.warn('lab worker heartbeat failed', { error: (err as Error).message }));
  }, 120_000).unref();
}

process.on('SIGTERM', () => {
  log.info('api shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
});

main().catch((err) => {
  console.error('api failed to start:', err);
  process.exit(1);
});

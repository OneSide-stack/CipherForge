import http from 'node:http';
import net from 'node:net';
import { z } from 'zod';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { config } from './config.js';
import { log, sanitize } from './logger.js';
import { requireApiAuth, verifyWsAuth } from './auth.js';
import { LabManager } from './manager.js';

const manager = new LabManager();
const app = express();
app.disable('x-powered-by');
// The target proxy needs the untouched request body (the lab may accept forms).
app.use(
  express.json({
    limit: '512kb',
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);
app.use(
  express.urlencoded({
    extended: false,
    limit: '256kb',
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);

app.get('/livez', (_req, res) => res.json({ ok: true, svc: 'lab-runner', version: config.version }));

app.use('/sessions', requireApiAuth);
app.use('/admin', requireApiAuth);
app.use('/health', requireApiAuth);

app.get('/health', async (_req, res) => {
  const health = await manager.health();
  res.status(health.ok ? 200 : 503).json(health);
});

const startSchema = z.object({
  sessionId: z.string().uuid(),
  userId: z.string().uuid(),
  labId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
  labVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  templateChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  sessionSecret: z.string().min(32).max(128),
  ttlSeconds: z.number().int().min(60).max(24 * 3600),
  requestId: z.string().min(8).max(64),
});

app.post('/sessions', async (req, res, next) => {
  try {
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'validation', issues: parsed.error.issues.map((i) => i.path.join('.') + ': ' + i.message) });
    const session = await manager.start(parsed.data);
    res.status(201).json(session);
  } catch (err) {
    next(err);
  }
});

app.get('/sessions/:id', async (req, res, next) => {
  try {
    const consume = req.query.consume === '1';
    res.json(await manager.poll(req.params.id, consume));
  } catch (err) {
    next(err);
  }
});

app.post('/sessions/:id/stop', async (req, res, next) => {
  try {
    const reason = req.body?.reason === 'expired' ? 'expired' : 'stopped';
    res.json(await manager.stop(req.params.id, reason));
  } catch (err) {
    next(err);
  }
});

app.post('/sessions/:id/reset', async (req, res, next) => {
  try {
    res.json(await manager.reset(req.params.id));
  } catch (err) {
    next(err);
  }
});

app.post('/sessions/:id/extend', async (req, res, next) => {
  try {
    const parsed = z.object({ ttlSeconds: z.number().int().min(60).max(24 * 3600) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'validation', issues: parsed.error.issues.map((i) => i.message) });
    res.json(await manager.extend(req.params.id, parsed.data.ttlSeconds));
  } catch (err) {
    next(err);
  }
});

app.post('/sessions/:id/validate', async (req, res, next) => {
  try {
    const parsed = z
      .object({
        userId: z.string().uuid(),
        objectiveId: z.string().regex(/^[a-z0-9-]{2,40}$/),
        validator: z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/),
        evidence: z.record(z.unknown()).optional(),
        timeoutMs: z.number().int().min(1000).max(60000).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'validation', issues: parsed.error.issues.map((i) => i.message) });
    const { result } = await manager.validate(req.params.id, parsed.data.userId, {
      objectiveId: parsed.data.objectiveId,
      validator: parsed.data.validator,
      meta: {},
      evidence: parsed.data.evidence ?? {},
      timeoutMs: parsed.data.timeoutMs,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.get('/sessions/:id/logs', async (req, res, next) => {
  try {
    const logs = await manager.collectLogs(req.params.id);
    res.json({ logs });
  } catch (err) {
    next(err);
  }
});

app.get('/sessions/:id/metrics', async (req, res, next) => {
  try {
    const session = manager.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'not-found' });
    const health = await manager.poll(req.params.id, false);
    res.json({ metrics: health.metrics ?? null, state: health.state });
  } catch (err) {
    next(err);
  }
});

app.get('/admin/sessions', (_req, res) => {
  res.json({ sessions: manager.listManaged ? manager.listManaged() : [] });
});

app.post('/admin/cleanup-orphans', async (_req, res, next) => {
  try {
    const state = await manager.health();
    res.json({ ok: true, ...state.capacity });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- target proxy
function hopByHop(name: string): boolean {
  return ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'].includes(
    name.toLowerCase(),
  );
}

function stripFrameHeaders(headers: Record<string, string | string[] | undefined>) {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || hopByHop(k)) continue;
    const lower = k.toLowerCase();
    if (lower === 'x-frame-options' || lower === 'content-security-policy') continue;
    if (lower === 'set-cookie') {
      const arr = Array.isArray(v) ? v : [v];
      out[k] = arr.map((c) => c.replace(/;\s*domain=[^;]+/gi, '').replace(/;\s*(samesite|secure)=/gi, (m) => m));
      continue;
    }
    out[k] = v;
  }
  return out;
}

app.all('/sessions/:id/target/:name/*', async (req, res, next) => {
  try {
    const upstream = await manager.targetUpstream(req.params.id, req.params.name);
    const wildcard = (req.params as Record<string, string>)[0] ?? '';
    const suffix = wildcard ? `/${wildcard}` : '/';
    const search = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    const upstreamPath = suffix + search;
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || hopByHop(k)) continue;
      if (k.toLowerCase() === 'host') continue;
      if (k.toLowerCase().startsWith('x-cf-')) continue;
      headers[k] = v;
    }
    headers.host = 'target.lab';
    if (typeof headers.cookie === 'string') {
      const cookies = headers.cookie
        .split(';')
        .map((c) => c.trim())
        .filter((c) => c && !c.startsWith('cf_session=') && !c.startsWith('cf_csrf='));
      if (cookies.length) headers.cookie = cookies.join('; ');
      else delete headers.cookie;
    }
    manager.noteActivity(req.params.id);

    const clientReq = http.request(
      {
        method: req.method,
        path: upstreamPath,
        headers,
        socketPath: upstream.kind === 'unix' ? upstream.socketPath : undefined,
        host: upstream.kind === 'tcp' ? upstream.host : undefined,
        port: upstream.kind === 'tcp' ? upstream.port : undefined,
        timeout: 20_000,
      },
      (upstreamRes) => {
        res.status(upstreamRes.statusCode ?? 502);
        const clean = stripFrameHeaders(upstreamRes.headers);
        for (const [k, v] of Object.entries(clean)) res.setHeader(k, v);
        const location = upstreamRes.headers.location;
        if (typeof location === 'string' && location.startsWith('/')) {
          res.setHeader('location', `/sessions/${req.params.id}/target/${req.params.name}${location}`);
        }
        upstreamRes.pipe(res);
      },
    );
    clientReq.on('timeout', () => clientReq.destroy(new Error('target timeout')));
    clientReq.on('error', (err) => {
      log.warn('target proxy failed', { sessionId: req.params.id, error: err.message });
      if (!res.headersSent) res.status(502).json({ error: 'target_unreachable', message: 'The lab target did not respond.' });
      else res.end();
    });
    const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody;
    if (['GET', 'HEAD'].includes(req.method)) clientReq.end();
    else if (rawBody) {
      headers['content-length'] = String(rawBody.length);
      clientReq.setHeader('content-length', String(rawBody.length));
      clientReq.end(rawBody);
    } else req.pipe(clientReq);
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------------- errors
app.use((err: Error & { status?: number; code?: string; detail?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err.status && err.status >= 400 ? err.status : 500;
  if (status >= 500) log.error('runner request failed', { error: err.message });
  res.status(status).json({
    error: err.code ?? (status === 404 ? 'not-found' : status === 429 ? 'rate-limited' : 'internal-error'),
    message: sanitize(err.message, 400),
    detail: err.detail ? sanitize(err.detail, 1200) : undefined,
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });

server.on('upgrade', async (req, socket: net.Socket, head) => {
  const url = new URL(req.url ?? '/', 'http://runner.local');
  const match = /^\/sessions\/([0-9a-f-]{20,40})\/terminal$/.exec(url.pathname);
  if (!match) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  const authError = verifyWsAuth(req, url);
  if (authError) {
    socket.write(`HTTP/1.1 401 Unauthorized\r\n\r\n`);
    socket.destroy();
    return;
  }
  const sessionId = match[1]!;
  const userId = url.searchParams.get('userId') ?? '';
  const cols = Number(url.searchParams.get('cols') ?? 100);
  const rows = Number(url.searchParams.get('rows') ?? 30);
  let channel;
  try {
    channel = await manager.terminal(sessionId, userId, cols, rows);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    socket.write(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : status === 409 ? 'Conflict' : 'Error'}\r\n\r\n`);
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    log.info('terminal attached', { sessionId, userId: userId.slice(0, 8) });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      try {
        channel.close();
      } catch {}
      try {
        ws.close();
      } catch {}
    };
    ws.send(JSON.stringify({ type: 'ready', sessionId }));
    channel.onData((chunk) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'output', data: chunk.toString('base64') }));
    });
    channel.onExit((code) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'exit', code }));
      close();
    });
    channel.onError((err) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', message: sanitize(err.message, 200) }));
    });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'input' && typeof msg.data === 'string') {
          channel.write(Buffer.from(msg.data, 'base64'));
          manager.noteActivity(sessionId);
        } else if (msg.type === 'resize' && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
          channel.resize(Number(msg.cols), Number(msg.rows));
        } else if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch {
        /* ignore malformed frames */
      }
    });
    ws.on('close', () => {
      log.info('terminal detached', { sessionId });
      close();
    });
    ws.on('error', () => close());
  });
});

async function main() {
  if (!config.secret || config.secret.length < 32) {
    console.error('FATAL: CF_RUNNER_SECRET must be set to a random value of at least 32 characters.');
    process.exit(1);
  }
  await manager.init();
  server.listen(config.port, config.host, () => {
    log.info('lab-runner listening', { port: config.port, bind: config.host, driver: config.driver, labsDir: config.labsDir });
  });
}

process.on('SIGTERM', () => {
  log.info('runner shutting down');
  server.close();
  process.exit(0);
});

main().catch((err) => {
  console.error('lab-runner failed to start:', err.message);
  process.exit(1);
});

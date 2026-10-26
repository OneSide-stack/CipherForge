import http from 'node:http';
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import type { RunnerHealth, ValidatorResult } from '@cipherforge/shared';
import { config } from '../config.js';
import { ApiError, unavailable } from '../lib/errors.js';

interface RunnerSessionResponse {
  id: string;
  state: string;
  detail: string;
  targets: { name: string; port: number; protocol: string; path: string }[];
  failure?: { code: string; message: string; detail?: string };
  events?: { at: string; state: string; level: 'info' | 'warn' | 'error'; message: string }[];
  expiresAt?: string;
  provision?: { flags: Record<string, string>; meta: Record<string, unknown> };
  readyAt?: string;
}

function sign(method: string, path: string): { ts: string; nonce: string; sig: string } {
  const ts = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  // The runner authenticates the path only; query parameters are not signed.
  const signedPath = path.split('?')[0] ?? path;
  const sig = crypto.createHmac('sha256', config.runnerSecret).update(`${method}\n${signedPath}\n${ts}\n${nonce}`).digest('hex');
  return { ts, nonce, sig };
}

function headersFor(method: string, path: string, json = true): Record<string, string> {
  const { ts, nonce, sig } = sign(method, path);
  return {
    ...(json ? { 'content-type': 'application/json' } : {}),
    'x-cf-timestamp': ts,
    'x-cf-nonce': nonce,
    'x-cf-signature': sig,
  };
}

async function runnerFetch<T>(method: string, path: string, body?: unknown, timeoutMs = 120_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.runnerUrl}${path}`, {
      method,
      headers: headersFor(method, path),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const err = json as { error?: string; message?: string; detail?: string } | undefined;
      throw new ApiError(res.status, err?.error ?? 'runner_error', err?.message ?? 'Lab worker request failed', err?.detail);
    }
    return json as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const e = err as Error;
    if (e.name === 'AbortError') throw new ApiError(504, 'runner_timeout', 'The lab worker did not respond in time.');
    throw unavailable(`Lab worker unavailable: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

export const runner = {
  health: () => runnerFetch<RunnerHealth>('GET', '/health', undefined, 8000),
  startSession: (payload: Record<string, unknown>) => runnerFetch<RunnerSessionResponse>('POST', '/sessions', payload),
  getSession: (id: string, consume = false) => runnerFetch<RunnerSessionResponse>('GET', `/sessions/${id}${consume ? '?consume=1' : ''}`, undefined, 10_000),
  stopSession: (id: string, reason = 'stopped') => runnerFetch<RunnerSessionResponse>('POST', `/sessions/${id}/stop`, { reason }),
  resetSession: (id: string) => runnerFetch<RunnerSessionResponse>('POST', `/sessions/${id}/reset`, {}),
  extendSession: (id: string, ttlSeconds: number) => runnerFetch<RunnerSessionResponse>('POST', `/sessions/${id}/extend`, { ttlSeconds }),
  validate: (id: string, payload: { userId: string; objectiveId: string; validator: string; evidence?: Record<string, unknown> }) =>
    runnerFetch<ValidatorResult>('POST', `/sessions/${id}/validate`, payload, 60_000),
  logs: (id: string) => runnerFetch<{ logs: string }>('GET', `/sessions/${id}/logs`, undefined, 10_000),
};

/** Authenticated byte-level proxy from the platform to a session target. */
export async function proxyTarget(req: Request, res: Response, sessionId: string, targetName: string, suffix: string): Promise<void> {
  const search = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  const runnerPath = `/sessions/${sessionId}/target/${encodeURIComponent(targetName)}${suffix.startsWith('/') ? '' : '/'}${suffix}${search}`;
  const { ts, nonce, sig } = sign(req.method === 'HEAD' ? 'GET' : req.method, runnerPath);
  const headers: Record<string, string | string[]> = {
    'x-cf-timestamp': ts,
    'x-cf-nonce': nonce,
    'x-cf-signature': sig,
    host: 'lab.local',
  };
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    const lower = k.toLowerCase();
    if (['host', 'connection', 'content-length', 'x-csrf-token', 'cookie'].includes(lower)) continue;
    if (lower.startsWith('x-cf-')) continue;
    headers[k] = v;
  }
  if (req.headers.cookie) {
    const filtered = req.headers.cookie
      .split(';')
      .map((c) => c.trim())
      .filter((c) => c && !c.startsWith('cf_session=') && !c.startsWith('cf_csrf='));
    if (filtered.length) headers.cookie = filtered.join('; ');
  }

  await new Promise<void>((resolve, reject) => {
    const upstream = http.request(
      { host: '127.0.0.1', port: new URL(config.runnerUrl).port || 80, path: runnerPath, method: req.method, headers, timeout: 25_000 },
      (upstreamRes) => {
        res.status(upstreamRes.statusCode ?? 502);
        for (const [k, v] of Object.entries(upstreamRes.headers)) {
          if (v === undefined) continue;
          const lower = k.toLowerCase();
          if (['connection', 'transfer-encoding', 'content-length', 'content-security-policy', 'x-frame-options'].includes(lower)) continue;
          if (lower === 'location' && typeof v === 'string' && v.startsWith('/')) {
            // The runner rewrites target redirects to /sessions/<id>/target/<name>/...
            // The API serves the gateway under /api, so re-prefix those paths.
            const gateway = `${req.baseUrl}${req.originalUrl.split('?')[0]?.split('/target/')[0] ?? ''}/target/${encodeURIComponent(targetName)}`;
            res.setHeader('location', v.startsWith('/sessions/') ? `/api${v}` : `${gateway}/${v.replace(/^\/+/, '')}`);
            continue;
          }
          if (lower === 'set-cookie') {
            const scope = `${req.baseUrl}${req.originalUrl.split('?')[0]?.split('/target/')[0] ?? ''}/target/${encodeURIComponent(targetName)}/`;
            const cookies = (Array.isArray(v) ? v : [v]).map((cookie) => cookie.replace(/;\s*path=\/[^;]*/i, `; Path=${scope}`));
            res.setHeader('set-cookie', cookies);
            continue;
          }
          res.setHeader(k, v);
        }
        res.setHeader('cache-control', 'no-store');
        const contentType = String(upstreamRes.headers['content-type'] ?? '');
        if (contentType.includes('text/html')) {
          let body = '';
          upstreamRes.on('data', (chunk) => (body += chunk.toString()));
          upstreamRes.on('end', () => {
            const base = `${req.baseUrl.replace(/\/$/, '')}/`;
            const injected = body.replace(/<head([^>]*)>/i, `<head$1><base href="${base}">`);
            res.end(injected);
            resolve();
          });
        } else {
          upstreamRes.pipe(res);
          upstreamRes.on('end', resolve);
        }
      },
    );
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', (err) => {
      if (!res.headersSent) res.status(502).json({ error: 'target_unreachable', message: 'The lab target did not respond.', detail: err.message });
      else res.end();
      resolve();
    });
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (['GET', 'HEAD'].includes(req.method)) upstream.end();
    else if (rawBody) {
      headers['content-length'] = String(rawBody.length);
      upstream.setHeader('content-length', String(rawBody.length));
      upstream.end(rawBody);
    } else req.pipe(upstream);
  });
}

export function terminalRunnerUrl(sessionId: string, userId: string) {
  const path = `/sessions/${sessionId}/terminal`;
  const { ts, nonce, sig } = sign('GET', path);
  const url = new URL(config.runnerUrl);
  url.protocol = 'ws:';
  url.pathname = path;
  url.searchParams.set('ts', ts);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('sig', sig);
  url.searchParams.set('userId', userId);
  return url.toString();
}

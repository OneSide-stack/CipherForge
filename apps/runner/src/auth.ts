import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';
import { log } from './logger.js';

const seenNonces = new Map<string, number>();
const MAX_SKEW_MS = 60_000;

setInterval(() => {
  const cutoff = Date.now() - MAX_SKEW_MS * 2;
  for (const [nonce, at] of seenNonces) if (at < cutoff) seenNonces.delete(nonce);
}, 30_000).unref();

export function signRequest(method: string, path: string, timestamp: string, nonce: string): string {
  return crypto
    .createHmac('sha256', config.secret)
    .update(`${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}`)
    .digest('hex');
}

export function verifySignature(method: string, path: string, timestamp: string, nonce: string, signature: string): string | null {
  if (!config.secret) return 'runner secret is not configured';
  if (!timestamp || !nonce || !signature) return 'missing authentication headers';
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_SKEW_MS) return 'stale or invalid timestamp';
  if (seenNonces.has(nonce)) return 'replayed request nonce';
  const expected = signRequest(method, path, timestamp, nonce);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return 'invalid request signature';
  seenNonces.set(nonce, Date.now());
  return null;
}

export function requireApiAuth(req: Request, res: Response, next: NextFunction) {
  const path = req.originalUrl.split('?')[0] ?? req.path;
  const error = verifySignature(
    req.method,
    path,
    String(req.header('x-cf-timestamp') ?? ''),
    String(req.header('x-cf-nonce') ?? ''),
    String(req.header('x-cf-signature') ?? ''),
  );
  if (error) {
    log.warn('rejected runner request', { path, error });
    res.status(401).json({ error: 'unauthorized', message: error });
    return;
  }
  next();
}

export function verifyWsAuth(req: import('node:http').IncomingMessage, url: URL): string | null {
  return verifySignature(
    'GET',
    url.pathname,
    String(url.searchParams.get('ts') ?? ''),
    String(url.searchParams.get('nonce') ?? ''),
    String(url.searchParams.get('sig') ?? ''),
  );
}

export function signQuery(path: string): string {
  const ts = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  const sig = signRequest('GET', path, ts, nonce);
  return `ts=${encodeURIComponent(ts)}&nonce=${nonce}&sig=${sig}`;
}

export function newNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function signBody(method: string, path: string): Record<string, string> {
  const ts = String(Date.now());
  const nonce = newNonce();
  return {
    'content-type': 'application/json',
    'x-cf-timestamp': ts,
    'x-cf-nonce': nonce,
    'x-cf-signature': signRequest(method, path, ts, nonce),
  };
}

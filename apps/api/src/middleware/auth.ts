import type { NextFunction, Request, Response } from 'express';
import { one, query } from '../db/index.js';
import { config } from '../config.js';
import { randomToken, sha256, timingSafeEqualStr } from '../lib/crypto.js';
import { forbidden, unauthorized } from '../lib/errors.js';

export interface AuthUser {
  id: string;
  email: string;
  username: string;
  role: 'learner' | 'admin';
  xp: number;
  status: string;
  disabled: boolean;
}

export interface AuthContext {
  user: AuthUser;
  sessionId: string;
  csrfHash: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

const lastSeenCache = new Map<string, number>();

export function cookieOptions(maxAgeMs: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.cookieSecure,
    path: '/',
    maxAge: maxAgeMs,
  };
}

export function csrfCookieOptions(maxAgeMs: number) {
  return { ...cookieOptions(maxAgeMs), httpOnly: false };
}

export async function createAuthSession(userId: string, ip: string | undefined, userAgent: string | undefined) {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600_000);
  await query(
    `INSERT INTO auth_sessions (user_id, token_hash, csrf_hash, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, sha256(token), sha256(csrfToken), ip ?? null, (userAgent ?? '').slice(0, 300), expiresAt],
  );
  return { token, csrfToken, expiresAt };
}

export function setAuthCookies(res: Response, token: string, csrfToken: string, expiresAt: Date) {
  const maxAge = Math.max(0, expiresAt.getTime() - Date.now());
  res.cookie('cf_session', token, cookieOptions(maxAge));
  res.cookie('cf_csrf', csrfToken, csrfCookieOptions(maxAge));
  res.setHeader('x-csrf-token', csrfToken);
}

export function clearAuthCookies(res: Response) {
  res.clearCookie('cf_session', { path: '/' });
  res.clearCookie('cf_csrf', { path: '/' });
}

export async function loadAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.cf_session as string | undefined;
    if (!token) return next();
    const row = await one<{
      session_id: string;
      csrf_hash: string;
      expires_at: Date;
      revoked_at: Date | null;
      user_id: string;
      email: string;
      username: string;
      role: 'learner' | 'admin';
      xp: number;
      status: string;
      disabled: boolean;
    }>(
      `SELECT s.id AS session_id, s.csrf_hash, s.expires_at, s.revoked_at, u.id AS user_id, u.email, u.username, u.role, u.xp, u.status, u.disabled
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1`,
      [sha256(token)],
    );
    if (!row || row.revoked_at || new Date(row.expires_at) < new Date() || row.disabled || row.status !== 'active') return next();
    req.auth = {
      sessionId: row.session_id,
      csrfHash: row.csrf_hash,
      user: {
        id: row.user_id,
        email: row.email,
        username: row.username,
        role: row.role,
        xp: row.xp,
        status: row.status,
        disabled: row.disabled,
      },
    };
    const now = Date.now();
    if (!lastSeenCache.has(row.session_id) || now - (lastSeenCache.get(row.session_id) ?? 0) > 60_000) {
      lastSeenCache.set(row.session_id, now);
      void query('UPDATE auth_sessions SET last_seen_at = now() WHERE id = $1', [row.session_id]).catch(() => {});
      void query('UPDATE users SET last_seen_at = now() WHERE id = $1', [row.user_id]).catch(() => {});
    }
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) return next(unauthorized('Sign in to access this resource'));
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) return next(unauthorized());
  if (req.auth.user.role !== 'admin') return next(forbidden('Administrator role required'));
  next();
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Reject cross-site state changes (defence in depth alongside SameSite=Lax). */
export function originGuard(req: Request, _res: Response, next: NextFunction) {
  if (!MUTATING.has(req.method)) return next();
  const origin = req.headers.origin;
  if (origin) {
    try {
      const originHost = new URL(origin).host;
      const host = req.headers['x-forwarded-host'] ?? req.headers.host;
      const allowed = String(host).split(',')[0]?.trim();
      if (originHost !== allowed) {
        if (config.frontendOrigin && origin === config.frontendOrigin) return next();
        return next(forbidden('Cross-origin request rejected'));
      }
    } catch {
      return next(forbidden('Invalid origin header'));
    }
  }
  next();
}

/** Double-submit CSRF validation for authenticated mutations. */
export function csrfProtection(req: Request, _res: Response, next: NextFunction) {
  if (!MUTATING.has(req.method)) return next();
  if (!req.auth) return next();
  const token = req.headers['x-csrf-token'];
  const cookieToken = req.cookies?.cf_csrf;
  if (typeof token !== 'string' || !timingSafeEqualStr(sha256(token), req.auth.csrfHash)) {
    return next(forbidden('Missing or invalid CSRF token'));
  }
  if (typeof cookieToken === 'string' && !timingSafeEqualStr(token, cookieToken)) {
    return next(forbidden('CSRF token mismatch'));
  }
  next();
}

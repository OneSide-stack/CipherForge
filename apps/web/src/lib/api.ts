import type { ApiErrorShape } from './types';

export class ApiError extends Error {
  status: number;
  code: string;
  detail?: string;
  constructor(status: number, body: ApiErrorShape | null, fallback: string) {
    super(body?.message || fallback);
    this.status = status;
    this.code = body?.error ?? 'request-failed';
    this.detail = body?.detail;
  }
}

function readCookie(name: string): string | undefined {
  return document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

let csrfFromHeader: string | null = null;

export function csrfToken(): string | undefined {
  return csrfFromHeader ?? readCookie('cf_csrf');
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const csrf = csrfToken();
  if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  const headerToken = res.headers.get('x-csrf-token');
  if (headerToken) csrfFromHeader = headerToken;
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    if (res.status === 401) onUnauthorized?.();
    throw new ApiError(res.status, (json as ApiErrorShape) ?? null, `Request failed (${res.status})`);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  del: <T>(path: string) => request<T>('DELETE', path),
};

export function apiUrl(path: string): string {
  return path;
}

export function terminalUrl(sessionId: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws/terminal/${sessionId}`;
}

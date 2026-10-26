const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type Level = (typeof LEVELS)[number];
const threshold = (process.env.CF_LOG_LEVEL ?? 'info') as Level;

function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/CF\{[a-f0-9]{16,}\}/gi, 'CF{redacted}')
      .replace(/(password|secret|token|authorization)(["']?\s*[:=]\s*["']?)([^\s,"'}]+)/gi, '$1$2[redacted]');
  }
  return value;
}

function emit(level: Level, msg: string, meta: Record<string, unknown> = {}) {
  if (LEVELS.indexOf(level) < LEVELS.indexOf(threshold)) return;
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    safe[k] = /pass|secret|token|flag/i.test(k) ? '[redacted]' : redact(v);
  }
  const line = JSON.stringify({ at: new Date().toISOString(), level, svc: 'api', msg, ...safe });
  (level === 'error' ? console.error : console.log)(line);
}

export const log = {
  debug: (m: string, meta?: Record<string, unknown>) => emit('debug', m, meta),
  info: (m: string, meta?: Record<string, unknown>) => emit('info', m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => emit('warn', m, meta),
  error: (m: string, meta?: Record<string, unknown>) => emit('error', m, meta),
};

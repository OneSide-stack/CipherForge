const levels = ['debug', 'info', 'warn', 'error'] as const;
type Level = (typeof levels)[number];
const threshold = (process.env.CF_LOG_LEVEL ?? 'info') as Level;

function emit(level: Level, msg: string, meta?: Record<string, unknown>) {
  if (levels.indexOf(level) < levels.indexOf(threshold)) return;
  const line = JSON.stringify({ at: new Date().toISOString(), level, svc: 'lab-runner', msg, ...(meta ?? {}) });
  (level === 'error' ? console.error : console.log)(line);
}

export const log = {
  debug: (m: string, meta?: Record<string, unknown>) => emit('debug', m, meta),
  info: (m: string, meta?: Record<string, unknown>) => emit('info', m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => emit('warn', m, meta),
  error: (m: string, meta?: Record<string, unknown>) => emit('error', m, meta),
};

/** Redacts secrets and raw flags from anything that may reach logs or the UI. */
export function sanitize(input: string, maxLength = 2000): string {
  return String(input ?? '')
    .replace(/CF\{[a-f0-9]{16,}\}/gi, 'CF{redacted}')
    .replace(/(CF_SESSION_SECRET|CF_RUNNER_SECRET|password|token|secret)([=:]\s*)([^\s"']+)/gi, '$1$2[redacted]')
    .replace(/\b[a-f0-9]{64}\b/gi, '[redacted-hash]')
    .slice(0, maxLength);
}

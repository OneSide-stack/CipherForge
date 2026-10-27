import path from 'node:path';
import os from 'node:os';

const env = process.env;
const repoRoot = env.CF_REPO_ROOT ?? path.resolve(process.cwd());
const isProd = env.NODE_ENV === 'production' || env.CF_ENV === 'production';

function required(name: string, fallback?: string): string {
  const value = env[name] ?? fallback;
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

const appSecret = required('CF_APP_SECRET', isProd ? undefined : 'dev-only-app-secret-change-me-0123456789abcdef');

export const config = {
  env: isProd ? 'production' : 'development',
  port: Number(env.CF_API_PORT ?? env.PORT ?? 5000),
  bind: env.CF_API_BIND ?? '0.0.0.0',
  repoRoot,
  webDist: env.CF_WEB_DIST ?? path.join(repoRoot, 'apps/web/dist'),
  labsDir: env.CF_LABS_DIR ?? path.join(repoRoot, 'labs'),
  databaseUrl: env.DATABASE_URL ?? 'postgres://cipherforge:cipherforge@127.0.0.1:54329/cipherforge',
  appSecret,
  runnerUrl: (env.CF_RUNNER_URL ?? 'http://127.0.0.1:7100').replace(/\/$/, ''),
  runnerSecret: required('CF_RUNNER_SECRET', isProd ? undefined : 'dev-runner-secret-0123456789abcdef0123456789abcdef'),
  cookieSecure: env.CF_COOKIE_SECURE === 'true' || (env.CF_COOKIE_SECURE !== 'false' && isProd),
  sessionTtlHours: Number(env.CF_AUTH_TTL_HOURS ?? 24 * 7),
  trustProxy: env.CF_TRUST_PROXY !== '0',
  maxActiveSessionsPerUser: Number(env.CF_MAX_ACTIVE_SESSIONS ?? 2),
  provisionPerHour: Number(env.CF_PROVISION_PER_HOUR ?? 12),
  registerPerHour: Number(env.CF_REGISTER_PER_HOUR ?? 10),
  flagAttemptsPerMinute: Number(env.CF_FLAG_ATTEMPTS_PER_MINUTE ?? 10),
  checksPerMinute: Number(env.CF_CHECKS_PER_MINUTE ?? 12),
  seedAdminEmail: env.CF_ADMIN_EMAIL ?? (isProd ? '' : 'admin@cipherforge.dev'),
  seedAdminPassword: env.CF_ADMIN_PASSWORD ?? (isProd ? '' : 'AdminForge!2024'),
  seedLearnerEmail: env.CF_LEARNER_EMAIL ?? (isProd ? '' : 'learner@cipherforge.dev'),
  seedLearnerPassword: env.CF_LEARNER_PASSWORD ?? (isProd ? '' : 'CipherForge!2024'),
  frontendOrigin: env.CF_FRONTEND_ORIGIN ?? '',
  // Hostname suffixes whose origin is allowed to embed the SPA in an iframe.
  // Cloud preview environments (e.g. *.e2b.app) serve the app inside their own
  // document; production deployments should leave this empty.
  previewFrameHosts: (env.CF_PREVIEW_FRAME_HOSTS ?? (isProd ? '' : '.e2b.app'))
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
  // Extra ancestors allowed for preview hosts: '*' keeps the app embeddable when
  // the hosting console frames it from an origin we cannot know ahead of time.
  previewFrameAncestors: env.CF_PREVIEW_FRAME_ANCESTORS ?? (isProd ? '' : '*'),
  version: '1.0.0',
  runtimeDir: env.CF_RUNTIME_DIR ?? path.join(os.homedir(), '.cache', 'cipherforge'),
};

if (config.env === 'production' && config.appSecret.length < 32) {
  throw new Error('CF_APP_SECRET must be at least 32 characters in production');
}

import path from 'node:path';
import os from 'node:os';

const env = process.env;
const repoRoot = env.CF_REPO_ROOT ?? path.resolve(process.cwd());

export type DriverMode = 'docker' | 'sandbox' | 'auto';

export const config = {
  port: Number(env.CF_RUNNER_PORT ?? 7100),
  host: env.CF_RUNNER_BIND ?? '127.0.0.1',
  /** HMAC secret shared with the API only. Rotated per deployment. */
  secret: env.CF_RUNNER_SECRET ?? '',
  driver: (env.CF_RUNNER_DRIVER ?? 'auto') as DriverMode,
  labsDir: env.CF_LABS_DIR ?? path.join(repoRoot, 'labs'),
  runtimeDir: env.CF_RUNTIME_DIR ?? path.join(os.homedir(), '.cache', 'cipherforge'),
  rootfsDir: env.CF_ROOTFS_DIR ?? '',
  assetsDir: env.CF_ASSETS_DIR ?? '',
  maxSessions: Number(env.CF_RUNNER_MAX_SESSIONS ?? 8),
  maxSessionsPerUser: Number(env.CF_RUNNER_MAX_PER_USER ?? 2),
  provisioningTimeoutMs: Number(env.CF_PROVISION_TIMEOUT_MS ?? 90_000),
  dockerSocket: env.CF_DOCKER_SOCKET ?? '/var/run/docker.sock',
  dockerHost: env.CF_DOCKER_HOST ?? '',
  version: '1.0.0',
};

config.rootfsDir ||= path.join(config.runtimeDir, 'rootfs');
config.assetsDir ||= path.join(config.runtimeDir, 'assets');

export function repoPath(...parts: string[]): string {
  return path.join(repoRoot, ...parts);
}

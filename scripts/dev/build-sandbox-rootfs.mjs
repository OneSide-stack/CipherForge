#!/usr/bin/env node
/**
 * Build the CipherForge sandbox base rootfs + platform assets.
 *
 * The sandbox runner is the fallback execution backend for environments where
 * the Docker engine is unavailable (for example CI sandboxes). It is NOT a
 * simulation: sessions run as real Linux user/mount/PID/NET namespaces with an
 * overlayfs root, pivot_root, bounded tmpfs storage and a real PTY shell.
 *
 *   npm run setup:sandbox
 *
 * Output (default ~/.cache/cipherforge):
 *   rootfs/   read-only base userland (lower layer of every session)
 *   assets/   platform tooling mounted at /opt/cf inside sessions, containing
 *             node-pty, the labctl CLI and Python packet-analysis libraries.
 */
import { cp, mkdir, readFile, rm, writeFile, symlink, access, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const RUNTIME = process.env.CF_RUNTIME_DIR ?? path.join(process.env.HOME ?? '/home/user', '.cache', 'cipherforge');
const ROOTFS = path.join(RUNTIME, 'rootfs');
const ASSETS = path.join(RUNTIME, 'assets');
const PY = path.join(ASSETS, 'py');

const log = (...a) => console.log('[rootfs]', ...a);
const exists = async (p) => {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

async function main() {
  if (!(await exists('/usr/sbin/pivot_root'))) throw new Error('pivot_root not found; unsupported host');
  if (!(await exists('/usr/bin/unshare'))) throw new Error('unshare(1) not found; unsupported host');

  await mkdir(RUNTIME, { recursive: true });
  log('building base rootfs at', ROOTFS);
  await rm(ROOTFS, { recursive: true, force: true });
  await mkdir(ROOTFS, { recursive: true });

  const excludes = [
    '--exclude=usr/local/lib/node_modules',
    '--exclude=usr/local/include',
    '--exclude=usr/share/doc',
    '--exclude=usr/share/man',
    '--exclude=usr/share/locale',
    '--exclude=usr/share/icons',
    '--exclude=usr/share/fonts',
    '--exclude=usr/lib/gcc',
    '--exclude=usr/lib/llvm*',
    '--exclude=etc/shadow',
    '--exclude=etc/shadow-',
    '--exclude=etc/gshadow',
    '--exclude=etc/gshadow-',
    '--exclude=etc/ssl/private',
    '--exclude=etc/ssh/ssh_host*',
  ];
  const cmd = `tar -C / ${excludes.join(' ')} --ignore-failed-read -cf - bin sbin lib lib64 usr etc | tar -C ${JSON.stringify(ROOTFS)} --no-same-owner -xpf -`;
  try {
    execFileSync('/bin/bash', ['-c', cmd], { stdio: ['ignore', 'inherit', 'inherit'] });
  } catch (err) {
    log('tar reported warnings (unreadable files are expected):', String(err.message).slice(0, 200));
  }

  // node binary + a writable-safe /etc baseline.
  await mkdir(path.join(ROOTFS, 'usr/local/bin'), { recursive: true });
  if (await exists('/usr/local/bin/node')) {
    await cp('/usr/local/bin/node', path.join(ROOTFS, 'usr/local/bin/node'));
    await chmod(path.join(ROOTFS, 'usr/local/bin/node'), 0o755);
  } else {
    throw new Error('node binary not found at /usr/local/bin/node');
  }
  for (const dir of ['home/learner', 'opt/cf', 'run', 'srv', 'mnt', 'media', 'root', 'var/log', 'var/tmp', 'var/run', 'dev/pts', 'dev/shm']) {
    await mkdir(path.join(ROOTFS, dir), { recursive: true });
  }
  await writeFile(path.join(ROOTFS, 'etc/passwd'), 'root:x:0:0:root:/root:/bin/bash\nlearner:x:0:0:Lab Learner:/home/learner:/bin/bash\n');
  await writeFile(path.join(ROOTFS, 'etc/group'), 'root:x:0:\nlearner:x:0:\nnogroup:x:65534:\n');
  await writeFile(path.join(ROOTFS, 'etc/hostname'), 'cipherforge-lab\n');
  await writeFile(path.join(ROOTFS, 'etc/hosts'), '127.0.0.1 localhost\n');
  await writeFile(path.join(ROOTFS, 'etc/resolv.conf'), '# outbound DNS denied by lab network policy\n');
  await writeFile(
    path.join(ROOTFS, 'etc/profile.d/05-tools.sh'),
    'export PATH=/opt/cf/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin\nexport PYTHONPATH=/opt/cf/py:${PYTHONPATH}\nexport EDITOR=vi\n',
  );
  await rm(path.join(ROOTFS, 'etc/machine-id'), { force: true });
  await rm(path.join(ROOTFS, 'var/lib/apt/lists'), { recursive: true, force: true });

  // ---------------------------------------------------------------- assets
  log('building platform assets at', ASSETS);
  await rm(ASSETS, { recursive: true, force: true });
  await mkdir(path.join(ASSETS, 'bin'), { recursive: true });
  await mkdir(path.join(ASSETS, 'node_modules'), { recursive: true });
  await mkdir(PY, { recursive: true });

  const ptySrc = path.join(REPO, 'node_modules/node-pty');
  if (!(await exists(ptySrc))) throw new Error('node-pty is not installed; run npm install first');
  await cp(ptySrc, path.join(ASSETS, 'node_modules/node-pty'), { recursive: true, dereference: true });
  await cp(path.join(REPO, 'runner-assets', 'labctl.mjs'), path.join(ASSETS, 'bin', 'labctl'));
  await chmod(path.join(ASSETS, 'bin', 'labctl'), 0o755);
  await symlink('/usr/local/bin/node', path.join(ASSETS, 'bin/node')).catch(() => {});

  // Helpful, honest tool shims for binaries missing from the host userland.
  const busybox = await exists(path.join(ROOTFS, 'usr/bin/busybox'));
  if (busybox) {
    await writeFile(path.join(ASSETS, 'bin/vi'), '#!/bin/sh\nexec busybox vi "$@"\n', { mode: 0o755 });
    await writeFile(path.join(ASSETS, 'bin/pager'), '#!/bin/sh\nexec busybox less "$@"\n', { mode: 0o755 });
  }

  // Real packet-analysis libraries (scapy reads actual pcap captures).
  log('installing python packet-analysis libraries');
  try {
    execFileSync(
      'python3',
      ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '--target', PY, '--no-warn-script-location', 'scapy==2.6.1', 'dpkt==1.9.8'],
      { stdio: ['ignore', 'inherit', 'inherit'], timeout: 240000 },
    );
    log('scapy + dpkt installed');
  } catch (err) {
    log('WARNING: could not install scapy/dpkt (network restricted). Packet labs will use the built-in pcap reader.');
  }
  await writeFile(path.join(PY, 'README.txt'), 'PYTHONPATH is preset to /opt/cf/py inside lab sessions.\n');

  await writeFile(
    path.join(RUNTIME, 'rootfs-version.json'),
    JSON.stringify({ builtAt: new Date().toISOString(), node: execFileSync('node', ['--version']).toString().trim() }, null, 2),
  );
  const size = execFileSync('/bin/bash', ['-c', `du -sh ${JSON.stringify(ROOTFS)} ${JSON.stringify(ASSETS)} | awk '{print $1, $2}'`]).toString();
  log('done\n' + size.trim());
  log('Next: start the lab-runner with CF_RUNNER_DRIVER=sandbox (npm run dev:runner)');
}

main().catch((err) => {
  console.error('[rootfs] FAILED:', err.message);
  process.exit(1);
});

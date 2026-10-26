import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { CATEGORIES, type LabTemplate, type LabStatus } from './types.js';

const FORBIDDEN_KEYS = new Set([
  'privileged',
  'capadd',
  'devices',
  'binds',
  'volumes',
  'mounts',
  'pidmode',
  'ipcmode',
  'networkmode',
  'hostconfig',
  'dockerfile',
  'compose',
  'command',
  'entrypoint',
]);

export class TemplateValidationError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = 'TemplateValidationError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep validation of a lab template. Anything a learner could try to smuggle
 * into a Docker invocation (host mounts, privileged flags, raw commands) is
 * rejected here, before the runner ever talks to Docker.
 */
export function validateTemplate(raw: unknown): LabTemplate {
  const fail = (msg: string): never => {
    throw new TemplateValidationError(`Invalid lab template: ${msg}`, [msg]);
  };
  if (!isPlainObject(raw)) fail('template must be an object');
  const t = raw as Record<string, any>;
  const issues: string[] = [];

  const walk = (value: unknown, pathStr: string) => {
    if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${pathStr}[${i}]`));
    if (isPlainObject(value)) {
      for (const [k, v] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.has(k.toLowerCase())) issues.push(`forbidden key "${pathStr}.${k}"`);
        walk(v, `${pathStr}.${k}`);
      }
    }
  };
  walk(t, 'template');
  if (issues.length) throw new TemplateValidationError('Template contains forbidden runtime configuration', issues);

  if (t.schemaVersion !== 1) fail('schemaVersion must be 1');
  for (const key of ['id', 'version', 'title', 'subtitle', 'category', 'difficulty', 'summary', 'scenario']) {
    if (typeof t[key] !== 'string' || !t[key].trim()) fail(`missing string field ${key}`);
  }
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(t.id)) fail('id must be a kebab-case slug (3-64 chars)');
  if (!/^\d+\.\d+\.\d+$/.test(t.version)) fail('version must be semver (x.y.z)');
  if (!CATEGORIES.includes(t.category)) fail(`unknown category ${t.category}`);
  if (!['Beginner', 'Intermediate', 'Advanced', 'Expert'].includes(t.difficulty)) fail('invalid difficulty');
  if (!['published', 'coming_soon', 'unavailable'].includes(t.status)) fail('invalid status');
  if (!Number.isInteger(t.estimatedMinutes) || t.estimatedMinutes < 5 || t.estimatedMinutes > 240)
    fail('estimatedMinutes out of range');
  if (!Number.isInteger(t.baseXp) || t.baseXp < 0 || t.baseXp > 1000) fail('baseXp out of range');

  if (!Array.isArray(t.services)) fail('services must be an array');
  if (!isPlainObject(t.resources)) fail('resources must be specified explicitly');
  const r = t.resources ?? {};
  for (const k of ['cpus', 'memoryMb', 'pids', 'writableDiskMb', 'maxMinutes', 'idleTimeoutMinutes']) {
    if (typeof r[k] !== 'number' || !(r[k] > 0)) fail(`resources.${k} must be a positive number`);
  }
  if (r.memoryMb > 4096 || r.pids > 1024 || r.cpus > 4) fail('resources exceed platform maximums');

  if (!isPlainObject(t.network)) fail('network policy required');
  if (!['deny', 'allow'].includes(t.network?.outbound)) fail('network.outbound must be deny|allow');

  const services = t.services as any[];
  const names = new Set<string>();
  const ports = new Set<number>();
  for (const svc of services) {
    if (!isPlainObject(svc)) fail('service must be an object');
    if (typeof svc.name !== 'string' || !/^[a-z][a-z0-9-]{1,30}$/.test(svc.name)) fail('invalid service name');
    if (names.has(svc.name)) fail(`duplicate service ${svc.name}`);
    names.add(svc.name);
    if (!['target', 'support', 'workspace'].includes(svc.role)) fail(`invalid role for ${svc.name}`);
    for (const p of svc.ports ?? []) {
      if (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535) fail(`invalid port on ${svc.name}`);
      if (ports.has(p.port) && svc.role !== 'workspace') fail(`duplicate published port ${p.port}`);
      ports.add(p.port);
      if (!['http', 'https', 'tcp', 'udp'].includes(p.protocol)) fail(`invalid protocol on ${svc.name}`);
    }
    if (svc.app && (typeof svc.app !== 'string' || svc.app.includes('..'))) fail('invalid app path');
  }
  if (!services.some((s) => s.role === 'target') && t.status === 'published' && t.workspaceOnly !== true)
    fail('published labs require a target service or an explicit workspaceOnly declaration');
  if (t.workspaceOnly === true && !Array.isArray(t.workspace?.tools)) fail('workspace-only labs must declare workspace tools');

  if (!Array.isArray(t.objectives) || t.objectives.length === 0) fail('objectives required');
  const objIds = new Set<string>();
  for (const o of t.objectives as any[]) {
    if (!isPlainObject(o)) fail('objective must be an object');
    if (typeof o.id !== 'string' || !/^[a-z0-9-]{2,40}$/.test(o.id)) fail('invalid objective id');
    if (objIds.has(o.id)) fail(`duplicate objective ${o.id}`);
    objIds.add(o.id);
    const v = o.validation;
    if (!isPlainObject(v) || !['flag', 'check'].includes(String(v.type))) fail(`objective ${o.id} needs validation`);
    if (typeof v.xp !== 'number' || v.xp < 0 || v.xp > 500) fail(`objective ${o.id} xp out of range`);
    if (v.type === 'check' && (typeof v.validator !== 'string' || !v.validator))
      fail(`objective ${o.id} needs a validator`);
    if (!Array.isArray(o.hints)) fail(`objective ${o.id} hints must be an array`);
  }
  if (Array.isArray(t.validators)) {
    for (const v of t.validators as string[]) {
      const declared = (t.objectives as any[]).some((o) => o.validation?.validator === v);
      if (!declared) fail(`validator ${v} is listed but not used by any objective`);
    }
  }
  if (t.provisioner && (typeof t.provisioner.script !== 'string' || t.provisioner.script.includes('..')))
    fail('invalid provisioner script');

  if (t.status === 'published') {
    if (!t.provisioner) fail('published labs require a provisioning script');
    if (!Array.isArray(t.walkthrough) || t.walkthrough.length === 0) fail('published labs need walkthrough steps');
  }

  return raw as LabTemplate;
}

export interface RegistryEntry {
  template: LabTemplate;
  checksum: string;
  dir: string;
}

export interface LabRegistry {
  entries: Map<string, RegistryEntry>;
  byCategory: Map<string, RegistryEntry[]>;
  list(): RegistryEntry[];
  get(id: string): RegistryEntry | undefined;
  published(): RegistryEntry[];
}

export async function loadRegistry(labsDir: string): Promise<LabRegistry> {
  const dirs = await readdir(labsDir, { withFileTypes: true });
  const entries = new Map<string, RegistryEntry>();
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const templatePath = path.join(labsDir, dir.name, 'template.json');
    let raw: string;
    try {
      raw = await readFile(templatePath, 'utf8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new TemplateValidationError(`Lab ${dir.name}: template.json is not valid JSON: ${(err as Error).message}`);
    }
    const template = validateTemplate(parsed);
    if (template.id !== dir.name)
      throw new TemplateValidationError(`Lab directory ${dir.name} does not match template id ${template.id}`);
    const checksum = createHash('sha256')
      .update(raw)
      .update('\n')
      .update(await fileDigest(path.join(labsDir, dir.name)))
      .digest('hex');
    entries.set(template.id, { template, checksum, dir: path.join(labsDir, dir.name) });
  }
  const byCategory = new Map<string, RegistryEntry[]>();
  for (const entry of entries.values()) {
    const list = byCategory.get(entry.template.category) ?? [];
    list.push(entry);
    byCategory.set(entry.template.category, list);
  }
  const sorted = [...entries.values()].sort(
    (a, b) => a.template.baseXp - b.template.baseXp || a.template.title.localeCompare(b.template.title),
  );
  return {
    entries,
    byCategory,
    list: () => sorted,
    get: (id) => entries.get(id),
    published: () => sorted.filter((e) => e.template.status === 'published'),
  };
}

/** Stable digest over the code assets shipped with a lab (apps, validators, provisioners). */
async function fileDigest(dir: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (current: string, rel: string) => {
    const list = await readdir(current, { withFileTypes: true });
    list.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of list) {
      const abs = path.join(current, item.name);
      const relPath = path.join(rel, item.name);
      if (item.isDirectory()) {
        await walk(abs, relPath);
      } else if (item.isFile()) {
        const s = await stat(abs);
        if (s.size > 2_000_000) continue;
        hash.update(relPath).update('\0').update(await readFile(abs)).update('\0');
      }
    }
  };
  try {
    await walk(dir, '');
  } catch {
    /* assets optional */
  }
  return hash.digest('hex');
}

export function statusLabel(status: LabStatus): string {
  return status === 'published' ? 'Ready' : status === 'coming_soon' ? 'Coming Soon' : 'Unavailable';
}

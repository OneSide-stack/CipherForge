import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadRegistry, validateTemplate } from '@cipherforge/shared';

const repo = path.resolve(import.meta.dirname, '../../../..');
const labsDir = path.join(repo, 'labs');

const baseTemplate = () =>
  JSON.parse(fs.readFileSync(path.join(labsDir, 'http-header-hunt/template.json'), 'utf8')) as Record<string, unknown>;

test('every shipped template validates and the catalog meets the product floor', async () => {
  const registry = await loadRegistry(labsDir);
  const entries = registry.list().map((e) => e.template);
  assert.ok(entries.length >= 20, `expected at least 20 catalog entries, found ${entries.length}`);
  const published = entries.filter((t) => t.status === 'published');
  const interactive = published.filter((t) => !t.workspaceOnly);
  assert.ok(interactive.length >= 12, `expected at least 12 interactive labs, found ${interactive.length}`);
  for (const entry of entries) {
    assert.equal(entry.id, path.basename(registry.get(entry.id)!.dir));
  }
});

test('forbidden runtime configuration is rejected', () => {
  for (const key of ['privileged', 'capAdd', 'binds', 'devices', 'command']) {
    const template = baseTemplate();
    (template.services as Record<string, unknown>[])[0][key] = true;
    assert.throws(() => validateTemplate(template), /forbidden/i, `key ${key} must be rejected`);
  }
});

test('resources and network policy are mandatory', () => {
  const noResources = baseTemplate();
  delete noResources.resources;
  assert.throws(() => validateTemplate(noResources));

  const noNetwork = baseTemplate();
  delete noNetwork.network;
  assert.throws(() => validateTemplate(noNetwork));

  const publishedWithoutTarget = baseTemplate();
  publishedWithoutTarget.services = [];
  assert.throws(() => validateTemplate(publishedWithoutTarget), /target service/i);
});

test('invalid categories and duplicate objectives are rejected', () => {
  const badCategory = baseTemplate();
  badCategory.category = 'Not A Category';
  assert.throws(() => validateTemplate(badCategory));

  const duplicate = baseTemplate();
  const objectives = (duplicate.objectives as Record<string, unknown>[]);
  duplicate.objectives = [objectives[0], objectives[0]];
  assert.throws(() => validateTemplate(duplicate));
});

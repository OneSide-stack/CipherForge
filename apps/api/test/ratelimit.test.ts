import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryLimit } from '../src/services/ratelimit.js';

test('in-process limiter allows the configured burst then throws 429', () => {
  const key = `test:${Math.random()}`;
  for (let i = 0; i < 3; i += 1) memoryLimit(key, 3, 60_000);
  assert.throws(() => memoryLimit(key, 3, 60_000), (err: unknown) => {
    const e = err as { status?: number; code?: string };
    return e.status === 429;
  });
});

test('limits are scoped per key', () => {
  const a = `test-a:${Math.random()}`;
  const b = `test-b:${Math.random()}`;
  for (let i = 0; i < 5; i += 1) memoryLimit(a, 5, 60_000);
  assert.doesNotThrow(() => memoryLimit(b, 5, 60_000));
});

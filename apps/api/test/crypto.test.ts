import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPassword, hmacHex, sha256, timingSafeEqualStr, verifyPassword } from '../src/lib/crypto.js';

test('passwords hash with scrypt and verify in constant time', () => {
  const { hash, salt } = hashPassword('CipherForge!2024');
  assert.notEqual(hash, 'CipherForge!2024');
  assert.equal(hash.length > 20, true);
  assert.equal(verifyPassword('CipherForge!2024', salt, hash), true);
  assert.equal(verifyPassword('cipherforge!2024', salt, hash), false);
  assert.equal(verifyPassword('CipherForge!2024', salt, Buffer.from('not-the-hash').toString('base64')), false);
});

test('a different salt produces a different hash for the same password', () => {
  const a = hashPassword('same-password');
  const b = hashPassword('same-password');
  assert.notEqual(a.hash, b.hash);
  assert.equal(verifyPassword('same-password', a.salt, a.hash), true);
  assert.equal(verifyPassword('same-password', b.salt, b.hash), true);
});

test('hmac and digest helpers are deterministic and key-dependent', () => {
  assert.equal(hmacHex('k1', 'v'), hmacHex('k1', 'v'));
  assert.notEqual(hmacHex('k1', 'v'), hmacHex('k2', 'v'));
  assert.equal(sha256('abc').length, 64);
  assert.match(sha256('abc'), /^[0-9a-f]{64}$/);
});

test('timing safe comparison rejects different lengths without throwing', () => {
  assert.equal(timingSafeEqualStr('abc', 'abc'), true);
  assert.equal(timingSafeEqualStr('abc', 'abcd'), false);
  assert.equal(timingSafeEqualStr('', 'a'), false);
});

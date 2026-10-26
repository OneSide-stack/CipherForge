import assert from 'node:assert/strict';
import test from 'node:test';
import { cx, difficultyTone, minutesLabel, stateLabel, stateTone, timeLeft } from '../src/lib/format.js';

test('cx joins truthy class names only', () => {
  assert.equal(cx('a', false, null, 'b', undefined), 'a b');
  assert.equal(cx(), '');
});

test('difficulty and state map to stable tones', () => {
  assert.equal(difficultyTone('Beginner'), 'teal');
  assert.equal(difficultyTone('Advanced'), 'ember');
  assert.equal(difficultyTone('Unknown'), 'blue');
  assert.equal(stateTone('ready'), 'teal');
  assert.equal(stateTone('failed'), 'red');
  assert.equal(stateTone('provisioning'), 'amber');
});

test('state labels are human readable', () => {
  assert.equal(stateLabel('ready'), 'Ready');
  assert.equal(stateLabel('coming_soon'), 'Coming Soon');
});

test('minute formatting compacts hours', () => {
  assert.equal(minutesLabel(25), '25 min');
  assert.equal(minutesLabel(60), '1h');
  assert.equal(minutesLabel(95), '1h 35m');
});

test('countdown formatting handles expiry and fields', () => {
  assert.equal(timeLeft(0), 'expired');
  assert.equal(timeLeft(-5), 'expired');
  assert.match(timeLeft(3600 + 120), /^1h 02m$/);
  assert.equal(timeLeft(75), '1:15');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertCanonicalInvocation,
  assertIsolationConfig,
  verifyNegativeControls,
} = require('./run-isolation-gate');

test('accepts only the canonical uncached two-worker configuration', () => {
  assert.doesNotThrow(() =>
    assertIsolationConfig({ cache: false, maxWorkers: 2 }),
  );
  for (const config of [
    { cache: true, maxWorkers: 2 },
    { cache: false, maxWorkers: 1 },
    { cache: false, maxWorkers: '50%' },
    { maxWorkers: 2 },
  ]) {
    assert.throws(() => assertIsolationConfig(config), /isolation gate/i);
  }
});

test('rejects caller arguments so cached, in-band, filtered, or single-worker execution cannot override the gate', () => {
  assert.doesNotThrow(() => assertCanonicalInvocation([]));
  for (const args of [
    ['--runInBand'],
    ['-i'],
    ['--maxWorkers=1'],
    ['--maxWorkers', '1'],
    ['--cache'],
    ['--cache=true'],
    ['--config', './other.json'],
    ['--listTests'],
    ['--showConfig'],
    ['-t', 'nonexistent test'],
    ['test/isolation/worker-isolation-a.spec.ts'],
  ]) {
    assert.throws(() => assertCanonicalInvocation(args), /canonical invocation/i);
  }
});

test('canonical gate executes its built-in negative-control matrix', () => {
  assert.doesNotThrow(() => verifyNegativeControls());
});

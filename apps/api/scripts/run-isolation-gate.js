#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const apiRoot = path.resolve(__dirname, '..');
const configPath = path.join(apiRoot, 'test', 'jest-isolation.json');
const withTestEnvPath = path.join(apiRoot, 'scripts', 'with-test-env.js');

function assertIsolationConfig(config) {
  if (
    typeof config !== 'object' ||
    config === null ||
    config.cache !== false ||
    config.maxWorkers !== 2
  ) {
    throw new Error(
      'Isolation gate requires cache=false and numeric maxWorkers=2 in test/jest-isolation.json.',
    );
  }
}

function assertCanonicalInvocation(args) {
  if (!Array.isArray(args) || args.length !== 0) {
    throw new Error(
      'Canonical invocation accepts no caller arguments; cached, filtered, in-band, alternate-config, and worker-count overrides are refused.',
    );
  }
}

function verifyNegativeControls() {
  const forbidden = [
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
  ];

  assertCanonicalInvocation([]);
  for (const args of forbidden) {
    let refused = false;
    try {
      assertCanonicalInvocation(args);
    } catch {
      refused = true;
    }
    if (!refused) {
      throw new Error(
        `Isolation gate negative control failed for override shape: ${args[0] ?? 'unknown'}.`,
      );
    }
  }
}

function main(args) {
  assertCanonicalInvocation(args);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assertIsolationConfig(config);
  verifyNegativeControls();

  process.stdout.write(
    '[isolation-gate] canonical contract verified: cache=false, maxWorkers=2, unsafe overrides rejected.\n',
  );

  const child = spawnSync(
    process.execPath,
    [
      withTestEnvPath,
      'jest',
      '--config',
      configPath,
      '--no-cache',
      '--maxWorkers=2',
    ],
    {
      cwd: apiRoot,
      env: process.env,
      stdio: 'inherit',
    },
  );
  if (child.error) {
    throw child.error;
  }
  process.exitCode = child.status ?? 1;
}

module.exports = {
  assertCanonicalInvocation,
  assertIsolationConfig,
  verifyNegativeControls,
};

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unexpected failure';
    process.stderr.write(`[isolation-gate] ${message}\n`);
    process.exitCode = 1;
  }
}

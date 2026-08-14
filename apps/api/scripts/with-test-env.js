#!/usr/bin/env node
'use strict';

/**
 * Q0-SEC npm script shim.
 *
 * Every Repository/E2E test script runs through this shim so that:
 *   1. NODE_ENV is always forced to 'test' (requirement: NODE_ENV=test in all
 *      Repository and E2E test scripts), no matter what the caller exported.
 *   2. The test database guard runs BEFORE jest boots and refuses to start
 *      when TEST_DATABASE_URL is missing, matches DATABASE_URL, or targets a
 *      non-allowlisted / production / staging database.
 *   3. Each invocation generates a FRESH run id (MOEEN_TEST_RUN_ID) and a
 *      FRESH owner token (MOEEN_TEST_OWNER_TOKEN) that become the run-unique
 *      schema and its ownership proof, so two parallel runs can never overlap
 *      and no run can drop another's schema. Values inherited from the
 *      terminal, CI, npm or an external wrapper are deliberately ignored —
 *      the run id, the owner token and the run-specific TEST_DATABASE_URL are
 *      written into an isolated CHILD environment that is passed to spawn,
 *      never into this process's own env.
 *
 * Usage: node scripts/with-test-env.js jest [args...]
 *        node scripts/with-test-env.js node [node args...]
 */

const path = require('node:path');
const { spawn } = require('node:child_process');
const fs = require('node:fs');

const apiRoot = path.resolve(__dirname, '..');

// 1. Hard requirement: test scripts always run as NODE_ENV=test.
process.env.NODE_ENV = 'test';

// Load the local environment (never overrides variables already exported).
const envFile = path.join(apiRoot, '.env');
if (fs.existsSync(envFile)) {
  require(path.join(apiRoot, 'node_modules', 'dotenv')).config({
    path: envFile,
  });
}

// 2. Preflight: compile and run the guard before jest starts.
process.env.TS_NODE_TRANSPILE_ONLY = '1';
require(path.join(apiRoot, 'node_modules', 'ts-node', 'register'));
const guard = require(path.join(apiRoot, 'src', 'test-db.guard.ts'));

try {
  guard.assertTestDatabaseUrl(process.env);
} catch (error) {
  console.error(`\nQ0-SEC guard: ${error.message}\n`);
  process.exit(1);
}

// 3. Own the run environment HERE, before jest spawns. A fresh run id AND a
//    fresh owner token are generated for EVERY invocation — values inherited
//    from the terminal, CI, npm or any wrapper are never reused — and the
//    run-specific TEST_DATABASE_URL is written into an isolated CHILD
//    environment (not into this process's env). jest and every worker inherit
//    exactly these values for this run only; workers never rewrite
//    TEST_DATABASE_URL themselves, they only validate what they inherited
//    (test/setup/setup-test-env.ts).
const runId = guard.generateTestRunId();
const ownerToken = guard.generateOwnerToken();
const childEnv = {
  ...process.env,
  NODE_ENV: 'test',
  MOEEN_TEST_RUN_ID: runId,
  MOEEN_TEST_OWNER_TOKEN: ownerToken,
};
// The preflight returns the canonical base URL (raw query never kept).
childEnv.TEST_DATABASE_URL = guard.withRunSchema(
  guard.assertTestDatabaseUrl(process.env),
  runId,
);
// P1-1: re-verify the EXACT effective connection settings jest will use,
// after withRunSchema() and before spawn.
guard.assertTestDatabaseUrl(childEnv);
console.log(`[test-db] run ${runId} schema ${guard.runSchemaName(runId)}`);

const [command, ...args] = process.argv.slice(2);
let file;
let childArgs;
if (command === 'jest') {
  file = require.resolve('jest/bin/jest', { paths: [apiRoot] });
  childArgs = [file, ...args];
} else if (command === 'node') {
  file = process.execPath;
  childArgs = args;
} else {
  console.error(
    "Q0-SEC shim: unknown command (expected 'jest' or 'node').",
  );
  process.exit(1);
}

const child = spawn(process.execPath, childArgs, {
  stdio: 'inherit',
  env: childEnv,
  cwd: apiRoot,
});
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});

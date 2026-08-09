import 'dotenv/config';
import {
  TestDatabaseGuardError,
  assertTestDatabaseUrl,
  extractSearchPath,
  runSchemaName,
  TEST_OWNER_TOKEN_ENV,
  TEST_RUN_ID_ENV,
  validateOwnerToken,
  validateTestRunId,
} from '../../src/test-db.guard';

/**
 * Q0-SEC per-worker validation hook.
 *
 * The run environment (MOEEN_TEST_RUN_ID, MOEEN_TEST_OWNER_TOKEN and the
 * run-specific TEST_DATABASE_URL) is prepared by scripts/with-test-env.js
 * BEFORE jest spawns, so every worker inherits it directly from the process
 * environment. This hook NEVER generates or rewrites any of those values —
 * it only fail-fast validates what was inherited:
 *
 *  - NODE_ENV is test;
 *  - a run id and an owner token exist (i.e. tests were started through the
 *    npm scripts) and match the expected shape;
 *  - the inherited TEST_DATABASE_URL passes every guard rule (local-only
 *    host/user/port, allowlisted database, single approved query parameter,
 *    dedicated test search_path, no effective match with DATABASE_URL);
 *  - the search_path is exactly THIS run's unique schema — not the shared
 *    base schema and not any other run's schema.
 */
export default function setupTestEnv(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new TestDatabaseGuardError(
      `Refusing to run: NODE_ENV must be 'test' for automated tests (got '${
        process.env.NODE_ENV ?? '(unset)'
      }').`,
    );
  }
  const runId = process.env[TEST_RUN_ID_ENV];
  if (!runId) {
    throw new TestDatabaseGuardError(
      `Refusing to run: ${TEST_RUN_ID_ENV} is not set — start tests through the npm scripts (scripts/with-test-env.js) so the run-specific TEST_DATABASE_URL is prepared before jest spawns.`,
    );
  }
  validateTestRunId(runId);
  const ownerToken = process.env[TEST_OWNER_TOKEN_ENV];
  if (!ownerToken) {
    throw new TestDatabaseGuardError(
      `Refusing to run: ${TEST_OWNER_TOKEN_ENV} is not set — start tests through the npm scripts (scripts/with-test-env.js).`,
    );
  }
  validateOwnerToken(ownerToken);
  assertTestDatabaseUrl(process.env);
  const expected = runSchemaName(runId);
  const inheritedUrl = process.env.TEST_DATABASE_URL as string;
  const searchPath = extractSearchPath(new URL(inheritedUrl));
  if (searchPath !== expected) {
    // The inherited value is deliberately omitted — it may carry a sensitive
    // search_path supplied by an attacker-controlled environment.
    throw new TestDatabaseGuardError(
      `Refusing to run: inherited TEST_DATABASE_URL search_path does not match this run's schema '${expected}'.`,
    );
  }
  process.stdout.write(`[test-db] worker schema: ${expected}\n`);
}

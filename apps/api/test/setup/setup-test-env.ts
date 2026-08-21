import 'dotenv/config';
import { Pool } from 'pg';
import { runDatabaseMigrations } from '../../src/database-migrations';
import {
  TestDatabaseGuardError,
  assertTestDatabaseUrl,
  extractSearchPath,
  ownerTokenHash,
  runSchemaName,
  TEST_OWNER_TOKEN_ENV,
  TEST_RUN_ID_ENV,
  validateOwnerToken,
  validateTestRunId,
  validateWorkerId,
  workerSchemaName,
  withWorkerSchema,
} from '../../src/test-db.guard';
import { createOwnedSchema, qualifiedMarkerTable } from './ownership';

/** Returns true when `error` is a PostgreSQL duplicate_schema error (42P06). */
function isPostgresDuplicateSchemaError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '42P06'
  );
}

/**
 * Q0-SEC per-worker setup hook (setupFiles — runs inside EVERY Jest worker).
 *
 * The run environment (MOEEN_TEST_RUN_ID, MOEEN_TEST_OWNER_TOKEN and the
 * run-specific TEST_DATABASE_URL) is prepared by scripts/with-test-env.js
 * BEFORE jest spawns, so every worker inherits it. This hook:
 *
 *  1. fail-fast validates what was inherited (NODE_ENV, run id, owner token,
 *     every guard rule, search_path == this run's schema);
 *  2. derives THIS worker's own schema from the canonical pair
 *     (MOEEN_TEST_RUN_ID + JEST_WORKER_ID) — moeen_test_<runId>_w<workerId>;
 *  3. creates it with a plain CREATE SCHEMA (no IF NOT EXISTS) and records
 *     the run's ownership marker (run id + SHA-256 of the run owner token)
 *     INSIDE it, so teardown can prove ownership per worker schema;
 *  4. applies the application's ordered migration manifest to the worker
 *     schema before any test module or repository can execute;
 *  5. rewrites THIS worker process's TEST_DATABASE_URL to its own schema —
 *     pools constructed after setupFiles therefore all target this worker's
 *     fully migrated schema; no worker ever shares another worker's schema.
 *
 * No sleeps, no retries, no global state: the rewrite is per-process.
 *
 * NOTE (jest 30): setupFiles modules must expose the hook as the module
 * itself (module.exports = fn). A transpiled `export default` is NOT invoked
 * by jest's setupFiles runtime, so the hook is attached CJS-style below.
 */
async function setupTestEnv(): Promise<void> {
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

  // The inherited URL must be this run's schema (the shim's value), never the
  // shared base and never another run's schema.
  const baseUrl = assertTestDatabaseUrl(process.env);
  const expected = runSchemaName(runId);
  const searchPath = extractSearchPath(new URL(baseUrl));
  if (searchPath !== expected) {
    // The inherited value is deliberately omitted — it may carry a sensitive
    // search_path supplied by an attacker-controlled environment.
    throw new TestDatabaseGuardError(
      `Refusing to run: inherited TEST_DATABASE_URL search_path does not match this run's schema '${expected}'.`,
    );
  }

  // Per-worker schema: canonical name from run id + JEST_WORKER_ID.
  const workerId = process.env.JEST_WORKER_ID ?? '1';
  validateWorkerId(workerId);
  const workerSchema = workerSchemaName(runId, workerId);

  // setupFiles runs once PER TEST FILE, and jest isolates each file's
  // sandbox (module/globalThis/process.env state does not survive between
  // files). The DATABASE is therefore the only durable shared truth: the
  // FIRST invocation in this worker creates the schema with a plain CREATE
  // SCHEMA (no IF NOT EXISTS — any pre-existing name FAILS), and a later
  // invocation that finds the schema already present reuses it ONLY after
  // PROVING ownership — the marker inside it must match this run's id and
  // owner-token hash. A foreign schema, a missing marker or a mismatch
  // rethrows the original error (fail-closed).
  const pool = new Pool({ connectionString: baseUrl });
  try {
    try {
      await createOwnedSchema(
        pool,
        workerSchema,
        runId,
        ownerTokenHash(ownerToken),
      );
    } catch (error) {
      // Only the known PostgreSQL duplicate_schema SQLSTATE (42P06) may be
      // treated as a safe race/reuse. Any other error — including permission
      // failures, syntax errors, or corrupted markers — must propagate even if
      // an ownership marker happens to exist.
      if (!isPostgresDuplicateSchemaError(error)) {
        throw error;
      }
      const marker = await pool.query<{
        run_id: string;
        owner_token_hash: string;
      }>(
        `SELECT run_id, owner_token_hash FROM ${qualifiedMarkerTable(workerSchema)}`,
      );
      // Singleton marker: exactly ONE row, matching this run, proves the
      // schema is ours. A missing marker, extra rows or a mismatch all
      // rethrow the original CREATE error (fail-closed).
      const row = marker.rows.length === 1 ? marker.rows[0] : undefined;
      if (
        !row ||
        row.run_id !== runId ||
        row.owner_token_hash !== ownerTokenHash(ownerToken)
      ) {
        // Not ours (or not readable): the schema stays untouched and the
        // original CREATE error is rethrown — the worker fails.
        throw error;
      }
    }
  } finally {
    await pool.end();
  }

  // Apply the SAME ordered migration contract used by the application before
  // any repository/test module executes. This is deliberately not another
  // hand-written test schema: adding a migration to the release manifest is
  // sufficient to advance every isolated worker schema.
  const workerUrl = withWorkerSchema(baseUrl, runId, workerId);
  const migrationPool = new Pool({ connectionString: workerUrl });
  try {
    await runDatabaseMigrations(migrationPool);
  } finally {
    await migrationPool.end();
  }

  // Rewrite THIS worker's URL to its fully migrated schema. Every pool
  // constructed from here on in this process targets the worker schema; the
  // effective search_path is the worker schema plus the always-implicit
  // pg_catalog.
  process.env.TEST_DATABASE_URL = workerUrl;
  process.stdout.write(`[test-db] worker schema: ${workerSchema}\n`);
}

// TypeScript form of the same CommonJS callable (compiles to
// `module.exports = setupTestEnv;` verbatim) — jest 30.4.1 setupFiles must
// keep seeing a callable CommonJS export; never convert this to `export default`.
export = setupTestEnv;

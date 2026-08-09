import 'dotenv/config';
import { Pool } from 'pg';
import {
  TestDatabaseGuardError,
  assertTestDatabaseUrl,
  ownerTokenHash,
  runSchemaName,
  TEST_OWNER_TOKEN_ENV,
  TEST_RUN_ID_ENV,
  validateOwnerToken,
  validateTestRunId,
} from '../../src/test-db.guard';

/**
 * Q0-SEC global setup: runs once per jest invocation, before any test file.
 * Validates the inherited run environment, runs the role privilege preflight
 * (fail-closed), then creates the run-unique schema (moeen_test_<runId>) and
 * records an ownership marker INSIDE it. The run id, the owner token and the
 * run-specific TEST_DATABASE_URL come from scripts/with-test-env.js — this
 * hook never generates or rewrites environment variables.
 */
export default async function globalSetup(): Promise<void> {
  assertTestDatabaseUrl(process.env);
  const runId = process.env[TEST_RUN_ID_ENV];
  if (!runId) {
    throw new TestDatabaseGuardError(
      `Refusing to run: ${TEST_RUN_ID_ENV} is not set — start tests through the npm scripts (scripts/with-test-env.js).`,
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
  const schema = runSchemaName(runId);

  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  try {
    // P2: fail-closed role preflight — a safe, dedicated, non-superuser test
    // role is required; no wide-privilege fallback is ever used.
    await assertSafeTestRole(pool);

    // Plain CREATE SCHEMA (no IF NOT EXISTS): a schema that already exists
    // under this run's name must FAIL the run, never be adopted.
    await pool.query(`CREATE SCHEMA "${schema}"`);

    // Ownership marker inside the freshly created schema: run id + SHA-256 of
    // this run's owner token. Teardown refuses to drop without a matching
    // marker, so no run can ever drop another run's (or a shared) schema.
    await pool.query(
      `CREATE TABLE "${schema}".q0sec_run_ownership (
         run_id TEXT NOT NULL,
         owner_token_hash TEXT NOT NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
    );
    await pool.query(
      `INSERT INTO "${schema}".q0sec_run_ownership (run_id, owner_token_hash)
       VALUES ($1, $2)`,
      [runId, ownerTokenHash(ownerToken)],
    );

    // The role must be able to manage its own run schema.
    const own = await pool.query<{ ok: boolean }>(
      `SELECT has_schema_privilege(current_schema(), 'CREATE') AS ok`,
    );
    if (!own.rows[0]?.ok) {
      throw new TestDatabaseGuardError(
        'Q0-SEC privilege preflight: the test role cannot manage its own run schema — refusing to run.',
      );
    }
  } finally {
    await pool.end();
  }
  process.stdout.write(`[test-db] run schema: ${schema}\n`);
}

/**
 * P2 — fail-closed privilege preflight. The role used by automated tests must
 * be a dedicated non-superuser test role: it must not be postgres, must not
 * be a superuser, must not be able to create objects in the public schema and
 * must not be able to modify the shared 'moeen_test' schema. If any check
 * fails, the run is refused — no fallback to a wide-privilege role.
 */
async function assertSafeTestRole(pool: Pool): Promise<void> {
  const role = await pool.query<{
    name: string;
    super: boolean;
  }>(
    `SELECT current_user AS name,
            (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS super`,
  );
  const name = role.rows[0]?.name ?? '(unknown)';
  if (name === 'postgres') {
    throw new TestDatabaseGuardError(
      'Q0-SEC privilege preflight: refusing to run automated tests as the postgres role.',
    );
  }
  if (role.rows[0]?.super) {
    throw new TestDatabaseGuardError(
      'Q0-SEC privilege preflight: refusing to run automated tests as a superuser role.',
    );
  }
  const pub = await pool.query<{ ok: boolean }>(
    `SELECT has_schema_privilege('public', 'CREATE') AS ok`,
  );
  if (pub.rows[0]?.ok) {
    throw new TestDatabaseGuardError(
      'Q0-SEC privilege preflight: the test role must not be able to create objects in the public schema.',
    );
  }
  const shared = await pool.query<{ ok: boolean }>(
    `SELECT has_schema_privilege('moeen_test', 'CREATE') AS ok`,
  );
  if (shared.rows[0]?.ok) {
    throw new TestDatabaseGuardError(
      "Q0-SEC privilege preflight: the test role must not be able to modify the shared 'moeen_test' schema.",
    );
  }
}

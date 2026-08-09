import { Pool } from 'pg';
import {
  TEST_RUN_ID_MAX_LENGTH,
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
 * Q0-SEC global teardown: drops ONLY this run's schema with CASCADE, and only
 * after PROVING ownership. The dropped name must be exactly moeen_test_<runId>
 * (public, the shared moeen_test base schema, and any other schema name are
 * refused outright), the ownership marker table must exist inside the schema,
 * and its run id + owner-token hash must match THIS run's values. When the
 * marker is missing or does not match, NO drop happens and the run fails with
 * a safe message (no secrets). This replaces the old shared-schema
 * LIKE 'PILOT-%' row cleanup entirely.
 */
export default async function globalTeardown(): Promise<void> {
  assertTestDatabaseUrl(process.env);
  const runId = process.env[TEST_RUN_ID_ENV];
  if (!runId) {
    return;
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
  // Structural ownership check: only this run's own schema may be dropped.
  // (runSchemaName already validated the run id against the shared 4-52
  // charset bound; this re-check refuses public / moeen_test / anything that
  // is not this run's exact schema name.)
  if (
    !new RegExp(`^moeen_test_[a-z0-9]{4,${TEST_RUN_ID_MAX_LENGTH}}$`).test(
      schema,
    ) ||
    schema !== `moeen_test_${runId}`
  ) {
    throw new TestDatabaseGuardError(
      `Refusing to drop schema '${schema}': not owned by this run.`,
    );
  }
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  try {
    // Ownership marker proof BEFORE any drop.
    let marker: { run_id: string; owner_token_hash: string } | undefined;
    try {
      const res = await pool.query<{
        run_id: string;
        owner_token_hash: string;
      }>(`SELECT run_id, owner_token_hash FROM q0sec_run_ownership`);
      marker = res.rows[0];
    } catch {
      marker = undefined;
    }
    if (!marker) {
      throw new TestDatabaseGuardError(
        `Q0-SEC ownership: refusing to drop schema '${schema}' — ownership marker is missing or unreadable.`,
      );
    }
    if (
      marker.run_id !== runId ||
      marker.owner_token_hash !== ownerTokenHash(ownerToken)
    ) {
      throw new TestDatabaseGuardError(
        `Q0-SEC ownership: refusing to drop schema '${schema}' — ownership marker does not match this run.`,
      );
    }
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    process.stdout.write(`[test-db] dropped schema: ${schema}\n`);
  } finally {
    await pool.end();
  }
}

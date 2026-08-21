import { Pool } from 'pg';
import {
  TEST_OWNER_TOKEN_ENV,
  TEST_RUN_ID_ENV,
  ownerTokenHash,
  validateWorkerId,
  workerSchemaName,
} from './test-db.guard';
import { qualifiedMarkerTable } from '../test/setup/ownership';

/**
 * Q0-SEC setupFiles regression (Jest 30.4.1).
 *
 * Jest 30 does NOT invoke a transpiled `export default` from a setupFiles
 * module — the hook must be exported as module.exports = fn (proven by
 * probe). Before that fix, test/setup/setup-test-env.ts silently never ran,
 * yet suites still passed green, so this regression proves — with DATABASE
 * state, not console output — that the per-worker setup actually executed
 * for THIS worker:
 *
 *  - the inherited TEST_DATABASE_URL was rewritten to THIS worker's schema
 *    (current_schema() inside the DB equals the canonical worker schema);
 *  - the worker schema physically exists in pg_namespace;
 *  - the ownership marker inside it binds it to THIS run id and THIS
 *    owner-token hash (the Q0-SEC contract).
 *
 * If setupFiles did not run, current_schema() stays on the RUN schema (or
 * the base schema), the worker schema does not exist, and every assertion
 * above fails loudly — never a false green.
 */
describe('setupFiles regression (Jest 30.4.1)', () => {
  const runId = process.env[TEST_RUN_ID_ENV];
  const ownerToken = process.env[TEST_OWNER_TOKEN_ENV];
  const workerId = process.env.JEST_WORKER_ID;

  it('setup-test-env actually executed: the worker schema and its ownership marker are live', async () => {
    // Fail-closed prerequisites: without setupFiles (and the shim), these
    // are unset or empty and the whole test collapses immediately.
    expect(runId).toBeTruthy();
    expect(ownerToken).toBeTruthy();
    expect(workerId).toBeTruthy();
    validateWorkerId(workerId as string);

    const workerSchema = workerSchemaName(runId as string, workerId as string);
    const expectedHash = ownerTokenHash(ownerToken as string);

    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    try {
      // 1) The inherited URL must have been rewritten to THIS worker's
      //    schema by setup-test-env.ts. If setupFiles never ran, this is the
      //    RUN schema (or the base) — a hard, obvious mismatch.
      const cs = await pool.query<{ cs: string }>(
        'SELECT current_schema() AS cs',
      );
      expect(cs.rows[0].cs).toBe(workerSchema);

      // 2) The worker schema must physically exist in pg_namespace.
      const ns = await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1',
        [workerSchema],
      );
      expect(ns.rows[0].n).toBe(1);

      // 3) The ownership marker must exist INSIDE the worker schema and bind
      //    it to this exact run id + owner-token hash. A missing marker, a
      //    foreign marker or a mismatched run id all fail closed.
      const marker = await pool.query<{
        run_id: string;
        owner_token_hash: string;
      }>(
        `SELECT run_id, owner_token_hash FROM ${qualifiedMarkerTable(
          workerSchema,
        )}`,
      );
      expect(marker.rows).toHaveLength(1);
      expect(marker.rows[0].run_id).toBe(runId);
      expect(marker.rows[0].owner_token_hash).toBe(expectedHash);

      // 4) The worker bootstrap must apply the same ordered migration manifest
      //    used by the application before any repository initializes. This is
      //    the regression boundary for new migrations: a worker schema may not
      //    silently stop at an older hand-maintained repository schema.
      const history = await pool.query<{ version: string }>(
        'SELECT version FROM moeen_schema_migrations ORDER BY version',
      );
      expect(history.rows).toEqual([
        { version: '0001' },
        { version: '0002' },
        { version: '0003' },
        { version: '0004' },
        { version: '0005' },
      ]);

      const locationColumns = await pool.query<{ column_name: string }>(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'service_requests'
            AND column_name LIKE 'location_%'
          ORDER BY column_name`,
      );
      expect(locationColumns.rows).toEqual([
        { column_name: 'location_confirmed_at' },
        { column_name: 'location_latitude' },
        { column_name: 'location_longitude' },
        { column_name: 'location_source' },
      ]);
    } finally {
      await pool.end();
    }
  });
});

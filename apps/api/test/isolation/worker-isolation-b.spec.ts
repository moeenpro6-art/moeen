import { Pool } from 'pg';
import {
  TEST_RUN_ID_ENV,
  runSchemaName,
  workerSchemaName,
} from '../../src/test-db.guard';
import { quoteIdent } from '../setup/ownership';

const FILE_TAG = 'b';
const COORD_TABLE = 'q0sec_worker_isolation';
const PROBE_TABLE = 'q0sec_worker_probe';

/**
 * Q0-SEC worker-isolation proof (file B) — the mirror of
 * worker-isolation-a.spec.ts; see its doc comment for the design. Both files
 * share ONE coordination table inside the run schema and ONE probe table name
 * inside their own per-worker schemas, so any single-worker scheduling (e.g.
 * --runInBand) fails the id/schema assertions instead of passing vacuously.
 */
jest.setTimeout(120_000);

describe(`worker isolation proof ${FILE_TAG} (P2-1)`, () => {
  const runId = process.env[TEST_RUN_ID_ENV] as string;
  const workerId = process.env.JEST_WORKER_ID ?? '1';
  const mySchema = workerSchemaName(runId, workerId);
  const runSchema = runSchemaName(runId);
  const coord = `${quoteIdent(runSchema)}.${COORD_TABLE}`;

  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  it('proves cross-worker isolation against the other file', async () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    try {
      // 1. THIS worker's actual schema + its artifact inside that schema.
      const cs = await pool.query<{ cs: string }>(
        'SELECT current_schema() AS cs',
      );
      expect(cs.rows[0].cs).toBe(mySchema);
      await pool.query(
        `CREATE TABLE ${quoteIdent(mySchema)}.${PROBE_TABLE} (source TEXT NOT NULL)`,
      );
      await pool.query(
        `INSERT INTO ${quoteIdent(mySchema)}.${PROBE_TABLE} (source) VALUES ($1)`,
        [workerId],
      );

      // 2. Record this worker in the run-schema coordination table (created
      //    once by globalSetup BEFORE any worker starts — no CREATE race).
      await pool.query(
        `INSERT INTO ${coord} (worker_id, schema_name)
         VALUES ($1, $2)
         ON CONFLICT (worker_id) DO UPDATE
           SET schema_name = EXCLUDED.schema_name, recorded_at = NOW()`,
        [workerId, mySchema],
      );

      // 3. Wait for BOTH records (the other file runs concurrently in its own
      //    worker; under --runInBand it never appears with a different id).
      const deadline = Date.now() + 90_000;
      let other: { worker_id: string; schema_name: string } | undefined;
      while (Date.now() < deadline) {
        const rows = await pool.query<{
          worker_id: string;
          schema_name: string;
        }>(`SELECT worker_id, schema_name FROM ${coord}`);
        if (rows.rows.length >= 2) {
          other = rows.rows.find((r) => r.worker_id !== workerId);
          if (other) break;
        }
        await sleep(250);
      }
      expect(other).toBeDefined();
      // The other record must be a DIFFERENT worker — fails under --runInBand.
      expect(other!.worker_id).not.toBe(workerId);
      // ...running in a DIFFERENT, canonical per-worker schema.
      expect(other!.schema_name).not.toBe(mySchema);
      expect(other!.schema_name).toBe(
        workerSchemaName(runId, other!.worker_id),
      );

      // 4. Read the other file's artifact from ITS actual schema.
      const artifact = await pool.query<{ source: string }>(
        `SELECT source FROM ${quoteIdent(other!.schema_name)}.${PROBE_TABLE}`,
      );
      expect(artifact.rows).toHaveLength(1);
      expect(artifact.rows[0].source).toBe(other!.worker_id);
    } finally {
      await pool.end();
    }
  });
});

import { Pool, type PoolClient } from 'pg';
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
import {
  classifyOwnedSchemaByOid,
  dropOwnedSchemaAtomically,
  enumerateMarkedSchemas,
  isOwnershipClientDiscarded,
  releaseOwnershipClient,
  type MarkedSchemaRow,
  type SchemaClassification,
} from './ownership';

/** Safely reduces any thrown value to a short, secret-free refusal reason. */
function refusalReason(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message.trim()
    : 'unexpected failure';
}

/**
 * Q0-SEC global teardown: drops ONLY this run's schemas, and only after
 * PROVING ownership. The run schema name is computed ONCE from the run id
 * through the same canonicalization used at creation (runSchemaName), and
 * every worker schema of this run is dropped through the same atomic
 * ownership routine: one transaction per schema with an OID-keyed advisory
 * lock, an explicitly directed search_path, qualified marker reads (row
 * locked and re-read), a transactional rename to a fresh name with an OID
 * re-verify binding the destructive DDL to the verified namespace
 * (identity-safe — a concurrent rename/swap can never redirect the DROP to
 * an unverified schema), a dependency-safe gate (every dependent object
 * outside the owned namespace is enumerated from pg_depend and refused
 * unless explicitly proven safe and owned) and a CASCADE-FREE destructive
 * step (every owned root object is dropped with its own no-CASCADE DROP; a
 * dependency created AFTER the gate makes that DROP fail and the whole
 * transaction rolls back — no external object can ever be deleted or
 * altered, and the namespace itself is dropped last without CASCADE).
 * Any schema without a matching marker, or with any mismatch, is REFUSED and
 * left in place; the run then fails with a safe message (no secrets). No
 * glob/LIKE wipe is ever used for deletion — only exact verified names.
 *
 * WORKER DISCOVERY IS TWO-PRONGED because a schema NAME is mutable:
 * (1) name-based enumeration (moeen_test_<runId>_w<workerId>, tight prefix +
 *     exact client-side shape check) finds this run's worker schemas under
 *     their canonical names and surfaces name-lookalikes (which are refused);
 * (2) marker-IDENTITY enumeration (every non-system schema carrying an
 *     ownership marker table, classified by the marker's run id) finds owned
 *     schemas REGARDLESS of their current name — an owned worker schema
 *     renamed before teardown no longer matches the name pattern, but its
 *     immutable ownership marker still proves it belongs to this run, so it
 *     is discovered and cleaned through the same atomic routine. Discovery is
 *     keyed on the DURABLE namespace OID: the classification re-resolves the
 *     current name from the OID with a bounded retry loop, so a rename that
 *     lands AFTER the enumeration (the rename-after-enumeration race) is
 *     still resolved, and a rename landing between classification and drop is
 *     re-resolved and retried once. A marker naming a DIFFERENT run (e.g. a
 *     parallel run still in flight) is deterministically foreign and
 *     preserved untouched; a missing/unreadable or non-unique marker is
 *     AMBIGUOUS ownership and refuses fail-closed. A drop refusal under a
 *     name that NO LONGER EXISTS is not recorded: the schema was either
 *     renamed (the marker-identity net re-resolves it) or consumed
 *     concurrently — nothing is left at that name to refuse about.
 *
 * ORDER OF OPERATIONS (cleanup is CONTINUE-safe, ownership is fail-closed):
 * every independently verifiable WORKER schema is enumerated and cleaned
 * FIRST, before the run anchor is even attempted. Each candidate goes through
 * its OWN independent atomic ownership verification; a foreign/unexpected
 * schema causes that single schema to be refused and recorded, but cleanup
 * keeps going so that one leaked or lookalike schema cannot prevent the rest
 * of the run's owned schemas from being cleaned up. The run ANCHOR schema is
 * processed LAST and is refused/recorded like any other schema — a
 * missing, corrupt, or foreign anchor can therefore NEVER prevent the valid
 * owned worker schemas from being cleaned safely. All refusals (schema name +
 * safe reason) are aggregated, and only after every independently safe
 * cleanup attempt has completed does teardown throw one fail-closed error.
 * A failed transaction rollback is the exception: that client is discarded,
 * so teardown aborts rather than issuing another query on an unhealthy session.
 */
export default async function globalTeardown(): Promise<void> {
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
  const tokenHash = ownerTokenHash(ownerToken);

  // P1-1: the target schema is computed exactly once, with the same
  // canonicalization and length bounds used at creation. This is the ONLY
  // name the run anchor may ever be dropped under.
  const schema = runSchemaName(runId);
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
  // Aggregated safe refusals: schema name + the underlying (secret-free)
  // refusal reason. Every independently safe cleanup attempt completes before
  // any aggregated error is thrown.
  const skipped: { schema: string; reason: string }[] = [];
  const recordRefusal = (name: string, error: unknown): void => {
    skipped.push({ schema: name, reason: refusalReason(error) });
    process.stdout.write(`[test-db] skipped schema (not owned): ${name}\n`);
  };
  try {
    const client = await pool.connect();
    try {
      // 1. WORKER schemas FIRST — NAME-BASED enumeration. Tight prefix +
      //    exact client-side shape check; each candidate is then dropped only
      //    after its OWN independent atomic ownership verification (marker,
      //    run id, token hash) — a lookalike schema without a valid marker is
      //    refused, recorded, and skipped so the rest of the cleanup still
      //    runs. A refusal under a name that NO LONGER EXISTS is benign (the
      //    schema was renamed — the marker-identity step re-resolves it — or
      //    consumed concurrently) and is not recorded.
      const candidates = await pool.query<{ nspname: string }>(
        `SELECT nspname FROM pg_namespace WHERE nspname LIKE $1`,
        [`moeen_test_${runId}_w%`],
      );
      const workerShape = new RegExp(`^moeen_test_${runId}_w[1-9]\\d{0,1}$`);
      for (const row of candidates.rows) {
        if (!workerShape.test(row.nspname)) {
          continue;
        }
        try {
          await dropOwnedSchemaAtomically(
            client,
            row.nspname,
            runId,
            tokenHash,
          );
          process.stdout.write(`[test-db] dropped schema: ${row.nspname}\n`);
        } catch (error) {
          if (isOwnershipClientDiscarded(client)) {
            throw error;
          }
          if (await schemaExistsAt(client, row.nspname)) {
            recordRefusal(row.nspname, error);
          }
        }
      }

      // 2. WORKER schemas — MARKER-IDENTITY enumeration keyed on the DURABLE
      //    namespace OID. A schema NAME is mutable: an owned worker schema
      //    renamed before teardown no longer matches the pattern above and
      //    would leak. The ownership marker is the immutable identity, so
      //    every non-system schema carrying a marker table is enumerated here
      //    with its OID and classified by the marker's run id (under the same
      //    OID-keyed advisory lock the atomic drop routine takes):
      //    - a single-row marker naming THIS run proves ownership regardless
      //      of the current name — the renamed schema is cleaned through the
      //      SAME atomic routine (which re-verifies run id, token hash and
      //      identity before any destructive DDL);
      //    - a marker naming a DIFFERENT run (a parallel run still in flight,
      //      or a stale leftover from an older run) is deterministically
      //      foreign — preserved untouched, never refused or dropped;
      //    - a missing/unreadable or non-unique marker is AMBIGUOUS ownership
      //      — fail closed: the schema is preserved and the refusal is
      //      recorded. The run anchor is excluded here by name; its canonical
      //      name is processed by its own exact-name step LAST (a renamed
      //      anchor no longer matches that name, so it falls into this net
      //      and is cleaned by its marker).
      const marked = await enumerateMarkedSchemas(pool, schema);
      for (const row of marked) {
        await classifyAndDropWorker(
          client,
          row,
          runId,
          tokenHash,
          recordRefusal,
        );
      }

      // 3. The run ANCHOR schema LAST. Refused and recorded like any other
      //    schema when the ownership proof fails — an anchor problem is
      //    aggregated, never a terminal abort that could skip worker cleanup.
      //    A refusal under the canonical name that NO LONGER EXISTS is benign
      //    (the anchor was renamed — the marker-identity step above already
      //    re-resolved and cleaned it — or consumed concurrently).
      try {
        await dropOwnedSchemaAtomically(client, schema, runId, tokenHash);
        process.stdout.write(`[test-db] dropped schema: ${schema}\n`);
      } catch (error) {
        if (isOwnershipClientDiscarded(client)) {
          throw error;
        }
        if (await schemaExistsAt(client, schema)) {
          recordRefusal(schema, error);
        }
      }
    } finally {
      releaseOwnershipClient(client);
    }
  } finally {
    await pool.end();
  }

  if (skipped.length > 0) {
    throw new TestDatabaseGuardError(
      `Q0-SEC teardown: refused to drop ${skipped.length} schema(s) not owned by this run: ${skipped
        .map((s) => `${s.schema} (${s.reason})`)
        .join(', ')}.`,
    );
  }
}

/**
 * Classifies one marker-bearing candidate by its DURABLE OID and drops it
 * when it belongs to this run. The classification re-resolves the current
 * name from the OID (bounded retry), and when the atomic drop refuses — a
 * concurrent rename can land between classification and drop — the
 * classification is repeated once from the OID and the drop retried under
 * the re-resolved name. A refusal is recorded ONLY when the refused name
 * still exists: a name that vanished was either renamed (and is re-resolved
 * here or in the next candidate's classification) or consumed concurrently —
 * in both cases nothing is left at that name, and a schema with OUR marker
 * can never be silently lost (the retry re-resolves it or the refusal names
 * it).
 */
async function classifyAndDropWorker(
  client: PoolClient,
  row: MarkedSchemaRow,
  runId: string,
  tokenHash: string,
  recordRefusal: (name: string, error: unknown) => void,
): Promise<void> {
  let classification: SchemaClassification | null;
  try {
    classification = await classifyOwnedSchemaByOid(
      client,
      row.nsOid,
      row.markerOid,
    );
  } catch (error) {
    if (isOwnershipClientDiscarded(client)) {
      throw error;
    }
    // Ambiguous ownership: never guess, never delete — fail closed.
    recordRefusal(row.nspname, error);
    return;
  }
  if (!classification || classification.runId !== runId) {
    // Vanished (concurrent cleanup) or deterministically foreign — preserve.
    return;
  }
  try {
    await dropOwnedSchemaAtomically(
      client,
      classification.currentName,
      runId,
      tokenHash,
    );
    process.stdout.write(
      `[test-db] dropped schema: ${classification.currentName}\n`,
    );
    return;
  } catch (error) {
    if (isOwnershipClientDiscarded(client)) {
      throw error;
    }
    // A concurrent rename may have landed between classification and drop:
    // re-resolve the CURRENT name from the durable OID and retry once.
    try {
      const again = await classifyOwnedSchemaByOid(
        client,
        row.nsOid,
        row.markerOid,
      );
      if (again && again.runId === runId) {
        await dropOwnedSchemaAtomically(
          client,
          again.currentName,
          runId,
          tokenHash,
        );
        process.stdout.write(
          `[test-db] dropped schema: ${again.currentName}\n`,
        );
        return;
      }
    } catch (retryError) {
      if (isOwnershipClientDiscarded(client)) {
        throw retryError;
      }
      // Fall through to the refusal below (the retry itself refused).
    }
    const currentName = await currentNameOfOid(client, row.nsOid);
    if (currentName) {
      recordRefusal(currentName, error);
    }
  }
}

/**
 * Resolves the CURRENT name of a namespace from its DURABLE OID (a schema
 * NAME is mutable; the OID is not). Returns `null` when the namespace no
 * longer exists (a concurrent cleanup consumed it — nothing is left to
 * refuse). Used to record a teardown refusal under the schema's ACTUAL
 * current name, so a concurrent rename can never erase the refusal of an
 * owned schema that is still present.
 */
async function currentNameOfOid(
  client: PoolClient,
  nsOid: number,
): Promise<string | null> {
  const res = await client.query<{ nspname: string }>(
    'SELECT nspname FROM pg_namespace WHERE oid = $1::oid',
    [nsOid],
  );
  return res.rows[0]?.nspname ?? null;
}

/** True when a schema still exists under `name` (on the given client). */
async function schemaExistsAt(
  client: PoolClient,
  name: string,
): Promise<boolean> {
  const res = await client.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1',
    [name],
  );
  return res.rows[0]?.n === 1;
}

import 'dotenv/config';
import { Pool } from 'pg';
import {
  TestDatabaseGuardError,
  TestReachableRole,
  TestRoleMembership,
  TestRoleSnapshot,
  applicationDatabaseIdentity,
  assertSafeRoleReachability,
  assertSafeTestRoleSnapshot,
  assertTestDatabaseUrl,
  getForbiddenMembershipRoles,
  ownerTokenHash,
  parseEffectiveConnection,
  resolveReachableRoles,
  runSchemaName,
  TEST_OWNER_TOKEN_ENV,
  TEST_RUN_ID_ENV,
  validateOwnerToken,
  validateTestRunId,
} from '../../src/test-db.guard';
import {
  createOwnedSchema,
  classifyOwnedSchemaByOid,
  dropOwnedSchemaAtomically,
  enumerateMarkedSchemas,
  quoteIdent,
  releaseOwnershipClient,
} from './ownership';

/**
 * Q0-SEC global setup: runs once per jest invocation, before any test file.
 * Validates the inherited run environment, runs the role privilege preflight
 * (fail-closed), then creates the run-unique schema (moeen_test_<runId>) and
 * records an ownership marker INSIDE it. The run id, the owner token and the
 * run-specific TEST_DATABASE_URL come from scripts/with-test-env.js — this
 * hook never generates or rewrites environment variables.
 *
 * FAIL-CLOSED COMMIT-OUTCOME SAFETY: an error returned while COMMIT is being
 * processed is AMBIGUOUS — PostgreSQL may have committed even though the
 * client received an error (database or network failure between the server
 * writing the commit record and the client reading the acknowledgement). The
 * absence of a commit acknowledgement therefore NEVER proves rollback, and
 * the default globalTeardown will not run because Jest skips it when
 * globalSetup throws. Every setup failure therefore triggers a fail-closed
 * reconciliation (see reconcilePotentiallyCommittedRunSchema): the database
 * is probed for the run schema; a schema whose ownership marker matches this
 * run is cleaned up (never assumed rolled back), a foreign schema is never
 * touched and is explicitly refused, and a probe that cannot be answered
 * fails closed. This guarantees no owned run-schema leak can survive a
 * setup failure.
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
  const tokenHash = ownerTokenHash(ownerToken);

  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  try {
    // P2: fail-closed role preflight — a safe, dedicated, non-superuser test
    // role is required; no wide-privilege fallback is ever used.
    await assertSafeTestRole(pool);

    // Q0-SEC recursive role-membership gap: the identity/attribute preflight
    // above validates the CURRENT role; this second boundary enumerates every
    // role reachable via PostgreSQL 16 INHERIT, SET or ADMIN semantics and
    // refuses when ANY reachable role carries a dangerous attribute or is a
    // predefined role (pg_checkpoint, pg_create_subscription, ...).
    await assertSafeRoleReachabilityOfSession(pool);

    // Plain CREATE SCHEMA (no IF NOT EXISTS): a schema that already exists
    // under this run's name must FAIL the run, never be adopted. The
    // ownership marker (run id + SHA-256 of this run's owner token) is
    // recorded INSIDE the freshly created schema; teardown refuses to drop
    // without a matching marker, so no run can ever drop another run's (or a
    // shared) schema.
    await createOwnedSchema(pool, schema, runId, tokenHash);

    // Worker-isolation coordination table INSIDE the run schema: the two
    // isolation probes (test/isolation) record their JEST_WORKER_ID + actual
    // schema here and cross-read each other's artifact. It is created here,
    // BEFORE any worker starts, so the probes never race a CREATE — they only
    // INSERT/UPDATE rows. Dropped together with the run schema at teardown.
    await pool.query(
      `CREATE TABLE ${quoteIdent(schema)}.q0sec_worker_isolation (
         worker_id TEXT PRIMARY KEY,
         schema_name TEXT NOT NULL,
         recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
    );

    // The role must be able to manage its own run schema. The check is
    // performed against the run schema explicitly (not current_schema()), so
    // an inherited URL that is still pointing at the base schema fails here
    // deterministically.
    const own = await pool.query<{ ok: boolean }>(
      `SELECT has_schema_privilege($1::regnamespace, 'CREATE') AS ok`,
      [schema],
    );
    if (!own.rows[0]?.ok) {
      throw new TestDatabaseGuardError(
        'Q0-SEC privilege preflight: the test role cannot manage its own run schema — refusing to run.',
      );
    }
  } catch (error) {
    // Q0-SEC FAIL-CLOSED COMMIT-OUTCOME HANDLING: an error returned while
    // COMMIT is being processed is ambiguous — PostgreSQL may have committed
    // even though the client received an error. The error alone therefore
    // NEVER proves the schema was rolled back. Reconcile the run schema
    // against the database: a potentially-committed OWNED schema is cleaned
    // up, a FOREIGN schema is never touched and is explicitly refused, and
    // an unverifiable state fails closed. If the reconciliation itself
    // refuses (or cannot verify), it throws its own fail-closed error; only
    // when nothing was committed does the original error propagate.
    await reconcilePotentiallyCommittedRunSchema(
      pool,
      schema,
      runId,
      tokenHash,
      error,
    );
    throw error;
  } finally {
    await pool.end();
  }
  process.stdout.write(`[test-db] run schema: ${schema}\n`);
}

/** Safely reduces any thrown value to a short, secret-free reason string. */
function safeErrorText(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message.trim()
    : 'unexpected failure';
}

/**
 * Q0-SEC fail-closed reconciliation of an AMBIGUOUS commit outcome.
 *
 * A database/network error returned while COMMIT is being processed may be
 * ambiguous: PostgreSQL may have committed the transaction even though the
 * client received an error. The cleanup path MUST NOT assume that a failed
 * COMMIT response proves rollback and thereby skip cleanup of a schema that
 * actually committed. This routine runs for EVERY globalSetup failure and
 * settles the ambiguity against the database itself:
 *
 *   1. PROBE — does the run schema currently exist under its canonical name?
 *      A probe that cannot be answered fails closed (explicit refusal; the
 *      schema must be checked and removed manually).
 *   2. PRESENT — the commit may have landed. Ownership is verified through
 *      the SAME atomic routine teardown uses (dropOwnedSchemaAtomically):
 *      marker table inside the schema, run id + owner-token hash match, the
 *      destructive DDL bound to the verified namespace OID, external
 *      dependencies refused. A matching marker proves the schema IS this
 *      run's potentially-committed owned schema and it is dropped — no owned
 *      run-schema leak survives a failed setup. A missing, unreadable,
 *      non-unique or non-matching marker means the schema is FOREIGN: it is
 *      NEVER touched and the refusal is surfaced.
 *   3. ABSENT at the canonical name — NOT proof that nothing committed: a
 *      schema NAME is mutable, and an owned schema renamed before this probe
 *      would be mistaken for rollback and leaked (MEDIUM final-review
 *      finding). The probe is therefore cross-checked by DURABLE
 *      MARKER-IDENTITY: every marker-bearing schema is classified by its
 *      namespace OID, and a schema whose marker carries THIS run's id AND
 *      owner-token hash (an unforgeable 256-bit capability only this run's
 *      createOwnedSchema writes) is this run's potentially-committed schema
 *      under whatever name it currently has — it is dropped through the same
 *      atomic routine. Only when BOTH the canonical-name probe and the
 *      identity search are empty is the outcome truly "nothing committed".
 *      The identity search is keyed on the durable OID (classifyOwnedSchemaByOid),
 *      so a rename racing the search cannot hide the schema, and it fails
 *      closed when a schema's ownership cannot be classified (never guessed).
 *   4. CLEANUP REFUSAL — if the atomic drop refuses or the connection fails,
 *      the schema is re-probed (canonical name AND identity): if it is gone
 *      (concurrent cleanup), nothing leaked and the original error propagates
 *      unchanged; if it still exists, the failure becomes an EXPLICIT REFUSAL
 *      naming both the original error and the cleanup refusal — the schema is
 *      left in place and is never silently assumed rolled back.
 */
async function reconcilePotentiallyCommittedRunSchema(
  pool: Pool,
  schema: string,
  runId: string,
  tokenHash: string,
  originalError: unknown,
): Promise<void> {
  const probe = async (): Promise<boolean> => {
    const res = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1',
      [schema],
    );
    return res.rows[0]?.n === 1;
  };
  const refuseCritical = (detail: string): never => {
    throw new TestDatabaseGuardError(
      `Q0-SEC globalSetup: CRITICAL — the run schema '${schema}' was potentially committed (ambiguous COMMIT outcome) and still exists, but its cleanup was refused: ${detail}. The schema was left in place and must be removed manually. Original error: ${safeErrorText(originalError)}.`,
    );
  };

  let exists: boolean;
  try {
    exists = await probe();
  } catch (probeError) {
    throw new TestDatabaseGuardError(
      `Q0-SEC globalSetup: after a setup failure the run schema '${schema}' could not be verified (${safeErrorText(probeError)}) — an ambiguous COMMIT may have committed it, so it MUST be checked and removed manually if present. Original error: ${safeErrorText(originalError)}.`,
    );
  }

  // Drop one verified owned schema by its current name; returns false when
  // the schema is gone afterwards (concurrent cleanup) and true when it was
  // cleaned here. Throws the atomic-drop refusal on failure.
  const dropOwnedByName = async (
    currentName: string,
    alreadyCleaned: (name: string) => void,
  ): Promise<void> => {
    const client = await pool.connect();
    try {
      await dropOwnedSchemaAtomically(client, currentName, runId, tokenHash);
      alreadyCleaned(currentName);
    } finally {
      releaseOwnershipClient(client);
    }
  };

  if (exists) {
    // The canonical name is occupied — the commit may have landed there (or
    // a foreign schema holds the name). The atomic routine decides.
    try {
      await dropOwnedByName(schema, (name) => {
        process.stdout.write(
          `[test-db] cleaned up potentially-committed run schema: ${name}\n`,
        );
      });
      return;
    } catch (dropError) {
      // The canonical-name drop refused. A concurrent session may have
      // renamed OUR committed schema away and left a foreign schema at the
      // canonical name: reconcile by durable marker identity before
      // concluding. Our schema (if any) is cleaned; the canonical name is
      // then re-probed to decide the final outcome.
      const ours = await findOwnedSchemaByMarkerIdentity(
        pool,
        runId,
        tokenHash,
      );
      if (ours) {
        try {
          await dropOwnedByName(ours.currentName, (name) => {
            process.stdout.write(
              `[test-db] cleaned up potentially-committed run schema: ${name}\n`,
            );
          });
        } catch (identityDropError) {
          if (await findOwnedSchemaByMarkerIdentity(pool, runId, tokenHash)) {
            refuseCritical(
              `the owned schema was found by marker identity but its cleanup was refused: ${safeErrorText(
                identityDropError,
              )}`,
            );
          }
          return; // concurrent cleanup consumed it — nothing leaked.
        }
      }
      // Re-probe the canonical name to distinguish "a concurrent cleanup
      // consumed it" (nothing leaked) from "the foreign/owned schema is
      // still there" (explicit refusal — never silently assumed rolled back).
      let stillExists = true;
      try {
        stillExists = await probe();
      } catch {
        stillExists = true;
      }
      if (!stillExists) {
        return;
      }
      refuseCritical(safeErrorText(dropError));
    }
  }

  // The canonical name is ABSENT. A committed owned schema renamed before
  // this probe would be invisible here — reconcile by durable marker
  // identity (OID-keyed classification, fail-closed on ambiguity) before
  // concluding that nothing was committed.
  const ours = await findOwnedSchemaByMarkerIdentity(pool, runId, tokenHash);
  if (!ours) {
    // Nothing committed (or nothing owned remains) — the original error
    // propagates unchanged.
    return;
  }
  try {
    await dropOwnedByName(ours.currentName, (name) => {
      process.stdout.write(
        `[test-db] cleaned up potentially-committed run schema: ${name}\n`,
      );
    });
  } catch (dropError) {
    // Re-probe by identity: gone (concurrent cleanup) → nothing leaked;
    // still there → explicit refusal.
    const still = await findOwnedSchemaByMarkerIdentity(
      pool,
      runId,
      tokenHash,
    ).catch(() => null);
    if (!still) {
      return;
    }
    refuseCritical(safeErrorText(dropError));
  }
}

/**
 * Finds THIS run's potentially-committed schema by its DURABLE ownership
 * marker (run id AND owner-token hash — the token hash is a random 256-bit
 * capability only this run's createOwnedSchema writes), regardless of the
 * schema's current name. Returns `null` when no schema carries this run's
 * marker. Fails closed when any marker-bearing schema cannot be classified
 * (ambiguous ownership) — never guessed, never silently skipped.
 */
async function findOwnedSchemaByMarkerIdentity(
  pool: Pool,
  runId: string,
  tokenHash: string,
): Promise<{ currentName: string } | null> {
  const marked = await enumerateMarkedSchemas(pool, null);
  const matches: { currentName: string }[] = [];
  const client = await pool.connect();
  try {
    for (const row of marked) {
      let classification;
      try {
        classification = await classifyOwnedSchemaByOid(
          client,
          row.nsOid,
          row.markerOid,
        );
      } catch (error) {
        throw new TestDatabaseGuardError(
          `Q0-SEC globalSetup: after a setup failure a marker-bearing schema could not be classified (${refusalReason(
            error,
          )}) — an ambiguous COMMIT may have committed the run schema, so it MUST be checked and removed manually if present. Original error context: ${safeErrorText(
            error,
          )}.`,
        );
      }
      if (!classification) {
        continue;
      }
      if (
        classification.runId === runId &&
        classification.ownerTokenHash === tokenHash
      ) {
        matches.push({ currentName: classification.currentName });
      }
    }
  } finally {
    releaseOwnershipClient(client);
  }
  if (matches.length > 1) {
    throw new TestDatabaseGuardError(
      `Q0-SEC globalSetup: CRITICAL — more than one schema carries this run's ownership marker (${matches
        .map((m) => m.currentName)
        .join(
          ', ',
        )}); the ambiguous COMMIT outcome cannot be settled safely — the schemas were left in place and must be removed manually.`,
    );
  }
  return matches[0] ?? null;
}

/** Safely reduces any thrown value to a short, secret-free reason string. */
function refusalReason(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message.trim()
    : 'unexpected failure';
}

/**
 * P2 — fail-closed privilege preflight. The role used by automated tests must
 * be exactly the dedicated restricted test role (moeen_test_runner) that
 * matches the TEST_DATABASE_URL user: not postgres, not moeen_app, not a
 * superuser, no wide privilege flags (CREATEDB/CREATEROLE/REPLICATION/
 * BYPASSRLS), no CREATE on the public schema, on the shared 'moeen_test'
 * schema, on the application database, and NO CONNECT on the application
 * database either (the runner must not even be able to reach 'moeen'); the
 * runner must have CONNECT on the dedicated test database. session_user,
 * current_user and the URL user must ALL agree (a SET ROLE is refused), and
 * every collected fact must be a real boolean. If any check fails, the run is
 * refused — no fallback to a wide-privilege role. The rules live in the
 * guard's pure assertSafeTestRoleSnapshot (table-driven tested); this hook
 * only collects the live facts.
 */
export async function collectTestRoleSnapshot(
  pool: Pool,
  applicationDatabase = applicationDatabaseIdentity(process.env).database,
  testDatabase = parseEffectiveConnection(process.env.TEST_DATABASE_URL ?? '')
    .database,
): Promise<TestRoleSnapshot> {
  const role = await pool.query<{
    session_name: string;
    name: string;
    super: boolean;
    createdb: boolean;
    createrole: boolean;
    replication: boolean;
    bypassrls: boolean;
    pub_create: boolean;
    shared_create: boolean;
    appdb_create: boolean;
    app_connect: boolean;
    forbidden_member: boolean;
    can_connect_testdb: boolean;
  }>(
    `SELECT session_user AS session_name,
            current_user AS name,
            (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS super,
            (SELECT rolcreatedb FROM pg_roles WHERE rolname = current_user) AS createdb,
            (SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user) AS createrole,
            (SELECT rolreplication FROM pg_roles WHERE rolname = current_user) AS replication,
            (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypassrls,
            has_schema_privilege('public', 'CREATE') AS pub_create,
            has_schema_privilege('moeen_test', 'CREATE') AS shared_create,
            has_database_privilege($1::name, 'CREATE') AS appdb_create,
            has_database_privilege($1::name, 'CONNECT') AS app_connect,
            has_database_privilege($2::name, 'CONNECT') AS can_connect_testdb,
            EXISTS (
              SELECT 1
                FROM unnest($3::text[]) AS forbidden(role_name)
                JOIN pg_roles r ON r.rolname = forbidden.role_name
               WHERE pg_has_role(current_user, r.oid, 'MEMBER')
            ) AS forbidden_member`,
    [
      applicationDatabase,
      testDatabase,
      Array.from(getForbiddenMembershipRoles()),
    ],
  );
  const row = role.rows[0];
  if (!row) {
    throw new TestDatabaseGuardError(
      'Q0-SEC privilege preflight: could not read the connected role facts — refusing to run.',
    );
  }
  return {
    sessionUser: row.session_name,
    currentUser: row.name,
    isSuperuser: row.super,
    canCreateDb: row.createdb,
    canCreateRole: row.createrole,
    isReplicationRole: row.replication,
    bypassesRls: row.bypassrls,
    canCreateInPublic: row.pub_create,
    canCreateInSharedTestSchema: row.shared_create,
    canCreateOnAppDatabase: row.appdb_create,
    canConnectAppDatabase: row.app_connect,
    isMemberOfForbiddenRoles: row.forbidden_member,
    canConnectTestDatabase: row.can_connect_testdb,
  };
}

async function assertSafeTestRole(pool: Pool): Promise<void> {
  const testConnection = parseEffectiveConnection(
    process.env.TEST_DATABASE_URL ?? '',
  );
  const appIdentity = applicationDatabaseIdentity(process.env);
  const snapshot = await collectTestRoleSnapshot(
    pool,
    appIdentity.database,
    testConnection.database,
  );
  assertSafeTestRoleSnapshot(snapshot, testConnection.user);
}

/**
 * Q0-SEC — SET ROLE privilege-boundary preflight (recursive escalation gap).
 *
 * The identity/attribute snapshot above validates the role the session is
 * CURRENTLY using. PostgreSQL's SET ROLE lets the session switch to any role
 * reachable through membership — directly or recursively — and the
 * switched-to role's attributes apply immediately. This routine enumerates
 * the FULL closure of roles the connected session can actually SET ROLE to
 * using all PG16 membership semantics: inherit_option, set_option and
 * admin_option (an admin member can self-grant), plus implicit
 * pg_database_owner membership when a reachable role owns the current
 * database. It refuses the run when ANY reachable role carries a dangerous
 * attribute or is a PostgreSQL predefined system role (the 'pg_' prefix is
 * reserved by PostgreSQL itself for system roles). The pure graph resolver
 * and rules live in the guard; this hook only collects live catalogs.
 *
 * Ordering matters: this runs AFTER assertSafeTestRole, so a superuser /
 * CREATEROLE session is already refused before its (potentially
 * under-enumerated) closure is ever considered — fail-closed by construction.
 */
export async function collectReachableRoles(
  pool: Pool,
): Promise<TestReachableRole[]> {
  const roles = await pool.query<{
    role_name: string;
    super: boolean;
    createdb: boolean;
    createrole: boolean;
    replication: boolean;
    bypassrls: boolean;
    predefined: boolean;
    database_owner: string;
  }>(
    `SELECT r.rolname AS role_name,
            r.rolsuper AS super,
            r.rolcreatedb AS createdb,
            r.rolcreaterole AS createrole,
            r.rolreplication AS replication,
            r.rolbypassrls AS bypassrls,
            (r.rolname LIKE 'pg\\_%') AS predefined,
            (SELECT d.datdba::regrole::text
               FROM pg_database d
              WHERE d.datname = current_database()) AS database_owner
       FROM pg_roles r`,
  );
  const roleFacts = roles.rows.map((row) => ({
    roleName: row.role_name,
    isSuperuser: row.super,
    canCreateDb: row.createdb,
    canCreateRole: row.createrole,
    isReplicationRole: row.replication,
    bypassesRls: row.bypassrls,
    isPredefinedSystemRole: row.predefined,
  }));
  const databaseOwners = new Set(roles.rows.map((row) => row.database_owner));
  const [databaseOwner] = databaseOwners;
  if (databaseOwners.size !== 1 || !databaseOwner) {
    throw new TestDatabaseGuardError(
      'Q0-SEC privilege preflight: could not determine the current database owner — refusing to run.',
    );
  }
  const memberships = await pool.query<{
    member_role_name: string;
    target_role_name: string;
    inherit_option: boolean;
    set_option: boolean;
    admin_option: boolean;
  }>(
    `SELECT member_role.rolname AS member_role_name,
            target_role.rolname AS target_role_name,
            m.inherit_option,
            m.set_option,
            m.admin_option
       FROM pg_auth_members m
       JOIN pg_roles member_role ON member_role.oid = m.member
       JOIN pg_roles target_role ON target_role.oid = m.roleid`,
  );
  const membershipFacts: TestRoleMembership[] = memberships.rows.map((row) => ({
    memberRoleName: row.member_role_name,
    targetRoleName: row.target_role_name,
    inheritOption: row.inherit_option,
    setOption: row.set_option,
    adminOption: row.admin_option,
  }));
  return resolveReachableRoles(
    roleFacts,
    membershipFacts,
    parseEffectiveConnection(process.env.TEST_DATABASE_URL ?? '').user,
    databaseOwner,
  );
}

async function assertSafeRoleReachabilityOfSession(pool: Pool): Promise<void> {
  const urlUser = parseEffectiveConnection(
    process.env.TEST_DATABASE_URL ?? '',
  ).user;
  const reachable = await collectReachableRoles(pool);
  assertSafeRoleReachability(reachable, urlUser);
}

import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { TestDatabaseGuardError } from '../../src/test-db.guard';

/** Safely reduces any thrown value to a short, secret-free refusal reason. */
function safeErrorText(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message.trim()
    : 'unexpected failure';
}

// A rollback failure means the session state is unknowable. The client is
// discarded immediately through node-postgres' unhealthy release path; this
// WeakSet lets the owning caller's normal finally block avoid a second release.
const discardedOwnershipClients = new WeakSet<PoolClient>();

function releaseErrorFor(rollbackError: unknown): Error {
  return rollbackError instanceof Error
    ? rollbackError
    : new Error('PostgreSQL transaction rollback failed.');
}

/** Keeps the original operation error primary while retaining rollback context. */
function withRollbackContext(
  operationError: unknown,
  rollbackError: unknown,
): unknown {
  if (operationError instanceof Error && Object.isExtensible(operationError)) {
    try {
      if (operationError.cause === undefined) {
        Object.defineProperty(operationError, 'cause', {
          configurable: true,
          value: rollbackError,
        });
      } else {
        Object.defineProperty(operationError, 'rollbackError', {
          configurable: true,
          value: rollbackError,
        });
      }
      return operationError;
    } catch {
      // Fall through to an AggregateError when an exotic Error object rejects
      // diagnostic properties. The original remains the first aggregated item.
    }
  }
  return new AggregateError(
    [operationError, rollbackError],
    'The ownership operation failed and its transaction could not be rolled back.',
    { cause: operationError },
  );
}

/**
 * Rolls back an ownership transaction and always rethrows the operation
 * failure. If ROLLBACK itself fails, the connection is destroyed rather than
 * returned to the pool, and the rollback error is retained as diagnostic
 * context without replacing the primary operation error.
 */
async function rollbackOrDiscard(
  client: PoolClient,
  operationError: unknown,
): Promise<never> {
  try {
    await client.query('ROLLBACK');
  } catch (rollbackError) {
    const contextualError = withRollbackContext(operationError, rollbackError);
    discardedOwnershipClients.add(client);
    try {
      client.release(releaseErrorFor(rollbackError));
    } catch (releaseError) {
      // A release failure must not mask the original operation failure. Keep
      // it as additional context when possible; the client remains marked so
      // no caller later returns it to the pool as healthy.
      if (
        contextualError instanceof Error &&
        Object.isExtensible(contextualError)
      ) {
        try {
          Object.defineProperty(contextualError, 'releaseError', {
            configurable: true,
            value: releaseError,
          });
        } catch {
          // The primary + rollback errors are still retained.
        }
      }
    }
    throw contextualError;
  }
  throw operationError;
}

/** Releases a caller-owned client unless rollback failure already discarded it. */
export function releaseOwnershipClient(client: PoolClient): void {
  if (discardedOwnershipClients.delete(client)) {
    return;
  }
  client.release();
}

export function isOwnershipClientDiscarded(client: PoolClient): boolean {
  return discardedOwnershipClients.has(client);
}

/**
 * Q0-SEC shared schema-ownership helpers, used by global-setup, the per-worker
 * setup hook and the teardown hook (and by tests that fabricate temporary
 * schemas). Every schema the test infrastructure creates gets an ownership
 * marker table INSIDE it (run id + SHA-256 of the run's owner token), and
 * every drop goes through dropOwnedSchemaAtomically, which binds the marker
 * verification to the exact schema being dropped inside one transaction —
 * IDENTITY-safe (the drop is bound to the verified namespace OID, so a
 * concurrent rename/swap can never redirect it) AND DEPENDENCY-safe (before
 * the destructive DDL, the EXACT set of objects CASCADE would destroy is
 * derived from PostgreSQL's own dependency graph, and the 'owned' boundary
 * is derived from that same graph — direct namespace bindings plus internal/
 * auto/extension artifacts — so the classification is complete by
 * construction and every doomed object that does not provably belong to the
 * owned namespace is refused: CASCADE can never delete or alter anything
 * beyond the verified boundary).
 */

/** The ownership marker table name (always qualified with its schema). */
export const OWNERSHIP_MARKER_TABLE = 'q0sec_run_ownership';

/** Double-quotes a PostgreSQL identifier with escaping (defense in depth: callers validate the charset first). */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** The marker table of a schema, qualified: "schema".q0sec_run_ownership. */
export function qualifiedMarkerTable(schema: string): string {
  return `${quoteIdent(schema)}.${OWNERSHIP_MARKER_TABLE}`;
}

/**
 * The ONLY external-dependency kinds the teardown protocol may destroy
 * without violating the ownership boundary. Everything else in the doomed
 * set is REFUSED (fail-closed) before the destructive DDL, because CASCADE
 * would otherwise delete or ALTER that dependent object — an effect
 * extending outside the verified, marker-proven namespace.
 *
 * Current allowlist — `toast-of-owned-relation`, PROVEN SAFE AND OWNED by
 * construction:
 *
 *   A TOAST table (pg_class relkind 't' in the pg_toast namespace) is an
 *   invisible implementation artifact of an owned relation INSIDE the
 *   verified namespace. It carries an internal (deptype 'i') dependency on
 *   its parent table, cannot exist or outlive that parent, is never user
 *   visible or independently owned, and is destroyed by the drop only
 *   because the parent relation — which the marker proves is owned — is
 *   destroyed with it. A TOAST index (relkind 'i' in pg_toast, auto
 *   deptype 'a' on its toast table) is the same class of artifact, created
 *   lazily with the toast data and destroyed with its toast table. Requiring
 *   this exact shape (internal/auto dependency + relkind 't'/'i' + pg_toast
 *   namespace) keeps the carve-out unspoofable: no user object of any other
 *   kind can match it — pg_toast is a system namespace and every object in
 *   it is an implementation artifact of some relation.
 *
 * Extending this set requires a design review proving the new kind is both
 * safe to destroy and owned by the same run. Q0-SEC policy: teardown
 * authority NEVER extends to dependent objects outside the owned namespace
 * beyond this list — the check below refuses everything else.
 */
const ALLOWED_EXTERNAL_DEPENDENCY_KINDS: ReadonlySet<string> = new Set([
  'toast-of-owned-relation',
]);

/**
 * The shared dependency-graph closure over the verified namespace row — the
 * SINGLE source of the "doomed" boundary for BOTH halves of the destructive
 * protocol: the external-dependency scan (assertNoExternalDependents) and the
 * drop plan (computeDropPlan). Both must classify against exactly the same
 * closure semantics, so the closure lives here once and is inlined into both
 * queries.
 *
 *   doomed = the transitive closure of the verified namespace row over
 *   pg_depend (dependent → referenced), following the same arcs — and the
 *   same special cases — PostgreSQL's own drop machinery (findDependentObjects)
 *   follows when it processes a DROP SCHEMA ... CASCADE (see the
 *   assertNoExternalDependents docs for the arc-by-arc rationale).
 *
 *   owned  = the verified namespace row itself plus every object PostgreSQL
 *   binds DIRECTLY to it (rule (a)+(b) of the ownership boundary).
 *
 * The parameter is always the verified namespace OID ($1).
 */
const DEPENDENCY_CLOSURE_SQL = `
  WITH RECURSIVE doomed AS (
    SELECT d.classid, d.objid, d.objsubid, d.deptype
      FROM pg_depend d
     WHERE d.refclassid = 'pg_namespace'::regclass
       AND d.refobjid = $1
       AND d.deptype <> 'p'
    UNION
    SELECT d.classid, d.objid, d.objsubid, d.deptype
      FROM pg_depend d
      JOIN doomed k
        ON d.refclassid = k.classid
       AND d.refobjid = k.objid
       AND (d.refobjsubid = k.objsubid
            OR (k.classid = 'pg_class'::regclass
                AND k.objsubid = 0
                AND d.refobjsubid > 0))
     WHERE d.deptype <> 'p'
  ),
  owned AS (
    -- (a) the verified namespace row itself.
    SELECT 'pg_namespace'::regclass::oid AS classid, $1::oid AS objid, 0::int AS objsubid
    UNION ALL
    -- (b) every object PostgreSQL binds DIRECTLY to the namespace row.
    --     All schema-scoped objects carry such an arc, so this covers every
    --     namespace-owned catalog — current and future — with no
    --     hand-enumerated list that could go stale.
    SELECT d.classid, d.objid, d.objsubid
      FROM pg_depend d
     WHERE d.refclassid = 'pg_namespace'::regclass
       AND d.refobjid = $1
       AND d.deptype <> 'p'
    UNION ALL
    -- (d) explicitly created casts whose source type, target type and
    --     function ALL live in the owned namespace (the automatic
    --     range→multirange casts match this same rule; a cast with any
    --     part outside the namespace stays refused, fail-closed).
    SELECT 'pg_cast'::regclass::oid, pc.oid, 0::int
      FROM pg_cast pc
      JOIN pg_type src ON src.oid = pc.castsource
      JOIN pg_type tgt ON tgt.oid = pc.casttarget
      LEFT JOIN pg_proc cf ON cf.oid = pc.castfunc
     WHERE src.typnamespace = $1
       AND tgt.typnamespace = $1
       AND (pc.castfunc = 0 OR cf.pronamespace = $1)
    UNION
    -- (c) implementation artifacts of owned objects, reached over the
    --     INTERNAL ('i'), AUTO ('a') and EXTENSION-MEMBER ('e') arcs:
    --     composite/array/multirange types, indexes, constraints (relation
    --     AND domain), column defaults, triggers, policies, rewrite rules,
    --     extension members. A dependent that is itself a namespace-
    --     carrying object (pg_class/pg_type/pg_proc) must live in the
    --     owned namespace — TOAST tables (pg_toast) therefore stay
    --     external-but-allowlisted (ALLOWED_EXTERNAL_DEPENDENCY_KINDS) and
    --     any cross-namespace artifact (e.g. a foreign partition of an
    --     owned partitioned table) is refused.
    SELECT d.classid, d.objid, d.objsubid
      FROM pg_depend d
      JOIN owned k
        ON d.refclassid = k.classid
       AND d.refobjid = k.objid
       AND (d.refobjsubid = k.objsubid
            OR (k.classid = 'pg_class'::regclass
                AND k.objsubid = 0
                AND d.refobjsubid > 0))
     WHERE d.deptype IN ('i', 'a', 'e')
       AND (d.classid NOT IN ('pg_class'::regclass, 'pg_type'::regclass, 'pg_proc'::regclass)
            OR EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = d.objid AND c.relnamespace = $1)
            OR EXISTS (SELECT 1 FROM pg_type t WHERE t.oid = d.objid AND t.typnamespace = $1)
            OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = d.objid AND p.pronamespace = $1))
  )`;

/** One row of the external-dependency scan (see assertNoExternalDependents). */
interface ExternalDependentRow {
  dep_catalog: string;
  dep_oid: string;
  deptype: string;
  dep_description: string;
  dep_relkind: string | null;
  dep_schema: string | null;
}

/** Classifies an external dependency row; only allowlisted kinds pass. */
function externalDependencyKind(row: ExternalDependentRow): string {
  if (
    row.dep_catalog === 'pg_class' &&
    (row.deptype === 'i' || row.deptype === 'a') &&
    (row.dep_relkind === 't' || row.dep_relkind === 'i') &&
    row.dep_schema === 'pg_toast'
  ) {
    return 'toast-of-owned-relation';
  }
  return `unowned:${row.dep_catalog}/${row.deptype}`;
}

/**
 * Dependency-safe gate — the SECOND half of the destructive-cleanup protocol
 * (identity-safety is the first). Before the DROP SCHEMA CASCADE, compute
 * the EXACT set of objects the CASCADE would destroy and refuse the drop if
 * any of them is not provably owned by the verified namespace. BOTH halves of
 * the boundary are derived from PostgreSQL's own dependency graph — never
 * from a hand-written list of catalog names — so the classification is
 * complete by construction (an omission like the historical pg_collation gap
 * is structurally impossible):
 *
 *   doomed = the transitive closure of the verified namespace row over
 *   pg_depend (dependent → referenced), following the same arcs — and the
 *   same special cases — PostgreSQL's own drop machinery (findDependentObjects)
 *   follows when it processes a DROP SCHEMA ... CASCADE:
 *
 *     - every object in the schema has a dependency arc ON the namespace
 *       row, so the seed is the whole schema;
 *     - a column of a destroyed relation dies with the relation, so any
 *       dependent that references a relation at COLUMN level (refobjsubid >
 *       0) is destroyed too when the relation itself is destroyed;
 *     - a view's _RETURN rewrite rule (pg_rewrite ev_type '1'; ON SELECT
 *       rules exist only on views) makes the view relation itself dependent
 *       on the rule, exactly as the drop machinery treats it — PostgreSQL
 *       records no pg_depend arc for that, so the view relation is added to
 *       the refused set in the outer query below.
 *
 *   owned = every object that legitimately lives in the verified namespace,
 *   derived from the database in four rules:
 *
 *     (a) the verified namespace row itself;
 *     (b) every object PostgreSQL binds DIRECTLY to the namespace row. All
 *         schema-scoped objects carry a pg_depend arc on their namespace —
 *         verified on PG16 for tables, views, sequences, functions (incl.
 *         auto range/multirange constructors and extension members such as
 *         pgcrypto), collations, conversions, text-search objects, statistics,
 *         base/enum/domain/range/multirange types, extension rows and more.
 *         This single rule covers EVERY namespace-owned catalog — pg_class,
 *         pg_type, pg_proc, pg_collation, pg_operator, pg_opclass,
 *         pg_opfamily, pg_conversion, pg_ts_config, pg_ts_dict, pg_ts_parser,
 *         pg_ts_template, pg_statistic_ext, pg_extension,
 *         pg_publication_namespace — including any catalog a future
 *         PostgreSQL version adds, so no hand-enumerated list can go stale;
 *     (c) the implementation artifacts of owned objects, reached over the
 *         INTERNAL ('i'), AUTO ('a') and EXTENSION-MEMBER ('e') dependency
 *         arcs — the deptypes PostgreSQL reserves for objects created with,
 *         living with and dying with their parent: composite/array/multirange
 *         types, indexes, constraints (relation AND domain), column defaults,
 *         triggers, policies, rewrite rules, extension members. A dependent
 *         that is itself a namespace-carrying object (pg_class, pg_type,
 *         pg_proc) is owned ONLY when it lives in the verified namespace —
 *         this keeps TOAST tables (pg_toast) external-but-allowlisted below
 *         and REFUSES any cross-namespace artifact (verified on PG16: a
 *         foreign table partition of an owned partitioned table is an 'a'
 *         dependent and is refused; an external column referencing an owned
 *         collation is a normal ('n') dependent and is refused, so the
 *         CASCADE that would silently drop that column can never run);
 *     (d) explicitly created casts whose source type, target type AND
 *         function all live in the verified namespace (the automatic
 *         range→multirange casts are covered by this same rule; casts with
 *         any part outside the namespace stay refused, exactly as before).
 *
 * The gate is fail-closed in BOTH directions: an object the closure reaches
 * that is NOT owned is refused (that is the containment guarantee — CASCADE
 * can no longer delete or ALTER anything beyond the verified namespace), and
 * an object class accidentally MISSED by the derivation can only cause a
 * false refusal, never a silent boundary crossing, because the boundary
 * itself is computed from the database, not enumerated. Only the allowlisted
 * toast implementation artifacts of owned relations (see
 * ALLOWED_EXTERNAL_DEPENDENCY_KINDS) may be destroyed with their parents.
 *
 * NOTE: schema-level publication bindings (pg_publication_namespace) cannot
 * be created by the restricted test role (requires superuser). A row lacking
 * a direct namespace arc would be refused (fail-closed) — unreachable for
 * this role, so the derivation needs no carve-out for it.
 */
async function assertNoExternalDependents(
  client: PoolClient,
  schemaOid: number,
  schema: string,
): Promise<void> {
  const res = await client.query<ExternalDependentRow>(
    `${DEPENDENCY_CLOSURE_SQL}
    SELECT DISTINCT
      d.classid::regclass::text AS dep_catalog,
      d.objid::text AS dep_oid,
      d.deptype,
      pg_describe_object(d.classid, d.objid, d.objsubid) AS dep_description,
      CASE WHEN d.classid = 'pg_class'::regclass
           THEN (SELECT c2.relkind FROM pg_class c2 WHERE c2.oid = d.objid)
           ELSE NULL END AS dep_relkind,
      CASE WHEN d.classid = 'pg_class'::regclass
           THEN (SELECT n2.nspname FROM pg_class c2
                   JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
                  WHERE c2.oid = d.objid)
           ELSE NULL END AS dep_schema
    FROM doomed d
    LEFT JOIN owned o ON o.classid = d.classid AND o.objid = d.objid
    WHERE o.classid IS NULL
    UNION ALL
    -- Views reached through a doomed _RETURN rewrite rule: PostgreSQL's drop
    -- machinery treats a view's relation as dependent on its _RETURN rule
    -- (ON SELECT rules exist only on views, so ev_type '1' identifies them
    -- exactly), even though no pg_depend arc records it. Add the external
    -- view relation itself to the refused set.
    SELECT DISTINCT
      'pg_class'::regclass::text AS dep_catalog,
      rw.ev_class::text AS dep_oid,
      'i'::"char" AS deptype,
      pg_describe_object('pg_class'::regclass, rw.ev_class, 0) AS dep_description,
      c.relkind AS dep_relkind,
      n.nspname AS dep_schema
    FROM pg_rewrite rw
    JOIN doomed k
      ON k.classid = 'pg_rewrite'::regclass::oid
     AND k.objid = rw.oid
     AND k.objsubid = 0
    JOIN pg_class c ON c.oid = rw.ev_class
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN owned o
      ON o.classid = 'pg_class'::regclass::oid
     AND o.objid = rw.ev_class
    WHERE rw.ev_type = '1'::"char"
      AND o.classid IS NULL`,
    [schemaOid],
  );
  const refused: ExternalDependentRow[] = [];
  const seen = new Set<string>();
  for (const row of res.rows) {
    if (ALLOWED_EXTERNAL_DEPENDENCY_KINDS.has(externalDependencyKind(row))) {
      continue;
    }
    // One refusal per distinct dependent object (an object may carry several
    // dependency arcs across the boundary).
    const key = `${row.dep_catalog}:${row.dep_oid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refused.push(row);
  }
  if (refused.length > 0) {
    throw new TestDatabaseGuardError(
      `Q0-SEC ownership: refusing to drop schema '${schema}' — dropping it would destroy ${refused.length} dependent object(s) outside the owned namespace: ${refused
        .map((r) => `${r.dep_description} (${r.deptype})`)
        .join(', ')}.`,
    );
  }
}

/**
 * Fresh, unpredictable schema name used to bind the destructive DDL to the
 * verified namespace OID (rename → re-verify → drop). 31 chars total, well
 * below the 63-byte PostgreSQL identifier cap; generated per call so two
 * teardown transactions can never target the same throwaway name.
 */
function generateTeardownName(): string {
  return `q0sec_teardown_${randomBytes(8).toString('hex')}`;
}

/**
 * One object of the DROP plan (see computeDropPlan). `classid`/`objid` are the
 * NUMERIC catalog OIDs (used for the blocker classification); `sql` is the
 * exact no-CASCADE DROP statement (or `null` for composite relations, which
 * die with their pg_type entry via DROP TYPE).
 */
interface DropPlanRoot {
  classid: string;
  objid: string;
  description: string;
  sql: string | null;
}

/** A partitioned table whose parent relation must be exclusion-locked. */
interface PartitionedTableLock {
  objid: string;
  description: string;
  sql: string;
}

/** One row of the doomed closure, materialized for the blocker classification. */
interface DoomedObject {
  classid: string;
  objid: string;
}

/** The verified destructive plan: every doomed object + the roots to drop. */
interface DropPlan {
  doomed: DoomedObject[];
  roots: DropPlanRoot[];
  partitionedTables: PartitionedTableLock[];
}

/**
 * True when `error` is PostgreSQL's dependent_objects_still_exist (2BP01) —
 * the failure a no-CASCADE DROP raises when some object still depends on the
 * target. Only this failure may be handled by deferral; everything else is a
 * fail-closed refusal.
 */
function isDependentObjectsStillExistError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '2BP01'
  );
}

/**
 * Builds the exact no-CASCADE DROP statement for one root object, qualified
 * with the FRESH teardown name (the verified namespace's current name — the
 * destructive statements only ever run under it). Returns `null` for the
 * composite RELATION of a standalone composite type (its pg_type entry is
 * dropped by DROP TYPE and takes the relation with it). An object kind this
 * switch does not recognize is refused fail-closed by the caller via the
 * 'UNSUPPORTED:' marker — the old CASCADE would have handled it silently, the
 * new protocol must never guess.
 */
function buildRootDropSql(
  root: {
    classid_text: string;
    relkind: string | null;
    relname: string | null;
    typtype: string | null;
    typname: string | null;
    prokind: string | null;
    proname: string | null;
    identity_args: string | null;
    collname: string | null;
    conname: string | null;
    cfgname: string | null;
    dictname: string | null;
    prsname: string | null;
    tmplname: string | null;
    stxname: string | null;
    extname: string | null;
    oprname: string | null;
    oprleft: string | null;
    oprright: string | null;
    opcname: string | null;
    opc_am: string | null;
    opfname: string | null;
    opf_am: string | null;
    castsrc: string | null;
    casttgt: string | null;
  },
  freshSchema: string,
): string | null {
  const fq = (name: string): string =>
    `${quoteIdent(freshSchema)}.${quoteIdent(name)}`;
  switch (root.classid_text) {
    case 'pg_class':
      if (root.relkind === 'r' || root.relkind === 'p') {
        return `DROP TABLE ${fq(root.relname!)}`;
      }
      if (root.relkind === 'v') return `DROP VIEW ${fq(root.relname!)}`;
      if (root.relkind === 'm') {
        return `DROP MATERIALIZED VIEW ${fq(root.relname!)}`;
      }
      if (root.relkind === 'S') return `DROP SEQUENCE ${fq(root.relname!)}`;
      if (root.relkind === 'f') {
        return `DROP FOREIGN TABLE ${fq(root.relname!)}`;
      }
      if (root.relkind === 'c') {
        // Composite relation of a standalone composite type — DROP TYPE on
        // its pg_type entry drops the relation with it; nothing to emit.
        return null;
      }
      return `UNSUPPORTED:pg_class/${root.relkind ?? '?'}`;
    case 'pg_type':
      return `DROP TYPE ${fq(root.typname!)}`;
    case 'pg_proc':
      if (root.prokind === 'p') {
        return `DROP PROCEDURE ${fq(root.proname!)}(${root.identity_args})`;
      }
      if (root.prokind === 'a') {
        return `DROP AGGREGATE ${fq(root.proname!)}(${root.identity_args})`;
      }
      return `DROP FUNCTION ${fq(root.proname!)}(${root.identity_args})`;
    case 'pg_collation':
      return `DROP COLLATION ${fq(root.collname!)}`;
    case 'pg_conversion':
      return `DROP CONVERSION ${fq(root.conname!)}`;
    case 'pg_ts_config':
      return `DROP TEXT SEARCH CONFIGURATION ${fq(root.cfgname!)}`;
    case 'pg_ts_dict':
      return `DROP TEXT SEARCH DICTIONARY ${fq(root.dictname!)}`;
    case 'pg_ts_parser':
      return `DROP TEXT SEARCH PARSER ${fq(root.prsname!)}`;
    case 'pg_ts_template':
      return `DROP TEXT SEARCH TEMPLATE ${fq(root.tmplname!)}`;
    case 'pg_statistic_ext':
      return `DROP STATISTICS ${fq(root.stxname!)}`;
    case 'pg_extension':
      return `DROP EXTENSION ${quoteIdent(root.extname!)}`;
    case 'pg_operator': {
      const left = root.oprleft === null ? 'NONE' : root.oprleft;
      const right = root.oprright === null ? 'NONE' : root.oprright;
      return `DROP OPERATOR ${fq(root.oprname!)} (${left}, ${right})`;
    }
    case 'pg_opclass':
      return `DROP OPERATOR CLASS ${fq(root.opcname!)} USING ${root.opc_am}`;
    case 'pg_opfamily':
      return `DROP OPERATOR FAMILY ${fq(root.opfname!)} USING ${root.opf_am}`;
    case 'pg_cast':
      return `DROP CAST (${root.castsrc} AS ${root.casttgt})`;
    default:
      return `UNSUPPORTED:${root.classid_text}`;
  }
}

/**
 * Computes the destructive plan for the verified namespace from PostgreSQL's
 * own dependency graph (the SAME closure the external-dependency scan used):
 *
 *   doomed = every object CASCADE would have destroyed — materialized so the
 *            sweep can classify a 2BP01 blocker as "inside the verified
 *            boundary" (ordering — defer) or "outside it" (a NEW external
 *            dependent — refuse, fail-closed);
 *   roots  = the owned objects that need their OWN no-CASCADE DROP — the
 *            owned set minus the INTERNAL ('i') / AUTO ('a') /
 *            EXTENSION-MEMBER ('e') artifacts, which die with their parents —
 *            plus the exact DROP statement for each kind.
 *
 * The namespace row itself is not a root: the namespace is dropped by the
 * final DROP SCHEMA (no CASCADE) after every root is gone.
 */
async function computeDropPlan(
  client: PoolClient,
  schemaOid: number,
  freshSchema: string,
): Promise<DropPlan> {
  const doomedRes = await client.query<DoomedObject>(
    `${DEPENDENCY_CLOSURE_SQL}
    SELECT DISTINCT classid::oid AS classid, objid::oid AS objid
      FROM doomed`,
    [schemaOid],
  );
  const rootsRes = await client.query<{
    classid_text: string;
    classid: string;
    objid: string;
    description: string;
    relkind: string | null;
    relname: string | null;
    typtype: string | null;
    typname: string | null;
    prokind: string | null;
    proname: string | null;
    identity_args: string | null;
    collname: string | null;
    conname: string | null;
    cfgname: string | null;
    dictname: string | null;
    prsname: string | null;
    tmplname: string | null;
    stxname: string | null;
    extname: string | null;
    oprname: string | null;
    oprleft: string | null;
    oprright: string | null;
    opcname: string | null;
    opc_am: string | null;
    opfname: string | null;
    opf_am: string | null;
    castsrc: string | null;
    casttgt: string | null;
  }>(
    `${DEPENDENCY_CLOSURE_SQL},
    root AS (
      -- owned objects that are NOT internal/auto/extension artifacts of
      -- another owned object: exactly the objects needing their own DROP.
      SELECT DISTINCT o.classid, o.objid, o.objsubid
        FROM owned o
       WHERE NOT EXISTS (
         SELECT 1 FROM pg_depend d
           JOIN owned k
             ON d.refclassid = k.classid
            AND d.refobjid = k.objid
            AND (d.refobjsubid = k.objsubid
                 OR (k.classid = 'pg_class'::regclass
                     AND k.objsubid = 0
                     AND d.refobjsubid > 0))
          WHERE d.classid = o.classid
            AND d.objid = o.objid
            AND d.objsubid = o.objsubid
            AND d.deptype IN ('i', 'a', 'e')
       )
    )
    SELECT r.classid::regclass::text AS classid_text,
           r.classid::oid AS classid,
           r.objid::oid AS objid,
           pg_describe_object(r.classid, r.objid, r.objsubid) AS description,
           CASE WHEN r.classid = 'pg_class'::regclass
                THEN (SELECT relkind::text FROM pg_class c WHERE c.oid = r.objid)
                ELSE NULL END AS relkind,
           CASE WHEN r.classid = 'pg_class'::regclass
                THEN (SELECT relname FROM pg_class c WHERE c.oid = r.objid)
                ELSE NULL END AS relname,
           CASE WHEN r.classid = 'pg_type'::regclass
                THEN (SELECT typtype::text FROM pg_type ty WHERE ty.oid = r.objid)
                ELSE NULL END AS typtype,
           CASE WHEN r.classid = 'pg_type'::regclass
                THEN (SELECT typname FROM pg_type ty WHERE ty.oid = r.objid)
                ELSE NULL END AS typname,
           CASE WHEN r.classid = 'pg_proc'::regclass
                THEN (SELECT prokind::text FROM pg_proc p WHERE p.oid = r.objid)
                ELSE NULL END AS prokind,
           CASE WHEN r.classid = 'pg_proc'::regclass
                THEN (SELECT proname FROM pg_proc p WHERE p.oid = r.objid)
                ELSE NULL END AS proname,
           -- The identity argument list is rendered under THIS transaction's
           -- search_path (fresh teardown name + pg_catalog), so the exact
           -- string DROP FUNCTION/PROCEDURE/AGGREGATE must parse is produced.
           CASE WHEN r.classid = 'pg_proc'::regclass
                THEN (SELECT pg_get_function_identity_arguments(p.oid)
                        FROM pg_proc p WHERE p.oid = r.objid)
                ELSE NULL END AS identity_args,
           CASE WHEN r.classid = 'pg_collation'::regclass
                THEN (SELECT collname FROM pg_collation c WHERE c.oid = r.objid)
                ELSE NULL END AS collname,
           CASE WHEN r.classid = 'pg_conversion'::regclass
                THEN (SELECT conname FROM pg_conversion c WHERE c.oid = r.objid)
                ELSE NULL END AS conname,
           CASE WHEN r.classid = 'pg_ts_config'::regclass
                THEN (SELECT cfgname FROM pg_ts_config c WHERE c.oid = r.objid)
                ELSE NULL END AS cfgname,
           CASE WHEN r.classid = 'pg_ts_dict'::regclass
                THEN (SELECT dictname FROM pg_ts_dict c WHERE c.oid = r.objid)
                ELSE NULL END AS dictname,
           CASE WHEN r.classid = 'pg_ts_parser'::regclass
                THEN (SELECT prsname FROM pg_ts_parser c WHERE c.oid = r.objid)
                ELSE NULL END AS prsname,
           CASE WHEN r.classid = 'pg_ts_template'::regclass
                THEN (SELECT tmplname FROM pg_ts_template c WHERE c.oid = r.objid)
                ELSE NULL END AS tmplname,
           CASE WHEN r.classid = 'pg_statistic_ext'::regclass
                THEN (SELECT stxname FROM pg_statistic_ext c WHERE c.oid = r.objid)
                ELSE NULL END AS stxname,
           CASE WHEN r.classid = 'pg_extension'::regclass
                THEN (SELECT extname FROM pg_extension c WHERE c.oid = r.objid)
                ELSE NULL END AS extname,
           CASE WHEN r.classid = 'pg_operator'::regclass
                THEN (SELECT oprname FROM pg_operator c WHERE c.oid = r.objid)
                ELSE NULL END AS oprname,
           CASE WHEN r.classid = 'pg_operator'::regclass
                THEN (SELECT CASE WHEN oprleft = 0 THEN 'NONE'
                                  ELSE format_type(oprleft, NULL) END
                         FROM pg_operator c WHERE c.oid = r.objid)
                ELSE NULL END AS oprleft,
           CASE WHEN r.classid = 'pg_operator'::regclass
                THEN (SELECT CASE WHEN oprright = 0 THEN 'NONE'
                                  ELSE format_type(oprright, NULL) END
                         FROM pg_operator c WHERE c.oid = r.objid)
                ELSE NULL END AS oprright,
           CASE WHEN r.classid = 'pg_opclass'::regclass
                THEN (SELECT opcname FROM pg_opclass c WHERE c.oid = r.objid)
                ELSE NULL END AS opcname,
           CASE WHEN r.classid = 'pg_opclass'::regclass
                THEN (SELECT am.amname FROM pg_opclass c
                        JOIN pg_am am ON am.oid = c.opcmethod
                       WHERE c.oid = r.objid)
                ELSE NULL END AS opc_am,
           CASE WHEN r.classid = 'pg_opfamily'::regclass
                THEN (SELECT opfname FROM pg_opfamily c WHERE c.oid = r.objid)
                ELSE NULL END AS opfname,
           CASE WHEN r.classid = 'pg_opfamily'::regclass
                THEN (SELECT am.amname FROM pg_opfamily c
                        JOIN pg_am am ON am.oid = c.opfmethod
                       WHERE c.oid = r.objid)
                ELSE NULL END AS opf_am,
           CASE WHEN r.classid = 'pg_cast'::regclass
                THEN (SELECT format_type(castsource, NULL)
                        FROM pg_cast c WHERE c.oid = r.objid)
                ELSE NULL END AS castsrc,
           CASE WHEN r.classid = 'pg_cast'::regclass
                THEN (SELECT format_type(casttarget, NULL)
                        FROM pg_cast c WHERE c.oid = r.objid)
                ELSE NULL END AS casttgt
      FROM root r
     WHERE r.classid <> 'pg_namespace'::regclass
     ORDER BY 1, 2`,
    [schemaOid],
  );
  const partitionedRes = await client.query<{
    objid: string;
    description: string;
    relname: string;
  }>(
    `SELECT c.oid::oid AS objid,
            pg_describe_object('pg_class'::regclass, c.oid, 0) AS description,
            c.relname
       FROM pg_class c
      WHERE c.relnamespace = $1::oid
        AND c.relkind = 'p'
      ORDER BY c.oid`,
    [schemaOid],
  );
  return {
    doomed: doomedRes.rows,
    roots: rootsRes.rows.map((row) => ({
      classid: row.classid,
      objid: row.objid,
      description: row.description,
      sql: buildRootDropSql(row, freshSchema),
    })),
    partitionedTables: partitionedRes.rows.map((row) => ({
      objid: row.objid,
      description: row.description,
      sql: `LOCK TABLE ONLY ${quoteIdent(freshSchema)}.${quoteIdent(row.relname)} IN ACCESS EXCLUSIVE MODE`,
    })),
  };
}

/**
 * Closes the partition-specific plan-to-DROP race. PostgreSQL treats an
 * attached partition as an implementation child of its partitioned parent:
 * `DROP TABLE parent` removes the partition even without CASCADE. The generic
 * 2BP01 blocker path therefore cannot protect an external partition created
 * after the plan was computed.
 *
 * Acquire ACCESS EXCLUSIVE on every owned partitioned table (including a
 * partitioned table that is itself a partition, and therefore not a drop-plan
 * root). `ONLY` avoids recursively locking an already-attached external
 * partition. ATTACH PARTITION must lock the parent and cannot commit while
 * these locks are held. Once all parent locks are acquired, re-run the final
 * dependency boundary check and recompute the complete plan. A partitioned
 * table that appeared outside the initially locked set causes a fail-closed
 * refusal; otherwise the returned plan and every parent DROP are protected by
 * locks held until this transaction commits or rolls back.
 */
async function lockPartitionedTablesAndRevalidatePlan(
  client: PoolClient,
  initialPlan: DropPlan,
  freshSchema: string,
  schemaOid: number,
  schema: string,
): Promise<DropPlan> {
  const lockedPartitionedTableOids = new Set<string>();
  for (const table of initialPlan.partitionedTables) {
    try {
      await client.query(table.sql);
    } catch (error) {
      throw new TestDatabaseGuardError(
        `Q0-SEC ownership: refusing to drop schema '${schema}' — partitioned table ${table.description} could not be exclusion-locked (${safeErrorText(error)}) — nothing was destroyed.`,
      );
    }
    lockedPartitionedTableOids.add(String(table.objid));
  }

  // These are the FINAL validation and plan snapshots. They run only after
  // every known partitioned parent is locked, and the revalidated plan — not
  // the stale initial plan — drives the destructive sweep.
  await assertNoExternalDependents(client, schemaOid, schema);
  const revalidatedPlan = await computeDropPlan(client, schemaOid, freshSchema);
  const unlocked = revalidatedPlan.partitionedTables.filter(
    (table) => !lockedPartitionedTableOids.has(String(table.objid)),
  );
  if (unlocked.length > 0) {
    throw new TestDatabaseGuardError(
      `Q0-SEC ownership: refusing to drop schema '${schema}' — new partitioned table(s) appeared while the drop plan was being locked (${unlocked
        .map((table) => table.description)
        .join(', ')}) — nothing was destroyed.`,
    );
  }
  return revalidatedPlan;
}

/**
 * The no-CASCADE destructive sweep — the core of the scan-to-drop TOCTOU
 * closure (HIGH final-review finding). DROP SCHEMA ... CASCADE was the one
 * statement that could observe a dependency created AFTER the external-
 * dependency scan: its dependency walk reads the catalogs at statement
 * execution time (live-verified on PG16: neither READ COMMITTED, REPEATABLE
 * READ nor SERIALIZABLE prevents it — the drop machinery always sees newly
 * committed pg_depend rows), so a concurrent session could create an external
 * dependent after the scan and have the CASCADE destroy it. The protocol
 * below makes that structurally impossible:
 *
 *   - every owned root object is dropped with its OWN no-CASCADE DROP
 *     statement (internal/auto/extension artifacts die with their parents);
 *   - except for attached partitions (excluded by the parent locks and final
 *     revalidation above), a no-CASCADE DROP FAILS (2BP01) whenever an object
 *     still depends on the target — including an external dependent created
 *     and committed AFTER the plan was computed (its pg_depend row is not in
 *     the verified doomed set, so it cannot be mistaken for an in-boundary
 *     artifact);
 *   - the sweep then classifies the 2BP01 blockers against the verified
 *     doomed set: a blocker INSIDE the boundary means ordering (deferred to
 *     the next pass), a blocker OUTSIDE it means a new external dependent —
 *     fail-closed REFUSAL; the transaction ROLLBACK restores everything,
 *     so no external object can ever be deleted or altered by the teardown,
 *     no matter how the concurrent session times its creation;
 *   - only after every root is gone is the namespace itself dropped — with
 *     DROP SCHEMA (no CASCADE), which fails if ANY object (including one
 *     created inside the namespace concurrently) remains.
 */
async function dropOwnedContentsWithoutCascade(
  client: PoolClient,
  plan: DropPlan,
  freshSchema: string,
  schemaOid: number,
  schema: string,
): Promise<void> {
  const refused = (message: string): TestDatabaseGuardError =>
    new TestDatabaseGuardError(
      `Q0-SEC ownership: refusing to drop schema '${schema}' — ${message}`,
    );
  const doomedClassIds = plan.doomed.map((d) => d.classid);
  const doomedObjIds = plan.doomed.map((d) => d.objid);
  const remaining: DropPlanRoot[] = [...plan.roots];

  const blockerDescription = async (
    refClassid: number,
    refObjid: number,
  ): Promise<string[]> => {
    const res = await client.query<{ description: string }>(
      `SELECT DISTINCT pg_describe_object(d.classid, d.objid, d.objsubid) AS description
         FROM pg_depend d
        WHERE d.refclassid = $1::oid
          AND d.refobjid = $2::oid
          AND d.deptype <> 'p'
          AND NOT (d.classid = ANY($3::oid[]) AND d.objid = ANY($4::oid[]))`,
      [refClassid, refObjid, doomedClassIds, doomedObjIds],
    );
    return res.rows.map((r) => r.description);
  };

  for (let pass = 0; pass < 20; pass += 1) {
    let progress = false;
    const deferred: DropPlanRoot[] = [];
    for (const root of remaining) {
      if (root.sql === null) {
        // Composite relation: dropped via its pg_type entry (DROP TYPE). If
        // that entry is somehow not a root, the final DROP SCHEMA fails
        // closed below — never a silent skip.
        deferred.push(root);
        continue;
      }
      if (root.sql.startsWith('UNSUPPORTED:')) {
        throw refused(
          `the owned namespace contains an object kind the destructive protocol does not support (${root.sql}) — nothing was destroyed.`,
        );
      }
      await client.query('SAVEPOINT q0sec_drop');
      try {
        await client.query(root.sql);
        await client.query('RELEASE SAVEPOINT q0sec_drop');
        progress = true;
      } catch (error) {
        await client
          .query('ROLLBACK TO SAVEPOINT q0sec_drop')
          .catch(() => undefined);
        if (!isDependentObjectsStillExistError(error)) {
          throw refused(
            `the owned object ${root.description} could not be dropped (${safeErrorText(error)}) — nothing was destroyed.`,
          );
        }
        const blockers = await blockerDescription(
          Number(root.classid),
          Number(root.objid),
        );
        if (blockers.length > 0) {
          throw refused(
            `new external dependent(s) appeared during teardown and would be destroyed by dropping ${root.description}: ${blockers.join(
              ', ',
            )} — nothing was destroyed.`,
          );
        }
        // Every blocker is inside the verified boundary — an ordering
        // dependency; retry on the next pass.
        deferred.push(root);
      }
    }
    remaining.length = 0;
    remaining.push(...deferred);
    if (!progress) {
      if (remaining.length > 0) {
        throw refused(
          `the owned namespace could not be emptied (dependency cycle or unsupported object among: ${remaining
            .map((r) => r.description)
            .join(', ')}) — nothing was destroyed.`,
        );
      }
      break;
    }
  }
  if (remaining.length > 0) {
    throw refused(
      'the owned namespace could not be emptied within the drop budget — nothing was destroyed.',
    );
  }

  // The namespace itself: DROP SCHEMA WITHOUT CASCADE — it succeeds only on a
  // completely empty schema, so any object created inside the namespace after
  // the plan (a concurrent session with CREATE on the schema) makes this fail
  // and the whole transaction rolls back. External dependents on the
  // namespace row itself (e.g. a publication binding — superuser-only for the
  // test role) fail the same way and are refused via the blocker check.
  await client.query('SAVEPOINT q0sec_drop_schema');
  try {
    await client.query(`DROP SCHEMA ${quoteIdent(freshSchema)}`);
    await client.query('RELEASE SAVEPOINT q0sec_drop_schema');
  } catch (error) {
    await client
      .query('ROLLBACK TO SAVEPOINT q0sec_drop_schema')
      .catch(() => undefined);
    if (!isDependentObjectsStillExistError(error)) {
      throw refused(
        `the owned schema could not be dropped (${safeErrorText(error)}) — nothing was destroyed.`,
      );
    }
    const namespaceClassId = (
      await client.query<{ oid: number }>(
        `SELECT 'pg_namespace'::regclass::oid::int AS oid`,
      )
    ).rows[0].oid;
    const blockers = await blockerDescription(namespaceClassId, schemaOid);
    if (blockers.length > 0) {
      throw refused(
        `new object(s) appeared inside the owned schema during teardown (${blockers.join(
          ', ',
        )}) — nothing was destroyed.`,
      );
    }
    throw refused(
      'the owned schema could not be emptied even though every verified object was dropped — nothing was destroyed.',
    );
  }
}

/**
 * Creates a schema (plain CREATE SCHEMA — a pre-existing schema FAILS the run,
 * never gets adopted) and records its ownership marker inside it, ALL inside
 * ONE transaction on a single PoolClient: BEGIN → CREATE SCHEMA → CREATE
 * marker → INSERT marker → COMMIT. Any failure ROLLBACKs and rethrows, so a
 * schema can never be left behind without its ownership marker.
 */
export async function createOwnedSchema(
  pool: Pool,
  schema: string,
  runId: string,
  ownerTokenHash: string,
): Promise<void> {
  const marker = qualifiedMarkerTable(schema);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${quoteIdent(schema)}`);
    await client.query(
      `CREATE TABLE ${marker} (
         run_id TEXT NOT NULL,
         owner_token_hash TEXT NOT NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
    );
    // DB-level singleton: at most ONE marker row per schema (a unique index
    // on a constant expression). Reads additionally enforce rows.length === 1
    // so even a foreign/legacy marker table without this index fails closed.
    await client.query(
      `CREATE UNIQUE INDEX q0sec_run_ownership_singleton
       ON ${marker} ((true))`,
    );
    await client.query(
      `INSERT INTO ${marker} (run_id, owner_token_hash) VALUES ($1, $2)`,
      [runId, ownerTokenHash],
    );
    await client.query('COMMIT');
  } catch (error) {
    await rollbackOrDiscard(client, error);
  } finally {
    releaseOwnershipClient(client);
  }
}

/**
 * P1-1 — verifies inside PostgreSQL itself that the session's effective
 * search_path is EXACTLY [<targetSchema>, pg_catalog] in that order. The
 * comparison is performed by the database (`current_schemas(false)` equals
 * the expected array), so node-pg's client-side parsing of name[] values
 * (which returns the raw '{...}' string, not a JS array) can never skew the
 * verdict. Throws fail-closed on false/null/unexpected result.
 */
export async function verifySearchPathExactly(
  client: PoolClient,
  schema: string,
): Promise<void> {
  const sp = await client.query<{ ok: boolean | null }>(
    `SELECT current_schemas(false) = ARRAY[$1::name, 'pg_catalog'::name] AS ok`,
    [schema],
  );
  if (sp.rows[0]?.ok !== true) {
    throw new TestDatabaseGuardError(
      `Q0-SEC ownership: refusing to drop schema '${schema}' — effective search_path is not exactly the target schema followed by pg_catalog.`,
    );
  }
}

/**
 * P1-1 — atomically verifies ownership of `schema` and drops it, inside ONE
 * transaction, all accesses qualified to the target schema:
 *
 *   BEGIN
 *   - advisory transaction lock derived from the verified namespace OID
 *     (durable identity — a schema NAME is mutable, so the lock key never
 *     depends on a name)
 *   - SET LOCAL search_path TO "schema", pg_catalog
 *   - verify the effective search_path inside PostgreSQL (exactly
 *     [schema, pg_catalog] in order)
 *   - verify the schema exists under the exact expected name
 *   - read the marker QUALIFIED inside the target schema, row locked
 *     (SELECT ... FOR UPDATE)
 *   - verify run id + owner-token hash
 *   - RE-READ the marker immediately before the identity-binding step
 *   - ALTER SCHEMA ... RENAME TO a fresh unpredictable name (transactional;
 *     takes an ACCESS EXCLUSIVE lock on the schema row held until COMMIT)
 *   - re-resolve the FRESH name and require its OID to equal the OID
 *     verified above (a swap that landed between the checks and the rename
 *     is refused here — the ROLLBACK restores the foreign schema's name)
 *   - SET LOCAL search_path TO "fresh", pg_catalog + re-verify, and re-read
 *     the marker under the fresh name (singleton + match again)
 *   - DEPENDENCY-SAFE GATE: enumerate pg_depend arcs crossing the namespace
 *     boundary (referenced object inside, dependent object outside) and
 *     refuse if any dependent is not explicitly proven safe and owned
 *     (the only allowlisted kind: the toast table of an owned relation)
 *   - DROP-PLAN: derive the EXACT set of objects the destructive step may
 *     destroy (the doomed closure) and the roots needing their own DROP
 *     from the same dependency graph
 *   - PARTITION EXCLUSION: ACCESS EXCLUSIVE-lock ONLY every owned partitioned
 *     table, then re-run the dependency gate and recompute the plan while the
 *     locks are held (ATTACH PARTITION cannot land between this final
 *     validation and a parent DROP)
 *   - DROP every root with its OWN no-CASCADE DROP statement (sweep with
 *     savepoints; a 2BP01 blocker inside the verified closure is deferred,
 *     a blocker OUTSIDE it is a NEW external dependent — refused), then
 *     DROP SCHEMA "fresh" WITHOUT CASCADE (succeeds only on an empty
 *     schema — any object created concurrently inside the namespace fails
 *     the whole transaction fail-closed)
 *   COMMIT
 *
 * Any mismatch ROLLBACKs and refuses the drop. Because the destructive DDL
 * is bound to the verified namespace OID (the fresh name is created by this
 * transaction's own rename and row-locked until COMMIT), no concurrent
 * rename/swap can redirect the DROP to a namespace that was never verified,
 * and because the destructive protocol contains NO CASCADE statement, a
 * dependency created AFTER the gate (live-verified on PG16: the CASCADE drop
 * machinery reads the catalogs at statement time and no isolation level can
 * hide a committed dependent from it) can never be deleted or altered — the
 * no-CASCADE DROP of its referenced object fails (2BP01), the blocker is
 * classified as outside the verified closure, and the transaction rolls
 * back with everything preserved. Attached partitions are the PostgreSQL
 * exception (a parent DROP removes them without 2BP01), so the parent locks
 * plus lock-held revalidation exclude that race explicitly. The caller must
 * already have validated `schema` against the run id (canonicalization +
 * length bounds).
 */
export async function dropOwnedSchemaAtomically(
  client: PoolClient,
  schema: string,
  runId: string,
  ownerTokenHashValue: string,
): Promise<void> {
  const q = quoteIdent(schema);
  const marker = qualifiedMarkerTable(schema);
  try {
    await client.query('BEGIN');
    // 2. Direct the session at the target schema only, explicitly.
    await client.query(`SET LOCAL search_path TO ${q}, pg_catalog`);
    // 3. Verify the effective search_path — the verdict comes from
    //    PostgreSQL itself, never from client-side array parsing.
    await verifySearchPathExactly(client, schema);
    // 4. Resolve the schema to its stable OID and verify the marker table
    //    belongs to that exact namespace. This binds the ownership check to
    //    the namespace identity rather than a textual name that could be
    //    confused by search_path redirection.
    const ns = await client.query<{ oid: number }>(
      'SELECT oid::int AS oid FROM pg_namespace WHERE nspname = $1',
      [schema],
    );
    if (ns.rows.length !== 1) {
      throw new TestDatabaseGuardError(
        `Q0-SEC ownership: refusing to drop schema '${schema}' — schema not found under the expected name.`,
      );
    }
    const schemaOid = ns.rows[0].oid;
    // 1. Advisory transaction lock derived from the verified namespace OID
    //    (auto released at COMMIT/ROLLBACK — no two runs can race the same
    //    schema, and the key is DURABLE identity: a schema NAME is mutable,
    //    so a name-derived key would let a concurrent rename desynchronize
    //    two teardowns of the same namespace).
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      String(schemaOid),
    ]);
    const markerRel = await client.query<{ relname: string }>(
      `SELECT relname FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relname = $1
         AND n.nspname = $2
         AND n.oid = $3::oid`,
      [OWNERSHIP_MARKER_TABLE, schema, schemaOid],
    );
    if (markerRel.rows.length !== 1) {
      throw new TestDatabaseGuardError(
        `Q0-SEC ownership: refusing to drop schema '${schema}' — ownership marker table is not bound to the expected namespace OID.`,
      );
    }
    // 5. Marker read, QUALIFIED inside the target schema, row locked.
    //    A missing/unreadable marker table is treated as "no ownership" —
    //    the raw pg error must never surface as anything but a clean
    //    fail-closed refusal.
    let markerRow: { run_id: string; owner_token_hash: string } | undefined;
    try {
      const first = await client.query<{
        run_id: string;
        owner_token_hash: string;
      }>(`SELECT run_id, owner_token_hash FROM ${marker} FOR UPDATE`);
      // Singleton marker: exactly ONE row must exist — extra rows mean the
      // ownership is not unique and must be treated as unverifiable.
      markerRow = first.rows.length === 1 ? first.rows[0] : undefined;
    } catch {
      markerRow = undefined;
    }
    if (!markerRow) {
      throw new TestDatabaseGuardError(
        `Q0-SEC ownership: refusing to drop schema '${schema}' — ownership marker is missing or unreadable.`,
      );
    }
    if (
      markerRow.run_id !== runId ||
      markerRow.owner_token_hash !== ownerTokenHashValue
    ) {
      throw new TestDatabaseGuardError(
        `Q0-SEC ownership: refusing to drop schema '${schema}' — ownership marker does not match this run.`,
      );
    }
    // 6. Re-read the marker immediately before the identity-binding step.
    //    Singleton enforced again: exactly one row, matching this run.
    const again = await client.query<{
      run_id: string;
      owner_token_hash: string;
    }>(`SELECT run_id, owner_token_hash FROM ${marker}`);
    if (
      again.rows.length !== 1 ||
      again.rows[0]?.run_id !== runId ||
      again.rows[0]?.owner_token_hash !== ownerTokenHashValue
    ) {
      throw new TestDatabaseGuardError(
        `Q0-SEC ownership: refusing to drop schema '${schema}' — ownership marker changed before the drop.`,
      );
    }
    // 7. BIND THE DESTRUCTIVE DDL TO THE VERIFIED NAMESPACE OID (identity-safe
    //    cleanup). A schema NAME is mutable: between the marker verification
    //    above and a name-based DROP SCHEMA, a concurrent session could RENAME
    //    this schema away and RENAME a foreign schema into its place — the
    //    drop would then destroy a namespace that was never verified. The
    //    protocol below makes that impossible:
    //
    //    a) ALTER SCHEMA ... RENAME TO a fresh, unpredictable name. The
    //       rename is transactional (a refusal or a crash ROLLBACKs it) and
    //       takes an ACCESS EXCLUSIVE lock on the schema's pg_namespace row
    //       that OUR transaction holds until COMMIT — once the schema sits
    //       under the fresh name, no concurrent session can rename it away,
    //       drop it, or claim the fresh name until we finish.
    //    b) Re-resolve the FRESH name and require its OID to equal the OID
    //       verified in step 4. If a swap landed between the checks and the
    //       rename, the rename moved the FOREIGN schema to the fresh name and
    //       this check refuses — the ROLLBACK restores the foreign schema to
    //       its original name, so it SURVIVES untouched.
    //    c) Re-point the session at the fresh name, re-verify the effective
    //       search_path, and re-read the ownership marker under the fresh
    //       name — the exact namespace about to be destroyed must still carry
    //       the matching marker.
    //    d) DROP SCHEMA under the fresh name only.
    const freshName = generateTeardownName();
    if (freshName === schema) {
      throw new TestDatabaseGuardError(
        `Q0-SEC ownership: refusing to drop schema '${schema}' — could not bind a unique teardown name.`,
      );
    }
    try {
      await client.query(
        `ALTER SCHEMA ${q} RENAME TO ${quoteIdent(freshName)}`,
      );
    } catch {
      // The schema vanished or was replaced under this name — fail closed.
      throw new TestDatabaseGuardError(
        `Q0-SEC ownership: refusing to drop schema '${schema}' — namespace identity changed during teardown (concurrent rename/swap detected).`,
      );
    }
    const rebound = await client.query<{ oid: number }>(
      'SELECT oid::int AS oid FROM pg_namespace WHERE nspname = $1',
      [freshName],
    );
    if (rebound.rows.length !== 1 || rebound.rows[0].oid !== schemaOid) {
      throw new TestDatabaseGuardError(
        `Q0-SEC ownership: refusing to drop schema '${schema}' — namespace identity changed during teardown (concurrent rename/swap detected).`,
      );
    }
    const freshQ = quoteIdent(freshName);
    await client.query(`SET LOCAL search_path TO ${freshQ}, pg_catalog`);
    await verifySearchPathExactly(client, freshName);
    let freshMarkerRow:
      { run_id: string; owner_token_hash: string } | undefined;
    try {
      const freshRead = await client.query<{
        run_id: string;
        owner_token_hash: string;
      }>(
        `SELECT run_id, owner_token_hash FROM ${qualifiedMarkerTable(freshName)}`,
      );
      freshMarkerRow =
        freshRead.rows.length === 1 ? freshRead.rows[0] : undefined;
    } catch {
      freshMarkerRow = undefined;
    }
    if (
      !freshMarkerRow ||
      freshMarkerRow.run_id !== runId ||
      freshMarkerRow.owner_token_hash !== ownerTokenHashValue
    ) {
      throw new TestDatabaseGuardError(
        `Q0-SEC ownership: refusing to drop schema '${schema}' — ownership marker changed before the drop.`,
      );
    }
    // 8. DEPENDENCY-SAFE GATE — the last verification before any destructive
    //    DDL. Compute the exact set of objects the destructive step would
    //    destroy (the closure of this verified namespace over PostgreSQL's
    //    own dependency graph) and refuse if anything in it is not provably
    //    owned (allowlisted toast artifacts excepted); the ROLLBACK then
    //    restores the schema's original name and leaves every object
    //    untouched.
    await assertNoExternalDependents(client, schemaOid, schema);
    // 9. DESTRUCTIVE STEP WITHOUT CASCADE (scan-to-drop TOCTOU closure): the
    //    gate above proves every EXISTING dependent is owned, but a
    //    dependency created AFTER the gate and committed before the
    //    destructive DDL could still be observed by a DROP SCHEMA ... CASCADE
    //    (live-verified on PG16: the CASCADE machinery reads the catalogs at
    //    statement time — no isolation level hides a committed dependent).
    //    The protocol therefore never issues CASCADE: partitioned parents are
    //    exclusion-locked and the boundary + plan are revalidated under those
    //    locks; every root is then dropped with its OWN no-CASCADE DROP (any
    //    other new external dependent makes that DROP fail with 2BP01 and the
    //    whole transaction ROLLBACKs); finally the namespace is dropped
    //    WITHOUT CASCADE, which succeeds only on a completely empty schema.
    const initialPlan = await computeDropPlan(client, schemaOid, freshName);
    const plan = await lockPartitionedTablesAndRevalidatePlan(
      client,
      initialPlan,
      freshName,
      schemaOid,
      schema,
    );
    await dropOwnedContentsWithoutCascade(
      client,
      plan,
      freshName,
      schemaOid,
      schema,
    );
    await client.query('COMMIT');
  } catch (error) {
    await rollbackOrDiscard(client, error);
  }
}

/**
 * The result of an OID-keyed ownership classification (see
 * classifyOwnedSchemaByOid): the marker content of the verified namespace
 * plus its CURRENT name (re-resolved from the durable OID at classification
 * time — the only name the caller may pass to destructive routines).
 */
export interface SchemaClassification {
  runId: string;
  ownerTokenHash: string;
  currentName: string;
}

/** One candidate row of the marker-identity enumeration. */
export interface MarkedSchemaRow {
  nsOid: number;
  nspname: string;
  markerOid: number;
}

/** Bounded re-resolution rounds for one classification (see below). */
const CLASSIFY_MAX_ROUNDS = 4;

/**
 * Marker-IDENTITY classification keyed on the DURABLE namespace OID — the
 * shared discovery primitive of teardown (worker-schema discovery) and
 * globalSetup (ambiguous-COMMIT reconciliation). A schema NAME is mutable:
 * a schema renamed between enumeration and a name-based marker lookup
 * silently escapes name-based discovery (MEDIUM final-review finding). This
 * routine never trusts a name: every round re-resolves the CURRENT name from
 * the OID, reads the ownership marker under it, and re-verifies that the
 * name still resolves to the OID (a swap) and that the marker table is still
 * the enumerated one (a marker-table replacement) — a rename/swap landing in
 * the middle of a round simply restarts the round, and after a bounded
 * number of rounds without a consistent read the classification refuses
 * fail-closed (the schema is preserved and the run fails loudly; it is never
 * silently assumed gone). The advisory transaction lock is keyed on the OID
 * as well, so a concurrent teardown of the same namespace serializes with
 * the classification regardless of renames.
 *
 * Returns the classification, or `null` when the namespace no longer exists
 * (a concurrent cleanup consumed it — nothing left to classify). Throws a
 * fail-closed TestDatabaseGuardError when ownership is AMBIGUOUS — marker
 * missing/unreadable/non-unique, or identity churn beyond the round budget.
 */
export async function classifyOwnedSchemaByOid(
  client: PoolClient,
  nsOid: number,
  markerTableOid: number,
): Promise<SchemaClassification | null> {
  let settled = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      String(nsOid),
    ]);
    for (let round = 0; round < CLASSIFY_MAX_ROUNDS; round += 1) {
      // 1. Resolve the CURRENT name from the durable OID.
      const nameRes = await client.query<{ nspname: string }>(
        'SELECT nspname FROM pg_namespace WHERE oid = $1::oid',
        [nsOid],
      );
      const name = nameRes.rows[0]?.nspname;
      if (!name) {
        await client.query('ROLLBACK');
        settled = true;
        return null;
      }
      // 2. Read the marker under the current name (singleton enforced).
      let rows: { run_id: string; owner_token_hash: string }[];
      let readFailed = false;
      try {
        const res = await client.query<{
          run_id: string;
          owner_token_hash: string;
        }>(
          `SELECT run_id, owner_token_hash FROM ${qualifiedMarkerTable(name)}`,
        );
        rows = res.rows;
      } catch {
        readFailed = true;
        rows = [];
      }
      // 3. Re-verify identity from the durable OID: a rename or swap landing
      //    between step 1 and step 2 must restart the round — the name that
      //    was just read must still BE the enumerated namespace, with the
      //    enumerated marker table.
      const nowRes = await client.query<{ oid: number; marker_oid: number }>(
        `SELECT n.oid::int AS oid,
                COALESCE((SELECT c.oid::int FROM pg_class c
                           WHERE c.relnamespace = n.oid
                             AND c.relname = $2
                             AND c.relkind = 'r'), 0) AS marker_oid
           FROM pg_namespace n
          WHERE n.nspname = $1`,
        [name, OWNERSHIP_MARKER_TABLE],
      );
      const now = nowRes.rows[0];
      if (!now || now.oid !== nsOid || now.marker_oid !== markerTableOid) {
        // The name moved (rename/swap) or the marker table was replaced —
        // restart the round with the re-resolved name.
        continue;
      }
      if (readFailed) {
        await client.query('ROLLBACK');
        settled = true;
        throw new TestDatabaseGuardError(
          `Q0-SEC ownership: refusing to drop schema '${name}' — ownership marker is missing or unreadable.`,
        );
      }
      if (rows.length !== 1) {
        await client.query('ROLLBACK');
        settled = true;
        throw new TestDatabaseGuardError(
          `Q0-SEC ownership: refusing to drop schema '${name}' — ownership marker is not unique (ambiguous ownership).`,
        );
      }
      await client.query('COMMIT');
      settled = true;
      return {
        runId: rows[0].run_id,
        ownerTokenHash: rows[0].owner_token_hash,
        currentName: name,
      };
    }
    throw new TestDatabaseGuardError(
      `Q0-SEC ownership: refusing to drop a schema — its identity kept changing during classification (concurrent rename/swap churn); the schema is preserved.`,
    );
  } catch (error) {
    if (!settled) {
      await rollbackOrDiscard(client, error);
    }
    throw error;
  }
}

/**
 * Marker-IDENTITY enumeration: every non-system schema that carries an
 * ownership marker table, returned with its DURABLE identity (namespace OID
 * + marker-table OID) and its current name. The OIDs are the identity — the
 * names are only hints for messages and may already be stale (the
 * classification re-resolves them). `excludeName` (a schema currently under
 * that exact name, e.g. the run anchor handled by its own exact-name step)
 * is skipped; `null` excludes nothing.
 */
export async function enumerateMarkedSchemas(
  pool: Pool,
  excludeName: string | null,
): Promise<MarkedSchemaRow[]> {
  const res = await pool.query<{
    ns_oid: number;
    nspname: string;
    marker_oid: number;
  }>(
    `SELECT n.oid::int AS ns_oid,
            n.nspname,
            c.oid::int AS marker_oid
       FROM pg_namespace n
       JOIN pg_class c
         ON c.relnamespace = n.oid
        AND c.relname = $2
        AND c.relkind = 'r'
      WHERE n.nspname NOT LIKE 'pg\\_%'
        AND n.nspname <> 'information_schema'
        AND ($1::text IS NULL OR n.nspname <> $1)
      ORDER BY n.oid`,
    [excludeName, OWNERSHIP_MARKER_TABLE],
  );
  return res.rows.map((row) => ({
    nsOid: row.ns_oid,
    nspname: row.nspname,
    markerOid: row.marker_oid,
  }));
}

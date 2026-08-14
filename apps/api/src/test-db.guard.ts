import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * Q0-SEC — test database guard.
 *
 * Every Repository/E2E test run must connect exclusively to a dedicated local
 * test schema. This module is the single enforcement point:
 *
 *  - it refuses to run when TEST_DATABASE_URL is missing or malformed;
 *  - it rejects any URL that effectively connects to DATABASE_URL (the
 *    application database), comparing the EFFECTIVE connection, not raw text;
 *  - it allowlists host, port, user, database and schema, and explicitly
 *    blocks production/staging hosts and production database names;
 *  - it verifies the same connection settings pg will actually use: node-postgres
 *    applies query parameters that can override the URL authority (host, port,
 *    user, password, database, ssl, ...), so ONLY a single `options` parameter
 *    carrying exactly `-c search_path=<schema>` is accepted and every other
 *    parameter is refused; after verification the connection URL is rebuilt
 *    canonically (the original query is never kept);
 *  - each test run gets a unique schema (moeen_test_<runId>) plus a separate
 *    owner token whose SHA-256 hash is stored INSIDE the schema, so teardown
 *    can only drop a schema this run provably created;
 *  - run ids are capped so the schema name stays within PostgreSQL's 63-byte
 *    identifier limit.
 *
 * It is imported by the npm script shim (scripts/with-test-env.js), by the
 * jest setup/globalSetup/globalTeardown hooks, and by the security spec.
 */

export const TEST_RUN_ID_ENV = 'MOEEN_TEST_RUN_ID';
export const TEST_OWNER_TOKEN_ENV = 'MOEEN_TEST_OWNER_TOKEN';
export const TEST_SCHEMA_PREFIX = 'moeen_test';

/** Local-only hosts a test connection may target. */
const ALLOWED_TEST_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
]);

/** Local-only PostgreSQL port used by Moeen (PG16 on 5433; Odoo 5432 is off-limits). */
const ALLOWED_TEST_PORTS: ReadonlySet<string> = new Set(['5433']);

/** Database users a test connection may use. Only the dedicated restricted test role is accepted. */
export const EXPECTED_TEST_ROLE = 'moeen_test_runner';
const ALLOWED_TEST_USERS: ReadonlySet<string> = new Set([EXPECTED_TEST_ROLE]);

/**
 * Databases a test connection may target (the dedicated test schema lives
 * inside them).
 *
 * moeen_test is the default and preferred test database (.env.example
 * convention). A dedicated moeen_test database now exists locally, so the
 * application database 'moeen' is no longer accepted for automated tests at
 * all — the app database is unreachable by any test run by construction.
 * Any other database name is rejected outright.
 */
const ALLOWED_TEST_DATABASES: ReadonlySet<string> = new Set(['moeen_test']);

/**
 * Production/staging database names that are explicitly refused even when the
 * host is (mistakenly) local. The allowlist above is authoritative: anything
 * not listed is rejected regardless of these names.
 */
const FORBIDDEN_PRODUCTION_DATABASES: ReadonlySet<string> = new Set([
  'moeen_prod',
  'moeen_production',
  'moeen_staging',
  'moeen_stage',
  'moeen_preprod',
  'moeen_qa',
  'moeen_dev',
  'moeen_development',
  'railway',
  'postgres',
  'template0',
  'template1',
]);

/** Host patterns that indicate a production/staging endpoint (used for precise error messages). */
const FORBIDDEN_HOST_PATTERNS: readonly RegExp[] = [
  /(^|\.)(railway|render|fly|heroku|azure|aws|amazonaws|rds|digitalocean|supabase|neon|vercel|netlify|cleardb|elephantsql|planetscale|aiven|scaleway|linode|vultr|ovh)(\.|$)/i,
  /(^|[-.])(prod|production|staging|stage|preprod|qa|live|demo)([-.]|$)/i,
];

/**
 * Identifier limits (P1-2/P2-1): PostgreSQL identifiers are at most 63 bytes.
 * The run schema is `moeen_test_<runId>` (10 + 1 + runId) and the worker
 * schema is `moeen_test_<runId>_w<workerId>` (10 + 1 + runId + 2 + up to 2
 * digits), so run ids are capped at 48 — the tightest bound that keeps BOTH
 * shapes within 63 bytes. The same bound feeds validateTestRunId,
 * TEST_SCHEMA_PATTERN and the teardown ownership check.
 */
const SCHEMA_PREFIX_LENGTH = TEST_SCHEMA_PREFIX.length; // 10 ('moeen_test')
const PG_IDENTIFIER_MAX_LENGTH = 63;
const WORKER_SUFFIX_PREFIX = '_w'; // 2 chars
const WORKER_ID_MAX_DIGITS = 2; // worker ids 1..99
export const TEST_RUN_ID_MIN_LENGTH = 4;
export const TEST_RUN_ID_MAX_LENGTH =
  PG_IDENTIFIER_MAX_LENGTH -
  SCHEMA_PREFIX_LENGTH -
  1 -
  WORKER_SUFFIX_PREFIX.length -
  WORKER_ID_MAX_DIGITS; // 48

/** A test schema is `moeen_test`, `moeen_test_<runId>` or a per-worker `moeen_test_<runId>_w<workerId>`. */
export const TEST_SCHEMA_PATTERN = new RegExp(
  `^${TEST_SCHEMA_PREFIX}(?:_[a-z0-9]{${TEST_RUN_ID_MIN_LENGTH},${TEST_RUN_ID_MAX_LENGTH}}(?:_w[1-9]\\d{0,${WORKER_ID_MAX_DIGITS - 1}})?)?$`,
);

const TEST_RUN_ID_PATTERN = new RegExp(
  `^[a-z0-9]{${TEST_RUN_ID_MIN_LENGTH},${TEST_RUN_ID_MAX_LENGTH}}$`,
);

const TEST_WORKER_ID_PATTERN = new RegExp(
  `^[1-9]\\d{0,${WORKER_ID_MAX_DIGITS - 1}}$`,
);

const TEST_OWNER_TOKEN_PATTERN = /^[a-f0-9]{32,64}$/;

/**
 * P1-1: node-postgres applies connection-string QUERY parameters that can
 * override the URL authority (host, port, user, password, database, ssl,
 * options, ...). The guard therefore refuses every query parameter except a
 * single `options` that carries exactly one `-c search_path=<schema>` flag, so
 * pg can never connect anywhere the guard did not approve.
 */
const ALLOWED_QUERY_PARAMETERS: ReadonlySet<string> = new Set(['options']);
const OPTIONS_SEARCH_PATH_PATTERN = /^-c\s+search_path=(\S+)$/;
const APPROVED_PROTOCOL = 'postgresql:';

export class TestDatabaseGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestDatabaseGuardError';
  }
}

/** The connection settings pg will actually use, after URL + query parsing. */
export interface EffectiveConnection {
  protocol: string;
  host: string;
  port: string;
  user: string;
  /** Never printed anywhere — the canonical URL is the only carrier. */
  password: string;
  database: string;
  /** The single search_path value, or null when no options were provided. */
  searchPath: string | null;
}

/** Physical database identity, deliberately excluding credentials/session policy. */
export type PhysicalDatabaseIdentity = Pick<
  EffectiveConnection,
  'protocol' | 'host' | 'port' | 'database'
>;

/**
 * Parses a connection string into the settings pg will actually use, applying
 * the strict query-parameter policy. Throws TestDatabaseGuardError with a
 * generic message on any malformed input (the raw URL is never echoed).
 */
export function parseEffectiveConnection(rawUrl: string): EffectiveConnection {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    // Generic on purpose: the raw URL (which may carry credentials, query
    // parameters or a sensitive search_path) must never reach error output.
    throw new TestDatabaseGuardError(
      'Refusing to run: TEST_DATABASE_URL is malformed or unsupported.',
    );
  }
  if (parsed.protocol !== APPROVED_PROTOCOL) {
    // Protocol aliases (postgres://, ...) are refused: only postgresql:// is
    // approved, and the value itself is never echoed.
    throw new TestDatabaseGuardError(
      'Refusing to run: TEST_DATABASE_URL protocol is not supported (only postgresql:// is approved).',
    );
  }

  // Query parameters: reject every key that is not the single approved
  // `options`, reject duplicates, and require options to carry exactly one
  // `-c search_path=<schema>`.
  const entries = [...parsed.searchParams.entries()];
  const counts = new Map<string, number>();
  for (const [key] of entries) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of counts) {
    if (!ALLOWED_QUERY_PARAMETERS.has(key)) {
      throw new TestDatabaseGuardError(
        `Refusing to run: TEST_DATABASE_URL query parameter '${key}' is not allowed.`,
      );
    }
    if (count > 1) {
      throw new TestDatabaseGuardError(
        `Refusing to run: TEST_DATABASE_URL query parameter '${key}' is duplicated.`,
      );
    }
  }
  let searchPath: string | null = null;
  const optionsValue = parsed.searchParams.get('options');
  if (optionsValue !== null) {
    const match = OPTIONS_SEARCH_PATH_PATTERN.exec(optionsValue);
    if (!match) {
      throw new TestDatabaseGuardError(
        "Refusing to run: TEST_DATABASE_URL options must contain exactly one '-c search_path=<schema>'.",
      );
    }
    searchPath = match[1];
    if (searchPath.includes(',')) {
      throw new TestDatabaseGuardError(
        'Refusing to run: TEST_DATABASE_URL search_path must be a single schema (no multi-value search_path).',
      );
    }
  }

  let host: string;
  const port = parsed.port || '5432';
  let user: string;
  let password: string;
  let database: string;
  try {
    // Match pg-connection-string's effective parsing. WHATWG URL leaves
    // percent escapes in hostname/pathname, while node-postgres decodes the
    // host with decodeURIComponent and the database with decodeURI. Comparing
    // the undecoded URL spelling would let the same physical database appear
    // distinct (for example, /%6doeen_test versus /moeen_test).
    host = decodeURIComponent(parsed.hostname);
    user = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
    database = decodeURI(parsed.pathname.replace(/^\/+/, ''));
  } catch {
    throw new TestDatabaseGuardError(
      'Refusing to run: TEST_DATABASE_URL is malformed or unsupported.',
    );
  }

  return {
    protocol: APPROVED_PROTOCOL,
    host,
    port,
    user,
    password,
    database,
    searchPath,
  };
}

/**
 * Rebuilds the connection URL canonically from the approved components: the
 * original query string is never kept — only the single options parameter for
 * the search_path survives. The password is embedded (pg needs it) but is
 * never printed by any message in this module.
 */
export function buildCanonicalUrl(conn: EffectiveConnection): string {
  const userinfo = `${encodeURIComponent(conn.user)}:${encodeURIComponent(
    conn.password,
  )}`;
  const base = `${APPROVED_PROTOCOL}//${userinfo}@${conn.host}:${conn.port}/${conn.database}`;
  return conn.searchPath === null
    ? base
    : `${base}?options=${encodeURIComponent(
        `-c search_path=${conn.searchPath}`,
      )}`;
}

/**
 * Canonical host identity used only for physical-target comparison. This is
 * deliberately pure: IP parsing and WHATWG IPv6 canonicalization perform no
 * DNS lookup, so equality remains deterministic and fail-closed.
 */
function normalizePhysicalHost(host: string): string {
  let normalized = host.toLowerCase();

  // DNS names are case-insensitive and a single final dot is the canonical
  // absolute-name marker, not a different endpoint (localhost. = localhost).
  if (!normalized.includes(':') && normalized.endsWith('.')) {
    normalized = normalized.slice(0, -1);
  }

  const unbracketed =
    normalized.startsWith('[') && normalized.endsWith(']')
      ? normalized.slice(1, -1)
      : normalized;
  const ipVersion = isIP(unbracketed);

  if (ipVersion === 4) {
    return unbracketed.startsWith('127.') ? 'loopback' : unbracketed;
  }
  if (ipVersion === 6) {
    // URL canonicalizes expanded/compressed and dotted/hex IPv6 spellings
    // without resolving them. Its hostname includes brackets for IPv6.
    const canonicalIpv6 = new URL(`http://[${unbracketed}]/`).hostname.slice(
      1,
      -1,
    );
    if (canonicalIpv6 === '::1') return 'loopback';

    // WHATWG renders IPv4-mapped IPv6 as ::ffff:<high16>:<low16>. Collapse
    // every mapped 127.0.0.0/8 address to the same loopback identity.
    const mappedIpv4 = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(
      canonicalIpv6,
    );
    if (mappedIpv4) {
      const high = Number.parseInt(mappedIpv4[1], 16);
      return high >>> 8 === 127 ? 'loopback' : canonicalIpv6;
    }
    return canonicalIpv6;
  }

  return normalized === 'localhost' ? 'loopback' : normalized;
}

/**
 * True when both connections resolve to the same physical database target.
 * Credentials and session policy (including search_path) are deliberately
 * excluded: changing either must never make the application database look
 * like a distinct physical target.
 */
export function normalizedEquals(
  first: PhysicalDatabaseIdentity,
  second: PhysicalDatabaseIdentity,
): boolean {
  return (
    first.protocol === second.protocol &&
    normalizePhysicalHost(first.host) === normalizePhysicalHost(second.host) &&
    first.port === second.port &&
    first.database === second.database
  );
}

/**
 * Derives the physical application database identity from DATABASE_URL.
 * Missing, malformed, aliased-protocol or unsupported connection properties
 * fail closed; the raw URL and credentials are never echoed.
 */
export function applicationDatabaseIdentity(
  environment: NodeJS.ProcessEnv = process.env,
): PhysicalDatabaseIdentity {
  const applicationUrl = environment.DATABASE_URL;
  if (!applicationUrl) {
    throw new TestDatabaseGuardError(
      'Refusing to run: DATABASE_URL is not set, so the application database identity cannot be verified.',
    );
  }
  let connection: EffectiveConnection;
  try {
    connection = parseEffectiveConnection(applicationUrl);
  } catch {
    throw new TestDatabaseGuardError(
      'Refusing to run: DATABASE_URL is malformed or unsupported.',
    );
  }
  if (!connection.host || !connection.port || !connection.database) {
    throw new TestDatabaseGuardError(
      'Refusing to run: DATABASE_URL does not identify a complete physical database target.',
    );
  }
  return {
    protocol: connection.protocol,
    host: connection.host,
    port: connection.port,
    database: connection.database,
  };
}

function assertConnectionTarget(conn: EffectiveConnection): void {
  if (!ALLOWED_TEST_HOSTS.has(conn.host)) {
    const hint = FORBIDDEN_HOST_PATTERNS.some((pattern) =>
      pattern.test(conn.host),
    )
      ? 'production/staging hosts are never allowed for automated tests'
      : `host '${conn.host}' is not in the test host allowlist`;
    throw new TestDatabaseGuardError(
      `Refusing to run: TEST_DATABASE_URL host '${conn.host}' is blocked — ${hint}.`,
    );
  }
  if (!ALLOWED_TEST_PORTS.has(conn.port)) {
    throw new TestDatabaseGuardError(
      `Refusing to run: TEST_DATABASE_URL port ${conn.port} is not in the test allowlist (expected 5433).`,
    );
  }
  if (!ALLOWED_TEST_USERS.has(conn.user)) {
    // The offending username value is deliberately omitted — usernames are
    // credentials and must never appear in error output.
    throw new TestDatabaseGuardError(
      'Refusing to run: TEST_DATABASE_URL user is not in the test user allowlist (only the dedicated moeen_test_runner role is accepted).',
    );
  }
  if (FORBIDDEN_PRODUCTION_DATABASES.has(conn.database)) {
    throw new TestDatabaseGuardError(
      `Refusing to run: TEST_DATABASE_URL database '${conn.database}' is a production/staging database name and is blocked for tests.`,
    );
  }
  if (!ALLOWED_TEST_DATABASES.has(conn.database)) {
    throw new TestDatabaseGuardError(
      `Refusing to run: TEST_DATABASE_URL database '${conn.database}' is not in the test database allowlist (moeen_test).`,
    );
  }
}

function assertSearchPath(searchPath: string | null): void {
  if (searchPath === null) {
    throw new TestDatabaseGuardError(
      "Refusing to run: TEST_DATABASE_URL has no search_path in its connection options; tests must run inside a dedicated 'moeen_test*' schema.",
    );
  }
  if (!TEST_SCHEMA_PATTERN.test(searchPath)) {
    // The raw search_path value is deliberately omitted — it could carry a
    // sensitive value supplied by an attacker-controlled URL.
    throw new TestDatabaseGuardError(
      "Refusing to run: TEST_DATABASE_URL search_path is not a dedicated test schema (expected 'moeen_test' or 'moeen_test_<run>').",
    );
  }
}

/**
 * Validates the test database configuration and returns the CANONICAL
 * connection URL (never the raw input). Throws TestDatabaseGuardError on the
 * first violation so no test process can start against a non-test database.
 */
export function assertTestDatabaseUrl(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (environment.NODE_ENV !== 'test') {
    throw new TestDatabaseGuardError(
      `Refusing to run: NODE_ENV must be 'test' for automated tests (got '${
        environment.NODE_ENV ?? '(unset)'
      }').`,
    );
  }
  const rawUrl = environment.TEST_DATABASE_URL;
  if (!rawUrl) {
    throw new TestDatabaseGuardError(
      'Refusing to run: TEST_DATABASE_URL is not set. Automated tests require a dedicated test database connection.',
    );
  }
  const conn = parseEffectiveConnection(rawUrl);
  assertConnectionTarget(conn);

  const applicationIdentity = applicationDatabaseIdentity(environment);
  if (normalizedEquals(conn, applicationIdentity)) {
    throw new TestDatabaseGuardError(
      'Refusing to run: TEST_DATABASE_URL matches DATABASE_URL: it resolves to the same physical database as DATABASE_URL. Automated tests must use a distinct database.',
    );
  }

  assertSearchPath(conn.searchPath);
  return buildCanonicalUrl(conn);
}

/** Extracts the search_path value from a PostgreSQL URL's `options` parameter, or null. */
export function extractSearchPath(parsed: URL): string | null {
  const options = parsed.searchParams.get('options');
  if (!options) return null;
  const match = /(?:^|[\s,])search_path\s*=\s*([^\s]+)/i.exec(options);
  if (!match) return null;
  let value = match[1];
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    value = value.slice(1, -1);
  }
  return value;
}

/**
 * Generates a fresh, unique run identifier for ONE test invocation.
 *
 * Deliberately NEVER reads the environment: any MOEEN_TEST_RUN_ID inherited
 * from a terminal, CI, npm or an external wrapper is ignored, so two
 * independently-started runs can never share a run id (and therefore a
 * schema) by accident or by force. Pure cryptographic randomness, no
 * timestamp, valid PostgreSQL schema-name charset ([a-z0-9], 4-52 chars —
 * the schema name moeen_test_<runId> stays within PostgreSQL's 63-byte
 * identifier limit).
 */
export function generateTestRunId(): string {
  return randomBytes(9).toString('hex');
}

/**
 * Validates a run identifier's shape before it is ever used in SQL or a
 * schema name. Throws TestDatabaseGuardError unless it is 4-52 lowercase
 * letters/digits (the same charset accepted for PostgreSQL identifiers, with
 * injection characters such as '-', '_', quotes and whitespace refused).
 */
export function validateTestRunId(runId: string): void {
  if (!TEST_RUN_ID_PATTERN.test(runId)) {
    // The offending value is deliberately omitted — it could be an inherited
    // environment value that must not surface in error output.
    throw new TestDatabaseGuardError(
      `Refusing to run: invalid test run id (must be ${TEST_RUN_ID_MIN_LENGTH}-${TEST_RUN_ID_MAX_LENGTH} lowercase letters/digits).`,
    );
  }
}

/** The unique schema name for a run id: moeen_test_<runId> (≤ 63 chars). */
export function runSchemaName(runId: string): string {
  validateTestRunId(runId);
  return `${TEST_SCHEMA_PREFIX}_${runId}`;
}

/**
 * Validates a Jest worker id (canonical decimal string 1..99, no leading zeros,
 * no non-digits, no zero). Worker ids come from JEST_WORKER_ID; anything else
 * is refused before it can reach a schema name.
 */
export function validateWorkerId(workerId: string): void {
  if (!TEST_WORKER_ID_PATTERN.test(workerId)) {
    throw new TestDatabaseGuardError(
      'Refusing to run: invalid Jest worker id (must be a canonical integer 1-99 with no leading zeros).',
    );
  }
  // The regex already rejects '0', leading zeros and non-canonical forms; the
  // numeric bound is a cheap, explicit second guard that is trivial to test.
  const numeric = Number(workerId);
  if (numeric < 1 || numeric > 99) {
    throw new TestDatabaseGuardError(
      'Refusing to run: invalid Jest worker id (must be 1-99).',
    );
  }
}

/**
 * The per-worker schema for a run: moeen_test_<runId>_w<workerId> (≤ 63
 * chars — the single canonical shape every file derives from the same
 * MOEEN_TEST_RUN_ID + JEST_WORKER_ID pair).
 */
export function workerSchemaName(runId: string, workerId: string): string {
  validateTestRunId(runId);
  validateWorkerId(workerId);
  return `${TEST_SCHEMA_PREFIX}_${runId}${WORKER_SUFFIX_PREFIX}${workerId}`;
}

/**
 * Generates a fresh, independent owner token for ONE test invocation.
 * Like the run id, it never reads the environment — inherited values are
 * ignored. It is only ever stored inside the run schema as a SHA-256 hash
 * and is never printed by any log line.
 */
export function generateOwnerToken(): string {
  return randomBytes(16).toString('hex');
}

/** Validates an owner token's shape (32-64 lowercase hex chars). */
export function validateOwnerToken(token: string): void {
  if (!TEST_OWNER_TOKEN_PATTERN.test(token)) {
    throw new TestDatabaseGuardError(
      'Refusing to run: invalid test owner token.',
    );
  }
}

/** SHA-256 hex digest of the owner token — the only form stored/comparable. */
export function ownerTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The role-privilege facts global-setup collects from the live database. */
export interface TestRoleSnapshot {
  /** The role the client authenticated as (session_user) — must equal current_user and the URL user. */
  sessionUser: string;
  currentUser: string;
  isSuperuser: boolean;
  canCreateDb: boolean;
  canCreateRole: boolean;
  isReplicationRole: boolean;
  bypassesRls: boolean;
  canCreateInPublic: boolean;
  canCreateInSharedTestSchema: boolean;
  canCreateOnAppDatabase: boolean;
  /** True when the role has CONNECT privilege on the derived application database. */
  canConnectAppDatabase: boolean;
  /** True when the role is a direct or indirect member of a forbidden role. */
  isMemberOfForbiddenRoles: boolean;
  /** True when the role has CONNECT privilege on the dedicated test database (required). */
  canConnectTestDatabase: boolean;
}

/**
 * Non-PostgreSQL/vendor roles that must never be granted to the test runner.
 * Predefined pg_* roles are discovered dynamically from pg_roles and the
 * complete membership graph; they must never depend on a fixed name list.
 */
const FORBIDDEN_MEMBERSHIP_ROLES: ReadonlySet<string> = new Set([
  'postgres',
  'rds_superuser',
  'rdsadmin',
  'azure_pg_admin',
  'cloudsqlsuperuser',
]);

/** Returns the set of roles whose membership is forbidden for the test role. */
export function getForbiddenMembershipRoles(): ReadonlySet<string> {
  return FORBIDDEN_MEMBERSHIP_ROLES;
}

/**
 * P1-3 — fail-closed privilege preflight (pure, table-driven testable).
 * The role used by automated tests must be exactly the dedicated restricted
 * test role that owns the TEST_DATABASE_URL user: not postgres, not
 * moeen_app, not a superuser, not a role with any wide privilege flag, with
 * no CREATE on the public schema, no CREATE on the shared moeen_test schema,
 * no CREATE or CONNECT on the application database, and with CONNECT on the
 * dedicated test database. Any violation refuses the run.
 *
 * Identity is verified fail-closed: session_user, current_user and the
 * configured TEST_DATABASE_URL user must ALL agree, and every collected
 * privilege fact must be a real boolean (a NULL fact — e.g. a missing
 * pg_roles row — is an inconsistent state and refuses the run).
 */
export function assertSafeTestRoleSnapshot(
  snapshot: TestRoleSnapshot,
  urlUser: string,
): void {
  const { currentUser, sessionUser } = snapshot;
  if (!sessionUser || !currentUser) {
    throw new TestDatabaseGuardError(
      'Q0-SEC privilege preflight: could not read the connected role identity — refusing to run.',
    );
  }
  if (sessionUser !== urlUser) {
    throw new TestDatabaseGuardError(
      'Q0-SEC privilege preflight: the session role does not match the TEST_DATABASE_URL user — refusing to run.',
    );
  }
  if (sessionUser !== currentUser) {
    throw new TestDatabaseGuardError(
      'Q0-SEC privilege preflight: session_user and current_user differ (SET ROLE in effect) — refusing to run.',
    );
  }
  if (currentUser !== urlUser) {
    throw new TestDatabaseGuardError(
      'Q0-SEC privilege preflight: the connected role does not match the TEST_DATABASE_URL user — refusing to run.',
    );
  }
  if (currentUser !== EXPECTED_TEST_ROLE) {
    throw new TestDatabaseGuardError(
      `Q0-SEC privilege preflight: refusing to run automated tests as role '${currentUser}' (only the dedicated ${EXPECTED_TEST_ROLE} role is accepted).`,
    );
  }
  // Fail closed on ambiguous state: every privilege fact must be a real
  // boolean. A NULL (missing pg_roles row, unknown privilege target) is
  // treated as a refusal, never as "false".
  const facts: Array<[string, unknown]> = [
    ['isSuperuser', snapshot.isSuperuser],
    ['canCreateDb', snapshot.canCreateDb],
    ['canCreateRole', snapshot.canCreateRole],
    ['isReplicationRole', snapshot.isReplicationRole],
    ['bypassesRls', snapshot.bypassesRls],
    ['canCreateInPublic', snapshot.canCreateInPublic],
    ['canCreateInSharedTestSchema', snapshot.canCreateInSharedTestSchema],
    ['canCreateOnAppDatabase', snapshot.canCreateOnAppDatabase],
    ['canConnectAppDatabase', snapshot.canConnectAppDatabase],
    ['isMemberOfForbiddenRoles', snapshot.isMemberOfForbiddenRoles],
    ['canConnectTestDatabase', snapshot.canConnectTestDatabase],
  ];
  for (const [name, value] of facts) {
    if (typeof value !== 'boolean') {
      throw new TestDatabaseGuardError(
        `Q0-SEC privilege preflight: role fact '${name}' is not a boolean (inconsistent privilege state) — refusing to run.`,
      );
    }
  }
  if (snapshot.isSuperuser) {
    throw new TestDatabaseGuardError(
      'Q0-SEC privilege preflight: refusing to run automated tests as a superuser role.',
    );
  }
  if (snapshot.canCreateDb) {
    throw new TestDatabaseGuardError(
      'Q0-SEC privilege preflight: refusing to run automated tests with CREATEDB privileges.',
    );
  }
  if (snapshot.canCreateRole) {
    throw new TestDatabaseGuardError(
      'Q0-SEC privilege preflight: refusing to run automated tests with CREATEROLE privileges.',
    );
  }
  if (snapshot.isReplicationRole) {
    throw new TestDatabaseGuardError(
      'Q0-SEC privilege preflight: refusing to run automated tests with REPLICATION privileges.',
    );
  }
  if (snapshot.bypassesRls) {
    throw new TestDatabaseGuardError(
      'Q0-SEC privilege preflight: refusing to run automated tests with BYPASSRLS privileges.',
    );
  }
  if (snapshot.canCreateInPublic) {
    throw new TestDatabaseGuardError(
      'Q0-SEC privilege preflight: the test role must not be able to create objects in the public schema.',
    );
  }
  if (snapshot.canCreateOnAppDatabase) {
    throw new TestDatabaseGuardError(
      'Q0-SEC privilege preflight: the test role must not be able to create objects in the application database.',
    );
  }
  if (snapshot.canConnectAppDatabase) {
    throw new TestDatabaseGuardError(
      'Q0-SEC privilege preflight: the test role must not be able to CONNECT to the application database.',
    );
  }
  if (snapshot.canCreateInSharedTestSchema) {
    throw new TestDatabaseGuardError(
      "Q0-SEC privilege preflight: the test role must not be able to modify the shared 'moeen_test' schema.",
    );
  }
  if (snapshot.isMemberOfForbiddenRoles) {
    throw new TestDatabaseGuardError(
      'Q0-SEC privilege preflight: the test role must not be a member (directly or indirectly) of privileged roles such as vendor/admin roles (postgres, rds_superuser, etc.).',
    );
  }
  if (!snapshot.canConnectTestDatabase) {
    throw new TestDatabaseGuardError(
      'Q0-SEC privilege preflight: the test role must have CONNECT privilege on the test database.',
    );
  }
}

/**
 * Q0-SEC — role-membership reachability boundary (recursive escalation gap).
 *
 * The identity/attribute preflight above validates only the role the session
 * is CURRENTLY using. PostgreSQL's SET ROLE lets the session switch to any
 * role it can reach through role membership — directly or recursively — and
 * the switched-to role's ATTRIBUTES (superuser, createdb, ...) apply to the
 * session immediately, even though attributes are never inherited through
 * plain membership. A test identity that can SET ROLE to a privileged role
 * is therefore one statement away from privilege escalation, no matter how
 * innocuously that role is named.
 *
 * PostgreSQL 16 stores three independent edge capabilities in
 * pg_auth_members: inherit_option exposes inherited privileges, set_option
 * permits SET ROLE, and admin_option enables self-grant/escalation. The
 * collector traverses ANY edge with one of those capabilities, recursively,
 * plus the implicit pg_database_owner membership PostgreSQL appends when a
 * reachable role owns the current database. This catches INHERIT-only
 * predefined roles as well as SET-only and ADMIN-only paths.
 *
 * The checker is fail-closed: an enumeration that is not an array, is empty,
 * lacks the session role itself, or carries a non-boolean fact refuses the
 * run. Every reachable role is inspected for dangerous ATTRIBUTES
 * (capability-based — no name list), and for PostgreSQL predefined system
 * roles: the 'pg_' prefix is reserved by PostgreSQL itself for system roles,
 * so a prefix check is authoritative rather than an easily-incomplete fixed
 * list — it covers pg_checkpoint, pg_create_subscription, pg_monitor,
 * pg_read_all_data, pg_database_owner, ... which carry no attribute flags
 * yet grant cluster-level capabilities.
 */
export interface TestReachableRole {
  roleName: string;
  isSuperuser: boolean;
  canCreateDb: boolean;
  canCreateRole: boolean;
  isReplicationRole: boolean;
  bypassesRls: boolean;
  /** True for PostgreSQL predefined system roles (the 'pg_' prefix is reserved). */
  isPredefinedSystemRole: boolean;
}

/** One pg_auth_members edge, including every PG16 reachability semantic. */
export interface TestRoleMembership {
  memberRoleName: string;
  targetRoleName: string;
  inheritOption: boolean;
  setOption: boolean;
  adminOption: boolean;
}

/**
 * Resolves the full role closure used by the privilege preflight. An edge is
 * reachable when PostgreSQL permits inherited privileges, SET ROLE, or role
 * administration/self-grant. The implicit pg_database_owner edge is included
 * when the current database owner is itself reachable.
 */
export function resolveReachableRoles(
  roles: readonly TestReachableRole[],
  memberships: readonly TestRoleMembership[],
  sessionUser: string,
  databaseOwner: string,
): TestReachableRole[] {
  if (!Array.isArray(roles) || !Array.isArray(memberships)) {
    throw new TestDatabaseGuardError(
      'Q0-SEC privilege preflight: could not enumerate the role membership graph — refusing to run.',
    );
  }
  const catalogRoles = roles as readonly TestReachableRole[];
  const catalogMemberships = memberships as readonly TestRoleMembership[];
  const byName = new Map<string, TestReachableRole>();
  for (const role of catalogRoles) {
    if (
      typeof role.roleName !== 'string' ||
      !role.roleName ||
      byName.has(role.roleName)
    ) {
      throw new TestDatabaseGuardError(
        'Q0-SEC privilege preflight: the role catalog is incomplete or ambiguous — refusing to run.',
      );
    }
    byName.set(role.roleName, role);
  }
  if (!byName.has(databaseOwner)) {
    throw new TestDatabaseGuardError(
      'Q0-SEC privilege preflight: the current database owner is absent from the role catalog — refusing to run.',
    );
  }
  const edges = new Map<string, string[]>();
  for (const membership of catalogMemberships) {
    const facts = [
      membership.inheritOption,
      membership.setOption,
      membership.adminOption,
    ];
    if (facts.some((value) => typeof value !== 'boolean')) {
      throw new TestDatabaseGuardError(
        'Q0-SEC privilege preflight: a role membership option is not boolean — refusing to run.',
      );
    }
    if (
      typeof membership.memberRoleName !== 'string' ||
      typeof membership.targetRoleName !== 'string' ||
      !byName.has(membership.memberRoleName) ||
      !byName.has(membership.targetRoleName)
    ) {
      throw new TestDatabaseGuardError(
        'Q0-SEC privilege preflight: a role membership references an unknown role — refusing to run.',
      );
    }
    if (!facts.some(Boolean)) continue;
    const targets = edges.get(membership.memberRoleName) ?? [];
    targets.push(membership.targetRoleName);
    edges.set(membership.memberRoleName, targets);
  }

  const reachableNames = new Set<string>();
  const queue = [sessionUser];
  while (queue.length > 0) {
    const roleName = queue.shift();
    if (!roleName || reachableNames.has(roleName)) continue;
    const role = byName.get(roleName);
    if (!role) {
      throw new TestDatabaseGuardError(
        'Q0-SEC privilege preflight: the session role is absent from the role catalog — refusing to run.',
      );
    }
    reachableNames.add(roleName);
    for (const target of edges.get(roleName) ?? []) queue.push(target);
    if (roleName === databaseOwner) queue.push('pg_database_owner');
  }
  return [...reachableNames].map((name) => {
    const role = byName.get(name);
    if (!role) {
      throw new TestDatabaseGuardError(
        'Q0-SEC privilege preflight: the reachable role closure is inconsistent — refusing to run.',
      );
    }
    return role;
  });
}

const REACHABLE_ROLE_VIOLATIONS: ReadonlyArray<
  [keyof TestReachableRole, string]
> = [
  ['isSuperuser', 'is a superuser'],
  ['canCreateDb', 'has the CREATEDB attribute'],
  ['canCreateRole', 'has the CREATEROLE attribute'],
  ['isReplicationRole', 'has the REPLICATION attribute'],
  ['bypassesRls', 'has the BYPASSRLS attribute'],
];

/**
 * Fail-closed role privilege-boundary check. `reachable` is the full closure
 * of roles reachable through INHERIT, SET, ADMIN/self-grant, or implicit
 * pg_database_owner semantics, collected from PostgreSQL's own catalogs.
 * Every reachable role must be free of dangerous attributes and must not be a
 * predefined system role; an incomplete or ambiguous enumeration refuses.
 */
export function assertSafeRoleReachability(
  reachable: readonly TestReachableRole[],
  sessionUser: string,
): void {
  if (!Array.isArray(reachable) || reachable.length === 0) {
    throw new TestDatabaseGuardError(
      'Q0-SEC privilege preflight: could not enumerate the roles reachable via SET ROLE or INHERIT/ADMIN membership — refusing to run.',
    );
  }
  // Array.isArray narrows the parameter to `any[]`; re-assert the static
  // element type so the type-aware lint rules keep checking the rest. The
  // runtime shape is still fully validated below (boolean facts, session
  // role presence) — this cast only restores static typing.
  const roles = reachable as readonly TestReachableRole[];
  // The session role itself is ALWAYS in the closure (SET ROLE to one's own
  // role is always allowed). Its absence means the enumeration is
  // incomplete — refuse, never assume.
  if (!roles.some((role) => role.roleName === sessionUser)) {
    throw new TestDatabaseGuardError(
      'Q0-SEC privilege preflight: the SET ROLE enumeration does not include the session role — refusing to run.',
    );
  }
  for (const role of roles) {
    for (const [flag, violation] of REACHABLE_ROLE_VIOLATIONS) {
      const value = role[flag];
      if (typeof value !== 'boolean') {
        throw new TestDatabaseGuardError(
          `Q0-SEC privilege preflight: SET ROLE reachability fact '${flag}' for role '${role.roleName}' is not a boolean (inconsistent privilege state) — refusing to run.`,
        );
      }
      if (value) {
        throw new TestDatabaseGuardError(
          `Q0-SEC privilege preflight: the test role can SET ROLE to '${role.roleName}' or inherit/administer that role, which ${violation} — refusing to run.`,
        );
      }
    }
    if (typeof role.isPredefinedSystemRole !== 'boolean') {
      throw new TestDatabaseGuardError(
        "Q0-SEC privilege preflight: SET ROLE reachability fact 'isPredefinedSystemRole' for role '" +
          `${role.roleName}' is not a boolean (inconsistent privilege state) — refusing to run.`,
      );
    }
    if (role.isPredefinedSystemRole) {
      throw new TestDatabaseGuardError(
        `Q0-SEC privilege preflight: the test role can SET ROLE to the predefined PostgreSQL system role '${role.roleName}' or reach it through INHERIT/ADMIN membership — refusing to run.`,
      );
    }
  }
}

/**
 * Rewrites the URL's search_path to the run-unique schema and returns the new
 * canonical URL. The input is fully re-validated first (effective connection
 * parsing incl. the query-parameter policy), so the result is guaranteed to
 * pass every guard rule again.
 */
export function withRunSchema(url: string, runId: string): string {
  const conn = parseEffectiveConnection(url);
  validateTestRunId(runId);
  return buildCanonicalUrl({ ...conn, searchPath: runSchemaName(runId) });
}

/**
 * Rewrites the URL's search_path to the per-worker schema and returns the new
 * canonical URL. Same guarantees as withRunSchema — the input is fully
 * re-validated first, so the result passes every guard rule again.
 */
export function withWorkerSchema(
  url: string,
  runId: string,
  workerId: string,
): string {
  const conn = parseEffectiveConnection(url);
  validateTestRunId(runId);
  validateWorkerId(workerId);
  return buildCanonicalUrl({
    ...conn,
    searchPath: workerSchemaName(runId, workerId),
  });
}

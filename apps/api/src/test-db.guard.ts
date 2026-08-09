import { createHash, randomBytes } from 'node:crypto';

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

/** Database users a test connection may use (postgres/superuser is refused by the role preflight). */
const ALLOWED_TEST_USERS: ReadonlySet<string> = new Set([
  'moeen_app',
  'moeen_test_runner',
]);

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
 * Identifier limits (P1-2): PostgreSQL identifiers are at most 63 bytes, and
 * the run schema is `moeen_test_<runId>` (10 + 1 + runId), so run ids are
 * capped at 52. The same bound feeds validateTestRunId, TEST_SCHEMA_PATTERN
 * and the teardown ownership check.
 */
const SCHEMA_PREFIX_LENGTH = TEST_SCHEMA_PREFIX.length; // 10 ('moeen_test')
const PG_IDENTIFIER_MAX_LENGTH = 63;
export const TEST_RUN_ID_MIN_LENGTH = 4;
export const TEST_RUN_ID_MAX_LENGTH =
  PG_IDENTIFIER_MAX_LENGTH - SCHEMA_PREFIX_LENGTH - 1; // 52

/** A test schema is exactly `moeen_test` or `moeen_test_<lowercase run id>`. */
export const TEST_SCHEMA_PATTERN = new RegExp(
  `^${TEST_SCHEMA_PREFIX}(?:_[a-z0-9]{${TEST_RUN_ID_MIN_LENGTH},${TEST_RUN_ID_MAX_LENGTH}})?$`,
);

const TEST_RUN_ID_PATTERN = new RegExp(
  `^[a-z0-9]{${TEST_RUN_ID_MIN_LENGTH},${TEST_RUN_ID_MAX_LENGTH}}$`,
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

  const host = parsed.hostname;
  const port = parsed.port || '5432';
  let user: string;
  let password: string;
  try {
    user = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
  } catch {
    throw new TestDatabaseGuardError(
      'Refusing to run: TEST_DATABASE_URL is malformed or unsupported.',
    );
  }
  const database = parsed.pathname.replace(/^\/+/, '');

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

/** True when both effective connections target the same database. */
export function normalizedEquals(
  first: EffectiveConnection,
  second: EffectiveConnection,
): boolean {
  return (
    first.protocol === second.protocol &&
    first.host === second.host &&
    first.port === second.port &&
    first.user === second.user &&
    first.database === second.database &&
    (first.searchPath ?? '') === (second.searchPath ?? '')
  );
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
      'Refusing to run: TEST_DATABASE_URL user is not in the test user allowlist (moeen_app).',
    );
  }
  if (FORBIDDEN_PRODUCTION_DATABASES.has(conn.database)) {
    throw new TestDatabaseGuardError(
      `Refusing to run: TEST_DATABASE_URL database '${conn.database}' is a production/staging database name and is blocked for tests.`,
    );
  }
  if (!ALLOWED_TEST_DATABASES.has(conn.database)) {
    throw new TestDatabaseGuardError(
      `Refusing to run: TEST_DATABASE_URL database '${conn.database}' is not in the test database allowlist (moeen_test; 'moeen' only as the documented schema-confined local exception).`,
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

  const applicationUrl = environment.DATABASE_URL;
  if (applicationUrl) {
    let appConn: EffectiveConnection;
    try {
      appConn = parseEffectiveConnection(applicationUrl);
    } catch {
      // Generic on purpose — the raw application URL must never be echoed.
      throw new TestDatabaseGuardError(
        'Refusing to run: DATABASE_URL is malformed or unsupported.',
      );
    }
    if (normalizedEquals(conn, appConn)) {
      throw new TestDatabaseGuardError(
        'Refusing to run: TEST_DATABASE_URL matches DATABASE_URL. Automated tests must never use the application database connection.',
      );
    }
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

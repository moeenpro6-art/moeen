import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { parse as parsePgConnectionString } from 'pg-connection-string';
import {
  EXPECTED_TEST_ROLE,
  TEST_SCHEMA_PATTERN,
  TEST_RUN_ID_MAX_LENGTH,
  TEST_OWNER_TOKEN_ENV,
  TEST_RUN_ID_ENV,
  TestDatabaseGuardError,
  TestReachableRole,
  TestRoleMembership,
  TestRoleSnapshot,
  applicationDatabaseIdentity,
  assertSafeRoleReachability,
  assertSafeTestRoleSnapshot,
  assertTestDatabaseUrl,
  buildCanonicalUrl,
  extractSearchPath,
  generateOwnerToken,
  generateTestRunId,
  getForbiddenMembershipRoles,
  normalizedEquals,
  ownerTokenHash,
  parseEffectiveConnection,
  resolveReachableRoles,
  runSchemaName,
  validateOwnerToken,
  validateTestRunId,
  validateWorkerId,
  withRunSchema,
  withWorkerSchema,
  workerSchemaName,
} from './test-db.guard';
import globalTeardown from '../test/setup/global-teardown';
import {
  collectReachableRoles,
  collectTestRoleSnapshot,
} from '../test/setup/global-setup';
import {
  classifyOwnedSchemaByOid,
  createOwnedSchema,
  dropOwnedSchemaAtomically,
  isOwnershipClientDiscarded,
  OWNERSHIP_MARKER_TABLE,
  qualifiedMarkerTable,
  quoteIdent,
  releaseOwnershipClient,
  verifySearchPathExactly,
} from '../test/setup/ownership';
// The ownership module namespace, used to spy on the setup hook's imported
// bindings (the per-worker reuse regression needs to observe what the hook
// calls on this module).
import * as ownershipModule from '../test/setup/ownership';
// The per-worker setup hook is a CommonJS callable (module.exports) — import
// it with the TS import-equals form so the call here is type-safe and jest's
// setupFiles contract stays untouched.
import setupTestEnv = require('../test/setup/setup-test-env');

const LOCAL_TEST_URL =
  'postgresql://moeen_test_runner:local-password@localhost:5433/moeen_test?options=-c%20search_path%3Dmoeen_test';

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    TEST_DATABASE_URL: LOCAL_TEST_URL,
    DATABASE_URL: 'postgresql://moeen_app:local-password@localhost:5433/moeen',
    ...overrides,
  };
}

describe('test database guard (Q0-SEC)', () => {
  it('accepts the canonical local test URL and returns it unchanged', () => {
    expect(assertTestDatabaseUrl(env())).toBe(LOCAL_TEST_URL);
  });

  it('accepts a run-scoped local test URL', () => {
    const runUrl = withRunSchema(LOCAL_TEST_URL, generateTestRunId());
    expect(assertTestDatabaseUrl({ ...env(), TEST_DATABASE_URL: runUrl })).toBe(
      runUrl,
    );
  });

  it('refuses the application database moeen now that a dedicated moeen_test database exists', () => {
    // The documented local-dev exception is gone: a real moeen_test database
    // exists, so the application database is never a valid test target even
    // with a dedicated test search_path.
    const exceptionUrl =
      'postgresql://moeen_test_runner:***@localhost:5433/moeen?options=-c%20search_path%3Dmoeen_test';
    expect(() =>
      assertTestDatabaseUrl(env({ TEST_DATABASE_URL: exceptionUrl })),
    ).toThrow(/not in the test database allowlist/);
  });

  it('refuses the application database moeen when it is not confined to a test schema', () => {
    // Same database but no dedicated test search_path: this is the application
    // schema and must be rejected.
    expect(() =>
      assertTestDatabaseUrl(
        env({
          TEST_DATABASE_URL:
            'postgresql://moeen_test_runner:pw@localhost:5433/moeen',
        }),
      ),
    ).toThrow(TestDatabaseGuardError);
  });

  it('refuses to run when TEST_DATABASE_URL is missing', () => {
    expect(() => assertTestDatabaseUrl(env({ TEST_DATABASE_URL: '' }))).toThrow(
      TestDatabaseGuardError,
    );
    expect(() =>
      assertTestDatabaseUrl(env({ TEST_DATABASE_URL: undefined })),
    ).toThrow(/TEST_DATABASE_URL is not set/);
  });

  it('refuses to run when NODE_ENV is not test', () => {
    expect(() =>
      assertTestDatabaseUrl(env({ NODE_ENV: 'production' })),
    ).toThrow(/NODE_ENV must be 'test'/);
  });

  it('refuses an invalid URL', () => {
    expect(() =>
      assertTestDatabaseUrl(env({ TEST_DATABASE_URL: 'not-a-url-at-all' })),
    ).toThrow(/malformed or unsupported/);
  });

  it('refuses a URL that matches DATABASE_URL exactly', () => {
    const applicationUrl =
      'postgresql://moeen_test_runner:pw@localhost:5433/moeen_test';
    expect(() =>
      assertTestDatabaseUrl(
        env({
          TEST_DATABASE_URL: applicationUrl,
          DATABASE_URL: applicationUrl,
        }),
      ),
    ).toThrow(/matches DATABASE_URL/);
  });

  it('refuses a URL matching DATABASE_URL even when both carry the same search_path', () => {
    const url =
      'postgresql://moeen_test_runner:pw@localhost:5433/moeen_test?options=-c%20search_path%3Dmoeen_test';
    expect(() =>
      assertTestDatabaseUrl(env({ TEST_DATABASE_URL: url, DATABASE_URL: url })),
    ).toThrow(/matches DATABASE_URL/);
  });

  it('refuses the same physical application database despite different credentials and search_path', () => {
    const testUrl =
      'postgresql://moeen_test_runner:test-secret@localhost:5433/moeen_test?options=-c%20search_path%3Dmoeen_test';
    const applicationUrl =
      'postgresql://moeen_app:app-secret@localhost:5433/moeen_test?options=-c%20search_path%3Dapplication_private';

    expect(
      normalizedEquals(
        parseEffectiveConnection(testUrl),
        parseEffectiveConnection(applicationUrl),
      ),
    ).toBe(true);
    expect(() =>
      assertTestDatabaseUrl(
        env({ TEST_DATABASE_URL: testUrl, DATABASE_URL: applicationUrl }),
      ),
    ).toThrow(/same physical database as DATABASE_URL/);
  });

  it('refuses node-postgres-equivalent physical targets despite encoded database and loopback spellings', () => {
    const testUrl =
      'postgresql://moeen_test_runner:***@localhost:5433/moeen_test?options=-c%20search_path%3Dmoeen_test';
    const applicationUrls = [
      // pg-connection-string decodes this database name to moeen_test.
      'postgresql://moeen_app:***@localhost:5433/%6doeen%5ftest?options=-c%20search_path%3Dapplication_private',
      // All accepted local host spellings address the same fail-closed local
      // physical boundary for a given port/database.
      'postgresql://moeen_app:***@127.0.0.1:5433/moeen_test?options=-c%20search_path%3Dapplication_private',
      'postgresql://moeen_app:***@[::1]:5433/moeen_test?options=-c%20search_path%3Dapplication_private',
      // DNS hostnames are case-insensitive.
      'postgresql://moeen_app:***@LOCALHOST:5433/moeen_test?options=-c%20search_path%3Dapplication_private',
    ];

    for (const applicationUrl of applicationUrls) {
      expect(
        normalizedEquals(
          parseEffectiveConnection(testUrl),
          applicationDatabaseIdentity({ DATABASE_URL: applicationUrl }),
        ),
      ).toBe(true);
      expect(() =>
        assertTestDatabaseUrl(
          env({ TEST_DATABASE_URL: testUrl, DATABASE_URL: applicationUrl }),
        ),
      ).toThrow(/same physical database as DATABASE_URL/);
    }
  });

  describe('deterministic loopback physical identity normalization', () => {
    it.each([
      { label: 'localhost', authority: 'localhost' },
      { label: 'localhost.', authority: 'localhost.' },
      { label: '127.0.0.1', authority: '127.0.0.1' },
      { label: '127.0.0.2', authority: '127.0.0.2' },
      { label: '127.255.255.254', authority: '127.255.255.254' },
      { label: '::1', authority: '[::1]' },
      {
        label: '::ffff:127.0.0.1',
        authority: '[::ffff:127.0.0.1]',
      },
    ])(
      'normalizes $label to the same physical target despite credentials and search_path',
      ({ authority }) => {
        const testUrl = LOCAL_TEST_URL;
        const applicationUrl =
          `postgresql://application_user:application_password@${authority}:5433/moeen_test` +
          '?options=-c%20search_path%3Dapplication_private';
        const applicationIdentity = applicationDatabaseIdentity({
          DATABASE_URL: applicationUrl,
        });

        expect(
          normalizedEquals(
            parseEffectiveConnection(testUrl),
            applicationIdentity,
          ),
        ).toBe(true);
        expect(() =>
          assertTestDatabaseUrl(
            env({ TEST_DATABASE_URL: testUrl, DATABASE_URL: applicationUrl }),
          ),
        ).toThrow(/same physical database as DATABASE_URL/);
      },
    );
  });

  it('refuses an incomplete DATABASE_URL physical identity', () => {
    expect(() =>
      assertTestDatabaseUrl(
        env({ DATABASE_URL: 'postgresql://localhost:5433' }),
      ),
    ).toThrow(/does not identify a complete physical database target/);
  });

  it('accepts a genuinely distinct test database and derives the application database identity', () => {
    const environment = env();
    const testIdentity = parseEffectiveConnection(
      environment.TEST_DATABASE_URL as string,
    );
    const applicationIdentity = applicationDatabaseIdentity(environment);

    expect(normalizedEquals(testIdentity, applicationIdentity)).toBe(false);
    expect(applicationIdentity.database).toBe('moeen');
    expect(() => assertTestDatabaseUrl(environment)).not.toThrow();
  });

  it('refuses a valid test target when DATABASE_URL is missing (physical identity cannot be proven)', () => {
    expect(() =>
      assertTestDatabaseUrl(env({ DATABASE_URL: undefined })),
    ).toThrow(/DATABASE_URL is not set/);
  });

  it('accepts the local test URL next to a DATABASE_URL without search_path', () => {
    // The legitimate layout: a dedicated test database, and the application
    // DATABASE_URL pointing at the application database.
    expect(() => assertTestDatabaseUrl(env())).not.toThrow();
  });

  describe('production/staging hosts are rejected even when set in the environment', () => {
    const productionHosts = [
      'postgres.railway.internal',
      'moeen-production.up.railway.app',
      'db.staging.example.com',
      'moeen-prod-db.example.org',
      'ec2-3-10-100-1.eu-west-2.compute.amazonaws.com',
      '34.199.42.7',
      'db.onrender.com',
      'moeen.railway.app',
    ];

    for (const host of productionHosts) {
      it(`rejects host '${host}'`, () => {
        const url = `postgresql://postgres:secret@${host}:5432/moeen_test`;
        expect(() =>
          // NODE_ENV=test and a valid-looking URL are not enough: the host
          // allowlist must block it regardless of anything else.
          assertTestDatabaseUrl(
            env({ TEST_DATABASE_URL: url, DATABASE_URL: undefined }),
          ),
        ).toThrow(/host '.*' is blocked/);
      });
    }

    it('rejects a production host even when DATABASE_URL is unset', () => {
      expect(() =>
        assertTestDatabaseUrl(
          env({
            TEST_DATABASE_URL:
              'postgresql://postgres:secret@postgres.railway.internal:5432/moeen_test',
            DATABASE_URL: undefined,
          }),
        ),
      ).toThrow(/host 'postgres\.railway\.internal' is blocked/);
    });
  });

  describe('production/staging database names are rejected', () => {
    const productionDatabases = [
      'moeen_prod',
      'moeen_production',
      'moeen_staging',
      'moeen_stage',
      'moeen_preprod',
      'moeen_qa',
      'railway',
      'postgres',
      'template0',
    ];

    for (const database of productionDatabases) {
      it(`rejects database '${database}' even on localhost`, () => {
        const url = `postgresql://moeen_test_runner:pw@localhost:5433/${database}?options=-c%20search_path%3Dmoeen_test`;
        expect(() =>
          assertTestDatabaseUrl(env({ TEST_DATABASE_URL: url })),
        ).toThrow(TestDatabaseGuardError);
      });
    }

    it('rejects a database name outside the allowlist', () => {
      expect(() =>
        assertTestDatabaseUrl(
          env({
            TEST_DATABASE_URL:
              'postgresql://moeen_test_runner:pw@localhost:5433/analytics?options=-c%20search_path%3Dmoeen_test',
          }),
        ),
      ).toThrow(/not in the test database allowlist/);
    });
  });

  it('rejects a database user outside the allowlist', () => {
    expect(() =>
      assertTestDatabaseUrl(
        env({
          TEST_DATABASE_URL:
            'postgresql://railway:pw@localhost:5433/moeen_test?options=-c%20search_path%3Dmoeen_test',
        }),
      ),
    ).toThrow(/user is not in the test user allowlist/);
  });

  it('rejects a port outside the allowlist', () => {
    expect(() =>
      assertTestDatabaseUrl(
        env({
          TEST_DATABASE_URL:
            'postgresql://moeen_test_runner:pw@localhost:5432/moeen_test?options=-c%20search_path%3Dmoeen_test',
        }),
      ),
    ).toThrow(/port 5432 is not in the test allowlist/);
  });

  describe('search_path must be a dedicated test schema', () => {
    const rejectedSearchPaths = [
      undefined, // no options at all
      '', // empty options
      'moeen', // the application schema
      'public',
      'moeen_test,public', // multi-schema path escapes into shared data
      '$user',
      'moeen_test_ABC', // uppercase run id
      'moeen_dev',
    ];

    for (const searchPath of rejectedSearchPaths) {
      it(`rejects search_path '${String(searchPath)}'`, () => {
        const base =
          'postgresql://moeen_test_runner:pw@localhost:5433/moeen_test';
        const url =
          searchPath === undefined || searchPath === ''
            ? base
            : `${base}?options=${encodeURIComponent(
                `-c search_path=${searchPath}`,
              )}`;
        expect(() =>
          assertTestDatabaseUrl(env({ TEST_DATABASE_URL: url })),
        ).toThrow(TestDatabaseGuardError);
      });
    }

    it('accepts a search_path of moeen_test_<run>', () => {
      const url =
        'postgresql://moeen_test_runner:pw@localhost:5433/moeen_test?options=-c%20search_path%3Dmoeen_test_abc123';
      expect(() =>
        assertTestDatabaseUrl(env({ TEST_DATABASE_URL: url })),
      ).not.toThrow();
    });
  });

  describe('extractSearchPath', () => {
    it('extracts the search_path from the options parameter', () => {
      expect(extractSearchPath(new URL(LOCAL_TEST_URL))).toBe('moeen_test');
      expect(
        extractSearchPath(
          new URL(
            'postgresql://moeen_test_runner:pw@localhost:5433/moeen_test?options=-c%20search_path%3Dmoeen_test_abc123',
          ),
        ),
      ).toBe('moeen_test_abc123');
    });

    it('returns null when no options/search_path is present', () => {
      expect(
        extractSearchPath(
          new URL(
            'postgresql://moeen_test_runner:pw@localhost:5433/moeen_test',
          ),
        ),
      ).toBeNull();
      expect(
        extractSearchPath(
          new URL(
            'postgresql://moeen_test_runner:pw@localhost:5433/moeen_test?sslmode=require',
          ),
        ),
      ).toBeNull();
    });
  });

  describe('run-scoped schemas', () => {
    it('workers inherit the run URL, rewritten by setupFiles to the per-worker schema (P2-1)', () => {
      const runId = process.env.MOEEN_TEST_RUN_ID;
      const workerId = process.env.JEST_WORKER_ID ?? '1';
      expect(runId).toBeTruthy();
      // P2-1 contract: the shim hands every worker the RUN URL, and
      // test/setup/setup-test-env.ts (setupFiles) rewrites THIS worker's
      // process env to its own schema — so inside a running worker the
      // effective search_path is the canonical worker schema.
      const searchPath = extractSearchPath(
        new URL(process.env.TEST_DATABASE_URL as string),
      );
      expect(searchPath).toBe(workerSchemaName(runId as string, workerId));
      expect(searchPath).toMatch(TEST_SCHEMA_PATTERN);
    });

    it('accepts only canonical worker ids 1..99 and rejects leading zeros and zero', () => {
      for (const good of ['1', '2', '9', '10', '50', '99']) {
        expect(() => validateWorkerId(good)).not.toThrow();
        expect(workerSchemaName('a'.repeat(48), good)).toContain(`_w${good}`);
      }
      for (const bad of [
        '0',
        '00',
        '01',
        '001',
        '010',
        '100',
        '999',
        '-1',
        '1.0',
        '1e1',
        ' 1',
        '1 ',
        'one',
        '',
        '0x1',
      ]) {
        expect(() => validateWorkerId(bad)).toThrow(/invalid Jest worker id/);
      }
    });

    it('schema pattern and worker URL accept only canonical worker ids (boundaries 1/99)', () => {
      const runId = 'a'.repeat(TEST_RUN_ID_MAX_LENGTH);
      // Valid boundaries: worker 1 and worker 99, at both the schema-name
      // pattern and the URL-rewrite enforcement paths.
      for (const good of ['1', '99']) {
        expect(TEST_SCHEMA_PATTERN.test(`moeen_test_${runId}_w${good}`)).toBe(
          true,
        );
        expect(() =>
          withWorkerSchema(LOCAL_TEST_URL, runId, good),
        ).not.toThrow();
        expect(withWorkerSchema(LOCAL_TEST_URL, runId, good)).toContain(
          `_w${good}`,
        );
      }
      // Invalid: zero, leading-zero forms, and out-of-range values are
      // rejected at the schema-name pattern AND by the URL rewrite.
      for (const bad of ['0', '00', '01', '001', '010', '100', '999']) {
        expect(TEST_SCHEMA_PATTERN.test(`moeen_test_${runId}_w${bad}`)).toBe(
          false,
        );
        expect(() => withWorkerSchema(LOCAL_TEST_URL, runId, bad)).toThrow(
          /invalid Jest worker id/,
        );
      }
      // The bare run schema (no worker suffix) still passes, and a worker
      // suffix can never appear without a run id.
      expect(TEST_SCHEMA_PATTERN.test(`moeen_test_${runId}`)).toBe(true);
      expect(TEST_SCHEMA_PATTERN.test(`moeen_test_w1`)).toBe(false);
    });

    it('produces a distinct schema per run id', () => {
      const first = withRunSchema(LOCAL_TEST_URL, 'runone');
      const second = withRunSchema(LOCAL_TEST_URL, 'runtwo');
      expect(first).not.toBe(second);
      expect(new URL(first).searchParams.get('options')).toBe(
        '-c search_path=moeen_test_runone',
      );
      expect(new URL(second).searchParams.get('options')).toBe(
        '-c search_path=moeen_test_runtwo',
      );
      expect(runSchemaName('runone')).toBe('moeen_test_runone');
      expect(runSchemaName('runtwo')).toBe('moeen_test_runtwo');
    });

    it('generates a fresh, unique run id on every call', () => {
      const first = generateTestRunId();
      const second = generateTestRunId();
      expect(first).not.toBe(second);
      expect(runSchemaName(first)).toMatch(/^moeen_test_[a-z0-9]+$/);
      expect(first).toMatch(/^[a-z0-9]{4,64}$/);
    });

    it('never reuses an inherited MOEEN_TEST_RUN_ID when generating', () => {
      // The QA finding: an inherited value must never be returned as-is, so
      // two independent invocations can never share a run id by accident or
      // by force. Generation is deliberately environment-free.
      process.env.MOEEN_TEST_RUN_ID = 'f00d1234abcd';
      try {
        const generated = generateTestRunId();
        expect(generated).not.toBe('f00d1234abcd');
        expect(generated).toMatch(/^[a-z0-9]{4,64}$/);
      } finally {
        delete process.env.MOEEN_TEST_RUN_ID;
      }
    });

    it('validates run id shape without accepting foreign characters', () => {
      expect(() => validateTestRunId('f00d1234abcd')).not.toThrow();
      expect(() => validateTestRunId('runone')).not.toThrow();
      for (const bad of [
        '',
        'abc',
        'UPPER',
        'with-dash',
        'with_underscore',
        'x'.repeat(65),
        'x; DROP SCHEMA public CASCADE',
      ]) {
        expect(() => validateTestRunId(bad)).toThrow(/invalid test run id/);
      }
    });

    it('refuses a malicious run id before it reaches SQL', () => {
      expect(() => runSchemaName('x; DROP SCHEMA public CASCADE')).toThrow(
        /invalid test run id/,
      );
      expect(() => withRunSchema(LOCAL_TEST_URL, 'UPPER-case')).toThrow(
        /invalid test run id/,
      );
    });
  });

  describe('shim run-id freshness (Q0-SEC regression)', () => {
    // Requirement C: a MOEEN_TEST_RUN_ID inherited from a terminal, CI, npm
    // or any wrapper must NEVER be reused by scripts/with-test-env.js. This
    // spawns the REAL shim (end to end) twice with the SAME inherited value
    // and asserts each invocation generates its own fresh run id.
    const shimPath = path.resolve(__dirname, '../scripts/with-test-env.js');
    const INHERITED = 'f00d1234abcd';

    function invokeShim(): string {
      const output = execFileSync(
        process.execPath,
        [shimPath, 'jest', '--listTests'],
        {
          env: { ...process.env, MOEEN_TEST_RUN_ID: INHERITED },
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
      const match =
        /\[test-db\] run ([a-z0-9]{4,64}) schema (moeen_test_[a-z0-9]+)/.exec(
          output,
        );
      expect(match).not.toBeNull();
      const [, runId, schema] = match as RegExpExecArray;
      expect(schema).toBe(`moeen_test_${runId}`);
      return runId;
    }

    it('ignores the inherited MOEEN_TEST_RUN_ID and generates a fresh id per invocation', () => {
      const first = invokeShim();
      const second = invokeShim();
      expect(first).not.toBe(INHERITED);
      expect(second).not.toBe(INHERITED);
      expect(first).not.toBe(second);
    }, 120_000);
  });

  describe('credential non-disclosure (Q0-SEC regression)', () => {
    // QA finding: guard error messages must never surface the raw
    // TEST_DATABASE_URL — its username/password or query parameters. Every
    // assertion below uses clearly fake credentials and proves they never
    // reach any error message or the shim's stdout/stderr.
    const USER = 'q0secretuser';
    const PASSWORD = 'q0secretpassword';
    const TOKEN = 'q0secrettoken';
    const SECRET_PATH = 'q0secretpath';

    function refusalMessage(overrides: NodeJS.ProcessEnv): string {
      try {
        assertTestDatabaseUrl(env(overrides));
        throw new Error('expected the guard to refuse');
      } catch (error) {
        expect(error).toBeInstanceOf(TestDatabaseGuardError);
        return (error as Error).message;
      }
    }

    it('never leaks credentials from a malformed URL (A)', () => {
      // Unbalanced IPv6 bracket: guarantees the URL constructor throws while
      // the input still carries the fake credentials.
      const raw = `postgresql://${USER}:${PASSWORD}@[bad:5433/moeen_test`;
      const message = refusalMessage({ TEST_DATABASE_URL: raw });
      expect(message).toMatch(/malformed or unsupported/);
      expect(message).not.toContain(USER);
      expect(message).not.toContain(PASSWORD);
      expect(message).not.toContain(raw);
    });

    it('never leaks credentials when TEST_DATABASE_URL matches DATABASE_URL (B)', () => {
      const url = `postgresql://moeen_test_runner:${PASSWORD}@localhost:5433/moeen_test?options=-c%20search_path%3Dmoeen_test`;
      const message = refusalMessage({
        TEST_DATABASE_URL: url,
        DATABASE_URL: url,
      });
      expect(message).toMatch(/matches DATABASE_URL/);
      expect(message).not.toContain(PASSWORD);
      expect(message).not.toContain(url);
    });

    it('never leaks credentials or query parameters across guard failures (C)', () => {
      const urls = [
        // host refusal (username branch fires first for the first two)
        `postgresql://${USER}:${PASSWORD}@q0host.invalid:5433/moeen_test`,
        `postgresql://${USER}:${PASSWORD}@localhost:9999/moeen_test`,
        // database allowlist refusal
        `postgresql://moeen_test_runner:${PASSWORD}@localhost:5433/q0secretdb`,
        // search_path refusal with a sensitive query string
        `postgresql://moeen_test_runner:${PASSWORD}@localhost:5433/moeen_test?token=${TOKEN}&options=${encodeURIComponent(
          `-c search_path=${SECRET_PATH}`,
        )}`,
      ];
      for (const raw of urls) {
        const message = refusalMessage({ TEST_DATABASE_URL: raw });
        expect(message).not.toContain(USER);
        expect(message).not.toContain(PASSWORD);
        expect(message).not.toContain(TOKEN);
        expect(message).not.toContain(SECRET_PATH);
        expect(message).not.toContain(raw);
      }
    });

    it('shim stdout/stderr never contains credentials (D)', () => {
      const raw = `postgresql://${USER}:${PASSWORD}@q0host.invalid:5433/moeen_test`;
      const shimPath = path.resolve(__dirname, '../scripts/with-test-env.js');
      const captured: string[] = [];
      const applicationUrl = process.env.DATABASE_URL as string;
      for (const testDatabaseUrl of [raw, applicationUrl]) {
        try {
          execFileSync(process.execPath, [shimPath, 'jest', '--listTests'], {
            env: { ...process.env, TEST_DATABASE_URL: testDatabaseUrl },
            encoding: 'utf8',
            timeout: 60_000,
          });
          throw new Error('expected the shim to refuse');
        } catch (error) {
          const failure = error as {
            status?: number;
            stdout?: string;
            stderr?: string;
          };
          expect(failure.status).toBe(1);
          captured.push(`${failure.stdout ?? ''}${failure.stderr ?? ''}`);
        }
      }
      const all = captured.join('\n');
      expect(all).not.toContain(USER);
      expect(all).not.toContain(PASSWORD);
      expect(all).not.toContain(raw);
      expect(all).not.toContain(applicationUrl);
    }, 120_000);
  });

  describe('effective connection verification (P1-1)', () => {
    // node-postgres applies query parameters that override the URL authority.
    // The guard must refuse every connection-affecting parameter so pg can
    // never connect anywhere the guard did not approve.
    const GOOD_OPTIONS = 'options=-c%20search_path%3Dmoeen_test';
    const BASE = 'postgresql://moeen_test_runner:pw@localhost:5433/moeen_test';

    for (const key of [
      'host',
      'port',
      'user',
      'username',
      'password',
      'database',
      'dbname',
      'ssl',
      'sslmode',
      'application_name',
    ]) {
      it(`rejects the connection-affecting query parameter '${key}'`, () => {
        const url = `${BASE}?${key}=whatever&${GOOD_OPTIONS}`;
        expect(() =>
          assertTestDatabaseUrl(env({ TEST_DATABASE_URL: url })),
        ).toThrow(new RegExp(`query parameter '${key}' is not allowed`));
      });
    }

    it('rejects duplicated query parameters', () => {
      const url = `${BASE}?${GOOD_OPTIONS}&${GOOD_OPTIONS}`;
      expect(() =>
        assertTestDatabaseUrl(env({ TEST_DATABASE_URL: url })),
      ).toThrow(/query parameter 'options' is duplicated/);
    });

    it('requires options to be exactly one -c search_path flag', () => {
      for (const options of [
        'options=-c%20application_name%3Dx',
        'options=search_path%3Dmoeen_test',
        'options=-c%20search_path%3Da%20-c%20search_path%3Db',
        'options=-c%20search_path%3Dmoeen_test%20extra',
      ]) {
        expect(() =>
          assertTestDatabaseUrl(
            env({ TEST_DATABASE_URL: `${BASE}?${options}` }),
          ),
        ).toThrow(/options must contain exactly one '-c search_path=<schema>'/);
      }
    });

    it('rejects a multi-value search_path (including percent-encoded commas)', () => {
      for (const options of [
        'options=-c%20search_path%3Dmoeen_test,public',
        'options=-c%20search_path%3Dmoeen_test%2Cpublic',
      ]) {
        expect(() =>
          assertTestDatabaseUrl(
            env({ TEST_DATABASE_URL: `${BASE}?${options}` }),
          ),
        ).toThrow(/single schema \(no multi-value search_path\)/);
      }
    });

    it('rejects protocol aliases such as postgres://', () => {
      expect(() =>
        assertTestDatabaseUrl(
          env({
            TEST_DATABASE_URL:
              'postgres://moeen_test_runner:pw@localhost:5433/moeen_test?' +
              GOOD_OPTIONS,
          }),
        ),
      ).toThrow(/protocol is not supported/);
    });

    it('rejects a malformed DATABASE_URL without echoing it', () => {
      expect(() =>
        assertTestDatabaseUrl(env({ DATABASE_URL: 'not-a-url-at-all' })),
      ).toThrow(/DATABASE_URL is malformed or unsupported/);
      expect(() =>
        assertTestDatabaseUrl(
          env({
            DATABASE_URL: 'postgresql://q0secretuser:q0secretpassword@[bad',
          }),
        ),
      ).toThrow(/DATABASE_URL is malformed or unsupported/);
    });

    it('returns a canonical URL and never keeps the original query', () => {
      // Extra unknown params are refused outright; a valid input is rebuilt
      // into exactly one options parameter (no 'application_name', no raw
      // query leftovers, deterministic %20/%3D encoding).
      const url =
        'postgresql://moeen_test_runner:pw@localhost:5433/moeen_test?options=-c%20search_path%3Dmoeen_test';
      expect(assertTestDatabaseUrl(env({ TEST_DATABASE_URL: url }))).toBe(
        'postgresql://moeen_test_runner:pw@localhost:5433/moeen_test?options=-c%20search_path%3Dmoeen_test',
      );
      expect(buildCanonicalUrl(parseEffectiveConnection(url))).toBe(
        'postgresql://moeen_test_runner:pw@localhost:5433/moeen_test?options=-c%20search_path%3Dmoeen_test',
      );
    });

    it('matches the connection settings pg actually interprets', () => {
      // Parity with node-postgres' own parser: for every accepted URL, the
      // guard's effective fields equal what pg-connection-string resolves.
      const urls = [
        'postgresql://moeen_test_runner:***@localhost:5433/moeen_test?options=-c%20search_path%3Dmoeen_test',
        'postgresql://moeen_test_runner:***@localhost:5433/%6doeen%5ftest?options=-c%20search_path%3Dmoeen_test',
        'postgresql://moeen_test_runner:***@localhost:5433/moeen?options=-c%20search_path%3Dmoeen_test',
        'postgresql://moeen_test_runner:pw@localhost:5433/moeen_test?options=-c+search_path%3Dmoeen_test_abc123',
      ];
      for (const url of urls) {
        const conn = parseEffectiveConnection(url);
        const pgParsed = parsePgConnectionString(url);
        expect(conn.host).toBe(pgParsed.host);
        expect(conn.port).toBe(pgParsed.port ?? '5432');
        expect(conn.user).toBe(pgParsed.user);
        expect(conn.database).toBe(pgParsed.database);
        const pgOptions = pgParsed.options ?? '';
        const pgMatch = /search_path=(\S+)/.exec(pgOptions);
        expect(conn.searchPath).toBe(pgMatch ? pgMatch[1] : null);
      }
    });
  });

  describe('run ownership token and identifier limits (P1-2)', () => {
    it('generates a fresh owner token per call, never from the environment', () => {
      process.env.MOEEN_TEST_OWNER_TOKEN = 'f'.repeat(32);
      try {
        const first = generateOwnerToken();
        const second = generateOwnerToken();
        expect(first).not.toBe(second);
        expect(first).not.toBe('f'.repeat(32));
        expect(first).toMatch(/^[a-f0-9]{32,64}$/);
      } finally {
        delete process.env.MOEEN_TEST_OWNER_TOKEN;
      }
    });

    it('validates owner token shape', () => {
      expect(() => validateOwnerToken('f'.repeat(32))).not.toThrow();
      expect(() => validateOwnerToken('f'.repeat(64))).not.toThrow();
      for (const bad of [
        '',
        'g'.repeat(32),
        'F'.repeat(32),
        'f'.repeat(31),
        'f'.repeat(65),
      ]) {
        expect(() => validateOwnerToken(bad)).toThrow(
          /invalid test owner token/,
        );
      }
    });

    it('hashes the owner token deterministically without exposing it', () => {
      const token = generateOwnerToken();
      expect(ownerTokenHash(token)).toMatch(/^[a-f0-9]{64}$/);
      expect(ownerTokenHash(token)).toBe(ownerTokenHash(token));
      expect(ownerTokenHash(token)).not.toBe(token);
    });

    it('caps the run id so the schema name fits the PostgreSQL identifier limit', () => {
      // Run schema: moeen_test_ (10) + '_' (1) + runId (48) = 59 bytes.
      expect(runSchemaName('a'.repeat(TEST_RUN_ID_MAX_LENGTH))).toHaveLength(
        59,
      );
      // Worker schema: + '_w' (2) + workerId (2) = 63 bytes, the exact cap.
      expect(
        workerSchemaName('a'.repeat(TEST_RUN_ID_MAX_LENGTH), '99'),
      ).toHaveLength(63);
      expect(() =>
        validateTestRunId('a'.repeat(TEST_RUN_ID_MAX_LENGTH + 1)),
      ).toThrow(/invalid test run id/);
      expect(
        TEST_SCHEMA_PATTERN.test(
          `moeen_test_${'a'.repeat(TEST_RUN_ID_MAX_LENGTH)}`,
        ),
      ).toBe(true);
      expect(
        TEST_SCHEMA_PATTERN.test(
          `moeen_test_${'a'.repeat(TEST_RUN_ID_MAX_LENGTH + 1)}`,
        ),
      ).toBe(false);
    });
  });

  describe('shim child environment probe (P3)', () => {
    it('hands the child the shim childEnv, not inherited values', () => {
      const shimPath = path.resolve(__dirname, '../scripts/with-test-env.js');
      const probePath = path.resolve(
        __dirname,
        '../scripts/probe-child-env.js',
      );
      const inheritedRunId = 'f00d1234abcd';
      const inheritedToken = 'e'.repeat(32);
      const output = execFileSync(
        process.execPath,
        [shimPath, 'node', probePath],
        {
          env: {
            ...process.env,
            MOEEN_TEST_RUN_ID: inheritedRunId,
            MOEEN_TEST_OWNER_TOKEN: inheritedToken,
          },
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
      const shimMatch =
        /\[test-db\] run ([a-z0-9]{4,51}) schema (moeen_test_[a-z0-9]+)/.exec(
          output,
        );
      expect(shimMatch).not.toBeNull();
      const probeMatch =
        /\[probe\] run ([a-z0-9]{4,51}) owner (present|missing) schema (moeen_test_[a-z0-9]+)/.exec(
          output,
        );
      expect(probeMatch).not.toBeNull();
      const [, shimRunId, shimSchema] = shimMatch as RegExpExecArray;
      const [, probeRunId, ownerStatus, probeSchema] =
        probeMatch as RegExpExecArray;
      // The child received the shim's fresh childEnv values, not the
      // inherited ones.
      expect(probeRunId).toBe(shimRunId);
      expect(probeRunId).not.toBe(inheritedRunId);
      expect(ownerStatus).toBe('present');
      expect(probeSchema).toBe(shimSchema);
      expect(probeSchema).toBe(`moeen_test_${shimRunId}`);
    }, 120_000);
  });

  describe('role privilege preflight (P1-3)', () => {
    const base: TestRoleSnapshot = {
      sessionUser: EXPECTED_TEST_ROLE,
      currentUser: EXPECTED_TEST_ROLE,
      isSuperuser: false,
      canCreateDb: false,
      canCreateRole: false,
      isReplicationRole: false,
      bypassesRls: false,
      canCreateInPublic: false,
      canCreateInSharedTestSchema: false,
      canCreateOnAppDatabase: false,
      canConnectAppDatabase: false,
      isMemberOfForbiddenRoles: false,
      canConnectTestDatabase: true,
    };

    it('accepts the dedicated restricted test role', () => {
      expect(() =>
        assertSafeTestRoleSnapshot(base, EXPECTED_TEST_ROLE),
      ).not.toThrow();
    });

    const dangerousFlags: Array<[keyof TestRoleSnapshot, RegExp]> = [
      ['isSuperuser', /superuser role/],
      ['canCreateDb', /CREATEDB/],
      ['canCreateRole', /CREATEROLE/],
      ['isReplicationRole', /REPLICATION/],
      ['bypassesRls', /BYPASSRLS/],
      ['canCreateInPublic', /public schema/],
      ['canCreateInSharedTestSchema', /shared 'moeen_test' schema/],
      ['canCreateOnAppDatabase', /application database/],
      ['canConnectAppDatabase', /CONNECT to the application database/],
      [
        'isMemberOfForbiddenRoles',
        /member \(directly or indirectly\) of privileged roles/,
      ],
    ];

    it('refuses a role that cannot connect to the test database', () => {
      expect(() =>
        assertSafeTestRoleSnapshot(
          { ...base, canConnectTestDatabase: false },
          EXPECTED_TEST_ROLE,
        ),
      ).toThrow(/CONNECT privilege/);
    });

    it('refuses when session_user differs from the TEST_DATABASE_URL user', () => {
      expect(() =>
        assertSafeTestRoleSnapshot(
          { ...base, sessionUser: 'some_other_user' },
          EXPECTED_TEST_ROLE,
        ),
      ).toThrow(/session role does not match the TEST_DATABASE_URL user/);
    });

    it('refuses when current_user differs from session_user (SET ROLE)', () => {
      expect(() =>
        assertSafeTestRoleSnapshot(
          { ...base, currentUser: 'impersonated_role' },
          EXPECTED_TEST_ROLE,
        ),
      ).toThrow(/session_user and current_user differ/);
    });

    it('refuses when the role identity cannot be read (fail closed)', () => {
      expect(() =>
        assertSafeTestRoleSnapshot(
          { ...base, sessionUser: '' },
          EXPECTED_TEST_ROLE,
        ),
      ).toThrow(/could not read the connected role identity/);
    });

    it.each([
      ['isSuperuser', null],
      ['canCreateDb', undefined],
      ['isMemberOfForbiddenRoles', null],
      ['canConnectAppDatabase', null],
      ['canConnectTestDatabase', undefined],
    ] as Array<[keyof TestRoleSnapshot, unknown]>)(
      'refuses a NULL/undefined %s fact (fail closed, never false)',
      (flag, value) => {
        expect(() =>
          assertSafeTestRoleSnapshot(
            { ...base, [flag]: value },
            EXPECTED_TEST_ROLE,
          ),
        ).toThrow(/is not a boolean/);
      },
    );

    it.each(dangerousFlags)(
      'refuses a role with the %s privilege flag',
      (flag, message) => {
        expect(() =>
          assertSafeTestRoleSnapshot(
            { ...base, [flag]: true },
            EXPECTED_TEST_ROLE,
          ),
        ).toThrow(message);
      },
    );

    it.each(['postgres', 'moeen_app', 'some_unexpected_role'])(
      'refuses the %s role',
      (name) => {
        expect(() =>
          assertSafeTestRoleSnapshot(
            { ...base, sessionUser: name, currentUser: name },
            name,
          ),
        ).toThrow(/only the dedicated moeen_test_runner role/);
      },
    );

    it('refuses a role that does not match the TEST_DATABASE_URL user', () => {
      expect(() => assertSafeTestRoleSnapshot(base, 'some_other_user')).toThrow(
        /does not match the TEST_DATABASE_URL user/,
      );
    });

    it('rejects a TEST_DATABASE_URL whose user is moeen_app', () => {
      expect(() =>
        assertTestDatabaseUrl(
          env({
            TEST_DATABASE_URL:
              'postgresql://moeen_app:pw@localhost:5433/moeen_test?options=-c%20search_path%3Dmoeen_test',
          }),
        ),
      ).toThrow(/only the dedicated moeen_test_runner role is accepted/);
    });

    it('rejects a TEST_DATABASE_URL whose user is postgres', () => {
      expect(() =>
        assertTestDatabaseUrl(
          env({
            TEST_DATABASE_URL:
              'postgresql://postgres:***@localhost:5433/moeen_test?options=-c%20search_path%3Dmoeen_test',
          }),
        ),
      ).toThrow(/only the dedicated moeen_test_runner role is accepted/);
    });

    it('keeps the fixed membership denylist limited to non-PostgreSQL vendor/admin roles', () => {
      const forbidden = getForbiddenMembershipRoles();
      for (const role of ['postgres', 'rds_superuser', 'rdsadmin']) {
        expect(forbidden.has(role)).toBe(true);
      }
      expect([...forbidden].some((role) => role.startsWith('pg_'))).toBe(false);
    });
  });

  describe('role-membership reachability boundary (recursive escalation gap)', () => {
    // Q0-SEC final-review finding: the preflight validated only the CURRENT
    // role + a fixed dangerous-role NAME denylist. A custom reachable role may
    // itself carry dangerous attributes, and the fixed denylist omitted
    // privileged PG16 predefined roles such as pg_checkpoint /
    // pg_create_subscription (which carry NO attribute flags). These
    // regressions prove the fail-closed privilege-boundary model: every role
    // the test identity can actually SET ROLE to (directly or recursively,
    // per PostgreSQL's authoritative membership semantics) is inspected for
    // dangerous attributes and for predefined system roles (the 'pg_' prefix
    // is reserved by PostgreSQL itself — authoritative, not a fixed list).

    function safeRole(roleName: string): TestReachableRole {
      return {
        roleName,
        isSuperuser: false,
        canCreateDb: false,
        canCreateRole: false,
        isReplicationRole: false,
        bypassesRls: false,
        isPredefinedSystemRole: false,
      };
    }

    function membership(
      memberRoleName: string,
      targetRoleName: string,
      options: Partial<
        Pick<TestRoleMembership, 'inheritOption' | 'setOption' | 'adminOption'>
      >,
    ): TestRoleMembership {
      return {
        memberRoleName,
        targetRoleName,
        inheritOption: false,
        setOption: false,
        adminOption: false,
        ...options,
      };
    }

    it('rejects pg_checkpoint reached recursively through INHERIT-only memberships', () => {
      const roles = [
        safeRole(EXPECTED_TEST_ROLE),
        safeRole('innocuous_custom_role'),
        safeRole('database_owner_role'),
        { ...safeRole('pg_checkpoint'), isPredefinedSystemRole: true },
        { ...safeRole('pg_database_owner'), isPredefinedSystemRole: true },
      ];
      const reachable = resolveReachableRoles(
        roles,
        [
          membership(EXPECTED_TEST_ROLE, 'innocuous_custom_role', {
            inheritOption: true,
          }),
          membership('innocuous_custom_role', 'pg_checkpoint', {
            inheritOption: true,
          }),
        ],
        EXPECTED_TEST_ROLE,
        'database_owner_role',
      );

      expect(reachable.map((role) => role.roleName)).toContain('pg_checkpoint');
      expect(() =>
        assertSafeRoleReachability(reachable, EXPECTED_TEST_ROLE),
      ).toThrow(/predefined PostgreSQL system role 'pg_checkpoint'/);
    });

    it('rejects pg_create_subscription reached through a SET-only membership', () => {
      const roles = [
        safeRole(EXPECTED_TEST_ROLE),
        safeRole('database_owner_role'),
        { ...safeRole('pg_create_subscription'), isPredefinedSystemRole: true },
        { ...safeRole('pg_database_owner'), isPredefinedSystemRole: true },
      ];
      const reachable = resolveReachableRoles(
        roles,
        [
          membership(EXPECTED_TEST_ROLE, 'pg_create_subscription', {
            setOption: true,
          }),
        ],
        EXPECTED_TEST_ROLE,
        'database_owner_role',
      );

      expect(() =>
        assertSafeRoleReachability(reachable, EXPECTED_TEST_ROLE),
      ).toThrow(/predefined PostgreSQL system role 'pg_create_subscription'/);
    });

    it('rejects pg_use_reserved_connections reached through an INHERIT-only membership', () => {
      const roles = [
        safeRole(EXPECTED_TEST_ROLE),
        safeRole('database_owner_role'),
        {
          ...safeRole('pg_use_reserved_connections'),
          isPredefinedSystemRole: true,
        },
        { ...safeRole('pg_database_owner'), isPredefinedSystemRole: true },
      ];
      const reachable = resolveReachableRoles(
        roles,
        [
          membership(EXPECTED_TEST_ROLE, 'pg_use_reserved_connections', {
            inheritOption: true,
          }),
        ],
        EXPECTED_TEST_ROLE,
        'database_owner_role',
      );

      expect(() =>
        assertSafeRoleReachability(reachable, EXPECTED_TEST_ROLE),
      ).toThrow(
        /predefined PostgreSQL system role 'pg_use_reserved_connections'/,
      );
    });

    it('accepts an innocuous custom role reached through INHERIT-only membership', () => {
      const roles = [
        safeRole(EXPECTED_TEST_ROLE),
        safeRole('innocuous_custom_role'),
        safeRole('database_owner_role'),
        { ...safeRole('pg_database_owner'), isPredefinedSystemRole: true },
      ];
      const reachable = resolveReachableRoles(
        roles,
        [
          membership(EXPECTED_TEST_ROLE, 'innocuous_custom_role', {
            inheritOption: true,
          }),
        ],
        EXPECTED_TEST_ROLE,
        'database_owner_role',
      );

      expect(reachable.map((role) => role.roleName)).toEqual([
        EXPECTED_TEST_ROLE,
        'innocuous_custom_role',
      ]);
      expect(() =>
        assertSafeRoleReachability(reachable, EXPECTED_TEST_ROLE),
      ).not.toThrow();
    });

    it('traverses ADMIN-only memberships when dynamically discovering predefined roles', () => {
      const roles = [
        safeRole(EXPECTED_TEST_ROLE),
        safeRole('database_owner_role'),
        { ...safeRole('pg_checkpoint'), isPredefinedSystemRole: true },
        { ...safeRole('pg_database_owner'), isPredefinedSystemRole: true },
      ];
      const reachable = resolveReachableRoles(
        roles,
        [
          membership(EXPECTED_TEST_ROLE, 'pg_checkpoint', {
            adminOption: true,
          }),
        ],
        EXPECTED_TEST_ROLE,
        'database_owner_role',
      );

      expect(() =>
        assertSafeRoleReachability(reachable, EXPECTED_TEST_ROLE),
      ).toThrow(/predefined PostgreSQL system role 'pg_checkpoint'/);
    });

    it('accepts the safe test-runner configuration (the session role alone)', () => {
      expect(() =>
        assertSafeRoleReachability(
          [safeRole(EXPECTED_TEST_ROLE)],
          EXPECTED_TEST_ROLE,
        ),
      ).not.toThrow();
    });

    it('accepts a harmless recursively reachable custom role chain (deep closure, innocuous names)', () => {
      // The closure result is judged as a whole: an arbitrarily deep chain of
      // harmless roles (here the session role + two indirect members) passes.
      expect(() =>
        assertSafeRoleReachability(
          [
            safeRole(EXPECTED_TEST_ROLE),
            safeRole('billing_analyst'),
            safeRole('reports_viewer'),
          ],
          EXPECTED_TEST_ROLE,
        ),
      ).not.toThrow();
    });

    const dangerousAttributes: Array<[keyof TestReachableRole, RegExp]> = [
      ['isSuperuser', /which is a superuser/],
      ['canCreateDb', /which has the CREATEDB attribute/],
      ['canCreateRole', /which has the CREATEROLE attribute/],
      ['isReplicationRole', /which has the REPLICATION attribute/],
      ['bypassesRls', /which has the BYPASSRLS attribute/],
    ];

    it.each(dangerousAttributes)(
      'rejects a recursively reachable custom role with the %s attribute even under an innocuous name',
      (flag, message) => {
        expect(() =>
          assertSafeRoleReachability(
            [
              safeRole(EXPECTED_TEST_ROLE),
              { ...safeRole('reports_viewer'), [flag]: true },
            ],
            EXPECTED_TEST_ROLE,
          ),
        ).toThrow(message);
      },
    );

    it('names the offending reachable role in the refusal', () => {
      expect(() =>
        assertSafeRoleReachability(
          [
            safeRole(EXPECTED_TEST_ROLE),
            { ...safeRole('reports_viewer'), bypassesRls: true },
          ],
          EXPECTED_TEST_ROLE,
        ),
      ).toThrow(/can SET ROLE to 'reports_viewer'/);
    });

    it.each([
      'pg_checkpoint',
      'pg_create_subscription',
      'pg_execute_server_program',
      'pg_monitor',
      'pg_read_all_data',
      'pg_write_all_data',
      'pg_read_all_settings',
      'pg_read_all_stats',
      'pg_read_server_files',
      'pg_write_server_files',
      'pg_signal_backend',
      'pg_stat_scan_tables',
      'pg_database_owner',
    ])(
      'rejects the reachable predefined PG16 system role %s (no attribute flags needed)',
      (roleName) => {
        expect(() =>
          assertSafeRoleReachability(
            [
              safeRole(EXPECTED_TEST_ROLE),
              { ...safeRole(roleName), isPredefinedSystemRole: true },
            ],
            EXPECTED_TEST_ROLE,
          ),
        ).toThrow(/can SET ROLE to the predefined PostgreSQL system role/);
      },
    );

    it('judges predefined roles by the reserved pg_ prefix fact, not by a fixed name list', () => {
      // A custom role whose name only RESEMBLES a system role is fine when the
      // collector reports it as non-predefined; the checker keys on the fact
      // (computed from the pg_ prefix PostgreSQL reserves), never on a name.
      expect(() =>
        assertSafeRoleReachability(
          [
            safeRole(EXPECTED_TEST_ROLE),
            safeRole('checkpoint_operator'),
            safeRole('subscription_reporter'),
          ],
          EXPECTED_TEST_ROLE,
        ),
      ).not.toThrow();
    });

    it('refuses an empty enumeration (fail closed)', () => {
      expect(() => assertSafeRoleReachability([], EXPECTED_TEST_ROLE)).toThrow(
        /could not enumerate the roles reachable via SET ROLE/,
      );
    });

    it('refuses an enumeration that lacks the session role (incomplete closure)', () => {
      expect(() =>
        assertSafeRoleReachability(
          [safeRole('some_other_role')],
          EXPECTED_TEST_ROLE,
        ),
      ).toThrow(/does not include the session role/);
    });

    it.each([
      ['isSuperuser', null],
      ['canCreateDb', undefined],
      ['canCreateRole', null],
      ['isReplicationRole', undefined],
      ['bypassesRls', null],
      ['isPredefinedSystemRole', undefined],
    ] as Array<[keyof TestReachableRole, unknown]>)(
      'refuses a NULL/undefined %s reachability fact (fail closed, never false)',
      (flag, value) => {
        expect(() =>
          assertSafeRoleReachability(
            [
              safeRole(EXPECTED_TEST_ROLE),
              { ...safeRole('reports_viewer'), [flag]: value },
            ],
            EXPECTED_TEST_ROLE,
          ),
        ).toThrow(/is not a boolean/);
      },
    );

    it('keeps the application-database CONNECT isolation boundary intact alongside the reachability check', () => {
      // Regression anchor: the reachability boundary COMPLEMENTS the existing
      // snapshot checks — it must never be mistaken for a replacement. A role
      // that can CONNECT to the application database still refuses the run.
      const snapshot: TestRoleSnapshot = {
        sessionUser: EXPECTED_TEST_ROLE,
        currentUser: EXPECTED_TEST_ROLE,
        isSuperuser: false,
        canCreateDb: false,
        canCreateRole: false,
        isReplicationRole: false,
        bypassesRls: false,
        canCreateInPublic: false,
        canCreateInSharedTestSchema: false,
        canCreateOnAppDatabase: false,
        canConnectAppDatabase: true,
        isMemberOfForbiddenRoles: false,
        canConnectTestDatabase: true,
      };
      expect(() =>
        assertSafeTestRoleSnapshot(snapshot, EXPECTED_TEST_ROLE),
      ).toThrow(/CONNECT to the application database/);
    });
  });

  describe('live role collector (P1-3, live preflight path)', () => {
    // These tests exercise the REAL collector SQL used by globalSetup against
    // the live dedicated test database (moeen_test via TEST_DATABASE_URL) —
    // not a fabricated snapshot. They prove the collector detects the actual
    // environment facts (identity agreement, app-database CONNECT) and that
    // the pure preflight rejects exactly when the live facts are unsafe.
    jest.setTimeout(60_000);
    const collectorPool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    });

    it('collects the live identity and requires session/current/URL user agreement', async () => {
      const snapshot = await collectTestRoleSnapshot(collectorPool);
      expect(snapshot.sessionUser).toBe(EXPECTED_TEST_ROLE);
      expect(snapshot.currentUser).toBe(EXPECTED_TEST_ROLE);
      const urlUser = parseEffectiveConnection(
        process.env.TEST_DATABASE_URL ?? '',
      ).user;
      expect(urlUser).toBe(EXPECTED_TEST_ROLE);
      // All collected facts must be real booleans (never NULL).
      for (const [name, value] of Object.entries(snapshot)) {
        if (name === 'sessionUser' || name === 'currentUser') continue;
        expect(typeof value).toBe('boolean');
      }
    });

    it('requires CONNECT on the dedicated test database', async () => {
      const snapshot = await collectTestRoleSnapshot(collectorPool);
      expect(snapshot.canConnectTestDatabase).toBe(true);
    });

    it('queries CREATE/CONNECT against database names derived from the validated URLs', async () => {
      let executedSql = '';
      let executedParameters: unknown[] | undefined;
      const query = (sql: string, parameters?: unknown[]) => {
        executedSql = sql;
        executedParameters = parameters;
        return Promise.resolve({
          rows: [
            {
              session_name: EXPECTED_TEST_ROLE,
              name: EXPECTED_TEST_ROLE,
              super: false,
              createdb: false,
              createrole: false,
              replication: false,
              bypassrls: false,
              pub_create: false,
              shared_create: false,
              appdb_create: false,
              app_connect: false,
              forbidden_member: false,
              can_connect_testdb: true,
            },
          ],
        });
      };
      const pool = { query } as unknown as Pool;

      await collectTestRoleSnapshot(
        pool,
        'derived_application_database',
        'derived_test_database',
      );

      expect(executedParameters).toEqual([
        'derived_application_database',
        'derived_test_database',
        expect.any(Array),
      ]);
      expect(executedSql).not.toContain("has_database_privilege('moeen'");
    });

    it('collects an INHERIT-only predefined role from the live-catalog result shape', async () => {
      let queryNumber = 0;
      const safeCatalogRole = (roleName: string, predefined: boolean) => ({
        role_name: roleName,
        super: false,
        createdb: false,
        createrole: false,
        replication: false,
        bypassrls: false,
        predefined,
        database_owner: 'database_owner_role',
      });
      const query = () => {
        queryNumber += 1;
        if (queryNumber === 1) {
          return Promise.resolve({
            rows: [
              safeCatalogRole(EXPECTED_TEST_ROLE, false),
              safeCatalogRole('database_owner_role', false),
              safeCatalogRole('pg_database_owner', true),
              safeCatalogRole('pg_checkpoint', true),
            ],
          });
        }
        return Promise.resolve({
          rows: [
            {
              member_role_name: EXPECTED_TEST_ROLE,
              target_role_name: 'pg_checkpoint',
              inherit_option: true,
              set_option: false,
              admin_option: false,
            },
          ],
        });
      };

      const reachable = await collectReachableRoles({
        query,
      } as unknown as Pool);

      expect(queryNumber).toBe(2);
      expect(reachable.map((role) => role.roleName)).toEqual([
        EXPECTED_TEST_ROLE,
        'pg_checkpoint',
      ]);
      expect(() =>
        assertSafeRoleReachability(reachable, EXPECTED_TEST_ROLE),
      ).toThrow(/predefined PostgreSQL system role 'pg_checkpoint'/);
    });

    it('rejects the live snapshot exactly when the runner can CONNECT to the application database', async () => {
      const snapshot = await collectTestRoleSnapshot(collectorPool);
      const urlUser = parseEffectiveConnection(
        process.env.TEST_DATABASE_URL ?? '',
      ).user;
      if (snapshot.canConnectAppDatabase) {
        // The environment is non-compliant (e.g. default PUBLIC CONNECT on
        // moeen): the preflight MUST refuse — this is the fail-closed
        // application-database boundary.
        expect(() => assertSafeTestRoleSnapshot(snapshot, urlUser)).toThrow(
          /CONNECT to the application database/,
        );
      } else {
        // Compliant environment: the full preflight must accept the live role.
        expect(() =>
          assertSafeTestRoleSnapshot(snapshot, urlUser),
        ).not.toThrow();
      }
    });

    it('never reports the live runner as a member of the forbidden roles', async () => {
      const snapshot = await collectTestRoleSnapshot(collectorPool);
      expect(snapshot.isMemberOfForbiddenRoles).toBe(false);
    });

    it('collects the full live membership closure and the restricted runner passes the reachability boundary', async () => {
      // Q0-SEC recursive escalation gap: the REAL collector SQL (the same
      // queries globalSetup runs) must enumerate roles reachable through
      // INHERIT, SET or ADMIN semantics, and the pure boundary check must
      // accept the live restricted runner (regression #4: the existing safe
      // test-runner configuration still passes).
      const reachable = await collectReachableRoles(collectorPool);
      expect(reachable.length).toBeGreaterThan(0);
      const names = reachable.map((role) => role.roleName);
      expect(names).toContain(EXPECTED_TEST_ROLE);
      for (const role of reachable) {
        for (const [name, value] of Object.entries(role)) {
          if (name === 'roleName') continue;
          expect(typeof value).toBe('boolean');
        }
        expect(role.isSuperuser).toBe(false);
        expect(role.canCreateDb).toBe(false);
        expect(role.canCreateRole).toBe(false);
        expect(role.isReplicationRole).toBe(false);
        expect(role.bypassesRls).toBe(false);
        expect(role.isPredefinedSystemRole).toBe(false);
      }
      expect(() =>
        assertSafeRoleReachability(reachable, EXPECTED_TEST_ROLE),
      ).not.toThrow();
    });

    it('the collector follows PostgreSQL authoritative membership catalogs (inherit/set/admin edges + implicit pg_database_owner)', async () => {
      // Deterministic live proof of the reachability model's building blocks:
      // (a) the derived edge set is fed by pg_auth_members INHERIT, SET and
      // ADMIN capabilities;
      // (b) the implicit pg_database_owner edge is always present for the
      // current database's owner, mirroring roles_is_member_of.
      const edges = await collectorPool.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM pg_auth_members m
          WHERE (m.inherit_option OR m.set_option OR m.admin_option)
            AND m.member = current_user::regrole::oid`,
      );
      const implicit = await collectorPool.query<{
        src: string;
        target: string;
      }>(
        `SELECT d.datdba::regrole::text AS src,
                'pg_database_owner'::regrole::text AS target
           FROM pg_database d
          WHERE d.datname = current_database()`,
      );
      expect(implicit.rows).toHaveLength(1);
      expect(implicit.rows[0]?.target).toBe('pg_database_owner');
      // The implicit edge only fires when the DB owner is itself reachable;
      // the live runner has no membership edges, so the closure stays at the
      // session role — the two facts together prove both model branches.
      expect(edges.rows[0]?.n).toBe(0);
      const reachable = await collectReachableRoles(collectorPool);
      expect(reachable.map((role) => role.roleName)).toEqual([
        EXPECTED_TEST_ROLE,
      ]);
    });

    afterAll(async () => {
      await collectorPool.end();
    });
  });

  describe('documented TEST_DATABASE_URL contract (P1-2)', () => {
    function exampleValues(): {
      testUrl: string;
      appUrl: string;
    } {
      const example = readFileSync(
        path.resolve(__dirname, '../.env.example'),
        'utf8',
      );
      const testLine = example
        .split(/\r?\n/)
        .find((line) => line.startsWith('TEST_DATABASE_URL='));
      const appLine = example
        .split(/\r?\n/)
        .find((line) => line.startsWith('DATABASE_URL='));
      expect(testLine).toBeTruthy();
      expect(appLine).toBeTruthy();
      return {
        testUrl: (testLine as string).slice('TEST_DATABASE_URL='.length),
        appUrl: (appLine as string).slice('DATABASE_URL='.length),
      };
    }

    it('documents the base search_path and the dedicated test role', () => {
      const { testUrl } = exampleValues();
      const conn = parseEffectiveConnection(testUrl);
      expect(conn.user).toBe('moeen_test_runner');
      expect(conn.database).toBe('moeen_test');
      expect(conn.searchPath).toBe('moeen_test');
    });

    it('the documented value passes validation and converts to run/worker schemas', () => {
      const { testUrl, appUrl } = exampleValues();
      const canonical = assertTestDatabaseUrl({
        NODE_ENV: 'test',
        TEST_DATABASE_URL: testUrl,
        DATABASE_URL: appUrl,
      });
      const conn = parseEffectiveConnection(canonical);
      expect(conn.searchPath).toBe('moeen_test');
      // Never a fallback to DATABASE_URL: the effective connections differ.
      expect(normalizedEquals(conn, parseEffectiveConnection(appUrl))).toBe(
        false,
      );
      // The shim rewrites the base search_path to a run schema...
      const runId = generateTestRunId();
      const runUrl = withRunSchema(canonical, runId);
      expect(parseEffectiveConnection(runUrl).searchPath).toBe(
        runSchemaName(runId),
      );
      // ...and the documented base itself is accepted by the guard.
      expect(
        assertTestDatabaseUrl({
          NODE_ENV: 'test',
          TEST_DATABASE_URL: testUrl,
          DATABASE_URL: appUrl,
        }),
      ).toBe(canonical);
    });
  });

  describe('effective search_path verification (P1-1)', () => {
    const checkPool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    });

    // current_schemas(false) only lists EXISTING schemas, so every schema
    // used in a search_path must exist for the comparison to be meaningful.
    async function withTempSchemas<T>(
      names: string[],
      fn: () => Promise<T>,
    ): Promise<T> {
      for (const name of names) {
        await checkPool.query(`CREATE SCHEMA "${name}"`);
      }
      try {
        return await fn();
      } finally {
        for (const name of names) {
          await checkPool
            .query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`)
            .catch(() => undefined);
        }
      }
    }

    async function withSessionPath<T>(
      pathSql: string,
      fn: (client: PoolClient) => Promise<T>,
    ): Promise<T> {
      const client = await checkPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL search_path TO ${pathSql}`);
        return await fn(client);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    }

    it('passes when the effective path is exactly [target, pg_catalog]', async () => {
      const a = `moeen_test_spa_${generateTestRunId()}`;
      await withTempSchemas([a], async () => {
        await withSessionPath(`"${a}", pg_catalog`, async (client) => {
          await expect(
            verifySearchPathExactly(client, a),
          ).resolves.toBeUndefined();
        });
      });
    });

    it('refuses when a wrong schema is first', async () => {
      const a = `moeen_test_spa_${generateTestRunId()}`;
      const b = `moeen_test_spb_${generateTestRunId()}`;
      await withTempSchemas([a, b], async () => {
        await withSessionPath(`"${b}", pg_catalog`, async (client) => {
          await expect(verifySearchPathExactly(client, a)).rejects.toThrow(
            /search_path is not exactly the target schema/,
          );
        });
      });
    });

    it('refuses when an extra schema follows the target', async () => {
      const a = `moeen_test_spa_${generateTestRunId()}`;
      const b = `moeen_test_spb_${generateTestRunId()}`;
      await withTempSchemas([a, b], async () => {
        await withSessionPath(`"${a}", "${b}", pg_catalog`, async (client) => {
          await expect(verifySearchPathExactly(client, a)).rejects.toThrow(
            /search_path is not exactly the target schema/,
          );
        });
      });
    });

    it('refuses when pg_catalog precedes the target', async () => {
      const a = `moeen_test_spa_${generateTestRunId()}`;
      await withTempSchemas([a], async () => {
        await withSessionPath(`pg_catalog, "${a}"`, async (client) => {
          await expect(verifySearchPathExactly(client, a)).rejects.toThrow(
            /search_path is not exactly the target schema/,
          );
        });
      });
    });

    it('refuses when pg_catalog is missing from the path', async () => {
      const a = `moeen_test_spa_${generateTestRunId()}`;
      await withTempSchemas([a], async () => {
        await withSessionPath(`"${a}"`, async (client) => {
          await expect(verifySearchPathExactly(client, a)).rejects.toThrow(
            /search_path is not exactly the target schema/,
          );
        });
      });
    });

    afterAll(async () => {
      await checkPool.end();
    });
  });

  describe('global teardown ownership binding (P1-1)', () => {
    // These tests create/drop several schemas in real transactions; under
    // full-suite load the default 5s jest timeout is too tight.
    jest.setTimeout(60_000);
    const baseUrl = assertTestDatabaseUrl(process.env);

    async function withFakeRun<T>(
      runId: string,
      token: string,
      fn: () => Promise<T>,
    ): Promise<T> {
      const previous = {
        [TEST_RUN_ID_ENV]: process.env[TEST_RUN_ID_ENV],
        [TEST_OWNER_TOKEN_ENV]: process.env[TEST_OWNER_TOKEN_ENV],
        TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
      };
      process.env[TEST_RUN_ID_ENV] = runId;
      process.env[TEST_OWNER_TOKEN_ENV] = token;
      process.env.TEST_DATABASE_URL = withRunSchema(baseUrl, runId);
      try {
        return await fn();
      } finally {
        process.env[TEST_RUN_ID_ENV] = previous[TEST_RUN_ID_ENV];
        process.env[TEST_OWNER_TOKEN_ENV] = previous[TEST_OWNER_TOKEN_ENV];
        process.env.TEST_DATABASE_URL = previous.TEST_DATABASE_URL;
      }
    }

    async function schemaExists(name: string): Promise<boolean> {
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      try {
        const res = await pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1',
          [name],
        );
        return res.rows[0]?.n === 1;
      } finally {
        await pool.end();
      }
    }

    async function dropFabricated(name: string): Promise<void> {
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      try {
        await pool.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
      } finally {
        await pool.end();
      }
    }

    it('fails closed when the teardown run id is missing', async () => {
      const previousRunId = process.env[TEST_RUN_ID_ENV];
      const previousOwnerToken = process.env[TEST_OWNER_TOKEN_ENV];
      const previousTestUrl = process.env.TEST_DATABASE_URL;
      delete process.env[TEST_RUN_ID_ENV];
      process.env[TEST_OWNER_TOKEN_ENV] = generateOwnerToken();
      process.env.TEST_DATABASE_URL = baseUrl;
      try {
        await expect(globalTeardown()).rejects.toThrow(
          new RegExp(`${TEST_RUN_ID_ENV} is not set`),
        );
      } finally {
        if (previousRunId === undefined) delete process.env[TEST_RUN_ID_ENV];
        else process.env[TEST_RUN_ID_ENV] = previousRunId;
        if (previousOwnerToken === undefined)
          delete process.env[TEST_OWNER_TOKEN_ENV];
        else process.env[TEST_OWNER_TOKEN_ENV] = previousOwnerToken;
        if (previousTestUrl === undefined) delete process.env.TEST_DATABASE_URL;
        else process.env.TEST_DATABASE_URL = previousTestUrl;
      }
    });

    it('stops cleanup before reusing a transaction client whose rollback failed', async () => {
      const runId = generateTestRunId();
      const token = generateOwnerToken();
      const workerSchema = `moeen_test_${runId}_w7`;
      const operationError = new Error('drop failed and rollback also failed');
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      const dropSpy = jest
        .spyOn(ownershipModule, 'dropOwnedSchemaAtomically')
        .mockRejectedValue(operationError);
      const discardedSpy = jest
        .spyOn(ownershipModule, 'isOwnershipClientDiscarded')
        .mockReturnValue(true);
      try {
        await pool.query(`CREATE SCHEMA "${workerSchema}"`);
        await withFakeRun(runId, token, async () => {
          await expect(globalTeardown()).rejects.toBe(operationError);
        });
        expect(discardedSpy).toHaveBeenCalled();
        expect(dropSpy).toHaveBeenCalledTimes(1);
      } finally {
        discardedSpy.mockRestore();
        dropSpy.mockRestore();
        await dropFabricated(workerSchema);
        await pool.end();
      }
    });

    it('a marker that matches in schema A never allows dropping schema B', async () => {
      const runId = generateTestRunId();
      const token = generateOwnerToken();
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      const client = await pool.connect();
      try {
        await createOwnedSchema(
          pool,
          `moeen_test_${runId}`,
          runId,
          ownerTokenHash(token),
        );
        await createOwnedSchema(
          pool,
          `moeen_test_${runId}_w7`,
          runId,
          ownerTokenHash(token),
        );
        await pool.query(`CREATE SCHEMA "moeen_test_${runId}_w8"`);
        await withFakeRun(runId, token, async () => {
          // The owned schemas (workers first, anchor last) are dropped; the
          // unmarked one is refused and recorded. Teardown continues past it
          // and fails at the end.
          await expect(globalTeardown()).rejects.toThrow(
            /refused to drop .* schema\(s\) not owned by this run/,
          );
        });
        expect(await schemaExists(`moeen_test_${runId}`)).toBe(false);
        expect(await schemaExists(`moeen_test_${runId}_w7`)).toBe(false);
        expect(await schemaExists(`moeen_test_${runId}_w8`)).toBe(true);
      } finally {
        // Exact-name cleanup of EVERY schema this test created, regardless of
        // where it failed: run + worker + the foreign lookalike.
        await dropFabricated(`moeen_test_${runId}`);
        await dropFabricated(`moeen_test_${runId}_w7`);
        await dropFabricated(`moeen_test_${runId}_w8`);
        client.release();
        await pool.end();
      }
    });

    it('an unqualified marker read cannot be redirected by the session search_path', async () => {
      // Regression for the old teardown: it read q0sec_run_ownership
      // UNQUALIFIED, so a session search_path pointing at schema B (whose
      // marker matches) would have authorized dropping schema A. The new
      // routine reads the marker only QUALIFIED inside the target schema.
      const runId = generateTestRunId();
      const token = generateOwnerToken();
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      const client = await pool.connect();
      try {
        await createOwnedSchema(
          pool,
          `moeen_test_${runId}_w7`,
          runId,
          ownerTokenHash(token),
        );
        await pool.query(`CREATE SCHEMA "moeen_test_${runId}_w8"`);
        // Point the session at B (the schema WITH the matching marker) — the
        // old code would have read B's marker and dropped A. The new
        // implementation first checks that the marker table belongs to the
        // target namespace OID, so the session search_path redirection is
        // caught earlier with a namespace-OID mismatch rather than a missing
        // marker. Both are fail-closed refusals that leave the target intact.
        await client.query(`SET search_path TO "moeen_test_${runId}_w7"`);
        await expect(
          dropOwnedSchemaAtomically(
            client,
            `moeen_test_${runId}_w8`,
            runId,
            ownerTokenHash(token),
          ),
        ).rejects.toThrow(
          /ownership marker (is missing|table is not bound to the expected namespace OID)/,
        );
        expect(await schemaExists(`moeen_test_${runId}_w8`)).toBe(true);
      } finally {
        client.release();
        await dropFabricated(`moeen_test_${runId}_w7`);
        await dropFabricated(`moeen_test_${runId}_w8`);
        await pool.end();
      }
    });

    it('a concurrent rename/swap cannot redirect the drop to a foreign namespace (two-session adversarial)', async () => {
      // Area 7 regression: the OLD implementation verified the schema OID but
      // later resolved the MUTABLE schema name again for the DROP SCHEMA, so a
      // concurrent rename/swap could make the destructive DDL target a foreign
      // namespace. The fixed implementation binds the drop to the verified
      // namespace OID (transactional rename to a fresh name + OID re-verify).
      //
      // Deterministic interleaving without sleeps: session 2 (the attacker)
      // begins the swap in an UNCOMMITTED transaction while holding ACCESS
      // EXCLUSIVE on the verified schema's marker table. Session 1 (the drop)
      // therefore ALWAYS completes its marker verification against the
      // verified namespace and then BLOCKS at the row-locked marker read. The
      // test observes that block in pg_locks, commits the swap, and only then
      // lets the drop continue — so the swap is guaranteed to become visible
      // AFTER verification and BEFORE the destructive step, in every run.
      const runId = generateTestRunId();
      const token = generateOwnerToken();
      const tokenHash = ownerTokenHash(token);
      // Name S holds the VERIFIED schema; name T holds the FOREIGN schema.
      const verified = `moeen_test_${runId}`;
      const foreign = `moeen_test_${runId}_w7`;
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      const dropClient = await pool.connect();
      const attackerClient = await pool.connect();
      try {
        // Verified schema with a REAL matching marker at name S.
        await createOwnedSchema(pool, verified, runId, tokenHash);
        // Foreign schema with a FORGED matching marker at name T: every marker
        // check passes on it, so only the namespace-identity binding can tell
        // it apart from the verified schema. With the OLD code this forged
        // marker is exactly what let a swap redirect the DROP to it.
        await createOwnedSchema(pool, foreign, runId, tokenHash);

        await attackerClient.query('BEGIN');
        await attackerClient.query(
          `LOCK TABLE ${qualifiedMarkerTable(verified)} IN ACCESS EXCLUSIVE MODE`,
        );
        // Swap: T(foreign) → temp, S(verified) → T, temp(foreign) → S. After
        // COMMIT, name S resolves to the FOREIGN schema and name T to the
        // verified one.
        const temp = `${foreign}_swap`;
        await attackerClient.query(
          `ALTER SCHEMA ${quoteIdent(foreign)} RENAME TO ${quoteIdent(temp)}`,
        );
        await attackerClient.query(
          `ALTER SCHEMA ${quoteIdent(verified)} RENAME TO ${quoteIdent(foreign)}`,
        );
        await attackerClient.query(
          `ALTER SCHEMA ${quoteIdent(temp)} RENAME TO ${quoteIdent(verified)}`,
        );

        // Session 1 (the drop). The catch handler guarantees the promise can
        // never reject unhandled, even if an earlier assertion fails while the
        // drop is still blocked.
        let dropError: unknown;
        const dropSettled = dropOwnedSchemaAtomically(
          dropClient,
          verified,
          runId,
          tokenHash,
        ).then(
          () => {
            dropError = null;
          },
          (error: unknown) => {
            dropError = error;
          },
        );

        // Wait until the drop session is provably blocked at the row-locked
        // marker read (it MUST block — the lock is held uncommitted). Once
        // observed, its OID + marker verification has completed against the
        // verified namespace under the ORIGINAL name.
        let observedBlocked = false;
        for (let attempt = 0; attempt < 300; attempt += 1) {
          const waiting = await pool.query<{ n: number }>(
            `SELECT count(*)::int AS n
               FROM pg_locks l
               JOIN pg_class c ON c.oid = l.relation
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = $1 AND c.relname = $2 AND NOT l.granted`,
            [verified, OWNERSHIP_MARKER_TABLE],
          );
          if ((waiting.rows[0]?.n ?? 0) > 0) {
            observedBlocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(observedBlocked).toBe(true);

        // Commit the swap NOW: the drop session's next statements re-resolve
        // name S to the FOREIGN schema. The drop protocol's rename moves the
        // foreign schema to the fresh teardown name, and the OID re-verify
        // must refuse — the ROLLBACK then restores the foreign schema's name.
        await attackerClient.query('COMMIT');
        await dropSettled;

        expect(dropError).toBeInstanceOf(TestDatabaseGuardError);
        expect((dropError as Error).message).toMatch(
          /namespace identity changed during teardown/,
        );
        // The FOREIGN namespace survives at name S, and the verified
        // namespace survives at name T — the cleanup refused rather than
        // deleting an identity that was not the one it verified.
        expect(await schemaExists(verified)).toBe(true);
        expect(await schemaExists(foreign)).toBe(true);
      } finally {
        // Exact-name cleanup of EVERY schema this test created, regardless of
        // where it failed: both schemas survive the refused drop.
        await dropFabricated(verified);
        await dropFabricated(foreign);
        dropClient.release();
        attackerClient.release();
        await pool.end();
      }
    });

    it('a NEW external dependent created after the dependency gate is refused — scan-to-drop TOCTOU (two-session adversarial)', async () => {
      // HIGH final-review finding regression: the external-dependency scan
      // and the destructive DDL were separate READ COMMITTED statements, so
      // a concurrent session could create an external dependent after the
      // scan and have the DROP SCHEMA ... CASCADE destroy it (live-verified
      // on PG16: the CASCADE machinery reads the catalogs at statement time,
      // so no isolation level can hide a committed dependent). The
      // destructive protocol now contains NO CASCADE: every owned root
      // object is dropped with its own no-CASCADE DROP, so a dependent
      // created after the plan makes the DROP of its referenced object fail
      // (2BP01), the blocker is classified as outside the verified closure,
      // and the transaction ROLLBACKs with EVERYTHING preserved.
      //
      // Deterministic interleaving without sleeps: session 2 (the attacker)
      // holds ACCESS EXCLUSIVE on the owned table in an UNCOMMITTED
      // transaction. Session 1 (the drop) therefore ALWAYS completes its
      // marker verification, the dependency gate and the drop plan, and then
      // BLOCKS at the destructive DDL of the table. The test observes that
      // block in pg_locks, creates + commits the external view, and only
      // then lets the drop continue — the new dependent is guaranteed to
      // land AFTER the gate and BEFORE the destructive step, in every run.
      const runId = generateTestRunId();
      const token = generateOwnerToken();
      const tokenHash = ownerTokenHash(token);
      const target = `moeen_test_${runId}`;
      const sibling = `moeen_test_${runId}_w7`;
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      const dropClient = await pool.connect();
      const attackerClient = await pool.connect();
      try {
        await createOwnedSchema(pool, target, runId, tokenHash);
        await createOwnedSchema(pool, sibling, runId, tokenHash);
        await pool.query(
          `CREATE TABLE "${target}".t (id INT PRIMARY KEY, body TEXT)`,
        );

        await attackerClient.query('BEGIN');
        await attackerClient.query(
          `LOCK TABLE "${target}".t IN ACCESS EXCLUSIVE MODE`,
        );

        // Session 1 (the drop). The catch handler guarantees the promise can
        // never reject unhandled, even if an earlier assertion fails while
        // the drop is still blocked.
        let dropError: unknown;
        const dropSettled = dropOwnedSchemaAtomically(
          dropClient,
          target,
          runId,
          tokenHash,
        ).then(
          () => {
            dropError = null;
          },
          (error: unknown) => {
            dropError = error;
          },
        );

        // Wait until the drop session is provably blocked at the destructive
        // DDL of the table (it MUST block — the lock is held uncommitted).
        // Once observed, the gate and the drop plan have completed.
        let observedBlocked = false;
        for (let attempt = 0; attempt < 300; attempt += 1) {
          const waiting = await pool.query<{ n: number }>(
            `SELECT count(*)::int AS n
               FROM pg_locks l
               JOIN pg_class c ON c.oid = l.relation
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = $1 AND c.relname = $2 AND NOT l.granted`,
            [target, 't'],
          );
          if ((waiting.rows[0]?.n ?? 0) > 0) {
            observedBlocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(observedBlocked).toBe(true);

        // Create + commit the external dependent NOW, while the drop is
        // blocked at the destructive step: with the OLD CASCADE protocol
        // this view would be destroyed by the drop.
        await attackerClient.query(
          `CREATE VIEW "${sibling}".q0sec_toctou_view
             AS SELECT id FROM "${target}".t`,
        );
        await attackerClient.query('COMMIT');
        await dropSettled;

        // Fail-closed: the drop REFUSED (nothing was destroyed) and the
        // view, the target schema and the sibling schema ALL survive.
        expect(dropError).toBeInstanceOf(TestDatabaseGuardError);
        expect((dropError as Error).message).toMatch(
          /new external dependent\(s\) appeared during teardown/,
        );
        expect(await schemaExists(target)).toBe(true);
        expect(await schemaExists(sibling)).toBe(true);
        const view = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relname = $2`,
          [sibling, 'q0sec_toctou_view'],
        );
        expect(view.rows[0].n).toBe(1);

        // Positive control: once the external dependent is removed, the SAME
        // teardown on the SAME schema succeeds — the refusal was caused by
        // the concurrent dependent, not by the protocol.
        await pool.query(`DROP VIEW "${sibling}".q0sec_toctou_view`);
        await dropOwnedSchemaAtomically(dropClient, target, runId, tokenHash);
        expect(await schemaExists(target)).toBe(false);
        expect(await schemaExists(sibling)).toBe(true);
      } finally {
        // Exact-name cleanup of EVERY schema this test created, regardless
        // of where it failed.
        await dropFabricated(target);
        await dropFabricated(sibling);
        dropClient.release();
        attackerClient.release();
        await pool.end();
      }
    });

    it('a NEW external partition created after the drop plan is refused and preserved (two-session adversarial)', async () => {
      // Exact partition race: session 2 holds ACCESS EXCLUSIVE on the owned
      // partitioned parent before session 1 starts cleanup. Session 1 can
      // therefore finish its dependency scan + drop plan, but blocks when it
      // reaches the planned parent DROP. Once that wait is observable in
      // pg_locks, session 2 creates an external partition and commits. A plain
      // DROP TABLE of the parent automatically removes attached partitions
      // even WITHOUT CASCADE, so cleanup must lock the parent first and then
      // revalidate while that lock is held; otherwise this external table is
      // silently destroyed.
      const runId = generateTestRunId();
      const token = generateOwnerToken();
      const tokenHash = ownerTokenHash(token);
      const target = `moeen_test_${runId}`;
      const sibling = `moeen_test_${runId}_w7`;
      const parent = 'q0sec_partitioned_parent';
      const externalPartition = 'q0sec_external_partition';
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      const dropClient = await pool.connect();
      const attackerClient = await pool.connect();
      let attackerInTransaction = false;
      let dropSettled: Promise<void> | undefined;
      try {
        await createOwnedSchema(pool, target, runId, tokenHash);
        await createOwnedSchema(pool, sibling, runId, tokenHash);
        await pool.query(
          `CREATE TABLE ${quoteIdent(target)}.${quoteIdent(parent)} (id INT NOT NULL)
             PARTITION BY RANGE (id)`,
        );

        await attackerClient.query('BEGIN');
        attackerInTransaction = true;
        await attackerClient.query(
          `LOCK TABLE ONLY ${quoteIdent(target)}.${quoteIdent(parent)}
             IN ACCESS EXCLUSIVE MODE`,
        );

        let dropError: unknown;
        dropSettled = dropOwnedSchemaAtomically(
          dropClient,
          target,
          runId,
          tokenHash,
        ).then(
          () => {
            dropError = null;
          },
          (error: unknown) => {
            dropError = error;
          },
        );

        // Both the vulnerable parent DROP and the fixed pre-drop exclusion
        // lock wait on this exact relation, so observing the ungranted lock
        // proves the initial scan/plan was computed before the partition is
        // attached. No timing guess is involved.
        let observedBlocked = false;
        for (let attempt = 0; attempt < 300; attempt += 1) {
          const waiting = await pool.query<{ n: number }>(
            `SELECT count(*)::int AS n
               FROM pg_locks l
               JOIN pg_class c ON c.oid = l.relation
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = $1
                AND c.relname = $2
                AND NOT l.granted`,
            [target, parent],
          );
          if ((waiting.rows[0]?.n ?? 0) > 0) {
            observedBlocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(observedBlocked).toBe(true);

        await attackerClient.query(
          `CREATE TABLE ${quoteIdent(sibling)}.${quoteIdent(externalPartition)}
             PARTITION OF ${quoteIdent(target)}.${quoteIdent(parent)}
             FOR VALUES FROM (0) TO (100)`,
        );
        await attackerClient.query('COMMIT');
        attackerInTransaction = false;
        await dropSettled;

        expect(dropError).toBeInstanceOf(TestDatabaseGuardError);
        expect((dropError as Error).message).toMatch(
          /dependent object\(s\) outside the owned namespace/,
        );
        expect(await schemaExists(target)).toBe(true);
        expect(await schemaExists(sibling)).toBe(true);
        const partition = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relname = $2`,
          [sibling, externalPartition],
        );
        expect(partition.rows[0].n).toBe(1);

        // Positive control: once detached, the external table is no longer a
        // child the parent DROP would remove. The same cleanup succeeds and
        // the external table remains in the sibling schema.
        await pool.query(
          `ALTER TABLE ${quoteIdent(target)}.${quoteIdent(parent)}
             DETACH PARTITION ${quoteIdent(sibling)}.${quoteIdent(externalPartition)}`,
        );
        await dropOwnedSchemaAtomically(dropClient, target, runId, tokenHash);
        expect(await schemaExists(target)).toBe(false);
        const detached = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relname = $2`,
          [sibling, externalPartition],
        );
        expect(detached.rows[0].n).toBe(1);
      } finally {
        if (attackerInTransaction) {
          await attackerClient.query('ROLLBACK').catch(() => undefined);
        }
        await dropSettled?.catch(() => undefined);
        await dropFabricated(target);
        await dropFabricated(sibling);
        dropClient.release();
        attackerClient.release();
        await pool.end();
      }
    });

    it('retains the partition parent exclusion lock until cleanup commits and refuses a late ATTACH PARTITION', async () => {
      // Lock-retention regression for the fixed partition race. A third
      // session holds a deterministic barrier table that was created BEFORE
      // the partitioned parent. Cleanup computes its initial plan, acquires
      // ACCESS EXCLUSIVE on the parent, revalidates, and then blocks trying to
      // drop that earlier barrier. Exact PID + relation OID + mode evidence
      // below therefore proves cleanup is retaining the granted parent lock
      // after its initial plan while a late ATTACH is waiting on that lock.
      const runId = generateTestRunId();
      const token = generateOwnerToken();
      const tokenHash = ownerTokenHash(token);
      const target = `moeen_test_${runId}`;
      const sibling = `moeen_test_${runId}_w7`;
      const barrier = 'q0sec_cleanup_barrier';
      const parent = 'q0sec_lock_retention_parent';
      const externalTable = 'q0sec_late_standalone';
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      const dropClient = await pool.connect();
      const barrierClient = await pool.connect();
      const attachClient = await pool.connect();
      let barrierInTransaction = false;
      let dropSettled: Promise<void> | undefined;
      let attachSettled: Promise<void> | undefined;
      try {
        await createOwnedSchema(pool, target, runId, tokenHash);
        await createOwnedSchema(pool, sibling, runId, tokenHash);
        // Creation order is deliberate: pg_class roots are swept by OID, so
        // cleanup reaches this barrier before the later partitioned parent.
        await pool.query(
          `CREATE TABLE ${quoteIdent(target)}.${quoteIdent(barrier)} (id INT)`,
        );
        await pool.query(
          `CREATE TABLE ${quoteIdent(target)}.${quoteIdent(parent)} (id INT NOT NULL)
             PARTITION BY RANGE (id)`,
        );
        // This is an EXISTING standalone external table, not CREATE TABLE ...
        // PARTITION OF. Its row and standalone identity must survive refusal.
        await pool.query(
          `CREATE TABLE ${quoteIdent(sibling)}.${quoteIdent(externalTable)} (
             id INT NOT NULL CHECK (id >= 0 AND id < 100)
           )`,
        );
        await pool.query(
          `INSERT INTO ${quoteIdent(sibling)}.${quoteIdent(externalTable)} (id)
           VALUES (42)`,
        );

        const relations = await pool.query<{
          barrier_oid: number;
          external_oid: number;
          parent_oid: number;
        }>(
          `SELECT
             to_regclass(format('%I.%I', $1::text, $2::text))::oid::int AS barrier_oid,
             to_regclass(format('%I.%I', $1::text, $3::text))::oid::int AS parent_oid,
             to_regclass(format('%I.%I', $4::text, $5::text))::oid::int AS external_oid`,
          [target, barrier, parent, sibling, externalTable],
        );
        const { barrier_oid: barrierOid, parent_oid: parentOid } =
          relations.rows[0];
        const dropPid = (
          await dropClient.query<{ pid: number }>(
            'SELECT pg_backend_pid()::int AS pid',
          )
        ).rows[0].pid;
        const attachPid = (
          await attachClient.query<{ pid: number }>(
            'SELECT pg_backend_pid()::int AS pid',
          )
        ).rows[0].pid;

        await barrierClient.query('BEGIN');
        barrierInTransaction = true;
        await barrierClient.query(
          `LOCK TABLE ${quoteIdent(target)}.${quoteIdent(barrier)}
             IN ACCESS EXCLUSIVE MODE`,
        );

        let dropError: unknown;
        dropSettled = dropOwnedSchemaAtomically(
          dropClient,
          target,
          runId,
          tokenHash,
        ).then(
          () => {
            dropError = null;
          },
          (error: unknown) => {
            dropError = error;
          },
        );

        // Prove both sides of the cleanup barrier using this cleanup backend's
        // exact PID and the exact relation OIDs/modes: parent lock GRANTED,
        // barrier DROP lock UNGRANTED. The parent lock is acquired only after
        // computeDropPlan(), so this is the required post-plan interleaving.
        let observedCleanupBarrier = false;
        for (let attempt = 0; attempt < 300; attempt += 1) {
          const locks = await pool.query<{
            barrier_waiting: boolean;
            parent_granted: boolean;
          }>(
            `SELECT
               EXISTS (
                 SELECT 1 FROM pg_locks l
                  WHERE l.pid = $1
                    AND l.locktype = 'relation'
                    AND l.relation = $2::oid
                    AND l.mode = 'AccessExclusiveLock'
                    AND l.granted
               ) AS parent_granted,
               EXISTS (
                 SELECT 1 FROM pg_locks l
                  WHERE l.pid = $1
                    AND l.locktype = 'relation'
                    AND l.relation = $3::oid
                    AND l.mode = 'AccessExclusiveLock'
                    AND NOT l.granted
               ) AS barrier_waiting`,
            [dropPid, parentOid, barrierOid],
          );
          const state = locks.rows[0];
          if (state.parent_granted && state.barrier_waiting) {
            observedCleanupBarrier = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(observedCleanupBarrier).toBe(true);

        let attachError: unknown;
        attachSettled = attachClient
          .query(
            `ALTER TABLE ${quoteIdent(target)}.${quoteIdent(parent)}
               ATTACH PARTITION ${quoteIdent(sibling)}.${quoteIdent(externalTable)}
               FOR VALUES FROM (0) TO (100)`,
          )
          .then(
            () => {
              attachError = null;
            },
            (error: unknown) => {
              attachError = error;
            },
          );

        // PostgreSQL 16 ATTACH PARTITION requests ShareUpdateExclusiveLock on
        // the parent. Tie the ungranted row to this exact attach backend and
        // parent OID so no cleanup/barrier waiter can satisfy the assertion.
        let observedAttachBlocked = false;
        for (let attempt = 0; attempt < 300; attempt += 1) {
          const waiting = await pool.query<{ waiting: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM pg_locks l
                WHERE l.pid = $1
                  AND l.locktype = 'relation'
                  AND l.relation = $2::oid
                  AND l.mode = 'ShareUpdateExclusiveLock'
                  AND NOT l.granted
             ) AS waiting`,
            [attachPid, parentOid],
          );
          if (waiting.rows[0].waiting) {
            observedAttachBlocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(observedAttachBlocked).toBe(true);

        // Release only the deterministic barrier. Cleanup must retain its
        // parent lock, finish the no-CASCADE sweep, and commit before ATTACH
        // wakes and refuses because the owned parent no longer exists.
        await barrierClient.query('ROLLBACK');
        barrierInTransaction = false;
        await dropSettled;
        await attachSettled;

        expect(dropError).toBeNull();
        expect(attachError).toBeInstanceOf(Error);
        expect(await schemaExists(target)).toBe(false);
        expect(await schemaExists(sibling)).toBe(true);
        const external = await pool.query<{ relispartition: boolean }>(
          `SELECT c.relispartition
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.oid = $1::oid
              AND n.nspname = $2
              AND c.relname = $3`,
          [relations.rows[0].external_oid, sibling, externalTable],
        );
        expect(external.rows).toEqual([{ relispartition: false }]);
        const rows = await pool.query<{ id: number }>(
          `SELECT id FROM ${quoteIdent(sibling)}.${quoteIdent(externalTable)}`,
        );
        expect(rows.rows).toEqual([{ id: 42 }]);
      } finally {
        // Unblock every pending promise before releasing clients or attempting
        // exact-name fixture cleanup, even when an earlier assertion fails.
        if (barrierInTransaction) {
          await barrierClient.query('ROLLBACK').catch(() => undefined);
        }
        await dropSettled?.catch(() => undefined);
        await attachSettled?.catch(() => undefined);
        await dropFabricated(target);
        await dropFabricated(sibling);
        dropClient.release();
        barrierClient.release();
        attachClient.release();
        await pool.end();
      }
    });

    it('a raw DROP SCHEMA CASCADE destroys an external dependent committed between scan and drop (control — the race the protocol closes)', async () => {
      // Control for the scan-to-drop TOCTOU regression: drives the OLD
      // protocol shape (a dependent created + committed while a drop
      // transaction is open, then DROP SCHEMA CASCADE) and proves the
      // CASCADE destroys the external dependent — i.e. the interleaving the
      // new no-CASCADE protocol refuses is a REAL destructive race. With the
      // protocol, the same interleaving refuses and preserves everything
      // (see the two-session adversarial regression above).
      const runId = generateTestRunId();
      const token = generateOwnerToken();
      const tokenHash = ownerTokenHash(token);
      const target = `moeen_test_${runId}`;
      const sibling = `moeen_test_${runId}_w7`;
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      const client = await pool.connect();
      try {
        await createOwnedSchema(pool, target, runId, tokenHash);
        await createOwnedSchema(pool, sibling, runId, tokenHash);
        await pool.query(
          `CREATE TABLE "${target}".t (id INT PRIMARY KEY, body TEXT)`,
        );

        // Old-shape protocol: BEGIN (snapshot established), then the
        // external dependent is created + committed by a SECOND session
        // (its own transaction), then DROP SCHEMA CASCADE — a fresh
        // statement snapshot, so the dependent is visible to the CASCADE.
        await client.query('BEGIN');
        await client.query('SELECT 1');
        await pool.query(
          `CREATE VIEW "${sibling}".q0sec_cascade_control
             AS SELECT id FROM "${target}".t`,
        );
        await client.query(`DROP SCHEMA "${target}" CASCADE`);
        await client.query('COMMIT');

        // The CASCADE destroyed the external view — the race is real.
        const view = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relname = $2`,
          [sibling, 'q0sec_cascade_control'],
        );
        expect(view.rows[0].n).toBe(0);
        expect(await schemaExists(target)).toBe(false);
        expect(await schemaExists(sibling)).toBe(true);
      } finally {
        // Exact-name cleanup of EVERY schema this test created, regardless
        // of where it failed.
        client.release();
        await dropFabricated(target);
        await dropFabricated(sibling);
        await pool.end();
      }
    });

    it('a swapped marker refuses the drop and the schema survives', async () => {
      const runId = generateTestRunId();
      const token = generateOwnerToken();
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      const client = await pool.connect();
      try {
        await createOwnedSchema(
          pool,
          `moeen_test_${runId}`,
          runId,
          ownerTokenHash(token),
        );
        await createOwnedSchema(
          pool,
          `moeen_test_${runId}_w7`,
          runId,
          ownerTokenHash(token),
        );
        // Swap the worker marker's run id so it no longer matches this run.
        await pool.query(
          `UPDATE ${qualifiedMarkerTable(`moeen_test_${runId}_w7`)} SET run_id = $1`,
          [generateTestRunId()],
        );
        await withFakeRun(runId, token, async () => {
          // The worker with the swapped marker is refused and recorded; the
          // run anchor is dropped after it. Teardown fails at the end with
          // the aggregated refusal.
          await expect(globalTeardown()).rejects.toThrow(
            /refused to drop .* schema\(s\) not owned by this run/,
          );
        });
        expect(await schemaExists(`moeen_test_${runId}`)).toBe(false);
        expect(await schemaExists(`moeen_test_${runId}_w7`)).toBe(true);
      } finally {
        // Exact-name cleanup of EVERY schema this test created: the run
        // schema (which the refused teardown left behind) and the worker.
        await dropFabricated(`moeen_test_${runId}`);
        await dropFabricated(`moeen_test_${runId}_w7`);
        client.release();
        await pool.end();
      }
    });

    it('a wrong owner token refuses the drop and the schema survives', async () => {
      const runId = generateTestRunId();
      const token = generateOwnerToken();
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      const client = await pool.connect();
      try {
        await createOwnedSchema(
          pool,
          `moeen_test_${runId}`,
          runId,
          ownerTokenHash(token),
        );
        await createOwnedSchema(
          pool,
          `moeen_test_${runId}_w7`,
          runId,
          ownerTokenHash(token),
        );
        await withFakeRun(runId, generateOwnerToken(), async () => {
          // Every schema is refused (wrong token) and recorded — workers
          // first, anchor last. Teardown aggregates the refusals and fails at
          // the end with the underlying ownership-mismatch reasons.
          await expect(globalTeardown()).rejects.toThrow(
            /ownership marker does not match/,
          );
        });
        // The run schema the teardown tried to drop was REFUSED because of
        // the wrong token — fail-closed means it must still exist.
        expect(await schemaExists(`moeen_test_${runId}`)).toBe(true);
        // The worker schema also survives (independent evidence).
        expect(await schemaExists(`moeen_test_${runId}_w7`)).toBe(true);
      } finally {
        await dropFabricated(`moeen_test_${runId}`);
        await dropFabricated(`moeen_test_${runId}_w7`);
        client.release();
        await pool.end();
      }
    });

    it('the correct path drops the exact owned schemas and refuses a foreign lookalike', async () => {
      const runId = generateTestRunId();
      const token = generateOwnerToken();
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      const client = await pool.connect();
      try {
        await createOwnedSchema(
          pool,
          `moeen_test_${runId}`,
          runId,
          ownerTokenHash(token),
        );
        await createOwnedSchema(
          pool,
          `moeen_test_${runId}_w1`,
          runId,
          ownerTokenHash(token),
        );
        // A foreign schema with the same tight prefix but NO marker.
        await pool.query(`CREATE SCHEMA "moeen_test_${runId}_w9"`);
        await withFakeRun(runId, token, async () => {
          // The owned schemas (workers first, anchor last) are dropped; the
          // foreign lookalike is refused and recorded. Teardown continues
          // past it and fails at the end.
          await expect(globalTeardown()).rejects.toThrow(
            /refused to drop .* schema\(s\) not owned by this run/,
          );
        });
        // The owned schemas were dropped; the foreign one was refused.
        expect(await schemaExists(`moeen_test_${runId}`)).toBe(false);
        expect(await schemaExists(`moeen_test_${runId}_w1`)).toBe(false);
        expect(await schemaExists(`moeen_test_${runId}_w9`)).toBe(true);
      } finally {
        // Exact-name cleanup of EVERY schema this test created, regardless of
        // where it failed: run + worker + the foreign lookalike.
        await dropFabricated(`moeen_test_${runId}`);
        await dropFabricated(`moeen_test_${runId}_w1`);
        await dropFabricated(`moeen_test_${runId}_w9`);
        client.release();
        await pool.end();
      }
    });

    it('a corrupt/foreign run anchor never prevents a valid owned worker schema from being cleaned', async () => {
      // Finding B adversarial regression: the run ANCHOR schema exists under
      // the canonical name but is corrupt/foreign (NO ownership marker — a
      // leaked or attacker-created namespace), while a VALID owned worker
      // schema of this run carries a matching marker. Teardown must refuse
      // the anchor, still clean the valid worker safely, and only then fail
      // with the aggregated refusal.
      const runId = generateTestRunId();
      const token = generateOwnerToken();
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      const client = await pool.connect();
      try {
        // Corrupt/foreign run anchor: bare schema, no marker table.
        await pool.query(`CREATE SCHEMA "moeen_test_${runId}"`);
        // Valid owned worker schema WITH the exact matching marker.
        await createOwnedSchema(
          pool,
          `moeen_test_${runId}_w7`,
          runId,
          ownerTokenHash(token),
        );
        await withFakeRun(runId, token, async () => {
          // Teardown processes workers FIRST, the anchor LAST, and only then
          // throws the aggregated refusal (which names the refused anchor).
          await expect(globalTeardown()).rejects.toThrow(
            new RegExp(
              `refused to drop .* schema\\(s\\) not owned by this run: .*moeen_test_${runId} \\(.*ownership marker table is not bound to the expected namespace OID`,
            ),
          );
        });
        // The valid owned worker WAS cleaned safely despite the corrupt
        // anchor — the anchor refusal never prevented its cleanup.
        expect(await schemaExists(`moeen_test_${runId}_w7`)).toBe(false);
        // The corrupt/foreign anchor was REFUSED, never dropped.
        expect(await schemaExists(`moeen_test_${runId}`)).toBe(true);
      } finally {
        // Exact-name cleanup of EVERY schema this test created, regardless of
        // where it failed: the corrupt anchor (refused, left behind) and the
        // worker (dropped by teardown, but IF the test failed early it may
        // still exist).
        await dropFabricated(`moeen_test_${runId}`);
        await dropFabricated(`moeen_test_${runId}_w7`);
        client.release();
        await pool.end();
      }
    });

    it('refuses the drop when CASCADE would destroy dependent objects outside the owned namespace (dependency-safe gate)', async () => {
      // HIGH final-review finding regression: DROP SCHEMA CASCADE deletes or
      // ALTERS dependent objects OUTSIDE the verified namespace (here: a
      // foreign key constraint and a view in a sibling schema referencing the
      // owned table). Teardown must DETECT the boundary-crossing dependencies
      // before the destructive DDL and REFUSE — leaving the target schema,
      // the sibling schema and every external dependent object untouched.
      const runId = generateTestRunId();
      const token = generateOwnerToken();
      const tokenHash = ownerTokenHash(token);
      const target = `moeen_test_${runId}`;
      const sibling = `moeen_test_${runId}_w7`;
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      const client = await pool.connect();
      try {
        await createOwnedSchema(pool, target, runId, tokenHash);
        await createOwnedSchema(pool, sibling, runId, tokenHash);
        // The owned table carries a TOAST-able column: its toast table is the
        // ONE legitimately external implementation artifact (allowlisted) and
        // must NOT cause a refusal — otherwise teardown would break on every
        // schema that ever held text/bytea data.
        await pool.query(
          `CREATE TABLE "${target}".t (id INT PRIMARY KEY, body TEXT)`,
        );
        // External dependent objects INSIDE the sibling namespace but OUTSIDE
        // the target namespace: a foreign key constraint and a view that
        // reference target.t. Both would be destroyed by a naive CASCADE.
        await pool.query(
          `CREATE TABLE "${sibling}".ref_tbl (id INT PRIMARY KEY)`,
        );
        await pool.query(
          `ALTER TABLE "${sibling}".ref_tbl
             ADD CONSTRAINT q0sec_cross_fk
             FOREIGN KEY (id) REFERENCES "${target}".t(id)`,
        );
        await pool.query(
          `CREATE VIEW "${sibling}".q0sec_cross_view
             AS SELECT id FROM "${target}".t`,
        );

        // Teardown REFUSES instead of causing cross-schema destruction.
        await expect(
          dropOwnedSchemaAtomically(client, target, runId, tokenHash),
        ).rejects.toThrow(
          /destroy \d+ dependent object\(s\) outside the owned namespace/,
        );

        // Fail-closed: NOTHING was deleted or altered — the target schema,
        // the sibling schema and both external dependent objects all survive
        // (the refusal ROLLBACKs the whole transaction, including the rename
        // that bound the drop to the verified namespace OID).
        expect(await schemaExists(target)).toBe(true);
        expect(await schemaExists(sibling)).toBe(true);
        const fk = await pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM pg_constraint WHERE conname = $1',
          ['q0sec_cross_fk'],
        );
        expect(fk.rows[0].n).toBe(1);
        const view = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relname = $2`,
          [sibling, 'q0sec_cross_view'],
        );
        expect(view.rows[0].n).toBe(1);

        // Positive control: the refusal is caused by the external dependents
        // and nothing else. Once they are removed, the SAME teardown on the
        // SAME schema succeeds — proving the gate is precise, not a blanket
        // blocking of cleanup.
        await pool.query(`DROP VIEW "${sibling}".q0sec_cross_view`);
        await pool.query(
          `ALTER TABLE "${sibling}".ref_tbl DROP CONSTRAINT q0sec_cross_fk`,
        );
        await dropOwnedSchemaAtomically(client, target, runId, tokenHash);
        expect(await schemaExists(target)).toBe(false);
        expect(await schemaExists(sibling)).toBe(true);
      } finally {
        // Exact-name cleanup of EVERY schema this test created, regardless of
        // where it failed: both schemas survive the refused drop and the
        // positive-control drop only ever removed the target.
        client.release();
        await dropFabricated(target);
        await dropFabricated(sibling);
        await pool.end();
      }
    });

    it('refuses the drop when an EXTERNAL table column depends on an owned COLLATION (pg_collation containment regression)', async () => {
      // HIGH final-review finding regression: the dependency-boundary scan
      // used to enumerate the 'inside' catalogs by hand and OMITTED
      // pg_collation. An owned collation referenced by a column of an
      // external table therefore escaped the gate — and DROP SCHEMA CASCADE
      // then silently DROPPED the external column (verified against PG16:
      // the column is destroyed, not merely altered). The containment model
      // is now derived from PostgreSQL's own dependency graph on BOTH sides:
      // the doomed set is the graph closure, and the owned set is the direct
      // namespace binding (which covers pg_collation by construction — no
      // catalog list exists to omit) plus internal/auto/extension artifacts.
      // The external column is reached through a NORMAL ('n') arc on the
      // owned collation, so it is refused. This test proves the collation
      // case is refused and fail-closed, then that removing the external
      // dependency lets the SAME teardown succeed.
      const runId = generateTestRunId();
      const token = generateOwnerToken();
      const tokenHash = ownerTokenHash(token);
      const target = `moeen_test_${runId}`;
      const sibling = `moeen_test_${runId}_w7`;
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      const client = await pool.connect();
      try {
        await createOwnedSchema(pool, target, runId, tokenHash);
        await createOwnedSchema(pool, sibling, runId, tokenHash);
        // An owned collation INSIDE the target namespace...
        await pool.query(
          `CREATE COLLATION "${target}".q0sec_cross_coll (provider = libc, locale = 'C')`,
        );
        // ...referenced by a column of an EXTERNAL table (sibling schema).
        // DROP SCHEMA CASCADE on the target would destroy that column.
        await pool.query(
          `CREATE TABLE "${sibling}".ext_ref (id INT PRIMARY KEY, c TEXT COLLATE "${target}".q0sec_cross_coll)`,
        );

        // Teardown REFUSES instead of causing cross-schema destruction.
        await expect(
          dropOwnedSchemaAtomically(client, target, runId, tokenHash),
        ).rejects.toThrow(
          /destroy \d+ dependent object\(s\) outside the owned namespace/,
        );

        // Fail-closed: NOTHING was deleted or altered. The target schema and
        // its collation survive; the external table and its column survive
        // WITH the collation still bound to the column.
        expect(await schemaExists(target)).toBe(true);
        expect(await schemaExists(sibling)).toBe(true);
        const coll = await pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM pg_collation WHERE collname = $1',
          ['q0sec_cross_coll'],
        );
        expect(coll.rows[0].n).toBe(1);
        const col = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_attribute a
             JOIN pg_class c ON c.oid = a.attrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relname = $2 AND a.attname = $3
              AND a.attnum > 0 AND NOT a.attisdropped`,
          [sibling, 'ext_ref', 'c'],
        );
        expect(col.rows[0].n).toBe(1);
        const colColl = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_attribute a
             JOIN pg_class c ON c.oid = a.attrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_collation cl ON cl.oid = a.attcollation
            WHERE n.nspname = $1 AND c.relname = $2 AND a.attname = $3
              AND cl.collname = $4 AND cl.collnamespace = $5::regnamespace`,
          [sibling, 'ext_ref', 'c', 'q0sec_cross_coll', target],
        );
        expect(colColl.rows[0].n).toBe(1);

        // Positive control: remove the external dependency (drop the column);
        // the SAME teardown on the SAME schema then succeeds — proving the
        // gate is precise, not a blanket blocking of cleanup — and only the
        // target schema is gone while the sibling table remains.
        await pool.query(`ALTER TABLE "${sibling}".ext_ref DROP COLUMN c`);
        await dropOwnedSchemaAtomically(client, target, runId, tokenHash);
        expect(await schemaExists(target)).toBe(false);
        expect(await schemaExists(sibling)).toBe(true);
        const extTable = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relname = $2`,
          [sibling, 'ext_ref'],
        );
        expect(extTable.rows[0].n).toBe(1);
      } finally {
        // Exact-name cleanup of EVERY schema this test created, regardless of
        // where it failed: both schemas survive the refused drop and the
        // positive-control drop only ever removed the target.
        client.release();
        await dropFabricated(target);
        await dropFabricated(sibling);
        await pool.end();
      }
    });

    it('tears down an owned schema containing EVERY namespace-owned object class and implementation artifact (complete-coverage containment)', async () => {
      // Positive completeness regression for the derived containment model:
      // the owned boundary must cover every object class the test role can
      // create in its run schema — tables (PK/unique/plain indexes, toast,
      // defaults, triggers, policies, serial sequences, RLS), views (+_RETURN
      // rule), enums/domains (+domain constraint), range types (+automatic
      // multirange type, casts and constructor functions), collations,
      // conversions, text-search config/dictionary, extended statistics and
      // (when available) a trusted extension — WITHOUT any false refusal.
      // Before the derivation, each hand-enumerated 'inside' catalog was a
      // potential false-refusal landmine; the collation regression above is
      // the adversarial half, this test is the coverage half.
      const runId = generateTestRunId();
      const token = generateOwnerToken();
      const tokenHash = ownerTokenHash(token);
      const target = `moeen_test_${runId}`;
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      const client = await pool.connect();
      try {
        await createOwnedSchema(pool, target, runId, tokenHash);
        const t = `"${target}"`;
        // Tables + indexes + toast + defaults + triggers + policies + serial.
        await pool.query(
          `CREATE TABLE ${t}.t (
             id SERIAL PRIMARY KEY,
             body TEXT DEFAULT 'x',
             code TEXT UNIQUE,
             payload BYTEA
           )`,
        );
        await pool.query(`CREATE INDEX q0sec_full_idx ON ${t}.t (body)`);
        await pool.query(
          `CREATE FUNCTION ${t}.trg() RETURNS trigger LANGUAGE plpgsql
             AS 'BEGIN RETURN NEW; END'`,
        );
        await pool.query(
          `CREATE TRIGGER trg_full BEFORE INSERT ON ${t}.t
             FOR EACH ROW EXECUTE FUNCTION ${t}.trg()`,
        );
        await pool.query(`ALTER TABLE ${t}.t ENABLE ROW LEVEL SECURITY`);
        await pool.query(`CREATE POLICY pol_full ON ${t}.t USING (true)`);
        // View + _RETURN rule.
        await pool.query(`CREATE VIEW ${t}.v AS SELECT id, body FROM ${t}.t`);
        // Enum + array, domain + domain constraint, range + multirange +
        // automatic casts + constructor functions.
        await pool.query(`CREATE TYPE ${t}.myenum AS ENUM ('a', 'b')`);
        await pool.query(
          `CREATE TABLE ${t}.arr (id INT PRIMARY KEY, vals ${t}.myenum[])`,
        );
        await pool.query(`CREATE DOMAIN ${t}.pos_int AS INT CHECK (VALUE > 0)`);
        await pool.query(`CREATE TYPE ${t}.myrange AS RANGE (subtype = int4)`);
        await pool.query(
          `CREATE TABLE ${t}.rg (id INT PRIMARY KEY, r ${t}.myrange, m ${t}.mymultirange)`,
        );
        // Collation, conversion, text-search objects, extended statistics.
        await pool.query(
          `CREATE COLLATION ${t}.coll_full (provider = libc, locale = 'C')`,
        );
        await pool.query(
          `CREATE CONVERSION ${t}.conv_full FOR 'LATIN1' TO 'UTF8' FROM iso8859_1_to_utf8`,
        );
        await pool.query(
          `CREATE TEXT SEARCH CONFIGURATION ${t}.tsconf_full (COPY = pg_catalog.simple)`,
        );
        await pool.query(
          `CREATE TEXT SEARCH DICTIONARY ${t}.tsdict_full (TEMPLATE = pg_catalog.simple)`,
        );
        await pool.query(`CREATE STATISTICS stx_full ON id, body FROM ${t}.t`);
        // direct namespace arcs). pgcrypto is the only trusted extension on
        // the reference PG16; if it is absent server-side, skip gracefully.
        let extCreated = false;
        try {
          await pool.query(`CREATE EXTENSION pgcrypto SCHEMA ${t}`);
          extCreated = true;
        } catch {
          // Extension unavailable on this server — the coverage above is
          // still complete for every other class; skip the extension part.
        }

        // EVERY object class above must be classified owned: teardown must
        // succeed on the first attempt with zero refusals.
        await dropOwnedSchemaAtomically(client, target, runId, tokenHash);
        expect(await schemaExists(target)).toBe(false);
        if (extCreated) {
          // The extension and all its members died with the schema.
          const ext = await pool.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM pg_extension WHERE extname = $1',
            ['pgcrypto'],
          );
          expect(ext.rows[0].n).toBe(0);
        }
      } finally {
        client.release();
        await dropFabricated(target);
        await pool.end();
      }
    });

    it('global teardown refuses when a FOREIGN schema depends on the run anchor (no cross-schema destruction)', async () => {
      // Teardown-level adversarial regression: the run ANCHOR is legitimately
      // owned, but a FOREIGN (unowned) lookalike worker schema holds a foreign
      // key and a view referencing the anchor's table. Teardown must NOT drop
      // the foreign schema (no marker) and must NOT drop the anchor either —
      // CASCADE on the anchor would delete/alter the foreign objects — so it
      // refuses both, records the refusals and fails, with every object
      // preserved.
      const runId = generateTestRunId();
      const token = generateOwnerToken();
      const tokenHash = ownerTokenHash(token);
      const anchor = `moeen_test_${runId}`;
      const foreign = `moeen_test_${runId}_w9`;
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      try {
        await createOwnedSchema(pool, anchor, runId, tokenHash);
        await pool.query(
          `CREATE TABLE "${anchor}".t (id INT PRIMARY KEY, body TEXT)`,
        );
        // Foreign/unowned lookalike schema (tight prefix, NO ownership
        // marker) that references the anchor's table.
        await pool.query(`CREATE SCHEMA "${foreign}"`);
        await pool.query(
          `CREATE TABLE "${foreign}".dep_tbl (id INT PRIMARY KEY)`,
        );
        await pool.query(
          `ALTER TABLE "${foreign}".dep_tbl
             ADD CONSTRAINT q0sec_foreign_fk
             FOREIGN KEY (id) REFERENCES "${anchor}".t(id)`,
        );
        await pool.query(
          `CREATE VIEW "${foreign}".q0sec_foreign_view
             AS SELECT id FROM "${anchor}".t`,
        );

        await withFakeRun(runId, token, async () => {
          // The foreign worker is refused (no marker) and the anchor is
          // refused by the dependency-safe gate; teardown aggregates both
          // refusals and fails closed.
          await expect(globalTeardown()).rejects.toThrow(
            /refused to drop .* schema\(s\) not owned by this run: .*destroy \d+ dependent object\(s\) outside the owned namespace/,
          );
        });

        // Fail-closed: the foreign schema was never dropped, the anchor was
        // never dropped, and the foreign dependent objects are preserved —
        // teardown refused rather than causing cross-schema destructive
        // effects.
        expect(await schemaExists(anchor)).toBe(true);
        expect(await schemaExists(foreign)).toBe(true);
        const fk = await pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM pg_constraint WHERE conname = $1',
          ['q0sec_foreign_fk'],
        );
        expect(fk.rows[0].n).toBe(1);
        const view = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relname = $2`,
          [foreign, 'q0sec_foreign_view'],
        );
        expect(view.rows[0].n).toBe(1);
      } finally {
        // Exact-name cleanup of EVERY schema this test created, regardless of
        // where it failed: the refused anchor and the foreign lookalike.
        await dropFabricated(anchor);
        await dropFabricated(foreign);
        await pool.end();
      }
    });

    it('discovers and cleans an owned worker schema renamed before teardown, leaving foreign schemas untouched', async () => {
      // MEDIUM final-review finding regression: worker discovery used to key
      // on the expected NAME pattern (moeen_test_<runId>_w<workerId>), so a
      // legitimately owned worker schema renamed before teardown evaded
      // discovery and leaked. Discovery is now marker-IDENTITY-based as well:
      // the immutable ownership marker proves the renamed namespace belongs
      // to this run, so teardown finds and safely cleans the exact owned
      // namespace regardless of its current name — while foreign schemas
      // (unmarked, or marked by a different run) are preserved untouched.
      const runId = generateTestRunId();
      const token = generateOwnerToken();
      const otherRunId = generateTestRunId();
      const renamedWorker = `q0sec_renamed_${runId}`;
      const foreignBare = `q0sec_foreign_${generateTestRunId()}`;
      const foreignRunSchema = `moeen_test_${otherRunId}_w2`;
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      try {
        await createOwnedSchema(
          pool,
          `moeen_test_${runId}`,
          runId,
          ownerTokenHash(token),
        );
        // A legitimately owned worker schema of this run...
        await createOwnedSchema(
          pool,
          `moeen_test_${runId}_w1`,
          runId,
          ownerTokenHash(token),
        );
        // ...RENAMED before teardown to a name outside the worker pattern.
        await pool.query(
          `ALTER SCHEMA "moeen_test_${runId}_w1" RENAME TO "${renamedWorker}"`,
        );
        // A foreign schema with no marker at all.
        await pool.query(`CREATE SCHEMA "${foreignBare}"`);
        // A foreign schema carrying the marker of a DIFFERENT run (the shape
        // a parallel run's worker schema has while that run is still in
        // flight) — must be skipped, never refused.
        await createOwnedSchema(
          pool,
          foreignRunSchema,
          otherRunId,
          ownerTokenHash(generateOwnerToken()),
        );
        await withFakeRun(runId, token, async () => {
          // Marker-identity discovery finds the renamed owned schema and
          // cleans it; the foreign schemas are preserved and NO refusal is
          // raised — teardown resolves.
          await expect(globalTeardown()).resolves.toBeUndefined();
        });
        // The owned namespaces were cleaned: the anchor and — the regression
        // — the renamed worker schema, under its NEW name.
        expect(await schemaExists(`moeen_test_${runId}`)).toBe(false);
        expect(await schemaExists(`moeen_test_${runId}_w1`)).toBe(false);
        expect(await schemaExists(renamedWorker)).toBe(false);
        // The foreign schemas are untouched.
        expect(await schemaExists(foreignBare)).toBe(true);
        expect(await schemaExists(foreignRunSchema)).toBe(true);
      } finally {
        // Exact-name cleanup of EVERY schema this test created, regardless of
        // where it failed.
        await dropFabricated(`moeen_test_${runId}`);
        await dropFabricated(`moeen_test_${runId}_w1`);
        await dropFabricated(renamedWorker);
        await dropFabricated(foreignBare);
        await dropFabricated(foreignRunSchema);
        await pool.end();
      }
    });

    it('cleans an owned worker schema RENAMED after enumeration (OID-keyed discovery, two-session adversarial)', async () => {
      // MEDIUM final-review finding regression: marker-identity enumeration
      // used to read the marker by the ENUMERATED NAME, so a worker schema
      // renamed AFTER the enumeration query but BEFORE the name-based marker
      // lookup evaded discovery and leaked silently (old-name lookup → null
      // → skip, no refusal). Discovery is now keyed on the DURABLE namespace
      // OID: the classification re-resolves the CURRENT name from the OID
      // with a bounded retry loop, so the renamed schema is found and cleaned
      // through the same atomic routine.
      //
      // Deterministic interleaving without sleeps: session 2 locks the
      // worker's marker row in an UNCOMMITTED transaction, so teardown
      // ALWAYS blocks at its marker read — which happens AFTER enumeration.
      // The test observes that block in pg_locks, renames the schema +
      // commits, and only then lets teardown continue: the rename is
      // guaranteed to land after enumeration and before the name-based
      // marker lookup, in every run.
      const runId = generateTestRunId();
      const token = generateOwnerToken();
      const enumeratedWorker = `q0sec_enumerated_${runId}`;
      const renamedWorker = `q0sec_renamed_after_enum_${runId}`;
      const foreignBare = `q0sec_foreign_${generateTestRunId()}`;
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      const attackerClient = await pool.connect();
      let attackerInTransaction = false;
      let teardownSettled: Promise<void> | undefined;
      try {
        await createOwnedSchema(
          pool,
          `moeen_test_${runId}`,
          runId,
          ownerTokenHash(token),
        );
        await createOwnedSchema(
          pool,
          `moeen_test_${runId}_w1`,
          runId,
          ownerTokenHash(token),
        );
        // Move the legitimate worker outside the canonical worker-name shape
        // BEFORE teardown starts. This prevents the earlier name-based worker
        // pass from intercepting it: marker-identity enumeration must discover
        // this exact namespace under enumeratedWorker, after which the second
        // rename below exercises the OID-keyed re-resolution race itself.
        await pool.query(
          `ALTER SCHEMA "moeen_test_${runId}_w1" RENAME TO "${enumeratedWorker}"`,
        );
        await pool.query(`CREATE SCHEMA "${foreignBare}"`);

        await attackerClient.query('BEGIN');
        attackerInTransaction = true;
        await attackerClient.query(
          `SELECT 1 FROM ${qualifiedMarkerTable(enumeratedWorker)} FOR UPDATE`,
        );
        const xidResult = await attackerClient.query<{ xid: string }>(
          'SELECT pg_current_xact_id()::text AS xid',
        );
        const attackerXid = xidResult.rows[0]?.xid;
        expect(attackerXid).toMatch(/^\d+$/);

        let teardownError: unknown;
        teardownSettled = withFakeRun(runId, token, async () => {
          try {
            await globalTeardown();
            return null;
          } catch (error: unknown) {
            return error;
          }
        }).then(
          (error: unknown) => {
            teardownError = error;
          },
          (error: unknown) => {
            // Keep the concurrent task handled even if the harness itself
            // rejects, so an earlier assertion can never leave an unhandled
            // promise behind.
            teardownError = error;
          },
        );

        // Wait until teardown is provably blocked at the marker read (it
        // MUST block — the row is locked uncommitted). On PostgreSQL 16 a
        // SELECT waiting for a row lock reports a not-granted
        // transactionid/ShareLock on the locker's XID; its relation is NULL,
        // so polling relation identity would never observe this wait. Once
        // this exact XID wait is observed, marker-identity enumeration has
        // completed with enumeratedWorker as its name hint and OID-keyed
        // classification is blocked at that marker lookup.
        let observedBlocked = false;
        for (let attempt = 0; attempt < 300; attempt += 1) {
          const waiting = await pool.query<{ n: number }>(
            `SELECT count(*)::int AS n
               FROM pg_locks l
              WHERE l.locktype = 'transactionid'
                AND l.transactionid::text = $1
                AND l.mode = 'ShareLock'
                AND NOT l.granted`,
            [attackerXid],
          );
          if ((waiting.rows[0]?.n ?? 0) > 0) {
            observedBlocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(observedBlocked).toBe(true);

        // Rename NOW + commit: the schema moves to a name outside the worker
        // pattern while teardown is between marker-identity enumeration and
        // the completion of its marker lookup.
        await attackerClient.query(
          `ALTER SCHEMA "${enumeratedWorker}" RENAME TO "${renamedWorker}"`,
        );
        await attackerClient.query('COMMIT');
        attackerInTransaction = false;
        await teardownSettled;

        // Teardown resolved WITHOUT any refusal: the renamed schema was
        // cleaned under its new name, the anchor was cleaned, and the
        // foreign schema is untouched.
        expect(teardownError).toBeNull();
        expect(await schemaExists(`moeen_test_${runId}`)).toBe(false);
        expect(await schemaExists(`moeen_test_${runId}_w1`)).toBe(false);
        expect(await schemaExists(enumeratedWorker)).toBe(false);
        expect(await schemaExists(renamedWorker)).toBe(false);
        expect(await schemaExists(foreignBare)).toBe(true);
      } finally {
        // Unblock and settle the concurrent teardown BEFORE exact-name
        // cleanup. This runs even when the wait assertion or rename fails, so
        // no idle transaction can poison later tests or make cleanup deadlock.
        if (attackerInTransaction) {
          await attackerClient.query('ROLLBACK').catch(() => undefined);
          attackerInTransaction = false;
        }
        if (teardownSettled) {
          await teardownSettled.catch(() => undefined);
        }
        attackerClient.release();
        try {
          // Best-effort exact-name cleanup of EVERY schema this test created:
          // one failed drop must not skip the remaining owned/foreign names.
          const cleanup = await Promise.allSettled([
            dropFabricated(`moeen_test_${runId}`),
            dropFabricated(`moeen_test_${runId}_w1`),
            dropFabricated(enumeratedWorker),
            dropFabricated(renamedWorker),
            dropFabricated(foreignBare),
          ]);
          const failed = cleanup.find(
            (result): result is PromiseRejectedResult =>
              result.status === 'rejected',
          );
          if (failed) {
            await Promise.reject(
              failed.reason instanceof Error
                ? failed.reason
                : new Error('schema cleanup failed'),
            );
          }
        } finally {
          await pool.end();
        }
      }
    });

    it('fails closed on AMBIGUOUS ownership during marker-identity discovery (non-unique marker)', async () => {
      // A schema whose marker table cannot prove unique ownership — here a
      // manually-built marker table WITHOUT the DB-level singleton index
      // holding two rows — must never be deleted and must fail the run: the
      // discovery-level classification treats it as ambiguous ownership and
      // refuses, while the run anchor is still cleaned.
      const runId = generateTestRunId();
      const token = generateOwnerToken();
      const ambiguous = `q0sec_ambiguous_${runId}`;
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      try {
        await createOwnedSchema(
          pool,
          `moeen_test_${runId}`,
          runId,
          ownerTokenHash(token),
        );
        await pool.query(`CREATE SCHEMA "${ambiguous}"`);
        await pool.query(
          `CREATE TABLE ${qualifiedMarkerTable(ambiguous)} (
             run_id TEXT NOT NULL,
             owner_token_hash TEXT NOT NULL,
             created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
           )`,
        );
        await pool.query(
          `INSERT INTO ${qualifiedMarkerTable(ambiguous)} (run_id, owner_token_hash)
           VALUES ($1, $2)`,
          [runId, ownerTokenHash(token)],
        );
        await pool.query(
          `INSERT INTO ${qualifiedMarkerTable(ambiguous)} (run_id, owner_token_hash)
           VALUES ($1, $2)`,
          [runId, ownerTokenHash(token)],
        );
        await withFakeRun(runId, token, async () => {
          await expect(globalTeardown()).rejects.toThrow(
            new RegExp(
              `refused to drop [0-9]+ schema[(]s[)] not owned by this run: .*${ambiguous} [(].*ownership marker is not unique`,
            ),
          );
        });
        // Fail-closed: the ambiguous schema was preserved, while the owned
        // run anchor was still cleaned (cleanup continues past the refused
        // candidate).
        expect(await schemaExists(ambiguous)).toBe(true);
        expect(await schemaExists(`moeen_test_${runId}`)).toBe(false);
      } finally {
        // Exact-name cleanup of EVERY schema this test created, regardless of
        // where it failed.
        await dropFabricated(`moeen_test_${runId}`);
        await dropFabricated(ambiguous);
        await pool.end();
      }
    });
  });

  describe('global setup fail-after-commit rollback (P2)', () => {
    jest.setTimeout(60_000);
    const baseUrl = assertTestDatabaseUrl(process.env);

    async function schemaExists(name: string): Promise<boolean> {
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      try {
        const res = await pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1',
          [name],
        );
        return res.rows[0]?.n === 1;
      } finally {
        await pool.end();
      }
    }

    async function dropFabricated(name: string): Promise<void> {
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      try {
        await pool.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
      } finally {
        await pool.end();
      }
    }

    it('rolls back the run schema if globalSetup fails after createOwnedSchema commits', async () => {
      jest.resetModules();
      const runId = generateTestRunId();
      const token = generateOwnerToken();
      const schema = `moeen_test_${runId}`;
      const previous = {
        [TEST_RUN_ID_ENV]: process.env[TEST_RUN_ID_ENV],
        [TEST_OWNER_TOKEN_ENV]: process.env[TEST_OWNER_TOKEN_ENV],
        TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
      };

      process.env[TEST_RUN_ID_ENV] = runId;
      process.env[TEST_OWNER_TOKEN_ENV] = token;
      process.env.TEST_DATABASE_URL = baseUrl;

      // Fault injection: we need a failure AFTER createOwnedSchema has returned
      // and globalSetup has recorded schemaCommitted=true. Patching
      // createOwnedSchema itself does not work because the throw prevents
      // globalSetup from flipping the flag. Instead, we reset Jest's module
      // cache, then patch Pool.prototype.query so the FIRST query issued after
      // createOwnedSchema commits (the worker-isolation coordination table
      // CREATE TABLE) throws. globalSetup's fail-after-commit handler must then
      // roll the schema back.
      const FreshPool = jest.requireActual<typeof import('pg')>('pg').Pool;
      const ownership = jest.requireActual<
        typeof import('../test/setup/ownership')
      >('../test/setup/ownership');
      const originalPoolQuery: unknown = Reflect.get(
        FreshPool.prototype,
        'query',
      );
      if (typeof originalPoolQuery !== 'function') {
        throw new Error('pg Pool.prototype.query is not callable');
      }
      const originalCreateOwnedSchema = ownership.createOwnedSchema;
      let createCommitted = false;
      ownership.createOwnedSchema = jest.fn(
        async (...args: Parameters<typeof originalCreateOwnedSchema>) => {
          await originalCreateOwnedSchema(...args);
          createCommitted = true;
        },
      ) as typeof originalCreateOwnedSchema;
      FreshPool.prototype.query = jest.fn(function (
        this: Pool,
        sql: string | { text: string },
        ...rest: unknown[]
      ): Promise<unknown> {
        const text = typeof sql === 'string' ? sql : sql.text;
        if (createCommitted && text.includes('q0sec_worker_isolation')) {
          return Promise.reject(new Error('injected after-commit failure'));
        }
        const result: unknown = Reflect.apply(originalPoolQuery, this, [
          sql,
          ...rest,
        ]);
        return Promise.resolve(result);
      }) as unknown as typeof FreshPool.prototype.query;

      try {
        const globalSetup = jest.requireActual<
          typeof import('../test/setup/global-setup')
        >('../test/setup/global-setup').default;
        await expect(globalSetup()).rejects.toThrow(
          /injected after-commit failure/,
        );
        expect(createCommitted).toBe(true);
        // The fail-after-commit handler must have rolled the schema back.
        expect(await schemaExists(schema)).toBe(false);
      } finally {
        ownership.createOwnedSchema = originalCreateOwnedSchema;
        FreshPool.prototype.query =
          originalPoolQuery as typeof FreshPool.prototype.query;
        process.env[TEST_RUN_ID_ENV] = previous[TEST_RUN_ID_ENV];
        process.env[TEST_OWNER_TOKEN_ENV] = previous[TEST_OWNER_TOKEN_ENV];
        process.env.TEST_DATABASE_URL = previous.TEST_DATABASE_URL;
        await dropFabricated(schema);
      }
    });

    it('reconciles an AMBIGUOUS post-COMMIT failure where the transaction actually committed (no owned run-schema leak)', async () => {
      // Finding regression: an error returned while COMMIT is being processed
      // is ambiguous — PostgreSQL may have committed even though the client
      // received an error. The cleanup path must NOT assume that a failed
      // COMMIT response proves rollback and skip cleanup of a schema that
      // actually committed.
      //
      // Deterministic simulation: the REAL createOwnedSchema runs to
      // completion, so its transaction REALLY commits server-side (the schema
      // and its ownership marker genuinely exist), and the client-side call
      // then rejects — exactly what a lost/errored COMMIT acknowledgement
      // looks like. globalSetup's reconciliation must locate the committed
      // schema, prove ownership via its marker and clean it up; nothing may
      // leak and no foreign schema may be touched.
      jest.resetModules();
      const runId = generateTestRunId();
      const token = generateOwnerToken();
      const schema = `moeen_test_${runId}`;
      const previous = {
        [TEST_RUN_ID_ENV]: process.env[TEST_RUN_ID_ENV],
        [TEST_OWNER_TOKEN_ENV]: process.env[TEST_OWNER_TOKEN_ENV],
        TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
      };

      process.env[TEST_RUN_ID_ENV] = runId;
      process.env[TEST_OWNER_TOKEN_ENV] = token;
      process.env.TEST_DATABASE_URL = baseUrl;

      const ownership = jest.requireActual<
        typeof import('../test/setup/ownership')
      >('../test/setup/ownership');
      const originalCreateOwnedSchema = ownership.createOwnedSchema;
      ownership.createOwnedSchema = jest.fn(
        async (...args: Parameters<typeof originalCreateOwnedSchema>) => {
          // The real creation + COMMIT runs against the real database — the
          // schema IS committed — then the client-side call fails.
          await originalCreateOwnedSchema(...args);
          throw new Error('injected ambiguous post-COMMIT failure');
        },
      ) as typeof originalCreateOwnedSchema;

      const stdoutSpy = jest
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);
      try {
        const globalSetup = jest.requireActual<
          typeof import('../test/setup/global-setup')
        >('../test/setup/global-setup').default;
        await expect(globalSetup()).rejects.toThrow(
          /injected ambiguous post-COMMIT failure/,
        );
        // The reconciliation must have located and cleaned the committed
        // schema: NO owned run-schema leak may remain.
        expect(await schemaExists(schema)).toBe(false);
        const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
        expect(written).toContain(
          'cleaned up potentially-committed run schema',
        );
        expect(written).not.toContain('CRITICAL');
      } finally {
        stdoutSpy.mockRestore();
        ownership.createOwnedSchema = originalCreateOwnedSchema;
        process.env[TEST_RUN_ID_ENV] = previous[TEST_RUN_ID_ENV];
        process.env[TEST_OWNER_TOKEN_ENV] = previous[TEST_OWNER_TOKEN_ENV];
        process.env.TEST_DATABASE_URL = previous.TEST_DATABASE_URL;
        await dropFabricated(schema);
      }
    });

    it('reconciles a committed run schema RENAMED before the ambiguous-COMMIT probe (durable marker identity)', async () => {
      // MEDIUM final-review finding regression: the ambiguous-COMMIT
      // reconciliation probed ONLY the canonical mutable schema name, so a
      // committed owned run schema renamed before the probe was mistaken for
      // rollback and silently leaked (Jest skips teardown when globalSetup
      // throws). Reconciliation now ALSO searches by DURABLE marker identity
      // (run id + owner-token hash — a random 256-bit capability only this
      // run's createOwnedSchema writes — classified by the namespace OID):
      // the renamed committed schema is found under its new name and cleaned
      // through the same atomic routine; foreign schemas remain untouched.
      //
      // Deterministic: the real creation COMMITS the schema at the canonical
      // name, the test then RENAMES it (a committed owned schema that no
      // longer matches the canonical probe), and only then does globalSetup
      // fail (injected ambiguous COMMIT error) and reconcile.
      jest.resetModules();
      const runId = generateTestRunId();
      const token = generateOwnerToken();
      const schema = `moeen_test_${runId}`;
      const renamed = `q0sec_reconciled_renamed_${runId}`;
      const foreign = `q0sec_reconciled_foreign_${generateTestRunId()}`;
      const previous = {
        [TEST_RUN_ID_ENV]: process.env[TEST_RUN_ID_ENV],
        [TEST_OWNER_TOKEN_ENV]: process.env[TEST_OWNER_TOKEN_ENV],
        TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
      };

      process.env[TEST_RUN_ID_ENV] = runId;
      process.env[TEST_OWNER_TOKEN_ENV] = token;
      process.env.TEST_DATABASE_URL = baseUrl;

      const pool = new Pool({ connectionString: baseUrl });
      try {
        // The committed owned run schema, then RENAMED before the
        // reconciliation — under its new name it is invisible to the
        // canonical-name probe.
        await createOwnedSchema(pool, schema, runId, ownerTokenHash(token));
        await pool.query(`ALTER SCHEMA "${schema}" RENAME TO "${renamed}"`);
        // A foreign marker-bearing schema (another run's shape) that must
        // remain untouched.
        await createOwnedSchema(
          pool,
          foreign,
          generateTestRunId(),
          ownerTokenHash(generateOwnerToken()),
        );

        // globalSetup's createOwnedSchema fails with the simulated ambiguous
        // COMMIT error; the reconciliation must settle it by identity.
        const ownership = jest.requireActual<
          typeof import('../test/setup/ownership')
        >('../test/setup/ownership');
        const originalCreateOwnedSchema = ownership.createOwnedSchema;
        ownership.createOwnedSchema = jest
          .fn<
            ReturnType<typeof originalCreateOwnedSchema>,
            Parameters<typeof originalCreateOwnedSchema>
          >()
          .mockRejectedValue(
            new Error(
              'injected ambiguous COMMIT failure (renamed committed schema)',
            ),
          );

        const stdoutSpy = jest
          .spyOn(process.stdout, 'write')
          .mockImplementation(() => true);
        try {
          const globalSetup = jest.requireActual<
            typeof import('../test/setup/global-setup')
          >('../test/setup/global-setup').default;
          await expect(globalSetup()).rejects.toThrow(
            /injected ambiguous COMMIT failure \(renamed committed schema\)/,
          );
          // The renamed committed schema was found by durable identity and
          // cleaned — under BOTH names nothing remains.
          expect(await schemaExists(schema)).toBe(false);
          expect(await schemaExists(renamed)).toBe(false);
          const written = stdoutSpy.mock.calls
            .map((c) => String(c[0]))
            .join('');
          expect(written).toContain(
            'cleaned up potentially-committed run schema',
          );
          expect(written).not.toContain('CRITICAL');
          // The foreign schema is untouched.
          expect(await schemaExists(foreign)).toBe(true);
        } finally {
          stdoutSpy.mockRestore();
          ownership.createOwnedSchema = originalCreateOwnedSchema;
        }
      } finally {
        process.env[TEST_RUN_ID_ENV] = previous[TEST_RUN_ID_ENV];
        process.env[TEST_OWNER_TOKEN_ENV] = previous[TEST_OWNER_TOKEN_ENV];
        process.env.TEST_DATABASE_URL = previous.TEST_DATABASE_URL;
        await dropFabricated(schema);
        await dropFabricated(renamed);
        await dropFabricated(foreign);
        await pool.end();
      }
    });

    it('does NOT fabricate cleanup or refusal when an ambiguous COMMIT failure left NO committed schema', async () => {
      // The counterpart of the committed case: the failure is ambiguous, but
      // the transaction actually did NOT commit (the rollback completed or
      // nothing was ever created). The reconciliation must detect that
      // nothing exists, clean nothing, refuse nothing, and let the original
      // error propagate unchanged.
      jest.resetModules();
      const runId = generateTestRunId();
      const token = generateOwnerToken();
      const schema = `moeen_test_${runId}`;
      const previous = {
        [TEST_RUN_ID_ENV]: process.env[TEST_RUN_ID_ENV],
        [TEST_OWNER_TOKEN_ENV]: process.env[TEST_OWNER_TOKEN_ENV],
        TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
      };

      process.env[TEST_RUN_ID_ENV] = runId;
      process.env[TEST_OWNER_TOKEN_ENV] = token;
      process.env.TEST_DATABASE_URL = baseUrl;

      const ownership = jest.requireActual<
        typeof import('../test/setup/ownership')
      >('../test/setup/ownership');
      const originalCreateOwnedSchema = ownership.createOwnedSchema;
      ownership.createOwnedSchema = jest
        .fn<
          ReturnType<typeof originalCreateOwnedSchema>,
          Parameters<typeof originalCreateOwnedSchema>
        >()
        .mockRejectedValue(
          new Error('injected ambiguous COMMIT failure (not committed)'),
        );

      const stdoutSpy = jest
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);
      try {
        const globalSetup = jest.requireActual<
          typeof import('../test/setup/global-setup')
        >('../test/setup/global-setup').default;
        await expect(globalSetup()).rejects.toThrow(
          /injected ambiguous COMMIT failure \(not committed\)/,
        );
        expect(await schemaExists(schema)).toBe(false);
        const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
        // No cleanup happened (nothing to clean) and no explicit refusal was
        // surfaced (nothing was committed).
        expect(written).not.toContain(
          'cleaned up potentially-committed run schema',
        );
        expect(written).not.toContain('CRITICAL');
      } finally {
        stdoutSpy.mockRestore();
        ownership.createOwnedSchema = originalCreateOwnedSchema;
        process.env[TEST_RUN_ID_ENV] = previous[TEST_RUN_ID_ENV];
        process.env[TEST_OWNER_TOKEN_ENV] = previous[TEST_OWNER_TOKEN_ENV];
        process.env.TEST_DATABASE_URL = previous.TEST_DATABASE_URL;
        await dropFabricated(schema);
      }
    });

    it('refuses (never touches) a FOREIGN schema found under the run name during ambiguous-COMMIT reconciliation', async () => {
      // The "without touching foreign schemas" half of the fail-closed
      // protocol: a schema that exists under this run's canonical name but
      // whose ownership marker names a DIFFERENT run is deterministically
      // foreign. The reconciliation must refuse explicitly, leave it in
      // place, and surface BOTH the original failure and the cleanup refusal.
      jest.resetModules();
      const runId = generateTestRunId();
      const token = generateOwnerToken();
      const schema = `moeen_test_${runId}`;
      const previous = {
        [TEST_RUN_ID_ENV]: process.env[TEST_RUN_ID_ENV],
        [TEST_OWNER_TOKEN_ENV]: process.env[TEST_OWNER_TOKEN_ENV],
        TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
      };

      // A foreign schema already occupies the run's canonical name, carrying
      // an ownership marker that names a DIFFERENT run.
      const pool = new Pool({ connectionString: baseUrl });
      try {
        await pool.query(`CREATE SCHEMA "${schema}"`);
        await pool.query(
          `CREATE TABLE ${qualifiedMarkerTable(schema)} (
             run_id TEXT NOT NULL,
             owner_token_hash TEXT NOT NULL,
             created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
           )`,
        );
        await pool.query(
          `INSERT INTO ${qualifiedMarkerTable(schema)} (run_id, owner_token_hash)
           VALUES ($1, $2)`,
          [generateTestRunId(), ownerTokenHash(generateOwnerToken())],
        );
      } finally {
        await pool.end();
      }

      process.env[TEST_RUN_ID_ENV] = runId;
      process.env[TEST_OWNER_TOKEN_ENV] = token;
      process.env.TEST_DATABASE_URL = baseUrl;

      const ownership = jest.requireActual<
        typeof import('../test/setup/ownership')
      >('../test/setup/ownership');
      const originalCreateOwnedSchema = ownership.createOwnedSchema;
      // createOwnedSchema would fail on the pre-existing foreign schema
      // (duplicate_schema 42P06); simulate the failure as the ambiguous
      // COMMIT-style error globalSetup must reconcile.
      ownership.createOwnedSchema = jest
        .fn<
          ReturnType<typeof originalCreateOwnedSchema>,
          Parameters<typeof originalCreateOwnedSchema>
        >()
        .mockRejectedValue(new Error('injected ambiguous COMMIT failure'));

      try {
        const globalSetup = jest.requireActual<
          typeof import('../test/setup/global-setup')
        >('../test/setup/global-setup').default;
        const error = await globalSetup().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(Error);
        const message = (error as Error).message;
        // Explicit refusal: the reconciliation surfaced the ambiguity, the
        // cleanup refusal and the original failure.
        expect(message).toMatch(/CRITICAL/);
        expect(message).toMatch(/must be removed manually/);
        expect(message).toMatch(/injected ambiguous COMMIT failure/);
        expect(message).toMatch(/ownership marker does not match this run/);
        // The FOREIGN schema was never touched: it still exists untouched.
        expect(await schemaExists(schema)).toBe(true);
      } finally {
        ownership.createOwnedSchema = originalCreateOwnedSchema;
        process.env[TEST_RUN_ID_ENV] = previous[TEST_RUN_ID_ENV];
        process.env[TEST_OWNER_TOKEN_ENV] = previous[TEST_OWNER_TOKEN_ENV];
        process.env.TEST_DATABASE_URL = previous.TEST_DATABASE_URL;
        await dropFabricated(schema);
      }
    });
  });

  describe('ownership transaction + singleton guarantees (P2)', () => {
    // These tests create/drop real schemas and transactions; under full-suite
    // load the default 5s jest timeout is too tight.
    jest.setTimeout(60_000);
    const baseUrl = assertTestDatabaseUrl(process.env);

    async function schemaExists(name: string): Promise<boolean> {
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      try {
        const res = await pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1',
          [name],
        );
        return res.rows[0]?.n === 1;
      } finally {
        await pool.end();
      }
    }

    async function dropFabricated(name: string): Promise<void> {
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      try {
        await pool.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
      } finally {
        await pool.end();
      }
    }

    it('createOwnedSchema leaves NO schema when the marker insert fails mid-transaction', async () => {
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      const runId = generateTestRunId();
      const token = generateOwnerToken();
      const schema = `moeen_test_${runId}`;
      const real = await pool.connect();
      try {
        // Fault injection: the INSERT (last step) fails, AFTER the CREATE
        // SCHEMA and CREATE TABLE have already executed against the real DB.
        // The whole transaction must ROLLBACK — no schema may remain.
        const injected = new Error('injected marker insert failure');
        const stubClient = {
          query: async (sql: string, params?: unknown[]) => {
            if (sql.trim().startsWith('INSERT INTO')) throw injected;
            return real.query(sql, params as never[]);
          },
          release: () => {
            // The real client is released by createOwnedSchema on the ROLLBACK
            // path; this stub must not release it again.
          },
        };
        const stubPool = {
          connect: () => Promise.resolve(stubClient),
        } as unknown as Pool;
        await expect(
          createOwnedSchema(stubPool, schema, runId, ownerTokenHash(token)),
        ).rejects.toThrow('injected marker insert failure');
        // The transaction rolled back: no schema, no marker table, no rows.
        expect(await schemaExists(schema)).toBe(false);
        const ns = await pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1',
          [schema],
        );
        expect(ns.rows[0].n).toBe(0);
      } finally {
        real.release();
        await pool.end();
      }
    });

    it('createOwnedSchema discards the pooled client when rollback fails', async () => {
      const operationError = new Error('injected schema creation failure');
      const rollbackError = new Error('injected rollback failure');
      const releases: Array<Error | boolean | undefined> = [];
      const stubClient = {
        query: (sql: string) => {
          if (sql === 'BEGIN') return Promise.resolve({ rows: [] });
          if (sql.startsWith('CREATE SCHEMA')) {
            return Promise.reject(operationError);
          }
          if (sql === 'ROLLBACK') return Promise.reject(rollbackError);
          return Promise.reject(new Error(`unexpected query: ${sql}`));
        },
        release: (error?: Error | boolean) => {
          releases.push(error);
        },
      };
      const stubPool = {
        connect: () => Promise.resolve(stubClient),
      } as unknown as Pool;

      const caught = await createOwnedSchema(
        stubPool,
        `moeen_test_${generateTestRunId()}`,
        generateTestRunId(),
        ownerTokenHash(generateOwnerToken()),
      ).catch((error: unknown) => error);

      // The operation error stays primary, while the rollback failure remains
      // available as diagnostic context and is passed to pg's unhealthy
      // release path so the connection is destroyed instead of pooled.
      expect(caught).toBe(operationError);
      expect((caught as Error).cause).toBe(rollbackError);
      expect(releases).toEqual([rollbackError]);
    });

    it.each([
      {
        name: 'dropOwnedSchemaAtomically',
        invoke: (client: PoolClient) =>
          dropOwnedSchemaAtomically(
            client,
            `moeen_test_${generateTestRunId()}`,
            generateTestRunId(),
            ownerTokenHash(generateOwnerToken()),
          ),
      },
      {
        name: 'classifyOwnedSchemaByOid',
        invoke: (client: PoolClient) =>
          classifyOwnedSchemaByOid(client, 1, 2).then(() => undefined),
      },
    ])(
      '$name discards the pooled client when rollback fails',
      async ({ invoke }) => {
        const operationError = new Error(
          'injected ownership operation failure',
        );
        const rollbackError = new Error('injected ownership rollback failure');
        const releases: Array<Error | boolean | undefined> = [];
        let began = false;
        const stubClient = {
          query: (sql: string) => {
            if (sql === 'BEGIN') {
              began = true;
              return Promise.resolve({ rows: [] });
            }
            if (sql === 'ROLLBACK') return Promise.reject(rollbackError);
            return Promise.reject(operationError);
          },
          release: (error?: Error | boolean) => {
            releases.push(error);
          },
        } as unknown as PoolClient;

        const caught = await invoke(stubClient).catch(
          (error: unknown) => error,
        );

        expect(began).toBe(true);
        expect(caught).toBe(operationError);
        expect((caught as Error).cause).toBe(rollbackError);
        expect(releases).toEqual([rollbackError]);
        expect(isOwnershipClientDiscarded(stubClient)).toBe(true);
        releaseOwnershipClient(stubClient);
        expect(releases).toEqual([rollbackError]);
      },
    );

    it('the ownership marker is a DB-level singleton — a second row is rejected', async () => {
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      const runId = generateTestRunId();
      const token = generateOwnerToken();
      const schema = `moeen_test_${runId}`;
      try {
        await createOwnedSchema(pool, schema, runId, ownerTokenHash(token));
        await expect(
          pool.query(
            `INSERT INTO ${qualifiedMarkerTable(schema)} (run_id, owner_token_hash)
             VALUES ($1, $2)`,
            [generateTestRunId(), ownerTokenHash(generateOwnerToken())],
          ),
        ).rejects.toThrow(/duplicate key/);
        const m = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${qualifiedMarkerTable(schema)}`,
        );
        expect(m.rows[0].n).toBe(1);
      } finally {
        await dropFabricated(schema);
        await pool.end();
      }
    });

    it('dropOwnedSchemaAtomically refuses a marker table with MORE than one row', async () => {
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      const runId = generateTestRunId();
      const token = generateOwnerToken();
      const schema = `moeen_test_${runId}`;
      try {
        // A foreign/legacy-style marker table WITHOUT the DB-level singleton
        // index, holding two matching rows: ownership is not unique, so the
        // drop must be refused regardless of the row contents.
        await pool.query(`CREATE SCHEMA "${schema}"`);
        await pool.query(
          `CREATE TABLE ${qualifiedMarkerTable(schema)} (
             run_id TEXT NOT NULL,
             owner_token_hash TEXT NOT NULL,
             created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
           )`,
        );
        await pool.query(
          `INSERT INTO ${qualifiedMarkerTable(schema)} (run_id, owner_token_hash)
           VALUES ($1, $2)`,
          [runId, ownerTokenHash(token)],
        );
        await pool.query(
          `INSERT INTO ${qualifiedMarkerTable(schema)} (run_id, owner_token_hash)
           VALUES ($1, $2)`,
          [runId, ownerTokenHash(token)],
        );
        const client = await pool.connect();
        try {
          await expect(
            dropOwnedSchemaAtomically(
              client,
              schema,
              runId,
              ownerTokenHash(token),
            ),
          ).rejects.toThrow(/ownership marker is missing or unreadable/);
        } finally {
          client.release();
        }
        expect(await schemaExists(schema)).toBe(true);
      } finally {
        await dropFabricated(schema);
        await pool.end();
      }
    });

    it('the per-worker reuse check refuses a marker table with MORE than one row', async () => {
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      const runId = generateTestRunId();
      const token = generateOwnerToken();
      const workerSchema = workerSchemaName(runId, '1');
      const saved: Record<string, string | undefined> = {
        [TEST_RUN_ID_ENV]: process.env[TEST_RUN_ID_ENV],
        [TEST_OWNER_TOKEN_ENV]: process.env[TEST_OWNER_TOKEN_ENV],
        TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
        JEST_WORKER_ID: process.env.JEST_WORKER_ID,
      };

      try {
        await pool.query(`CREATE SCHEMA "${workerSchema}"`);
        await pool.query(
          `CREATE TABLE ${qualifiedMarkerTable(workerSchema)} (
             run_id TEXT NOT NULL,
             owner_token_hash TEXT NOT NULL,
             created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
           )`,
        );
        await pool.query(
          `INSERT INTO ${qualifiedMarkerTable(workerSchema)} (run_id, owner_token_hash)
           VALUES ($1, $2)`,
          [runId, ownerTokenHash(token)],
        );
        await pool.query(
          `INSERT INTO ${qualifiedMarkerTable(workerSchema)} (run_id, owner_token_hash)
           VALUES ($1, $2)`,
          [runId, ownerTokenHash(token)],
        );
        process.env[TEST_RUN_ID_ENV] = runId;
        process.env[TEST_OWNER_TOKEN_ENV] = token;
        process.env.TEST_DATABASE_URL = withRunSchema(baseUrl, runId);
        process.env.JEST_WORKER_ID = '1';
        // The reuse path must NOT adopt the multi-row schema: the original
        // CREATE error is rethrown (fail-closed).
        await expect(setupTestEnv()).rejects.toThrow(/already exists/);
        expect(await schemaExists(workerSchema)).toBe(true);
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        await dropFabricated(workerSchema);
        await pool.end();
      }
    });

    it('a non-42P06 create error is rethrown BEFORE marker-based reuse (fail-closed)', async () => {
      // Finding A regression: ONLY the PostgreSQL duplicate_schema SQLSTATE
      // (42P06) may enter the marker-based reuse path. Any other
      // createOwnedSchema error — here a permission failure (42501) — must
      // propagate immediately, even when a valid, matching ownership marker
      // exists inside the worker schema (which reuse would otherwise adopt).
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      const runId = generateTestRunId();
      const token = generateOwnerToken();
      const workerSchema = workerSchemaName(runId, '1');
      const saved: Record<string, string | undefined> = {
        [TEST_RUN_ID_ENV]: process.env[TEST_RUN_ID_ENV],
        [TEST_OWNER_TOKEN_ENV]: process.env[TEST_OWNER_TOKEN_ENV],
        TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
        JEST_WORKER_ID: process.env.JEST_WORKER_ID,
      };
      const createSpy = jest
        .spyOn(ownershipModule, 'createOwnedSchema')
        .mockRejectedValue(
          Object.assign(new Error('permission denied for schema'), {
            code: '42501',
          }),
        );
      const markerTableSpy = jest.spyOn(
        ownershipModule,
        'qualifiedMarkerTable',
      );
      try {
        // A pre-existing worker schema WITH a single matching marker row:
        // the reuse path WOULD adopt it — under the buggy behaviour the call
        // resolves instead of throwing.
        await pool.query(`CREATE SCHEMA "${workerSchema}"`);
        await pool.query(
          `CREATE TABLE ${qualifiedMarkerTable(workerSchema)} (
             run_id TEXT NOT NULL,
             owner_token_hash TEXT NOT NULL,
             created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
           )`,
        );
        await pool.query(
          `INSERT INTO ${qualifiedMarkerTable(workerSchema)} (run_id, owner_token_hash)
           VALUES ($1, $2)`,
          [runId, ownerTokenHash(token)],
        );
        process.env[TEST_RUN_ID_ENV] = runId;
        process.env[TEST_OWNER_TOKEN_ENV] = token;
        process.env.TEST_DATABASE_URL = withRunSchema(baseUrl, runId);
        process.env.JEST_WORKER_ID = '1';
        // The permission error must propagate — and the marker-based reuse
        // logic must never even be reached.
        markerTableSpy.mockClear();
        await expect(setupTestEnv()).rejects.toThrow(
          /permission denied for schema/,
        );
        expect(markerTableSpy).not.toHaveBeenCalled();
        // Fail-closed: the schema is NOT adopted; it stays untouched.
        expect(await schemaExists(workerSchema)).toBe(true);
      } finally {
        createSpy.mockRestore();
        markerTableSpy.mockRestore();
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        await dropFabricated(workerSchema);
        await pool.end();
      }
    });

    it('reuses a duplicate worker schema ONLY when the marker matches exactly', async () => {
      // The legitimate duplicate-schema reuse case: a later setupFiles
      // invocation in the same worker finds the schema already created (real
      // 42P06 from CREATE SCHEMA) and adopts it ONLY after the singleton
      // marker inside it matches this run's id + owner-token hash.
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      const runId = generateTestRunId();
      const token = generateOwnerToken();
      const workerSchema = workerSchemaName(runId, '1');
      const saved: Record<string, string | undefined> = {
        [TEST_RUN_ID_ENV]: process.env[TEST_RUN_ID_ENV],
        [TEST_OWNER_TOKEN_ENV]: process.env[TEST_OWNER_TOKEN_ENV],
        TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
        JEST_WORKER_ID: process.env.JEST_WORKER_ID,
      };
      try {
        // Pre-existing schema with the EXACT matching marker (as if created
        // by the first setupFiles invocation of this worker).
        await createOwnedSchema(
          pool,
          workerSchema,
          runId,
          ownerTokenHash(token),
        );
        process.env[TEST_RUN_ID_ENV] = runId;
        process.env[TEST_OWNER_TOKEN_ENV] = token;
        process.env.TEST_DATABASE_URL = withRunSchema(baseUrl, runId);
        process.env.JEST_WORKER_ID = '1';
        // The real CREATE SCHEMA fails with 42P06 and the matching marker
        // proves ownership: the hook succeeds and adopts the schema.
        await expect(setupTestEnv()).resolves.toBeUndefined();
        // The run URL was rewritten to THIS worker's schema (setup succeeded).
        expect(process.env.TEST_DATABASE_URL).toBe(
          withWorkerSchema(withRunSchema(baseUrl, runId), runId, '1'),
        );
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        await dropFabricated(workerSchema);
        await pool.end();
      }
    });
  });
});

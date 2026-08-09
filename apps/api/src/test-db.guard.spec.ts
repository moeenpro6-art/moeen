import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { parse as parsePgConnectionString } from 'pg-connection-string';
import {
  TEST_SCHEMA_PATTERN,
  TEST_RUN_ID_MAX_LENGTH,
  TestDatabaseGuardError,
  assertTestDatabaseUrl,
  buildCanonicalUrl,
  extractSearchPath,
  generateOwnerToken,
  generateTestRunId,
  ownerTokenHash,
  parseEffectiveConnection,
  runSchemaName,
  validateOwnerToken,
  validateTestRunId,
  withRunSchema,
} from './test-db.guard';

const LOCAL_TEST_URL =
  'postgresql://moeen_app:local-password@localhost:5433/moeen_test?options=-c%20search_path%3Dmoeen_test';

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
      'postgresql://moeen_app:***@localhost:5433/moeen?options=-c%20search_path%3Dmoeen_test';
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
          TEST_DATABASE_URL: 'postgresql://moeen_app:pw@localhost:5433/moeen',
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
      'postgresql://moeen_app:pw@localhost:5433/moeen_test';
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
      'postgresql://moeen_app:pw@localhost:5433/moeen_test?options=-c%20search_path%3Dmoeen_test';
    expect(() =>
      assertTestDatabaseUrl(env({ TEST_DATABASE_URL: url, DATABASE_URL: url })),
    ).toThrow(/matches DATABASE_URL/);
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
        const url = `postgresql://moeen_app:pw@localhost:5433/${database}?options=-c%20search_path%3Dmoeen_test`;
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
              'postgresql://moeen_app:pw@localhost:5433/analytics?options=-c%20search_path%3Dmoeen_test',
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
            'postgresql://moeen_app:pw@localhost:5432/moeen_test?options=-c%20search_path%3Dmoeen_test',
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
        const base = 'postgresql://moeen_app:pw@localhost:5433/moeen_test';
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
        'postgresql://moeen_app:pw@localhost:5433/moeen_test?options=-c%20search_path%3Dmoeen_test_abc123';
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
            'postgresql://moeen_app:pw@localhost:5433/moeen_test?options=-c%20search_path%3Dmoeen_test_abc123',
          ),
        ),
      ).toBe('moeen_test_abc123');
    });

    it('returns null when no options/search_path is present', () => {
      expect(
        extractSearchPath(
          new URL('postgresql://moeen_app:pw@localhost:5433/moeen_test'),
        ),
      ).toBeNull();
      expect(
        extractSearchPath(
          new URL(
            'postgresql://moeen_app:pw@localhost:5433/moeen_test?sslmode=require',
          ),
        ),
      ).toBeNull();
    });
  });

  describe('run-scoped schemas', () => {
    it('workers inherit the run-specific TEST_DATABASE_URL prepared by the shim', () => {
      const runId = process.env.MOEEN_TEST_RUN_ID;
      expect(runId).toBeTruthy();
      const searchPath = extractSearchPath(
        new URL(process.env.TEST_DATABASE_URL as string),
      );
      expect(searchPath).toBe(runSchemaName(runId as string));
      expect(searchPath).toMatch(/^moeen_test_[a-z0-9]{4,64}$/);
      console.log(`[test-db] worker schema: ${searchPath}`);
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
      const url = `postgresql://moeen_app:${PASSWORD}@localhost:5433/moeen_test?options=-c%20search_path%3Dmoeen_test`;
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
        `postgresql://moeen_app:${PASSWORD}@localhost:5433/q0secretdb`,
        // search_path refusal with a sensitive query string
        `postgresql://moeen_app:${PASSWORD}@localhost:5433/moeen_test?token=${TOKEN}&options=${encodeURIComponent(
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
    const BASE = 'postgresql://moeen_app:pw@localhost:5433/moeen_test';

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
              'postgres://moeen_app:pw@localhost:5433/moeen_test?' +
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
        'postgresql://moeen_app:pw@localhost:5433/moeen_test?options=-c%20search_path%3Dmoeen_test';
      expect(assertTestDatabaseUrl(env({ TEST_DATABASE_URL: url }))).toBe(
        'postgresql://moeen_app:pw@localhost:5433/moeen_test?options=-c%20search_path%3Dmoeen_test',
      );
      expect(buildCanonicalUrl(parseEffectiveConnection(url))).toBe(
        'postgresql://moeen_app:pw@localhost:5433/moeen_test?options=-c%20search_path%3Dmoeen_test',
      );
    });

    it('matches the connection settings pg actually interprets', () => {
      // Parity with node-postgres' own parser: for every accepted URL, the
      // guard's effective fields equal what pg-connection-string resolves.
      const urls = [
        'postgresql://moeen_app:pw@localhost:5433/moeen_test?options=-c%20search_path%3Dmoeen_test',
        'postgresql://moeen_app:pw@localhost:5433/moeen?options=-c%20search_path%3Dmoeen_test',
        'postgresql://moeen_app:pw@localhost:5433/moeen_test?options=-c+search_path%3Dmoeen_test_abc123',
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
      // moeen_test_ (10) + '_' (1) + runId <= 63 bytes.
      expect(runSchemaName('a'.repeat(TEST_RUN_ID_MAX_LENGTH))).toHaveLength(
        63,
      );
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
});

import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  defaultMigrationsDirectory,
  loadMigrations,
  runDatabaseMigrations,
} from './database-migrations';
import {
  TEST_OWNER_TOKEN_ENV,
  TEST_RUN_ID_ENV,
  buildCanonicalUrl,
  generateOwnerToken,
  ownerTokenHash,
  parseEffectiveConnection,
} from './test-db.guard';
import {
  createOwnedSchema,
  dropOwnedSchemaAtomically,
  quoteIdent,
  releaseOwnershipClient,
} from '../test/setup/ownership';

const CURRENT_TABLES = [
  'auth_login_failures',
  'customer_otp_challenges',
  'customer_otp_request_attempts',
  'customer_sessions',
  'customers',
  'provider_access_credentials',
  'provider_sessions',
  'providers',
  'public_auth_rate_limits',
  'request_provider_opportunities',
  'service_payments',
  'service_quotes',
  'service_request_events',
  'service_request_images',
  'service_requests',
  'staff_audit_events',
  'staff_sessions',
  'staff_users',
  'support_tickets',
];

describe('database migration discovery', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'moeen-migrations-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('orders numbered SQL migrations deterministically', async () => {
    await Promise.all([
      writeFile(join(directory, '0003_third.sql'), 'SELECT 3;'),
      writeFile(join(directory, '0001_first.sql'), 'SELECT 1;'),
      writeFile(join(directory, '0002_second.sql'), 'SELECT 2;'),
    ]);

    const migrations = await loadMigrations(directory);

    expect(migrations.map(({ version, name }) => ({ version, name }))).toEqual([
      { version: '0001', name: 'first' },
      { version: '0002', name: 'second' },
      { version: '0003', name: 'third' },
    ]);
  });

  it('refuses duplicate versions instead of depending on filenames', async () => {
    await Promise.all([
      writeFile(join(directory, '0001_first.sql'), 'SELECT 1;'),
      writeFile(join(directory, '0001_other.sql'), 'SELECT 2;'),
    ]);

    await expect(loadMigrations(directory)).rejects.toThrow(
      "Duplicate database migration version '0001'",
    );
  });

  it('produces platform-independent checksums for SQL line endings', async () => {
    await writeFile(
      join(directory, '0001_first.sql'),
      'SELECT 1;\r\nSELECT 2;\r\n',
    );
    const windowsChecksum = (await loadMigrations(directory))[0].checksum;

    await writeFile(
      join(directory, '0001_first.sql'),
      'SELECT 1;\nSELECT 2;\n',
    );
    const unixChecksum = (await loadMigrations(directory))[0].checksum;

    expect(windowsChecksum).toBe(unixChecksum);
  });

  it('fails closed when the release contains no SQL migrations', async () => {
    await expect(loadMigrations(directory)).rejects.toThrow(
      'No database migrations were found',
    );
  });

  it('requires the baseline to be version 0001', async () => {
    await writeFile(join(directory, '0002_second.sql'), 'SELECT 2;');

    await expect(loadMigrations(directory)).rejects.toThrow(
      "First database migration must be version '0001'",
    );
  });

  it('ships the immutable service-request-images migration after the v1 baseline', async () => {
    const migrations = await loadMigrations(defaultMigrationsDirectory());

    expect(
      migrations.map(({ version, filename }) => ({ version, filename })),
    ).toEqual([
      { version: '0001', filename: '0001_current_schema.sql' },
      { version: '0002', filename: '0002_service_request_images.sql' },
    ]);
  });
});

describe('versioned PostgreSQL migrations', () => {
  const rootConnection = process.env.TEST_DATABASE_URL;
  const runId =
    process.env[TEST_RUN_ID_ENV] ?? `b1${randomBytes(6).toString('hex')}`;
  const ownerToken = process.env[TEST_OWNER_TOKEN_ENV] ?? generateOwnerToken();
  let rootPool: Pool;
  let pool: Pool;
  let schema: string;

  async function createIsolatedSchemaPool(prefix: string): Promise<{
    schema: string;
    pool: Pool;
  }> {
    const isolatedSchema = `${prefix}_${randomBytes(8).toString('hex')}`;
    await createOwnedSchema(
      rootPool,
      isolatedSchema,
      runId,
      ownerTokenHash(ownerToken),
    );
    const connection = parseEffectiveConnection(rootConnection!);
    return {
      schema: isolatedSchema,
      pool: new Pool({
        connectionString: buildCanonicalUrl({
          ...connection,
          searchPath: isolatedSchema,
        }),
      }),
    };
  }

  async function dropIsolatedSchema(
    isolatedPool: Pool,
    isolatedSchema: string,
  ): Promise<void> {
    await isolatedPool.end();
    const client = await rootPool.connect();
    try {
      await dropOwnedSchemaAtomically(
        client,
        isolatedSchema,
        runId,
        ownerTokenHash(ownerToken),
      );
    } finally {
      releaseOwnershipClient(client);
    }
  }

  beforeAll(async () => {
    if (!rootConnection) {
      throw new Error('TEST_DATABASE_URL is required');
    }
    schema = `b1_migrations_${randomBytes(8).toString('hex')}`;
    rootPool = new Pool({ connectionString: rootConnection });
    await createOwnedSchema(
      rootPool,
      schema,
      runId,
      ownerTokenHash(ownerToken),
    );
    const connection = parseEffectiveConnection(rootConnection);
    pool = new Pool({
      connectionString: buildCanonicalUrl({
        ...connection,
        searchPath: schema,
      }),
    });
  });

  afterAll(async () => {
    await pool?.end();
    if (rootPool && schema) {
      const client = await rootPool.connect();
      try {
        await dropOwnedSchemaAtomically(
          client,
          schema,
          runId,
          ownerTokenHash(ownerToken),
        );
      } finally {
        releaseOwnershipClient(client);
      }
    }
    await rootPool?.end();
  });

  it('migrates an empty schema through v1 and v2 and is then idempotent', async () => {
    const first = await runDatabaseMigrations(
      pool,
      defaultMigrationsDirectory(),
    );
    expect(first).toEqual({ applied: ['0001', '0002'], baselined: [] });

    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_type = 'BASE TABLE'
          AND table_name <> 'q0sec_run_ownership'
          AND table_name <> 'moeen_schema_migrations'
        ORDER BY table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(CURRENT_TABLES);

    const second = await runDatabaseMigrations(
      pool,
      defaultMigrationsDirectory(),
    );
    expect(second).toEqual({ applied: [], baselined: [] });

    const history = await pool.query<{ version: string }>(
      'SELECT version FROM moeen_schema_migrations ORDER BY version',
    );
    expect(history.rows).toEqual([{ version: '0001' }, { version: '0002' }]);

    const historyRelation = `${quoteIdent(schema)}.${quoteIdent(
      'moeen_schema_migrations',
    )}`;
    const historyCount = await rootPool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${historyRelation}`,
    );
    expect(historyCount.rows[0].count).toBe(2);
  });

  it('baselines an exact legacy v1 schema and applies only v2', async () => {
    const { schema: legacySchema, pool: legacyPool } =
      await createIsolatedSchemaPool('b1_legacy_v1');
    const v1Directory = await mkdtemp(join(tmpdir(), 'moeen-v1-migrations-'));
    try {
      const [v1] = await loadMigrations(defaultMigrationsDirectory());
      await writeFile(join(v1Directory, v1.filename), v1.sql);
      await runDatabaseMigrations(legacyPool, v1Directory);
      await legacyPool.query('DROP TABLE moeen_schema_migrations');

      await expect(runDatabaseMigrations(legacyPool)).resolves.toEqual({
        applied: ['0002'],
        baselined: ['0001'],
      });
      const history = await legacyPool.query<{
        version: string;
        execution_mode: string;
      }>(
        'SELECT version, execution_mode FROM moeen_schema_migrations ORDER BY version',
      );
      expect(history.rows).toEqual([
        { version: '0001', execution_mode: 'baselined' },
        { version: '0002', execution_mode: 'applied' },
      ]);
    } finally {
      await rm(v1Directory, { recursive: true, force: true });
      await dropIsolatedSchema(legacyPool, legacySchema);
    }
  });

  it('applies v2 to a database with valid v1 history', async () => {
    const { schema: v1Schema, pool: v1Pool } =
      await createIsolatedSchemaPool('b1_v1_history');
    const v1Directory = await mkdtemp(join(tmpdir(), 'moeen-v1-history-'));
    try {
      const [v1] = await loadMigrations(defaultMigrationsDirectory());
      await writeFile(join(v1Directory, v1.filename), v1.sql);
      await runDatabaseMigrations(v1Pool, v1Directory);

      await expect(runDatabaseMigrations(v1Pool)).resolves.toEqual({
        applied: ['0002'],
        baselined: [],
      });
    } finally {
      await rm(v1Directory, { recursive: true, force: true });
      await dropIsolatedSchema(v1Pool, v1Schema);
    }
  });

  it('rolls back a failed 0002 without recording history or leaving v2 shape', async () => {
    const { schema: failureSchema, pool: failurePool } =
      await createIsolatedSchemaPool('b1_failed_v2');
    const failureDirectory = await mkdtemp(
      join(tmpdir(), 'moeen-failing-v2-migrations-'),
    );
    try {
      const [v1] = await loadMigrations(defaultMigrationsDirectory());
      await writeFile(join(failureDirectory, v1.filename), v1.sql);
      await writeFile(
        join(failureDirectory, '0002_service_request_images.sql'),
        'ALTER TABLE service_requests ADD COLUMN client_submission_id UUID; CREATE TABLE must_rollback (id INTEGER); SELECT missing_column FROM missing_table;',
      );

      await expect(
        runDatabaseMigrations(failurePool, failureDirectory),
      ).rejects.toThrow();
      const failedRecord = await failurePool.query<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM moeen_schema_migrations
          WHERE version = '0002'`,
      );
      expect(failedRecord.rows[0].count).toBe(0);
      const shape = await failurePool.query<{
        image_table: string | null;
        submission_column_count: number;
        rollback_table: string | null;
      }>(
        `SELECT to_regclass(format('%I.%I', current_schema(), 'service_request_images'))::text AS image_table,
                (SELECT count(*)::int
                   FROM information_schema.columns
                  WHERE table_schema = current_schema()
                    AND table_name = 'service_requests'
                    AND column_name = 'client_submission_id') AS submission_column_count,
                to_regclass(format('%I.%I', current_schema(), 'must_rollback'))::text AS rollback_table`,
      );
      expect(shape.rows[0]).toEqual({
        image_table: null,
        submission_column_count: 0,
        rollback_table: null,
      });
    } finally {
      await rm(failureDirectory, { recursive: true, force: true });
      await dropIsolatedSchema(failurePool, failureSchema);
    }
  });

  it('refuses a pre-created v2 schema without migration history', async () => {
    const { schema: precreatedSchema, pool: precreatedPool } =
      await createIsolatedSchemaPool('b1_precreated_v2');
    try {
      await runDatabaseMigrations(precreatedPool);
      await precreatedPool.query('DROP TABLE moeen_schema_migrations');

      await expect(runDatabaseMigrations(precreatedPool)).rejects.toThrow(
        "Refusing to apply initial database migration '0001'",
      );
      const history = await precreatedPool.query<{ relation: string | null }>(
        `SELECT to_regclass(
           format('%I.%I', current_schema(), 'moeen_schema_migrations')
         )::text AS relation`,
      );
      expect(history.rows[0].relation).toBeNull();
    } finally {
      await dropIsolatedSchema(precreatedPool, precreatedSchema);
    }
  });

  it('refuses a v2 schema that drifts from the applied 0002 constraint contract', async () => {
    const { schema: driftSchema, pool: driftPool } =
      await createIsolatedSchemaPool('b1_v2_constraint_drift');
    try {
      await runDatabaseMigrations(driftPool);
      await driftPool.query(
        'ALTER TABLE service_request_images DROP CONSTRAINT service_request_images_sort_order_check',
      );

      await expect(runDatabaseMigrations(driftPool)).rejects.toThrow(
        "Database schema does not satisfy applied migration '0002'",
      );
    } finally {
      await dropIsolatedSchema(driftPool, driftSchema);
    }
  });

  it('refuses a v2 schema that drifts from the applied 0002 column contract', async () => {
    const { schema: driftSchema, pool: driftPool } =
      await createIsolatedSchemaPool('b1_v2_column_drift');
    try {
      await runDatabaseMigrations(driftPool);
      await driftPool.query(
        'ALTER TABLE service_request_images ALTER COLUMN byte_size TYPE BIGINT',
      );

      await expect(runDatabaseMigrations(driftPool)).rejects.toThrow(
        "Database schema does not satisfy applied migration '0002'",
      );
    } finally {
      await dropIsolatedSchema(driftPool, driftSchema);
    }
  });

  it('refuses a non-empty partial schema before replaying the initial migration', async () => {
    const { schema: partialSchema, pool: partialPool } =
      await createIsolatedSchemaPool('b1_partial');
    try {
      await partialPool.query(`
        CREATE TABLE customers (
          id BIGSERIAL PRIMARY KEY,
          phone TEXT UNIQUE NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await expect(runDatabaseMigrations(partialPool)).rejects.toThrow(
        "Refusing to apply initial database migration '0001'",
      );
      const relations = await partialPool.query<{ table_name: string }>(
        `SELECT table_name
           FROM information_schema.tables
          WHERE table_schema = current_schema()
            AND table_name <> 'q0sec_run_ownership'
          ORDER BY table_name`,
      );
      expect(relations.rows.map((row) => row.table_name)).toEqual([
        'customers',
      ]);
    } finally {
      await dropIsolatedSchema(partialPool, partialSchema);
    }
  });

  it('accepts the exact 0001 foreign-key set and normal BIGSERIAL sequence semantics', async () => {
    const { schema: exactSchema, pool: exactPool } =
      await createIsolatedSchemaPool('b1_exact_contract');
    const v1Directory = await mkdtemp(join(tmpdir(), 'moeen-exact-v1-'));
    try {
      const [v1] = await loadMigrations(defaultMigrationsDirectory());
      await writeFile(join(v1Directory, v1.filename), v1.sql);
      await expect(
        runDatabaseMigrations(exactPool, v1Directory),
      ).resolves.toEqual({
        applied: ['0001'],
        baselined: [],
      });
      await exactPool.query('DROP TABLE moeen_schema_migrations');

      await expect(
        runDatabaseMigrations(exactPool, v1Directory),
      ).resolves.toEqual({
        applied: [],
        baselined: ['0001'],
      });
    } finally {
      await rm(v1Directory, { recursive: true, force: true });
      await dropIsolatedSchema(exactPool, exactSchema);
    }
  });

  it('refuses to baseline an expected foreign key declared NOT VALID', async () => {
    const { schema: notValidSchema, pool: notValidPool } =
      await createIsolatedSchemaPool('b1_not_valid_fk');
    try {
      await runDatabaseMigrations(notValidPool);
      await notValidPool.query('DROP TABLE moeen_schema_migrations');
      await notValidPool.query(
        `ALTER TABLE customer_sessions
           DROP CONSTRAINT customer_sessions_customer_id_fkey,
           ADD CONSTRAINT customer_sessions_customer_id_fkey
             FOREIGN KEY (customer_id) REFERENCES customers(id) NOT VALID`,
      );
      const validation = await notValidPool.query<{ validated: boolean }>(
        `SELECT convalidated AS validated
           FROM pg_constraint
          WHERE conrelid = to_regclass(
                  format('%I.%I', current_schema(), 'customer_sessions')
                )
            AND conname = 'customer_sessions_customer_id_fkey'`,
      );
      expect(validation.rows).toEqual([{ validated: false }]);

      await expect(runDatabaseMigrations(notValidPool)).rejects.toThrow(
        "Refusing to apply initial database migration '0001'",
      );
    } finally {
      await dropIsolatedSchema(notValidPool, notValidSchema);
    }
  });

  it('refuses a NOT VALID expected foreign key even when an orphan row already exists', async () => {
    const { schema: orphanSchema, pool: orphanPool } =
      await createIsolatedSchemaPool('b1_not_valid_orphan_fk');
    try {
      await runDatabaseMigrations(orphanPool);
      await orphanPool.query('DROP TABLE moeen_schema_migrations');
      await orphanPool.query(
        'ALTER TABLE customer_sessions DROP CONSTRAINT customer_sessions_customer_id_fkey',
      );
      await orphanPool.query(
        `INSERT INTO customer_sessions
           (token_hash, customer_id, expires_at)
         VALUES ('b1-orphan-customer-session', 9223372036854775807, NOW() + INTERVAL '1 hour')`,
      );
      await orphanPool.query(
        `ALTER TABLE customer_sessions
           ADD CONSTRAINT customer_sessions_customer_id_fkey
             FOREIGN KEY (customer_id) REFERENCES customers(id) NOT VALID`,
      );
      const contractState = await orphanPool.query<{
        validated: boolean;
        orphan_count: number;
      }>(
        `SELECT constraint_record.convalidated AS validated,
                (
                  SELECT count(*)::int
                    FROM customer_sessions source
                    LEFT JOIN customers target ON target.id = source.customer_id
                   WHERE target.id IS NULL
                ) AS orphan_count
           FROM pg_constraint constraint_record
          WHERE constraint_record.conrelid = to_regclass(
                  format('%I.%I', current_schema(), 'customer_sessions')
                )
            AND constraint_record.conname = 'customer_sessions_customer_id_fkey'`,
      );
      expect(contractState.rows).toEqual([
        { validated: false, orphan_count: 1 },
      ]);

      await expect(runDatabaseMigrations(orphanPool)).rejects.toThrow(
        "Refusing to apply initial database migration '0001'",
      );
    } finally {
      await dropIsolatedSchema(orphanPool, orphanSchema);
    }
  });

  it('refuses an additional foreign key to another exact test-owned schema', async () => {
    const { schema: sourceSchema, pool: sourcePool } =
      await createIsolatedSchemaPool('b1_extra_fk_source');
    const { schema: targetSchema, pool: targetPool } =
      await createIsolatedSchemaPool('b1_extra_fk_target');
    try {
      await runDatabaseMigrations(sourcePool);
      await runDatabaseMigrations(targetPool);
      await sourcePool.query('DROP TABLE moeen_schema_migrations');
      await sourcePool.query(
        `ALTER TABLE customer_sessions
           ADD CONSTRAINT b1_unexpected_cross_schema_fk
           FOREIGN KEY (token_hash)
           REFERENCES ${quoteIdent(targetSchema)}.staff_sessions(token_hash)`,
      );

      await expect(runDatabaseMigrations(sourcePool)).rejects.toThrow(
        "Refusing to apply initial database migration '0001'",
      );
    } finally {
      await dropIsolatedSchema(sourcePool, sourceSchema);
      await dropIsolatedSchema(targetPool, targetSchema);
    }
  });

  it('refuses an additional same-schema foreign key absent from 0001', async () => {
    const { schema: lookalikeSchema, pool: lookalikePool } =
      await createIsolatedSchemaPool('b1_extra_same_schema_fk');
    try {
      await runDatabaseMigrations(lookalikePool);
      await lookalikePool.query('DROP TABLE moeen_schema_migrations');
      await lookalikePool.query(
        `ALTER TABLE customer_sessions
           ADD CONSTRAINT b1_unexpected_same_schema_fk
           FOREIGN KEY (token_hash) REFERENCES staff_sessions(token_hash)`,
      );

      await expect(runDatabaseMigrations(lookalikePool)).rejects.toThrow(
        "Refusing to apply initial database migration '0001'",
      );
    } finally {
      await dropIsolatedSchema(lookalikePool, lookalikeSchema);
    }
  });

  it('refuses to baseline a lookalike schema with a mismatched foreign key', async () => {
    const { schema: lookalikeSchema, pool: lookalikePool } =
      await createIsolatedSchemaPool('b1_lookalike');
    try {
      await runDatabaseMigrations(lookalikePool);
      await lookalikePool.query('DROP TABLE moeen_schema_migrations');
      await lookalikePool.query(
        `ALTER TABLE customer_sessions
           DROP CONSTRAINT customer_sessions_customer_id_fkey,
           ADD CONSTRAINT customer_sessions_customer_id_fkey
             FOREIGN KEY (customer_id) REFERENCES staff_users(id)`,
      );

      await expect(runDatabaseMigrations(lookalikePool)).rejects.toThrow(
        "Refusing to apply initial database migration '0001'",
      );
      const history = await lookalikePool.query<{ relation: string | null }>(
        `SELECT to_regclass(
           format('%I.%I', current_schema(), 'moeen_schema_migrations')
         )::text AS relation`,
      );
      expect(history.rows[0].relation).toBeNull();
    } finally {
      await dropIsolatedSchema(lookalikePool, lookalikeSchema);
    }
  });

  it('refuses an FK to a same-named table in another exact test-owned schema', async () => {
    const { schema: lookalikeSchema, pool: lookalikePool } =
      await createIsolatedSchemaPool('b1_fk_source');
    const { schema: targetSchema, pool: targetPool } =
      await createIsolatedSchemaPool('b1_fk_target');
    try {
      await runDatabaseMigrations(lookalikePool);
      await runDatabaseMigrations(targetPool);
      await lookalikePool.query('DROP TABLE moeen_schema_migrations');
      await lookalikePool.query(
        `ALTER TABLE customer_sessions
           DROP CONSTRAINT customer_sessions_customer_id_fkey,
           ADD CONSTRAINT customer_sessions_customer_id_fkey
             FOREIGN KEY (customer_id)
             REFERENCES ${quoteIdent(targetSchema)}.customers(id)`,
      );

      await expect(runDatabaseMigrations(lookalikePool)).rejects.toThrow(
        "Refusing to apply initial database migration '0001'",
      );
    } finally {
      await dropIsolatedSchema(lookalikePool, lookalikeSchema);
      await dropIsolatedSchema(targetPool, targetSchema);
    }
  });

  it('refuses to baseline current-looking tables with an incompatible column type', async () => {
    const { schema: lookalikeSchema, pool: lookalikePool } =
      await createIsolatedSchemaPool('b1_column_lookalike');
    try {
      await runDatabaseMigrations(lookalikePool);
      await lookalikePool.query('DROP TABLE moeen_schema_migrations');
      await lookalikePool.query(
        'ALTER TABLE customers ALTER COLUMN phone TYPE VARCHAR(32)',
      );

      await expect(runDatabaseMigrations(lookalikePool)).rejects.toThrow(
        "Refusing to apply initial database migration '0001'",
      );
    } finally {
      await dropIsolatedSchema(lookalikePool, lookalikeSchema);
    }
  });

  it('refuses to baseline a schema missing a required column default', async () => {
    const { schema: missingDefaultSchema, pool: missingDefaultPool } =
      await createIsolatedSchemaPool('b1_missing_default');
    try {
      await runDatabaseMigrations(missingDefaultPool);
      await missingDefaultPool.query('DROP TABLE moeen_schema_migrations');
      await missingDefaultPool.query(
        'ALTER TABLE customers ALTER COLUMN created_at DROP DEFAULT',
      );

      await expect(runDatabaseMigrations(missingDefaultPool)).rejects.toThrow(
        "Refusing to apply initial database migration '0001'",
      );
    } finally {
      await dropIsolatedSchema(missingDefaultPool, missingDefaultSchema);
    }
  });

  it('refuses to baseline a schema with an incompatible column default', async () => {
    const { schema: wrongDefaultSchema, pool: wrongDefaultPool } =
      await createIsolatedSchemaPool('b1_wrong_default');
    try {
      await runDatabaseMigrations(wrongDefaultPool);
      await wrongDefaultPool.query('DROP TABLE moeen_schema_migrations');
      await wrongDefaultPool.query(
        "ALTER TABLE customers ALTER COLUMN created_at SET DEFAULT (CURRENT_TIMESTAMP + INTERVAL '1 day')",
      );

      await expect(runDatabaseMigrations(wrongDefaultPool)).rejects.toThrow(
        "Refusing to apply initial database migration '0001'",
      );
    } finally {
      await dropIsolatedSchema(wrongDefaultPool, wrongDefaultSchema);
    }
  });

  it('refuses incompatible BIGSERIAL increment and cycle behavior', async () => {
    const { schema: behaviorSchema, pool: behaviorPool } =
      await createIsolatedSchemaPool('b1_sequence_behavior');
    try {
      await runDatabaseMigrations(behaviorPool);
      await behaviorPool.query('DROP TABLE moeen_schema_migrations');
      await behaviorPool.query(
        'ALTER SEQUENCE customers_id_seq INCREMENT BY 2',
      );

      await expect(runDatabaseMigrations(behaviorPool)).rejects.toThrow(
        "Refusing to apply initial database migration '0001'",
      );

      await behaviorPool.query(
        'ALTER SEQUENCE customers_id_seq INCREMENT BY 1 CYCLE',
      );
      await expect(runDatabaseMigrations(behaviorPool)).rejects.toThrow(
        "Refusing to apply initial database migration '0001'",
      );
    } finally {
      await dropIsolatedSchema(behaviorPool, behaviorSchema);
    }
  });

  it('refuses a BIGSERIAL sequence with an incompatible data type', async () => {
    const { schema: typeSchema, pool: typePool } =
      await createIsolatedSchemaPool('b1_sequence_type');
    try {
      await runDatabaseMigrations(typePool);
      await typePool.query('DROP TABLE moeen_schema_migrations');
      await typePool.query(
        'ALTER SEQUENCE customers_id_seq AS INTEGER NO MAXVALUE',
      );

      await expect(runDatabaseMigrations(typePool)).rejects.toThrow(
        "Refusing to apply initial database migration '0001'",
      );
    } finally {
      await dropIsolatedSchema(typePool, typeSchema);
    }
  });

  it('refuses missing or wrong BIGSERIAL sequence ownership', async () => {
    const { schema: ownershipSchema, pool: ownershipPool } =
      await createIsolatedSchemaPool('b1_sequence_ownership');
    try {
      await runDatabaseMigrations(ownershipPool);
      await ownershipPool.query('DROP TABLE moeen_schema_migrations');
      await ownershipPool.query(
        'ALTER SEQUENCE customers_id_seq OWNED BY NONE',
      );

      await expect(runDatabaseMigrations(ownershipPool)).rejects.toThrow(
        "Refusing to apply initial database migration '0001'",
      );

      await ownershipPool.query(
        'ALTER SEQUENCE customers_id_seq OWNED BY staff_users.id',
      );
      await expect(runDatabaseMigrations(ownershipPool)).rejects.toThrow(
        "Refusing to apply initial database migration '0001'",
      );
    } finally {
      await dropIsolatedSchema(ownershipPool, ownershipSchema);
    }
  });

  it('refuses a BIGSERIAL default backed by a sequence in another exact test-owned schema', async () => {
    const { schema: sourceSchema, pool: sourcePool } =
      await createIsolatedSchemaPool('b1_sequence_source');
    const { schema: sequenceSchema, pool: sequencePool } =
      await createIsolatedSchemaPool('b1_sequence_target');
    let multiSchemaPool: Pool | undefined;
    try {
      await runDatabaseMigrations(sourcePool);
      await sourcePool.query('DROP TABLE moeen_schema_migrations');
      await sourcePool.query('ALTER SEQUENCE customers_id_seq OWNED BY NONE');
      await sourcePool.query(
        `ALTER SEQUENCE customers_id_seq SET SCHEMA ${quoteIdent(sequenceSchema)}`,
      );

      const connection = parseEffectiveConnection(rootConnection!);
      multiSchemaPool = new Pool({
        connectionString: buildCanonicalUrl({
          ...connection,
          searchPath: `${sourceSchema},${sequenceSchema}`,
        }),
      });
      const defaultExpression = await multiSchemaPool.query<{
        expression: string;
      }>(
        `SELECT pg_get_expr(default_record.adbin, default_record.adrelid, false)
                AS expression
           FROM pg_attrdef default_record
           JOIN pg_class source ON source.oid = default_record.adrelid
           JOIN pg_namespace source_namespace
             ON source_namespace.oid = source.relnamespace
           JOIN pg_attribute source_attribute
             ON source_attribute.attrelid = source.oid
            AND source_attribute.attnum = default_record.adnum
          WHERE source_namespace.nspname = current_schema()
            AND source.relname = 'customers'
            AND source_attribute.attname = 'id'`,
      );
      expect(defaultExpression.rows[0]?.expression).toBe(
        "nextval('customers_id_seq'::regclass)",
      );

      await expect(runDatabaseMigrations(multiSchemaPool)).rejects.toThrow(
        "Refusing to apply initial database migration '0001'",
      );
    } finally {
      await multiSchemaPool?.end();
      await dropIsolatedSchema(sourcePool, sourceSchema);
      await dropIsolatedSchema(sequencePool, sequenceSchema);
    }
  });

  it('refuses generated semantics absent from the baseline migration', async () => {
    const { schema: generatedSchema, pool: generatedPool } =
      await createIsolatedSchemaPool('b1_generated_column');
    try {
      await runDatabaseMigrations(generatedPool);
      await generatedPool.query('DROP TABLE moeen_schema_migrations');
      await generatedPool.query(
        `ALTER TABLE service_requests
           DROP COLUMN details,
           ADD COLUMN details TEXT GENERATED ALWAYS AS ('generated'::text) STORED`,
      );

      await expect(runDatabaseMigrations(generatedPool)).rejects.toThrow(
        "Refusing to apply initial database migration '0001'",
      );
    } finally {
      await dropIsolatedSchema(generatedPool, generatedSchema);
    }
  });

  it('refuses to baseline a schema missing a required primary key', async () => {
    const { schema: missingPkSchema, pool: missingPkPool } =
      await createIsolatedSchemaPool('b1_missing_pk');
    try {
      await runDatabaseMigrations(missingPkPool);
      await missingPkPool.query('DROP TABLE moeen_schema_migrations');
      await missingPkPool.query(
        'ALTER TABLE customer_otp_challenges DROP CONSTRAINT customer_otp_challenges_pkey',
      );

      await expect(runDatabaseMigrations(missingPkPool)).rejects.toThrow(
        "Refusing to apply initial database migration '0001'",
      );
    } finally {
      await dropIsolatedSchema(missingPkPool, missingPkSchema);
    }
  });

  it('refuses to baseline a schema missing a required unique key', async () => {
    const { schema: missingUniqueSchema, pool: missingUniquePool } =
      await createIsolatedSchemaPool('b1_missing_unique');
    try {
      await runDatabaseMigrations(missingUniquePool);
      await missingUniquePool.query('DROP TABLE moeen_schema_migrations');
      await missingUniquePool.query(
        'ALTER TABLE customers DROP CONSTRAINT customers_phone_key',
      );

      await expect(runDatabaseMigrations(missingUniquePool)).rejects.toThrow(
        "Refusing to apply initial database migration '0001'",
      );
    } finally {
      await dropIsolatedSchema(missingUniquePool, missingUniqueSchema);
    }
  });

  it('refuses to baseline a schema whose unique key covers wrong columns', async () => {
    const { schema: wrongColumnsSchema, pool: wrongColumnsPool } =
      await createIsolatedSchemaPool('b1_unique_wrong_columns');
    try {
      await runDatabaseMigrations(wrongColumnsPool);
      await wrongColumnsPool.query('DROP TABLE moeen_schema_migrations');
      await wrongColumnsPool.query(
        'ALTER TABLE customers DROP CONSTRAINT customers_phone_key',
      );
      await wrongColumnsPool.query(
        'ALTER TABLE customers ADD CONSTRAINT customers_phone_key UNIQUE (phone, id)',
      );

      await expect(runDatabaseMigrations(wrongColumnsPool)).rejects.toThrow(
        "Refusing to apply initial database migration '0001'",
      );
    } finally {
      await dropIsolatedSchema(wrongColumnsPool, wrongColumnsSchema);
    }
  });

  it('refuses to baseline a schema that uses the wrong constraint type', async () => {
    const { schema: wrongTypeSchema, pool: wrongTypePool } =
      await createIsolatedSchemaPool('b1_unique_wrong_type');
    try {
      await runDatabaseMigrations(wrongTypePool);
      await wrongTypePool.query('DROP TABLE moeen_schema_migrations');
      await wrongTypePool.query(
        'ALTER TABLE customer_otp_challenges DROP CONSTRAINT customer_otp_challenges_pkey',
      );
      await wrongTypePool.query(
        'ALTER TABLE customer_otp_challenges ADD CONSTRAINT customer_otp_challenges_pkey UNIQUE (challenge_id)',
      );

      await expect(runDatabaseMigrations(wrongTypePool)).rejects.toThrow(
        "Refusing to apply initial database migration '0001'",
      );
    } finally {
      await dropIsolatedSchema(wrongTypePool, wrongTypeSchema);
    }
  });

  it('refuses checksum and version inconsistencies in applied history', async () => {
    const { schema: historySchema, pool: historyPool } =
      await createIsolatedSchemaPool('b1_history');
    try {
      await runDatabaseMigrations(historyPool);
      const original = await historyPool.query<{
        name: string;
        checksum: string;
      }>(
        `SELECT name, checksum
           FROM moeen_schema_migrations
          WHERE version = '0001'`,
      );
      await historyPool.query(
        `UPDATE moeen_schema_migrations
            SET checksum = repeat('0', 64)
          WHERE version = '0001'`,
      );
      await expect(runDatabaseMigrations(historyPool)).rejects.toThrow(
        "Database migration '0001' does not match its applied history",
      );
      await historyPool.query(
        `UPDATE moeen_schema_migrations
            SET checksum = $1
          WHERE version = '0001'`,
        [original.rows[0].checksum],
      );
      await historyPool.query(
        `INSERT INTO moeen_schema_migrations
           (version, name, checksum, execution_mode)
         VALUES ('0003', 'unknown', repeat('1', 64), 'applied')`,
      );
      await expect(runDatabaseMigrations(historyPool)).rejects.toThrow(
        "Database migration '0003' is applied but missing from this release",
      );
    } finally {
      await dropIsolatedSchema(historyPool, historySchema);
    }
  });

  it('applies a pending migration when valid v2 history already exists', async () => {
    const { schema: repairSchema, pool: repairPool } =
      await createIsolatedSchemaPool('b1_repair');
    const repairDirectory = await mkdtemp(
      join(tmpdir(), 'moeen-repair-migrations-'),
    );
    try {
      await runDatabaseMigrations(repairPool);
      const current = await loadMigrations(defaultMigrationsDirectory());
      await Promise.all(
        current.map((migration) =>
          writeFile(join(repairDirectory, migration.filename), migration.sql),
        ),
      );
      await writeFile(
        join(repairDirectory, '0003_add_valid_history_probe.sql'),
        'CREATE TABLE valid_history_probe (id INTEGER PRIMARY KEY);',
      );

      await expect(
        runDatabaseMigrations(repairPool, repairDirectory),
      ).resolves.toEqual({ applied: ['0003'], baselined: [] });
    } finally {
      await rm(repairDirectory, { recursive: true, force: true });
      await dropIsolatedSchema(repairPool, repairSchema);
    }
  });
});

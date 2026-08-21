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
  'fcm_devices',
  'notification_outbox',
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

  it('ships customer service location as 0005 after the immutable 0001-0004 history', async () => {
    const migrations = await loadMigrations(defaultMigrationsDirectory());

    expect(
      migrations.map(({ version, filename }) => ({ version, filename })),
    ).toEqual([
      { version: '0001', filename: '0001_current_schema.sql' },
      { version: '0002', filename: '0002_service_request_images.sql' },
      { version: '0003', filename: '0003_fcm_notifications.sql' },
      { version: '0004', filename: '0004_fcm_notification_types.sql' },
      { version: '0005', filename: '0005_service_request_locations.sql' },
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

  it('migrates an empty schema through v1-v5 and is then idempotent', async () => {
    const first = await runDatabaseMigrations(
      pool,
      defaultMigrationsDirectory(),
    );
    expect(first).toEqual({
      applied: ['0001', '0002', '0003', '0004', '0005'],
      baselined: [],
    });

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
    expect(history.rows).toEqual([
      { version: '0001' },
      { version: '0002' },
      { version: '0003' },
      { version: '0004' },
      { version: '0005' },
    ]);

    const historyRelation = `${quoteIdent(schema)}.${quoteIdent(
      'moeen_schema_migrations',
    )}`;
    const historyCount = await rootPool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${historyRelation}`,
    );
    expect(historyCount.rows[0].count).toBe(5);
  });

  it('applies only 0003-0005 to a database already migrated through 0002', async () => {
    const { schema: v2Schema, pool: v2Pool } =
      await createIsolatedSchemaPool('b1_v2_only');
    const v2Directory = await mkdtemp(join(tmpdir(), 'moeen-v2-migrations-'));
    try {
      const migrations = await loadMigrations(defaultMigrationsDirectory());
      await Promise.all(
        migrations
          .filter(
            (migration) =>
              !['0003', '0004', '0005'].includes(migration.version),
          )
          .map((migration) =>
            writeFile(join(v2Directory, migration.filename), migration.sql),
          ),
      );
      await expect(runDatabaseMigrations(v2Pool, v2Directory)).resolves.toEqual(
        { applied: ['0001', '0002'], baselined: [] },
      );

      await expect(runDatabaseMigrations(v2Pool)).resolves.toEqual({
        applied: ['0003', '0004', '0005'],
        baselined: [],
      });

      const history = await v2Pool.query<{
        version: string;
        execution_mode: string;
      }>(
        'SELECT version, execution_mode FROM moeen_schema_migrations ORDER BY version',
      );
      expect(history.rows).toEqual([
        { version: '0001', execution_mode: 'applied' },
        { version: '0002', execution_mode: 'applied' },
        { version: '0003', execution_mode: 'applied' },
        { version: '0004', execution_mode: 'applied' },
        { version: '0005', execution_mode: 'applied' },
      ]);
    } finally {
      await rm(v2Directory, { recursive: true, force: true });
      await dropIsolatedSchema(v2Pool, v2Schema);
    }
  });

  it('applies only 0005 to a v4 schema without fabricating legacy locations', async () => {
    const { schema: v4Schema, pool: v4Pool } =
      await createIsolatedSchemaPool('b1_v4_only');
    const v4Directory = await mkdtemp(join(tmpdir(), 'moeen-v4-migrations-'));
    try {
      const migrations = await loadMigrations(defaultMigrationsDirectory());
      await Promise.all(
        migrations
          .filter((migration) => migration.version !== '0005')
          .map((migration) =>
            writeFile(join(v4Directory, migration.filename), migration.sql),
          ),
      );
      await expect(runDatabaseMigrations(v4Pool, v4Directory)).resolves.toEqual(
        { applied: ['0001', '0002', '0003', '0004'], baselined: [] },
      );
      const legacy = await v4Pool.query<{ id: string }>(
        `INSERT INTO service_requests (service_id, address, timing)
         VALUES ('location-migration-probe', 'حي الصفراء، بريدة', 'scheduled')
         RETURNING id`,
      );

      await expect(runDatabaseMigrations(v4Pool)).resolves.toEqual({
        applied: ['0005'],
        baselined: [],
      });
      const shape = await v4Pool.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'service_requests'
            AND column_name LIKE 'location_%'
          ORDER BY column_name`,
      );
      expect(shape.rows).toEqual([
        {
          column_name: 'location_confirmed_at',
          data_type: 'timestamp with time zone',
          is_nullable: 'YES',
          column_default: null,
        },
        {
          column_name: 'location_latitude',
          data_type: 'numeric',
          is_nullable: 'YES',
          column_default: null,
        },
        {
          column_name: 'location_longitude',
          data_type: 'numeric',
          is_nullable: 'YES',
          column_default: null,
        },
        {
          column_name: 'location_source',
          data_type: 'text',
          is_nullable: 'YES',
          column_default: null,
        },
      ]);
      const legacyLocation = await v4Pool.query<{
        location_latitude: string | null;
        location_longitude: string | null;
        location_source: string | null;
        location_confirmed_at: Date | null;
      }>(
        `SELECT location_latitude, location_longitude,
                location_source, location_confirmed_at
           FROM service_requests
          WHERE id = $1`,
        [legacy.rows[0].id],
      );
      expect(legacyLocation.rows).toEqual([
        {
          location_latitude: null,
          location_longitude: null,
          location_source: null,
          location_confirmed_at: null,
        },
      ]);
      await expect(runDatabaseMigrations(v4Pool)).resolves.toEqual({
        applied: [],
        baselined: [],
      });
    } finally {
      await rm(v4Directory, { recursive: true, force: true });
      await dropIsolatedSchema(v4Pool, v4Schema);
    }
  });

  it('rolls back 0005 when a partial location column already exists', async () => {
    const { schema: partialSchema, pool: partialPool } =
      await createIsolatedSchemaPool('b1_v5_partial');
    const v4Directory = await mkdtemp(join(tmpdir(), 'moeen-v4-partial-'));
    try {
      const migrations = await loadMigrations(defaultMigrationsDirectory());
      await Promise.all(
        migrations
          .filter((migration) => migration.version !== '0005')
          .map((migration) =>
            writeFile(join(v4Directory, migration.filename), migration.sql),
          ),
      );
      await runDatabaseMigrations(partialPool, v4Directory);
      await partialPool.query(
        'ALTER TABLE service_requests ADD COLUMN location_latitude NUMERIC(9,6)',
      );

      await expect(runDatabaseMigrations(partialPool)).rejects.toThrow();
      const history = await partialPool.query<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM moeen_schema_migrations
          WHERE version = '0005'`,
      );
      expect(history.rows).toEqual([{ count: 0 }]);
      const columns = await partialPool.query<{ column_name: string }>(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'service_requests'
            AND column_name LIKE 'location_%'
          ORDER BY column_name`,
      );
      expect(columns.rows).toEqual([{ column_name: 'location_latitude' }]);
    } finally {
      await rm(v4Directory, { recursive: true, force: true });
      await dropIsolatedSchema(partialPool, partialSchema);
    }
  });

  it('baselines an exact legacy v1 schema and applies only v2-v5', async () => {
    const { schema: legacySchema, pool: legacyPool } =
      await createIsolatedSchemaPool('b1_legacy_v1');
    const v1Directory = await mkdtemp(join(tmpdir(), 'moeen-v1-migrations-'));
    try {
      const [v1] = await loadMigrations(defaultMigrationsDirectory());
      await writeFile(join(v1Directory, v1.filename), v1.sql);
      await runDatabaseMigrations(legacyPool, v1Directory);
      await legacyPool.query('DROP TABLE moeen_schema_migrations');

      await expect(runDatabaseMigrations(legacyPool)).resolves.toEqual({
        applied: ['0002', '0003', '0004', '0005'],
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
        { version: '0003', execution_mode: 'applied' },
        { version: '0004', execution_mode: 'applied' },
        { version: '0005', execution_mode: 'applied' },
      ]);
    } finally {
      await rm(v1Directory, { recursive: true, force: true });
      await dropIsolatedSchema(legacyPool, legacySchema);
    }
  });

  it('applies v2-v5 to a database with valid v1 history', async () => {
    const { schema: v1Schema, pool: v1Pool } =
      await createIsolatedSchemaPool('b1_v1_history');
    const v1Directory = await mkdtemp(join(tmpdir(), 'moeen-v1-history-'));
    try {
      const [v1] = await loadMigrations(defaultMigrationsDirectory());
      await writeFile(join(v1Directory, v1.filename), v1.sql);
      await runDatabaseMigrations(v1Pool, v1Directory);

      await expect(runDatabaseMigrations(v1Pool)).resolves.toEqual({
        applied: ['0002', '0003', '0004', '0005'],
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

  it('refuses a pre-created current schema without migration history', async () => {
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
    const v2Directory = await mkdtemp(join(tmpdir(), 'moeen-v2-drift-'));
    try {
      const migrations = await loadMigrations(defaultMigrationsDirectory());
      await Promise.all(
        migrations
          .filter(
            (migration) =>
              !['0003', '0004', '0005'].includes(migration.version),
          )
          .map((migration) =>
            writeFile(join(v2Directory, migration.filename), migration.sql),
          ),
      );
      await runDatabaseMigrations(driftPool, v2Directory);
      await driftPool.query(
        'ALTER TABLE service_request_images DROP CONSTRAINT service_request_images_sort_order_check',
      );

      await expect(runDatabaseMigrations(driftPool)).rejects.toThrow(
        "Database schema does not satisfy applied migration '0002'",
      );
    } finally {
      await rm(v2Directory, { recursive: true, force: true });
      await dropIsolatedSchema(driftPool, driftSchema);
    }
  });

  it('refuses a v2 schema that drifts from the applied 0002 column contract', async () => {
    const { schema: driftSchema, pool: driftPool } =
      await createIsolatedSchemaPool('b1_v2_column_drift');
    const v2Directory = await mkdtemp(join(tmpdir(), 'moeen-v2-column-'));
    try {
      const migrations = await loadMigrations(defaultMigrationsDirectory());
      await Promise.all(
        migrations
          .filter(
            (migration) =>
              !['0003', '0004', '0005'].includes(migration.version),
          )
          .map((migration) =>
            writeFile(join(v2Directory, migration.filename), migration.sql),
          ),
      );
      await runDatabaseMigrations(driftPool, v2Directory);
      await driftPool.query(
        'ALTER TABLE service_request_images ALTER COLUMN byte_size TYPE BIGINT',
      );

      await expect(runDatabaseMigrations(driftPool)).rejects.toThrow(
        "Database schema does not satisfy applied migration '0002'",
      );
    } finally {
      await rm(v2Directory, { recursive: true, force: true });
      await dropIsolatedSchema(driftPool, driftSchema);
    }
  });

  it('refuses a schema that drifts from the applied 0004 constraint contract', async () => {
    const { schema: driftSchema, pool: driftPool } =
      await createIsolatedSchemaPool('b1_v4_constraint_drift');
    try {
      await runDatabaseMigrations(driftPool);
      await driftPool.query(
        'ALTER TABLE fcm_devices DROP CONSTRAINT fcm_devices_platform_check',
      );

      await expect(runDatabaseMigrations(driftPool)).rejects.toThrow(
        "Database schema does not satisfy applied migration '0005'",
      );
    } finally {
      await dropIsolatedSchema(driftPool, driftSchema);
    }
  });

  it('refuses a schema that drifts from the applied 0004 column contract', async () => {
    const { schema: driftSchema, pool: driftPool } =
      await createIsolatedSchemaPool('b1_v4_column_drift');
    try {
      await runDatabaseMigrations(driftPool);
      await driftPool.query(
        'ALTER TABLE notification_outbox ALTER COLUMN attempts TYPE INTEGER',
      );

      await expect(runDatabaseMigrations(driftPool)).rejects.toThrow(
        "Database schema does not satisfy applied migration '0005'",
      );
    } finally {
      await dropIsolatedSchema(driftPool, driftSchema);
    }
  });

  it('refuses a widened 0004 notification-type CHECK that dropped an approved Pilot value', async () => {
    const { schema: driftSchema, pool: driftPool } =
      await createIsolatedSchemaPool('b1_v4_type_drift');
    try {
      await runDatabaseMigrations(driftPool);
      // Re-drop and recreate the CHECK without 'quote_received' -- a value
      // the 0004 contract requires but the 0003 contract did not know about.
      await driftPool.query(
        `ALTER TABLE notification_outbox DROP CONSTRAINT notification_outbox_notification_type_check`,
      );
      await driftPool.query(
        `ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_notification_type_check
         CHECK (notification_type IN (
           'request_created',
           'assignment_confirmed',
           'provider_on_the_way',
           'service_in_progress',
           'request_completed',
           'request_cancelled',
           'opportunity_invited',
           'provider_assigned',
           'opportunity_closed',
           'quote_approved'
         ))`,
      );

      await expect(runDatabaseMigrations(driftPool)).rejects.toThrow(
        "Database schema does not satisfy applied migration '0005'",
      );
    } finally {
      await dropIsolatedSchema(driftPool, driftSchema);
    }
  });

  it.each([
    [
      'column type',
      'ALTER TABLE service_requests ALTER COLUMN location_latitude TYPE DOUBLE PRECISION',
    ],
    [
      'column nullability',
      'ALTER TABLE service_requests ALTER COLUMN location_source SET NOT NULL',
    ],
    [
      'column default',
      'ALTER TABLE service_requests ALTER COLUMN location_confirmed_at SET DEFAULT NOW()',
    ],
  ])('refuses 0005 %s drift', async (_case, driftSql) => {
    const { schema: driftSchema, pool: driftPool } =
      await createIsolatedSchemaPool('b1_v5_column_drift');
    try {
      await runDatabaseMigrations(driftPool);
      await driftPool.query(driftSql);

      await expect(runDatabaseMigrations(driftPool)).rejects.toThrow(
        "Database schema does not satisfy applied migration '0005'",
      );
    } finally {
      await dropIsolatedSchema(driftPool, driftSchema);
    }
  });

  it('refuses 0005 location constraint drift', async () => {
    const { schema: driftSchema, pool: driftPool } =
      await createIsolatedSchemaPool('b1_v5_constraint_drift');
    try {
      await runDatabaseMigrations(driftPool);
      await driftPool.query(
        'ALTER TABLE service_requests DROP CONSTRAINT service_requests_location_completeness_check',
      );

      await expect(runDatabaseMigrations(driftPool)).rejects.toThrow(
        "Database schema does not satisfy applied migration '0005'",
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
         VALUES ('0006', 'unknown', repeat('1', 64), 'applied')`,
      );
      await expect(runDatabaseMigrations(historyPool)).rejects.toThrow(
        "Database migration '0006' is applied but missing from this release",
      );
    } finally {
      await dropIsolatedSchema(historyPool, historySchema);
    }
  });

  it('refuses checksum drift in the applied 0005 history', async () => {
    const { schema: historySchema, pool: historyPool } =
      await createIsolatedSchemaPool('b1_v5_history');
    try {
      await runDatabaseMigrations(historyPool);
      await historyPool.query(
        `UPDATE moeen_schema_migrations
            SET checksum = repeat('0', 64)
          WHERE version = '0005'`,
      );

      await expect(runDatabaseMigrations(historyPool)).rejects.toThrow(
        "Database migration '0005' does not match its applied history",
      );
    } finally {
      await dropIsolatedSchema(historyPool, historySchema);
    }
  });

  it('applies a pending migration when valid v5 history already exists', async () => {
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
        join(repairDirectory, '0006_add_valid_history_probe.sql'),
        'CREATE TABLE valid_history_probe (id INTEGER PRIMARY KEY);',
      );

      await expect(
        runDatabaseMigrations(repairPool, repairDirectory),
      ).resolves.toEqual({ applied: ['0006'], baselined: [] });
    } finally {
      await rm(repairDirectory, { recursive: true, force: true });
      await dropIsolatedSchema(repairPool, repairSchema);
    }
  });
});

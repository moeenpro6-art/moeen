import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { resolveDatabaseConnectionString } from './database.config';

const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9][a-z0-9_-]*)[.]sql$/;
const MIGRATION_LOCK_NAMESPACE = 'moeen-schema-migrations';
const LEGACY_STARTUP_DDL_LOCK_SQL =
  'SELECT pg_advisory_xact_lock(hashtextextended(current_schema(), 0))';
const MIGRATION_HISTORY_TABLE = 'moeen_schema_migrations';
const SCHEMA_INFRASTRUCTURE_TABLES = [
  MIGRATION_HISTORY_TABLE,
  'q0sec_run_ownership',
  'q0sec_worker_isolation',
] as const;

const CURRENT_SCHEMA_COLUMN_TYPES: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  auth_login_failures: {
    scope: 'text!',
    subject_hash: 'character(64)!',
    attempted_at: 'timestamp with time zone!',
  },
  customer_otp_challenges: {
    challenge_id: 'uuid!',
    phone: 'text!',
    expires_at: 'timestamp with time zone!',
    failed_attempts: 'smallint!',
    created_at: 'timestamp with time zone!',
  },
  customer_otp_request_attempts: {
    id: 'bigint!',
    phone: 'text!',
    requested_at: 'timestamp with time zone!',
  },
  customer_sessions: {
    token_hash: 'text!',
    customer_id: 'bigint!',
    expires_at: 'timestamp with time zone!',
    created_at: 'timestamp with time zone!',
  },
  customers: {
    id: 'bigint!',
    phone: 'text!',
    created_at: 'timestamp with time zone!',
  },
  provider_access_credentials: {
    provider_id: 'text!',
    access_code_hash: 'text!',
    updated_at: 'timestamp with time zone!',
    lookup_id: 'text',
  },
  provider_sessions: {
    token_hash: 'text!',
    provider_id: 'text!',
    expires_at: 'timestamp with time zone!',
    created_at: 'timestamp with time zone!',
  },
  providers: {
    id: 'text!',
    name: 'text!',
    specialties: 'text[]!',
    available: 'boolean!',
    service_zone: 'text!',
    verification_status: 'text!',
  },
  public_auth_rate_limits: {
    scope: 'text!',
    subject_hash: 'character(64)!',
    window_started_at: 'timestamp with time zone!',
    attempt_count: 'integer!',
  },
  request_provider_opportunities: {
    id: 'bigint!',
    service_request_id: 'bigint!',
    provider_id: 'text!',
    status: 'text!',
    created_at: 'timestamp with time zone!',
  },
  service_payments: {
    id: 'bigint!',
    service_request_id: 'bigint!',
    quote_id: 'bigint!',
    amount_halalas: 'integer!',
    currency: 'character(3)!',
    method: 'text!',
    status: 'text!',
    collected_at: 'timestamp with time zone',
    refunded_at: 'timestamp with time zone',
    created_at: 'timestamp with time zone!',
  },
  service_quotes: {
    id: 'bigint!',
    service_request_id: 'bigint!',
    amount_halalas: 'integer!',
    scope: 'text!',
    status: 'text!',
    proposed_at: 'timestamp with time zone!',
    decided_at: 'timestamp with time zone',
    provider_id: 'text',
  },
  service_request_events: {
    id: 'bigint!',
    service_request_id: 'bigint!',
    type: 'text!',
    status: 'text!',
    created_at: 'timestamp with time zone!',
  },
  service_requests: {
    id: 'bigint!',
    service_id: 'text!',
    address: 'text!',
    details: 'text',
    timing: 'text!',
    status: 'text!',
    created_at: 'timestamp with time zone!',
    assigned_provider_id: 'text',
    customer_id: 'bigint',
    rating: 'smallint',
    rating_comment: 'text',
  },
  staff_audit_events: {
    id: 'bigint!',
    staff_user_id: 'bigint!',
    action: 'text!',
    subject_type: 'text!',
    subject_id: 'text!',
    old_state: 'jsonb',
    new_state: 'jsonb',
    created_at: 'timestamp with time zone!',
  },
  staff_sessions: {
    token_hash: 'text!',
    staff_user_id: 'bigint!',
    expires_at: 'timestamp with time zone!',
    created_at: 'timestamp with time zone!',
  },
  staff_users: {
    id: 'bigint!',
    email: 'text!',
    display_name: 'text!',
    role: 'text!',
    password_hash: 'text!',
    is_active: 'boolean!',
    created_at: 'timestamp with time zone!',
  },
  support_tickets: {
    id: 'bigint!',
    service_request_id: 'bigint!',
    customer_id: 'bigint!',
    category: 'text!',
    comment: 'text!',
    status: 'text!',
    created_at: 'timestamp with time zone!',
  },
};

const CURRENT_SCHEMA_COLUMN_DEFAULTS: Readonly<Record<string, string>> = {
  'auth_login_failures.attempted_at': 'now()',
  'customer_otp_challenges.failed_attempts': '0',
  'customer_otp_challenges.created_at': 'now()',
  'customer_otp_request_attempts.id':
    "nextval('customer_otp_request_attempts_id_seq'::regclass)",
  'customer_sessions.created_at': 'now()',
  'customers.id': "nextval('customers_id_seq'::regclass)",
  'customers.created_at': 'now()',
  'provider_access_credentials.updated_at': 'now()',
  'provider_sessions.created_at': 'now()',
  'providers.available': 'true',
  'providers.service_zone': "'بريدة'::text",
  'providers.verification_status': "'pending'::text",
  'request_provider_opportunities.id':
    "nextval('request_provider_opportunities_id_seq'::regclass)",
  'request_provider_opportunities.status': "'invited'::text",
  'request_provider_opportunities.created_at': 'now()',
  'service_payments.id': "nextval('service_payments_id_seq'::regclass)",
  'service_payments.currency': "'SAR'::bpchar",
  'service_payments.created_at': 'now()',
  'service_quotes.id': "nextval('service_quotes_id_seq'::regclass)",
  'service_quotes.status': "'proposed'::text",
  'service_quotes.proposed_at': 'now()',
  'service_request_events.id':
    "nextval('service_request_events_id_seq'::regclass)",
  'service_request_events.created_at': 'now()',
  'service_requests.id': "nextval('service_requests_id_seq'::regclass)",
  'service_requests.status': "'pending_dispatch'::text",
  'service_requests.created_at': 'now()',
  'staff_audit_events.id': "nextval('staff_audit_events_id_seq'::regclass)",
  'staff_audit_events.created_at': 'now()',
  'staff_sessions.created_at': 'now()',
  'staff_users.id': "nextval('staff_users_id_seq'::regclass)",
  'staff_users.is_active': 'true',
  'staff_users.created_at': 'now()',
  'support_tickets.id': "nextval('support_tickets_id_seq'::regclass)",
  'support_tickets.status': "'open'::text",
  'support_tickets.created_at': 'now()',
};

type SequenceContract = {
  dataType: 'bigint';
  startValue: '1';
  minimumValue: '1';
  maximumValue: '9223372036854775807';
  incrementBy: '1';
  cacheSize: '1';
  cycles: false;
};

const BIGSERIAL_SEQUENCE_CONTRACT: SequenceContract = {
  dataType: 'bigint',
  startValue: '1',
  minimumValue: '1',
  maximumValue: '9223372036854775807',
  incrementBy: '1',
  cacheSize: '1',
  cycles: false,
};

const CURRENT_SCHEMA_SERIAL_COLUMNS: Readonly<
  Record<string, SequenceContract>
> = {
  'customer_otp_request_attempts.id': BIGSERIAL_SEQUENCE_CONTRACT,
  'customers.id': BIGSERIAL_SEQUENCE_CONTRACT,
  'request_provider_opportunities.id': BIGSERIAL_SEQUENCE_CONTRACT,
  'service_payments.id': BIGSERIAL_SEQUENCE_CONTRACT,
  'service_quotes.id': BIGSERIAL_SEQUENCE_CONTRACT,
  'service_request_events.id': BIGSERIAL_SEQUENCE_CONTRACT,
  'service_requests.id': BIGSERIAL_SEQUENCE_CONTRACT,
  'staff_audit_events.id': BIGSERIAL_SEQUENCE_CONTRACT,
  'staff_users.id': BIGSERIAL_SEQUENCE_CONTRACT,
  'support_tickets.id': BIGSERIAL_SEQUENCE_CONTRACT,
};

const CURRENT_SCHEMA_INDEX_TOKENS: Readonly<Record<string, readonly string[]>> =
  {
    auth_login_failures_lookup_idx: [
      'auth_login_failures',
      '(scope, subject_hash, attempted_at DESC)',
    ],
    customer_otp_challenges_expires_at_idx: [
      'customer_otp_challenges',
      '(expires_at)',
    ],
    customer_otp_request_attempts_phone_requested_at_idx: [
      'customer_otp_request_attempts',
      '(phone, requested_at DESC)',
    ],
    opportunities_provider_idx: [
      'request_provider_opportunities',
      '(provider_id, status)',
    ],
    provider_access_lookup_idx: [
      'CREATE UNIQUE INDEX',
      'provider_access_credentials',
      '(lookup_id)',
      'lookup_id IS NOT NULL',
    ],
    provider_sessions_provider_expires_idx: [
      'provider_sessions',
      '(provider_id, expires_at DESC)',
    ],
    service_payments_request_created_idx: [
      'service_payments',
      '(service_request_id, id DESC)',
    ],
    service_quotes_one_active_per_provider: [
      'CREATE UNIQUE INDEX',
      'service_quotes',
      '(service_request_id, provider_id)',
      'proposed',
      'approved',
      'provider_id IS NOT NULL',
    ],
    service_quotes_provider_idx: ['service_quotes', '(provider_id)'],
    service_quotes_request_latest_idx: [
      'service_quotes',
      '(service_request_id, id DESC)',
    ],
    service_request_events_request_created_idx: [
      'service_request_events',
      '(service_request_id, id)',
    ],
    staff_audit_events_actor_created_at_idx: [
      'staff_audit_events',
      '(staff_user_id, created_at DESC)',
    ],
    staff_audit_events_subject_created_at_idx: [
      'staff_audit_events',
      '(subject_type, subject_id, created_at DESC)',
    ],
    staff_sessions_expires_at_idx: ['staff_sessions', '(expires_at)'],
  };

const CURRENT_SCHEMA_KEY_CONSTRAINTS = [
  'customer_otp_challenges:p:challenge_id',
  'customer_otp_request_attempts:p:id',
  'customer_sessions:p:token_hash',
  'customers:p:id',
  'customers:u:phone',
  'provider_access_credentials:p:provider_id',
  'provider_access_credentials:u:access_code_hash',
  'provider_sessions:p:token_hash',
  'providers:p:id',
  'public_auth_rate_limits:p:scope,subject_hash',
  'request_provider_opportunities:p:id',
  'request_provider_opportunities:u:service_request_id,provider_id',
  'service_payments:p:id',
  'service_payments:u:quote_id',
  'service_payments:u:service_request_id,quote_id',
  'service_quotes:p:id',
  'service_request_events:p:id',
  'service_requests:p:id',
  'staff_audit_events:p:id',
  'staff_sessions:p:token_hash',
  'staff_users:p:id',
  'staff_users:u:email',
  'support_tickets:p:id',
] as const;

type ForeignKeyContract = {
  sourceTable: string;
  sourceColumns: readonly string[];
  targetTable: string;
  targetColumns: readonly string[];
  updateAction: 'a';
  deleteAction: 'a';
  matchType: 's';
  deferrable: false;
  initiallyDeferred: false;
  validated: true;
};

const currentSchemaForeignKey = (
  sourceTable: string,
  sourceColumns: readonly string[],
  targetTable: string,
  targetColumns: readonly string[],
): ForeignKeyContract => ({
  sourceTable,
  sourceColumns,
  targetTable,
  targetColumns,
  updateAction: 'a',
  deleteAction: 'a',
  matchType: 's',
  deferrable: false,
  initiallyDeferred: false,
  validated: true,
});

const CURRENT_SCHEMA_FOREIGN_KEYS: readonly ForeignKeyContract[] = [
  currentSchemaForeignKey('customer_sessions', ['customer_id'], 'customers', [
    'id',
  ]),
  currentSchemaForeignKey(
    'provider_access_credentials',
    ['provider_id'],
    'providers',
    ['id'],
  ),
  currentSchemaForeignKey('provider_sessions', ['provider_id'], 'providers', [
    'id',
  ]),
  currentSchemaForeignKey(
    'request_provider_opportunities',
    ['service_request_id'],
    'service_requests',
    ['id'],
  ),
  currentSchemaForeignKey(
    'request_provider_opportunities',
    ['provider_id'],
    'providers',
    ['id'],
  ),
  currentSchemaForeignKey(
    'service_payments',
    ['service_request_id'],
    'service_requests',
    ['id'],
  ),
  currentSchemaForeignKey('service_payments', ['quote_id'], 'service_quotes', [
    'id',
  ]),
  currentSchemaForeignKey(
    'service_quotes',
    ['service_request_id'],
    'service_requests',
    ['id'],
  ),
  currentSchemaForeignKey('service_quotes', ['provider_id'], 'providers', [
    'id',
  ]),
  currentSchemaForeignKey(
    'service_request_events',
    ['service_request_id'],
    'service_requests',
    ['id'],
  ),
  currentSchemaForeignKey(
    'service_requests',
    ['assigned_provider_id'],
    'providers',
    ['id'],
  ),
  currentSchemaForeignKey('service_requests', ['customer_id'], 'customers', [
    'id',
  ]),
  currentSchemaForeignKey(
    'staff_audit_events',
    ['staff_user_id'],
    'staff_users',
    ['id'],
  ),
  currentSchemaForeignKey('staff_sessions', ['staff_user_id'], 'staff_users', [
    'id',
  ]),
  currentSchemaForeignKey(
    'support_tickets',
    ['service_request_id'],
    'service_requests',
    ['id'],
  ),
  currentSchemaForeignKey('support_tickets', ['customer_id'], 'customers', [
    'id',
  ]),
];

const CURRENT_SCHEMA_CONSTRAINT_TOKENS: Readonly<
  Record<string, readonly string[]>
> = {
  auth_login_failures_scope_check: ['staff_login', 'provider_login'],
  customer_otp_challenges_failed_attempts_check: ['failed_attempts', '>= 0'],
  providers_verification_status_check: ['pending', 'verified', 'suspended'],
  public_auth_rate_limits_attempt_count_check: ['attempt_count', '> 0'],
  public_auth_rate_limits_scope_check: [
    'customer_otp_request',
    'customer_otp_verification',
    'provider_login',
  ],
  request_provider_opportunities_status_check: [
    'invited',
    'quoted',
    'withdrawn',
    'closed',
    'rejected',
  ],
  service_payments_amount_halalas_check: ['amount_halalas', '> 0'],
  service_payments_currency_check: ['currency', 'SAR'],
  service_payments_method_check: ['cash_on_completion', 'paymob'],
  service_payments_status_check: [
    'cash_due',
    'cash_collected',
    'checkout_created',
    'paid',
    'failed',
    'refund_pending',
    'refunded',
  ],
  service_quotes_amount_halalas_check: ['amount_halalas', '> 0'],
  service_quotes_status_check: [
    'proposed',
    'approved',
    'rejected',
    'withdrawn',
  ],
  service_request_events_type_check: [
    'request_created',
    'provider_assigned',
    'status_updated',
    'quote_proposed',
    'quote_approved',
    'quote_rejected',
    'opportunity_invited',
    'opportunity_closed',
    'provider_quote_submitted',
    'provider_quote_withdrawn',
  ],
  service_requests_rating_check: ['rating', '>= 1', '<= 5'],
  staff_users_role_check: ['admin', 'dispatcher', 'support_agent'],
};

type SchemaContract = {
  columnTypes: Readonly<Record<string, Readonly<Record<string, string>>>>;
  columnDefaults: Readonly<Record<string, string>>;
  serialColumns: Readonly<Record<string, SequenceContract>>;
  indexTokens: Readonly<Record<string, readonly string[]>>;
  keyConstraints: readonly string[];
  foreignKeys: readonly ForeignKeyContract[];
  constraintTokens: Readonly<Record<string, readonly string[]>>;
};

// Migration 0001 is immutable. Keep its exact contract independent from the
// latest release so a legacy v1 schema can still be safely classified and
// baselined before 0002 is applied.
const V1_SCHEMA_CONTRACT: SchemaContract = {
  columnTypes: CURRENT_SCHEMA_COLUMN_TYPES,
  columnDefaults: CURRENT_SCHEMA_COLUMN_DEFAULTS,
  serialColumns: CURRENT_SCHEMA_SERIAL_COLUMNS,
  indexTokens: CURRENT_SCHEMA_INDEX_TOKENS,
  keyConstraints: CURRENT_SCHEMA_KEY_CONSTRAINTS,
  foreignKeys: CURRENT_SCHEMA_FOREIGN_KEYS,
  constraintTokens: CURRENT_SCHEMA_CONSTRAINT_TOKENS,
};

const V2_SCHEMA_CONTRACT: SchemaContract = {
  columnTypes: {
    ...CURRENT_SCHEMA_COLUMN_TYPES,
    service_requests: {
      ...CURRENT_SCHEMA_COLUMN_TYPES.service_requests,
      client_submission_id: 'uuid',
      submission_fingerprint: 'character(64)',
    },
    service_request_images: {
      id: 'uuid!',
      service_request_id: 'bigint!',
      storage_key: 'text!',
      mime_type: 'text!',
      byte_size: 'integer!',
      content_sha256: 'character(64)!',
      sort_order: 'smallint!',
      created_at: 'timestamp with time zone!',
    },
  },
  columnDefaults: {
    ...CURRENT_SCHEMA_COLUMN_DEFAULTS,
    'service_request_images.created_at': 'now()',
  },
  serialColumns: CURRENT_SCHEMA_SERIAL_COLUMNS,
  indexTokens: {
    ...CURRENT_SCHEMA_INDEX_TOKENS,
    service_requests_customer_submission_unique: [
      'CREATE UNIQUE INDEX',
      'service_requests',
      '(customer_id, client_submission_id)',
      'client_submission_id IS NOT NULL',
    ],
  },
  keyConstraints: [
    ...CURRENT_SCHEMA_KEY_CONSTRAINTS,
    'service_request_images:p:id',
    'service_request_images:u:storage_key',
    'service_request_images:u:service_request_id,sort_order',
    'service_request_images:u:service_request_id,content_sha256',
  ],
  foreignKeys: [
    ...CURRENT_SCHEMA_FOREIGN_KEYS,
    currentSchemaForeignKey(
      'service_request_images',
      ['service_request_id'],
      'service_requests',
      ['id'],
    ),
  ],
  constraintTokens: {
    ...CURRENT_SCHEMA_CONSTRAINT_TOKENS,
    service_requests_submission_pair_check: [
      'client_submission_id',
      'submission_fingerprint',
      'IS NULL',
    ],
    service_requests_submission_fingerprint_check: [
      'submission_fingerprint',
      '^[0-9a-f]{64}$',
    ],
    service_request_images_mime_type_check: ['mime_type', 'image/jpeg'],
    service_request_images_byte_size_check: ['byte_size', '> 0', '<= 5242880'],
    service_request_images_content_sha256_check: [
      'content_sha256',
      '^[0-9a-f]{64}$',
    ],
    service_request_images_sort_order_check: ['sort_order', '>= 0', '<= 4'],
  },
};

export type DatabaseMigration = {
  version: string;
  name: string;
  filename: string;
  checksum: string;
  sql: string;
};

export type DatabaseMigrationResult = {
  applied: string[];
  baselined: string[];
};

type AppliedMigrationRow = {
  version: string;
  name: string;
  checksum: string;
};

export function defaultMigrationsDirectory(): string {
  return join(__dirname, 'database', 'migrations');
}

export async function loadMigrations(
  directory: string,
): Promise<DatabaseMigration[]> {
  const filenames = (await readdir(directory)).filter((filename) =>
    filename.endsWith('.sql'),
  );
  const migrations = await Promise.all(
    filenames.map(async (filename): Promise<DatabaseMigration> => {
      const match = MIGRATION_FILE_PATTERN.exec(filename);
      if (!match) {
        throw new Error(
          `Invalid database migration filename '${filename}'; expected NNNN_name.sql`,
        );
      }
      const sql = (await readFile(join(directory, filename), 'utf8')).replace(
        /\r\n?/g,
        '\n',
      );
      return {
        version: match[1],
        name: match[2],
        filename,
        checksum: createHash('sha256').update(sql).digest('hex'),
        sql,
      };
    }),
  );

  migrations.sort((first, second) =>
    first.version.localeCompare(second.version),
  );
  if (migrations.length === 0) {
    throw new Error(`No database migrations were found in '${directory}'`);
  }
  if (migrations[0].version !== '0001') {
    throw new Error("First database migration must be version '0001'");
  }
  const versions = new Set<string>();
  for (const migration of migrations) {
    if (versions.has(migration.version)) {
      throw new Error(
        `Duplicate database migration version '${migration.version}'`,
      );
    }
    versions.add(migration.version);
  }
  return migrations;
}

async function rollbackOrDiscard(
  client: PoolClient,
  operationError: unknown,
  onDiscard: () => void,
): Promise<never> {
  try {
    await client.query('ROLLBACK');
  } catch (rollbackError) {
    client.release(
      rollbackError instanceof Error
        ? rollbackError
        : new Error('Database migration rollback failed'),
    );
    onDiscard();
  }
  throw operationError;
}

async function createMigrationHistory(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS moeen_schema_migrations (
      version TEXT PRIMARY KEY CHECK (version ~ '^[0-9]{4}$'),
      name TEXT NOT NULL,
      checksum CHAR(64) NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
      execution_mode TEXT NOT NULL CHECK (execution_mode IN ('applied', 'baselined')),
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(
    `SELECT version, name, checksum, execution_mode, applied_at
       FROM moeen_schema_migrations
      LIMIT 0`,
  );
}

async function migrationHistoryExists(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT to_regclass(
       format('%I.%I', current_schema(), $1::text)
     ) IS NOT NULL AS exists`,
    [MIGRATION_HISTORY_TABLE],
  );
  return result.rows[0]?.exists === true;
}

async function schemaMatchesContract(
  client: PoolClient,
  contract: SchemaContract,
): Promise<boolean> {
  const tables = await client.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_type = 'BASE TABLE'
        AND table_name <> ALL($1::text[])
      ORDER BY table_name`,
    [SCHEMA_INFRASTRUCTURE_TABLES],
  );
  const expectedTables = Object.keys(contract.columnTypes).sort();
  if (
    tables.rows.length !== expectedTables.length ||
    tables.rows.some((row, index) => row.table_name !== expectedTables[index])
  ) {
    return false;
  }

  const columns = await client.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    not_null: boolean;
    default_expression: string | null;
    identity_kind: string;
    generated_kind: string;
  }>(
    `SELECT relation_record.relname AS table_name,
            attribute_record.attname AS column_name,
            format_type(
              attribute_record.atttypid,
              attribute_record.atttypmod
            ) AS data_type,
            attribute_record.attnotnull AS not_null,
            pg_get_expr(
              default_record.adbin,
              default_record.adrelid,
              false
            ) AS default_expression,
            attribute_record.attidentity AS identity_kind,
            attribute_record.attgenerated AS generated_kind
       FROM pg_class relation_record
       JOIN pg_namespace namespace_record
         ON namespace_record.oid = relation_record.relnamespace
       JOIN pg_attribute attribute_record
         ON attribute_record.attrelid = relation_record.oid
       LEFT JOIN pg_attrdef default_record
         ON default_record.adrelid = relation_record.oid
        AND default_record.adnum = attribute_record.attnum
      WHERE namespace_record.nspname = current_schema()
        AND relation_record.relname = ANY($1::text[])
        AND relation_record.relkind IN ('r', 'p')
        AND attribute_record.attnum > 0
        AND NOT attribute_record.attisdropped`,
    [Object.keys(contract.columnTypes)],
  );
  const actualColumns = new Map(
    columns.rows.map((row) => [`${row.table_name}.${row.column_name}`, row]),
  );
  const expectedColumns = Object.entries(contract.columnTypes).flatMap(
    ([table, tableColumns]) =>
      Object.entries(tableColumns).map(
        ([column, type]) => [`${table}.${column}`, type] as const,
      ),
  );
  if (actualColumns.size !== expectedColumns.length) return false;
  for (const [column, type] of expectedColumns) {
    const actual = actualColumns.get(column);
    if (
      !actual ||
      `${actual.data_type}${actual.not_null ? '!' : ''}` !== type ||
      actual.default_expression !== (contract.columnDefaults[column] ?? null) ||
      actual.identity_kind !== '' ||
      actual.generated_kind !== ''
    ) {
      return false;
    }
  }

  const activeSchema = await client.query<{ schema_name: string }>(
    'SELECT current_schema() AS schema_name',
  );
  const expectedSchema = activeSchema.rows[0]?.schema_name;
  if (!expectedSchema) return false;

  const sequences = await client.query<{
    source_table: string;
    source_column: string;
    sequence_kind: string | null;
    sequence_schema: string | null;
    data_type: string | null;
    start_value: string | null;
    minimum_value: string | null;
    maximum_value: string | null;
    increment_by: string | null;
    cache_size: string | null;
    cycles: boolean | null;
    owner_schema: string | null;
    owner_table: string | null;
    owner_column: string | null;
  }>(
    `SELECT source.relname AS source_table,
            source_attribute.attname AS source_column,
            sequence_record.relkind AS sequence_kind,
            sequence_namespace.nspname AS sequence_schema,
            format_type(sequence_parameters.seqtypid, NULL) AS data_type,
            sequence_parameters.seqstart::text AS start_value,
            sequence_parameters.seqmin::text AS minimum_value,
            sequence_parameters.seqmax::text AS maximum_value,
            sequence_parameters.seqincrement::text AS increment_by,
            sequence_parameters.seqcache::text AS cache_size,
            sequence_parameters.seqcycle AS cycles,
            owner_namespace.nspname AS owner_schema,
            owner_relation.relname AS owner_table,
            owner_attribute.attname AS owner_column
       FROM pg_class source
       JOIN pg_namespace source_namespace
         ON source_namespace.oid = source.relnamespace
       JOIN pg_attribute source_attribute
         ON source_attribute.attrelid = source.oid
       JOIN pg_attrdef default_record
         ON default_record.adrelid = source.oid
        AND default_record.adnum = source_attribute.attnum
       LEFT JOIN pg_depend default_dependency
         ON default_dependency.classid = 'pg_attrdef'::regclass
        AND default_dependency.objid = default_record.oid
        AND default_dependency.objsubid = 0
        AND default_dependency.refclassid = 'pg_class'::regclass
        AND default_dependency.deptype = 'n'
       LEFT JOIN pg_class sequence_record
         ON sequence_record.oid = default_dependency.refobjid
       LEFT JOIN pg_namespace sequence_namespace
         ON sequence_namespace.oid = sequence_record.relnamespace
       LEFT JOIN pg_sequence sequence_parameters
         ON sequence_parameters.seqrelid = sequence_record.oid
       LEFT JOIN pg_depend ownership_dependency
         ON ownership_dependency.classid = 'pg_class'::regclass
        AND ownership_dependency.objid = sequence_record.oid
        AND ownership_dependency.objsubid = 0
        AND ownership_dependency.refclassid = 'pg_class'::regclass
        AND ownership_dependency.deptype = 'a'
       LEFT JOIN pg_class owner_relation
         ON owner_relation.oid = ownership_dependency.refobjid
       LEFT JOIN pg_namespace owner_namespace
         ON owner_namespace.oid = owner_relation.relnamespace
       LEFT JOIN pg_attribute owner_attribute
         ON owner_attribute.attrelid = owner_relation.oid
        AND owner_attribute.attnum = ownership_dependency.refobjsubid
      WHERE source_namespace.nspname = current_schema()
        AND source.relkind IN ('r', 'p')
        AND source_attribute.attnum > 0
        AND NOT source_attribute.attisdropped
        AND source.relname || '.' || source_attribute.attname = ANY($1::text[])`,
    [Object.keys(contract.serialColumns)],
  );
  if (sequences.rows.length !== Object.keys(contract.serialColumns).length) {
    return false;
  }
  const actualSequences = new Map(
    sequences.rows.map((row) => [
      `${row.source_table}.${row.source_column}`,
      row,
    ]),
  );
  if (actualSequences.size !== sequences.rows.length) return false;
  for (const [serialColumn, expected] of Object.entries(
    contract.serialColumns,
  )) {
    const [sourceTable, sourceColumn] = serialColumn.split('.');
    const actual = actualSequences.get(serialColumn);
    if (
      !actual ||
      actual.sequence_kind !== 'S' ||
      actual.sequence_schema !== expectedSchema ||
      actual.owner_schema !== expectedSchema ||
      actual.owner_table !== sourceTable ||
      actual.owner_column !== sourceColumn ||
      actual.data_type !== expected.dataType ||
      actual.start_value !== expected.startValue ||
      actual.minimum_value !== expected.minimumValue ||
      actual.maximum_value !== expected.maximumValue ||
      actual.increment_by !== expected.incrementBy ||
      actual.cache_size !== expected.cacheSize ||
      actual.cycles !== expected.cycles
    ) {
      return false;
    }
  }

  const foreignKeys = await client.query<{
    source_schema: string;
    source_table: string;
    source_columns: string[];
    target_schema: string;
    target_table: string;
    target_columns: string[];
    update_action: string;
    delete_action: string;
    match_type: string;
    deferrable: boolean;
    initially_deferred: boolean;
    validated: boolean;
  }>(
    `SELECT source_namespace.nspname AS source_schema,
            source.relname AS source_table,
            array_agg(
              source_attribute.attname::text
              ORDER BY key_pair.position
            ) AS source_columns,
            target_namespace.nspname AS target_schema,
            target.relname AS target_table,
            array_agg(
              target_attribute.attname::text
              ORDER BY key_pair.position
            ) AS target_columns,
            constraint_record.confupdtype AS update_action,
            constraint_record.confdeltype AS delete_action,
            constraint_record.confmatchtype AS match_type,
            constraint_record.condeferrable AS deferrable,
            constraint_record.condeferred AS initially_deferred,
            constraint_record.convalidated AS validated
       FROM pg_constraint constraint_record
       JOIN pg_class source ON source.oid = constraint_record.conrelid
       JOIN pg_namespace source_namespace
         ON source_namespace.oid = source.relnamespace
       JOIN pg_class target ON target.oid = constraint_record.confrelid
       JOIN pg_namespace target_namespace
         ON target_namespace.oid = target.relnamespace
       JOIN unnest(constraint_record.conkey, constraint_record.confkey)
         WITH ORDINALITY AS key_pair(source_number, target_number, position)
         ON TRUE
       JOIN pg_attribute source_attribute
         ON source_attribute.attrelid = source.oid
        AND source_attribute.attnum = key_pair.source_number
       JOIN pg_attribute target_attribute
         ON target_attribute.attrelid = target.oid
        AND target_attribute.attnum = key_pair.target_number
      WHERE constraint_record.contype = 'f'
        AND source_namespace.nspname = current_schema()
        AND source.relname = ANY($1::text[])
        AND source.relkind IN ('r', 'p')
      GROUP BY constraint_record.oid,
               source_namespace.nspname,
               source.relname,
               target_namespace.nspname,
               target.relname,
               constraint_record.confupdtype,
               constraint_record.confdeltype,
               constraint_record.confmatchtype,
               constraint_record.condeferrable,
               constraint_record.condeferred,
               constraint_record.convalidated`,
    [Object.keys(contract.columnTypes)],
  );
  const foreignKeyKey = (foreignKey: {
    sourceSchema: string;
    sourceTable: string;
    sourceColumns: readonly string[];
    targetSchema: string;
    targetTable: string;
    targetColumns: readonly string[];
    updateAction: string;
    deleteAction: string;
    matchType: string;
    deferrable: boolean;
    initiallyDeferred: boolean;
    validated: boolean;
  }): string => JSON.stringify(foreignKey);
  const actualForeignKeys = foreignKeys.rows
    .map((row) =>
      foreignKeyKey({
        sourceSchema: row.source_schema,
        sourceTable: row.source_table,
        sourceColumns: row.source_columns,
        targetSchema: row.target_schema,
        targetTable: row.target_table,
        targetColumns: row.target_columns,
        updateAction: row.update_action,
        deleteAction: row.delete_action,
        matchType: row.match_type,
        deferrable: row.deferrable,
        initiallyDeferred: row.initially_deferred,
        validated: row.validated,
      }),
    )
    .sort();
  const expectedForeignKeys = contract.foreignKeys
    .map((foreignKey) =>
      foreignKeyKey({
        sourceSchema: expectedSchema,
        sourceTable: foreignKey.sourceTable,
        sourceColumns: foreignKey.sourceColumns,
        targetSchema: expectedSchema,
        targetTable: foreignKey.targetTable,
        targetColumns: foreignKey.targetColumns,
        updateAction: foreignKey.updateAction,
        deleteAction: foreignKey.deleteAction,
        matchType: foreignKey.matchType,
        deferrable: foreignKey.deferrable,
        initiallyDeferred: foreignKey.initiallyDeferred,
        validated: foreignKey.validated,
      }),
    )
    .sort();
  if (
    actualForeignKeys.length !== expectedForeignKeys.length ||
    actualForeignKeys.some(
      (foreignKey, index) => foreignKey !== expectedForeignKeys[index],
    )
  ) {
    return false;
  }

  const keyConstraints = await client.query<{
    table_name: string;
    constraint_type: string;
    columns: string;
  }>(
    `SELECT source.relname AS table_name,
            constraint_record.contype AS constraint_type,
            string_agg(
              attribute_record.attname,
              ','
              ORDER BY key_position.position
            ) AS columns
       FROM pg_constraint constraint_record
       JOIN pg_class source ON source.oid = constraint_record.conrelid
       JOIN pg_namespace namespace_record
         ON namespace_record.oid = source.relnamespace
       JOIN unnest(constraint_record.conkey) WITH ORDINALITY
         AS key_position(attnum, position) ON TRUE
       JOIN pg_attribute attribute_record
         ON attribute_record.attrelid = source.oid
        AND attribute_record.attnum = key_position.attnum
      WHERE constraint_record.contype IN ('p', 'u')
        AND namespace_record.nspname = current_schema()
        AND source.relname = ANY($1::text[])
        AND source.relkind IN ('r', 'p')
      GROUP BY source.relname, constraint_record.contype, constraint_record.conkey`,
    [Object.keys(contract.columnTypes)],
  );
  const actualKeyConstraints = new Set(
    keyConstraints.rows.map(
      (row) => `${row.table_name}:${row.constraint_type}:${row.columns}`,
    ),
  );
  for (const requiredKey of contract.keyConstraints) {
    if (!actualKeyConstraints.has(requiredKey)) {
      return false;
    }
  }

  const indexes = await client.query<{
    indexname: string;
    indexdef: string;
  }>(
    `SELECT indexname, indexdef
       FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname = ANY($1::text[])`,
    [Object.keys(contract.indexTokens)],
  );
  const indexDefinitions = new Map(
    indexes.rows.map((row) => [row.indexname, row.indexdef]),
  );
  for (const [indexName, tokens] of Object.entries(contract.indexTokens)) {
    const definition = indexDefinitions.get(indexName);
    if (!definition || tokens.some((token) => !definition.includes(token))) {
      return false;
    }
  }

  const constraints = await client.query<{
    constraint_name: string;
    definition: string;
  }>(
    `SELECT c.conname AS constraint_name,
            pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = current_schema()
        AND c.conname = ANY($1::text[])`,
    [Object.keys(contract.constraintTokens)],
  );
  const definitions = new Map(
    constraints.rows.map((row) => [row.constraint_name, row.definition]),
  );
  for (const [constraint, tokens] of Object.entries(
    contract.constraintTokens,
  )) {
    const definition = definitions.get(constraint);
    if (!definition || tokens.some((token) => !definition.includes(token))) {
      return false;
    }
  }
  return true;
}

async function initialSchemaHasUserObjects(
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query<{ has_user_objects: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM pg_class relation_record
         JOIN pg_namespace namespace_record
           ON namespace_record.oid = relation_record.relnamespace
        WHERE namespace_record.nspname = current_schema()
          AND relation_record.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
          AND relation_record.relname <> ALL($1::text[])
       UNION ALL
       SELECT 1
         FROM pg_proc procedure_record
         JOIN pg_namespace namespace_record
           ON namespace_record.oid = procedure_record.pronamespace
        WHERE namespace_record.nspname = current_schema()
       UNION ALL
       SELECT 1
         FROM pg_type type_record
         JOIN pg_namespace namespace_record
           ON namespace_record.oid = type_record.typnamespace
        WHERE namespace_record.nspname = current_schema()
          AND type_record.typrelid = 0
          AND type_record.typtype IN ('d', 'e', 'm', 'r')
     ) AS has_user_objects`,
    [SCHEMA_INFRASTRUCTURE_TABLES],
  );
  return result.rows[0]?.has_user_objects === true;
}

type InitialSchemaState = 'empty' | 'current';

async function classifyInitialSchema(
  client: PoolClient,
): Promise<InitialSchemaState> {
  if (await schemaMatchesContract(client, V1_SCHEMA_CONTRACT)) return 'current';
  if (await initialSchemaHasUserObjects(client)) {
    throw new Error(
      "Refusing to apply initial database migration '0001': the active schema is non-empty but does not match the supported current Moeen schema. Restore a compatible schema or resolve the partial/unknown objects before retrying.",
    );
  }
  return 'empty';
}

function contractForMigration(
  migration: DatabaseMigration | undefined,
): SchemaContract | undefined {
  if (migration?.version === '0001') return V1_SCHEMA_CONTRACT;
  if (
    migration?.version === '0002' &&
    migration.name === 'service_request_images'
  ) {
    return V2_SCHEMA_CONTRACT;
  }
  return undefined;
}

function validateAppliedMigrations(
  available: readonly DatabaseMigration[],
  applied: readonly AppliedMigrationRow[],
): Set<string> {
  const availableByVersion = new Map(
    available.map((migration) => [migration.version, migration]),
  );
  for (const [index, row] of applied.entries()) {
    const migration = availableByVersion.get(row.version);
    if (!migration) {
      throw new Error(
        `Database migration '${row.version}' is applied but missing from this release`,
      );
    }
    if (row.name !== migration.name || row.checksum !== migration.checksum) {
      throw new Error(
        `Database migration '${row.version}' does not match its applied history`,
      );
    }
    if (available[index]?.version !== row.version) {
      throw new Error(
        `Database migration history is not a contiguous version prefix at '${row.version}'`,
      );
    }
  }
  return new Set(applied.map((row) => row.version));
}

export async function runDatabaseMigrations(
  pool: Pool,
  directory = defaultMigrationsDirectory(),
): Promise<DatabaseMigrationResult> {
  const migrations = await loadMigrations(directory);
  const result: DatabaseMigrationResult = { applied: [], baselined: [] };
  const client = await pool.connect();
  let released = false;
  let locked = false;
  let initialSchemaState: InitialSchemaState | undefined;
  try {
    await client.query(
      `SELECT pg_advisory_lock(
         hashtextextended(
           current_database() || ':' || current_schema() || ':' || $1,
           0
         )
       )`,
      [MIGRATION_LOCK_NAMESPACE],
    );
    locked = true;

    await client.query('BEGIN');
    try {
      await client.query(LEGACY_STARTUP_DDL_LOCK_SQL);
      const hadMigrationHistory = await migrationHistoryExists(client);
      if (!hadMigrationHistory) {
        initialSchemaState = await classifyInitialSchema(client);
      }
      await createMigrationHistory(client);
      if (hadMigrationHistory) {
        const historyCount = await client.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM moeen_schema_migrations',
        );
        if (historyCount.rows[0]?.count === 0) {
          initialSchemaState = await classifyInitialSchema(client);
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await rollbackOrDiscard(client, error, () => {
        released = true;
      });
    }

    const history = await client.query<AppliedMigrationRow>(
      `SELECT version, name, checksum
         FROM moeen_schema_migrations
        ORDER BY version`,
    );
    const applied = validateAppliedMigrations(migrations, history.rows);

    if (history.rows.length > 0) {
      const lastApplied = migrations[history.rows.length - 1];
      const appliedContract = contractForMigration(lastApplied);
      if (
        appliedContract &&
        !(await schemaMatchesContract(client, appliedContract))
      ) {
        throw new Error(
          `Database schema does not satisfy applied migration '${lastApplied.version}'`,
        );
      }
    }

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      await client.query('BEGIN');
      try {
        await client.query(LEGACY_STARTUP_DDL_LOCK_SQL);
        const baseline =
          migration.version === '0001' && initialSchemaState === 'current';
        if (migration.version === '0001' && !initialSchemaState) {
          throw new Error(
            "Database migration history is inconsistent: version '0001' is pending after a non-empty applied history",
          );
        }
        if (!baseline) {
          await client.query(migration.sql);
        }
        const expectedContract = contractForMigration(migration);
        if (
          expectedContract &&
          !(await schemaMatchesContract(client, expectedContract))
        ) {
          throw new Error(
            `Database schema does not satisfy migration '${migration.version}' after execution`,
          );
        }
        await client.query(
          `INSERT INTO moeen_schema_migrations
             (version, name, checksum, execution_mode)
           VALUES ($1, $2, $3, $4)`,
          [
            migration.version,
            migration.name,
            migration.checksum,
            baseline ? 'baselined' : 'applied',
          ],
        );
        await client.query('COMMIT');
        (baseline ? result.baselined : result.applied).push(migration.version);
      } catch (error) {
        await rollbackOrDiscard(client, error, () => {
          released = true;
        });
      }
    }
    const latestContract = contractForMigration(migrations.at(-1));
    if (
      latestContract &&
      !(await schemaMatchesContract(client, latestContract))
    ) {
      throw new Error(
        'Database schema does not satisfy the current migration release',
      );
    }
    return result;
  } finally {
    if (!released) {
      if (locked) {
        try {
          await client.query(
            `SELECT pg_advisory_unlock(
               hashtextextended(
                 current_database() || ':' || current_schema() || ':' || $1,
                 0
               )
             )`,
            [MIGRATION_LOCK_NAMESPACE],
          );
        } catch (unlockError) {
          client.release(
            unlockError instanceof Error
              ? unlockError
              : new Error('Database migration lock release failed'),
          );
          released = true;
        }
      }
      if (!released) client.release();
    }
  }
}

export async function runDatabaseMigrationsFromEnvironment(): Promise<DatabaseMigrationResult> {
  const pool = new Pool({
    connectionString: resolveDatabaseConnectionString(),
  });
  try {
    return await runDatabaseMigrations(pool);
  } finally {
    await pool.end();
  }
}

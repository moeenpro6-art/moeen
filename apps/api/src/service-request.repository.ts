import { createHash, randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { resolveDatabaseConnectionString } from './database.config';
import {
  hashProviderAccessCode,
  isLegacyProviderAccessCodeHash,
  providerAccessCodeLookupId,
  verifyDummyProviderAccessCode,
  verifyProviderAccessCode,
} from './provider-access-code';
import type {
  CreatePilotProvider,
  CreateServiceRequest,
  Customer,
  PilotProvider,
  PilotProviderVerificationStatus,
  ProviderAppPrincipal,
  ServiceRequest,
  ServiceRequestEvent,
  ServiceRequestEventType,
  ServicePayment,
  ServicePaymentMethod,
  ServicePaymentStatus,
  ServiceQuote,
  ServiceQuoteStatus,
  CustomerQuoteProviderSummary,
  CustomerQuoteView,
  ProviderOpportunity,
  ProviderOpportunityAccess,
  ProviderOpportunityStatus,
  ServiceRequestStore,
  SupportCategory,
  SupportTicket,
  SupportTicketStatus,
} from './app.service';
import {
  toStaffDatabaseId,
  type StaffAuditSpec,
} from './staff-auth.repository';
import {
  RequestSubmissionConflictError,
  RequestSubmissionReplayError,
  type ServiceRequestSubmissionContext,
} from './request-image-create.contracts';
import type { StoredRequestImage } from './request-image.types';
import { fcmConfigFromEnvironment } from './fcm.config';
import { assertBroadAuditLocationSafe } from './location-privacy';
import { NotificationOutboxWriter } from './notification-outbox.writer';
import {
  customerStatusNotificationType,
  toRequestPublicId,
  type FcmNotificationType,
} from './notification-templates';

type ServiceRequestImageRow = {
  id: string;
  storage_key: string;
  mime_type: string;
  byte_size: number;
  content_sha256: string;
  sort_order: number;
};

const CLIENT_SUBMISSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ServiceRequestRow = {
  id: string;
  service_id: string;
  address: string;
  location_latitude: string | number | null;
  location_longitude: string | number | null;
  location_source: 'current_location' | 'map_pin' | null;
  location_confirmed_at: Date | null;
  details: string | null;
  timing: CreateServiceRequest['timing'];
  status: ServiceRequest['status'];
  // Present only when the reading query joins the customer (the assigned-
  // provider read path). Other read paths leave it undefined, so the mapper
  // can never populate it from rows that were not authorized to carry it.
  customer_phone: string | null;
  assigned_provider_id: string | null;
  assigned_provider_name: string | null;
  assigned_provider_specialties: string[] | null;
  assigned_provider_available: boolean | null;
  rating: number | null;
  rating_comment: string | null;
  quote_id: string | null;
  quote_provider_id: string | null;
  quote_provider_name: string | null;
  quote_amount_halalas: number | null;
  quote_scope: string | null;
  quote_status: ServiceQuoteStatus | null;
  quote_proposed_at: Date | null;
  quote_decided_at: Date | null;
  opportunity_invited: number | null;
  opportunity_quoted: number | null;
  opportunity_withdrawn: number | null;
  opportunity_closed: number | null;
  opportunity_rejected: number | null;
  opportunity_total: number | null;
  payment_id: string | null;
  payment_amount_halalas: number | null;
  payment_currency: 'SAR' | null;
  payment_method: ServicePaymentMethod | null;
  payment_status: ServicePaymentStatus | null;
  payment_created_at: Date | null;
  payment_collected_at: Date | null;
  payment_refunded_at: Date | null;
  created_at: Date;
};

type ServiceRequestEventRow = {
  type: ServiceRequestEventType;
  status: ServiceRequest['status'];
  created_at: Date;
};

type ServiceQuoteRow = {
  id: string;
  provider_id: string | null;
  provider_name?: string | null;
  amount_halalas: number;
  scope: string;
  status: ServiceQuoteStatus;
  proposed_at: Date;
  decided_at: Date | null;
};

export class ProviderQuoteConflictError extends Error {
  constructor() {
    super('You already have an active quote for this request');
  }
}

export class ProviderOpportunityClosedError extends Error {
  constructor() {
    super('Provider opportunity is not open for quoting');
  }
}

export class StaffQuoteInMarketplaceFlowError extends Error {
  constructor() {
    super(
      'Request is in the marketplace quote flow; staff quotes are not allowed',
    );
  }
}

export class ProviderUnavailableForApprovalError extends Error {
  constructor() {
    super('The selected provider is not available; choose another quote');
  }
}

type ServicePaymentRow = {
  id: string;
  amount_halalas: number;
  currency: 'SAR';
  method: ServicePaymentMethod;
  status: ServicePaymentStatus;
  created_at: Date;
  collected_at: Date | null;
  refunded_at: Date | null;
};

type SupportTicketRow = {
  id: string;
  service_request_id: string;
  category: SupportCategory;
  comment: string;
  status: SupportTicketStatus;
  created_at: Date;
};

export type StoredOtpChallenge = {
  challengeId: string;
  phone: string;
  expiresAt: Date;
  failedAttempts: number;
};

type OtpChallengeRow = {
  challenge_id: string;
  phone: string;
  expires_at: Date;
  failed_attempts: number;
};

type PilotProviderRow = {
  id: string;
  name: string;
  specialties: string[];
  available: boolean;
  service_zone: string;
  verification_status: PilotProviderVerificationStatus;
};

type ProviderAccessRow = PilotProviderRow & {
  access_code_hash: string;
};

@Injectable()
export class ServiceRequestRepository
  implements ServiceRequestStore, OnModuleInit, OnModuleDestroy
{
  private readonly pool = new Pool({
    connectionString: resolveDatabaseConnectionString(),
  });

  private readonly notificationOutbox: NotificationOutboxWriter;

  constructor(
    @Optional()
    @Inject(NotificationOutboxWriter)
    notificationOutbox?: NotificationOutboxWriter,
  ) {
    // AppModule injects the shared, fully configured writer. Direct repository
    // construction in focused tests remains supported and follows the same
    // environment contract instead of silently forcing notifications off.
    this.notificationOutbox =
      notificationOutbox ??
      new NotificationOutboxWriter(fcmConfigFromEnvironment(process.env));
  }

  /**
   * Enqueues a customer-recipient notification inside the caller's domain
   * transaction. The recipient identity is always the server-side customer
   * database id captured at the mutation site -- never a client-supplied
   * value. A null customer id (legacy service-request rows with nullable
   * ownership, FCM-2 HIGH #2) is preserved and passed through so the writer
   * deterministically SKIPS the notification instead of the repository
   * coercing it into a fabricated customer 0 that would fail the FK and
   * roll back an otherwise-valid domain mutation.
   */
  private enqueueCustomerNotification(
    client: PoolClient,
    args: {
      notificationType: FcmNotificationType;
      serviceRequestDatabaseId: number;
      customerDatabaseId: number | null;
      dedupeKey: string;
      reliability?: 'required' | 'best-effort';
    },
  ): Promise<void> {
    return this.notificationOutbox.writeOnClient(client, {
      notificationType: args.notificationType,
      serviceRequestDatabaseId: args.serviceRequestDatabaseId,
      recipient:
        args.customerDatabaseId === null
          ? undefined
          : {
              ownerKind: 'customer',
              customerDatabaseId: args.customerDatabaseId,
            },
      dedupeKey: args.dedupeKey,
      requestPublicId: toRequestPublicId(args.serviceRequestDatabaseId),
      reliability: args.reliability,
    });
  }

  /**
   * Enqueues a provider-recipient notification inside the caller's domain
   * transaction. The provider id comes from the server-side domain state at
   * the mutation site (opportunity/quote/assignment rows), never from a
   * client body.
   */
  private enqueueProviderNotification(
    client: PoolClient,
    args: {
      notificationType: FcmNotificationType;
      serviceRequestDatabaseId: number;
      providerId: string;
      dedupeKey: string;
    },
  ): Promise<void> {
    return this.notificationOutbox.writeOnClient(client, {
      notificationType: args.notificationType,
      serviceRequestDatabaseId: args.serviceRequestDatabaseId,
      recipient: { ownerKind: 'provider', providerId: args.providerId },
      dedupeKey: args.dedupeKey,
      requestPublicId: toRequestPublicId(args.serviceRequestDatabaseId),
    });
  }

  /**
   * Fail-safe cleanup for a transaction-scoped pool client.
   *
   * Whenever a transaction may have started, ROLLBACK is attempted before any
   * release (ROLLBACK outside a transaction is a harmless no-op warning in
   * PostgreSQL). When rollback succeeds the client is released to the pool
   * normally; when rollback fails, the connection state cannot be proven
   * clean, so the client is destroyed via the pg pool release-error semantics
   * (`release(error)`) and is never returned to the pool as a healthy
   * reusable connection. Exactly one release (or destroy) happens per call.
   */
  private async rollbackAndRelease(client: PoolClient): Promise<void> {
    try {
      await client.query('ROLLBACK');
      client.release();
    } catch (rollbackError) {
      client.release(rollbackError as Error);
    }
  }

  /**
   * Inserts a required staff audit record on the CALLER'S transaction client
   * (B5 atomic audit). The spec carries only identity fields; oldState and
   * newState are the authoritative in-transaction snapshots captured by the
   * executing command. Any failure (including the staff_users FK check) makes
   * the enclosing transaction roll back, so the domain mutation and its audit
   * evidence commit or fail together.
   */
  private async insertStaffAuditEvent(
    client: PoolClient,
    spec: StaffAuditSpec,
    oldState?: Record<string, unknown>,
    newState?: Record<string, unknown>,
  ): Promise<void> {
    assertBroadAuditLocationSafe(oldState);
    assertBroadAuditLocationSafe(newState);
    await client.query(
      `INSERT INTO staff_audit_events
        (staff_user_id, action, subject_type, subject_id, old_state, new_state)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        toStaffDatabaseId(spec.staffId),
        spec.action,
        spec.subjectType,
        spec.subjectId,
        oldState ?? null,
        newState ?? null,
      ],
    );
  }

  async onModuleInit(): Promise<void> {
    await this.initialize();
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  async initialize(): Promise<void> {
    // Concurrent same-schema initialization is serialized on a
    // schema-keyed advisory lock held for the WHOLE init protocol
    // (transaction-scoped: released automatically at COMMIT/ROLLBACK).
    // All statements run on ONE dedicated connection in ONE
    // transaction, so the catalog races of concurrent
    // CREATE TABLE/CREATE INDEX/ALTER (e.g. duplicate key on
    // pg_type_typname_nsp_index) become deterministic: the loser blocks
    // on the lock, then re-reads the committed state and every
    // IF NOT EXISTS / DO-block migration converges.
    const client = await this.pool.connect();
    let released = false;
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended(current_schema(), 0))',
      );
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS customers (
            id BIGSERIAL PRIMARY KEY,
            phone TEXT UNIQUE NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await client.query(`
          CREATE TABLE IF NOT EXISTS customer_sessions (
            token_hash TEXT PRIMARY KEY,
            customer_id BIGINT NOT NULL REFERENCES customers(id),
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await client.query(`
          CREATE TABLE IF NOT EXISTS customer_otp_challenges (
            challenge_id UUID PRIMARY KEY,
            phone TEXT NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            failed_attempts SMALLINT NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await client.query(
          'CREATE INDEX IF NOT EXISTS customer_otp_challenges_expires_at_idx ON customer_otp_challenges (expires_at)',
        );
        await client.query(`
          CREATE TABLE IF NOT EXISTS customer_otp_request_attempts (
            id BIGSERIAL PRIMARY KEY,
            phone TEXT NOT NULL,
            requested_at TIMESTAMPTZ NOT NULL
          )
        `);
        await client.query(
          'CREATE INDEX IF NOT EXISTS customer_otp_request_attempts_phone_requested_at_idx ON customer_otp_request_attempts (phone, requested_at DESC)',
        );
        await client.query(`
          CREATE TABLE IF NOT EXISTS providers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            specialties TEXT[] NOT NULL,
            available BOOLEAN NOT NULL DEFAULT TRUE
          )
        `);
        await client.query(
          "ALTER TABLE providers ADD COLUMN IF NOT EXISTS service_zone TEXT NOT NULL DEFAULT 'بريدة'",
        );
        await client.query(
          "ALTER TABLE providers ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending', 'verified', 'suspended'))",
        );
        await client.query(`
          CREATE TABLE IF NOT EXISTS provider_access_credentials (
            provider_id TEXT PRIMARY KEY REFERENCES providers(id),
            access_code_hash TEXT UNIQUE NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        // Indexed access-code lookup (SHA-256 lookup id) with a uniqueness
        // constraint as the final protection. Idempotent; no destructive DDL.
        await client.query(
          'ALTER TABLE provider_access_credentials ADD COLUMN IF NOT EXISTS lookup_id TEXT',
        );
        await client.query(
          `CREATE UNIQUE INDEX IF NOT EXISTS provider_access_lookup_idx
           ON provider_access_credentials (lookup_id)
           WHERE lookup_id IS NOT NULL`,
        );
        // Backfill lookup ids only where safely derivable: legacy SHA-256 hashes
        // are exactly sha256(accessCode). Salted scrypt hashes cannot be derived
        // and must be rotated by operations (login fails generically until then).
        await client.query(
          `UPDATE provider_access_credentials
           SET lookup_id = access_code_hash
           WHERE lookup_id IS NULL AND access_code_hash ~ '^[a-f0-9]{64}$'`,
        );
        await client.query(`
          CREATE TABLE IF NOT EXISTS provider_sessions (
            token_hash TEXT PRIMARY KEY,
            provider_id TEXT NOT NULL REFERENCES providers(id),
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await client.query(
          'CREATE INDEX IF NOT EXISTS provider_sessions_provider_expires_idx ON provider_sessions (provider_id, expires_at DESC)',
        );
        if (process.env.NODE_ENV === 'test') {
          await client.query(`
            INSERT INTO providers (id, name, specialties, available, service_zone, verification_status)
            VALUES
              ('provider-1', 'فريق التبريد السريع', ARRAY['ac-cleaning'], TRUE, 'بريدة', 'verified'),
              ('provider-2', 'مؤسسة النظافة المنزلية', ARRAY['upholstery', 'home-cleaning', 'tank-cleaning'], TRUE, 'بريدة', 'verified'),
              ('provider-3', 'فني السباكة محمد', ARRAY['plumbing'], TRUE, 'بريدة', 'verified')
            ON CONFLICT (id) DO UPDATE
            SET verification_status = 'verified', available = TRUE
          `);
        }
        await client.query(`
          CREATE TABLE IF NOT EXISTS service_requests (
            id BIGSERIAL PRIMARY KEY,
            service_id TEXT NOT NULL,
            address TEXT NOT NULL,
            details TEXT,
            timing TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending_dispatch',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await client.query(
          'ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS assigned_provider_id TEXT REFERENCES providers(id)',
        );
        await client.query(
          'ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS customer_id BIGINT REFERENCES customers(id)',
        );
        await client.query(
          'ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS rating SMALLINT CHECK (rating BETWEEN 1 AND 5)',
        );
        await client.query(
          'ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS rating_comment TEXT',
        );
        // Migration 0002 objects (idempotent): the versioned migration runner
        // applies these in deployed environments before the app boots; here
        // they are replayed additively so repository-level tests and legacy
        // bootstraps converge on the same schema. Every statement is a no-op
        // when the objects already exist, and the whole block runs inside the
        // schema-keyed advisory-lock transaction that serializes initialize().
        await client.query(
          'ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS client_submission_id UUID',
        );
        await client.query(
          'ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS submission_fingerprint CHAR(64)',
        );
        await client.query(`
          DO $$
          BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM pg_constraint
              WHERE conname = 'service_requests_submission_pair_check'
                AND conrelid = to_regclass('service_requests')
            ) THEN
              ALTER TABLE service_requests
                ADD CONSTRAINT service_requests_submission_pair_check
                CHECK (
                  (client_submission_id IS NULL) =
                  (submission_fingerprint IS NULL)
                );
            END IF;
            IF NOT EXISTS (
              SELECT 1 FROM pg_constraint
              WHERE conname = 'service_requests_submission_fingerprint_check'
                AND conrelid = to_regclass('service_requests')
            ) THEN
              ALTER TABLE service_requests
                ADD CONSTRAINT service_requests_submission_fingerprint_check
                CHECK (
                  submission_fingerprint IS NULL
                  OR submission_fingerprint ~ '^[0-9a-f]{64}$'
                );
            END IF;
          END $$;
        `);
        await client.query(
          `CREATE UNIQUE INDEX IF NOT EXISTS service_requests_customer_submission_unique
           ON service_requests (customer_id, client_submission_id)
           WHERE client_submission_id IS NOT NULL`,
        );
        await client.query(`
          CREATE TABLE IF NOT EXISTS service_request_images (
            id UUID PRIMARY KEY,
            service_request_id BIGINT NOT NULL
              REFERENCES service_requests(id) ON DELETE NO ACTION,
            storage_key TEXT NOT NULL UNIQUE,
            mime_type TEXT NOT NULL
              CONSTRAINT service_request_images_mime_type_check
              CHECK (mime_type = 'image/jpeg'),
            byte_size INTEGER NOT NULL
              CONSTRAINT service_request_images_byte_size_check
              CHECK (byte_size > 0 AND byte_size <= 5242880),
            content_sha256 CHAR(64) NOT NULL
              CONSTRAINT service_request_images_content_sha256_check
              CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
            sort_order SMALLINT NOT NULL
              CONSTRAINT service_request_images_sort_order_check
              CHECK (sort_order BETWEEN 0 AND 4),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT service_request_images_request_sort_unique
              UNIQUE (service_request_id, sort_order),
            CONSTRAINT service_request_images_request_content_unique
              UNIQUE (service_request_id, content_sha256)
          )
        `);
        await client.query(`
          CREATE TABLE IF NOT EXISTS service_request_events (
            id BIGSERIAL PRIMARY KEY,
            service_request_id BIGINT NOT NULL REFERENCES service_requests(id),
            type TEXT NOT NULL CHECK (type IN ('request_created', 'provider_assigned', 'status_updated', 'quote_proposed', 'quote_approved', 'quote_rejected', 'opportunity_invited', 'opportunity_closed', 'provider_quote_submitted', 'provider_quote_withdrawn')),
            status TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await client.query(
          'CREATE INDEX IF NOT EXISTS service_request_events_request_created_idx ON service_request_events (service_request_id, id)',
        );
        await client.query(`
          CREATE TABLE IF NOT EXISTS service_quotes (
            id BIGSERIAL PRIMARY KEY,
            service_request_id BIGINT NOT NULL REFERENCES service_requests(id),
            amount_halalas INTEGER NOT NULL CHECK (amount_halalas > 0),
            scope TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected', 'withdrawn')) DEFAULT 'proposed',
            proposed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            decided_at TIMESTAMPTZ
          )
        `);
        await client.query(
          'CREATE INDEX IF NOT EXISTS service_quotes_request_latest_idx ON service_quotes (service_request_id, id DESC)',
        );
        // Provider-owned marketplace quotes (additive; staff quotes keep provider_id NULL)
        await client.query(
          'ALTER TABLE service_quotes ADD COLUMN IF NOT EXISTS provider_id TEXT REFERENCES providers(id)',
        );
        await client.query(
          'CREATE INDEX IF NOT EXISTS service_quotes_provider_idx ON service_quotes (provider_id)',
        );
        // Final concurrency protection: one active provider quote per provider per request
        await client.query(
          `CREATE UNIQUE INDEX IF NOT EXISTS service_quotes_one_active_per_provider
           ON service_quotes (service_request_id, provider_id)
           WHERE status IN ('proposed', 'approved') AND provider_id IS NOT NULL`,
        );
        await client.query(`
          CREATE TABLE IF NOT EXISTS request_provider_opportunities (
            id BIGSERIAL PRIMARY KEY,
            service_request_id BIGINT NOT NULL REFERENCES service_requests(id),
            provider_id TEXT NOT NULL REFERENCES providers(id),
            status TEXT NOT NULL DEFAULT 'invited'
              CHECK (status IN ('invited', 'quoted', 'withdrawn', 'closed', 'rejected')),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (service_request_id, provider_id)
          )
        `);
        await client.query(
          'CREATE INDEX IF NOT EXISTS opportunities_provider_idx ON request_provider_opportunities (provider_id, status)',
        );
        // Extend the quote status CHECK with 'withdrawn' (controlled, idempotent,
        // race-safe). The complete inspect/alter protocol is SERIALIZED on the
        // exact schema-qualified table: an ACCESS EXCLUSIVE table lock is
        // acquired BEFORE any introspection (pg_constraint scan +
        // pg_get_constraintdef) and held through the ALTER inside the same
        // statement/transaction, so the object inspected is guaranteed to be the
        // object altered — no constraint OID can go stale between the two.
        // Concurrent same-schema initializers block on the lock and then re-read
        // the (already migrated) definition, so the outcome is deterministic.
        // The OID picked is always from THIS schema's relation only (a single
        // to_regclass lookup — no pg_get_constraintdef call inside any
        // pg_constraint scan), so a schema being dropped concurrently by a
        // parallel run can never make it open a dropped relation ("could not open
        // relation with OID ..."); the ALTER runs with a schema-qualified, safely
        // quoted table name — no dependence on search_path.
        await client.query(`
          DO $$
          DECLARE
            exact_schema text := current_schema();
            selected_constraint_oid oid;
            constraint_def text;
          BEGIN
            EXECUTE format(
              'LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE',
              exact_schema, 'service_quotes'
            );
            SELECT c.oid
              INTO selected_constraint_oid
              FROM pg_constraint c
             WHERE c.conrelid = to_regclass(
                     format('%I.%I', exact_schema, 'service_quotes')
                   )
               AND c.conname = 'service_quotes_status_check';

            IF selected_constraint_oid IS NOT NULL THEN
              SELECT pg_get_constraintdef(selected_constraint_oid)
                INTO constraint_def;
            ELSE
              constraint_def := NULL;
            END IF;

            IF constraint_def IS NULL OR NOT (
              constraint_def LIKE '%proposed%'
              AND constraint_def LIKE '%approved%'
              AND constraint_def LIKE '%rejected%'
              AND constraint_def LIKE '%withdrawn%'
            ) THEN
              BEGIN
                EXECUTE format(
                  'ALTER TABLE %I.%I DROP CONSTRAINT IF EXISTS service_quotes_status_check, ADD CONSTRAINT service_quotes_status_check CHECK (status IN (''proposed'', ''approved'', ''rejected'', ''withdrawn''))',
                  exact_schema, 'service_quotes'
                );
              EXCEPTION WHEN duplicate_object THEN
                NULL;
              END;
            END IF;
          END $$;
        `);
        // Extend the event type CHECK with distinct marketplace event types
        // (same serialized inspect/alter design as the quote CHECK migration
        // above: ACCESS EXCLUSIVE lock on the exact schema-qualified table before
        // introspection and through the ALTER, OID picked from the
        // schema-qualified relation, pg_get_constraintdef called later on that
        // single OID only, ALTER executed with a schema-qualified table name)
        await client.query(`
          DO $$
          DECLARE
            exact_schema text := current_schema();
            selected_constraint_oid oid;
            constraint_def text;
          BEGIN
            EXECUTE format(
              'LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE',
              exact_schema, 'service_request_events'
            );
            SELECT c.oid
              INTO selected_constraint_oid
              FROM pg_constraint c
             WHERE c.conrelid = to_regclass(
                     format('%I.%I', exact_schema, 'service_request_events')
                   )
               AND c.conname = 'service_request_events_type_check';

            IF selected_constraint_oid IS NOT NULL THEN
              SELECT pg_get_constraintdef(selected_constraint_oid)
                INTO constraint_def;
            ELSE
              constraint_def := NULL;
            END IF;

            IF constraint_def IS NULL OR NOT (
              constraint_def LIKE '%request_created%'
              AND constraint_def LIKE '%provider_assigned%'
              AND constraint_def LIKE '%status_updated%'
              AND constraint_def LIKE '%quote_proposed%'
              AND constraint_def LIKE '%quote_approved%'
              AND constraint_def LIKE '%quote_rejected%'
              AND constraint_def LIKE '%opportunity_invited%'
              AND constraint_def LIKE '%opportunity_closed%'
              AND constraint_def LIKE '%provider_quote_submitted%'
              AND constraint_def LIKE '%provider_quote_withdrawn%'
            ) THEN
              BEGIN
                EXECUTE format(
                  'ALTER TABLE %I.%I DROP CONSTRAINT IF EXISTS service_request_events_type_check, ADD CONSTRAINT service_request_events_type_check CHECK (type IN (''request_created'', ''provider_assigned'', ''status_updated'', ''quote_proposed'', ''quote_approved'', ''quote_rejected'', ''opportunity_invited'', ''opportunity_closed'', ''provider_quote_submitted'', ''provider_quote_withdrawn''))',
                  exact_schema, 'service_request_events'
                );
              EXCEPTION WHEN duplicate_object THEN
                NULL;
              END;
            END IF;
          END $$;
        `);
        // Extend the opportunity status CHECK with 'rejected' (controlled,
        // idempotent, race-safe — same serialized inspect/alter design as the
        // quote CHECK migration above: ACCESS EXCLUSIVE lock on the exact
        // schema-qualified table before introspection and through the ALTER)
        await client.query(`
          DO $$
          DECLARE
            exact_schema text := current_schema();
            selected_constraint_oid oid;
            constraint_def text;
          BEGIN
            EXECUTE format(
              'LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE',
              exact_schema, 'request_provider_opportunities'
            );
            SELECT c.oid
              INTO selected_constraint_oid
              FROM pg_constraint c
             WHERE c.conrelid = to_regclass(
                     format('%I.%I', exact_schema, 'request_provider_opportunities')
                   )
               AND c.conname = 'request_provider_opportunities_status_check';

            IF selected_constraint_oid IS NOT NULL THEN
              SELECT pg_get_constraintdef(selected_constraint_oid)
                INTO constraint_def;
            ELSE
              constraint_def := NULL;
            END IF;

            IF constraint_def IS NULL OR NOT (
              constraint_def LIKE '%invited%'
              AND constraint_def LIKE '%quoted%'
              AND constraint_def LIKE '%withdrawn%'
              AND constraint_def LIKE '%closed%'
              AND constraint_def LIKE '%rejected%'
            ) THEN
              BEGIN
                EXECUTE format(
                  'ALTER TABLE %I.%I DROP CONSTRAINT IF EXISTS request_provider_opportunities_status_check, ADD CONSTRAINT request_provider_opportunities_status_check CHECK (status IN (''invited'', ''quoted'', ''withdrawn'', ''closed'', ''rejected''))',
                  exact_schema, 'request_provider_opportunities'
                );
              EXCEPTION WHEN duplicate_object THEN
                NULL;
              END;
            END IF;
          END $$;
        `);
        await client.query(`
          CREATE TABLE IF NOT EXISTS service_payments (
            id BIGSERIAL PRIMARY KEY,
            service_request_id BIGINT NOT NULL REFERENCES service_requests(id),
            quote_id BIGINT NOT NULL UNIQUE REFERENCES service_quotes(id),
            amount_halalas INTEGER NOT NULL CHECK (amount_halalas > 0),
            currency CHAR(3) NOT NULL DEFAULT 'SAR' CHECK (currency = 'SAR'),
            method TEXT NOT NULL CHECK (method IN ('cash_on_completion', 'paymob')),
            status TEXT NOT NULL CHECK (status IN ('cash_due', 'cash_collected', 'checkout_created', 'paid', 'failed', 'refund_pending', 'refunded')),
            collected_at TIMESTAMPTZ,
            refunded_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (service_request_id, quote_id)
          )
        `);
        await client.query(
          'ALTER TABLE service_payments ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ',
        );
        await client.query(
          'CREATE INDEX IF NOT EXISTS service_payments_request_created_idx ON service_payments (service_request_id, id DESC)',
        );
        await client.query(`
          CREATE TABLE IF NOT EXISTS support_tickets (
            id BIGSERIAL PRIMARY KEY,
            service_request_id BIGINT NOT NULL REFERENCES service_requests(id),
            customer_id BIGINT NOT NULL REFERENCES customers(id),
            category TEXT NOT NULL,
            comment TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'open',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await client.query('COMMIT');
      } catch (error) {
        // The migration transaction is open (likely aborted) at this point:
        // roll back before releasing, and never release a dirty client.
        released = true;
        await this.rollbackAndRelease(client);
        throw error;
      }
      client.release();
    } catch (error) {
      // BEGIN or advisory-lock acquisition failed. A transaction may still be
      // open, or the connection state may be uncertain, so use the fail-safe
      // cleanup (attempt ROLLBACK; destroy the client if it cannot be proven
      // clean) instead of releasing the client untouched.
      if (!released) {
        await this.rollbackAndRelease(client);
      }
      throw error;
    }
  }

  async create(
    input: CreateServiceRequest,
    customerId: string,
    submission?: ServiceRequestSubmissionContext,
    images?: StoredRequestImage[],
  ): Promise<ServiceRequest> {
    // Last-resort integrity guard: the HTTP layer validates the UUID v4
    // Idempotency-Key, but the repository never trusts callers and rejects
    // malformed keys with a deterministic error before any SQL runs.
    if (
      submission &&
      !CLIENT_SUBMISSION_ID_PATTERN.test(submission.clientSubmissionId)
    ) {
      throw new Error('Invalid client submission id');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const databaseCustomerId = this.toCustomerDatabaseId(customerId);
      let row: ServiceRequestRow | undefined;
      if (submission) {
        // Atomic same-key arbitration: the partial unique index
        // service_requests_customer_submission_unique makes the first
        // committer win; a concurrent (or repeated) submission with the same
        // (customer, client_submission_id) blocks until the winner's outcome
        // is decided, then inserts nothing. The existing committed row is
        // then re-read inside the same transaction and compared by content
        // fingerprint: identical content replays, different content
        // conflicts. Either error rolls this transaction back — nothing is
        // inserted, and the caller compensates uploaded objects.
        const inserted = await client.query<ServiceRequestRow>(
          `INSERT INTO service_requests
             (service_id, address, details, timing, customer_id,
              client_submission_id, submission_fingerprint,
              location_latitude, location_longitude, location_source,
              location_confirmed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (customer_id, client_submission_id)
             WHERE client_submission_id IS NOT NULL
           DO NOTHING
           RETURNING id, service_id, address, details, timing, status,
                     location_latitude, location_longitude, location_source,
                     location_confirmed_at, created_at`,
          [
            input.serviceId,
            input.address,
            input.details ?? null,
            input.timing,
            databaseCustomerId,
            submission.clientSubmissionId,
            submission.submissionFingerprint,
            input.location?.point.latitude ?? null,
            input.location?.point.longitude ?? null,
            input.location?.source ?? null,
            input.location?.confirmedAt ?? null,
          ],
        );
        row = inserted.rows[0];
        if (!row) {
          const existing = await client.query<{
            id: string;
            submission_fingerprint: string;
          }>(
            `SELECT id, submission_fingerprint
               FROM service_requests
              WHERE customer_id = $1 AND client_submission_id = $2`,
            [databaseCustomerId, submission.clientSubmissionId],
          );
          const existingRow = existing.rows[0];
          if (!existingRow) {
            throw new Error('Service request could not be created');
          }
          if (
            existingRow.submission_fingerprint ===
            submission.submissionFingerprint
          ) {
            throw new RequestSubmissionReplayError();
          }
          throw new RequestSubmissionConflictError();
        }
      } else {
        const result = await client.query<ServiceRequestRow>(
          `INSERT INTO service_requests
             (service_id, address, details, timing, customer_id,
              location_latitude, location_longitude, location_source,
              location_confirmed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id, service_id, address, details, timing, status,
                     location_latitude, location_longitude, location_source,
                     location_confirmed_at, created_at`,
          [
            input.serviceId,
            input.address,
            input.details ?? null,
            input.timing,
            databaseCustomerId,
            input.location?.point.latitude ?? null,
            input.location?.point.longitude ?? null,
            input.location?.source ?? null,
            input.location?.confirmedAt ?? null,
          ],
        );
        row = result.rows[0];
      }
      if (!row) throw new Error('Service request could not be created');
      // Image metadata commits atomically with the request row: any image
      // insert failure aborts the transaction, so a request can never commit
      // without (or partially with) its image metadata, and vice versa.
      if (images && images.length > 0) {
        await this.insertRequestImages(
          client,
          Number.parseInt(row.id, 10),
          images,
        );
      }
      await client.query(
        `INSERT INTO service_request_events (service_request_id, type, status)
         VALUES ($1, 'request_created', $2)`,
        [row.id, row.status],
      );
      await this.insertEligibleOpportunities(
        client,
        Number.parseInt(row.id, 10),
        row.service_id,
        row.status,
      );
      // C1 request_created -> customer, best-effort (architecture report).
      await this.enqueueCustomerNotification(client, {
        notificationType: 'request_created',
        serviceRequestDatabaseId: Number.parseInt(row.id, 10),
        customerDatabaseId: databaseCustomerId,
        dedupeKey: `request_created:${row.id}`,
        reliability: 'best-effort',
      });
      await client.query('COMMIT');
      client.release();
      this.notificationOutbox.notifyEnqueued();
      return this.toServiceRequest(row);
    } catch (error) {
      await this.rollbackAndRelease(client);
      throw error;
    }
  }

  /**
   * Inserts canonical image metadata rows on the caller's transaction client.
   * Values are the server-canonicalized projections produced by
   * {@link RequestImageService}; any constraint failure (duplicate sort
   * order, duplicate content hash, invalid checks) aborts the enclosing
   * transaction, which is what makes image metadata and the request row
   * commit or fail together.
   */
  private async insertRequestImages(
    client: PoolClient,
    serviceRequestDatabaseId: number,
    images: StoredRequestImage[],
  ): Promise<void> {
    for (const image of images) {
      await client.query(
        `INSERT INTO service_request_images
           (id, service_request_id, storage_key, mime_type, byte_size,
            content_sha256, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          image.id,
          serviceRequestDatabaseId,
          image.storageKey,
          image.mimeType,
          image.byteSize,
          image.contentSha256,
          image.sortOrder,
        ],
      );
    }
  }

  /**
   * Targeted lookup of the request committed for a customer submission key.
   * Used by the replay path after {@link create} reports a replay; the
   * original committed row is returned as the authoritative response.
   */
  async findRequestByCustomerSubmission(
    customerId: string,
    clientSubmissionId: string,
  ): Promise<ServiceRequest | undefined> {
    const result = await this.pool.query<ServiceRequestRow>(
      `SELECT r.id, r.service_id, r.address, r.details, r.timing, r.status,
              r.location_latitude, r.location_longitude, r.location_source,
              r.location_confirmed_at, r.created_at,
              p.id AS assigned_provider_id, p.name AS assigned_provider_name,
              p.specialties AS assigned_provider_specialties, p.available AS assigned_provider_available,
              r.rating, r.rating_comment,
              q.id AS quote_id, q.amount_halalas AS quote_amount_halalas,
              q.scope AS quote_scope, q.status AS quote_status,
              q.proposed_at AS quote_proposed_at, q.decided_at AS quote_decided_at,
              sp.id AS payment_id, sp.amount_halalas AS payment_amount_halalas,
              sp.currency AS payment_currency, sp.method AS payment_method,
              sp.status AS payment_status, sp.created_at AS payment_created_at,
              sp.collected_at AS payment_collected_at,
              sp.refunded_at AS payment_refunded_at
       FROM service_requests r
       LEFT JOIN providers p ON p.id = r.assigned_provider_id
       LEFT JOIN LATERAL (
         SELECT id, amount_halalas, scope, status, proposed_at, decided_at
         FROM service_quotes
         WHERE service_request_id = r.id
         ORDER BY id DESC
         LIMIT 1
       ) q ON TRUE
       LEFT JOIN LATERAL (
         SELECT id, amount_halalas, currency, method, status, created_at, collected_at, refunded_at
         FROM service_payments
         WHERE service_request_id = r.id
         ORDER BY id DESC
         LIMIT 1
       ) sp ON TRUE
       WHERE r.customer_id = $1 AND r.client_submission_id = $2
       LIMIT 1`,
      [this.toCustomerDatabaseId(customerId), clientSubmissionId],
    );
    const row = result.rows[0];
    return row ? this.toServiceRequest(row) : undefined;
  }

  /**
   * Committed canonical image metadata for a request, ordered by sort order.
   * Used to project image DTOs for replays; the checks in the schema
   * guarantee the stored shape.
   */
  async findRequestImages(requestId: string): Promise<StoredRequestImage[]> {
    const result = await this.pool.query<ServiceRequestImageRow>(
      `SELECT id, storage_key, mime_type, byte_size, content_sha256, sort_order
         FROM service_request_images
        WHERE service_request_id = $1
        ORDER BY sort_order`,
      [this.toRequestDatabaseId(requestId)],
    );
    return result.rows.map((row) => ({
      id: row.id,
      storageKey: row.storage_key,
      mimeType: row.mime_type as 'image/jpeg',
      byteSize: row.byte_size,
      contentSha256: row.content_sha256,
      sortOrder: row.sort_order,
    }));
  }

  /**
   * ONE set-based batch read of committed image metadata for many request
   * ids, keyed by the public request id and ordered by sort_order inside
   * every request. Used by the authorized read projections so a list of N
   * requests costs a single bounded query instead of N per-request reads.
   */
  async findRequestImagesByRequestIds(
    requestIds: string[],
  ): Promise<Map<string, StoredRequestImage[]>> {
    const byRequest = new Map<string, StoredRequestImage[]>();
    if (requestIds.length === 0) return byRequest;
    const databaseIds = requestIds.map((requestId) =>
      this.toRequestDatabaseId(requestId),
    );
    const result = await this.pool.query<
      ServiceRequestImageRow & { request_id: number }
    >(
      `SELECT id, service_request_id AS request_id, storage_key, mime_type,
              byte_size, content_sha256, sort_order
         FROM service_request_images
        WHERE service_request_id = ANY($1::bigint[])
        ORDER BY service_request_id, sort_order`,
      [databaseIds],
    );
    for (const row of result.rows) {
      const requestId = `MOE-${1000 + Number(row.request_id)}`;
      const entry = byRequest.get(requestId) ?? [];
      entry.push({
        id: row.id,
        storageKey: row.storage_key,
        mimeType: row.mime_type as 'image/jpeg',
        byteSize: row.byte_size,
        contentSha256: row.content_sha256,
        sortOrder: row.sort_order,
      });
      byRequest.set(requestId, entry);
    }
    return byRequest;
  }

  /**
   * Bounded, keyset-paginated listing of committed `service_request_images`
   * storage keys under an exact, caller-validated namespace prefix. Used by
   * the orphan-object reconciler to build the authoritative reference set;
   * the prefix is parameterized (never concatenated from untrusted input)
   * and every page is capped.
   */
  async listImageStorageKeys(
    prefix: string,
    after?: string,
    limit = 500,
  ): Promise<{ keys: string[]; nextAfter?: string }> {
    if (!/^request-images\/[a-z0-9][a-z0-9_-]{0,31}\/$/.test(prefix)) {
      throw new Error('Invalid request image storage prefix');
    }
    if (
      after !== undefined &&
      (!after.startsWith(prefix) ||
        after.includes('..') ||
        !/^request-images\/[a-z0-9][a-z0-9_-]{0,31}\/[a-z0-9/.-]{0,180}$/.test(
          after,
        ))
    ) {
      throw new Error('Invalid request image storage key');
    }
    const bounded = Math.min(Math.max(Math.trunc(limit) || 500, 1), 1000);
    const result = await this.pool.query<{ storage_key: string }>(
      `SELECT storage_key
         FROM service_request_images
        WHERE storage_key LIKE $1 || '%'
          AND ($2::text IS NULL OR storage_key > $2)
        ORDER BY storage_key ASC
        LIMIT $3`,
      [prefix, after ?? null, bounded],
    );
    const keys = result.rows.map((row) => row.storage_key);
    return keys.length > 0
      ? { keys, nextAfter: keys[keys.length - 1] }
      : { keys };
  }

  /**
   * Set-based automatic invitation: creates one `invited` opportunity per
   * eligible provider (verified, available, matching specialty) for a newly
   * created request, inside the caller's transaction. Only rows actually
   * inserted by this helper produce an `opportunity_invited` event; conflicts
   * are skipped silently via the unique constraint.
   */
  private async insertEligibleOpportunities(
    client: PoolClient,
    serviceRequestDatabaseId: number,
    serviceId: string,
    requestStatus: string,
  ): Promise<void> {
    const inserted = await client.query<{ provider_id: string }>(
      `INSERT INTO request_provider_opportunities (service_request_id, provider_id)
       SELECT $1, p.id
       FROM providers p
       WHERE p.verification_status = 'verified'
         AND p.available = TRUE
         AND $2 = ANY(p.specialties)
       ON CONFLICT (service_request_id, provider_id) DO NOTHING
       RETURNING provider_id`,
      [serviceRequestDatabaseId, serviceId],
    );
    if (inserted.rows.length === 0) return;
    await client.query(
      `INSERT INTO service_request_events (service_request_id, type, status)
       SELECT service_request_id, 'opportunity_invited', status
       FROM unnest($1::int[], $2::text[]) AS t(service_request_id, status)`,
      [
        Array(inserted.rows.length).fill(serviceRequestDatabaseId),
        Array(inserted.rows.length).fill(requestStatus),
      ],
    );
    // P1 opportunity_invited -> provider (per inserted opportunity), required.
    for (const opportunity of inserted.rows) {
      await this.enqueueProviderNotification(client, {
        notificationType: 'opportunity_invited',
        serviceRequestDatabaseId,
        providerId: opportunity.provider_id,
        dedupeKey: `opportunity_invited:${serviceRequestDatabaseId}:${opportunity.provider_id}`,
      });
    }
  }

  async findAll(): Promise<ServiceRequest[]> {
    const result = await this.pool.query<ServiceRequestRow>(
      `SELECT r.id, r.service_id, r.address, r.details, r.timing, r.status,
              r.location_latitude, r.location_longitude, r.location_source,
              r.location_confirmed_at, r.created_at,
              p.id AS assigned_provider_id, p.name AS assigned_provider_name,
              p.specialties AS assigned_provider_specialties, p.available AS assigned_provider_available,
              r.rating, r.rating_comment,
              q.id AS quote_id, q.provider_id AS quote_provider_id,
              qp.name AS quote_provider_name,
              q.amount_halalas AS quote_amount_halalas,
              q.scope AS quote_scope, q.status AS quote_status,
              q.proposed_at AS quote_proposed_at, q.decided_at AS quote_decided_at,
              opp.invited AS opportunity_invited, opp.quoted AS opportunity_quoted,
              opp.withdrawn AS opportunity_withdrawn, opp.closed AS opportunity_closed,
              opp.rejected AS opportunity_rejected, opp.total AS opportunity_total,
              sp.id AS payment_id, sp.amount_halalas AS payment_amount_halalas,
              sp.currency AS payment_currency, sp.method AS payment_method,
              sp.status AS payment_status, sp.created_at AS payment_created_at,
              sp.collected_at AS payment_collected_at,
              sp.refunded_at AS payment_refunded_at
       FROM service_requests r
       LEFT JOIN providers p ON p.id = r.assigned_provider_id
       LEFT JOIN LATERAL (
         SELECT id, provider_id, amount_halalas, scope, status, proposed_at, decided_at
         FROM service_quotes
         WHERE service_request_id = r.id
         ORDER BY id DESC
         LIMIT 1
       ) q ON TRUE
       LEFT JOIN providers qp ON qp.id = q.provider_id
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE status = 'invited') AS invited,
                count(*) FILTER (WHERE status = 'quoted') AS quoted,
                count(*) FILTER (WHERE status = 'withdrawn') AS withdrawn,
                count(*) FILTER (WHERE status = 'closed') AS closed,
                count(*) FILTER (WHERE status = 'rejected') AS rejected,
                count(*) AS total
         FROM request_provider_opportunities
         WHERE service_request_id = r.id
       ) opp ON TRUE
       LEFT JOIN LATERAL (
         SELECT id, amount_halalas, currency, method, status, created_at, collected_at, refunded_at
         FROM service_payments
         WHERE service_request_id = r.id
         ORDER BY id DESC
         LIMIT 1
       ) sp ON TRUE
       ORDER BY r.id DESC`,
    );

    return result.rows.map((row) => this.toServiceRequest(row));
  }

  async findByCustomerId(customerId: string): Promise<ServiceRequest[]> {
    const result = await this.pool.query<ServiceRequestRow>(
      `SELECT r.id, r.service_id, r.address, r.details, r.timing, r.status,
              r.location_latitude, r.location_longitude, r.location_source,
              r.location_confirmed_at, r.created_at,
              p.id AS assigned_provider_id, p.name AS assigned_provider_name,
              p.specialties AS assigned_provider_specialties, p.available AS assigned_provider_available,
              r.rating, r.rating_comment,
              q.id AS quote_id, q.amount_halalas AS quote_amount_halalas,
              q.scope AS quote_scope, q.status AS quote_status,
              q.proposed_at AS quote_proposed_at, q.decided_at AS quote_decided_at,
              sp.id AS payment_id, sp.amount_halalas AS payment_amount_halalas,
              sp.currency AS payment_currency, sp.method AS payment_method,
              sp.status AS payment_status, sp.created_at AS payment_created_at,
              sp.collected_at AS payment_collected_at,
              sp.refunded_at AS payment_refunded_at
       FROM service_requests r
       LEFT JOIN providers p ON p.id = r.assigned_provider_id
       LEFT JOIN LATERAL (
         SELECT id, amount_halalas, scope, status, proposed_at, decided_at
         FROM service_quotes
         WHERE service_request_id = r.id
         ORDER BY id DESC
         LIMIT 1
       ) q ON TRUE
       LEFT JOIN LATERAL (
         SELECT id, amount_halalas, currency, method, status, created_at, collected_at, refunded_at
         FROM service_payments
         WHERE service_request_id = r.id
         ORDER BY id DESC
         LIMIT 1
       ) sp ON TRUE
       WHERE r.customer_id = $1
       ORDER BY r.id DESC`,
      [this.toCustomerDatabaseId(customerId)],
    );
    const requests = result.rows.map((row) => this.toServiceRequest(row));
    const providerQuotesByRequest = await this.fetchProviderQuotesByRequest(
      requests.map((request) => this.toRequestDatabaseId(request.id)),
    );
    const providerIds = [
      ...new Set(
        [...providerQuotesByRequest.values()]
          .flatMap((quotes) => quotes.map((quote) => quote.provider_id))
          .filter((providerId): providerId is string => providerId !== null),
      ),
    ];
    const ratingSummaries =
      await this.fetchProviderRatingSummaries(providerIds);
    return requests.map((request) => {
      const providerQuotes = providerQuotesByRequest.get(request.id) ?? [];
      return {
        ...request,
        quote: this.toCustomerQuote(request.quote),
        quotes: this.toCustomerQuoteViews(
          request.id,
          providerQuotes,
          ratingSummaries,
        ),
      };
    });
  }

  /**
   * One set-based aggregate query for all quoting providers of a customer
   * request list: AVG/COUNT of ratings from completed requests assigned to
   * each provider. Avoids an N+1 rating query per quote.
   */
  private async fetchProviderRatingSummaries(
    providerIds: string[],
  ): Promise<Map<string, Omit<CustomerQuoteProviderSummary, 'name'>>> {
    const summaries = new Map<
      string,
      Omit<CustomerQuoteProviderSummary, 'name'>
    >();
    if (providerIds.length === 0) return summaries;
    const result = await this.pool.query<{
      provider_id: string;
      average_rating: number | null;
      rating_count: number;
    }>(
      `SELECT assigned_provider_id AS provider_id,
              ROUND(AVG(rating)::numeric, 1)::float8 AS average_rating,
              COUNT(*)::int AS rating_count
       FROM service_requests
       WHERE assigned_provider_id = ANY($1::text[])
         AND status = 'completed'
         AND rating IS NOT NULL
       GROUP BY assigned_provider_id`,
      [providerIds],
    );
    for (const row of result.rows) {
      summaries.set(row.provider_id, {
        averageRating: row.average_rating,
        ratingCount: row.rating_count,
      });
    }
    return summaries;
  }

  private async fetchProviderQuotesByRequest(
    requestDatabaseIds: number[],
  ): Promise<Map<string, ServiceQuoteRow[]>> {
    const result = new Map<string, ServiceQuoteRow[]>();
    if (requestDatabaseIds.length === 0) return result;
    const rows = await this.pool.query<
      ServiceQuoteRow & { service_request_id: string }
    >(
      `SELECT q.id, q.provider_id, p.name AS provider_name,
              q.amount_halalas, q.scope, q.status,
              q.proposed_at, q.decided_at, q.service_request_id
        FROM service_quotes q
        LEFT JOIN providers p ON p.id = q.provider_id
        WHERE q.service_request_id = ANY($1::bigint[]) AND q.provider_id IS NOT NULL
        ORDER BY q.id DESC`,
      [requestDatabaseIds],
    );
    for (const row of rows.rows) {
      const requestId = `MOE-${1000 + Number(row.service_request_id)}`;
      const list = result.get(requestId) ?? [];
      list.push(row);
      result.set(requestId, list);
    }
    return result;
  }

  private toCustomerQuote(
    quote: ServiceQuote | undefined,
  ): ServiceQuote | undefined {
    if (!quote) return undefined;
    return {
      id: quote.id,
      amountHalalas: quote.amountHalalas,
      scope: quote.scope,
      status: quote.status,
      proposedAt: quote.proposedAt,
      decidedAt: quote.decidedAt,
    };
  }

  private toCustomerQuoteViews(
    requestId: string,
    providerQuotes: ServiceQuoteRow[],
    providerSummaries: Map<string, Omit<CustomerQuoteProviderSummary, 'name'>>,
  ): CustomerQuoteView[] {
    return providerQuotes.map((quote) => ({
      id: `QTE-${quote.id}`,
      amountHalalas: quote.amount_halalas,
      scope: quote.scope,
      status: quote.status,
      proposedAt: quote.proposed_at.toISOString(),
      decidedAt: quote.decided_at?.toISOString(),
      providerSummary: quote.provider_id
        ? {
            name: quote.provider_name ?? '',
            ...(providerSummaries.get(quote.provider_id) ?? {
              averageRating: null,
              ratingCount: 0,
            }),
          }
        : undefined,
    }));
  }

  async findByProviderId(providerId: string): Promise<ServiceRequest[]> {
    const result = await this.pool.query<ServiceRequestRow>(
      `SELECT r.id, r.service_id, r.address, r.details, r.timing, r.status,
              r.location_latitude, r.location_longitude, r.location_source,
              r.location_confirmed_at, r.created_at,
              c.phone AS customer_phone,
              p.id AS assigned_provider_id, p.name AS assigned_provider_name,
              p.specialties AS assigned_provider_specialties, p.available AS assigned_provider_available,
              r.rating, r.rating_comment,
              q.id AS quote_id, q.amount_halalas AS quote_amount_halalas,
              q.scope AS quote_scope, q.status AS quote_status,
              q.proposed_at AS quote_proposed_at, q.decided_at AS quote_decided_at,
              sp.id AS payment_id, sp.amount_halalas AS payment_amount_halalas,
              sp.currency AS payment_currency, sp.method AS payment_method,
              sp.status AS payment_status, sp.created_at AS payment_created_at,
              sp.collected_at AS payment_collected_at,
              sp.refunded_at AS payment_refunded_at
       FROM service_requests r
       JOIN providers p ON p.id = r.assigned_provider_id
       LEFT JOIN customers c ON c.id = r.customer_id
       LEFT JOIN LATERAL (
         SELECT id, amount_halalas, scope, status, proposed_at, decided_at
         FROM (
           SELECT id, amount_halalas, scope, status, proposed_at, decided_at,
                  0 AS quote_source_priority
           FROM service_quotes
           WHERE service_request_id = r.id
             AND provider_id = r.assigned_provider_id
           UNION ALL
           SELECT id, amount_halalas, scope, status, proposed_at, decided_at,
                  1 AS quote_source_priority
           FROM service_quotes
           WHERE service_request_id = r.id
             AND provider_id IS NULL
         ) eligible_quotes
         ORDER BY quote_source_priority, id DESC
         LIMIT 1
       ) q ON TRUE
       LEFT JOIN LATERAL (
         SELECT id, amount_halalas, currency, method, status, created_at, collected_at, refunded_at
         FROM service_payments
         WHERE service_request_id = r.id
         ORDER BY id DESC
         LIMIT 1
       ) sp ON TRUE
       WHERE r.assigned_provider_id = $1
       ORDER BY r.id DESC`,
      [providerId],
    );
    return result.rows.map((row) => this.toServiceRequest(row));
  }

  async findRequestEvents(requestId: string): Promise<ServiceRequestEvent[]> {
    const result = await this.pool.query<ServiceRequestEventRow>(
      `SELECT type, status, created_at
       FROM service_request_events
       WHERE service_request_id = $1
       ORDER BY id ASC`,
      [this.toRequestDatabaseId(requestId)],
    );
    return result.rows.map((row) => ({
      type: row.type,
      status: row.status,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async findProviders(): Promise<PilotProvider[]> {
    const result = await this.pool.query<PilotProviderRow>(
      `SELECT id, name, specialties, available, service_zone, verification_status
       FROM providers
       ORDER BY name`,
    );
    return result.rows.map((row) => this.toPilotProvider(row));
  }

  async setProviderAccessCode(
    providerId: string,
    accessCode: string,
    audit?: StaffAuditSpec,
  ): Promise<void> {
    const accessCodeHash = await hashProviderAccessCode(accessCode);
    const lookupId = providerAccessCodeLookupId(accessCode);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const provider = await client.query<{ id: string }>(
        'SELECT id FROM providers WHERE id = $1 FOR UPDATE',
        [providerId],
      );
      if (!provider.rows[0]) throw new Error('Pilot provider not found');
      try {
        await client.query(
          `INSERT INTO provider_access_credentials (provider_id, access_code_hash, lookup_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (provider_id) DO UPDATE
           SET access_code_hash = EXCLUDED.access_code_hash,
               lookup_id = EXCLUDED.lookup_id,
               updated_at = NOW()`,
          [providerId, accessCodeHash, lookupId],
        );
      } catch (error) {
        if (this.isUniqueViolation(error)) {
          throw new Error('Provider access code is already in use');
        }
        throw error;
      }
      await client.query(
        'DELETE FROM provider_sessions WHERE provider_id = $1',
        [providerId],
      );
      // The access code itself is a secret and is never written to the audit
      // trail; only the rotation fact is recorded.
      if (audit) {
        await this.insertStaffAuditEvent(client, audit, undefined, {
          accessCodeRotated: true,
        });
      }
      await client.query('COMMIT');
      client.release();
    } catch (error) {
      await this.rollbackAndRelease(client);
      throw error;
    }
  }

  async findProviderByAccessCode(
    accessCode: string,
  ): Promise<ProviderAppPrincipal | undefined> {
    // Single indexed lookup by SHA-256 lookup id, followed by at most one
    // real scrypt verification. Unknown ids run one fixed dummy verification
    // so timing does not reveal whether a credential exists.
    const lookupId = providerAccessCodeLookupId(accessCode);
    const result = await this.pool.query<ProviderAccessRow>(
      `SELECT p.id, p.name, p.specialties, p.available, p.service_zone,
              p.verification_status, c.access_code_hash
       FROM provider_access_credentials c
       JOIN providers p ON p.id = c.provider_id
       WHERE c.lookup_id = $1 AND p.verification_status = 'verified'
       LIMIT 1`,
      [lookupId],
    );
    const row = result.rows[0];
    if (!row) {
      await verifyDummyProviderAccessCode();
      return undefined;
    }
    if (!(await verifyProviderAccessCode(accessCode, row.access_code_hash))) {
      await verifyDummyProviderAccessCode();
      return undefined;
    }
    if (isLegacyProviderAccessCodeHash(row.access_code_hash)) {
      await this.pool.query(
        `UPDATE provider_access_credentials
         SET access_code_hash = $2, updated_at = NOW()
         WHERE provider_id = $1 AND access_code_hash = $3`,
        [
          row.id,
          await hashProviderAccessCode(accessCode),
          row.access_code_hash,
        ],
      );
    }
    return this.toProviderAppPrincipal(row);
  }

  async createProviderSession(
    providerId: string,
    token: string,
  ): Promise<void> {
    const result = await this.pool.query<{ provider_id: string }>(
      `INSERT INTO provider_sessions (token_hash, provider_id, expires_at)
       SELECT $1, p.id, NOW() + INTERVAL '30 days'
       FROM providers p
       WHERE p.id = $2 AND p.verification_status = 'verified'
       RETURNING provider_id`,
      [this.hashToken(token), providerId],
    );
    if (!result.rows[0]) throw new Error('Verified provider not found');
  }

  async revokeProviderSession(token: string): Promise<void> {
    await this.pool.query(
      'DELETE FROM provider_sessions WHERE token_hash = $1',
      [this.hashToken(token)],
    );
  }

  async findProviderBySession(
    token: string,
  ): Promise<ProviderAppPrincipal | undefined> {
    const result = await this.pool.query<PilotProviderRow>(
      `SELECT p.id, p.name, p.specialties, p.available, p.service_zone, p.verification_status
       FROM provider_sessions s
       JOIN providers p ON p.id = s.provider_id
       WHERE s.token_hash = $1
         AND s.expires_at > NOW()
         AND p.verification_status = 'verified'`,
      [this.hashToken(token)],
    );
    const row = result.rows[0];
    return row ? this.toProviderAppPrincipal(row) : undefined;
  }

  async updateProviderAvailability(
    providerId: string,
    available: boolean,
  ): Promise<ProviderAppPrincipal> {
    const result = await this.pool.query<PilotProviderRow>(
      `UPDATE providers
       SET available = $2
       WHERE id = $1 AND verification_status = 'verified'
       RETURNING id, name, specialties, available, service_zone, verification_status`,
      [providerId, available],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Verified provider not found');
    return this.toProviderAppPrincipal(row);
  }

  async createPilotProvider(
    input: CreatePilotProvider,
    audit?: StaffAuditSpec,
  ): Promise<PilotProvider> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<PilotProviderRow>(
        `INSERT INTO providers (
           id, name, specialties, available, service_zone, verification_status
         )
         VALUES ($1, $2, $3, FALSE, $4, 'pending')
         RETURNING id, name, specialties, available, service_zone, verification_status`,
        [
          `PILOT-${randomUUID()}`,
          input.name,
          input.specialties,
          input.serviceZone,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('Pilot provider could not be created');
      if (audit) {
        await this.insertStaffAuditEvent(
          client,
          // The subject row is created by this command, so the subject id is
          // resolved from the created row inside the same transaction (the
          // caller cannot know it beforehand).
          { ...audit, subjectId: row.id },
          undefined,
          {
            verificationStatus: row.verification_status,
            serviceZone: row.service_zone,
          },
        );
      }
      await client.query('COMMIT');
      client.release();
      return this.toPilotProvider(row);
    } catch (error) {
      await this.rollbackAndRelease(client);
      throw error;
    }
  }

  async updatePilotProviderVerification(
    providerId: string,
    verificationStatus: PilotProviderVerificationStatus,
    audit?: StaffAuditSpec,
    expectedCurrentStatus?: PilotProviderVerificationStatus,
  ): Promise<PilotProvider> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Authoritative old state: locked read on the provider row, inside the
      // same transaction that performs the mutation (B5 invariant).
      const current = await client.query<{
        verification_status: PilotProviderVerificationStatus;
        available: boolean;
      }>(
        `SELECT verification_status, available
         FROM providers
         WHERE id = $1
         FOR UPDATE`,
        [providerId],
      );
      const currentRow = current.rows[0];
      if (!currentRow) throw new Error('Pilot provider not found');
      // The workflow precondition (verify only from pending, suspend only from
      // verified, reactivate only from suspended) used to be a stale
      // controller-side read. It is enforced here on the locked row so the
      // transition gate is atomic with the mutation (B5 invariant).
      if (
        expectedCurrentStatus &&
        currentRow.verification_status !== expectedCurrentStatus
      ) {
        const notFoundMessages: Record<
          PilotProviderVerificationStatus,
          string
        > = {
          pending: 'Pending pilot provider not found',
          verified: 'Verified pilot provider not found',
          suspended: 'Suspended pilot provider not found',
        };
        throw new Error(notFoundMessages[expectedCurrentStatus]);
      }
      const result = await client.query<PilotProviderRow>(
        `UPDATE providers
         SET verification_status = $2,
             available = CASE WHEN $2 = 'verified' THEN TRUE ELSE FALSE END
         WHERE id = $1
         RETURNING id, name, specialties, available, service_zone, verification_status`,
        [providerId, verificationStatus],
      );
      const row = result.rows[0];
      if (!row) throw new Error('Pilot provider not found');
      if (audit) {
        await this.insertStaffAuditEvent(
          client,
          audit,
          {
            verificationStatus: currentRow.verification_status,
            available: currentRow.available,
          },
          {
            verificationStatus: row.verification_status,
            available: row.available,
          },
        );
      }
      await client.query('COMMIT');
      client.release();
      return this.toPilotProvider(row);
    } catch (error) {
      await this.rollbackAndRelease(client);
      throw error;
    }
  }

  async assignProvider(
    requestId: string,
    providerId: string,
    audit?: StaffAuditSpec,
  ): Promise<ServiceRequest> {
    const databaseId = this.toRequestDatabaseId(requestId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize on the same request row used by marketplace quote approval
      // (decideQuote locks the request row first) and every other
      // request-scoped transition. The eligibility check is revalidated on
      // the locked row, so a concurrent quote approval that commits first
      // makes this assignment fail instead of overwriting the winner.
      const request = await client.query<{
        status: ServiceRequest['status'];
        assigned_provider_id: string | null;
        customer_id: string;
      }>(
        `SELECT status, assigned_provider_id, customer_id::text
         FROM service_requests WHERE id = $1 FOR UPDATE`,
        [databaseId],
      );
      const currentStatus = request.rows[0]?.status;
      if (!currentStatus) {
        throw new Error('Request not found');
      }
      const requestCustomerId = this.customerDatabaseIdOrNull(
        request.rows[0]?.customer_id,
      );
      if (currentStatus !== 'pending_dispatch') {
        throw new Error(
          'Request is not pending dispatch; manual assignment is not allowed',
        );
      }
      const result = await client.query<ServiceRequestRow>(
        `UPDATE service_requests r
         SET assigned_provider_id = p.id, status = 'assigned'
         FROM providers p
         WHERE r.id = $1 AND p.id = $2 AND p.available = TRUE
           AND p.verification_status = 'verified'
           AND r.service_id = ANY(p.specialties)
         RETURNING r.id, r.service_id, r.address, r.details, r.timing, r.status, r.created_at,
                   p.id AS assigned_provider_id, p.name AS assigned_provider_name,
                   p.specialties AS assigned_provider_specialties, p.available AS assigned_provider_available,
                r.rating, r.rating_comment`,
        [databaseId, providerId],
      );
      const row = result.rows[0];
      if (!row) throw new Error('Request or available provider not found');
      // Reconcile any active marketplace state atomically so the manually
      // selected provider is the single authoritative provider: every active
      // provider quote is rejected and every open opportunity is closed,
      // mirroring the closing behavior of a quote approval.
      const closedQuotes = await client.query<{
        id: string;
        provider_id: string | null;
      }>(
        `UPDATE service_quotes
         SET status = 'rejected', decided_at = NOW()
         WHERE service_request_id = $1 AND provider_id IS NOT NULL
           AND status = 'proposed'
         RETURNING id, provider_id`,
        [databaseId],
      );
      for (let index = 0; index < closedQuotes.rows.length; index += 1) {
        await client.query(
          `INSERT INTO service_request_events (service_request_id, type, status)
           VALUES ($1, 'quote_rejected', 'assigned')`,
          [databaseId],
        );
      }
      const closedOpportunities = await client.query<{
        id: string;
        provider_id: string;
      }>(
        `UPDATE request_provider_opportunities
         SET status = 'closed'
         WHERE service_request_id = $1 AND status IN ('invited', 'quoted')
         RETURNING id, provider_id`,
        [databaseId],
      );
      for (let index = 0; index < closedOpportunities.rows.length; index += 1) {
        await client.query(
          `INSERT INTO service_request_events (service_request_id, type, status)
           VALUES ($1, 'opportunity_closed', 'assigned')`,
          [databaseId],
        );
      }
      await client.query(
        `INSERT INTO service_request_events (service_request_id, type, status)
         VALUES ($1, 'provider_assigned', 'assigned')`,
        [databaseId],
      );
      // P2 provider_assigned -> winner, C3 assignment_confirmed -> customer,
      // P3 opportunity_closed -> each closed-opportunity provider excluding
      // the winner (all required, architecture report section 3).
      await this.enqueueProviderNotification(client, {
        notificationType: 'provider_assigned',
        serviceRequestDatabaseId: databaseId,
        providerId,
        dedupeKey: `provider_assigned:${databaseId}:${providerId}`,
      });
      await this.enqueueCustomerNotification(client, {
        notificationType: 'assignment_confirmed',
        serviceRequestDatabaseId: databaseId,
        customerDatabaseId: requestCustomerId,
        dedupeKey: `assignment_confirmed:${databaseId}`,
      });
      for (const opportunity of closedOpportunities.rows) {
        if (opportunity.provider_id === providerId) continue;
        await this.enqueueProviderNotification(client, {
          notificationType: 'opportunity_closed',
          serviceRequestDatabaseId: databaseId,
          providerId: opportunity.provider_id,
          dedupeKey: `opportunity_closed:${databaseId}:${opportunity.provider_id}`,
        });
      }
      if (audit) {
        await this.insertStaffAuditEvent(
          client,
          audit,
          {
            status: currentStatus,
            providerId: request.rows[0]?.assigned_provider_id ?? null,
          },
          {
            status: row.status,
            providerId: row.assigned_provider_id ?? providerId,
          },
        );
      }
      await client.query('COMMIT');
      client.release();
      this.notificationOutbox.notifyEnqueued();
      return this.toServiceRequest(row);
    } catch (error) {
      await this.rollbackAndRelease(client);
      throw error;
    }
  }

  /**
   * Quote gating for entering in_progress. A request with no quotes may
   * start, and a request with at least one approved quote may start. Any
   * other combination (only proposed / rejected / withdrawn quotes) is
   * refused with the existing 'Quote approval required' error. The verdict
   * aggregates across ALL quotes: a newer rejected or withdrawn quote must
   * never invalidate an earlier approval, so the rule deliberately does not
   * inspect only the newest quote.
   */
  private async assertServiceMayStart(
    client: PoolClient,
    databaseId: number,
  ): Promise<void> {
    const summary = await client.query<{
      approved_count: number;
      total_count: number;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'approved')::int AS approved_count,
         COUNT(*)::int AS total_count
       FROM service_quotes
       WHERE service_request_id = $1`,
      [databaseId],
    );
    const row = summary.rows[0];
    if (row && row.total_count > 0 && row.approved_count === 0) {
      throw new Error('Quote approval required');
    }
  }

  async updateStatus(
    requestId: string,
    status: ServiceRequest['status'],
    audit?: StaffAuditSpec,
  ): Promise<ServiceRequest> {
    const allowedPreviousStatuses: Record<string, ServiceRequest['status'][]> =
      {
        on_the_way: ['assigned'],
        in_progress: ['on_the_way'],
        completed: ['in_progress'],
        cancelled: ['pending_dispatch', 'assigned', 'on_the_way'],
      };
    const previousStatuses = allowedPreviousStatuses[status];
    if (!previousStatuses) throw new Error('Unsupported status transition');

    const databaseId = Number(requestId.replace('MOE-', '')) - 1000;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<{
        status: ServiceRequest['status'];
        customer_id: string | null;
      }>(
        'SELECT status, customer_id::text FROM service_requests WHERE id = $1 FOR UPDATE',
        [databaseId],
      );
      const currentStatus = current.rows[0]?.status;
      const customerDatabaseId = this.customerDatabaseIdOrNull(
        current.rows[0]?.customer_id,
      );
      if (!currentStatus || !previousStatuses.includes(currentStatus)) {
        throw new Error('Invalid status transition');
      }
      if (status === 'in_progress') {
        await this.assertServiceMayStart(client, databaseId);
      }
      await client.query(
        `UPDATE service_requests SET status = $1 WHERE id = $2`,
        [status, databaseId],
      );
      await client.query(
        `INSERT INTO service_request_events (service_request_id, type, status)
         VALUES ($1, 'status_updated', $2)`,
        [databaseId, status],
      );
      // C4-C7 status notifications -> customer (required). Cancellation is
      // only reachable through the staff updateStatus path.
      const notificationType = customerStatusNotificationType(status);
      if (notificationType) {
        await this.enqueueCustomerNotification(client, {
          notificationType,
          serviceRequestDatabaseId: databaseId,
          customerDatabaseId,
          dedupeKey: `status_updated:${databaseId}:${status}`,
        });
      }
      if (audit) {
        await this.insertStaffAuditEvent(
          client,
          audit,
          { status: currentStatus },
          { status },
        );
      }
      await client.query('COMMIT');
      client.release();
      if (notificationType) this.notificationOutbox.notifyEnqueued();
    } catch (error) {
      await this.rollbackAndRelease(client);
      throw error;
    }

    const request = (await this.findAll()).find(
      (item) => item.id === requestId,
    );
    if (!request) throw new Error('Request not found after update');
    return request;
  }

  async updateStatusForProvider(
    requestId: string,
    providerId: string,
    status: Extract<
      ServiceRequest['status'],
      'on_the_way' | 'in_progress' | 'completed'
    >,
  ): Promise<ServiceRequest> {
    const allowedPreviousStatuses: Record<string, ServiceRequest['status'][]> =
      {
        on_the_way: ['assigned'],
        in_progress: ['on_the_way'],
        completed: ['in_progress'],
      };
    const previousStatuses = allowedPreviousStatuses[status];
    if (!previousStatuses) throw new Error('Unsupported provider status');

    const databaseId = this.toRequestDatabaseId(requestId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<{
        status: ServiceRequest['status'];
        customer_id: string | null;
      }>(
        `SELECT status, customer_id::text
         FROM service_requests
         WHERE id = $1 AND assigned_provider_id = $2
         FOR UPDATE`,
        [databaseId, providerId],
      );
      const currentStatus = current.rows[0]?.status;
      const customerDatabaseId = this.customerDatabaseIdOrNull(
        current.rows[0]?.customer_id,
      );
      if (!currentStatus) {
        throw new Error('Assigned provider request not found');
      }
      if (!previousStatuses.includes(currentStatus)) {
        throw new Error('Invalid status transition');
      }
      if (status === 'in_progress') {
        await this.assertServiceMayStart(client, databaseId);
      }
      await client.query(
        'UPDATE service_requests SET status = $1 WHERE id = $2',
        [status, databaseId],
      );
      await client.query(
        `INSERT INTO service_request_events (service_request_id, type, status)
         VALUES ($1, 'status_updated', $2)`,
        [databaseId, status],
      );
      // C4-C6 provider-driven status notifications -> customer (required).
      const notificationType = customerStatusNotificationType(status);
      if (notificationType) {
        await this.enqueueCustomerNotification(client, {
          notificationType,
          serviceRequestDatabaseId: databaseId,
          customerDatabaseId,
          dedupeKey: `status_updated:${databaseId}:${status}`,
        });
      }
      await client.query('COMMIT');
      client.release();
      if (notificationType) this.notificationOutbox.notifyEnqueued();
    } catch (error) {
      await this.rollbackAndRelease(client);
      throw error;
    }

    const request = (await this.findByProviderId(providerId)).find(
      (item) => item.id === requestId,
    );
    if (!request) throw new Error('Assigned provider request not found');
    return request;
  }

  async proposeQuote(
    requestId: string,
    amountHalalas: number,
    scope: string,
    audit?: StaffAuditSpec,
  ): Promise<ServiceQuote> {
    const databaseId = this.toRequestDatabaseId(requestId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const request = await client.query<{
        status: ServiceRequest['status'];
        customer_id: string | null;
      }>(
        'SELECT status, customer_id::text FROM service_requests WHERE id = $1 FOR UPDATE',
        [databaseId],
      );
      const status = request.rows[0]?.status;
      const customerDatabaseId = this.customerDatabaseIdOrNull(
        request.rows[0]?.customer_id,
      );
      if (!status || !['assigned', 'on_the_way'].includes(status)) {
        throw new Error('Quote can only be proposed before service starts');
      }
      const activeQuote = await client.query<{ id: string }>(
        `SELECT id FROM service_quotes
         WHERE service_request_id = $1 AND status IN ('proposed', 'approved')
         ORDER BY id DESC
         LIMIT 1`,
        [databaseId],
      );
      if (activeQuote.rows[0]) {
        throw new Error('An active quote already exists');
      }
      const marketplaceOpportunity = await client.query<{ id: string }>(
        `SELECT id FROM request_provider_opportunities
         WHERE service_request_id = $1
         LIMIT 1`,
        [databaseId],
      );
      if (marketplaceOpportunity.rows[0]) {
        throw new StaffQuoteInMarketplaceFlowError();
      }
      const result = await client.query<ServiceQuoteRow>(
        `INSERT INTO service_quotes (service_request_id, amount_halalas, scope)
         VALUES ($1, $2, $3)
         RETURNING id, provider_id, amount_halalas, scope, status, proposed_at, decided_at`,
        [databaseId, amountHalalas, scope],
      );
      const quote = result.rows[0];
      if (!quote) throw new Error('Quote could not be proposed');
      await client.query(
        `INSERT INTO service_request_events (service_request_id, type, status)
         VALUES ($1, 'quote_proposed', $2)`,
        [databaseId, status],
      );
      // C2 quote_received -> customer (required; staff quote).
      await this.enqueueCustomerNotification(client, {
        notificationType: 'quote_received',
        serviceRequestDatabaseId: databaseId,
        customerDatabaseId,
        dedupeKey: `quote_received:${databaseId}:${quote.id}`,
      });
      if (audit) {
        await this.insertStaffAuditEvent(client, audit, undefined, {
          quoteStatus: quote.status,
          amountHalalas: quote.amount_halalas,
        });
      }
      await client.query('COMMIT');
      client.release();
      this.notificationOutbox.notifyEnqueued();
      return this.toServiceQuote(quote);
    } catch (error) {
      await this.rollbackAndRelease(client);
      throw error;
    }
  }

  async decideQuote(
    requestId: string,
    customerId: string,
    quoteId: string,
    decision: Exclude<ServiceQuoteStatus, 'proposed'>,
  ): Promise<ServiceQuote> {
    const databaseId = this.toRequestDatabaseId(requestId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const quoteDatabaseId = this.toQuoteDatabaseId(quoteId);
      const customerDatabaseId = this.toCustomerDatabaseId(customerId);
      // Lock the request row FIRST so a quote decision serializes on the same
      // request row as manual assignment (assignProvider) and every other
      // request-scoped transition, with a consistent request -> quote lock
      // order that cannot deadlock against the manual-assignment
      // reconciliation (which locks the request row and then the quotes).
      // A nonexistent request still falls through to the joined quote query
      // below and yields the same 'Pending customer quote not found' error.
      await client.query(
        'SELECT status FROM service_requests WHERE id = $1 FOR UPDATE',
        [databaseId],
      );
      const quote = await client.query<
        ServiceQuoteRow & { request_status: ServiceRequest['status'] }
      >(
        `SELECT q.id, q.provider_id, q.amount_halalas, q.scope, q.status, q.proposed_at, q.decided_at,
                r.status AS request_status
         FROM service_quotes q
         JOIN service_requests r ON r.id = q.service_request_id
         WHERE q.id = $1 AND q.service_request_id = $2 AND r.customer_id = $3
         FOR UPDATE OF q`,
        [quoteDatabaseId, databaseId, this.toCustomerDatabaseId(customerId)],
      );
      const currentQuote = quote.rows[0];
      // A marketplace quote may only assign the provider while the request is
      // still pending dispatch. Once a manual assignment (or an earlier quote
      // approval) has moved the request to 'assigned', a later approval must
      // not replace the authoritative provider. Checked before the status
      // check so a quote reconciled to 'rejected' by a manual assignment still
      // fails with the accurate domain message instead of the misleading
      // 'Pending customer quote not found'.
      if (
        currentQuote &&
        decision === 'approved' &&
        currentQuote.provider_id &&
        currentQuote.request_status !== 'pending_dispatch'
      ) {
        throw new Error(
          'The request is no longer pending dispatch; the selected provider quote cannot be approved',
        );
      }
      if (!currentQuote || currentQuote.status !== 'proposed') {
        throw new Error('Pending customer quote not found');
      }
      if (currentQuote.provider_id) {
        const provider = await client.query<{
          verification_status: string;
          available: boolean;
        }>(
          `SELECT verification_status, available
           FROM providers
           WHERE id = $1
           FOR UPDATE`,
          [currentQuote.provider_id],
        );
        const currentProvider = provider.rows[0];
        if (
          !currentProvider ||
          currentProvider.verification_status !== 'verified' ||
          !currentProvider.available
        ) {
          throw new ProviderUnavailableForApprovalError();
        }
      }
      const result = await client.query<ServiceQuoteRow>(
        `UPDATE service_quotes
         SET status = $1, decided_at = NOW()
         WHERE id = $2
         RETURNING id, provider_id, amount_halalas, scope, status, proposed_at, decided_at`,
        [decision, quoteDatabaseId],
      );
      const updatedQuote = result.rows[0];
      if (!updatedQuote) throw new Error('Quote decision could not be saved');
      if (decision === 'rejected' && updatedQuote.provider_id) {
        await client.query(
          `UPDATE request_provider_opportunities
           SET status = 'rejected'
           WHERE service_request_id = $1 AND provider_id = $2
             AND status = 'quoted'`,
          [databaseId, updatedQuote.provider_id],
        );
      }
      if (decision === 'approved') {
        await client.query(
          `INSERT INTO service_payments (
             service_request_id, quote_id, amount_halalas, method, status
           )
           VALUES ($1, $2, $3, 'cash_on_completion', 'cash_due')
           ON CONFLICT (quote_id) DO NOTHING`,
          [databaseId, quoteDatabaseId, updatedQuote.amount_halalas],
        );
        if (updatedQuote.provider_id) {
          const closedQuotes = await client.query<{ id: string }>(
            `UPDATE service_quotes
             SET status = 'rejected', decided_at = NOW()
             WHERE service_request_id = $1 AND provider_id IS NOT NULL
               AND status = 'proposed' AND id <> $2
             RETURNING id`,
            [databaseId, quoteDatabaseId],
          );
          for (let index = 0; index < closedQuotes.rows.length; index += 1) {
            await client.query(
              `INSERT INTO service_request_events (service_request_id, type, status)
               VALUES ($1, 'quote_rejected', 'assigned')`,
              [databaseId],
            );
          }
          const openOpportunities = await client.query<{
            id: string;
            provider_id: string;
          }>(
            `SELECT id, provider_id FROM request_provider_opportunities
             WHERE service_request_id = $1 AND status IN ('invited', 'quoted')`,
            [databaseId],
          );
          await client.query(
            `UPDATE request_provider_opportunities
             SET status = 'closed'
             WHERE service_request_id = $1 AND status IN ('invited', 'quoted')`,
            [databaseId],
          );
          for (
            let index = 0;
            index < openOpportunities.rows.length;
            index += 1
          ) {
            await client.query(
              `INSERT INTO service_request_events (service_request_id, type, status)
               VALUES ($1, 'opportunity_closed', 'assigned')`,
              [databaseId],
            );
          }
          await client.query(
            `UPDATE service_requests
             SET assigned_provider_id = $2,
                 status = CASE
                   WHEN status = 'pending_dispatch' THEN 'assigned'
                   ELSE status
                 END
             WHERE id = $1`,
            [databaseId, updatedQuote.provider_id],
          );
          await client.query(
            `INSERT INTO service_request_events (service_request_id, type, status)
             VALUES ($1, 'provider_assigned', 'assigned')`,
            [databaseId],
          );
          // C3 assignment_confirmed -> customer, P2 provider_assigned ->
          // winner, P3 opportunity_closed -> each closed-opportunity provider
          // excluding the winner. Approval is what atomically closes
          // competitors.
          await this.enqueueCustomerNotification(client, {
            notificationType: 'assignment_confirmed',
            serviceRequestDatabaseId: databaseId,
            customerDatabaseId,
            dedupeKey: `assignment_confirmed:${databaseId}`,
          });
          await this.enqueueProviderNotification(client, {
            notificationType: 'provider_assigned',
            serviceRequestDatabaseId: databaseId,
            providerId: updatedQuote.provider_id,
            dedupeKey: `provider_assigned:${databaseId}:${updatedQuote.provider_id}`,
          });
          for (const opportunity of openOpportunities.rows) {
            if (opportunity.provider_id === updatedQuote.provider_id) continue;
            await this.enqueueProviderNotification(client, {
              notificationType: 'opportunity_closed',
              serviceRequestDatabaseId: databaseId,
              providerId: opportunity.provider_id,
              dedupeKey: `opportunity_closed:${databaseId}:${opportunity.provider_id}`,
            });
          }
        }
      }
      await client.query(
        `INSERT INTO service_request_events (service_request_id, type, status)
         VALUES ($1, $2, $3)`,
        [
          databaseId,
          decision === 'approved' ? 'quote_approved' : 'quote_rejected',
          currentQuote.request_status,
        ],
      );
      await client.query('COMMIT');
      client.release();
      if (decision === 'approved' && updatedQuote.provider_id) {
        this.notificationOutbox.notifyEnqueued();
      }
      return this.toServiceQuote(updatedQuote);
    } catch (error) {
      await this.rollbackAndRelease(client);
      throw error;
    }
  }

  async inviteProvidersToRequest(
    requestId: string,
    providerIds: string[],
    audit?: StaffAuditSpec,
  ): Promise<ProviderOpportunity[]> {
    const databaseId = this.toRequestDatabaseId(requestId);
    const uniqueProviderIds = [...new Set(providerIds)];
    if (uniqueProviderIds.length === 0) {
      throw new Error('Provider invitation list is empty');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const request = await client.query<{
        status: ServiceRequest['status'];
        service_id: string;
        timing: ServiceRequest['timing'];
      }>(
        `SELECT status, service_id, timing
         FROM service_requests
         WHERE id = $1
         FOR UPDATE`,
        [databaseId],
      );
      const currentRequest = request.rows[0];
      if (
        !currentRequest ||
        currentRequest.status === 'completed' ||
        currentRequest.status === 'cancelled'
      ) {
        throw new Error('Request is not open for provider invitations');
      }
      const activeQuote = await client.query<{ id: string }>(
        `SELECT id FROM service_quotes
         WHERE service_request_id = $1 AND status IN ('proposed', 'approved')
         LIMIT 1`,
        [databaseId],
      );
      if (activeQuote.rows[0]) {
        throw new Error(
          'An active quote exists; provider invitations are not allowed',
        );
      }
      const eligible = await client.query<{ provider_id: string }>(
        `SELECT p.id AS provider_id
         FROM providers p
         WHERE p.id = ANY($1::text[])
           AND p.verification_status = 'verified'
           AND p.available = TRUE
           AND $2 = ANY(p.specialties)`,
        [uniqueProviderIds, currentRequest.service_id],
      );
      const created: ProviderOpportunity[] = [];
      const insertedProviderIds: string[] = [];
      for (const providerId of eligible.rows.map((row) => row.provider_id)) {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO request_provider_opportunities (service_request_id, provider_id)
           VALUES ($1, $2)
           ON CONFLICT (service_request_id, provider_id) DO NOTHING
           RETURNING id`,
          [databaseId, providerId],
        );
        if (inserted.rows[0]) {
          await client.query(
            `INSERT INTO service_request_events (service_request_id, type, status)
             VALUES ($1, 'opportunity_invited', $2)`,
            [databaseId, currentRequest.status],
          );
          created.push({
            requestId,
            serviceId: currentRequest.service_id,
            timing: currentRequest.timing,
            opportunityStatus: 'invited',
          });
          insertedProviderIds.push(providerId);
          // P1 opportunity_invited -> provider (required).
          await this.enqueueProviderNotification(client, {
            notificationType: 'opportunity_invited',
            serviceRequestDatabaseId: databaseId,
            providerId,
            dedupeKey: `opportunity_invited:${databaseId}:${providerId}`,
          });
        }
      }
      if (audit && insertedProviderIds.length > 0) {
        await this.insertStaffAuditEvent(
          client,
          audit,
          undefined,
          // The REAL provider ids actually inserted (previously the audit
          // recorded the request id for every entry — a projection bug that
          // the in-transaction rewrite fixes).
          { invitedProviderIds: insertedProviderIds },
        );
      }
      await client.query('COMMIT');
      client.release();
      if (insertedProviderIds.length > 0) {
        this.notificationOutbox.notifyEnqueued();
      }
      return created;
    } catch (error) {
      await this.rollbackAndRelease(client);
      throw error;
    }
  }

  async listProviderOpportunities(
    providerId: string,
  ): Promise<ProviderOpportunityAccess[]> {
    const result = await this.pool.query<{
      request_id: string;
      service_id: string;
      timing: ServiceRequest['timing'];
      details: string | null;
      request_status: ServiceRequest['status'];
      opportunity_status: ProviderOpportunityStatus;
      quote_id: string | null;
      quote_provider_id: string | null;
      quote_amount_halalas: number | null;
      quote_scope: string | null;
      quote_status: ServiceQuoteStatus | null;
      quote_proposed_at: Date | null;
      quote_decided_at: Date | null;
    }>(
      `SELECT r.id AS request_id, r.service_id, r.timing, r.details,
              r.status AS request_status,
              o.status AS opportunity_status,
              q.id AS quote_id, q.provider_id AS quote_provider_id,
              q.amount_halalas AS quote_amount_halalas, q.scope AS quote_scope,
              q.status AS quote_status, q.proposed_at AS quote_proposed_at,
              q.decided_at AS quote_decided_at
       FROM request_provider_opportunities o
       JOIN service_requests r ON r.id = o.service_request_id
       LEFT JOIN LATERAL (
         SELECT id, provider_id, amount_halalas, scope, status, proposed_at, decided_at
         FROM service_quotes
         WHERE service_request_id = r.id AND provider_id = $1
         ORDER BY id DESC
         LIMIT 1
       ) q ON TRUE
       WHERE o.provider_id = $1
       ORDER BY r.id DESC`,
      [providerId],
    );
    return result.rows.map((row) => ({
      requestId: `MOE-${1000 + Number(row.request_id)}`,
      serviceId: row.service_id,
      timing: row.timing,
      opportunityStatus: row.opportunity_status,
      // Request content needed to assess and price the job. Exact address and
      // coordinates are intentionally absent from this query/projection.
      details: row.details ?? undefined,
      requestStatus: row.request_status,
      myQuote: row.quote_id
        ? {
            id: `QTE-${row.quote_id}`,
            providerId: row.quote_provider_id ?? undefined,
            amountHalalas: row.quote_amount_halalas ?? 0,
            scope: row.quote_scope ?? '',
            status: row.quote_status ?? 'proposed',
            proposedAt: row.quote_proposed_at?.toISOString() ?? '',
            decidedAt: row.quote_decided_at?.toISOString(),
          }
        : undefined,
    }));
  }

  async submitProviderQuote(
    requestId: string,
    providerId: string,
    amountHalalas: number,
    scope: string,
  ): Promise<ServiceQuote> {
    const databaseId = this.toRequestDatabaseId(requestId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const request = await client.query<{
        status: ServiceRequest['status'];
        customer_id: string | null;
      }>(
        'SELECT status, customer_id::text FROM service_requests WHERE id = $1 FOR UPDATE',
        [databaseId],
      );
      const currentStatus = request.rows[0]?.status;
      const customerDatabaseId = this.customerDatabaseIdOrNull(
        request.rows[0]?.customer_id,
      );
      if (!currentStatus) throw new Error('Service request not found');
      if (currentStatus !== 'pending_dispatch') {
        throw new Error(
          'Provider quotes are only accepted while the request is pending dispatch',
        );
      }
      const opportunity = await client.query<{
        status: ProviderOpportunityStatus;
      }>(
        `SELECT status FROM request_provider_opportunities
         WHERE service_request_id = $1 AND provider_id = $2
         FOR UPDATE`,
        [databaseId, providerId],
      );
      const opportunityStatus = opportunity.rows[0]?.status;
      if (
        !opportunityStatus ||
        !['invited', 'quoted'].includes(opportunityStatus)
      ) {
        throw new ProviderOpportunityClosedError();
      }
      const staffQuote = await client.query<{ id: string }>(
        `SELECT id FROM service_quotes
         WHERE service_request_id = $1 AND provider_id IS NULL
           AND status IN ('proposed', 'approved')
         LIMIT 1`,
        [databaseId],
      );
      if (staffQuote.rows[0]) {
        throw new StaffQuoteInMarketplaceFlowError();
      }
      const ownActiveQuote = await client.query<{ id: string }>(
        `SELECT id FROM service_quotes
         WHERE service_request_id = $1 AND provider_id = $2
           AND status IN ('proposed', 'approved')
         LIMIT 1`,
        [databaseId, providerId],
      );
      if (ownActiveQuote.rows[0]) {
        throw new ProviderQuoteConflictError();
      }
      let insertedQuote: ServiceQuoteRow;
      try {
        const inserted = await client.query<ServiceQuoteRow>(
          `INSERT INTO service_quotes (service_request_id, provider_id, amount_halalas, scope)
           VALUES ($1, $2, $3, $4)
           RETURNING id, provider_id, amount_halalas, scope, status, proposed_at, decided_at`,
          [databaseId, providerId, amountHalalas, scope],
        );
        insertedQuote = inserted.rows[0];
      } catch (error) {
        if (this.isUniqueViolation(error)) {
          throw new ProviderQuoteConflictError();
        }
        throw error;
      }
      if (!insertedQuote) {
        throw new Error('Provider quote could not be submitted');
      }
      await client.query(
        `UPDATE request_provider_opportunities
         SET status = 'quoted'
         WHERE service_request_id = $1 AND provider_id = $2`,
        [databaseId, providerId],
      );
      await client.query(
        `INSERT INTO service_request_events (service_request_id, type, status)
         VALUES ($1, 'provider_quote_submitted', 'pending_dispatch')`,
        [databaseId],
      );
      // C2 quote_received -> customer (required; provider quote).
      await this.enqueueCustomerNotification(client, {
        notificationType: 'quote_received',
        serviceRequestDatabaseId: databaseId,
        customerDatabaseId,
        dedupeKey: `quote_received:${databaseId}:${insertedQuote.id}`,
      });
      await client.query('COMMIT');
      client.release();
      this.notificationOutbox.notifyEnqueued();
      return this.toServiceQuote(insertedQuote);
    } catch (error) {
      await this.rollbackAndRelease(client);
      throw error;
    }
  }

  async withdrawProviderQuote(
    quoteId: string,
    providerId: string,
  ): Promise<ServiceQuote> {
    const databaseId = this.toQuoteDatabaseId(quoteId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const quote = await client.query<
        ServiceQuoteRow & { request_id: string }
      >(
        `SELECT q.id, q.provider_id, q.amount_halalas, q.scope, q.status,
                q.proposed_at, q.decided_at, q.service_request_id AS request_id
         FROM service_quotes q
         WHERE q.id = $1 AND q.provider_id = $2
         FOR UPDATE`,
        [databaseId, providerId],
      );
      const currentQuote = quote.rows[0];
      if (!currentQuote || currentQuote.status !== 'proposed') {
        throw new Error('Pending provider quote not found');
      }
      const updated = await client.query<ServiceQuoteRow>(
        `UPDATE service_quotes
         SET status = 'withdrawn', decided_at = NOW()
         WHERE id = $1
         RETURNING id, provider_id, amount_halalas, scope, status, proposed_at, decided_at`,
        [databaseId],
      );
      if (!updated.rows[0]) {
        throw new Error('Provider quote could not be withdrawn');
      }
      await client.query(
        `UPDATE request_provider_opportunities
         SET status = 'withdrawn'
         WHERE service_request_id = $1 AND provider_id = $2`,
        [currentQuote.request_id, providerId],
      );
      await client.query(
        `INSERT INTO service_request_events (service_request_id, type, status)
         VALUES ($1, 'provider_quote_withdrawn', 'pending_dispatch')`,
        [currentQuote.request_id],
      );
      await client.query('COMMIT');
      client.release();
      return this.toServiceQuote(updated.rows[0]);
    } catch (error) {
      await this.rollbackAndRelease(client);
      throw error;
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === '23505'
    );
  }

  async closeProviderOpportunity(
    requestId: string,
    providerId: string,
    audit?: StaffAuditSpec,
  ): Promise<{ closed: boolean }> {
    const databaseId = this.toRequestDatabaseId(requestId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const request = await client.query<{ status: ServiceRequest['status'] }>(
        'SELECT status FROM service_requests WHERE id = $1 FOR UPDATE',
        [databaseId],
      );
      const requestStatus = request.rows[0]?.status;
      if (!requestStatus) throw new Error('Service request not found');
      const updated = await client.query<{ id: string }>(
        `UPDATE request_provider_opportunities
         SET status = 'closed'
         WHERE service_request_id = $1 AND provider_id = $2
           AND status IN ('invited', 'quoted')
         RETURNING id`,
        [databaseId, providerId],
      );
      const closed = updated.rows.length > 0;
      if (closed) {
        await client.query(
          `INSERT INTO service_request_events (service_request_id, type, status)
           VALUES ($1, 'opportunity_closed', $2)`,
          [databaseId, requestStatus],
        );
      }
      if (audit && closed) {
        await this.insertStaffAuditEvent(client, audit, undefined, {
          providerId,
          closed,
        });
      }
      await client.query('COMMIT');
      client.release();
      return { closed };
    } catch (error) {
      await this.rollbackAndRelease(client);
      throw error;
    }
  }

  async collectCashPayment(
    requestId: string,
    audit?: StaffAuditSpec,
  ): Promise<ServicePayment> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const payment = await client.query<
        ServicePaymentRow & { request_status: ServiceRequest['status'] }
      >(
        `SELECT p.id, p.amount_halalas, p.currency, p.method, p.status,
                p.created_at, p.collected_at, p.refunded_at,
                r.status AS request_status
         FROM service_payments p
         JOIN service_requests r ON r.id = p.service_request_id
         WHERE p.service_request_id = $1 AND p.method = 'cash_on_completion'
         FOR UPDATE OF p, r`,
        [this.toRequestDatabaseId(requestId)],
      );
      const currentPayment = payment.rows[0];
      if (!currentPayment) throw new Error('Cash payment not found');
      if (currentPayment.status !== 'cash_due') {
        throw new Error('Cash payment is not due');
      }
      if (currentPayment.request_status !== 'completed') {
        throw new Error('Cash can only be collected after completion');
      }
      const collected = await client.query<ServicePaymentRow>(
        `UPDATE service_payments
         SET status = 'cash_collected', collected_at = NOW()
         WHERE id = $1 AND status = 'cash_due'
         RETURNING id, amount_halalas, currency, method, status, created_at, collected_at, refunded_at`,
        [currentPayment.id],
      );
      const row = collected.rows[0];
      if (!row) throw new Error('Cash payment could not be collected');
      if (audit) {
        await this.insertStaffAuditEvent(
          client,
          audit,
          this.toPaymentAuditState(currentPayment),
          this.toPaymentAuditState(row),
        );
      }
      await client.query('COMMIT');
      client.release();
      return this.toServicePayment(row);
    } catch (error) {
      await this.rollbackAndRelease(client);
      throw error;
    }
  }

  async refundCashPayment(
    requestId: string,
    audit?: StaffAuditSpec,
  ): Promise<ServicePayment> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const payment = await client.query<ServicePaymentRow>(
        `SELECT id, amount_halalas, currency, method, status, created_at, collected_at, refunded_at
         FROM service_payments
         WHERE service_request_id = $1 AND method = 'cash_on_completion'
         FOR UPDATE`,
        [this.toRequestDatabaseId(requestId)],
      );
      const currentPayment = payment.rows[0];
      if (!currentPayment) throw new Error('Cash payment not found');
      if (currentPayment.status !== 'cash_collected') {
        throw new Error('Cash payment is not eligible for refund');
      }
      const refunded = await client.query<ServicePaymentRow>(
        `UPDATE service_payments
         SET status = 'refunded', refunded_at = NOW()
         WHERE id = $1 AND status = 'cash_collected'
         RETURNING id, amount_halalas, currency, method, status, created_at, collected_at, refunded_at`,
        [currentPayment.id],
      );
      const row = refunded.rows[0];
      if (!row) throw new Error('Cash payment could not be refunded');
      if (audit) {
        await this.insertStaffAuditEvent(
          client,
          audit,
          this.toPaymentAuditState(currentPayment),
          this.toPaymentAuditState(row),
        );
      }
      await client.query('COMMIT');
      client.release();
      return this.toServicePayment(row);
    } catch (error) {
      await this.rollbackAndRelease(client);
      throw error;
    }
  }

  async rateRequest(
    requestId: string,
    customerId: string,
    rating: number,
    comment?: string,
  ): Promise<ServiceRequest> {
    const databaseId = Number(requestId.replace('MOE-', '')) - 1000;
    const result = await this.pool.query<{ id: string }>(
      `UPDATE service_requests
       SET rating = $1, rating_comment = $2
       WHERE id = $3 AND customer_id = $4 AND status = 'completed' AND rating IS NULL
       RETURNING id`,
      [
        rating,
        comment ?? null,
        databaseId,
        this.toCustomerDatabaseId(customerId),
      ],
    );
    if (!result.rows[0]) {
      throw new Error('Completed unrated customer request not found');
    }
    const request = (await this.findByCustomerId(customerId)).find(
      (item) => item.id === requestId,
    );
    if (!request) throw new Error('Rated request could not be loaded');
    return request;
  }

  async createSupportTicket(
    requestId: string,
    customerId: string,
    category: SupportCategory,
    comment: string,
  ): Promise<SupportTicket> {
    const result = await this.pool.query<SupportTicketRow>(
      `INSERT INTO support_tickets (service_request_id, customer_id, category, comment)
       SELECT r.id, r.customer_id, $1, $2
       FROM service_requests r
       WHERE r.id = $3 AND r.customer_id = $4
       RETURNING id, service_request_id, category, comment, status, created_at`,
      [
        category,
        comment,
        this.toRequestDatabaseId(requestId),
        this.toCustomerDatabaseId(customerId),
      ],
    );
    if (!result.rows[0]) throw new Error('Customer request not found');
    return this.toSupportTicket(result.rows[0]);
  }

  async findSupportTickets(): Promise<SupportTicket[]> {
    const result = await this.pool.query<SupportTicketRow>(
      `SELECT id, service_request_id, category, comment, status, created_at
       FROM support_tickets ORDER BY created_at DESC`,
    );
    return result.rows.map((row) => this.toSupportTicket(row));
  }

  async updateSupportTicketStatus(
    ticketId: string,
    status: SupportTicketStatus,
    audit?: StaffAuditSpec,
  ): Promise<SupportTicket> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Authoritative old state: locked read inside the same transaction that
      // performs the mutation (B5 invariant).
      const current = await client.query<{ status: SupportTicketStatus }>(
        'SELECT status FROM support_tickets WHERE id = $1 FOR UPDATE',
        [this.toSupportTicketDatabaseId(ticketId)],
      );
      const currentStatus = current.rows[0]?.status;
      if (!currentStatus) throw new Error('Support ticket not found');
      const result = await client.query<SupportTicketRow>(
        `UPDATE support_tickets SET status = $1
         WHERE id = $2
         RETURNING id, service_request_id, category, comment, status, created_at`,
        [status, this.toSupportTicketDatabaseId(ticketId)],
      );
      const row = result.rows[0];
      if (!row) throw new Error('Support ticket not found');
      if (audit) {
        await this.insertStaffAuditEvent(
          client,
          audit,
          { status: currentStatus },
          { status: row.status },
        );
      }
      await client.query('COMMIT');
      client.release();
      return this.toSupportTicket(row);
    } catch (error) {
      await this.rollbackAndRelease(client);
      throw error;
    }
  }

  async reserveOtpRequest(
    phone: string,
    requestedAt: Date,
  ): Promise<'accepted' | 'cooldown' | 'limit'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [phone]);

      const windowStart = new Date(requestedAt.getTime() - 60 * 60_000);
      const recent = await client.query<{ requested_at: Date }>(
        `SELECT requested_at
         FROM customer_otp_request_attempts
         WHERE phone = $1 AND requested_at > $2
         ORDER BY requested_at DESC`,
        [phone, windowStart],
      );
      const previousRequestAt = recent.rows[0]?.requested_at;
      if (
        previousRequestAt &&
        requestedAt.getTime() - previousRequestAt.getTime() < 60_000
      ) {
        await client.query('COMMIT');
        client.release();
        return 'cooldown';
      }
      if (recent.rows.length >= 5) {
        await client.query('COMMIT');
        client.release();
        return 'limit';
      }

      await client.query(
        `INSERT INTO customer_otp_request_attempts (phone, requested_at)
         VALUES ($1, $2)`,
        [phone, requestedAt],
      );
      await client.query(
        'DELETE FROM customer_otp_request_attempts WHERE requested_at < $1',
        [windowStart],
      );
      await client.query('COMMIT');
      client.release();
      return 'accepted';
    } catch (error) {
      await this.rollbackAndRelease(client);
      throw error;
    }
  }

  async createOtpChallenge(
    input: Pick<StoredOtpChallenge, 'challengeId' | 'phone' | 'expiresAt'>,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO customer_otp_challenges (challenge_id, phone, expires_at)
       VALUES ($1, $2, $3)`,
      [input.challengeId, input.phone, input.expiresAt],
    );
  }

  async reserveOtpVerificationAttempt(
    challengeId: string,
  ): Promise<StoredOtpChallenge | undefined> {
    const result = await this.pool.query<OtpChallengeRow>(
      `UPDATE customer_otp_challenges
       SET failed_attempts = failed_attempts + 1
       WHERE challenge_id = $1
         AND expires_at > NOW()
         AND failed_attempts < 5
       RETURNING challenge_id, phone, expires_at, failed_attempts`,
      [challengeId],
    );
    const row = result.rows[0];
    return row
      ? {
          challengeId: row.challenge_id,
          phone: row.phone,
          expiresAt: row.expires_at,
          failedAttempts: row.failed_attempts,
        }
      : undefined;
  }

  async findOtpChallenge(
    challengeId: string,
  ): Promise<StoredOtpChallenge | undefined> {
    const result = await this.pool.query<OtpChallengeRow>(
      `SELECT challenge_id, phone, expires_at, failed_attempts
       FROM customer_otp_challenges
       WHERE challenge_id = $1`,
      [challengeId],
    );
    const row = result.rows[0];
    return row
      ? {
          challengeId: row.challenge_id,
          phone: row.phone,
          expiresAt: row.expires_at,
          failedAttempts: row.failed_attempts,
        }
      : undefined;
  }

  async recordOtpFailure(challengeId: string): Promise<number | undefined> {
    const result = await this.pool.query<{ failed_attempts: number }>(
      `UPDATE customer_otp_challenges
       SET failed_attempts = failed_attempts + 1
       WHERE challenge_id = $1 AND failed_attempts < 5
       RETURNING failed_attempts`,
      [challengeId],
    );
    return result.rows[0]?.failed_attempts;
  }

  async consumeOtpChallenge(challengeId: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM customer_otp_challenges
       WHERE challenge_id = $1 AND expires_at > NOW()
       RETURNING challenge_id`,
      [challengeId],
    );
    return result.rowCount === 1;
  }

  async upsertCustomer(phone: string): Promise<Customer> {
    const result = await this.pool.query<{ id: string; phone: string }>(
      `INSERT INTO customers (phone) VALUES ($1)
       ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone
       RETURNING id, phone`,
      [phone],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Customer could not be created');
    return { id: `CUS-${1000 + Number(row.id)}`, phone: row.phone };
  }

  async createCustomerSession(
    customerId: string,
    token: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO customer_sessions (token_hash, customer_id, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '30 days')
       ON CONFLICT (token_hash) DO UPDATE
       SET customer_id = EXCLUDED.customer_id, expires_at = EXCLUDED.expires_at`,
      [this.hashToken(token), this.toCustomerDatabaseId(customerId)],
    );
  }

  async revokeCustomerSession(token: string): Promise<void> {
    await this.pool.query(
      'DELETE FROM customer_sessions WHERE token_hash = $1',
      [this.hashToken(token)],
    );
  }

  async findCustomerBySession(token: string): Promise<Customer | undefined> {
    const result = await this.pool.query<{ id: string; phone: string }>(
      `SELECT c.id, c.phone
       FROM customer_sessions s
       JOIN customers c ON c.id = s.customer_id
       WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
      [this.hashToken(token)],
    );
    const row = result.rows[0];
    return row
      ? { id: `CUS-${1000 + Number(row.id)}`, phone: row.phone }
      : undefined;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private toProviderAppPrincipal(row: PilotProviderRow): ProviderAppPrincipal {
    return {
      id: row.id,
      name: row.name,
      specialties: row.specialties,
      serviceZone: row.service_zone,
      available: row.available,
    };
  }

  private toPilotProvider(row: PilotProviderRow): PilotProvider {
    return {
      id: row.id,
      name: row.name,
      specialties: row.specialties,
      available: row.available,
      serviceZone: row.service_zone,
      verificationStatus: row.verification_status,
    };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private toCustomerDatabaseId(customerId: string): number {
    const match = /^CUS-(\d+)$/.exec(customerId);
    if (!match) throw new Error('Invalid customer id');
    return Number(match[1]) - 1000;
  }

  /**
   * Null-safe conversion of a `customer_id::text` column read. Legacy
   * service-request rows may carry a NULL customer ownership; those sites
   * must pass `null` through to the outbox writer (which skips the
   * notification) rather than coercing NULL to `Number(null) === 0`, a
   * fabricated customer id that would fail the FK and roll back an
   * otherwise-valid domain mutation (FCM-2 HIGH #2).
   */
  private customerDatabaseIdOrNull(
    value: string | null | undefined,
  ): number | null {
    return value === null || value === undefined ? null : Number(value);
  }

  private toRequestDatabaseId(requestId: string): number {
    const match = /^MOE-(\d+)$/.exec(requestId);
    if (!match) throw new Error('Invalid request id');
    return Number(match[1]) - 1000;
  }

  private toQuoteDatabaseId(quoteId: string): number {
    const match = /^QTE-(\d+)$/.exec(quoteId);
    if (!match) throw new Error('Invalid quote id');
    return Number(match[1]);
  }

  private toSupportTicketDatabaseId(ticketId: string): number {
    const match = /^SUP-(\d+)$/.exec(ticketId);
    if (!match) throw new Error('Invalid support ticket id');
    return Number(match[1]) - 1000;
  }

  private toSupportTicket(row: SupportTicketRow): SupportTicket {
    return {
      id: `SUP-${1000 + Number(row.id)}`,
      requestId: `MOE-${1000 + Number(row.service_request_id)}`,
      category: row.category,
      comment: row.comment,
      status: row.status,
      createdAt: row.created_at.toISOString(),
    };
  }

  private toServiceQuote(row: ServiceQuoteRow): ServiceQuote {
    return {
      id: `QTE-${row.id}`,
      providerId: row.provider_id ?? undefined,
      amountHalalas: row.amount_halalas,
      scope: row.scope,
      status: row.status,
      proposedAt: row.proposed_at.toISOString(),
      decidedAt: row.decided_at?.toISOString(),
    };
  }

  private toServicePayment(row: ServicePaymentRow): ServicePayment {
    return {
      id: `PAY-${row.id}`,
      amountHalalas: row.amount_halalas,
      currency: row.currency,
      method: row.method,
      status: row.status,
      createdAt: row.created_at.toISOString(),
      collectedAt: row.collected_at?.toISOString(),
      refundedAt: row.refunded_at?.toISOString(),
    };
  }

  private toPaymentAuditState(row: ServicePaymentRow): Record<string, unknown> {
    return {
      paymentId: `PAY-${row.id}`,
      method: row.method,
      status: row.status,
      amountHalalas: row.amount_halalas,
      currency: row.currency,
    };
  }

  private toServiceRequest(row: ServiceRequestRow): ServiceRequest {
    return {
      id: `MOE-${1000 + Number(row.id)}`,
      serviceId: row.service_id,
      address: row.address,
      location:
        row.location_latitude != null &&
        row.location_longitude != null &&
        row.location_source != null &&
        row.location_confirmed_at != null
          ? {
              point: {
                latitude: Number(row.location_latitude),
                longitude: Number(row.location_longitude),
              },
              displayAddress: row.address,
              source: row.location_source,
              confirmedAt: row.location_confirmed_at.toISOString(),
            }
          : undefined,
      details: row.details ?? undefined,
      timing: row.timing,
      status: row.status,
      assignedProvider: row.assigned_provider_id
        ? {
            id: row.assigned_provider_id,
            name: row.assigned_provider_name ?? '',
            specialties: row.assigned_provider_specialties ?? [],
            available: row.assigned_provider_available ?? false,
          }
        : undefined,
      quote: row.quote_id
        ? {
            id: `QTE-${row.quote_id}`,
            providerId: row.quote_provider_id ?? undefined,
            providerName: row.quote_provider_name ?? undefined,
            amountHalalas: row.quote_amount_halalas ?? 0,
            scope: row.quote_scope ?? '',
            status: row.quote_status ?? 'proposed',
            proposedAt: row.quote_proposed_at?.toISOString() ?? '',
            decidedAt: row.quote_decided_at?.toISOString(),
          }
        : undefined,
      opportunities:
        Number(row.opportunity_total) > 0
          ? {
              invited: Number(row.opportunity_invited),
              quoted: Number(row.opportunity_quoted),
              withdrawn: Number(row.opportunity_withdrawn),
              closed: Number(row.opportunity_closed),
              rejected: Number(row.opportunity_rejected),
              total: Number(row.opportunity_total),
            }
          : undefined,
      payment: row.payment_id
        ? this.toServicePayment({
            id: row.payment_id,
            amount_halalas: row.payment_amount_halalas ?? 0,
            currency: row.payment_currency ?? 'SAR',
            method: row.payment_method ?? 'cash_on_completion',
            status: row.payment_status ?? 'cash_due',
            created_at: row.payment_created_at ?? row.created_at,
            collected_at: row.payment_collected_at,
            refunded_at: row.payment_refunded_at,
          })
        : undefined,
      customerPhone:
        row.customer_phone != null &&
        this.mayDiscloseCustomerPhoneToProvider(row.status)
          ? row.customer_phone
          : undefined,
      rating: row.rating ?? undefined,
      ratingComment: row.rating_comment ?? undefined,
      createdAt: row.created_at.toISOString(),
    };
  }

  /**
   * Authorization gate for post-assignment customer phone disclosure.
   *
   * The customer phone may reach a provider response ONLY while the request
   * is in an active assigned lifecycle state. `findByProviderId` (the one
   * read path that selects `customer_phone`) already restricts rows to the
   * authenticated assigned provider via `WHERE r.assigned_provider_id = $1`,
   * so this status check is the remaining boundary: terminal states
   * (completed/cancelled) never carry the phone. Every other read path never
   * selects `customer_phone`, so the mapped field stays absent for customer,
   * staff, and pre-quote opportunity views regardless of this gate.
   */
  private mayDiscloseCustomerPhoneToProvider(
    status: ServiceRequest['status'],
  ): boolean {
    return (
      status === 'assigned' ||
      status === 'on_the_way' ||
      status === 'in_progress'
    );
  }
}

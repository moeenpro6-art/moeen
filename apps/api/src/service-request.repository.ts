import { createHash, randomUUID } from 'node:crypto';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
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
  ProviderOpportunityStatus,
  ServiceRequestStore,
  SupportCategory,
  SupportTicket,
  SupportTicketStatus,
} from './app.service';

type ServiceRequestRow = {
  id: string;
  service_id: string;
  address: string;
  details: string | null;
  timing: CreateServiceRequest['timing'];
  status: ServiceRequest['status'];
  assigned_provider_id: string | null;
  assigned_provider_name: string | null;
  assigned_provider_specialties: string[] | null;
  assigned_provider_available: boolean | null;
  rating: number | null;
  rating_comment: string | null;
  quote_id: string | null;
  quote_amount_halalas: number | null;
  quote_scope: string | null;
  quote_status: ServiceQuoteStatus | null;
  quote_proposed_at: Date | null;
  quote_decided_at: Date | null;
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

  async onModuleInit(): Promise<void> {
    await this.initialize();
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id BIGSERIAL PRIMARY KEY,
        phone TEXT UNIQUE NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS customer_sessions (
        token_hash TEXT PRIMARY KEY,
        customer_id BIGINT NOT NULL REFERENCES customers(id),
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS customer_otp_challenges (
        challenge_id UUID PRIMARY KEY,
        phone TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        failed_attempts SMALLINT NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(
      'CREATE INDEX IF NOT EXISTS customer_otp_challenges_expires_at_idx ON customer_otp_challenges (expires_at)',
    );
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS customer_otp_request_attempts (
        id BIGSERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        requested_at TIMESTAMPTZ NOT NULL
      )
    `);
    await this.pool.query(
      'CREATE INDEX IF NOT EXISTS customer_otp_request_attempts_phone_requested_at_idx ON customer_otp_request_attempts (phone, requested_at DESC)',
    );
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        specialties TEXT[] NOT NULL,
        available BOOLEAN NOT NULL DEFAULT TRUE
      )
    `);
    await this.pool.query(
      "ALTER TABLE providers ADD COLUMN IF NOT EXISTS service_zone TEXT NOT NULL DEFAULT 'بريدة'",
    );
    await this.pool.query(
      "ALTER TABLE providers ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending', 'verified', 'suspended'))",
    );
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS provider_access_credentials (
        provider_id TEXT PRIMARY KEY REFERENCES providers(id),
        access_code_hash TEXT UNIQUE NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Indexed access-code lookup (SHA-256 lookup id) with a uniqueness
    // constraint as the final protection. Idempotent; no destructive DDL.
    await this.pool.query(
      'ALTER TABLE provider_access_credentials ADD COLUMN IF NOT EXISTS lookup_id TEXT',
    );
    await this.pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS provider_access_lookup_idx
       ON provider_access_credentials (lookup_id)
       WHERE lookup_id IS NOT NULL`,
    );
    // Backfill lookup ids only where safely derivable: legacy SHA-256 hashes
    // are exactly sha256(accessCode). Salted scrypt hashes cannot be derived
    // and must be rotated by operations (login fails generically until then).
    await this.pool.query(
      `UPDATE provider_access_credentials
       SET lookup_id = access_code_hash
       WHERE lookup_id IS NULL AND access_code_hash ~ '^[a-f0-9]{64}$'`,
    );
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS provider_sessions (
        token_hash TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL REFERENCES providers(id),
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(
      'CREATE INDEX IF NOT EXISTS provider_sessions_provider_expires_idx ON provider_sessions (provider_id, expires_at DESC)',
    );
    if (process.env.NODE_ENV === 'test') {
      await this.pool.query(`
        INSERT INTO providers (id, name, specialties, available, service_zone, verification_status)
        VALUES
          ('provider-1', 'فريق التبريد السريع', ARRAY['ac-cleaning'], TRUE, 'بريدة', 'verified'),
          ('provider-2', 'مؤسسة النظافة المنزلية', ARRAY['upholstery', 'home-cleaning', 'tank-cleaning'], TRUE, 'بريدة', 'verified'),
          ('provider-3', 'فني السباكة محمد', ARRAY['plumbing'], TRUE, 'بريدة', 'verified')
        ON CONFLICT (id) DO UPDATE
        SET verification_status = 'verified', available = TRUE
      `);
    }
    await this.pool.query(`
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
    await this.pool.query(
      'ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS assigned_provider_id TEXT REFERENCES providers(id)',
    );
    await this.pool.query(
      'ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS customer_id BIGINT REFERENCES customers(id)',
    );
    await this.pool.query(
      'ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS rating SMALLINT CHECK (rating BETWEEN 1 AND 5)',
    );
    await this.pool.query(
      'ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS rating_comment TEXT',
    );
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS service_request_events (
        id BIGSERIAL PRIMARY KEY,
        service_request_id BIGINT NOT NULL REFERENCES service_requests(id),
        type TEXT NOT NULL CHECK (type IN ('request_created', 'provider_assigned', 'status_updated', 'quote_proposed', 'quote_approved', 'quote_rejected')),
        status TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(
      'CREATE INDEX IF NOT EXISTS service_request_events_request_created_idx ON service_request_events (service_request_id, id)',
    );
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS service_quotes (
        id BIGSERIAL PRIMARY KEY,
        service_request_id BIGINT NOT NULL REFERENCES service_requests(id),
        amount_halalas INTEGER NOT NULL CHECK (amount_halalas > 0),
        scope TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected')) DEFAULT 'proposed',
        proposed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        decided_at TIMESTAMPTZ
      )
    `);
    await this.pool.query(
      'CREATE INDEX IF NOT EXISTS service_quotes_request_latest_idx ON service_quotes (service_request_id, id DESC)',
    );
    // Provider-owned marketplace quotes (additive; staff quotes keep provider_id NULL)
    await this.pool.query(
      'ALTER TABLE service_quotes ADD COLUMN IF NOT EXISTS provider_id TEXT REFERENCES providers(id)',
    );
    await this.pool.query(
      'CREATE INDEX IF NOT EXISTS service_quotes_provider_idx ON service_quotes (provider_id)',
    );
    // Final concurrency protection: one active provider quote per provider per request
    await this.pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS service_quotes_one_active_per_provider
       ON service_quotes (service_request_id, provider_id)
       WHERE status IN ('proposed', 'approved') AND provider_id IS NOT NULL`,
    );
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS request_provider_opportunities (
        id BIGSERIAL PRIMARY KEY,
        service_request_id BIGINT NOT NULL REFERENCES service_requests(id),
        provider_id TEXT NOT NULL REFERENCES providers(id),
        status TEXT NOT NULL DEFAULT 'invited'
          CHECK (status IN ('invited', 'quoted', 'withdrawn', 'closed')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (service_request_id, provider_id)
      )
    `);
    await this.pool.query(
      'CREATE INDEX IF NOT EXISTS opportunities_provider_idx ON request_provider_opportunities (provider_id, status)',
    );
    // Extend the quote status CHECK with 'withdrawn' (controlled, idempotent, race-safe)
    await this.pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'service_quotes_status_check'
            AND pg_get_constraintdef(oid) LIKE '%withdrawn%'
        ) THEN
          BEGIN
            ALTER TABLE service_quotes
              DROP CONSTRAINT IF EXISTS service_quotes_status_check,
              ADD CONSTRAINT service_quotes_status_check
                CHECK (status IN ('proposed', 'approved', 'rejected', 'withdrawn'));
          EXCEPTION WHEN duplicate_object THEN
            NULL;
          END;
        END IF;
      END $$;
    `);
    // Extend the event type CHECK with distinct marketplace event types
    await this.pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'service_request_events_type_check'
            AND pg_get_constraintdef(oid) LIKE '%opportunity_closed%'
        ) THEN
          BEGIN
            ALTER TABLE service_request_events
              DROP CONSTRAINT IF EXISTS service_request_events_type_check,
              ADD CONSTRAINT service_request_events_type_check
                CHECK (type IN ('request_created', 'provider_assigned', 'status_updated',
                                'quote_proposed', 'quote_approved', 'quote_rejected',
                                'opportunity_invited', 'opportunity_closed',
                                'provider_quote_submitted', 'provider_quote_withdrawn'));
          EXCEPTION WHEN duplicate_object THEN
            NULL;
          END;
        END IF;
      END $$;
    `);
    // Extend the opportunity status CHECK with 'rejected' (controlled, idempotent, race-safe)
    await this.pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'request_provider_opportunities_status_check'
            AND pg_get_constraintdef(oid) LIKE '%rejected%'
        ) THEN
          BEGIN
            ALTER TABLE request_provider_opportunities
              DROP CONSTRAINT IF EXISTS request_provider_opportunities_status_check,
              ADD CONSTRAINT request_provider_opportunities_status_check
                CHECK (status IN ('invited', 'quoted', 'withdrawn', 'closed', 'rejected'));
          EXCEPTION WHEN duplicate_object THEN
            NULL;
          END;
        END IF;
      END $$;
    `);
    await this.pool.query(`
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
    await this.pool.query(
      'ALTER TABLE service_payments ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ',
    );
    await this.pool.query(
      'CREATE INDEX IF NOT EXISTS service_payments_request_created_idx ON service_payments (service_request_id, id DESC)',
    );
    await this.pool.query(`
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
  }

  async create(
    input: CreateServiceRequest,
    customerId: string,
  ): Promise<ServiceRequest> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<ServiceRequestRow>(
        `INSERT INTO service_requests (service_id, address, details, timing, customer_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, service_id, address, details, timing, status, created_at`,
        [
          input.serviceId,
          input.address,
          input.details ?? null,
          input.timing,
          this.toCustomerDatabaseId(customerId),
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('Service request could not be created');
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
      await client.query('COMMIT');
      return this.toServiceRequest(row);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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
  }

  async findAll(): Promise<ServiceRequest[]> {
    const result = await this.pool.query<ServiceRequestRow>(
      `SELECT r.id, r.service_id, r.address, r.details, r.timing, r.status, r.created_at,
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
       ORDER BY r.id DESC`,
    );

    return result.rows.map((row) => this.toServiceRequest(row));
  }

  async findByCustomerId(customerId: string): Promise<ServiceRequest[]> {
    const result = await this.pool.query<ServiceRequestRow>(
      `SELECT r.id, r.service_id, r.address, r.details, r.timing, r.status, r.created_at,
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
      `SELECT r.id, r.service_id, r.address, r.details, r.timing, r.status, r.created_at,
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
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
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
  ): Promise<PilotProvider> {
    const result = await this.pool.query<PilotProviderRow>(
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
    return this.toPilotProvider(row);
  }

  async updatePilotProviderVerification(
    providerId: string,
    verificationStatus: PilotProviderVerificationStatus,
  ): Promise<PilotProvider> {
    const result = await this.pool.query<PilotProviderRow>(
      `UPDATE providers
       SET verification_status = $2,
           available = CASE WHEN $2 = 'verified' THEN TRUE ELSE FALSE END
       WHERE id = $1
       RETURNING id, name, specialties, available, service_zone, verification_status`,
      [providerId, verificationStatus],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Pilot provider not found');
    return this.toPilotProvider(row);
  }

  async assignProvider(
    requestId: string,
    providerId: string,
  ): Promise<ServiceRequest> {
    const databaseId = Number(requestId.replace('MOE-', '')) - 1000;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<ServiceRequestRow>(
        `UPDATE service_requests r
         SET assigned_provider_id = p.id, status = 'assigned'
         FROM providers p
         WHERE r.id = $1 AND r.status = 'pending_dispatch' AND p.id = $2 AND p.available = TRUE
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
      await client.query(
        `INSERT INTO service_request_events (service_request_id, type, status)
         VALUES ($1, 'provider_assigned', 'assigned')`,
        [databaseId],
      );
      await client.query('COMMIT');
      return this.toServiceRequest(row);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async updateStatus(
    requestId: string,
    status: ServiceRequest['status'],
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
      const current = await client.query<{ status: ServiceRequest['status'] }>(
        'SELECT status FROM service_requests WHERE id = $1 FOR UPDATE',
        [databaseId],
      );
      const currentStatus = current.rows[0]?.status;
      if (!currentStatus || !previousStatuses.includes(currentStatus)) {
        throw new Error('Invalid status transition');
      }
      if (status === 'in_progress') {
        const latestQuote = await client.query<{ status: ServiceQuoteStatus }>(
          `SELECT status FROM service_quotes
           WHERE service_request_id = $1
           ORDER BY id DESC
           LIMIT 1`,
          [databaseId],
        );
        if (latestQuote.rows[0] && latestQuote.rows[0].status !== 'approved') {
          throw new Error('Quote approval required');
        }
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
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
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
      const current = await client.query<{ status: ServiceRequest['status'] }>(
        `SELECT status
         FROM service_requests
         WHERE id = $1 AND assigned_provider_id = $2
         FOR UPDATE`,
        [databaseId, providerId],
      );
      const currentStatus = current.rows[0]?.status;
      if (!currentStatus) {
        throw new Error('Assigned provider request not found');
      }
      if (!previousStatuses.includes(currentStatus)) {
        throw new Error('Invalid status transition');
      }
      if (status === 'in_progress') {
        const latestQuote = await client.query<{ status: ServiceQuoteStatus }>(
          `SELECT status FROM service_quotes
           WHERE service_request_id = $1
           ORDER BY id DESC
           LIMIT 1`,
          [databaseId],
        );
        if (latestQuote.rows[0] && latestQuote.rows[0].status !== 'approved') {
          throw new Error('Quote approval required');
        }
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
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
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
  ): Promise<ServiceQuote> {
    const databaseId = this.toRequestDatabaseId(requestId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const request = await client.query<{ status: ServiceRequest['status'] }>(
        'SELECT status FROM service_requests WHERE id = $1 FOR UPDATE',
        [databaseId],
      );
      const status = request.rows[0]?.status;
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
      await client.query('COMMIT');
      return this.toServiceQuote(quote);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
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
      const quote = await client.query<
        ServiceQuoteRow & { request_status: ServiceRequest['status'] }
      >(
        `SELECT q.id, q.provider_id, q.amount_halalas, q.scope, q.status, q.proposed_at, q.decided_at,
                r.status AS request_status
         FROM service_quotes q
         JOIN service_requests r ON r.id = q.service_request_id
         WHERE q.id = $1 AND q.service_request_id = $2 AND r.customer_id = $3
         FOR UPDATE OF q, r`,
        [quoteDatabaseId, databaseId, this.toCustomerDatabaseId(customerId)],
      );
      const currentQuote = quote.rows[0];
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
          const openOpportunities = await client.query<{ id: string }>(
            `SELECT id FROM request_provider_opportunities
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
      return this.toServiceQuote(updatedQuote);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async inviteProvidersToRequest(
    requestId: string,
    providerIds: string[],
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
        }
      }
      await client.query('COMMIT');
      return created;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listProviderOpportunities(
    providerId: string,
  ): Promise<ProviderOpportunity[]> {
    const result = await this.pool.query<{
      request_id: string;
      service_id: string;
      timing: ServiceRequest['timing'];
      opportunity_status: ProviderOpportunityStatus;
      quote_id: string | null;
      quote_provider_id: string | null;
      quote_amount_halalas: number | null;
      quote_scope: string | null;
      quote_status: ServiceQuoteStatus | null;
      quote_proposed_at: Date | null;
      quote_decided_at: Date | null;
    }>(
      `SELECT r.id AS request_id, r.service_id, r.timing,
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
      const request = await client.query<{ status: ServiceRequest['status'] }>(
        'SELECT status FROM service_requests WHERE id = $1 FOR UPDATE',
        [databaseId],
      );
      const currentStatus = request.rows[0]?.status;
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
      await client.query('COMMIT');
      return this.toServiceQuote(insertedQuote);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
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
      return this.toServiceQuote(updated.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
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
      await client.query('COMMIT');
      return { closed };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async collectCashPayment(requestId: string): Promise<ServicePayment> {
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
      await client.query('COMMIT');
      return this.toServicePayment(row);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async refundCashPayment(requestId: string): Promise<ServicePayment> {
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
      await client.query('COMMIT');
      return this.toServicePayment(row);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
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
  ): Promise<SupportTicket> {
    const result = await this.pool.query<SupportTicketRow>(
      `UPDATE support_tickets SET status = $1
       WHERE id = $2
       RETURNING id, service_request_id, category, comment, status, created_at`,
      [status, this.toSupportTicketDatabaseId(ticketId)],
    );
    if (!result.rows[0]) throw new Error('Support ticket not found');
    return this.toSupportTicket(result.rows[0]);
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
        return 'cooldown';
      }
      if (recent.rows.length >= 5) {
        await client.query('COMMIT');
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
      return 'accepted';
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
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

  private toServiceRequest(row: ServiceRequestRow): ServiceRequest {
    return {
      id: `MOE-${1000 + Number(row.id)}`,
      serviceId: row.service_id,
      address: row.address,
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
            amountHalalas: row.quote_amount_halalas ?? 0,
            scope: row.quote_scope ?? '',
            status: row.quote_status ?? 'proposed',
            proposedAt: row.quote_proposed_at?.toISOString() ?? '',
            decidedAt: row.quote_decided_at?.toISOString(),
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
      rating: row.rating ?? undefined,
      ratingComment: row.rating_comment ?? undefined,
      createdAt: row.created_at.toISOString(),
    };
  }
}

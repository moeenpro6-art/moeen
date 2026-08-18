import { randomUUID } from 'node:crypto';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { resolveDatabaseConnectionString } from './database.config';
import {
  FcmDeviceLimitExceededError,
  FcmTokenConflictError,
  fcmTokenHash,
  MAX_ACTIVE_FCM_DEVICES_PER_OWNER,
  type FcmDevice,
  type FcmDevicePlatform,
} from './fcm-device.contracts';

type FcmDeviceRow = {
  id: string;
  platform: FcmDevicePlatform;
  created_at: Date;
  last_seen_at: Date;
  revoked_at: Date | null;
};

/**
 * Store surface consumed by the device service and controllers. Ownership is
 * always derived from the caller-side authenticated identity: customer ids
 * use the opaque public form (`CUS-<n>`) and provider ids the provider
 * primary key; neither value is ever taken from a client body.
 */
export interface FcmDeviceStore {
  registerCustomerDevice(input: {
    customerId: string;
    token: string;
    platform: FcmDevicePlatform;
  }): Promise<FcmDevice>;
  registerProviderDevice(input: {
    providerId: string;
    token: string;
    platform: FcmDevicePlatform;
  }): Promise<FcmDevice>;
  revokeCustomerDevice(
    customerId: string,
    deviceId: string,
  ): Promise<FcmDevice | undefined>;
  revokeProviderDevice(
    providerId: string,
    deviceId: string,
  ): Promise<FcmDevice | undefined>;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const UNIQUE_VIOLATION_SQLSTATE = '23505';

@Injectable()
export class FcmDeviceRepository
  implements FcmDeviceStore, OnModuleInit, OnModuleDestroy
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

  /**
   * Test/dev schema bootstrap mirroring migration 0003 (same statements,
   * idempotent). The versioned migration runner remains the canonical
   * production path; this keeps repository/E2E suites on the exact same
   * shape without replaying migration history.
   */
  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    let released = false;
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended(current_schema(), 0))',
      );
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS fcm_devices (
            id UUID PRIMARY KEY,
            customer_id BIGINT REFERENCES customers(id),
            provider_id TEXT REFERENCES providers(id),
            token_secret TEXT NOT NULL,
            token_hash CHAR(64) NOT NULL
              CONSTRAINT fcm_devices_token_hash_check
              CHECK (token_hash ~ '^[0-9a-f]{64}$'),
            platform TEXT NOT NULL
              CONSTRAINT fcm_devices_platform_check
              CHECK (platform IN ('android', 'ios')),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            revoked_at TIMESTAMPTZ,
            CONSTRAINT fcm_devices_single_owner_check
              CHECK ((customer_id IS NULL) <> (provider_id IS NULL))
          )
        `);
        await client.query(
          `CREATE INDEX IF NOT EXISTS fcm_devices_customer_active_idx
           ON fcm_devices (customer_id)
           WHERE revoked_at IS NULL`,
        );
        await client.query(
          `CREATE INDEX IF NOT EXISTS fcm_devices_provider_active_idx
           ON fcm_devices (provider_id)
           WHERE revoked_at IS NULL`,
        );
        await client.query(
          `CREATE UNIQUE INDEX IF NOT EXISTS fcm_devices_active_token_hash_unique
           ON fcm_devices (token_hash)
           WHERE revoked_at IS NULL`,
        );
        await client.query(`
          CREATE TABLE IF NOT EXISTS notification_outbox (
            id BIGSERIAL PRIMARY KEY,
            dedupe_key TEXT NOT NULL UNIQUE,
            recipient_owner_kind TEXT NOT NULL
              CONSTRAINT notification_outbox_recipient_owner_kind_check
              CHECK (recipient_owner_kind IN ('customer', 'provider')),
            recipient_customer_id BIGINT REFERENCES customers(id),
            recipient_provider_id TEXT REFERENCES providers(id),
            notification_type TEXT NOT NULL
              CONSTRAINT notification_outbox_notification_type_check
              CHECK (notification_type IN (
                'request_created',
                'provider_assigned',
                'provider_on_the_way',
                'request_completed',
                'opportunity_invited',
                'quote_approved'
              )),
            service_request_id BIGINT REFERENCES service_requests(id),
            payload JSONB NOT NULL
              CONSTRAINT notification_outbox_payload_check
              CHECK (jsonb_typeof(payload) = 'object'),
            status TEXT NOT NULL DEFAULT 'pending'
              CONSTRAINT notification_outbox_status_check
              CHECK (status IN ('pending', 'sending', 'delivered', 'dead')),
            attempts SMALLINT NOT NULL DEFAULT 0
              CONSTRAINT notification_outbox_attempts_check
              CHECK (attempts >= 0),
            available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            next_attempt_at TIMESTAMPTZ,
            lease_claimed_at TIMESTAMPTZ,
            lease_claimed_by TEXT,
            last_error_kind TEXT
              CONSTRAINT notification_outbox_last_error_kind_check
              CHECK (last_error_kind IN (
                'no_active_device',
                'invalid_token',
                'unregistered_token',
                'network_error',
                'throttled',
                'unknown'
              )),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            delivered_at TIMESTAMPTZ,
            CONSTRAINT notification_outbox_single_recipient_check
              CHECK ((recipient_customer_id IS NULL) <> (recipient_provider_id IS NULL))
          )
        `);
        await client.query(
          `CREATE INDEX IF NOT EXISTS notification_outbox_pending_available_idx
           ON notification_outbox (available_at, id)
           WHERE status = 'pending'`,
        );
        await client.query(
          `CREATE INDEX IF NOT EXISTS notification_outbox_sending_claimed_idx
           ON notification_outbox (lease_claimed_at)
           WHERE status = 'sending'`,
        );
        await client.query('COMMIT');
      } catch (error) {
        released = true;
        await this.rollbackAndRelease(client);
        throw error;
      }
      client.release();
    } catch (error) {
      if (!released) {
        await this.rollbackAndRelease(client);
      }
      throw error;
    }
  }

  private async rollbackAndRelease(client: PoolClient): Promise<void> {
    try {
      await client.query('ROLLBACK');
      client.release();
    } catch (rollbackError) {
      client.release(rollbackError as Error);
    }
  }

  async registerCustomerDevice(input: {
    customerId: string;
    token: string;
    platform: FcmDevicePlatform;
  }): Promise<FcmDevice> {
    return this.registerDevice({
      ownerKind: 'customer',
      ownerKey: `moeen:fcm-device-cap:customer:${this.toCustomerDatabaseId(
        input.customerId,
      )}`,
      token: input.token,
      platform: input.platform,
      ownerPredicate: {
        column: 'customer_id',
        value: this.toCustomerDatabaseId(input.customerId),
      },
      nullOwner: { column: 'provider_id' },
    });
  }

  async registerProviderDevice(input: {
    providerId: string;
    token: string;
    platform: FcmDevicePlatform;
  }): Promise<FcmDevice> {
    return this.registerDevice({
      ownerKind: 'provider',
      ownerKey: `moeen:fcm-device-cap:provider:${input.providerId}`,
      token: input.token,
      platform: input.platform,
      ownerPredicate: { column: 'provider_id', value: input.providerId },
      nullOwner: { column: 'customer_id' },
    });
  }

  /**
   * Transactional register with safe rebinding:
   *   1. same token + same owner      -> idempotent last_seen refresh
   *   2. same token + different owner -> previous active row revoked, new
   *      row created (never two active owners for one token)
   *   3. new token                    -> create (subject to the active cap)
   * The per-owner advisory lock serializes the active-device cap so two
   * concurrent registrations can never exceed it. The active-token partial
   * unique index arbitrates the same-token cross-owner race.
   */
  private async registerDevice(input: {
    ownerKind: 'customer' | 'provider';
    ownerKey: string;
    token: string;
    platform: FcmDevicePlatform;
    ownerPredicate: { column: 'customer_id' | 'provider_id'; value: unknown };
    nullOwner: { column: 'customer_id' | 'provider_id' };
  }): Promise<FcmDevice> {
    const tokenHash = fcmTokenHash(input.token);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [input.ownerKey],
      );
      const existing = await client.query<{
        id: string;
        customer_id: string | null;
        provider_id: string | null;
      }>(
        `SELECT id, customer_id::text, provider_id
           FROM fcm_devices
          WHERE token_hash = $1 AND revoked_at IS NULL
            FOR UPDATE`,
        [tokenHash],
      );
      const activeRow = existing.rows[0];
      if (activeRow) {
        const sameOwner =
          input.ownerKind === 'customer'
            ? activeRow.customer_id === String(input.ownerPredicate.value)
            : activeRow.provider_id === input.ownerPredicate.value;
        if (sameOwner) {
          const refreshed = await client.query<FcmDeviceRow>(
            `UPDATE fcm_devices
                SET last_seen_at = NOW(), platform = $2
              WHERE id = $1
              RETURNING id, platform, created_at, last_seen_at, revoked_at`,
            [activeRow.id, input.platform],
          );
          await client.query('COMMIT');
          client.release();
          return this.toFcmDevice(refreshed.rows[0]);
        }
        // Token moved to a different account: revoke the previous active
        // ownership first. If THIS attempt later fails (e.g. cap), the
        // rollback restores the previous ownership atomically.
        await client.query(
          'UPDATE fcm_devices SET revoked_at = NOW() WHERE id = $1',
          [activeRow.id],
        );
      }
      const activeCount = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM fcm_devices
          WHERE ${input.ownerPredicate.column} = $1 AND revoked_at IS NULL`,
        [input.ownerPredicate.value],
      );
      if (activeCount.rows[0].count >= MAX_ACTIVE_FCM_DEVICES_PER_OWNER) {
        throw new FcmDeviceLimitExceededError();
      }
      const inserted = await client.query<FcmDeviceRow>(
        `INSERT INTO fcm_devices
           (id, ${input.ownerPredicate.column}, ${input.nullOwner.column},
            token_secret, token_hash, platform)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, platform, created_at, last_seen_at, revoked_at`,
        [
          randomUUID(),
          input.ownerPredicate.value,
          null,
          input.token,
          tokenHash,
          input.platform,
        ],
      );
      await client.query('COMMIT');
      client.release();
      return this.toFcmDevice(inserted.rows[0]);
    } catch (error) {
      await this.rollbackAndRelease(client);
      if (
        this.isUniqueViolation(error) &&
        this.mentionsActiveTokenIndex(error)
      ) {
        throw new FcmTokenConflictError();
      }
      throw error;
    }
  }

  async revokeCustomerDevice(
    customerId: string,
    deviceId: string,
  ): Promise<FcmDevice | undefined> {
    return this.revokeDevice(
      { column: 'customer_id', value: this.toCustomerDatabaseId(customerId) },
      deviceId,
    );
  }

  async revokeProviderDevice(
    providerId: string,
    deviceId: string,
  ): Promise<FcmDevice | undefined> {
    return this.revokeDevice(
      { column: 'provider_id', value: providerId },
      deviceId,
    );
  }

  /**
   * Owner-scoped revocation: only a device belonging to the authenticated
   * owner can be revoked. Unknown or foreign device ids resolve to
   * `undefined` (the caller maps that to a 404 that leaks nothing).
   * Revoking an already-revoked own device returns its row unchanged.
   */
  private async revokeDevice(
    ownerPredicate: { column: 'customer_id' | 'provider_id'; value: unknown },
    deviceId: string,
  ): Promise<FcmDevice | undefined> {
    if (!UUID_PATTERN.test(deviceId)) return undefined;
    const result = await this.pool.query<FcmDeviceRow>(
      `UPDATE fcm_devices
          SET revoked_at = COALESCE(revoked_at, NOW())
        WHERE id = $1 AND ${ownerPredicate.column} = $2
        RETURNING id, platform, created_at, last_seen_at, revoked_at`,
      [deviceId, ownerPredicate.value],
    );
    return result.rows[0] ? this.toFcmDevice(result.rows[0]) : undefined;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private toFcmDevice(row: FcmDeviceRow): FcmDevice {
    return {
      deviceId: row.id,
      platform: row.platform,
      createdAt: row.created_at.toISOString(),
      lastSeenAt: row.last_seen_at.toISOString(),
      active: row.revoked_at === null,
    };
  }

  private toCustomerDatabaseId(customerId: string): number {
    const match = /^CUS-(\d+)$/.exec(customerId);
    if (!match) throw new Error('Invalid customer id');
    return Number(match[1]) - 1000;
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === UNIQUE_VIOLATION_SQLSTATE
    );
  }

  private mentionsActiveTokenIndex(error: unknown): boolean {
    const message =
      typeof error === 'object' && error !== null
        ? (error as { message?: unknown }).message
        : undefined;
    return (
      typeof message === 'string' &&
      message.includes('fcm_devices_active_token_hash_unique')
    );
  }
}

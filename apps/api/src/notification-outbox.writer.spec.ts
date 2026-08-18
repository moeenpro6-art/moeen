import 'dotenv/config';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { resolveDatabaseConnectionString } from './database.config';
import type { FcmConfig } from './fcm.config';
import { FcmDeviceRepository } from './fcm-device.repository';
import {
  FCM_DISPATCH_WAKE_EVENT,
  NotificationOutboxWriter,
} from './notification-outbox.writer';
import { ServiceRequestRepository } from './service-request.repository';

const ENABLED_CONFIG: FcmConfig = {
  enabled: true,
  environment: 'test',
  projectId: 'test-project',
  clientEmail: 'test@example.test',
  privateKey: 'test-only-never-used-by-writer',
};

function requestDatabaseId(requestId: string): number {
  return Number(requestId.replace('MOE-', '')) - 1000;
}

function customerDatabaseId(customerId: string): number {
  return Number(customerId.replace('CUS-', '')) - 1000;
}

describe('NotificationOutboxWriter', () => {
  const repository = new ServiceRequestRepository();
  const deviceRepository = new FcmDeviceRepository();
  const pool = new Pool({
    connectionString: resolveDatabaseConnectionString(),
  });
  const wake = new EventEmitter();
  const writer = new NotificationOutboxWriter(ENABLED_CONFIG, wake);

  beforeAll(async () => {
    await repository.initialize();
    await deviceRepository.initialize();
  });

  afterAll(async () => {
    await Promise.all([
      repository.close(),
      deviceRepository.close(),
      pool.end(),
    ]);
  });

  async function fixture(): Promise<{
    client: PoolClient;
    requestId: number;
    customerId: number;
  }> {
    const customer = await repository.upsertCustomer(
      `+966${randomUUID().replaceAll('-', '').slice(0, 9)}`,
    );
    const request = await repository.create(
      {
        serviceId: 'ac-cleaning',
        address: 'حي اختبار خاص لا يدخل الإشعار',
        details: 'تفاصيل سرية لا تدخل الإشعار',
        timing: 'as-soon-as-possible',
      },
      customer.id,
    );
    return {
      client: await pool.connect(),
      requestId: requestDatabaseId(request.id),
      customerId: customerDatabaseId(customer.id),
    };
  }

  it('is a complete no-op while the feature is disabled', async () => {
    const disabled = new NotificationOutboxWriter();
    const query = jest.fn();
    await disabled.writeOnClient({ query } as unknown as PoolClient, {
      notificationType: 'request_created',
      serviceRequestDatabaseId: 1,
      recipient: { ownerKind: 'customer', customerDatabaseId: 1 },
      dedupeKey: 'disabled-must-not-write',
      requestPublicId: 'MOE-1001',
    });
    expect(query).not.toHaveBeenCalled();
    expect(disabled.enabled).toBe(false);
  });

  it('deterministically skips a notification whose recipient genuinely does not exist', async () => {
    // HIGH #2: a legacy service-request row with nullable ownership has no
    // notify-able recipient. The writer must issue ZERO queries (no
    // fabricated-owner INSERT, no FK failure) so the caller's domain
    // mutation can commit normally. The skip must never reach the client.
    const query = jest.fn();
    await writer.writeOnClient({ query } as unknown as PoolClient, {
      notificationType: 'request_cancelled',
      serviceRequestDatabaseId: 41,
      // recipient intentionally omitted: verified nullable legacy owner.
      dedupeKey: 'legacy-null-owner-must-skip',
      requestPublicId: 'MOE-1041',
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('never redirects a missing-recipient notification to another account', async () => {
    // HIGH #2 test 4: even when OTHER customers exist in the system, a
    // missing recipient must produce no row addressed to anyone -- no
    // fallback owner, no nearest-id guess.
    const query = jest.fn();
    const spec = {
      notificationType: 'request_cancelled' as const,
      serviceRequestDatabaseId: 41,
      // recipient omitted
      dedupeKey: 'legacy-null-owner-no-redirect',
      requestPublicId: 'MOE-1041',
    };
    await writer.writeOnClient({ query } as unknown as PoolClient, spec);
    expect(query).not.toHaveBeenCalled();
  });

  it('inserts the outbox row inside the caller transaction with safe content', async () => {
    const fixtureValue = await fixture();
    const key = `writer-safe-${randomUUID()}`;
    const { client } = fixtureValue;
    try {
      await client.query('BEGIN');
      await writer.writeOnClient(client, {
        notificationType: 'quote_received',
        serviceRequestDatabaseId: fixtureValue.requestId,
        recipient: {
          ownerKind: 'customer',
          customerDatabaseId: fixtureValue.customerId,
        },
        dedupeKey: key,
        requestPublicId: `MOE-${1000 + fixtureValue.requestId}`,
      });
      const inside = await client.query<{
        payload: Record<string, unknown>;
        notification_type: string;
        recipient_owner_kind: string;
        recipient_customer_id: string;
        recipient_provider_id: string | null;
      }>(
        `SELECT payload, notification_type, recipient_owner_kind,
                recipient_customer_id::text, recipient_provider_id
           FROM notification_outbox WHERE dedupe_key = $1`,
        [key],
      );
      expect(inside.rows).toHaveLength(1);
      expect(inside.rows[0]).toMatchObject({
        notification_type: 'quote_received',
        recipient_owner_kind: 'customer',
        recipient_customer_id: String(fixtureValue.customerId),
        recipient_provider_id: null,
      });
      expect(Object.keys(inside.rows[0].payload).sort()).toEqual([
        'eventId',
        'navigate',
        'requestId',
        'type',
        'v',
      ]);
      const serialized = JSON.stringify(inside.rows[0].payload);
      expect(serialized).not.toContain('حي اختبار');
      expect(serialized).not.toContain('تفاصيل سرية');
      expect(serialized).not.toContain('+966');
      expect(serialized).not.toContain('customerId');
      expect(serialized).not.toContain('providerId');
      expect(serialized).not.toContain('fcm');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const durable = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM notification_outbox WHERE dedupe_key = $1',
      [key],
    );
    expect(durable.rows[0].count).toBe(1);
  });

  it('rolls back the outbox row when the domain transaction rolls back', async () => {
    const fixtureValue = await fixture();
    const key = `writer-rollback-${randomUUID()}`;
    const { client } = fixtureValue;
    try {
      await client.query('BEGIN');
      await writer.writeOnClient(client, {
        notificationType: 'request_cancelled',
        serviceRequestDatabaseId: fixtureValue.requestId,
        recipient: {
          ownerKind: 'customer',
          customerDatabaseId: fixtureValue.customerId,
        },
        dedupeKey: key,
        requestPublicId: `MOE-${1000 + fixtureValue.requestId}`,
      });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    const row = await pool.query(
      'SELECT id FROM notification_outbox WHERE dedupe_key = $1',
      [key],
    );
    expect(row.rows).toHaveLength(0);
  });

  it('deduplicates a repeated semantic event within the transaction', async () => {
    const fixtureValue = await fixture();
    const key = `writer-dedupe-${randomUUID()}`;
    const { client } = fixtureValue;
    try {
      await client.query('BEGIN');
      const spec = {
        notificationType: 'provider_on_the_way' as const,
        serviceRequestDatabaseId: fixtureValue.requestId,
        recipient: {
          ownerKind: 'customer' as const,
          customerDatabaseId: fixtureValue.customerId,
        },
        dedupeKey: key,
        requestPublicId: `MOE-${1000 + fixtureValue.requestId}`,
      };
      await writer.writeOnClient(client, spec);
      await writer.writeOnClient(client, spec);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const rows = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM notification_outbox WHERE dedupe_key = $1',
      [key],
    );
    expect(rows.rows[0].count).toBe(1);
  });

  it('rolls the domain mutation back if a required outbox insert fails', async () => {
    const fixtureValue = await fixture();
    const key = `writer-atomic-failure-${randomUUID()}`;
    const marker = `atomicity-probe-${randomUUID()}`;
    const { client } = fixtureValue;
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO service_request_events (service_request_id, type, status)
         VALUES ($1, 'status_updated', $2)`,
        [fixtureValue.requestId, marker],
      );
      await expect(
        writer.writeOnClient(client, {
          notificationType: 'provider_assigned',
          serviceRequestDatabaseId: fixtureValue.requestId,
          recipient: {
            ownerKind: 'provider',
            providerId: `missing-provider-${randomUUID()}`,
          },
          dedupeKey: key,
          requestPublicId: `MOE-${1000 + fixtureValue.requestId}`,
        }),
      ).rejects.toMatchObject({ code: '23503' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    const state = await pool.query<{
      event_count: number;
      outbox_count: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM service_request_events WHERE status = $1) AS event_count,
         (SELECT count(*)::int FROM notification_outbox WHERE dedupe_key = $2) AS outbox_count`,
      [marker, key],
    );
    expect(state.rows[0]).toEqual({ event_count: 0, outbox_count: 0 });
  });

  it('records C1 best-effort as one bounded send attempt at the ceiling', async () => {
    const fixtureValue = await fixture();
    const key = `writer-best-effort-${randomUUID()}`;
    const { client } = fixtureValue;
    try {
      await client.query('BEGIN');
      await writer.writeOnClient(client, {
        notificationType: 'request_created',
        serviceRequestDatabaseId: fixtureValue.requestId,
        recipient: {
          ownerKind: 'customer',
          customerDatabaseId: fixtureValue.customerId,
        },
        dedupeKey: key,
        requestPublicId: `MOE-${1000 + fixtureValue.requestId}`,
        reliability: 'best-effort',
      });
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const row = await pool.query<{ attempts: number }>(
      'SELECT attempts FROM notification_outbox WHERE dedupe_key = $1',
      [key],
    );
    expect(row.rows[0].attempts).toBe(4);
  });

  it('emits the worker wake only after the caller explicitly signals post-commit', () => {
    const listener = jest.fn();
    wake.once(FCM_DISPATCH_WAKE_EVENT, listener);
    writer.notifyEnqueued();
    expect(listener).toHaveBeenCalledTimes(1);

    const disabledWake = new EventEmitter();
    const disabledListener = jest.fn();
    disabledWake.once(FCM_DISPATCH_WAKE_EVENT, disabledListener);
    new NotificationOutboxWriter(undefined, disabledWake).notifyEnqueued();
    expect(disabledListener).not.toHaveBeenCalled();
  });

  it('never lets a faulty post-commit wake listener fail the domain response', () => {
    const faultyWake = new EventEmitter();
    faultyWake.on(FCM_DISPATCH_WAKE_EVENT, () => {
      throw new Error('faulty listener');
    });
    const safeWriter = new NotificationOutboxWriter(ENABLED_CONFIG, faultyWake);
    expect(() => safeWriter.notifyEnqueued()).not.toThrow();
  });
});

import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { FcmDeviceRepository } from './fcm-device.repository';
import {
  FcmDeviceLimitExceededError,
  fcmTokenHash,
  MAX_ACTIVE_FCM_DEVICES_PER_OWNER,
  type FcmDevice,
} from './fcm-device.contracts';
import { ServiceRequestRepository } from './service-request.repository';

const CHECK_VIOLATION_SQLSTATE = '23514';
const UNIQUE_VIOLATION_SQLSTATE = '23505';

function uniqueToken(label: string): string {
  return `fcm-token-${label}-${randomUUID()}`;
}

function toCustomerDatabaseId(customerId: string): number {
  return Number(customerId.replace('CUS-', '')) - 1000;
}

async function expectSqlStateError(
  operation: Promise<unknown>,
  state: string,
): Promise<void> {
  const error = await operation.catch((caught: unknown) => caught);
  expect(
    typeof error === 'object' && error !== null
      ? (error as { code?: unknown }).code
      : undefined,
  ).toBe(state);
}

describe('FcmDeviceRepository', () => {
  const deviceRepository = new FcmDeviceRepository();
  const serviceRequestRepository = new ServiceRequestRepository();
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

  async function upsertCustomer(): Promise<string> {
    const customer = await serviceRequestRepository.upsertCustomer(
      `+966${randomUUID().replaceAll('-', '').slice(0, 9)}`,
    );
    return customer.id;
  }

  async function createProvider(): Promise<string> {
    const provider = await serviceRequestRepository.createPilotProvider({
      name: `مقدم أجهزة ${randomUUID().slice(0, 8)}`,
      specialties: ['ac-cleaning'],
      serviceZone: 'بريدة',
    });
    return provider.id;
  }

  beforeAll(async () => {
    await serviceRequestRepository.initialize();
    await deviceRepository.initialize();
  });

  afterAll(async () => {
    await Promise.all([
      deviceRepository.close(),
      serviceRequestRepository.close(),
      pool.end(),
    ]);
  });

  it('registers a customer device with a safe projection', async () => {
    const customerId = await upsertCustomer();
    const token = uniqueToken('customer');

    const device = await deviceRepository.registerCustomerDevice({
      customerId,
      token,
      platform: 'android',
    });

    expect(device.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(device.platform).toBe('android');
    expect(typeof device.createdAt).toBe('string');
    expect(typeof device.lastSeenAt).toBe('string');
    expect(device.active).toBe(true);
    expect(Object.keys(device).sort()).toEqual([
      'active',
      'createdAt',
      'deviceId',
      'lastSeenAt',
      'platform',
    ]);
    const rows = await pool.query<{
      token_secret: string;
      token_hash: string;
      customer_id: string;
      provider_id: string | null;
    }>(
      'SELECT token_secret, token_hash, customer_id::text, provider_id FROM fcm_devices WHERE id = $1',
      [device.deviceId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].token_secret).toBe(token);
    expect(rows.rows[0].token_hash).toBe(fcmTokenHash(token));
    expect(rows.rows[0].customer_id).not.toBeNull();
    expect(rows.rows[0].provider_id).toBeNull();
  });

  it('registers a provider device', async () => {
    const providerId = await createProvider();
    const token = uniqueToken('provider');

    const device = await deviceRepository.registerProviderDevice({
      providerId,
      token,
      platform: 'ios',
    });

    expect(device.active).toBe(true);
    expect(device.platform).toBe('ios');
    const rows = await pool.query<{ provider_id: string | null }>(
      'SELECT provider_id FROM fcm_devices WHERE id = $1',
      [device.deviceId],
    );
    expect(rows.rows[0].provider_id).toBe(providerId);
  });

  it('rejects rows with both or neither owner at the database level', async () => {
    const customerId = await upsertCustomer();
    const token = uniqueToken('both');
    await expectSqlStateError(
      pool.query(
        `INSERT INTO fcm_devices
           (id, customer_id, provider_id, token_secret, token_hash, platform)
         VALUES ($1, $2, 'provider-1', $3, $4, 'android')`,
        [
          randomUUID(),
          toCustomerDatabaseId(customerId),
          token,
          fcmTokenHash(token),
        ],
      ),
      CHECK_VIOLATION_SQLSTATE,
    );
    await expectSqlStateError(
      pool.query(
        `INSERT INTO fcm_devices
           (id, token_secret, token_hash, platform)
         VALUES ($1, $2, $3, 'android')`,
        [randomUUID(), token, fcmTokenHash(token)],
      ),
      CHECK_VIOLATION_SQLSTATE,
    );
  });

  it('rejects an unsupported platform at the database level', async () => {
    const token = uniqueToken('platform');
    await expectSqlStateError(
      pool.query(
        `INSERT INTO fcm_devices
           (id, customer_id, token_secret, token_hash, platform)
         VALUES ($1, 1, $2, $3, 'windows')`,
        [randomUUID(), token, fcmTokenHash(token)],
      ),
      CHECK_VIOLATION_SQLSTATE,
    );
  });

  it('rejects a malformed token hash at the database level', async () => {
    await expectSqlStateError(
      pool.query(
        `INSERT INTO fcm_devices
           (id, customer_id, token_secret, token_hash, platform)
         VALUES ($1, 1, $2, 'not-a-sha256', 'android')`,
        [randomUUID(), uniqueToken('hash')],
      ),
      CHECK_VIOLATION_SQLSTATE,
    );
  });

  it('is idempotent for the same token registered by the same owner', async () => {
    const customerId = await upsertCustomer();
    const token = uniqueToken('idempotent');

    const first = await deviceRepository.registerCustomerDevice({
      customerId,
      token,
      platform: 'android',
    });
    const second = await deviceRepository.registerCustomerDevice({
      customerId,
      token,
      platform: 'android',
    });

    expect(second.deviceId).toBe(first.deviceId);
    const count = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM fcm_devices WHERE token_hash = $1',
      [fcmTokenHash(token)],
    );
    expect(count.rows[0].count).toBe(1);
  });

  it('rebinds a token that moves to a different account', async () => {
    const customerId = await upsertCustomer();
    const providerId = await createProvider();
    const token = uniqueToken('rebind');

    const original = await deviceRepository.registerCustomerDevice({
      customerId,
      token,
      platform: 'android',
    });
    const rebound = await deviceRepository.registerProviderDevice({
      providerId,
      token,
      platform: 'android',
    });

    expect(rebound.deviceId).not.toBe(original.deviceId);
    expect(rebound.active).toBe(true);
    const originalRow = await pool.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM fcm_devices WHERE id = $1',
      [original.deviceId],
    );
    expect(originalRow.rows[0].revoked_at).not.toBeNull();
    const activeRows = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM fcm_devices WHERE token_hash = $1 AND revoked_at IS NULL',
      [fcmTokenHash(token)],
    );
    expect(activeRows.rows[0].count).toBe(1);
  });

  it('supports multiple devices per owner up to the approved cap', async () => {
    const customerId = await upsertCustomer();
    const devices: FcmDevice[] = [];
    for (let index = 0; index < MAX_ACTIVE_FCM_DEVICES_PER_OWNER; index++) {
      devices.push(
        await deviceRepository.registerCustomerDevice({
          customerId,
          token: uniqueToken(`cap-${index}`),
          platform: 'android',
        }),
      );
    }
    expect(new Set(devices.map((device) => device.deviceId)).size).toBe(
      MAX_ACTIVE_FCM_DEVICES_PER_OWNER,
    );

    await expect(
      deviceRepository.registerCustomerDevice({
        customerId,
        token: uniqueToken('cap-overflow'),
        platform: 'android',
      }),
    ).rejects.toBeInstanceOf(FcmDeviceLimitExceededError);
  });

  it('does not count revoked devices toward the cap', async () => {
    const customerId = await upsertCustomer();
    const devices: FcmDevice[] = [];
    for (let index = 0; index < MAX_ACTIVE_FCM_DEVICES_PER_OWNER; index++) {
      devices.push(
        await deviceRepository.registerCustomerDevice({
          customerId,
          token: uniqueToken(`cap-revoke-${index}`),
          platform: 'android',
        }),
      );
    }
    await expect(
      deviceRepository.registerCustomerDevice({
        customerId,
        token: uniqueToken('cap-revoke-overflow'),
        platform: 'android',
      }),
    ).rejects.toBeInstanceOf(FcmDeviceLimitExceededError);

    const revoked = await deviceRepository.revokeCustomerDevice(
      customerId,
      devices[0].deviceId,
    );
    expect(revoked?.active).toBe(false);

    const replacement = await deviceRepository.registerCustomerDevice({
      customerId,
      token: uniqueToken('cap-revoke-replacement'),
      platform: 'android',
    });
    expect(replacement.active).toBe(true);
  });

  it('revokes only the authenticated owner’s own device', async () => {
    const firstCustomerId = await upsertCustomer();
    const secondCustomerId = await upsertCustomer();
    const firstProviderId = await createProvider();
    const secondProviderId = await createProvider();

    const customerDevice = await deviceRepository.registerCustomerDevice({
      customerId: firstCustomerId,
      token: uniqueToken('revoke-customer'),
      platform: 'android',
    });
    const providerDevice = await deviceRepository.registerProviderDevice({
      providerId: firstProviderId,
      token: uniqueToken('revoke-provider'),
      platform: 'android',
    });

    expect(
      await deviceRepository.revokeCustomerDevice(
        secondCustomerId,
        customerDevice.deviceId,
      ),
    ).toBeUndefined();
    expect(
      await deviceRepository.revokeProviderDevice(
        secondProviderId,
        customerDevice.deviceId,
      ),
    ).toBeUndefined();
    expect(
      await deviceRepository.revokeProviderDevice(
        secondProviderId,
        providerDevice.deviceId,
      ),
    ).toBeUndefined();
    expect(
      await deviceRepository.revokeCustomerDevice(
        secondCustomerId,
        providerDevice.deviceId,
      ),
    ).toBeUndefined();

    const ownCustomerRevoke = await deviceRepository.revokeCustomerDevice(
      firstCustomerId,
      customerDevice.deviceId,
    );
    expect(ownCustomerRevoke?.deviceId).toBe(customerDevice.deviceId);
    expect(ownCustomerRevoke?.active).toBe(false);
    const ownProviderRevoke = await deviceRepository.revokeProviderDevice(
      firstProviderId,
      providerDevice.deviceId,
    );
    expect(ownProviderRevoke?.active).toBe(false);

    // A second revoke of an already-revoked own device stays a safe no-op.
    expect(
      (
        await deviceRepository.revokeCustomerDevice(
          firstCustomerId,
          customerDevice.deviceId,
        )
      )?.active,
    ).toBe(false);
  });

  it('returns undefined for malformed device ids', async () => {
    const customerId = await upsertCustomer();
    await expect(
      deviceRepository.revokeCustomerDevice(customerId, 'not-a-uuid'),
    ).resolves.toBeUndefined();
  });

  it('enforces at most one active device per token hash', async () => {
    const customerId = await upsertCustomer();
    const token = uniqueToken('active-unique');
    const deviceId = randomUUID();
    await pool.query(
      `INSERT INTO fcm_devices
         (id, customer_id, token_secret, token_hash, platform)
       VALUES ($1, $2, $3, $4, 'android')`,
      [deviceId, toCustomerDatabaseId(customerId), token, fcmTokenHash(token)],
    );
    await expectSqlStateError(
      pool.query(
        `INSERT INTO fcm_devices
           (id, customer_id, token_secret, token_hash, platform)
         VALUES ($1, $2, $3, $4, 'android')`,
        [
          randomUUID(),
          toCustomerDatabaseId(customerId),
          token,
          fcmTokenHash(token),
        ],
      ),
      UNIQUE_VIOLATION_SQLSTATE,
    );
    // A revoked row may keep the hash (rebinding relies on this).
    await pool.query(
      'UPDATE fcm_devices SET revoked_at = NOW() WHERE id = $1',
      [deviceId],
    );
    await pool.query(
      `INSERT INTO fcm_devices
         (id, customer_id, token_secret, token_hash, platform)
       VALUES ($1, $2, $3, $4, 'android')`,
      [
        randomUUID(),
        toCustomerDatabaseId(customerId),
        token,
        fcmTokenHash(token),
      ],
    );
  });

  describe('notification_outbox schema foundation', () => {
    const outboxDedupeKey = (): string => `fcm1-dedupe-${randomUUID()}`;

    it('accepts a valid pending row for a customer recipient', async () => {
      const customerId = await upsertCustomer();
      const key = outboxDedupeKey();
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO notification_outbox
           (dedupe_key, recipient_owner_kind, recipient_customer_id,
            notification_type, payload)
         VALUES ($1, 'customer', $2, 'request_created', $3)
         RETURNING id::text`,
        [
          key,
          toCustomerDatabaseId(customerId),
          JSON.stringify({ requestId: 'MOE-2001' }),
        ],
      );
      expect(inserted.rows).toHaveLength(1);
      const row = await pool.query<{ status: string; attempts: number }>(
        'SELECT status, attempts FROM notification_outbox WHERE id = $1',
        [inserted.rows[0].id],
      );
      expect(row.rows[0]).toEqual({ status: 'pending', attempts: 0 });
    });

    it('enforces the unique dedupe key', async () => {
      const key = outboxDedupeKey();
      await pool.query(
        `INSERT INTO notification_outbox
           (dedupe_key, recipient_owner_kind, recipient_provider_id,
            notification_type, payload)
         VALUES ($1, 'provider', 'provider-1', 'opportunity_invited', $2)`,
        [key, JSON.stringify({ requestId: 'MOE-2001' })],
      );
      await expectSqlStateError(
        pool.query(
          `INSERT INTO notification_outbox
             (dedupe_key, recipient_owner_kind, recipient_provider_id,
              notification_type, payload)
           VALUES ($1, 'provider', 'provider-2', 'opportunity_invited', $2)`,
          [key, JSON.stringify({ requestId: 'MOE-2001' })],
        ),
        UNIQUE_VIOLATION_SQLSTATE,
      );
    });

    it('rejects an unknown lifecycle status', async () => {
      await expectSqlStateError(
        pool.query(
          `INSERT INTO notification_outbox
             (dedupe_key, recipient_owner_kind, recipient_provider_id,
              notification_type, payload, status)
           VALUES ($1, 'provider', 'provider-1', 'opportunity_invited', $2, 'flying')`,
          [outboxDedupeKey(), JSON.stringify({})],
        ),
        CHECK_VIOLATION_SQLSTATE,
      );
    });

    it('rejects a recipient that is neither or both owner kinds', async () => {
      await expectSqlStateError(
        pool.query(
          `INSERT INTO notification_outbox
             (dedupe_key, recipient_owner_kind, notification_type, payload)
           VALUES ($1, 'customer', 'request_created', $2)`,
          [outboxDedupeKey(), JSON.stringify({})],
        ),
        CHECK_VIOLATION_SQLSTATE,
      );
      const customerId = await upsertCustomer();
      await expectSqlStateError(
        pool.query(
          `INSERT INTO notification_outbox
             (dedupe_key, recipient_owner_kind, recipient_customer_id,
              recipient_provider_id, notification_type, payload)
           VALUES ($1, 'customer', $2, 'provider-1', 'request_created', $3)`,
          [
            outboxDedupeKey(),
            toCustomerDatabaseId(customerId),
            JSON.stringify({}),
          ],
        ),
        CHECK_VIOLATION_SQLSTATE,
      );
    });

    it('rejects a non-object payload', async () => {
      await expectSqlStateError(
        pool.query(
          `INSERT INTO notification_outbox
             (dedupe_key, recipient_owner_kind, recipient_provider_id,
              notification_type, payload)
           VALUES ($1, 'provider', 'provider-1', 'opportunity_invited', '"text"')`,
          [outboxDedupeKey()],
        ),
        CHECK_VIOLATION_SQLSTATE,
      );
    });

    it('exposes the pending-queue and sending-reclaim indexes', async () => {
      const indexes = await pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname IN (
              'notification_outbox_pending_available_idx',
              'notification_outbox_sending_claimed_idx'
            )
          ORDER BY indexname`,
      );
      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        'notification_outbox_pending_available_idx',
        'notification_outbox_sending_claimed_idx',
      ]);
    });
  });

  it('stores token hashes as lowercase sha256 hex', async () => {
    const customerId = await upsertCustomer();
    const token = uniqueToken('hash-shape');
    const device = await deviceRepository.registerCustomerDevice({
      customerId,
      token,
      platform: 'android',
    });
    const rows = await pool.query<{ token_hash: string }>(
      'SELECT token_hash FROM fcm_devices WHERE id = $1',
      [device.deviceId],
    );
    expect(rows.rows[0].token_hash).toBe(
      createHash('sha256').update(token).digest('hex'),
    );
  });
});

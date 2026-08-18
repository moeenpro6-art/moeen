import 'dotenv/config';
/* eslint-disable @typescript-eslint/unbound-method,
                  @typescript-eslint/no-unsafe-member-access,
                  @typescript-eslint/require-await */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { resolveDatabaseConnectionString } from './database.config';
import type { FcmConfig } from './fcm.config';
import { FcmDeviceRepository } from './fcm-device.repository';
import {
  FcmDispatchWorker,
  type ClaimedFcmOutboxRow,
} from './fcm-dispatch.worker';
import {
  FcmBatchSendError,
  type FcmDeviceSendResult,
  type FcmSender,
} from './fcm.sender';
import { NotificationOutboxWriter } from './notification-outbox.writer';
import { ServiceRequestRepository } from './service-request.repository';

const ENABLED_CONFIG: FcmConfig = {
  enabled: true,
  environment: 'test',
  projectId: 'test-project',
  clientEmail: 'test@example.test',
  privateKey: 'test-only-never-used-by-mock-sender',
};

function requestDatabaseId(requestId: string): number {
  return Number(requestId.replace('MOE-', '')) - 1000;
}

function customerDatabaseId(customerId: string): number {
  return Number(customerId.replace('CUS-', '')) - 1000;
}

describe('FcmDispatchWorker', () => {
  const repository = new ServiceRequestRepository();
  const deviceRepository = new FcmDeviceRepository();
  const pool = new Pool({
    connectionString: resolveDatabaseConnectionString(),
  });
  const writer = new NotificationOutboxWriter(
    ENABLED_CONFIG,
    new EventEmitter(),
  );
  const workers: FcmDispatchWorker[] = [];

  beforeAll(async () => {
    await repository.initialize();
    await deviceRepository.initialize();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM notification_outbox');
    await pool.query('DELETE FROM fcm_devices');
  });

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  });

  afterAll(async () => {
    await Promise.all([
      repository.close(),
      deviceRepository.close(),
      pool.end(),
    ]);
  });

  function worker(sender: FcmSender): FcmDispatchWorker {
    const value = new FcmDispatchWorker(
      ENABLED_CONFIG,
      sender,
      new EventEmitter(),
    );
    workers.push(value);
    return value;
  }

  function senderMock(
    implementation: (tokens: string[]) => Promise<FcmDeviceSendResult[]>,
  ): FcmSender & { sendToDevices: jest.Mock } {
    return { sendToDevices: jest.fn(implementation) };
  }

  async function customerFixture(): Promise<{
    customerId: string;
    customerDbId: number;
    requestId: string;
    requestDbId: number;
  }> {
    const customer = await repository.upsertCustomer(
      `+966${randomUUID().replaceAll('-', '').slice(0, 9)}`,
    );
    const request = await repository.create(
      {
        serviceId: 'ac-cleaning',
        address: 'عنوان خاص لا يدخل الدفع',
        details: 'تفاصيل خاصة لا تدخل الدفع',
        timing: 'as-soon-as-possible',
      },
      customer.id,
    );
    return {
      customerId: customer.id,
      customerDbId: customerDatabaseId(customer.id),
      requestId: request.id,
      requestDbId: requestDatabaseId(request.id),
    };
  }

  async function enqueue(
    fixture: Awaited<ReturnType<typeof customerFixture>>,
    options?: { attempts?: number; dedupeKey?: string },
  ): Promise<number> {
    const key = options?.dedupeKey ?? `dispatch-${randomUUID()}`;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await writer.writeOnClient(client, {
        notificationType: 'quote_received',
        serviceRequestDatabaseId: fixture.requestDbId,
        recipient: {
          ownerKind: 'customer',
          customerDatabaseId: fixture.customerDbId,
        },
        dedupeKey: key,
        requestPublicId: fixture.requestId,
      });
      if (options?.attempts !== undefined) {
        await client.query(
          'UPDATE notification_outbox SET attempts = $2 WHERE dedupe_key = $1',
          [key, options.attempts],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const row = await pool.query<{ id: string }>(
      'SELECT id::text FROM notification_outbox WHERE dedupe_key = $1',
      [key],
    );
    return Number(row.rows[0].id);
  }

  async function claimOnly(
    dispatchWorker: FcmDispatchWorker,
  ): Promise<ClaimedFcmOutboxRow> {
    const rows = await dispatchWorker.claimBatch();
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  async function outboxState(id: number): Promise<{
    status: string;
    attempts: number;
    last_error_kind: string | null;
    future: boolean;
  }> {
    const result = await pool.query<{
      status: string;
      attempts: number;
      last_error_kind: string | null;
      future: boolean;
    }>(
      `SELECT status, attempts, last_error_kind,
              available_at > NOW() AS future
         FROM notification_outbox WHERE id = $1`,
      [id],
    );
    return result.rows[0];
  }

  it('claims rows with a lease and SKIP LOCKED prevents a concurrent double claim', async () => {
    const fixture = await customerFixture();
    const id = await enqueue(fixture);
    const first = worker(senderMock(async () => []));
    const second = worker(senderMock(async () => []));
    const firstClient = await pool.connect();
    const secondClient = await pool.connect();
    try {
      await firstClient.query('BEGIN');
      await secondClient.query('BEGIN');
      const firstClaim = await first.claimBatch(firstClient);
      const secondClaim = await second.claimBatch(secondClient);
      expect(firstClaim.map((row) => row.id)).toEqual([id]);
      expect(secondClaim).toEqual([]);
      const leased = await firstClient.query<{
        status: string;
        lease_claimed_at: Date | null;
        lease_claimed_by: string | null;
      }>(
        `SELECT status, lease_claimed_at, lease_claimed_by
           FROM notification_outbox WHERE id = $1`,
        [id],
      );
      expect(leased.rows[0].status).toBe('sending');
      expect(leased.rows[0].lease_claimed_at).not.toBeNull();
      expect(leased.rows[0].lease_claimed_by).toMatch(/^fcm-worker-/);
      await secondClient.query('ROLLBACK');
      await firstClient.query('ROLLBACK');
    } finally {
      secondClient.release();
      firstClient.release();
    }
  });

  it('reclaims only stale sending leases', async () => {
    const fixture = await customerFixture();
    const staleId = await enqueue(fixture, {
      dedupeKey: `stale-${randomUUID()}`,
    });
    const freshId = await enqueue(fixture, {
      dedupeKey: `fresh-${randomUUID()}`,
    });
    await pool.query(
      `UPDATE notification_outbox
          SET status = 'sending', lease_claimed_by = 'dead-worker',
              lease_claimed_at = CASE WHEN id = $1 THEN NOW() - INTERVAL '6 minutes' ELSE NOW() END
        WHERE id IN ($1, $2)`,
      [staleId, freshId],
    );
    const dispatchWorker = worker(senderMock(async () => []));
    await dispatchWorker.reclaimStale();
    const states = await pool.query<{ id: string; status: string }>(
      'SELECT id::text, status FROM notification_outbox ORDER BY id',
    );
    expect(states.rows).toEqual([
      { id: String(staleId), status: 'pending' },
      { id: String(freshId), status: 'sending' },
    ]);
  });

  it('renews a still-owned lease so a healthy worker is never prematurely reclaimed', async () => {
    // HIGH #1 regression: under the previous timing model a worker processing
    // beyond the original lease window had its still-'sending' rows reclaimed
    // by a second instance, causing duplicate sends. Now the worker heartbeat-
    // renews its own rows, so worker B must NOT reclaim them even after the
    // original lease would have expired.
    const fixture = await customerFixture();
    const id = await enqueue(fixture);
    const workerA = worker(senderMock(async () => []));
    // Worker A claims the row, simulating the start of a long batch.
    await claimOnly(workerA);
    // Fast-forward worker A's row beyond the original lease window, then
    // worker A renews its own lease exactly as it does mid-batch.
    await pool.query(
      `UPDATE notification_outbox
          SET lease_claimed_at = NOW() - INTERVAL '6 minutes'
        WHERE id = $1`,
      [id],
    );
    await workerA.renewOwnedLeases([id]);
    // Worker B runs the stale reclaim: the renewed row must remain 'sending'
    // (still actively owned by the healthy worker A).
    const workerB = worker(senderMock(async () => []));
    await workerB.reclaimStale();
    const state = await pool.query<{
      status: string;
      lease_claimed_by: string | null;
    }>(
      `SELECT status, lease_claimed_by FROM notification_outbox WHERE id = $1`,
      [id],
    );
    expect(state.rows[0].status).toBe('sending');
    expect(state.rows[0].lease_claimed_by).not.toBeNull();
  });

  it('still reclaims truly abandoned rows from a crashed worker', async () => {
    // HIGH #1 counter-part: an orphaned row whose worker has crashed (and
    // therefore never renews) ages out and is reclaimed exactly as before.
    const fixture = await customerFixture();
    const id = await enqueue(fixture);
    await pool.query(
      `UPDATE notification_outbox
          SET status = 'sending', lease_claimed_by = 'crashed-worker',
              lease_claimed_at = NOW() - INTERVAL '6 minutes'
        WHERE id = $1`,
      [id],
    );
    const workerB = worker(senderMock(async () => []));
    await workerB.reclaimStale();
    const state = await pool.query<{ status: string }>(
      'SELECT status FROM notification_outbox WHERE id = $1',
      [id],
    );
    expect(state.rows[0].status).toBe('pending');
  });

  it('treats no active devices as a safe terminal outcome without calling FCM', async () => {
    const fixture = await customerFixture();
    const id = await enqueue(fixture);
    const sender = senderMock(async () => []);
    const dispatchWorker = worker(sender);
    const row = await claimOnly(dispatchWorker);
    await expect(dispatchWorker.processClaimedRow(row)).resolves.toBe(
      'delivered',
    );
    expect(sender.sendToDevices).not.toHaveBeenCalled();
    expect(await outboxState(id)).toMatchObject({
      status: 'delivered',
      attempts: 0,
      last_error_kind: 'no_active_device',
    });
  });

  it('resolves all active account devices while excluding revoked devices', async () => {
    const fixture = await customerFixture();
    const activeOne = `active-one-${randomUUID()}`;
    const activeTwo = `active-two-${randomUUID()}`;
    const revokedToken = `revoked-${randomUUID()}`;
    await deviceRepository.registerCustomerDevice({
      customerId: fixture.customerId,
      token: activeOne,
      platform: 'android',
    });
    await deviceRepository.registerCustomerDevice({
      customerId: fixture.customerId,
      token: activeTwo,
      platform: 'ios',
    });
    const revoked = await deviceRepository.registerCustomerDevice({
      customerId: fixture.customerId,
      token: revokedToken,
      platform: 'android',
    });
    await deviceRepository.revokeCustomerDevice(
      fixture.customerId,
      revoked.deviceId,
    );
    const id = await enqueue(fixture);
    const sender = senderMock(async (tokens) =>
      tokens.map((token) => ({
        tokenShortRef: token.slice(0, 12),
        outcome: 'delivered' as const,
      })),
    );
    const dispatchWorker = worker(sender);
    const row = await claimOnly(dispatchWorker);
    await expect(dispatchWorker.processClaimedRow(row)).resolves.toBe(
      'delivered',
    );
    expect(sender.sendToDevices).toHaveBeenCalledTimes(1);
    expect(sender.sendToDevices.mock.calls[0][0]).toEqual([
      activeOne,
      activeTwo,
    ]);
    expect(sender.sendToDevices.mock.calls[0][0]).not.toContain(revokedToken);
    expect(await outboxState(id)).toMatchObject({ status: 'delivered' });
  });

  it('revokes only the exact permanently invalid device', async () => {
    const fixture = await customerFixture();
    const invalidToken = `invalid-${randomUUID()}`;
    const validToken = `valid-${randomUUID()}`;
    const invalidDevice = await deviceRepository.registerCustomerDevice({
      customerId: fixture.customerId,
      token: invalidToken,
      platform: 'android',
    });
    const validDevice = await deviceRepository.registerCustomerDevice({
      customerId: fixture.customerId,
      token: validToken,
      platform: 'android',
    });
    const id = await enqueue(fixture);
    const sender = senderMock(async () => [
      { tokenShortRef: 'invalid-ref', outcome: 'unregistered_token' },
      { tokenShortRef: 'valid-ref', outcome: 'delivered' },
    ]);
    const dispatchWorker = worker(sender);
    await dispatchWorker.processClaimedRow(await claimOnly(dispatchWorker));
    const devices = await pool.query<{ id: string; revoked: boolean }>(
      `SELECT id, revoked_at IS NOT NULL AS revoked
         FROM fcm_devices WHERE id IN ($1, $2) ORDER BY id`,
      [invalidDevice.deviceId, validDevice.deviceId],
    );
    const byId = new Map(
      devices.rows.map((device) => [device.id, device.revoked]),
    );
    expect(byId.get(invalidDevice.deviceId)).toBe(true);
    expect(byId.get(validDevice.deviceId)).toBe(false);
    expect(await outboxState(id)).toMatchObject({ status: 'delivered' });
  });

  it('keeps devices active and retries transient failures with persisted backoff', async () => {
    const fixture = await customerFixture();
    const token = `transient-${randomUUID()}`;
    const device = await deviceRepository.registerCustomerDevice({
      customerId: fixture.customerId,
      token,
      platform: 'android',
    });
    const id = await enqueue(fixture);
    const sender = senderMock(async () => [
      {
        tokenShortRef: 'transient-ref',
        outcome: 'transient_error',
        errorCode: 'messaging/server-unavailable',
      },
    ]);
    const dispatchWorker = worker(sender);
    await expect(
      dispatchWorker.processClaimedRow(await claimOnly(dispatchWorker)),
    ).resolves.toBe('retry');
    expect(await outboxState(id)).toMatchObject({
      status: 'pending',
      attempts: 1,
      last_error_kind: 'network_error',
      future: true,
    });
    const deviceState = await pool.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM fcm_devices WHERE id = $1',
      [device.deviceId],
    );
    expect(deviceState.rows[0].revoked_at).toBeNull();
  });

  it('uses deterministic partial success: delivered wins over a transient sibling', async () => {
    const fixture = await customerFixture();
    await deviceRepository.registerCustomerDevice({
      customerId: fixture.customerId,
      token: `partial-ok-${randomUUID()}`,
      platform: 'android',
    });
    await deviceRepository.registerCustomerDevice({
      customerId: fixture.customerId,
      token: `partial-transient-${randomUUID()}`,
      platform: 'ios',
    });
    const id = await enqueue(fixture);
    const sender = senderMock(async () => [
      { tokenShortRef: 'ok-ref', outcome: 'delivered' },
      {
        tokenShortRef: 'retry-ref',
        outcome: 'transient_error',
        errorCode: 'messaging/internal-error',
      },
    ]);
    const dispatchWorker = worker(sender);
    await expect(
      dispatchWorker.processClaimedRow(await claimOnly(dispatchWorker)),
    ).resolves.toBe('delivered');
    expect(await outboxState(id)).toMatchObject({
      status: 'delivered',
      attempts: 0,
    });
  });

  it('dead-letters non-retryable config/payload errors and never sends unsafe payloads', async () => {
    const fixture = await customerFixture();
    await deviceRepository.registerCustomerDevice({
      customerId: fixture.customerId,
      token: `config-${randomUUID()}`,
      platform: 'android',
    });
    const configId = await enqueue(fixture);
    const configSender = senderMock(async () => [
      {
        tokenShortRef: 'config-ref',
        outcome: 'config_error',
        errorCode: 'messaging/invalid-argument',
      },
    ]);
    const configWorker = worker(configSender);
    await expect(
      configWorker.processClaimedRow(await claimOnly(configWorker)),
    ).resolves.toBe('dead');
    expect(await outboxState(configId)).toMatchObject({
      status: 'dead',
      attempts: 1,
      last_error_kind: 'config_error',
    });

    await pool.query('DELETE FROM notification_outbox');
    const unsafeId = await enqueue(fixture);
    await pool.query(
      `UPDATE notification_outbox
          SET payload = payload || '{"customerPhone":"+966-secret"}'::jsonb
        WHERE id = $1`,
      [unsafeId],
    );
    const unsafeSender = senderMock(async () => []);
    const unsafeWorker = worker(unsafeSender);
    await expect(
      unsafeWorker.processClaimedRow(await claimOnly(unsafeWorker)),
    ).resolves.toBe('dead');
    expect(unsafeSender.sendToDevices).not.toHaveBeenCalled();
    expect(await outboxState(unsafeId)).toMatchObject({
      status: 'dead',
      last_error_kind: 'unknown',
    });
  });

  it('classifies batch-level config and throttle failures without retry storms', async () => {
    const fixture = await customerFixture();
    await deviceRepository.registerCustomerDevice({
      customerId: fixture.customerId,
      token: `batch-error-${randomUUID()}`,
      platform: 'android',
    });
    const configId = await enqueue(fixture);
    const configWorker = worker(
      senderMock(async () => {
        throw new FcmBatchSendError(
          'config_error',
          'messaging/mismatched-credential',
        );
      }),
    );
    await expect(
      configWorker.processClaimedRow(await claimOnly(configWorker)),
    ).resolves.toBe('dead');
    expect(await outboxState(configId)).toMatchObject({
      status: 'dead',
      attempts: 1,
      last_error_kind: 'config_error',
    });

    await pool.query('DELETE FROM notification_outbox');
    const throttleId = await enqueue(fixture);
    const throttleWorker = worker(
      senderMock(async () => {
        throw new FcmBatchSendError('throttled', 'messaging/quota-exceeded');
      }),
    );
    await expect(
      throttleWorker.processClaimedRow(await claimOnly(throttleWorker)),
    ).resolves.toBe('retry');
    expect(await outboxState(throttleId)).toMatchObject({
      status: 'pending',
      attempts: 1,
      last_error_kind: 'throttled',
      future: true,
    });
  });

  it('dead-letters at max attempts and a successful retry does not duplicate the outbox row', async () => {
    const fixture = await customerFixture();
    await deviceRepository.registerCustomerDevice({
      customerId: fixture.customerId,
      token: `retry-${randomUUID()}`,
      platform: 'android',
    });
    const key = `retry-dedupe-${randomUUID()}`;
    const id = await enqueue(fixture, { dedupeKey: key });
    let call = 0;
    const sender = senderMock(async () => {
      call += 1;
      if (call === 1) throw new Error('simulated FCM outage');
      return [{ tokenShortRef: 'ok-ref', outcome: 'delivered' }];
    });
    const dispatchWorker = worker(sender);
    await expect(
      dispatchWorker.processClaimedRow(await claimOnly(dispatchWorker)),
    ).resolves.toBe('retry');
    await pool.query(
      'UPDATE notification_outbox SET available_at = NOW(), next_attempt_at = NOW() WHERE id = $1',
      [id],
    );
    await expect(
      dispatchWorker.processClaimedRow(await claimOnly(dispatchWorker)),
    ).resolves.toBe('delivered');
    expect(sender.sendToDevices).toHaveBeenCalledTimes(2);
    const final = await pool.query<{
      status: string;
      attempts: number;
      count: number;
    }>(
      `SELECT status, attempts,
              (SELECT count(*)::int FROM notification_outbox WHERE dedupe_key = $2) AS count
         FROM notification_outbox WHERE id = $1`,
      [id, key],
    );
    expect(final.rows[0]).toEqual({
      status: 'delivered',
      attempts: 1,
      count: 1,
    });

    await pool.query('DELETE FROM notification_outbox');
    const deadId = await enqueue(fixture, { attempts: 4 });
    const deadSender = senderMock(async () => [
      {
        tokenShortRef: 'still-down',
        outcome: 'transient_error',
        errorCode: 'messaging/server-unavailable',
      },
    ]);
    const deadWorker = worker(deadSender);
    await expect(
      deadWorker.processClaimedRow(await claimOnly(deadWorker)),
    ).resolves.toBe('dead');
    expect(await outboxState(deadId)).toMatchObject({
      status: 'dead',
      attempts: 5,
      last_error_kind: 'network_error',
    });
  });
});

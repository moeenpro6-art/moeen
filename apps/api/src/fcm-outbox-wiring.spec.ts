import 'dotenv/config';
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
import type { FcmSender } from './fcm.sender';
import { NotificationOutboxWriter } from './notification-outbox.writer';
import { ServiceRequestRepository } from './service-request.repository';

const ENABLED_CONFIG: FcmConfig = {
  enabled: true,
  environment: 'test',
  projectId: 'test-project',
  clientEmail: 'test@example.test',
  privateKey: 'test-only-never-used-by-mock-sender',
};

type StoredNotification = {
  id: number;
  dedupeKey: string;
  recipientOwnerKind: 'customer' | 'provider';
  recipientCustomerId: number | null;
  recipientProviderId: string | null;
  notificationType: string;
  payload: Record<string, unknown>;
  attempts: number;
};

function requestDatabaseId(requestId: string): number {
  return Number(requestId.replace('MOE-', '')) - 1000;
}

function customerDatabaseId(customerId: string): number {
  return Number(customerId.replace('CUS-', '')) - 1000;
}

describe('FCM Pilot domain event wiring', () => {
  const wake = new EventEmitter();
  const writer = new NotificationOutboxWriter(ENABLED_CONFIG, wake);
  const repository = new ServiceRequestRepository(writer);
  const deviceRepository = new FcmDeviceRepository();
  const pool = new Pool({
    connectionString: resolveDatabaseConnectionString(),
  });
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

  async function customer(): Promise<{ id: string }> {
    return repository.upsertCustomer(
      `+966${randomUUID().replaceAll('-', '').slice(0, 9)}`,
    );
  }

  async function verifiedProvider(): Promise<{ id: string }> {
    const provider = await repository.createPilotProvider({
      name: `مقدم اختبار ${randomUUID().slice(0, 8)}`,
      specialties: ['ac-cleaning'],
      serviceZone: 'بريدة',
    });
    await repository.updatePilotProviderVerification(provider.id, 'verified');
    return provider;
  }

  async function createRequest(customerId: string): Promise<{ id: string }> {
    return repository.create(
      {
        serviceId: 'ac-cleaning',
        address: `عنوان سري ${randomUUID()}`,
        details: `تفاصيل سرية ${randomUUID()}`,
        timing: 'as-soon-as-possible',
      },
      customerId,
    );
  }

  async function notifications(
    requestId: string,
  ): Promise<StoredNotification[]> {
    const result = await pool.query<{
      id: number;
      dedupe_key: string;
      recipient_owner_kind: 'customer' | 'provider';
      recipient_customer_id: number | null;
      recipient_provider_id: string | null;
      notification_type: string;
      payload: Record<string, unknown>;
      attempts: number;
    }>(
      `SELECT id::int, dedupe_key, recipient_owner_kind,
              recipient_customer_id::int, recipient_provider_id,
              notification_type, payload, attempts
         FROM notification_outbox
        WHERE service_request_id = $1
        ORDER BY id`,
      [requestDatabaseId(requestId)],
    );
    return result.rows.map((row) => ({
      id: row.id,
      dedupeKey: row.dedupe_key,
      recipientOwnerKind: row.recipient_owner_kind,
      recipientCustomerId: row.recipient_customer_id,
      recipientProviderId: row.recipient_provider_id,
      notificationType: row.notification_type,
      payload: row.payload,
      attempts: row.attempts,
    }));
  }

  function expectSafeStoredPayloads(rows: StoredNotification[]): void {
    for (const row of rows) {
      expect(Object.keys(row.payload).sort()).toEqual([
        'eventId',
        'navigate',
        'requestId',
        'type',
        'v',
      ]);
      expect(row.payload.eventId).toBe(String(row.id));
      const serialized = JSON.stringify(row.payload);
      expect(serialized).not.toMatch(
        /customerPhone|customerName|customerEmail|customerId|providerId|address|details|description|images|imageUrl|signedUrl|storageKey|scope|amount|token/i,
      );
    }
  }

  it('wires C1 and P1 atomically on request creation with exact account recipients', async () => {
    const provider = await verifiedProvider();
    const owner = await customer();
    const request = await createRequest(owner.id);
    const rows = await notifications(request.id);

    const invitations = rows.filter(
      (row) => row.notificationType === 'opportunity_invited',
    );
    const ownInvitation = invitations.find(
      (row) => row.recipientProviderId === provider.id,
    );
    expect(invitations.length).toBeGreaterThanOrEqual(1);
    expect(ownInvitation).toMatchObject({
      recipientOwnerKind: 'provider',
      recipientProviderId: provider.id,
      recipientCustomerId: null,
      attempts: 0,
    });
    expect(ownInvitation?.dedupeKey).toBe(
      `opportunity_invited:${requestDatabaseId(request.id)}:${provider.id}`,
    );
    const customerPush = rows.find(
      (row) => row.notificationType === 'request_created',
    );
    expect(customerPush).toMatchObject({
      recipientOwnerKind: 'customer',
      recipientProviderId: null,
      attempts: 4,
    });
    expect(customerPush?.dedupeKey).toBe(
      `request_created:${requestDatabaseId(request.id)}`,
    );
    expectSafeStoredPayloads(rows);
  });

  it('wires C2 for provider quotes and never emits provider own-quote-rejected', async () => {
    const provider = await verifiedProvider();
    const owner = await customer();
    const request = await createRequest(owner.id);
    const quote = await repository.submitProviderQuote(
      request.id,
      provider.id,
      12_500,
      'نطاق عرض خاص لا يدخل الإشعار',
    );
    let rows = await notifications(request.id);
    const quotePush = rows.find(
      (row) => row.notificationType === 'quote_received',
    );
    expect(quotePush).toMatchObject({
      recipientOwnerKind: 'customer',
      recipientProviderId: null,
      attempts: 0,
    });
    expect(quotePush?.dedupeKey).toBe(
      `quote_received:${requestDatabaseId(request.id)}:${quote.id.replace('QTE-', '')}`,
    );

    await repository.decideQuote(request.id, owner.id, quote.id, 'rejected');
    rows = await notifications(request.id);
    expect(rows.map((row) => row.notificationType)).not.toContain(
      'quote_rejected',
    );
    expect(
      rows.filter((row) => row.recipientProviderId === provider.id),
    ).toHaveLength(1);
    expectSafeStoredPayloads(rows);
  });

  it('wires C3/P2/P3 on quote approval without notifying the winner that its opportunity closed', async () => {
    const winner = await verifiedProvider();
    const competitor = await verifiedProvider();
    const owner = await customer();
    const request = await createRequest(owner.id);
    const winningQuote = await repository.submitProviderQuote(
      request.id,
      winner.id,
      20_000,
      'عرض الفائز',
    );
    await repository.submitProviderQuote(
      request.id,
      competitor.id,
      21_000,
      'عرض المنافس',
    );

    await repository.decideQuote(
      request.id,
      owner.id,
      winningQuote.id,
      'approved',
    );
    const rows = await notifications(request.id);
    expect(
      rows.filter((row) => row.notificationType === 'assignment_confirmed'),
    ).toHaveLength(1);
    expect(
      rows.filter(
        (row) =>
          row.notificationType === 'provider_assigned' &&
          row.recipientProviderId === winner.id,
      ),
    ).toHaveLength(1);
    expect(
      rows.filter(
        (row) =>
          row.notificationType === 'opportunity_closed' &&
          row.recipientProviderId === competitor.id,
      ),
    ).toHaveLength(1);
    expect(
      rows.filter(
        (row) =>
          row.notificationType === 'opportunity_closed' &&
          row.recipientProviderId === winner.id,
      ),
    ).toHaveLength(0);

    await expect(
      repository.decideQuote(request.id, owner.id, winningQuote.id, 'approved'),
    ).rejects.toThrow();
    const afterReplay = await notifications(request.id);
    expect(afterReplay).toHaveLength(rows.length);
    expect(new Set(afterReplay.map((row) => row.dedupeKey)).size).toBe(
      afterReplay.length,
    );
    expectSafeStoredPayloads(afterReplay);
  });

  it('wires C4-C6 from provider status transitions and C7 from staff cancellation', async () => {
    const provider = await verifiedProvider();
    const owner = await customer();
    const request = await createRequest(owner.id);
    const quote = await repository.submitProviderQuote(
      request.id,
      provider.id,
      15_000,
      'نطاق اختبار',
    );
    await repository.decideQuote(request.id, owner.id, quote.id, 'approved');
    await repository.updateStatusForProvider(
      request.id,
      provider.id,
      'on_the_way',
    );
    await repository.updateStatusForProvider(
      request.id,
      provider.id,
      'in_progress',
    );
    await repository.updateStatusForProvider(
      request.id,
      provider.id,
      'completed',
    );
    const rows = await notifications(request.id);
    expect(
      rows
        .filter((row) =>
          [
            'provider_on_the_way',
            'service_in_progress',
            'request_completed',
          ].includes(row.notificationType),
        )
        .map((row) => row.notificationType),
    ).toEqual([
      'provider_on_the_way',
      'service_in_progress',
      'request_completed',
    ]);

    const cancellationOwner = await customer();
    const cancelledRequest = await createRequest(cancellationOwner.id);
    await repository.updateStatus(cancelledRequest.id, 'cancelled');
    const cancelledRows = await notifications(cancelledRequest.id);
    expect(
      cancelledRows.filter(
        (row) => row.notificationType === 'request_cancelled',
      ),
    ).toHaveLength(1);
    expectSafeStoredPayloads([...rows, ...cancelledRows]);
  });

  it('keeps a committed domain transition successful when FCM is down and retries only in the dispatcher', async () => {
    const provider = await verifiedProvider();
    const owner = await customer();
    const request = await createRequest(owner.id);
    await repository.assignProvider(request.id, provider.id);
    await deviceRepository.registerCustomerDevice({
      customerId: owner.id,
      token: `domain-outage-${randomUUID()}`,
      platform: 'android',
    });

    await expect(
      repository.updateStatusForProvider(request.id, provider.id, 'on_the_way'),
    ).resolves.toMatchObject({ status: 'on_the_way' });

    const rows = await notifications(request.id);
    const statusRow = rows.find(
      (row) => row.notificationType === 'provider_on_the_way',
    );
    expect(statusRow).toBeDefined();
    // Deterministic claim: this file accumulates pending rows across tests, so
    // clear every other pending row (simulating already-delivered history)
    // before the dispatcher claims, guaranteeing the target row is claimed.
    await pool.query(
      `UPDATE notification_outbox
          SET status = 'delivered', delivered_at = NOW()
        WHERE status = 'pending' AND id <> $1`,
      [statusRow?.id],
    );
    const sender: FcmSender = {
      sendToDevices: jest.fn().mockRejectedValue(new Error('simulated outage')),
    };
    const dispatchWorker = new FcmDispatchWorker(
      ENABLED_CONFIG,
      sender,
      new EventEmitter(),
    );
    workers.push(dispatchWorker);
    const claimed = await dispatchWorker.claimBatch();
    const claimedStatusRow = claimed.find((row) => row.id === statusRow?.id);
    expect(claimedStatusRow).toBeDefined();
    await expect(
      dispatchWorker.processClaimedRow(claimedStatusRow as ClaimedFcmOutboxRow),
    ).resolves.toBe('retry');

    const persisted = await pool.query<{
      request_status: string;
      outbox_status: string;
      attempts: number;
    }>(
      `SELECT r.status AS request_status, o.status AS outbox_status, o.attempts
         FROM service_requests r
         JOIN notification_outbox o ON o.service_request_id = r.id
        WHERE r.id = $1 AND o.id = $2`,
      [requestDatabaseId(request.id), statusRow?.id],
    );
    expect(persisted.rows[0]).toEqual({
      request_status: 'on_the_way',
      outbox_status: 'pending',
      attempts: 1,
    });
  });

  it('lets a legacy request with no customer owner commit its domain mutation without an outbox row', async () => {
    // HIGH #2: a legacy service-request row whose customer_id is NULL has no
    // notify-able recipient. A staff cancellation (updateStatus) must still
    // succeed and persist, and FCM must NOT fabricate an owner or roll the
    // mutation back -- the notification is skipped and no outbox row appears.
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO service_requests (service_id, address, details, timing, status, customer_id)
       VALUES ('ac-cleaning', 'عنوان تراثي', NULL, 'as-soon-as-possible', 'pending_dispatch', NULL)
       RETURNING id`,
    );
    const databaseId = Number(inserted.rows[0].id);
    const requestId = `MOE-${1000 + databaseId}`;

    await expect(
      repository.updateStatus(requestId, 'cancelled'),
    ).resolves.toMatchObject({ status: 'cancelled' });

    const persisted = await pool.query<{
      request_status: string;
      outbox_count: number;
    }>(
      `SELECT r.status AS request_status,
              (SELECT count(*)::int FROM notification_outbox o
                WHERE o.service_request_id = r.id) AS outbox_count
         FROM service_requests r WHERE r.id = $1`,
      [databaseId],
    );
    expect(persisted.rows[0]).toEqual({
      request_status: 'cancelled',
      outbox_count: 0,
    });
  });

  it('still routes modern requests to their exact owner and never to another account', async () => {
    // HIGH #2 tests 1 & 4: a modern row with a valid owner produces exactly
    // one outbox row addressed to that owner's server-side id (never a
    // fabricated/fallback identity). This is the positive counter-part to the
    // legacy-skip case.
    const owner = await customer();
    const request = await createRequest(owner.id);
    await repository.updateStatus(request.id, 'cancelled');
    const rows = await notifications(request.id);
    const cancellation = rows.find(
      (row) => row.notificationType === 'request_cancelled',
    );
    expect(cancellation).toBeDefined();
    expect(cancellation?.recipientOwnerKind).toBe('customer');
    expect(cancellation?.recipientCustomerId).toBe(
      customerDatabaseId(owner.id),
    );
    expect(cancellation?.recipientProviderId).toBeNull();
  });
});

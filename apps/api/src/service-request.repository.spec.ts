import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { resolveDatabaseConnectionString } from './database.config';
import {
  hashProviderAccessCode,
  providerAccessCodeLookupId,
} from './provider-access-code';
import { ServiceRequestRepository } from './service-request.repository';
import { StaffAuthRepository } from './staff-auth.repository';

describe('ServiceRequestRepository', () => {
  it('requires a dedicated test database connection when running tests', () => {
    expect(
      resolveDatabaseConnectionString({
        NODE_ENV: 'test',
        TEST_DATABASE_URL: 'postgresql://localhost:5433/moeen_test',
      }),
    ).toBe('postgresql://localhost:5433/moeen_test');
    expect(() => resolveDatabaseConnectionString({ NODE_ENV: 'test' })).toThrow(
      'TEST_DATABASE_URL must be configured when NODE_ENV is test',
    );
  });

  const repository = new ServiceRequestRepository();
  const staffAuthRepository = new StaffAuthRepository();

  beforeAll(async () => {
    await repository.initialize();
    await staffAuthRepository.initialize();
  });

  afterAll(async () => {
    // Remove pilot providers created by these tests so the provider-login
    // scrypt loop stays bounded across runs.
    const cleanupPool = new Pool({
      connectionString: resolveDatabaseConnectionString(),
    });
    try {
      await cleanupPool.query(
        `DELETE FROM service_payments
         WHERE service_request_id IN (
           SELECT id FROM service_requests WHERE assigned_provider_id LIKE 'PILOT-%'
         )
            OR quote_id IN (
           SELECT id FROM service_quotes WHERE provider_id LIKE 'PILOT-%'
         )`,
      );
      await cleanupPool.query(
        `DELETE FROM service_request_events
         WHERE service_request_id IN (
           SELECT id FROM service_requests WHERE assigned_provider_id LIKE 'PILOT-%'
         )`,
      );
      await cleanupPool.query(
        `DELETE FROM request_provider_opportunities
         WHERE provider_id LIKE 'PILOT-%'
            OR service_request_id IN (
           SELECT id FROM service_requests WHERE assigned_provider_id LIKE 'PILOT-%'
         )`,
      );
      await cleanupPool.query(
        `DELETE FROM service_quotes
         WHERE provider_id LIKE 'PILOT-%'
            OR service_request_id IN (
           SELECT id FROM service_requests WHERE assigned_provider_id LIKE 'PILOT-%'
         )`,
      );
      await cleanupPool.query(
        `DELETE FROM service_requests WHERE assigned_provider_id LIKE 'PILOT-%'`,
      );
      await cleanupPool.query(
        `DELETE FROM provider_sessions WHERE provider_id LIKE 'PILOT-%'`,
      );
      await cleanupPool.query(
        `DELETE FROM provider_access_credentials WHERE provider_id LIKE 'PILOT-%'`,
      );
      await cleanupPool.query(`DELETE FROM providers WHERE id LIKE 'PILOT-%'`);
    } finally {
      await cleanupPool.end();
    }
    await Promise.all([repository.close(), staffAuthRepository.close()]);
  });

  it('persists login failures and clears their throttle bucket after a success', async () => {
    const attemptStore = staffAuthRepository as unknown as {
      countRecentLoginFailures: (
        scope: 'staff_login' | 'provider_login',
        subjectHash: string,
        since: Date,
      ) => Promise<number>;
      recordLoginFailure: (
        scope: 'staff_login' | 'provider_login',
        subjectHash: string,
      ) => Promise<void>;
      clearLoginFailures: (
        scope: 'staff_login' | 'provider_login',
        subjectHash: string,
      ) => Promise<void>;
    };
    const subjectHash = `test-login-subject-${randomUUID()}`;
    const scope = 'staff_login' as const;

    await attemptStore.recordLoginFailure(scope, subjectHash);
    await expect(
      attemptStore.countRecentLoginFailures(
        scope,
        subjectHash,
        new Date(Date.now() - 15 * 60_000),
      ),
    ).resolves.toBe(1);
    await attemptStore.clearLoginFailures(scope, subjectHash);
    await expect(
      attemptStore.countRecentLoginFailures(
        scope,
        subjectHash,
        new Date(Date.now() - 15 * 60_000),
      ),
    ).resolves.toBe(0);
  });

  it('atomically reserves no more than five OTP verification attempts', async () => {
    const challengeId = randomUUID();
    await repository.createOtpChallenge({
      challengeId,
      phone: '+966500000001',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const reservations = await Promise.all(
      Array.from({ length: 6 }, () =>
        repository.reserveOtpVerificationAttempt(challengeId),
      ),
    );

    expect(reservations.filter(Boolean)).toHaveLength(5);
    await expect(repository.findOtpChallenge(challengeId)).resolves.toEqual(
      expect.objectContaining({ failedAttempts: 5 }),
    );
  });

  it('returns seeded providers for dispatch', async () => {
    await expect(repository.findProviders()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'provider-1',
          name: 'فريق التبريد السريع',
          available: true,
        }),
      ]),
    );
  });

  it('resolves a customer from their opaque session token', async () => {
    const customer = await repository.upsertCustomer('+966500000112');
    await repository.createCustomerSession(
      customer.id,
      'session-token-for-test',
    );

    await expect(
      repository.findCustomerBySession('session-token-for-test'),
    ).resolves.toEqual(customer);
    await expect(
      repository.findCustomerBySession('unknown-token'),
    ).resolves.toBeUndefined();
  });

  it('keeps the OTP resend cooldown after the API repository is recreated', async () => {
    const phone = `otp-test-${randomUUID()}`;
    const requestedAt = new Date();

    await expect(
      repository.reserveOtpRequest(phone, requestedAt),
    ).resolves.toBe('accepted');

    const restartedRepository = new ServiceRequestRepository();
    await restartedRepository.initialize();
    try {
      await expect(
        restartedRepository.reserveOtpRequest(
          phone,
          new Date(requestedAt.getTime() + 59_000),
        ),
      ).resolves.toBe('cooldown');
    } finally {
      await restartedRepository.close();
    }
  });

  it('persists OTP failure attempts', async () => {
    const challengeId = randomUUID();
    await repository.createOtpChallenge({
      challengeId,
      phone: '+966500123457',
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });

    await expect(repository.recordOtpFailure(challengeId)).resolves.toBe(1);
    await expect(repository.recordOtpFailure(challengeId)).resolves.toBe(2);
  });

  it('consumes an approved OTP challenge only once', async () => {
    const challengeId = randomUUID();
    await repository.createOtpChallenge({
      challengeId,
      phone: '+966500123458',
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });

    await expect(repository.consumeOtpChallenge(challengeId)).resolves.toBe(
      true,
    );
    await expect(repository.consumeOtpChallenge(challengeId)).resolves.toBe(
      false,
    );
  });

  it('persists an OTP challenge so a restarted API instance can recover it', async () => {
    const challengeId = randomUUID();
    const phone = '+966500123456';
    const expiresAt = new Date(Date.now() + 10 * 60_000);

    await repository.createOtpChallenge({ challengeId, phone, expiresAt });

    const restartedRepository = new ServiceRequestRepository();
    await restartedRepository.initialize();
    try {
      await expect(
        restartedRepository.findOtpChallenge(challengeId),
      ).resolves.toMatchObject({
        challengeId,
        phone,
        failedAttempts: 0,
      });
    } finally {
      await restartedRepository.close();
    }
  });

  it('blocks an unverified pilot provider from dispatch until an admin verifies it', async () => {
    const customer = await repository.upsertCustomer('+966500123459');
    const request = await repository.create(
      {
        serviceId: 'ac-cleaning',
        address: 'حي الصفراء، بريدة',
        timing: 'as-soon-as-possible',
      },
      customer.id,
    );
    const provider = await repository.createPilotProvider({
      name: 'مزود اختبار بريدة',
      specialties: ['ac-cleaning'],
      serviceZone: 'حي الصفراء، بريدة',
    });

    expect(provider).toMatchObject({
      verificationStatus: 'pending',
      available: false,
      serviceZone: 'حي الصفراء، بريدة',
    });
    await expect(
      repository.assignProvider(request.id, provider.id),
    ).rejects.toThrow('Request or available provider not found');

    await expect(
      repository.updatePilotProviderVerification(provider.id, 'verified'),
    ).resolves.toMatchObject({
      verificationStatus: 'verified',
      available: true,
    });
    const assigned = await repository.assignProvider(request.id, provider.id);
    expect(assigned.status).toBe('assigned');
    expect(assigned.assignedProvider?.id).toBe(provider.id);
  });

  it('blocks an approved pilot provider from an incompatible service category', async () => {
    const customer = await repository.upsertCustomer('+966500123458');
    const request = await repository.create(
      {
        serviceId: 'ac-cleaning',
        address: 'حي الصفراء، بريدة',
        timing: 'as-soon-as-possible',
      },
      customer.id,
    );
    const provider = await repository.createPilotProvider({
      name: 'فني سباكة اختبار',
      specialties: ['plumbing'],
      serviceZone: 'حي الصفراء، بريدة',
    });
    await repository.updatePilotProviderVerification(provider.id, 'verified');

    await expect(
      repository.assignProvider(request.id, provider.id),
    ).rejects.toThrow('Request or available provider not found');
  });

  it('creates an opaque provider session and scopes jobs and status changes to that provider', async () => {
    const providerStore = repository as unknown as {
      setProviderAccessCode: (
        providerId: string,
        accessCode: string,
      ) => Promise<void>;
      findProviderByAccessCode: (
        accessCode: string,
      ) => Promise<
        { id: string; name: string; available: boolean } | undefined
      >;
      createProviderSession: (
        providerId: string,
        token: string,
      ) => Promise<void>;
      findProviderBySession: (
        token: string,
      ) => Promise<
        { id: string; name: string; available: boolean } | undefined
      >;
      findByProviderId: (
        providerId: string,
      ) => Promise<Array<{ id: string; assignedProvider?: { id: string } }>>;
      updateStatusForProvider: (
        requestId: string,
        providerId: string,
        status: 'on_the_way' | 'in_progress' | 'completed',
      ) => Promise<{ status: string }>;
      updateProviderAvailability: (
        providerId: string,
        available: boolean,
      ) => Promise<{ available: boolean }>;
    };
    expect(typeof providerStore.setProviderAccessCode).toBe('function');
    expect(typeof providerStore.findProviderByAccessCode).toBe('function');
    expect(typeof providerStore.createProviderSession).toBe('function');
    expect(typeof providerStore.findByProviderId).toBe('function');

    const accessCode = `provider-access-${randomUUID()}`;
    await providerStore.setProviderAccessCode('provider-1', accessCode);
    const provider = await providerStore.findProviderByAccessCode(accessCode);
    expect(provider).toMatchObject({ id: 'provider-1', available: true });

    await providerStore.createProviderSession('provider-1', 'provider-session');
    await expect(
      providerStore.findProviderBySession('provider-session'),
    ).resolves.toMatchObject({ id: 'provider-1' });

    const customer = await repository.upsertCustomer('+966500000681');
    const ownRequest = await repository.create(
      {
        serviceId: 'ac-cleaning',
        address: 'حي الصفراء، بريدة',
        timing: 'as-soon-as-possible',
      },
      customer.id,
    );
    await repository.assignProvider(ownRequest.id, 'provider-1');

    const otherRequest = await repository.create(
      {
        serviceId: 'plumbing',
        address: 'حي النهضة، بريدة',
        timing: 'as-soon-as-possible',
      },
      customer.id,
    );
    await repository.assignProvider(otherRequest.id, 'provider-3');

    const assignedRequests = await providerStore.findByProviderId('provider-1');
    expect(
      assignedRequests.some(
        (request) =>
          request.id === ownRequest.id &&
          request.assignedProvider?.id === 'provider-1',
      ),
    ).toBe(true);
    await expect(
      providerStore.updateStatusForProvider(
        ownRequest.id,
        'provider-1',
        'on_the_way',
      ),
    ).resolves.toMatchObject({ status: 'on_the_way' });
    await expect(
      providerStore.updateStatusForProvider(
        otherRequest.id,
        'provider-1',
        'on_the_way',
      ),
    ).rejects.toThrow('Assigned provider request not found');

    await expect(
      providerStore.updateProviderAvailability('provider-1', false),
    ).resolves.toMatchObject({ available: false });
    await providerStore.updateProviderAvailability('provider-1', true);
  });

  it('upgrades a legacy provider access-code hash after a successful login', async () => {
    const accessCode = `provider-access-${randomUUID()}`;
    const provider = await repository.createPilotProvider({
      name: 'مقدم خدمة ترحيل الرمز',
      specialties: ['ac-cleaning'],
      serviceZone: 'بريدة',
    });
    await repository.updatePilotProviderVerification(provider.id, 'verified');

    const pool = new Pool({
      connectionString: resolveDatabaseConnectionString(),
    });
    try {
      const legacyHash = createHash('sha256').update(accessCode).digest('hex');
      await pool.query(
        `INSERT INTO provider_access_credentials (provider_id, access_code_hash)
         VALUES ($1, $2)`,
        [provider.id, legacyHash],
      );
      // The idempotent schema backfill must run before lookup works.
      await repository.initialize();

      await expect(
        repository.findProviderByAccessCode(accessCode),
      ).resolves.toMatchObject({ id: provider.id });

      const stored = await pool.query<{ access_code_hash: string }>(
        'SELECT access_code_hash FROM provider_access_credentials WHERE provider_id = $1',
        [provider.id],
      );
      expect(stored.rows[0]?.access_code_hash).toMatch(/^scrypt\$/);
    } finally {
      await pool.end();
    }
  }, 15_000);

  it('keeps provider lookups indexed: an unknown code is not verified against every provider', async () => {
    const probe = new Pool({
      connectionString: resolveDatabaseConnectionString(),
    });
    try {
      for (let index = 0; index < 200; index += 1) {
        const providerId = `PILOT-perf-${index}`;
        const code = `perf-access-${index}-${randomUUID().slice(0, 8)}`;
        await probe.query(
          `INSERT INTO providers (id, name, specialties, available, service_zone, verification_status)
           VALUES ($1, $2, ARRAY['ac-cleaning'], TRUE, 'بريدة', 'verified')`,
          [providerId, `مقدم أداء ${index}`],
        );
        await probe.query(
          `INSERT INTO provider_access_credentials (provider_id, access_code_hash, lookup_id)
           VALUES ($1, $2, $3)`,
          [
            providerId,
            await hashProviderAccessCode(code),
            providerAccessCodeLookupId(code),
          ],
        );
      }
      const startedAt = Date.now();
      await expect(
        repository.findProviderByAccessCode(`unknown-code-${randomUUID()}`),
      ).resolves.toBeUndefined();
      const elapsedMs = Date.now() - startedAt;
      // New path: one indexed lookup + one dummy verification (~0.1s).
      // The old O(N) path would verify 200 scrypt hashes (~12s+).
      expect(elapsedMs).toBeLessThan(5000);
    } finally {
      await probe.end();
    }
  }, 30_000);

  it('backfills lookup ids for legacy SHA-256 credentials and keeps them authenticating', async () => {
    const provider = await createVerifiedProvider(['ac-cleaning']);
    const accessCode = `legacy-backfill-${randomUUID()}`;
    const legacyHash = createHash('sha256').update(accessCode).digest('hex');
    const probe = new Pool({
      connectionString: resolveDatabaseConnectionString(),
    });
    try {
      await probe.query(
        `INSERT INTO provider_access_credentials (provider_id, access_code_hash)
         VALUES ($1, $2)`,
        [provider.id, legacyHash],
      );
      await repository.initialize();
      const stored = await probe.query<{ lookup_id: string | null }>(
        'SELECT lookup_id FROM provider_access_credentials WHERE provider_id = $1',
        [provider.id],
      );
      expect(stored.rows[0]?.lookup_id).toBe(legacyHash);
      await expect(
        repository.findProviderByAccessCode(accessCode),
      ).resolves.toMatchObject({ id: provider.id });
    } finally {
      await probe.end();
    }
  });

  it('fails generically for a scrypt credential without lookup_id until the code is rotated', async () => {
    const provider = await createVerifiedProvider(['ac-cleaning']);
    const accessCode = `scrypt-no-lookup-${randomUUID()}`;
    const probe = new Pool({
      connectionString: resolveDatabaseConnectionString(),
    });
    try {
      await probe.query(
        `INSERT INTO provider_access_credentials (provider_id, access_code_hash)
         VALUES ($1, $2)`,
        [provider.id, await hashProviderAccessCode(accessCode)],
      );
      await expect(
        repository.findProviderByAccessCode(accessCode),
      ).resolves.toBeUndefined();
      await repository.setProviderAccessCode(provider.id, accessCode);
      await expect(
        repository.findProviderByAccessCode(accessCode),
      ).resolves.toMatchObject({ id: provider.id });
    } finally {
      await probe.end();
    }
  });

  it('rejects a duplicate provider access code with a controlled error', async () => {
    const providerA = await createVerifiedProvider(['ac-cleaning']);
    const providerB = await createVerifiedProvider(['ac-cleaning']);
    const accessCode = `shared-code-${randomUUID()}`;
    await repository.setProviderAccessCode(providerA.id, accessCode);
    await expect(
      repository.setProviderAccessCode(providerB.id, accessCode),
    ).rejects.toThrow('Provider access code is already in use');
  });

  it('keeps existing provider sessions valid after the lookup migration', async () => {
    const provider = await createVerifiedProvider(['ac-cleaning']);
    const accessCode = `session-migration-${randomUUID()}`;
    await repository.setProviderAccessCode(provider.id, accessCode);
    await repository.createProviderSession(
      provider.id,
      'session-token-after-migration',
    );
    await expect(
      repository.findProviderBySession('session-token-after-migration'),
    ).resolves.toMatchObject({ id: provider.id });
    await expect(
      repository.findProviderByAccessCode(accessCode),
    ).resolves.toMatchObject({ id: provider.id });
  });

  it('records an immutable creation event for a new customer request', async () => {
    const historyReader = repository as unknown as {
      findRequestEvents: (
        requestId: string,
      ) => Promise<Array<{ type: string; status: string; createdAt: string }>>;
    };
    expect(typeof historyReader.findRequestEvents).toBe('function');

    const customer = await repository.upsertCustomer('+966****3462');
    const request = await repository.create(
      {
        serviceId: 'ac-cleaning',
        address: 'حي الصفراء، بريدة',
        timing: 'as-soon-as-possible',
      },
      customer.id,
    );

    await expect(historyReader.findRequestEvents(request.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'request_created',
          status: 'pending_dispatch',
        }),
      ]),
    );
  });

  it('requires customer approval before a quoted job can enter service', async () => {
    const quoteStore = repository as unknown as {
      proposeQuote: (
        requestId: string,
        amountHalalas: number,
        scope: string,
      ) => Promise<{ id: string; status: string; amountHalalas: number }>;
      decideQuote: (
        requestId: string,
        customerId: string,
        quoteId: string,
        decision: 'approved' | 'rejected',
      ) => Promise<{ id: string; status: string }>;
    };
    expect(typeof quoteStore.proposeQuote).toBe('function');
    expect(typeof quoteStore.decideQuote).toBe('function');

    const customer = await repository.upsertCustomer('+966****3464');
    // A unique serviceId guarantees no provider (seeded or accumulated from
    // earlier runs) can match, so the request has no auto-created
    // opportunities and the legacy staff quote path applies.
    const uniqueServiceId = `staff-flow-${randomUUID()}`;
    const request = await repository.create(
      {
        serviceId: uniqueServiceId,
        address: 'حي الصفراء، بريدة',
        timing: 'as-soon-as-possible',
      },
      customer.id,
    );
    const staffProvider = await createVerifiedProvider([uniqueServiceId]);
    await repository.assignProvider(request.id, staffProvider.id);
    await repository.updateStatus(request.id, 'on_the_way');

    const quote = await quoteStore.proposeQuote(
      request.id,
      15_000,
      'إصلاح تسرب تحت المغسلة',
    );
    expect(quote).toMatchObject({ status: 'proposed', amountHalalas: 15_000 });
    await expect(
      repository.updateStatus(request.id, 'in_progress'),
    ).rejects.toThrow('Quote approval required');

    await expect(
      quoteStore.decideQuote(request.id, customer.id, quote.id, 'approved'),
    ).resolves.toMatchObject({ id: quote.id, status: 'approved' });
    await expect(
      repository.updateStatus(request.id, 'in_progress'),
    ).resolves.toMatchObject({
      status: 'in_progress',
    });
  });

  it('appends one lifecycle event for assignment and every valid status update', async () => {
    const customer = await repository.upsertCustomer('+966****3463');
    const request = await repository.create(
      {
        serviceId: 'ac-cleaning',
        address: 'حي الصفراء، بريدة',
        timing: 'as-soon-as-possible',
      },
      customer.id,
    );

    await repository.assignProvider(request.id, 'provider-1');
    await repository.updateStatus(request.id, 'on_the_way');
    await repository.updateStatus(request.id, 'in_progress');
    await repository.updateStatus(request.id, 'completed');

    await expect(repository.findRequestEvents(request.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'request_created',
          status: 'pending_dispatch',
        }),
        expect.objectContaining({
          type: 'provider_assigned',
          status: 'assigned',
        }),
        expect.objectContaining({
          type: 'status_updated',
          status: 'on_the_way',
        }),
        expect.objectContaining({
          type: 'status_updated',
          status: 'in_progress',
        }),
        expect.objectContaining({
          type: 'status_updated',
          status: 'completed',
        }),
      ]),
    );
  });

  it('does not allow a dispatched job to be assigned a second time', async () => {
    const customer = await repository.upsertCustomer('+966****3461');
    const request = await repository.create(
      {
        serviceId: 'ac-cleaning',
        address: 'حي الصفراء، بريدة',
        timing: 'as-soon-as-possible',
      },
      customer.id,
    );
    await repository.assignProvider(request.id, 'provider-1');

    await expect(
      repository.assignProvider(request.id, 'provider-1'),
    ).rejects.toThrow('Request or available provider not found');
  });

  it('prevents a dispatcher from completing an assigned job before service starts', async () => {
    const customer = await repository.upsertCustomer('+966****3460');
    const request = await repository.create(
      {
        serviceId: 'ac-cleaning',
        address: 'حي الصفراء، بريدة',
        timing: 'as-soon-as-possible',
      },
      customer.id,
    );
    await repository.assignProvider(request.id, 'provider-1');

    await expect(
      repository.updateStatus(request.id, 'completed'),
    ).rejects.toThrow('Invalid status transition');
  });

  it('creates a cash-due payment for an approved quote and collects it only after completion', async () => {
    const paymentStore = repository as unknown as {
      collectCashPayment: (requestId: string) => Promise<{
        method: string;
        status: string;
        amountHalalas: number;
      }>;
    };
    const customer = await repository.upsertCustomer(
      `cash-test-${randomUUID()}`,
    );
    // A unique serviceId guarantees no provider can match, so the request
    // has no auto-created opportunities and the staff quote path applies.
    const uniqueServiceId = `staff-cash-${randomUUID()}`;
    const request = await repository.create(
      {
        serviceId: uniqueServiceId,
        address: 'حي الصفراء، بريدة',
        timing: 'as-soon-as-possible',
      },
      customer.id,
    );
    const staffProvider = await createVerifiedProvider([uniqueServiceId]);
    await repository.assignProvider(request.id, staffProvider.id);
    await repository.updateStatus(request.id, 'on_the_way');
    const quote = await repository.proposeQuote(
      request.id,
      15_000,
      'إصلاح تسرب تحت المغسلة',
    );
    await repository.decideQuote(request.id, customer.id, quote.id, 'approved');

    const payment = (
      (await repository.findByCustomerId(customer.id)).find(
        (item) => item.id === request.id,
      ) as typeof request & {
        payment?: { method: string; status: string; amountHalalas: number };
      }
    ).payment;
    expect(payment).toMatchObject({
      method: 'cash_on_completion',
      status: 'cash_due',
      amountHalalas: 15_000,
    });
    await expect(paymentStore.collectCashPayment(request.id)).rejects.toThrow(
      'Cash can only be collected after completion',
    );

    await repository.updateStatus(request.id, 'in_progress');
    await repository.updateStatus(request.id, 'completed');
    await expect(paymentStore.collectCashPayment(request.id)).resolves.toEqual(
      expect.objectContaining({
        method: 'cash_on_completion',
        status: 'cash_collected',
        amountHalalas: 15_000,
      }),
    );
  });

  it('persists a request under the owning customer and returns it only for that customer', async () => {
    const customer = await repository.upsertCustomer('+966****0111');
    const created = await repository.create(
      {
        serviceId: 'upholstery',
        address: 'حي النهضة، بريدة',
        details: 'غسيل كنب',
        timing: 'as-soon-as-possible',
      },
      customer.id,
    );

    const requests = await repository.findByCustomerId(customer.id);

    expect(created.id).toMatch(/^MOE-\d+$/);
    expect(created).toMatchObject({
      serviceId: 'upholstery',
      status: 'pending_dispatch',
    });
    expect(requests).toContainEqual({ ...created, quotes: [] });
  });

  async function createVerifiedProvider(specialties: string[]) {
    const provider = await repository.createPilotProvider({
      name: `مقدم اختبار ${randomUUID().slice(0, 8)}`,
      specialties,
      serviceZone: 'بريدة',
    });
    return repository.updatePilotProviderVerification(provider.id, 'verified');
  }

  async function createPendingRequest(serviceId = 'ac-cleaning') {
    const customer = await repository.upsertCustomer(
      `+9665${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`,
    );
    const request = await repository.create(
      {
        serviceId,
        address: 'حي الصفراء، بريدة',
        details: 'تفاصيل حساسة للخصوصية',
        timing: 'as-soon-as-possible',
      },
      customer.id,
    );
    return { request, customerId: customer.id };
  }

  async function readEventTypes(requestId: string): Promise<string[]> {
    const probe = new Pool({
      connectionString: resolveDatabaseConnectionString(),
    });
    try {
      const result = await probe.query<{ type: string }>(
        `SELECT type FROM service_request_events
         WHERE service_request_id = $1 ORDER BY id`,
        [Number(requestId.replace('MOE-', '')) - 1000],
      );
      return result.rows.map((row) => row.type);
    } finally {
      await probe.end();
    }
  }

  it('invites only eligible providers and records opportunity events', async () => {
    // Request is created first so the providers below do not exist at
    // auto-invite time; the manual invitation path then exercises its own
    // eligibility filtering.
    const { request } = await createPendingRequest('ac-cleaning');
    const eligible = await createVerifiedProvider(['ac-cleaning']);
    const pending = await repository.createPilotProvider({
      name: `مقدم معلق ${randomUUID().slice(0, 8)}`,
      specialties: ['ac-cleaning'],
      serviceZone: 'بريدة',
    });
    const suspended = await repository.updatePilotProviderVerification(
      (await createVerifiedProvider(['ac-cleaning'])).id,
      'suspended',
    );
    const wrongSpecialty = await createVerifiedProvider(['plumbing']);

    const created = await repository.inviteProvidersToRequest(request.id, [
      eligible.id,
      pending.id,
      suspended.id,
      wrongSpecialty.id,
    ]);

    expect(created.map((opportunity) => opportunity.requestId)).toEqual([
      request.id,
    ]);
    expect(created[0]).toMatchObject({
      serviceId: 'ac-cleaning',
      opportunityStatus: 'invited',
    });
    expect(await readEventTypes(request.id)).toContain('opportunity_invited');
    const opportunities = await repository.listProviderOpportunities(
      eligible.id,
    );
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0].requestId).toBe(request.id);
    await expect(
      repository.listProviderOpportunities(wrongSpecialty.id),
    ).resolves.toEqual([]);
  });

  it('automatically invites only eligible providers on request creation, emitting an event per inserted row only', async () => {
    const eligible = await createVerifiedProvider(['ac-cleaning']);
    const unavailable = await repository.updateProviderAvailability(
      (await createVerifiedProvider(['ac-cleaning'])).id,
      false,
    );
    const wrongSpecialty = await createVerifiedProvider(['plumbing']);
    const customer = await repository.upsertCustomer(
      `+9665${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`,
    );

    const created = await repository.create(
      {
        serviceId: 'ac-cleaning',
        address: 'حي الصفراء، بريدة',
        details: 'تفاصيل حساسة للخصوصية',
        timing: 'as-soon-as-possible',
      },
      customer.id,
    );

    expect(created.status).toBe('pending_dispatch');
    const eligibleOpportunities = await repository.listProviderOpportunities(
      eligible.id,
    );
    expect(eligibleOpportunities).toHaveLength(1);
    expect(eligibleOpportunities[0]).toMatchObject({
      requestId: created.id,
      serviceId: 'ac-cleaning',
      opportunityStatus: 'invited',
    });
    // Ineligible providers (unavailable, wrong specialty) get no opportunity.
    await expect(
      repository.listProviderOpportunities(unavailable.id),
    ).resolves.toEqual([]);
    await expect(
      repository.listProviderOpportunities(wrongSpecialty.id),
    ).resolves.toEqual([]);

    // Events: the request_created event plus one opportunity_invited per
    // provider actually eligible at creation time. The test DB accumulates
    // providers across runs, so assert relatively: the eligible provider's
    // row produced an invitation event, and ineligible providers produced
    // none attributable to them (their opportunity lists are empty).
    const events = await repository.findRequestEvents(created.id);
    expect(
      events.some(
        (event) =>
          event.type === 'opportunity_invited' &&
          event.status === 'pending_dispatch',
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === 'request_created')).toBe(true);
  });

  it('does not duplicate opportunities or invitation events when a row already exists', async () => {
    const provider = await createVerifiedProvider(['ac-cleaning']);
    const customer = await repository.upsertCustomer(
      `+9665${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`,
    );

    // First creation auto-invites the eligible provider.
    const first = await repository.create(
      {
        serviceId: 'ac-cleaning',
        address: 'حي الصفراء، بريدة',
        details: 'تفاصيل حساسة للخصوصية',
        timing: 'as-soon-as-possible',
      },
      customer.id,
    );
    const before = await repository.listProviderOpportunities(provider.id);
    expect(before).toHaveLength(1);
    const beforeCount = (await repository.findRequestEvents(first.id)).filter(
      (event) => event.type === 'opportunity_invited',
    ).length;

    // Manual invitation of the same provider is a no-op conflict: no second
    // opportunity row and no second invitation event.
    const manual = await repository.inviteProvidersToRequest(first.id, [
      provider.id,
    ]);
    expect(manual).toEqual([]);
    const after = await repository.listProviderOpportunities(provider.id);
    expect(after).toHaveLength(1);
    const afterCount = (await repository.findRequestEvents(first.id)).filter(
      (event) => event.type === 'opportunity_invited',
    ).length;
    expect(afterCount).toBe(beforeCount);
  });

  it('creates the request without opportunities or invitation events when no provider is eligible', async () => {
    // A unique serviceId guarantees no provider (seeded or accumulated from
    // earlier runs) can match it, keeping this test deterministic.
    const uniqueServiceId = `unmatched-${randomUUID()}`;
    const customer = await repository.upsertCustomer(
      `+9665${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`,
    );
    const created = await repository.create(
      {
        serviceId: uniqueServiceId,
        address: 'حي الصفراء، بريدة',
        details: 'تفاصيل حساسة للخصوصية',
        timing: 'as-soon-as-possible',
      },
      customer.id,
    );

    expect(created.status).toBe('pending_dispatch');
    const events = await repository.findRequestEvents(created.id);
    expect(
      events.filter((event) => event.type === 'opportunity_invited'),
    ).toHaveLength(0);
    expect(events.map((event) => event.type)).toContain('request_created');
  });

  it('rejects invitations when an active quote exists, on completed requests, and for empty lists', async () => {
    // A unique serviceId guarantees no provider can match, so the request
    // has no auto-created opportunities; the staff quote path then applies
    // and the "active quote blocks invitations" rule is exercised. The
    // provider is created after the request so auto-invite cannot reach it.
    const activeQuoteServiceId = `staff-invite-${randomUUID()}`;
    const quoteRequest = await createPendingRequest(activeQuoteServiceId);
    const staffProvider = await createVerifiedProvider([activeQuoteServiceId]);
    await repository.assignProvider(quoteRequest.request.id, staffProvider.id);
    await repository.proposeQuote(
      quoteRequest.request.id,
      10_000,
      'فحص وتنظيف',
    );
    await expect(
      repository.inviteProvidersToRequest(quoteRequest.request.id, [
        staffProvider.id,
      ]),
    ).rejects.toThrow(
      'An active quote exists; provider invitations are not allowed',
    );

    const completedServiceId = `staff-completed-${randomUUID()}`;
    const completed = await createPendingRequest(completedServiceId);
    const mover = await createVerifiedProvider([completedServiceId]);
    await repository.assignProvider(completed.request.id, mover.id);
    await repository.updateStatus(completed.request.id, 'on_the_way');
    await repository.updateStatus(completed.request.id, 'in_progress');
    await repository.updateStatus(completed.request.id, 'completed');
    await expect(
      repository.inviteProvidersToRequest(completed.request.id, [mover.id]),
    ).rejects.toThrow('Request is not open for provider invitations');

    await expect(
      repository.inviteProvidersToRequest(completed.request.id, []),
    ).rejects.toThrow('Provider invitation list is empty');
  });

  it('rejects staff quote proposals while provider opportunities exist', async () => {
    const provider = await createVerifiedProvider(['ac-cleaning']);
    const { request } = await createPendingRequest('ac-cleaning');
    await repository.assignProvider(request.id, provider.id);
    await repository.inviteProvidersToRequest(request.id, [provider.id]);

    await expect(
      repository.proposeQuote(request.id, 12_000, 'عرض من الموظف'),
    ).rejects.toThrow(
      'Request is in the marketplace quote flow; staff quotes are not allowed',
    );
  });

  it('lets a provider submit one quote per opportunity and rejects a duplicate with a domain error', async () => {
    const provider = await createVerifiedProvider(['ac-cleaning']);
    const { request } = await createPendingRequest('ac-cleaning');
    await repository.inviteProvidersToRequest(request.id, [provider.id]);

    const quote = await repository.submitProviderQuote(
      request.id,
      provider.id,
      15_000,
      'تنظيف شامل للمكيفات',
    );
    expect(quote).toMatchObject({
      providerId: provider.id,
      amountHalalas: 15_000,
      status: 'proposed',
    });
    const opportunities = await repository.listProviderOpportunities(
      provider.id,
    );
    expect(opportunities[0].opportunityStatus).toBe('quoted');
    expect(opportunities[0].myQuote?.id).toBe(quote.id);

    await expect(
      repository.submitProviderQuote(
        request.id,
        provider.id,
        9_000,
        'عرض أرخص',
      ),
    ).rejects.toThrow('You already have an active quote for this request');
  });

  it('allows two different providers to each hold an active quote for the same request', async () => {
    const providerA = await createVerifiedProvider(['ac-cleaning']);
    const providerB = await createVerifiedProvider(['ac-cleaning']);
    const { request } = await createPendingRequest('ac-cleaning');
    await repository.inviteProvidersToRequest(request.id, [
      providerA.id,
      providerB.id,
    ]);
    await repository.submitProviderQuote(
      request.id,
      providerA.id,
      15_000,
      'عرض المكيف',
    );
    await repository.submitProviderQuote(
      request.id,
      providerB.id,
      12_000,
      'عرض منافس',
    );
    const viewA = await repository.listProviderOpportunities(providerA.id);
    const viewB = await repository.listProviderOpportunities(providerB.id);
    expect(viewA[0].myQuote?.amountHalalas).toBe(15_000);
    expect(viewB[0].myQuote?.amountHalalas).toBe(12_000);
  });

  it('rejects provider quotes when the request is not pending dispatch, without an opportunity, or while a staff quote is active', async () => {
    const provider = await createVerifiedProvider(['ac-cleaning']);
    const assignedRequest = await createPendingRequest('ac-cleaning');
    await repository.inviteProvidersToRequest(assignedRequest.request.id, [
      provider.id,
    ]);
    await repository.assignProvider(assignedRequest.request.id, provider.id);
    await expect(
      repository.submitProviderQuote(
        assignedRequest.request.id,
        provider.id,
        10_000,
        'عرض',
      ),
    ).rejects.toThrow(
      'Provider quotes are only accepted while the request is pending dispatch',
    );

    // The stranger is created after the request so auto-invite cannot reach
    // it; without an opportunity row, quoting is rejected.
    const { request } = await createPendingRequest('ac-cleaning');
    const stranger = await createVerifiedProvider(['ac-cleaning']);
    await expect(
      repository.submitProviderQuote(request.id, stranger.id, 10_000, 'عرض'),
    ).rejects.toThrow('Provider opportunity is not open for quoting');

    // A fresh provider (created after the request) is not auto-invited, so
    // the probe can insert its opportunity row without a unique conflict.
    const staffRequest = await createPendingRequest('ac-cleaning');
    const staffSectionProvider = await createVerifiedProvider(['ac-cleaning']);
    const probe = new Pool({
      connectionString: resolveDatabaseConnectionString(),
    });
    try {
      const requestDatabaseId =
        Number(staffRequest.request.id.replace('MOE-', '')) - 1000;
      await probe.query(
        `INSERT INTO request_provider_opportunities (service_request_id, provider_id)
         VALUES ($1, $2)`,
        [requestDatabaseId, staffSectionProvider.id],
      );
      await probe.query(
        `INSERT INTO service_quotes (service_request_id, amount_halalas, scope, status)
         VALUES ($1, 9999, 'عرض موظف مباشر', 'proposed')`,
        [requestDatabaseId],
      );
    } finally {
      await probe.end();
    }
    await expect(
      repository.submitProviderQuote(
        staffRequest.request.id,
        staffSectionProvider.id,
        10_000,
        'عرض مقدم',
      ),
    ).rejects.toThrow(
      'Request is in the marketplace quote flow; staff quotes are not allowed',
    );
  });

  it('lets a provider withdraw only their own proposed quote', async () => {
    const providerA = await createVerifiedProvider(['ac-cleaning']);
    const providerB = await createVerifiedProvider(['ac-cleaning']);
    const { request } = await createPendingRequest('ac-cleaning');
    await repository.inviteProvidersToRequest(request.id, [
      providerA.id,
      providerB.id,
    ]);
    const quoteA = await repository.submitProviderQuote(
      request.id,
      providerA.id,
      15_000,
      'عرض أ',
    );
    await repository.submitProviderQuote(
      request.id,
      providerB.id,
      12_000,
      'عرض ب',
    );

    await expect(
      repository.withdrawProviderQuote(quoteA.id, providerB.id),
    ).rejects.toThrow('Pending provider quote not found');

    const withdrawn = await repository.withdrawProviderQuote(
      quoteA.id,
      providerA.id,
    );
    expect(withdrawn.status).toBe('withdrawn');
    const opportunities = await repository.listProviderOpportunities(
      providerA.id,
    );
    expect(opportunities[0].opportunityStatus).toBe('withdrawn');
    expect(opportunities[0].myQuote?.status).toBe('withdrawn');

    await expect(
      repository.withdrawProviderQuote(quoteA.id, providerA.id),
    ).rejects.toThrow('Pending provider quote not found');
  });

  it('approving a provider quote atomically closes competitors and opportunities, assigns the winner, and moves the request to assigned', async () => {
    const winner = await createVerifiedProvider(['ac-cleaning']);
    const loser = await createVerifiedProvider(['ac-cleaning']);
    const { request, customerId } = await createPendingRequest('ac-cleaning');
    await repository.inviteProvidersToRequest(request.id, [
      winner.id,
      loser.id,
    ]);
    const winnerQuote = await repository.submitProviderQuote(
      request.id,
      winner.id,
      15_000,
      'عرض الفائز',
    );
    const loserQuote = await repository.submitProviderQuote(
      request.id,
      loser.id,
      12_000,
      'عرض الخاسر',
    );

    const approved = await repository.decideQuote(
      request.id,
      customerId,
      winnerQuote.id,
      'approved',
    );
    expect(approved).toMatchObject({
      id: winnerQuote.id,
      providerId: winner.id,
      status: 'approved',
    });

    const customerView = await repository.findByCustomerId(customerId);
    const updated = customerView.find((item) => item.id === request.id);
    expect(updated?.status).toBe('assigned');
    expect(updated?.assignedProvider?.id).toBe(winner.id);
    expect(updated?.payment).toMatchObject({
      method: 'cash_on_completion',
      status: 'cash_due',
      amountHalalas: 15_000,
    });

    const loserView = await repository.listProviderOpportunities(loser.id);
    expect(loserView[0].opportunityStatus).toBe('closed');
    expect(loserView[0].myQuote?.id).toBe(loserQuote.id);
    expect(loserView[0].myQuote?.status).toBe('rejected');

    const events = await readEventTypes(request.id);
    expect(events).toContain('quote_approved');
    expect(events).toContain('quote_rejected');
    expect(events).toContain('opportunity_closed');
    expect(events).toContain('provider_assigned');
  });

  it('approval fails safely when the winning provider is not available or verified, with no state changes', async () => {
    for (const degradedStatus of ['suspended', 'pending'] as const) {
      const provider = await createVerifiedProvider(['ac-cleaning']);
      const { request, customerId } = await createPendingRequest('ac-cleaning');
      await repository.inviteProvidersToRequest(request.id, [provider.id]);
      const quote = await repository.submitProviderQuote(
        request.id,
        provider.id,
        15_000,
        'عرض',
      );
      await repository.updatePilotProviderVerification(
        provider.id,
        degradedStatus,
      );

      await expect(
        repository.decideQuote(request.id, customerId, quote.id, 'approved'),
      ).rejects.toThrow(
        'The selected provider is not available; choose another quote',
      );

      const opportunities = await repository.listProviderOpportunities(
        provider.id,
      );
      expect(opportunities[0].opportunityStatus).toBe('quoted');
      expect(opportunities[0].myQuote?.status).toBe('proposed');
      const customerView = await repository.findByCustomerId(customerId);
      const requestView = customerView.find((item) => item.id === request.id);
      expect(requestView?.status).toBe('pending_dispatch');
      expect(requestView?.assignedProvider).toBeUndefined();
      expect(requestView?.payment).toBeUndefined();
      const events = await readEventTypes(request.id);
      expect(events).not.toContain('quote_approved');
      expect(events).not.toContain('provider_assigned');
    }
  });

  it('concurrent approvals of two provider quotes select exactly one winner', async () => {
    const providerA = await createVerifiedProvider(['ac-cleaning']);
    const providerB = await createVerifiedProvider(['ac-cleaning']);
    const { request, customerId } = await createPendingRequest('ac-cleaning');
    await repository.inviteProvidersToRequest(request.id, [
      providerA.id,
      providerB.id,
    ]);
    const quoteA = await repository.submitProviderQuote(
      request.id,
      providerA.id,
      15_000,
      'عرض أ',
    );
    const quoteB = await repository.submitProviderQuote(
      request.id,
      providerB.id,
      12_000,
      'عرض ب',
    );

    const results = await Promise.allSettled([
      repository.decideQuote(request.id, customerId, quoteA.id, 'approved'),
      repository.decideQuote(request.id, customerId, quoteB.id, 'approved'),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);

    const customerView = await repository.findByCustomerId(customerId);
    const requestView = customerView.find((item) => item.id === request.id);
    const winnerId = requestView?.assignedProvider?.id;
    expect([providerA.id, providerB.id]).toContain(winnerId);
    const viewA = await repository.listProviderOpportunities(providerA.id);
    const viewB = await repository.listProviderOpportunities(providerB.id);
    const winnerView = winnerId === providerA.id ? viewA[0] : viewB[0];
    const loserView = winnerId === providerA.id ? viewB[0] : viewA[0];
    expect(winnerView.myQuote?.status).toBe('approved');
    expect(loserView.myQuote?.status).toBe('rejected');
  });

  it('keeps existing staff quote records and old event rows valid after the constraint extensions', async () => {
    // A unique serviceId guarantees no provider can match, so the request
    // has no auto-created opportunities and the staff quote path applies.
    // The provider is created after the request so auto-invite cannot
    // reach it.
    const uniqueServiceId = `staff-legacy-${randomUUID()}`;
    const { request, customerId } = await createPendingRequest(uniqueServiceId);
    const provider = await createVerifiedProvider([uniqueServiceId]);
    await repository.assignProvider(request.id, provider.id);
    const staffQuote = await repository.proposeQuote(
      request.id,
      10_000,
      'عرض الموظف القديم',
    );
    const approved = await repository.decideQuote(
      request.id,
      customerId,
      staffQuote.id,
      'approved',
    );
    expect(approved.status).toBe('approved');
    const customerView = await repository.findByCustomerId(customerId);
    expect(
      customerView.find((item) => item.id === request.id)?.payment,
    ).toMatchObject({ status: 'cash_due' });

    const probe = new Pool({
      connectionString: resolveDatabaseConnectionString(),
    });
    try {
      const requestDatabaseId = Number(request.id.replace('MOE-', '')) - 1000;
      await probe.query(
        `INSERT INTO service_quotes (service_request_id, amount_halalas, scope, status)
         VALUES ($1, 5000, 'عرض قديم مرفوض', 'rejected')`,
        [requestDatabaseId],
      );
      await probe.query(
        `INSERT INTO service_request_events (service_request_id, type, status)
         VALUES ($1, 'quote_proposed', 'assigned')`,
        [requestDatabaseId],
      );
    } finally {
      await probe.end();
    }
    expect(await readEventTypes(request.id)).toContain('quote_proposed');
  });

  it('never exposes address, details, or customer data through provider opportunities', async () => {
    const provider = await createVerifiedProvider(['ac-cleaning']);
    const customer = await repository.upsertCustomer(
      `+9665${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`,
    );
    const request = await repository.create(
      {
        serviceId: 'ac-cleaning',
        address: 'شارع الأمير سلطان، حي الصفراء، بريدة — منزل خاص',
        details: 'معلومات حساسة جدًا مع رقم جوال في الملاحظات',
        timing: 'as-soon-as-possible',
      },
      customer.id,
    );
    await repository.inviteProvidersToRequest(request.id, [provider.id]);

    const opportunities = await repository.listProviderOpportunities(
      provider.id,
    );
    expect(opportunities).toHaveLength(1);
    const opportunity = opportunities[0];
    expect(Object.keys(opportunity).sort()).toEqual([
      'myQuote',
      'opportunityStatus',
      'requestId',
      'serviceId',
      'timing',
    ]);
    const serialized = JSON.stringify(opportunity);
    expect(serialized).not.toContain('شارع الأمير سلطان');
    expect(serialized).not.toContain('معلومات حساسة');
  });
});

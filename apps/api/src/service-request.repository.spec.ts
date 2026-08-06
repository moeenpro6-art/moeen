import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { resolveDatabaseConnectionString } from './database.config';
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

    await expect(historyReader.findRequestEvents(request.id)).resolves.toEqual([
      expect.objectContaining({
        type: 'request_created',
        status: 'pending_dispatch',
      }),
    ]);
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
    const request = await repository.create(
      {
        serviceId: 'plumbing',
        address: 'حي الصفراء، بريدة',
        timing: 'as-soon-as-possible',
      },
      customer.id,
    );
    await repository.assignProvider(request.id, 'provider-3');
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

    await expect(repository.findRequestEvents(request.id)).resolves.toEqual([
      expect.objectContaining({
        type: 'request_created',
        status: 'pending_dispatch',
      }),
      expect.objectContaining({
        type: 'provider_assigned',
        status: 'assigned',
      }),
      expect.objectContaining({ type: 'status_updated', status: 'on_the_way' }),
      expect.objectContaining({
        type: 'status_updated',
        status: 'in_progress',
      }),
      expect.objectContaining({ type: 'status_updated', status: 'completed' }),
    ]);
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
    const request = await repository.create(
      {
        serviceId: 'plumbing',
        address: 'حي الصفراء، بريدة',
        timing: 'as-soon-as-possible',
      },
      customer.id,
    );
    await repository.assignProvider(request.id, 'provider-3');
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
    expect(requests).toContainEqual(created);
  });
});

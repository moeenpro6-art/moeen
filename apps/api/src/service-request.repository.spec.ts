import 'dotenv/config';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { resolveDatabaseConnectionString } from './database.config';
import {
  hashProviderAccessCode,
  providerAccessCodeLookupId,
} from './provider-access-code';
import { ServiceRequestRepository } from './service-request.repository';
import { StaffAuthRepository } from './staff-auth.repository';
import { generateOwnerToken, ownerTokenHash } from './test-db.guard';
import {
  createOwnedSchema,
  dropOwnedSchemaAtomically,
  quoteIdent,
} from '../test/setup/ownership';


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
    // Q0-SEC: the shared-schema LIKE 'PILOT-%' row cleanup is gone. Each test
    // run works inside its own unique schema (moeen_test_<runId>) that
    // global-teardown.ts drops with CASCADE, so no cross-run cleanup is ever
    // needed and no shared data can be touched.
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

  describe('migration CHECK scoping across all four constraints (Q0-SEC regression)', () => {
    // Table-driven, self-contained, parallel-safe: for each of the four
    // migrations the test builds TWO per-invocation schemas (subject +
    // sibling) with Q0-SEC ownership markers. The live run schema's tables
    // and constraints are never touched — no downgrade, no delete, no DROP.
    const runId = process.env.MOEEN_TEST_RUN_ID as string;

    const CASES = [
      {
        table: 'service_quotes',
        constraint: 'service_quotes_status_check',
        column: 'status',
        repository: 'serviceRequest' as const,
        required: ['proposed', 'approved', 'rejected', 'withdrawn'],
        partial: "CHECK (status IN ('proposed', 'approved', 'rejected'))",
        full: "CHECK (status IN ('proposed', 'approved', 'rejected', 'withdrawn'))",
      },
      {
        // The partial constraint already contains opportunity_closed but is
        // missing opportunity_invited, provider_quote_submitted and
        // provider_quote_withdrawn — it must still be repaired (a
        // single-token LIKE guard would skip it).
        table: 'service_request_events',
        constraint: 'service_request_events_type_check',
        column: 'type',
        repository: 'serviceRequest' as const,
        required: [
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
        partial:
          "CHECK (type IN ('request_created', 'provider_assigned', 'status_updated', 'quote_proposed', 'quote_approved', 'quote_rejected', 'opportunity_closed'))",
        full: "CHECK (type IN ('request_created', 'provider_assigned', 'status_updated', 'quote_proposed', 'quote_approved', 'quote_rejected', 'opportunity_invited', 'opportunity_closed', 'provider_quote_submitted', 'provider_quote_withdrawn'))",
      },
      {
        table: 'request_provider_opportunities',
        constraint: 'request_provider_opportunities_status_check',
        column: 'status',
        repository: 'serviceRequest' as const,
        required: ['invited', 'quoted', 'withdrawn', 'closed', 'rejected'],
        partial:
          "CHECK (status IN ('invited', 'quoted', 'withdrawn', 'closed'))",
        full: "CHECK (status IN ('invited', 'quoted', 'withdrawn', 'closed', 'rejected'))",
      },
      {
        table: 'public_auth_rate_limits',
        constraint: 'public_auth_rate_limits_scope_check',
        column: 'scope',
        repository: 'staffAuth' as const,
        required: [
          'customer_otp_request',
          'customer_otp_verification',
          'provider_login',
        ],
        partial:
          "CHECK (scope IN ('customer_otp_request', 'customer_otp_verification'))",
        full: "CHECK (scope IN ('customer_otp_request', 'customer_otp_verification', 'provider_login'))",
      },
    ];

    // Q0-SEC ownership lifecycle is UNIFIED on the shared helpers from
    // test/setup/ownership.ts: CREATE SCHEMA without IF NOT EXISTS, a
    // verifiable marker inside the schema, and no DROP before the marker is
    // proven to match this invocation's run id + owner token (atomically,
    // inside one transaction per schema).

    // A repository instance bound to an explicit schema via its own
    // connection string. The repositories read TEST_DATABASE_URL at
    // construction time only, so the env is re-pointed synchronously for the
    // `new` call and restored immediately — single-threaded JS means nothing
    // else in the process can observe the change and no global state is left
    // behind (the guard never runs against these URLs; they are derived from
    // the already-guarded run URL).
    function repositoryFor<T extends { close(): Promise<void> }>(
      Ctor: new () => T,
      schema: string,
    ): T {
      const originalUrl = process.env.TEST_DATABASE_URL;
      const base = resolveDatabaseConnectionString().split('?')[0];
      process.env.TEST_DATABASE_URL = `${base}?options=${encodeURIComponent(`-c search_path=${schema}`)}`;
      const instance = new Ctor();
      process.env.TEST_DATABASE_URL = originalUrl;
      return instance;
    }

    async function withPool<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
      const pool = new Pool({
        connectionString: resolveDatabaseConnectionString(),
      });
      try {
        return await fn(pool);
      } finally {
        await pool.end();
      }
    }

    async function constraintDef(
      pool: Pool,
      schema: string,
      table: string,
      constraint: string,
    ): Promise<string | null> {
      const res = await pool.query<{ def: string }>(
        `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
         JOIN pg_class rel ON rel.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = rel.relnamespace
         WHERE n.nspname = $1::text
           AND rel.relname = $2::text
           AND c.conname = $3::text`,
        [schema, table, constraint],
      );
      return res.rows[0]?.def ?? null;
    }

    for (const c of CASES) {
      it(`repairs ${c.constraint} in the subject schema while the sibling stays untouched (${c.table})`, async () => {
        // Per-invocation unique names: run id + random suffix, identifier
        // charset [a-z0-9_], well within PostgreSQL's 63-byte limit, so
        // parallel copies of this suite can never collide.
        const subject = `moeen_test_${runId}_x${randomBytes(3).toString('hex')}`;
        const sibling = `moeen_test_${runId}_y${randomBytes(3).toString('hex')}`;
        expect(subject).toMatch(/^[a-z0-9_]{4,63}$/);
        expect(sibling).toMatch(/^[a-z0-9_]{4,63}$/);
        expect(subject).not.toBe(sibling);

        const ownerToken = generateOwnerToken();
        const tokenHash = ownerTokenHash(ownerToken);
        const adminPool = new Pool({
          connectionString: resolveDatabaseConnectionString(),
        });
        const subjectRepo = repositoryFor(ServiceRequestRepository, subject);
        const subjectStaff = repositoryFor(StaffAuthRepository, subject);
        const siblingRepo = repositoryFor(ServiceRequestRepository, sibling);
        const siblingStaff = repositoryFor(StaffAuthRepository, sibling);
        try {
          await createOwnedSchema(adminPool, subject, runId, tokenHash);
          await createOwnedSchema(adminPool, sibling, runId, tokenHash);

          // Full independent baseline in BOTH schemas.
          await subjectRepo.initialize();
          await subjectStaff.initialize();
          await siblingRepo.initialize();
          await siblingStaff.initialize();

          // Explicit empty check on the target table before any downgrade —
          // never rely on test order or prior suite state.
          const rows = await adminPool.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM "${subject}".${c.table}`,
          );
          expect(rows.rows[0].n).toBe(0);

          // Sibling's full definition, captured BEFORE the repair.
          const siblingDefBefore = await constraintDef(
            adminPool,
            sibling,
            c.table,
            c.constraint,
          );
          expect(siblingDefBefore).not.toBeNull();

          // Downgrade ONLY the subject's target constraint to the legacy
          // partial definition.
          await adminPool.query(
            `ALTER TABLE "${subject}".${c.table}
               DROP CONSTRAINT IF EXISTS ${c.constraint},
               ADD CONSTRAINT ${c.constraint} ${c.partial}`,
          );
          const downgraded = await constraintDef(
            adminPool,
            subject,
            c.table,
            c.constraint,
          );
          expect(downgraded).not.toBeNull();
          expect(c.required.every((value) => downgraded!.includes(value))).toBe(
            false,
          );

          // The OTHER three constraints in subject, captured after the
          // downgrade (they must stay untouched by the repair).
          const othersBefore = new Map<string, string | null>();
          for (const other of CASES) {
            if (other.constraint === c.constraint) continue;
            othersBefore.set(
              other.constraint,
              await constraintDef(
                adminPool,
                subject,
                other.table,
                other.constraint,
              ),
            );
          }

          // Repair: initialize() on the SUBJECT only (explicit search_path
          // connection, no global env change).
          await subjectRepo.initialize();
          await subjectStaff.initialize();

          // Subject's target constraint is complete again — every required
          // value present, and the definition matches the sibling's full
          // normalized definition exactly (not merely "exists by name").
          const subjectAfter = await constraintDef(
            adminPool,
            subject,
            c.table,
            c.constraint,
          );
          expect(subjectAfter).not.toBeNull();
          for (const value of c.required) {
            expect(subjectAfter).toContain(value);
          }
          expect(subjectAfter).toBe(siblingDefBefore);

          // No cross-schema modification: the sibling's same-named
          // constraint is literally unchanged...
          expect(
            await constraintDef(adminPool, sibling, c.table, c.constraint),
          ).toBe(siblingDefBefore);

          // ...and the other three constraints in subject are unchanged.
          for (const other of CASES) {
            if (other.constraint === c.constraint) continue;
            expect(
              await constraintDef(
                adminPool,
                subject,
                other.table,
                other.constraint,
              ),
            ).toBe(othersBefore.get(other.constraint));
          }
        } finally {
          // Ownership-verified cleanup — always, even on failure (atomic
          // per-schema transaction with marker proof).
          const client = await adminPool.connect();
          try {
            await dropOwnedSchemaAtomically(client, subject, runId, tokenHash);
            await dropOwnedSchemaAtomically(client, sibling, runId, tokenHash);
          } finally {
            client.release();
            await adminPool.end();
            await subjectRepo.close();
            await subjectStaff.close();
            await siblingRepo.close();
            await siblingStaff.close();
          }
        }
      });
    }

    it('survives concurrent catalog create/drop cycles in unique owned schemas (stress)', async () => {
      const cycles = 6;
      const ownerToken = generateOwnerToken();
      const tokenHash = ownerTokenHash(ownerToken);
      const names = Array.from(
        { length: cycles },
        (_, i) => `moeen_test_${runId}_s${i}_${randomBytes(3).toString('hex')}`,
      );
      await withPool(async (pool) => {
        await Promise.all(
          names.map(async (name) => {
            // Same unified ownership lifecycle as every other temporary
            // schema: plain CREATE, marker inside, atomic verified DROP.
            await createOwnedSchema(pool, name, runId, tokenHash);
            await pool.query(
              `CREATE TABLE ${quoteIdent(name)}.t (
                 id INT PRIMARY KEY,
                 status TEXT NOT NULL
                   CHECK (status IN ('a', 'b', 'c'))
               )`,
            );
            await pool.query(
              `ALTER TABLE ${quoteIdent(name)}.t
                 DROP CONSTRAINT IF EXISTS t_status_check,
                 ADD CONSTRAINT t_status_check
                   CHECK (status IN ('a', 'b', 'c', 'd'))`,
            );
            const client = await pool.connect();
            try {
              await dropOwnedSchemaAtomically(client, name, runId, tokenHash);
            } finally {
              client.release();
            }
          }),
        );
        const leftover = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM information_schema.schemata
           WHERE schema_name = ANY($1)`,
          [names],
        );
        expect(leftover.rows[0].n).toBe(0);
      });
    });

    it('concurrent same-schema initialization is deterministic (serialized inspect/alter)', async () => {
      // ONE owned schema, several independent repository instances racing to
      // initialize it at the same time. Each initializer runs the same
      // CREATE TABLE IF NOT EXISTS / DO-block sequence; the ACCESS EXCLUSIVE
      // table lock taken before every inspect/alter protocol serializes the
      // participants, so the run must complete without errors and leave the
      // full canonical CHECK definitions in place — never a stale-OID
      // deparse failure, never a partial or corrupted constraint.
      const schema = `moeen_test_${runId}_c${randomBytes(3).toString('hex')}`;
      const ownerToken = generateOwnerToken();
      const tokenHash = ownerTokenHash(ownerToken);
      const participants = 4;
      const repos = Array.from({ length: participants }, () => ({
        serviceRequests: repositoryFor(ServiceRequestRepository, schema),
        staffAuth: repositoryFor(StaffAuthRepository, schema),
      }));
      const adminPool = new Pool({
        connectionString: resolveDatabaseConnectionString(),
      });
      try {
        await createOwnedSchema(adminPool, schema, runId, tokenHash);

        // All participants start at the same time; every initialize() must
        // converge on the same final catalog state.
        await Promise.all(
          repos.map(async (r) => {
            await r.serviceRequests.initialize();
            await r.staffAuth.initialize();
          }),
        );

        // Every migrated constraint is the full canonical definition.
        for (const c of CASES) {
          const def = await constraintDef(
            adminPool,
            schema,
            c.table,
            c.constraint,
          );
          expect(def).not.toBeNull();
          for (const value of c.required) {
            expect(def).toContain(value);
          }
        }
      } finally {
        // Ownership-verified cleanup — always, even on failure.
        const client = await adminPool.connect();
        try {
          await dropOwnedSchemaAtomically(client, schema, runId, tokenHash);
        } finally {
          client.release();
          await adminPool.end();
          for (const r of repos) {
            await r.serviceRequests.close();
            await r.staffAuth.close();
          }
        }
      }
    });

    it('fault injection: a thrown error still cleans up, and an unowned schema is never dropped', async () => {
      const owned = `moeen_test_${runId}_f${randomBytes(3).toString('hex')}`;
      const foreign = `moeen_test_${runId}_f${randomBytes(3).toString('hex')}`;
      const ownerToken = generateOwnerToken();
      const tokenHash = ownerTokenHash(ownerToken);
      let fault: unknown = null;
      await withPool(async (pool) => {
        await createOwnedSchema(pool, owned, runId, tokenHash);
        // A schema this invocation does NOT own (no marker).
        await pool.query(`CREATE SCHEMA ${quoteIdent(foreign)}`);
        try {
          try {
            // Deliberate fault after creation, before the test body completes.
            throw new Error('deliberate fault injected mid-test');
          } catch (error) {
            // The deliberate fault is the POINT of this test: capture it so
            // the finally below still runs and the test can prove cleanup
            // happened. Real cleanup errors are never swallowed — they still
            // propagate.
            fault = error;
          } finally {
            // The finally of the fault removes the OWNED schema — cleanup
            // works even when a middle step failed — and PROVES the unowned
            // schema is refused. A real cleanup failure propagates.
            const client = await pool.connect();
            try {
              await dropOwnedSchemaAtomically(client, owned, runId, tokenHash);
              await expect(
                dropOwnedSchemaAtomically(client, foreign, runId, tokenHash),
              ).rejects.toThrow(
                /ownership marker is missing|marker table is not bound to the expected namespace OID/,
              );
            } finally {
              client.release();
            }
          }

          // The fault really happened…
          expect(fault).toBeInstanceOf(Error);
          expect((fault as Error).message).toBe(
            'deliberate fault injected mid-test',
          );
          // …and the finally still removed the OWNED schema…
          const ownedLeft = await pool.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM information_schema.schemata
             WHERE schema_name = $1`,
            [owned],
          );
          expect(ownedLeft.rows[0].n).toBe(0);
          // …while the unowned schema was refused and therefore SURVIVES.
          const foreignLeft = await pool.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM information_schema.schemata
             WHERE schema_name = $1`,
            [foreign],
          );
          expect(foreignLeft.rows[0].n).toBe(1);
        } finally {
          // Independent hygiene finally: remove the foreign schema this test
          // created — exact name only — so even a failed assertion can never
          // leave it behind. (Provably ours: created moments ago here.)
          await pool.query(
            `DROP SCHEMA IF EXISTS ${quoteIdent(foreign)} CASCADE`,
          );
        }
        const leftover = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM information_schema.schemata
           WHERE schema_name = ANY($1)`,
          [[owned, foreign]],
        );
        expect(leftover.rows[0].n).toBe(0);
      });
    });
  });
});

describe('pooled transaction cleanup invariant (Q0-SEC regression)', () => {
  // Deterministic, DB-free regression tests for the fail-safe transaction
  // cleanup: a transaction-scoped pool client must never be released back to
  // the pg pool as healthy while a transaction may be open or aborted. Query
  // failures are scripted per call (1-based) on a fake client, so no real
  // database connection is ever made.

  const scriptedClient = (failAt: Record<number, string>) => {
    const queries: string[] = [];
    const order: string[] = [];
    const client = {
      query: jest.fn((sql: string) => {
        const failMessage = failAt[queries.length + 1];
        queries.push(String(sql));
        order.push(`query:${sql}`);
        if (failMessage !== undefined) throw new Error(failMessage);
        return { rows: [] };
      }),
      release: jest.fn((err?: Error) => {
        order.push(err === undefined ? 'release:clean' : 'release:error');
      }),
    };
    return { client, queries, order };
  };

  const connectSpyFor = (repo: ServiceRequestRepository, client: unknown) => {
    const pool = (repo as unknown as { pool: Pool }).pool;
    return jest.spyOn(pool, 'connect').mockResolvedValue(client as never);
  };

  const repositories: ServiceRequestRepository[] = [];

  afterEach(async () => {
    await Promise.all(repositories.splice(0).map((repo) => repo.close()));
    jest.restoreAllMocks();
  });

  const freshRepository = () => {
    const repo = new ServiceRequestRepository();
    repositories.push(repo);
    return repo;
  };

  it('initialize(): advisory-lock acquisition failure after BEGIN rolls back before releasing the client', async () => {
    const repo = freshRepository();
    const { client, queries, order } = scriptedClient({
      2: 'simulated advisory-lock acquisition failure',
    });
    connectSpyFor(repo, client);

    await expect(repo.initialize()).rejects.toThrow(
      'simulated advisory-lock acquisition failure',
    );

    expect(queries[0]).toBe('BEGIN');
    expect(queries).toContain('ROLLBACK');
    expect(order.indexOf('query:ROLLBACK')).toBeLessThan(
      order.indexOf('release:clean'),
    );
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith();
    expect(order).not.toContain('release:error');
  });

  it('initialize(): rollback failure discards the client via release(error) instead of a healthy release', async () => {
    const repo = freshRepository();
    const { client, order } = scriptedClient({
      2: 'simulated advisory-lock acquisition failure',
      3: 'simulated rollback failure',
    });
    connectSpyFor(repo, client);

    await expect(repo.initialize()).rejects.toThrow(
      'simulated advisory-lock acquisition failure',
    );

    expect(order).toContain('query:ROLLBACK');
    expect(order).toContain('release:error');
    expect(order).not.toContain('release:clean');
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(expect.any(Error));
  });

  it('initialize(): BEGIN failure cannot leak an uncertain transaction state', async () => {
    const repo = freshRepository();
    const { client, queries, order } = scriptedClient({
      1: 'simulated BEGIN failure',
    });
    connectSpyFor(repo, client);

    await expect(repo.initialize()).rejects.toThrow('simulated BEGIN failure');

    expect(queries[0]).toBe('BEGIN');
    // ROLLBACK is still attempted (a harmless no-op outside a transaction),
    // so the connection state is proven clean before the client is released.
    expect(queries).toContain('ROLLBACK');
    expect(order).toContain('release:clean');
    expect(order).not.toContain('release:error');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('initialize(): successful migration transaction commits and releases exactly once', async () => {
    const repo = freshRepository();
    const { client, queries, order } = scriptedClient({});
    connectSpyFor(repo, client);

    await expect(repo.initialize()).resolves.toBeUndefined();

    expect(queries[0]).toBe('BEGIN');
    expect(queries).toContain('COMMIT');
    expect(order.filter((entry) => entry === 'release:clean')).toHaveLength(1);
    expect(order).not.toContain('release:error');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('reserveOtpRequest(): mid-transaction failure rolls back before a clean release', async () => {
    const repo = freshRepository();
    const { client, queries, order } = scriptedClient({
      2: 'simulated advisory-lock acquisition failure',
    });
    connectSpyFor(repo, client);

    await expect(
      repo.reserveOtpRequest('+966****7777', new Date()),
    ).rejects.toThrow('simulated advisory-lock acquisition failure');

    expect(queries[0]).toBe('BEGIN');
    expect(queries).toContain('ROLLBACK');
    expect(order.indexOf('query:ROLLBACK')).toBeLessThan(
      order.indexOf('release:clean'),
    );
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith();
    expect(order).not.toContain('release:error');
  });

  it('reserveOtpRequest(): rollback failure destroys the pooled client', async () => {
    const repo = freshRepository();
    const { client, order } = scriptedClient({
      2: 'simulated advisory-lock acquisition failure',
      3: 'simulated rollback failure',
    });
    connectSpyFor(repo, client);

    await expect(
      repo.reserveOtpRequest('+966****7777', new Date()),
    ).rejects.toThrow('simulated advisory-lock acquisition failure');

    expect(order).toContain('release:error');
    expect(order).not.toContain('release:clean');
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(expect.any(Error));
  });

  it('reserveOtpRequest(): successful transaction path is unchanged', async () => {
    const repo = freshRepository();
    const { client, queries, order } = scriptedClient({});
    connectSpyFor(repo, client);

    await expect(
      repo.reserveOtpRequest('+966****7777', new Date()),
    ).resolves.toBe('accepted');

    expect(queries[0]).toBe('BEGIN');
    expect(queries[queries.length - 1]).toBe('COMMIT');
    expect(order.filter((entry) => entry === 'release:clean')).toHaveLength(1);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

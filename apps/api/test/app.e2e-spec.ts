import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { configureApiSecurity } from './../src/api-security';
import { StaffAuthRepository } from './../src/staff-auth.repository';
import { OTP_PROVIDER, type OtpProvider } from './../src/otp-provider';
import { hashStaffPassword, type StaffRole } from './../src/staff-auth.service';

function responseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected JSON response object');
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  const result = responseObject(value)[field];
  if (typeof result !== 'string') throw new Error(`Expected ${field} string`);
  return result;
}

function hasRequestStatusAuditEvent(
  body: unknown,
  requestId: string,
  oldStatus: string,
  newStatus: string,
): boolean {
  if (!Array.isArray(body)) return false;
  return body.some((value) => {
    const event = responseObject(value);
    return (
      event.action === 'request.status_updated' &&
      event.subjectType === 'service_request' &&
      event.subjectId === requestId &&
      responseObject(event.oldState).status === oldStatus &&
      responseObject(event.newState).status === newStatus
    );
  });
}

async function createStaffAuthorization(
  app: INestApplication<App>,
  role: StaffRole = 'admin',
): Promise<string> {
  const email = `staff-${randomUUID()}@example.test`;
  const password = 'test-only password';
  const repository = app.get(StaffAuthRepository);
  await repository.createStaff({
    email,
    displayName: 'موظف اختبار',
    role,
    passwordHash: await hashStaffPassword(password),
  });
  const response = await request(app.getHttpServer())
    .post('/admin/auth/login')
    .send({ email, password })
    .expect(201);
  return `Bearer ${requiredString(response.body, 'token')}`;
}

async function createProviderAuthorization(
  app: INestApplication<App>,
  specialties: string[],
): Promise<{
  providerId: string;
  name: string;
  authorization: string;
}> {
  const adminAuthorization = await createStaffAuthorization(app, 'admin');
  const created = await request(app.getHttpServer())
    .post('/providers')
    .set('Authorization', adminAuthorization)
    .send({
      name: `مقدم E2E ${randomUUID().slice(0, 8)}`,
      specialties,
      serviceZone: 'بريدة',
    })
    .expect(201);
  const providerId = requiredString(created.body, 'id');
  // Register the ACTUAL id returned by the server (never inferred from any
  // prefix) — only after the 201 confirmed creation succeeded.
  createdProviderIds.add(providerId);
  const name = requiredString(created.body, 'name');
  await request(app.getHttpServer())
    .patch(`/providers/${providerId}/verification`)
    .set('Authorization', adminAuthorization)
    .expect(200);
  const accessCode = `provider-access-${randomUUID()}`;
  await request(app.getHttpServer())
    .post(`/providers/${providerId}/access-code`)
    .set('Authorization', adminAuthorization)
    .send({ accessCode })
    .expect(201);
  const login = await request(app.getHttpServer())
    .post('/provider/auth/login')
    .send({ accessCode })
    .expect(201);
  return {
    providerId,
    name,
    authorization: `Bearer ${requiredString(login.body, 'token')}`,
  };
}

/**
 * Removes ONLY the providers this suite registered (exact ids) plus their
 * dependent rows, in FK-safe order (bottom-up per the actual constraints:
 * service_payments → service_request_events → request_provider_opportunities
 * → service_quotes → service_requests → provider_sessions →
 * provider_access_credentials → providers). Runs inside one transaction;
 * on any error it ROLLBACKs and rethrows. The registered ids are dropped
 * from the set ONLY after COMMIT, so repeated calls are idempotent no-ops.
 * No wildcard or prefix scans, no broad subqueries, no unregistered
 * providers are ever touched.
 */
async function removeCreatedProvidersForLegacyFlow(): Promise<void> {
  if (createdProviderIds.size === 0) return;
  const ids = [...createdProviderIds];
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM service_payments
       WHERE quote_id IN (
         SELECT id FROM service_quotes WHERE provider_id = ANY($1::text[])
       )
          OR service_request_id IN (
         SELECT id FROM service_requests WHERE assigned_provider_id = ANY($1::text[])
       )`,
      [ids],
    );
    await client.query(
      `DELETE FROM service_request_events
       WHERE service_request_id IN (
         SELECT id FROM service_requests WHERE assigned_provider_id = ANY($1::text[])
       )`,
      [ids],
    );
    await client.query(
      `DELETE FROM request_provider_opportunities
       WHERE provider_id = ANY($1::text[])
          OR service_request_id IN (
         SELECT id FROM service_requests WHERE assigned_provider_id = ANY($1::text[])
       )`,
      [ids],
    );
    await client.query(
      `DELETE FROM service_quotes
       WHERE provider_id = ANY($1::text[])
          OR service_request_id IN (
         SELECT id FROM service_requests WHERE assigned_provider_id = ANY($1::text[])
       )`,
      [ids],
    );
    await client.query(
      `DELETE FROM service_requests WHERE assigned_provider_id = ANY($1::text[])`,
      [ids],
    );
    await client.query(
      `DELETE FROM provider_sessions WHERE provider_id = ANY($1::text[])`,
      [ids],
    );
    await client.query(
      `DELETE FROM provider_access_credentials
       WHERE provider_id = ANY($1::text[])`,
      [ids],
    );
    await client.query(`DELETE FROM providers WHERE id = ANY($1::text[])`, [
      ids,
    ]);
    await client.query('COMMIT');
    for (const id of ids) {
      createdProviderIds.delete(id);
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function createCustomerAuthorization(
  app: INestApplication<App>,
): Promise<string> {
  const phone = uniqueTestPhone();
  const otpChallenge = await request(app.getHttpServer())
    .post('/auth/request-otp')
    .send({ phone })
    .expect(201);
  const verified = await request(app.getHttpServer())
    .post('/auth/verify-otp')
    .send({
      challengeId: requiredString(otpChallenge.body, 'challengeId'),
      otp: '123456',
    })
    .expect(201);
  return `Bearer ${requiredString(verified.body, 'token')}`;
}

async function createCustomerServiceRequest(
  app: INestApplication<App>,
  customerAuthorization: string,
): Promise<string> {
  const created = await request(app.getHttpServer())
    .post('/service-requests')
    .set('Authorization', customerAuthorization)
    .send({
      serviceId: 'ac-cleaning',
      address: 'حي الصفراء، بريدة',
      details: 'معلومات حساسة للخصوصية',
      timing: 'as-soon-as-possible',
    })
    .expect(201);
  return requiredString(created.body, 'id');
}

/**
 * Makes a seeded provider (provider-1/2/3) unavailable so automatic
 * invitations skip it. Returns a provider authorization for later use.
 */
async function makeSeededProviderUnavailable(
  app: INestApplication<App>,
  providerId: string,
): Promise<string> {
  const staffAuthorization = await createStaffAuthorization(app, 'admin');
  const accessCode = `provider-access-${randomUUID()}`;
  await request(app.getHttpServer())
    .post(`/providers/${providerId}/access-code`)
    .set('Authorization', staffAuthorization)
    .send({ accessCode })
    .expect(201);
  const login = await request(app.getHttpServer())
    .post('/provider/auth/login')
    .send({ accessCode })
    .expect(201);
  const authorization = `Bearer ${requiredString(login.body, 'token')}`;
  await request(app.getHttpServer())
    .patch('/provider/availability')
    .set('Authorization', authorization)
    .send({ available: false })
    .expect(200);
  return authorization;
}

/**
 * Q0-SEC isolation note for this suite:
 * scripts/with-test-env.js rewrites TEST_DATABASE_URL to the run-unique
 * schema (moeen_test_<runId>) BEFORE jest spawns, and test/setup/
 * setup-test-env.ts only VALIDATES what every worker inherits — it never
 * rewrites anything. Each run starts in a fresh schema and global-teardown.ts
 * drops this run's whole schema with CASCADE.
 *
 * Determinism for the legacy staff-flow tests: providers created through the
 * admin endpoint are assigned PILOT-prefixed ids by the SERVER, and they stay
 * eligible for auto-invite for the rest of the suite. Legacy-flow tests
 * therefore remove exactly the ids THIS suite registered (createdProviderIds)
 * before issuing their request — exact-match parameterized deletes only,
 * never prefix scans and never touching unregistered providers.
 */
const createdProviderIds = new Set<string>();

let nextTestPhoneSuffix = 0;
const testPhoneRunSeed =
  Number.parseInt(randomUUID().replaceAll('-', '').slice(0, 8), 16) %
  100_000_000;

function uniqueTestPhone(): string {
  const suffix = String(
    (testPhoneRunSeed + nextTestPhoneSuffix++) % 100_000_000,
  ).padStart(8, '0');
  return `+9665${suffix}`;
}

describe('AppController (e2e)', () => {
  let app: NestExpressApplication;

  beforeEach(async () => {
    const otpProvider: OtpProvider = {
      startVerification: jest.fn().mockResolvedValue(undefined),
      checkVerification: jest.fn().mockResolvedValue('approved'),
    };
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(OTP_PROVIDER)
      .useValue(otpProvider)
      .compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>();
    const clientIpSeed =
      Number.parseInt(randomUUID().replaceAll('-', '').slice(0, 8), 16) %
      64_516;
    const clientIp = `198.18.${Math.floor(clientIpSeed / 254) + 1}.${
      (clientIpSeed % 254) + 1
    }`;
    app.set('trust proxy', true);
    app.use((request: Request, _response: Response, next: NextFunction) => {
      request.headers['x-forwarded-for'] = clientIp;
      next();
    });
    configureApiSecurity(app);
    await app.init();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Moeen API is running');
  });

  it('GET /health returns an unauthenticated ok status', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok' });
  });

  it('sets baseline security and non-cache headers on API responses', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect((response) => {
        expect(response.headers).toEqual(
          expect.objectContaining({
            'cache-control': 'no-store, private',
            'content-security-policy':
              "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
            'permissions-policy': 'camera=(), geolocation=(), microphone=()',
            'referrer-policy': 'no-referrer',
            'x-content-type-options': 'nosniff',
            'x-frame-options': 'DENY',
          }),
        );
        expect(response.headers['x-powered-by']).toBeUndefined();
      });
  });

  it('/services (GET)', () => {
    return request(app.getHttpServer())
      .get('/services')
      .expect(200)
      .expect([
        { id: 'ac-cleaning', nameAr: 'تنظيف المكيفات' },
        { id: 'upholstery', nameAr: 'غسيل الكنب والمجالس' },
        { id: 'home-cleaning', nameAr: 'تنظيف المنازل' },
        { id: 'tank-cleaning', nameAr: 'تنظيف الخزانات' },
        { id: 'plumbing', nameAr: 'سباكة وتسربات' },
      ]);
  });

  it('revokes the current customer session on logout', async () => {
    const otpChallenge = await request(app.getHttpServer())
      .post('/auth/request-otp')
      .send({ phone: uniqueTestPhone() })
      .expect(201);
    const verified = await request(app.getHttpServer())
      .post('/auth/verify-otp')
      .send({
        challengeId: requiredString(otpChallenge.body, 'challengeId'),
        otp: '123456',
      })
      .expect(201);
    const authorization = `Bearer ${requiredString(verified.body, 'token')}`;

    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', authorization)
      .expect(201);
    await request(app.getHttpServer())
      .get('/my/service-requests')
      .set('Authorization', authorization)
      .expect(401);
  });

  it('rejects a malformed OTP verification payload before reading the challenge', () => {
    return request(app.getHttpServer())
      .post('/auth/verify-otp')
      .send({ challengeId: { unexpected: 'object' }, otp: [] })
      .expect(400);
  });

  it('rejects a malformed staff credential payload before authentication', () => {
    return request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: ['not-an-email'], password: { unexpected: 'object' } })
      .expect(400);
  });

  it('rate limits repeated invalid provider access-code attempts', async () => {
    const invalidAccessCode = `invalid-provider-code-${randomUUID()}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(app.getHttpServer())
        .post('/provider/auth/login')
        .send({ accessCode: invalidAccessCode })
        .expect(401);
    }

    await request(app.getHttpServer())
      .post('/provider/auth/login')
      .send({ accessCode: invalidAccessCode })
      .expect(429);
  }, 60_000);

  it('rejects a malformed provider access-code payload before authentication', () => {
    return request(app.getHttpServer())
      .post('/provider/auth/login')
      .send({ accessCode: { unexpected: 'object' } })
      .expect(400);
  });

  it('rejects a malformed customer service request before persistence', async () => {
    const otpChallenge = await request(app.getHttpServer())
      .post('/auth/request-otp')
      .send({ phone: uniqueTestPhone() })
      .expect(201);
    const verified = await request(app.getHttpServer())
      .post('/auth/verify-otp')
      .send({
        challengeId: requiredString(otpChallenge.body, 'challengeId'),
        otp: '123456',
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/service-requests')
      .set('Authorization', `Bearer ${requiredString(verified.body, 'token')}`)
      .send({
        serviceId: 'unknown-service',
        address: '',
        timing: 'tomorrow',
      })
      .expect(400);
  });

  it('creates and lists only the authenticated customer’s requests', async () => {
    const phone = uniqueTestPhone();
    const otpChallenge = await request(app.getHttpServer())
      .post('/auth/request-otp')
      .send({ phone })
      .expect(201);
    const verified = await request(app.getHttpServer())
      .post('/auth/verify-otp')
      .send({
        challengeId: requiredString(otpChallenge.body, 'challengeId'),
        otp: '123456',
      })
      .expect(201);
    const authorization = `Bearer ${requiredString(verified.body, 'token')}`;

    const created = await request(app.getHttpServer())
      .post('/service-requests')
      .set('Authorization', authorization)
      .send({
        serviceId: 'ac-cleaning',
        address: 'حي الصفراء، بريدة',
        details: 'تنظيف مكيفات',
        timing: 'as-soon-as-possible',
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(
        `/my/service-requests/${requiredString(created.body, 'id')}/support`,
      )
      .set('Authorization', authorization)
      .send({ category: 'quality', comment: 'الخدمة غير مرضية' })
      .expect(201)
      .expect((response) => {
        expect(response.body).toEqual(
          expect.objectContaining({
            requestId: requiredString(created.body, 'id'),
            category: 'quality',
            status: 'open',
          }),
        );
      });

    const staffAuthorization = await createStaffAuthorization(app);
    const requestId = requiredString(created.body, 'id');
    await request(app.getHttpServer())
      .patch(`/service-requests/${requestId}/assignment`)
      .set('Authorization', staffAuthorization)
      .send({ providerId: 'provider-1' })
      .expect(200);
    for (const status of ['on_the_way', 'in_progress', 'completed']) {
      await request(app.getHttpServer())
        .patch(`/service-requests/${requestId}/status`)
        .set('Authorization', staffAuthorization)
        .send({ status })
        .expect(200);
    }

    await request(app.getHttpServer())
      .get('/admin/audit-events')
      .set('Authorization', staffAuthorization)
      .expect(200)
      .expect(({ body }: { body: unknown }) => {
        expect(
          hasRequestStatusAuditEvent(
            body,
            requiredString(created.body, 'id'),
            'in_progress',
            'completed',
          ),
        ).toBe(true);
      });

    await request(app.getHttpServer())
      .post(`/my/service-requests/${requiredString(created.body, 'id')}/rating`)
      .set('Authorization', authorization)
      .send({ rating: 5, comment: 'خدمة ممتازة' })
      .expect(201);

    await request(app.getHttpServer())
      .get('/my/service-requests')
      .set('Authorization', authorization)
      .expect(200)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: requiredString(created.body, 'id'),
              serviceId: 'ac-cleaning',
              rating: 5,
              ratingComment: 'خدمة ممتازة',
            }),
          ]),
        );
      });
  });

  it('requires the customer to approve a quote before the quoted job starts', async () => {
    const phone = uniqueTestPhone();
    const otpChallenge = await request(app.getHttpServer())
      .post('/auth/request-otp')
      .send({ phone })
      .expect(201);
    const verified = await request(app.getHttpServer())
      .post('/auth/verify-otp')
      .send({
        challengeId: requiredString(otpChallenge.body, 'challengeId'),
        otp: '123456',
      })
      .expect(201);
    const customerAuthorization = `Bearer ${requiredString(verified.body, 'token')}`;
    // The legacy staff flow needs a request with no marketplace opportunity:
    // make the seeded ac-cleaning provider unavailable — this run's schema is
    // fresh, so no PILOT providers exist and auto-invite finds nobody.
    await makeSeededProviderUnavailable(app, 'provider-1');
    // Q0-SEC determinism: remove exactly the providers this suite created
    // (exact registered ids) so auto-invite finds nobody for this request.
    await removeCreatedProvidersForLegacyFlow();
    const created = await request(app.getHttpServer())
      .post('/service-requests')
      .set('Authorization', customerAuthorization)
      .send({
        serviceId: 'ac-cleaning',
        address: 'حي الصفراء، بريدة',
        timing: 'as-soon-as-possible',
      })
      .expect(201);
    const requestId = requiredString(created.body, 'id');
    const staffAuthorization = await createStaffAuthorization(
      app,
      'dispatcher',
    );
    // A provider created AFTER the request did not exist at auto-invite time,
    // so the request has no opportunity rows and the staff quote path applies.
    const legacyProvider = await createProviderAuthorization(app, [
      'ac-cleaning',
    ]);

    await request(app.getHttpServer())
      .patch(`/service-requests/${requestId}/assignment`)
      .set('Authorization', staffAuthorization)
      .send({ providerId: legacyProvider.providerId })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/service-requests/${requestId}/status`)
      .set('Authorization', staffAuthorization)
      .send({ status: 'on_the_way' })
      .expect(200);
    const proposed = await request(app.getHttpServer())
      .post(`/service-requests/${requestId}/quotes`)
      .set('Authorization', staffAuthorization)
      .send({ amountHalalas: 15000, scope: 'تنظيف كامل للمكيف' })
      .expect(201);
    const quoteId = requiredString(proposed.body, 'id');

    await request(app.getHttpServer())
      .patch(`/service-requests/${requestId}/status`)
      .set('Authorization', staffAuthorization)
      .send({ status: 'in_progress' })
      .expect(409);
    await request(app.getHttpServer())
      .post(`/my/service-requests/${requestId}/quotes/${quoteId}/decision`)
      .set('Authorization', customerAuthorization)
      .send({ decision: 'approved' })
      .expect(201)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toEqual(
          expect.objectContaining({ id: quoteId, status: 'approved' }),
        );
      });
    await request(app.getHttpServer())
      .patch(`/service-requests/${requestId}/status`)
      .set('Authorization', staffAuthorization)
      .send({ status: 'in_progress' })
      .expect(200);
    await request(app.getHttpServer())
      .get('/my/service-requests')
      .set('Authorization', customerAuthorization)
      .expect(200)
      .expect(({ body }: { body: unknown }) => {
        if (!Array.isArray(body))
          throw new Error('Expected customer request list');
        const customerRequests: unknown[] = body as unknown[];
        const matchingRequest = customerRequests.find(
          (value) => responseObject(value).id === requestId,
        );
        const quote = responseObject(responseObject(matchingRequest).quote);
        expect(quote.id).toBe(quoteId);
        expect(quote.status).toBe('approved');
      });
  });

  it('records cash collection only for a completed approved quote through an authorized staff endpoint', async () => {
    const phone = uniqueTestPhone();
    const otpChallenge = await request(app.getHttpServer())
      .post('/auth/request-otp')
      .send({ phone })
      .expect(201);
    const verified = await request(app.getHttpServer())
      .post('/auth/verify-otp')
      .send({
        challengeId: requiredString(otpChallenge.body, 'challengeId'),
        otp: '123456',
      })
      .expect(201);
    const customerAuthorization = `Bearer ${requiredString(verified.body, 'token')}`;
    // Legacy staff flow: the request must have no marketplace opportunity.
    // Make the seeded plumbing provider unavailable — this run's schema is
    // fresh, so no PILOT providers exist before creating the request.
    await makeSeededProviderUnavailable(app, 'provider-3');
    // Q0-SEC determinism: remove exactly the providers this suite created
    // (exact registered ids) so auto-invite finds nobody for this request.
    await removeCreatedProvidersForLegacyFlow();
    const created = await request(app.getHttpServer())
      .post('/service-requests')
      .set('Authorization', customerAuthorization)
      .send({
        serviceId: 'plumbing',
        address: 'حي الصفراء، بريدة',
        timing: 'as-soon-as-possible',
      })
      .expect(201);
    const requestId = requiredString(created.body, 'id');
    const dispatcherAuthorization = await createStaffAuthorization(
      app,
      'dispatcher',
    );
    // Provider created after the request: no auto-created opportunity, so the
    // legacy staff quote flow applies.
    const legacyProvider = await createProviderAuthorization(app, ['plumbing']);

    await request(app.getHttpServer())
      .patch(`/service-requests/${requestId}/assignment`)
      .set('Authorization', dispatcherAuthorization)
      .send({ providerId: legacyProvider.providerId })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/service-requests/${requestId}/status`)
      .set('Authorization', dispatcherAuthorization)
      .send({ status: 'on_the_way' })
      .expect(200);
    const proposed = await request(app.getHttpServer())
      .post(`/service-requests/${requestId}/quotes`)
      .set('Authorization', dispatcherAuthorization)
      .send({ amountHalalas: 15_000, scope: 'إصلاح تسرب تحت المغسلة' })
      .expect(201);
    await request(app.getHttpServer())
      .post(
        `/my/service-requests/${requestId}/quotes/${requiredString(proposed.body, 'id')}/decision`,
      )
      .set('Authorization', customerAuthorization)
      .send({ decision: 'approved' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/service-requests/${requestId}/payments/cash/collect`)
      .set('Authorization', dispatcherAuthorization)
      .expect(409);
    await request(app.getHttpServer())
      .patch(`/service-requests/${requestId}/status`)
      .set('Authorization', dispatcherAuthorization)
      .send({ status: 'in_progress' })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/service-requests/${requestId}/status`)
      .set('Authorization', dispatcherAuthorization)
      .send({ status: 'completed' })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/service-requests/${requestId}/payments/cash/collect`)
      .set('Authorization', dispatcherAuthorization)
      .expect(201)
      .expect(({ body }: { body: unknown }) => {
        expect(responseObject(body)).toEqual(
          expect.objectContaining({
            method: 'cash_on_completion',
            status: 'cash_collected',
            amountHalalas: 15_000,
            currency: 'SAR',
          }),
        );
      });
    await request(app.getHttpServer())
      .get('/my/service-requests')
      .set('Authorization', customerAuthorization)
      .expect(200)
      .expect(({ body }: { body: unknown }) => {
        if (!Array.isArray(body))
          throw new Error('Expected customer request list');
        const customerRequests: unknown[] = body as unknown[];
        const matching = customerRequests.find(
          (value) => responseObject(value).id === requestId,
        );
        expect(responseObject(matching).payment).toEqual(
          expect.objectContaining({ status: 'cash_collected' }),
        );
      });
    const supportAuthorization = await createStaffAuthorization(
      app,
      'support_agent',
    );
    await request(app.getHttpServer())
      .post(`/service-requests/${requestId}/payments/cash/refund`)
      .set('Authorization', supportAuthorization)
      .expect(403);
    const adminAuthorization = await createStaffAuthorization(app, 'admin');
    await request(app.getHttpServer())
      .post(`/service-requests/${requestId}/payments/cash/refund`)
      .set('Authorization', adminAuthorization)
      .expect(201)
      .expect(({ body }: { body: unknown }) => {
        expect(responseObject(body)).toEqual(
          expect.objectContaining({
            method: 'cash_on_completion',
            status: 'refunded',
            amountHalalas: 15_000,
          }),
        );
      });
    await request(app.getHttpServer())
      .post(`/service-requests/${requestId}/payments/cash/refund`)
      .set('Authorization', adminAuthorization)
      .expect(409);
  });

  it('lets a signed-in provider see only assigned jobs and advance an approved job', async () => {
    const phone = uniqueTestPhone();
    const otpChallenge = await request(app.getHttpServer())
      .post('/auth/request-otp')
      .send({ phone })
      .expect(201);
    const verified = await request(app.getHttpServer())
      .post('/auth/verify-otp')
      .send({
        challengeId: requiredString(otpChallenge.body, 'challengeId'),
        otp: '123456',
      })
      .expect(201);
    const customerAuthorization = `Bearer ${requiredString(verified.body, 'token')}`;
    // Legacy staff flow: both requests must have no marketplace
    // opportunities. Disable the seeded providers for ac-cleaning and
    // plumbing — this run's schema is fresh, so no PILOT providers exist.
    await makeSeededProviderUnavailable(app, 'provider-1');
    await makeSeededProviderUnavailable(app, 'provider-3');
    // Q0-SEC determinism: remove exactly the providers this suite created
    // (exact registered ids) so auto-invite finds nobody for these requests.
    await removeCreatedProvidersForLegacyFlow();
    const ownRequest = await request(app.getHttpServer())
      .post('/service-requests')
      .set('Authorization', customerAuthorization)
      .send({
        serviceId: 'ac-cleaning',
        address: 'حي الصفراء، بريدة',
        timing: 'as-soon-as-possible',
      })
      .expect(201);
    const otherRequest = await request(app.getHttpServer())
      .post('/service-requests')
      .set('Authorization', customerAuthorization)
      .send({
        serviceId: 'plumbing',
        address: 'حي النهضة، بريدة',
        timing: 'as-soon-as-possible',
      })
      .expect(201);
    const ownRequestId = requiredString(ownRequest.body, 'id');
    const otherRequestId = requiredString(otherRequest.body, 'id');
    const staffAuthorization = await createStaffAuthorization(app);
    // Fresh providers created after the requests: no auto-created
    // opportunities, so the legacy staff assignment/quote flow applies.
    const ownProvider = await createProviderAuthorization(app, ['ac-cleaning']);
    const otherProvider = await createProviderAuthorization(app, ['plumbing']);

    await request(app.getHttpServer())
      .patch(`/service-requests/${ownRequestId}/assignment`)
      .set('Authorization', staffAuthorization)
      .send({ providerId: ownProvider.providerId })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/service-requests/${otherRequestId}/assignment`)
      .set('Authorization', staffAuthorization)
      .send({ providerId: otherProvider.providerId })
      .expect(200);

    // ownProvider was created (and logged in) via createProviderAuthorization
    // after the requests, so its session token is already available.
    const providerAuthorization = ownProvider.authorization;

    await request(app.getHttpServer())
      .get('/provider/service-requests')
      .set('Authorization', providerAuthorization)
      .expect(200)
      .expect(({ body }: { body: unknown }) => {
        if (!Array.isArray(body)) throw new Error('Expected provider job list');
        const providerJobs: unknown[] = body as unknown[];
        expect(
          providerJobs.some((job) => responseObject(job).id === ownRequestId),
        ).toBe(true);
        expect(
          providerJobs.some((job) => responseObject(job).id === otherRequestId),
        ).toBe(false);
      });
    await request(app.getHttpServer())
      .patch(`/provider/service-requests/${otherRequestId}/status`)
      .set('Authorization', providerAuthorization)
      .send({ status: 'on_the_way' })
      .expect(404);
    await request(app.getHttpServer())
      .patch(`/provider/service-requests/${ownRequestId}/status`)
      .set('Authorization', providerAuthorization)
      .send({ status: 'on_the_way' })
      .expect(200);

    const proposed = await request(app.getHttpServer())
      .post(`/service-requests/${ownRequestId}/quotes`)
      .set('Authorization', staffAuthorization)
      .send({ amountHalalas: 15000, scope: 'تنظيف كامل للمكيف' })
      .expect(201);
    const quoteId = requiredString(proposed.body, 'id');
    await request(app.getHttpServer())
      .patch(`/provider/service-requests/${ownRequestId}/status`)
      .set('Authorization', providerAuthorization)
      .send({ status: 'in_progress' })
      .expect(409);
    await request(app.getHttpServer())
      .post(`/my/service-requests/${ownRequestId}/quotes/${quoteId}/decision`)
      .set('Authorization', customerAuthorization)
      .send({ decision: 'approved' })
      .expect(201);
    await request(app.getHttpServer())
      .patch(`/provider/service-requests/${ownRequestId}/status`)
      .set('Authorization', providerAuthorization)
      .send({ status: 'in_progress' })
      .expect(200);
    await request(app.getHttpServer())
      .patch('/provider/availability')
      .set('Authorization', providerAuthorization)
      .send({ available: false })
      .expect(200)
      .expect(({ body }: { body: unknown }) => {
        expect(responseObject(body).available).toBe(false);
      });
    await request(app.getHttpServer())
      .patch('/provider/availability')
      .set('Authorization', providerAuthorization)
      .send({ available: true })
      .expect(200);
  });

  it('rejects rotating with an access code already used by another provider', async () => {
    const staffAuthorization = await createStaffAuthorization(app);
    const sharedCode = `shared-access-${randomUUID()}`;
    await request(app.getHttpServer())
      .post('/providers/provider-1/access-code')
      .set('Authorization', staffAuthorization)
      .send({ accessCode: sharedCode })
      .expect(201);
    await request(app.getHttpServer())
      .post('/providers/provider-2/access-code')
      .set('Authorization', staffAuthorization)
      .send({ accessCode: sharedCode })
      .expect(409);
    // The rejected rotation changed nothing: provider-2 can still rotate
    // with a fresh code and authenticate with it.
    const freshCode = `fresh-access-${randomUUID()}`;
    await request(app.getHttpServer())
      .post('/providers/provider-2/access-code')
      .set('Authorization', staffAuthorization)
      .send({ accessCode: freshCode })
      .expect(201);
    const providerLogin = await request(app.getHttpServer())
      .post('/provider/auth/login')
      .send({ accessCode: freshCode })
      .expect(201);
    const provider = responseObject(providerLogin.body).provider as {
      id: string;
    };
    expect(provider.id).toBe('provider-2');
  });

  it('rejects a too-short provider access code with 400', async () => {
    const staffAuthorization = await createStaffAuthorization(app);
    await request(app.getHttpServer())
      .post('/providers/provider-1/access-code')
      .set('Authorization', staffAuthorization)
      .send({ accessCode: 'short-code' })
      .expect(400);
  });

  it('returns 404 when rotating the access code of an unknown provider', async () => {
    const staffAuthorization = await createStaffAuthorization(app);
    await request(app.getHttpServer())
      .post('/providers/provider-does-not-exist/access-code')
      .set('Authorization', staffAuthorization)
      .send({ accessCode: `provider-access-${randomUUID()}` })
      .expect(404);
  });

  it('rotating a provider access code invalidates the previous provider session', async () => {
    const staffAuthorization = await createStaffAuthorization(app);
    const oldCode = `provider-access-${randomUUID()}`;
    const newCode = `provider-access-${randomUUID()}`;
    await request(app.getHttpServer())
      .post('/providers/provider-1/access-code')
      .set('Authorization', staffAuthorization)
      .send({ accessCode: oldCode })
      .expect(201);
    const oldLogin = await request(app.getHttpServer())
      .post('/provider/auth/login')
      .send({ accessCode: oldCode })
      .expect(201);
    const oldSessionToken = requiredString(oldLogin.body, 'token');

    await request(app.getHttpServer())
      .post('/providers/provider-1/access-code')
      .set('Authorization', staffAuthorization)
      .send({ accessCode: newCode })
      .expect(201);

    // The session issued under the old code is invalidated.
    await request(app.getHttpServer())
      .get('/provider/auth/me')
      .set('Authorization', `Bearer ${oldSessionToken}`)
      .expect(401);
    // The new code authenticates.
    await request(app.getHttpServer())
      .post('/provider/auth/login')
      .send({ accessCode: newCode })
      .expect(201);
  });

  it('returns a role-safe profile and revokes a logged-out staff session', async () => {
    const authorization = await createStaffAuthorization(app, 'dispatcher');

    await request(app.getHttpServer())
      .get('/admin/auth/me')
      .set('Authorization', authorization)
      .expect(200)
      .expect(({ body }: { body: unknown }) => {
        const staff = responseObject(body);
        expect(typeof staff.id).toBe('string');
        expect(typeof staff.email).toBe('string');
        expect(staff.displayName).toBe('موظف اختبار');
        expect(staff.role).toBe('dispatcher');
        expect(staff).not.toHaveProperty('passwordHash');
      });

    await request(app.getHttpServer())
      .post('/admin/auth/logout')
      .set('Authorization', authorization)
      .expect(201);
    await request(app.getHttpServer())
      .get('/admin/auth/me')
      .set('Authorization', authorization)
      .expect(401);
  });

  it('enforces least-privilege roles for staff operations', async () => {
    const dispatcher = await createStaffAuthorization(app, 'dispatcher');
    const supportAgent = await createStaffAuthorization(app, 'support_agent');

    await request(app.getHttpServer())
      .get('/service-requests')
      .set('Authorization', dispatcher)
      .expect(200);
    await request(app.getHttpServer())
      .get('/support-tickets')
      .set('Authorization', dispatcher)
      .expect(403);
    await request(app.getHttpServer())
      .get('/support-tickets')
      .set('Authorization', supportAgent)
      .expect(200);
    await request(app.getHttpServer())
      .get('/providers')
      .set('Authorization', supportAgent)
      .expect(403);
    await request(app.getHttpServer())
      .get('/admin/audit-events')
      .set('Authorization', supportAgent)
      .expect(403);
  });

  it('rejects anonymous access to internal operations endpoints', async () => {
    await request(app.getHttpServer()).get('/service-requests').expect(401);
    await request(app.getHttpServer()).get('/providers').expect(401);
    await request(app.getHttpServer()).get('/support-tickets').expect(401);
  });

  it('rate limits OTP sends across rotating phones from the same client address', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await request(app.getHttpServer())
        .post('/auth/request-otp')
        .send({ phone: uniqueTestPhone() })
        .expect(201);
    }

    await request(app.getHttpServer())
      .post('/auth/request-otp')
      .send({ phone: uniqueTestPhone() })
      .expect(429);
  });

  it('rejects customer requests without a bearer token', () => {
    return request(app.getHttpServer()).get('/my/service-requests').expect(401);
  });

  it('lets staff invite eligible providers and keeps provider opportunities privacy-safe', async () => {
    const customerAuthorization = await createCustomerAuthorization(app);
    const requestId = await createCustomerServiceRequest(
      app,
      customerAuthorization,
    );
    const providerA = await createProviderAuthorization(app, ['ac-cleaning']);
    const providerB = await createProviderAuthorization(app, ['ac-cleaning']);
    const dispatcherAuthorization = await createStaffAuthorization(
      app,
      'dispatcher',
    );

    await request(app.getHttpServer())
      .post(`/service-requests/${requestId}/opportunities`)
      .set('Authorization', dispatcherAuthorization)
      .send({ providerIds: [providerA.providerId, providerB.providerId] })
      .expect(201);

    const supportAuthorization = await createStaffAuthorization(
      app,
      'support_agent',
    );
    await request(app.getHttpServer())
      .post(`/service-requests/${requestId}/opportunities`)
      .set('Authorization', supportAuthorization)
      .send({ providerIds: [providerA.providerId] })
      .expect(403);
    await request(app.getHttpServer())
      .get('/provider/opportunities')
      .expect(401);

    const opportunities = await request(app.getHttpServer())
      .get('/provider/opportunities')
      .set('Authorization', providerA.authorization)
      .expect(200);
    const body = opportunities.body as Record<string, unknown>[];
    expect(body).toHaveLength(1);
    expect(Object.keys(body[0]).sort()).toEqual([
      'opportunityStatus',
      'requestId',
      'serviceId',
      'timing',
    ]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('حي الصفراء');
    expect(serialized).not.toContain('معلومات حساسة');
  });

  it('auto-invites eligible verified/available providers when a customer creates a request', async () => {
    // Eligible provider exists BEFORE the request is created.
    const eligible = await createProviderAuthorization(app, ['ac-cleaning']);
    const customerAuthorization = await createCustomerAuthorization(app);
    const requestId = await createCustomerServiceRequest(
      app,
      customerAuthorization,
    );

    const opportunities = await request(app.getHttpServer())
      .get('/provider/opportunities')
      .set('Authorization', eligible.authorization)
      .expect(200);
    const body = opportunities.body as Record<string, unknown>[];
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      requestId,
      serviceId: 'ac-cleaning',
      opportunityStatus: 'invited',
    });
    // Privacy: no address, customer identity, phone, or details leaked.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('حي الصفراء');
    expect(serialized).not.toContain('معلومات حساسة');
  });

  it('excludes unverified, unavailable, and non-matching providers from automatic invitations', async () => {
    const adminAuthorization = await createStaffAuthorization(app, 'admin');
    // Unverified provider (no verification patch applied).
    const unverified = await request(app.getHttpServer())
      .post('/providers')
      .set('Authorization', adminAuthorization)
      .send({
        name: `مقدم غير موثق ${randomUUID().slice(0, 8)}`,
        specialties: ['ac-cleaning'],
        serviceZone: 'بريدة',
      })
      .expect(201);
    const unverifiedId = requiredString(unverified.body, 'id');
    // Unavailable provider (created verified, then set unavailable).
    const unavailableProvider = await createProviderAuthorization(app, [
      'ac-cleaning',
    ]);
    // Set unavailable through the provider's own session (the admin-side
    // /providers/:id/availability route does not exist).
    await request(app.getHttpServer())
      .patch('/provider/availability')
      .set('Authorization', unavailableProvider.authorization)
      .send({ available: false })
      .expect(200);
    // Non-matching provider (different specialty).
    await createProviderAuthorization(app, ['plumbing']);
    // Eligible provider must exist BEFORE the request is created.
    const eligible = await createProviderAuthorization(app, ['ac-cleaning']);

    const customerAuthorization = await createCustomerAuthorization(app);
    const requestId = await createCustomerServiceRequest(
      app,
      customerAuthorization,
    );

    // The eligible (verified + available + matching) provider sees the
    // auto-created opportunity.
    const eligibleView = await request(app.getHttpServer())
      .get('/provider/opportunities')
      .set('Authorization', eligible.authorization)
      .expect(200);
    const eligibleItems = eligibleView.body as Record<string, unknown>[];
    expect(eligibleItems).toHaveLength(1);
    expect(eligibleItems[0]).toMatchObject({
      requestId,
      serviceId: 'ac-cleaning',
      opportunityStatus: 'invited',
    });
    // The unavailable provider still has a session; its listing must not
    // contain the new request (auto-invite skipped it).
    const unavailableView = await request(app.getHttpServer())
      .get('/provider/opportunities')
      .set('Authorization', unavailableProvider.authorization)
      .expect(200);
    const unavailableBody = unavailableView.body as Record<string, unknown>[];
    expect(unavailableBody.some((item) => item.requestId === requestId)).toBe(
      false,
    );
    // The unverified provider cannot log in (no session), so it can never
    // see the request; confirm its id is not referenced anywhere customer-
    // visible by checking the customer's request history has no provider id.
    const history = await request(app.getHttpServer())
      .get(`/my/service-requests/${requestId}/history`)
      .set('Authorization', customerAuthorization)
      .expect(200);
    expect(JSON.stringify(history.body)).not.toContain(unverifiedId);
  });

  it('request creation succeeds with zero eligible providers and stays pending_dispatch', async () => {
    // Make the seeded ac-cleaning provider unavailable so no eligible
    // provider remains for this service; the request must still succeed.
    await makeSeededProviderUnavailable(app, 'provider-1');
    // Q0-SEC determinism: remove exactly the providers this suite created
    // (exact registered ids) so zero eligible providers remain.
    await removeCreatedProvidersForLegacyFlow();
    const customerAuthorization = await createCustomerAuthorization(app);
    const created = await request(app.getHttpServer())
      .post('/service-requests')
      .set('Authorization', customerAuthorization)
      .send({
        serviceId: 'ac-cleaning',
        address: 'حي الصفراء، بريدة',
        details: 'معلومات حساسة للخصوصية',
        timing: 'as-soon-as-possible',
      })
      .expect(201);
    const requestId = requiredString(created.body, 'id');
    expect(created.body).toMatchObject({ status: 'pending_dispatch' });
    // The provider-1 session sees no opportunity for this request.
    const providerAuthorization = await makeSeededProviderUnavailable(
      app,
      'provider-1',
    );
    const view = await request(app.getHttpServer())
      .get('/provider/opportunities')
      .set('Authorization', providerAuthorization)
      .expect(200);
    const body = view.body as Record<string, unknown>[];
    expect(body.some((item) => item.requestId === requestId)).toBe(false);
  });

  it('automatic plus manual invitation does not duplicate opportunities or events', async () => {
    // This run's schema is fresh, so the baseline auto-invite count is
    // deterministic (seeded provider-1 + the single eligible provider created
    // below) — no PILOT leftovers exist.
    const eligible = await createProviderAuthorization(app, ['ac-cleaning']);
    const customerAuthorization = await createCustomerAuthorization(app);
    const requestId = await createCustomerServiceRequest(
      app,
      customerAuthorization,
    );

    // Baseline events after automatic invitation.
    const baselineEvents = await request(app.getHttpServer())
      .get(`/my/service-requests/${requestId}/history`)
      .set('Authorization', customerAuthorization)
      .expect(200);
    const baselineTypes = (baselineEvents.body as Record<string, string>[]).map(
      (e) => e.type,
    );
    const baselineInviteCount = baselineTypes.filter(
      (t) => t === 'opportunity_invited',
    ).length;
    expect(baselineInviteCount).toBeGreaterThanOrEqual(1);

    // Manual re-invite of the already auto-invited provider: no duplicate.
    const dispatcherAuthorization = await createStaffAuthorization(
      app,
      'dispatcher',
    );
    const manual = await request(app.getHttpServer())
      .post(`/service-requests/${requestId}/opportunities`)
      .set('Authorization', dispatcherAuthorization)
      .send({ providerIds: [eligible.providerId] })
      .expect(201);
    expect(manual.body).toHaveLength(0);

    // Events unchanged after the no-op manual invitation.
    const afterEvents = await request(app.getHttpServer())
      .get(`/my/service-requests/${requestId}/history`)
      .set('Authorization', customerAuthorization)
      .expect(200);
    const afterInviteCount = (afterEvents.body as Record<string, string>[])
      .map((e) => e.type)
      .filter((t) => t === 'opportunity_invited').length;
    expect(afterInviteCount).toBe(baselineInviteCount);

    // Exactly one opportunity for the eligible provider on this request.
    const providerView = await request(app.getHttpServer())
      .get('/provider/opportunities')
      .set('Authorization', eligible.authorization)
      .expect(200);
    const matches = (providerView.body as Record<string, unknown>[]).filter(
      (item) => item.requestId === requestId,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      serviceId: 'ac-cleaning',
      opportunityStatus: 'invited',
    });

    // Privacy: events expose no provider identity or address.
    const serialized = JSON.stringify(afterEvents.body);
    expect(serialized).not.toContain('حي الصفراء');
    expect(serialized).not.toContain(eligible.providerId);
  });

  it('rejects staff quote creation with 409 when marketplace opportunities exist', async () => {
    // An eligible provider exists before the request → auto-invited →
    // marketplace opportunity exists. Assign a provider to advance the
    // request to a state where quotes are allowed, then confirm staff quote
    // is blocked with 409 because opportunities exist. (This run's schema is
    // fresh — no PILOT providers exist.)
    const eligible = await createProviderAuthorization(app, ['ac-cleaning']);
    const customerAuthorization = await createCustomerAuthorization(app);
    const requestId = await createCustomerServiceRequest(
      app,
      customerAuthorization,
    );
    const staffAuthorization = await createStaffAuthorization(
      app,
      'dispatcher',
    );
    await request(app.getHttpServer())
      .patch(`/service-requests/${requestId}/assignment`)
      .set('Authorization', staffAuthorization)
      .send({ providerId: eligible.providerId })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/service-requests/${requestId}/status`)
      .set('Authorization', staffAuthorization)
      .send({ status: 'on_the_way' })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/service-requests/${requestId}/quotes`)
      .set('Authorization', staffAuthorization)
      .send({ amountHalalas: 10000, scope: 'عرض موظف مرفوض' });

    expect(res.status).toBe(409);
    const resBody = res.body as { message?: string };
    expect(resBody.message).toContain('marketplace');
    // The request state is unchanged: still on_the_way, no staff quote.
    const view = await request(app.getHttpServer())
      .get('/my/service-requests')
      .set('Authorization', customerAuthorization)
      .expect(200);
    const myRequest = (view.body as Record<string, unknown>[]).find(
      (item) => item.id === requestId,
    ) as Record<string, unknown>;
    expect(myRequest.status).toBe('on_the_way');
    expect(myRequest.quote).toBeUndefined();
  });

  it('quote flow works from automatic invitation through provider opportunity listing', async () => {
    const eligible = await createProviderAuthorization(app, ['ac-cleaning']);
    const customerAuthorization = await createCustomerAuthorization(app);
    const requestId = await createCustomerServiceRequest(
      app,
      customerAuthorization,
    );

    const quote = await request(app.getHttpServer())
      .post(`/provider/opportunities/${requestId}/quotes`)
      .set('Authorization', eligible.authorization)
      .send({ amountHalalas: 15000, scope: 'تنظيف شامل للمكيفات' })
      .expect(201);
    expect(quote.body).toMatchObject({
      status: 'proposed',
      amountHalalas: 15000,
    });

    const opportunities = await request(app.getHttpServer())
      .get('/provider/opportunities')
      .set('Authorization', eligible.authorization)
      .expect(200);
    const body = opportunities.body as Record<string, unknown>[];
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      requestId,
      serviceId: 'ac-cleaning',
      opportunityStatus: 'quoted',
    });
    expect((body[0] as { myQuote?: { status: string } }).myQuote).toMatchObject(
      {
        status: 'proposed',
        amountHalalas: 15000,
      },
    );
  });

  it('rejects invalid provider invitation inputs and deduplicates ids', async () => {
    const customerAuthorization = await createCustomerAuthorization(app);
    const requestId = await createCustomerServiceRequest(
      app,
      customerAuthorization,
    );
    const dispatcherAuthorization = await createStaffAuthorization(
      app,
      'dispatcher',
    );
    const provider = await createProviderAuthorization(app, ['ac-cleaning']);

    await request(app.getHttpServer())
      .post(`/service-requests/${requestId}/opportunities`)
      .set('Authorization', dispatcherAuthorization)
      .send({ providerIds: [] })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/service-requests/${requestId}/opportunities`)
      .set('Authorization', dispatcherAuthorization)
      .send({ providerIds: 'provider-1' })
      .expect(400);
    const invited = await request(app.getHttpServer())
      .post(`/service-requests/${requestId}/opportunities`)
      .set('Authorization', dispatcherAuthorization)
      .send({ providerIds: [provider.providerId, provider.providerId] })
      .expect(201);
    expect(invited.body).toHaveLength(1);
  });

  it('lets an invited provider submit one quote and rejects duplicates, strangers, and malformed amounts', async () => {
    const customerAuthorization = await createCustomerAuthorization(app);
    const requestId = await createCustomerServiceRequest(
      app,
      customerAuthorization,
    );
    const dispatcherAuthorization = await createStaffAuthorization(
      app,
      'dispatcher',
    );
    const provider = await createProviderAuthorization(app, ['ac-cleaning']);
    const stranger = await createProviderAuthorization(app, ['ac-cleaning']);
    await request(app.getHttpServer())
      .post(`/service-requests/${requestId}/opportunities`)
      .set('Authorization', dispatcherAuthorization)
      .send({ providerIds: [provider.providerId] })
      .expect(201);

    const quote = await request(app.getHttpServer())
      .post(`/provider/opportunities/${requestId}/quotes`)
      .set('Authorization', provider.authorization)
      .send({ amountHalalas: 15000, scope: 'تنظيف شامل للمكيفات' })
      .expect(201);
    expect(quote.body).toEqual(
      expect.objectContaining({
        providerId: provider.providerId,
        status: 'proposed',
      }),
    );

    await request(app.getHttpServer())
      .post(`/provider/opportunities/${requestId}/quotes`)
      .set('Authorization', provider.authorization)
      .send({ amountHalalas: 9000, scope: 'عرض أرخص' })
      .expect(409);
    await request(app.getHttpServer())
      .post(`/provider/opportunities/${requestId}/quotes`)
      .set('Authorization', stranger.authorization)
      .send({ amountHalalas: 9000, scope: 'عرض غريب' })
      .expect(409);
    await request(app.getHttpServer())
      .post(`/provider/opportunities/${requestId}/quotes`)
      .set('Authorization', provider.authorization)
      .send({ amountHalalas: -5, scope: 'تنظيف' })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/provider/opportunities/${requestId}/quotes`)
      .set('Authorization', provider.authorization)
      .send({ amountHalalas: 15000, scope: '' })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/provider/opportunities/${requestId}/quotes`)
      .set('Authorization', provider.authorization)
      .send({ amountHalalas: Number.MAX_SAFE_INTEGER + 1, scope: 'تنظيف' })
      .expect(400);
  });

  it('withdraws only the provider own proposed quote and returns a generic 404 otherwise', async () => {
    const customerAuthorization = await createCustomerAuthorization(app);
    const requestId = await createCustomerServiceRequest(
      app,
      customerAuthorization,
    );
    const dispatcherAuthorization = await createStaffAuthorization(
      app,
      'dispatcher',
    );
    const providerA = await createProviderAuthorization(app, ['ac-cleaning']);
    const providerB = await createProviderAuthorization(app, ['ac-cleaning']);
    await request(app.getHttpServer())
      .post(`/service-requests/${requestId}/opportunities`)
      .set('Authorization', dispatcherAuthorization)
      .send({ providerIds: [providerA.providerId, providerB.providerId] })
      .expect(201);
    const quoteA = await request(app.getHttpServer())
      .post(`/provider/opportunities/${requestId}/quotes`)
      .set('Authorization', providerA.authorization)
      .send({ amountHalalas: 15000, scope: 'عرض أ' })
      .expect(201);
    const quoteB = await request(app.getHttpServer())
      .post(`/provider/opportunities/${requestId}/quotes`)
      .set('Authorization', providerB.authorization)
      .send({ amountHalalas: 12000, scope: 'عرض ب' })
      .expect(201);
    const quoteAId = requiredString(quoteA.body, 'id');
    const quoteBId = requiredString(quoteB.body, 'id');

    await request(app.getHttpServer())
      .post(`/provider/quotes/${quoteAId}/withdraw`)
      .set('Authorization', providerA.authorization)
      .expect(201)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toEqual(
          expect.objectContaining({ id: quoteAId, status: 'withdrawn' }),
        );
      });

    await request(app.getHttpServer())
      .post(`/provider/quotes/${quoteAId}/withdraw`)
      .set('Authorization', providerA.authorization)
      .expect(404)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toEqual(
          expect.objectContaining({
            message: 'Quote is not available for withdrawal',
          }),
        );
      });
    await request(app.getHttpServer())
      .post(`/provider/quotes/${quoteAId}/withdraw`)
      .set('Authorization', providerB.authorization)
      .expect(404);
    await request(app.getHttpServer())
      .post(`/provider/quotes/${quoteBId}/withdraw`)
      .set('Authorization', providerB.authorization)
      .expect(201);
  });

  it('lets the customer see all provider quotes and approve exactly one, closing competitors', async () => {
    const customerAuthorization = await createCustomerAuthorization(app);
    const requestId = await createCustomerServiceRequest(
      app,
      customerAuthorization,
    );
    const dispatcherAuthorization = await createStaffAuthorization(
      app,
      'dispatcher',
    );
    const providerA = await createProviderAuthorization(app, ['ac-cleaning']);
    const providerB = await createProviderAuthorization(app, ['ac-cleaning']);
    await request(app.getHttpServer())
      .post(`/service-requests/${requestId}/opportunities`)
      .set('Authorization', dispatcherAuthorization)
      .send({ providerIds: [providerA.providerId, providerB.providerId] })
      .expect(201);
    const quoteA = await request(app.getHttpServer())
      .post(`/provider/opportunities/${requestId}/quotes`)
      .set('Authorization', providerA.authorization)
      .send({ amountHalalas: 15000, scope: 'عرض الفائز' })
      .expect(201);
    const quoteB = await request(app.getHttpServer())
      .post(`/provider/opportunities/${requestId}/quotes`)
      .set('Authorization', providerB.authorization)
      .send({ amountHalalas: 12000, scope: 'عرض الخاسر' })
      .expect(201);
    const quoteAId = requiredString(quoteA.body, 'id');
    const quoteBId = requiredString(quoteB.body, 'id');

    const before = await request(app.getHttpServer())
      .get('/my/service-requests')
      .set('Authorization', customerAuthorization)
      .expect(200);
    const beforeRequest = (before.body as Record<string, unknown>[]).find(
      (item) => item.id === requestId,
    ) as Record<string, unknown>;
    const beforeQuotes = beforeRequest.quotes as Record<string, unknown>[];
    expect(beforeQuotes).toHaveLength(2);
    expect(beforeQuotes.every((quote) => quote.status === 'proposed')).toBe(
      true,
    );
    expect(beforeQuotes.every((quote) => !('providerId' in quote))).toBe(true);
    expect(beforeRequest.quote).toBeDefined();

    await request(app.getHttpServer())
      .post(`/my/service-requests/${requestId}/quotes/${quoteAId}/decision`)
      .set('Authorization', customerAuthorization)
      .send({ decision: 'approved' })
      .expect(201)
      .expect(({ body }: { body: Record<string, unknown> }) => {
        expect(body.status).toBe('approved');
        expect(body).not.toHaveProperty('providerId');
      });

    const after = await request(app.getHttpServer())
      .get('/my/service-requests')
      .set('Authorization', customerAuthorization)
      .expect(200);
    const afterRequest = (after.body as Record<string, unknown>[]).find(
      (item) => item.id === requestId,
    ) as Record<string, unknown>;
    expect(afterRequest.status).toBe('assigned');
    expect((afterRequest.assignedProvider as Record<string, unknown>).id).toBe(
      providerA.providerId,
    );
    const afterQuotes = afterRequest.quotes as Record<string, unknown>[];
    expect(afterQuotes).toHaveLength(2);
    const approvedView = afterQuotes.find(
      (quote) => quote.id === quoteAId,
    ) as Record<string, unknown>;
    expect(approvedView.status).toBe('approved');
    expect(approvedView.amountHalalas).toBe(15000);
    const rejectedView = afterQuotes.find(
      (quote) => quote.id === quoteBId,
    ) as Record<string, unknown>;
    expect(rejectedView.status).toBe('rejected');
    expect(rejectedView.amountHalalas).toBe(12000);
    expect(afterRequest.payment).toEqual(
      expect.objectContaining({
        method: 'cash_on_completion',
        status: 'cash_due',
        amountHalalas: 15000,
      }),
    );
  });

  it('returns only the winning provider marketplace quote in the assigned provider job', async () => {
    const customerAuthorization = await createCustomerAuthorization(app);
    const requestId = await createCustomerServiceRequest(
      app,
      customerAuthorization,
    );
    const dispatcherAuthorization = await createStaffAuthorization(
      app,
      'dispatcher',
    );
    const providerA = await createProviderAuthorization(app, ['ac-cleaning']);
    const providerB = await createProviderAuthorization(app, ['ac-cleaning']);
    const winnerScope = 'نطاق الفائز P0: تنظيف عميق للمكيف';
    const competitorScope = 'نطاق المنافس P0: تنظيف سريع للمكيف';

    await request(app.getHttpServer())
      .post(`/service-requests/${requestId}/opportunities`)
      .set('Authorization', dispatcherAuthorization)
      .send({ providerIds: [providerA.providerId, providerB.providerId] })
      .expect(201);

    const quoteA = await request(app.getHttpServer())
      .post(`/provider/opportunities/${requestId}/quotes`)
      .set('Authorization', providerA.authorization)
      .send({ amountHalalas: 15000, scope: winnerScope })
      .expect(201);
    const quoteAId = requiredString(quoteA.body, 'id');

    const quoteB = await request(app.getHttpServer())
      .post(`/provider/opportunities/${requestId}/quotes`)
      .set('Authorization', providerB.authorization)
      .send({ amountHalalas: 12000, scope: competitorScope })
      .expect(201);
    const quoteBId = requiredString(quoteB.body, 'id');

    await request(app.getHttpServer())
      .post(`/my/service-requests/${requestId}/quotes/${quoteAId}/decision`)
      .set('Authorization', customerAuthorization)
      .send({ decision: 'approved' })
      .expect(201);

    const customerView = await request(app.getHttpServer())
      .get('/my/service-requests')
      .set('Authorization', customerAuthorization)
      .expect(200);
    const customerRequest = (
      customerView.body as Record<string, unknown>[]
    ).find((item) => item.id === requestId) as Record<string, unknown>;
    const customerQuotes = customerRequest.quotes as Record<string, unknown>[];
    const approvedQuote = customerQuotes.find(
      (quote) => quote.id === quoteAId,
    ) as Record<string, unknown>;
    const rejectedQuote = customerQuotes.find(
      (quote) => quote.id === quoteBId,
    ) as Record<string, unknown>;
    expect(approvedQuote).toEqual(
      expect.objectContaining({
        id: quoteAId,
        amountHalalas: 15000,
        scope: winnerScope,
        status: 'approved',
      }),
    );
    expect(rejectedQuote).toEqual(
      expect.objectContaining({
        id: quoteBId,
        amountHalalas: 12000,
        scope: competitorScope,
        status: 'rejected',
      }),
    );
    expect(customerRequest.status).toBe('assigned');
    expect(
      (customerRequest.assignedProvider as Record<string, unknown>).id,
    ).toBe(providerA.providerId);
    expect(customerRequest.payment).toEqual(
      expect.objectContaining({
        method: 'cash_on_completion',
        status: 'cash_due',
        amountHalalas: 15000,
      }),
    );

    const providerJobsView = await request(app.getHttpServer())
      .get('/provider/service-requests')
      .set('Authorization', providerA.authorization)
      .expect(200);
    const providerJob = (
      providerJobsView.body as Record<string, unknown>[]
    ).find((item) => item.id === requestId) as Record<string, unknown>;
    expect(providerJob).toBeDefined();
    const providerQuote = responseObject(providerJob.quote);
    expect(providerQuote.id).toBe(quoteAId);
    expect(providerQuote.amountHalalas).toBe(15000);
    expect(providerQuote.scope).toBe(winnerScope);
    expect(providerQuote.status).toBe('approved');
    expect(typeof providerQuote.proposedAt).toBe('string');
    expect(typeof providerQuote.decidedAt).toBe('string');
    expect(JSON.stringify(providerJob)).not.toContain(competitorScope);

    const onTheWay = await request(app.getHttpServer())
      .patch(`/provider/service-requests/${requestId}/status`)
      .set('Authorization', providerA.authorization)
      .send({ status: 'on_the_way' })
      .expect(200);
    expect(responseObject(onTheWay.body).status).toBe('on_the_way');

    const inProgress = await request(app.getHttpServer())
      .patch(`/provider/service-requests/${requestId}/status`)
      .set('Authorization', providerA.authorization)
      .send({ status: 'in_progress' })
      .expect(200);
    expect(responseObject(inProgress.body).status).toBe('in_progress');
  });

  it('fails safely when the winning provider becomes unavailable before approval', async () => {
    const customerAuthorization = await createCustomerAuthorization(app);
    const requestId = await createCustomerServiceRequest(
      app,
      customerAuthorization,
    );
    const dispatcherAuthorization = await createStaffAuthorization(
      app,
      'dispatcher',
    );
    const provider = await createProviderAuthorization(app, ['ac-cleaning']);
    await request(app.getHttpServer())
      .post(`/service-requests/${requestId}/opportunities`)
      .set('Authorization', dispatcherAuthorization)
      .send({ providerIds: [provider.providerId] })
      .expect(201);
    const quote = await request(app.getHttpServer())
      .post(`/provider/opportunities/${requestId}/quotes`)
      .set('Authorization', provider.authorization)
      .send({ amountHalalas: 15000, scope: 'عرض' })
      .expect(201);
    const quoteId = requiredString(quote.body, 'id');

    const adminAuthorization = await createStaffAuthorization(app, 'admin');
    await request(app.getHttpServer())
      .patch(`/providers/${provider.providerId}/suspension`)
      .set('Authorization', adminAuthorization)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/my/service-requests/${requestId}/quotes/${quoteId}/decision`)
      .set('Authorization', customerAuthorization)
      .send({ decision: 'approved' })
      .expect(409);

    const after = await request(app.getHttpServer())
      .get('/my/service-requests')
      .set('Authorization', customerAuthorization)
      .expect(200);
    const afterRequest = (after.body as Record<string, unknown>[]).find(
      (item) => item.id === requestId,
    ) as Record<string, unknown>;
    expect(afterRequest.status).toBe('pending_dispatch');
    expect(afterRequest.assignedProvider).toBeUndefined();
    expect(afterRequest.payment).toBeUndefined();
    const quotes = afterRequest.quotes as Record<string, unknown>[];
    expect(quotes[0].status).toBe('proposed');
  });

  it('concurrent approvals of two provider quotes select exactly one winner', async () => {
    const customerAuthorization = await createCustomerAuthorization(app);
    const requestId = await createCustomerServiceRequest(
      app,
      customerAuthorization,
    );
    const dispatcherAuthorization = await createStaffAuthorization(
      app,
      'dispatcher',
    );
    const providerA = await createProviderAuthorization(app, ['ac-cleaning']);
    const providerB = await createProviderAuthorization(app, ['ac-cleaning']);
    await request(app.getHttpServer())
      .post(`/service-requests/${requestId}/opportunities`)
      .set('Authorization', dispatcherAuthorization)
      .send({ providerIds: [providerA.providerId, providerB.providerId] })
      .expect(201);
    const quoteA = await request(app.getHttpServer())
      .post(`/provider/opportunities/${requestId}/quotes`)
      .set('Authorization', providerA.authorization)
      .send({ amountHalalas: 15000, scope: 'عرض أ' })
      .expect(201);
    const quoteB = await request(app.getHttpServer())
      .post(`/provider/opportunities/${requestId}/quotes`)
      .set('Authorization', providerB.authorization)
      .send({ amountHalalas: 12000, scope: 'عرض ب' })
      .expect(201);
    const quoteAId = requiredString(quoteA.body, 'id');
    const quoteBId = requiredString(quoteB.body, 'id');

    const results = await Promise.allSettled([
      request(app.getHttpServer())
        .post(`/my/service-requests/${requestId}/quotes/${quoteAId}/decision`)
        .set('Authorization', customerAuthorization)
        .send({ decision: 'approved' })
        .expect(201),
      request(app.getHttpServer())
        .post(`/my/service-requests/${requestId}/quotes/${quoteBId}/decision`)
        .set('Authorization', customerAuthorization)
        .send({ decision: 'approved' })
        .expect(201),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);

    const after = await request(app.getHttpServer())
      .get('/my/service-requests')
      .set('Authorization', customerAuthorization)
      .expect(200);
    const afterRequest = (after.body as Record<string, unknown>[]).find(
      (item) => item.id === requestId,
    ) as Record<string, unknown>;
    expect(afterRequest.status).toBe('assigned');
    const afterQuotes = afterRequest.quotes as Record<string, unknown>[];
    expect(
      afterQuotes.find((quote) => quote.status === 'approved'),
    ).toBeDefined();
    expect(
      afterQuotes.find((quote) => quote.status === 'rejected'),
    ).toBeDefined();
  });

  it('rejects one provider quote while leaving the other active, updating the rejected opportunity', async () => {
    const customerAuthorization = await createCustomerAuthorization(app);
    const requestId = await createCustomerServiceRequest(
      app,
      customerAuthorization,
    );
    const dispatcherAuthorization = await createStaffAuthorization(
      app,
      'dispatcher',
    );
    const providerA = await createProviderAuthorization(app, ['ac-cleaning']);
    const providerB = await createProviderAuthorization(app, ['ac-cleaning']);
    await request(app.getHttpServer())
      .post(`/service-requests/${requestId}/opportunities`)
      .set('Authorization', dispatcherAuthorization)
      .send({ providerIds: [providerA.providerId, providerB.providerId] })
      .expect(201);
    const quoteA = await request(app.getHttpServer())
      .post(`/provider/opportunities/${requestId}/quotes`)
      .set('Authorization', providerA.authorization)
      .send({ amountHalalas: 15000, scope: 'عرض أ' })
      .expect(201);
    const quoteAId = requiredString(quoteA.body, 'id');
    const quoteB = await request(app.getHttpServer())
      .post(`/provider/opportunities/${requestId}/quotes`)
      .set('Authorization', providerB.authorization)
      .send({ amountHalalas: 12000, scope: 'عرض ب' })
      .expect(201);
    const quoteBId = requiredString(quoteB.body, 'id');

    // Reject A only.
    await request(app.getHttpServer())
      .post(`/my/service-requests/${requestId}/quotes/${quoteAId}/decision`)
      .set('Authorization', customerAuthorization)
      .send({ decision: 'rejected' })
      .expect(201);

    // Customer view: both quotes present, A rejected, B still proposed.
    const customerView = await request(app.getHttpServer())
      .get('/my/service-requests')
      .set('Authorization', customerAuthorization)
      .expect(200);
    const customerRequest = (
      customerView.body as Record<string, unknown>[]
    ).find((item) => item.id === requestId) as Record<string, unknown>;
    const quotes = customerRequest.quotes as Record<string, unknown>[];
    expect(quotes).toHaveLength(2);
    const rejectedQuote = quotes.find((q) => q.id === quoteAId) as Record<
      string,
      unknown
    >;
    expect(rejectedQuote.status).toBe('rejected');
    const activeQuote = quotes.find((q) => q.id === quoteBId) as Record<
      string,
      unknown
    >;
    expect(activeQuote.status).toBe('proposed');
    // Request still unassigned.
    expect(customerRequest.status).toBe('pending_dispatch');
    // No providerId exposed.
    expect(JSON.stringify(customerRequest)).not.toContain(providerA.providerId);

    // Provider A sees rejected opportunity.
    const providerAView = await request(app.getHttpServer())
      .get('/provider/opportunities')
      .set('Authorization', providerA.authorization)
      .expect(200);
    const aOpps = providerAView.body as Record<string, unknown>[];
    const aOpp = aOpps.find((o) => o.requestId === requestId) as Record<
      string,
      unknown
    >;
    expect(aOpp.opportunityStatus).toBe('rejected');
    expect((aOpp.myQuote as Record<string, unknown>).status).toBe('rejected');

    // Provider B still sees quoted opportunity.
    const providerBView = await request(app.getHttpServer())
      .get('/provider/opportunities')
      .set('Authorization', providerB.authorization)
      .expect(200);
    const bOpps = providerBView.body as Record<string, unknown>[];
    const bOpp = bOpps.find((o) => o.requestId === requestId) as Record<
      string,
      unknown
    >;
    expect(bOpp.opportunityStatus).toBe('quoted');
    expect((bOpp.myQuote as Record<string, unknown>).status).toBe('proposed');
  });

  it('subsequently approving a quote closes all opportunities and assigns the winner, without leaking competitor data', async () => {
    const customerAuthorization = await createCustomerAuthorization(app);
    const requestId = await createCustomerServiceRequest(
      app,
      customerAuthorization,
    );
    const dispatcherAuthorization = await createStaffAuthorization(
      app,
      'dispatcher',
    );
    const providerA = await createProviderAuthorization(app, ['ac-cleaning']);
    const providerB = await createProviderAuthorization(app, ['ac-cleaning']);
    await request(app.getHttpServer())
      .post(`/service-requests/${requestId}/opportunities`)
      .set('Authorization', dispatcherAuthorization)
      .send({ providerIds: [providerA.providerId, providerB.providerId] })
      .expect(201);
    // A is first quoted then rejected by the customer.
    const quoteA = await request(app.getHttpServer())
      .post(`/provider/opportunities/${requestId}/quotes`)
      .set('Authorization', providerA.authorization)
      .send({ amountHalalas: 15000, scope: 'عرض أ' })
      .expect(201);
    const quoteAId = requiredString(quoteA.body, 'id');
    await request(app.getHttpServer())
      .post(`/my/service-requests/${requestId}/quotes/${quoteAId}/decision`)
      .set('Authorization', customerAuthorization)
      .send({ decision: 'rejected' })
      .expect(201);
    // B quotes and is then approved.
    const quoteB = await request(app.getHttpServer())
      .post(`/provider/opportunities/${requestId}/quotes`)
      .set('Authorization', providerB.authorization)
      .send({ amountHalalas: 12000, scope: 'عرض ب' })
      .expect(201);
    const quoteBId = requiredString(quoteB.body, 'id');
    await request(app.getHttpServer())
      .post(`/my/service-requests/${requestId}/quotes/${quoteBId}/decision`)
      .set('Authorization', customerAuthorization)
      .send({ decision: 'approved' })
      .expect(201);

    // Winner assigned, competitor closed.
    const customerView = await request(app.getHttpServer())
      .get('/my/service-requests')
      .set('Authorization', customerAuthorization)
      .expect(200);
    const customerRequest = (
      customerView.body as Record<string, unknown>[]
    ).find((item) => item.id === requestId) as Record<string, unknown>;
    expect(customerRequest.status).toBe('assigned');
    expect(
      (customerRequest.assignedProvider as Record<string, unknown>).id,
    ).toBe(providerB.providerId);

    // Losing provider A sees closed opportunity with safe message.
    const providerAView = await request(app.getHttpServer())
      .get('/provider/opportunities')
      .set('Authorization', providerA.authorization)
      .expect(200);
    const aOpps = providerAView.body as Record<string, unknown>[];
    const aOpp = aOpps.find((o) => o.requestId === requestId) as Record<
      string,
      unknown
    >;
    // A was directly rejected earlier; its opportunity stays 'rejected',
    // not overwritten to 'closed' (the approval-closure targets only
    // 'invited'/'quoted' statuses).
    expect(aOpp.opportunityStatus).toBe('rejected');
    // No competitor data leaked.
    const serializedAOpp = JSON.stringify(aOpp);
    expect(serializedAOpp).not.toContain(providerB.providerId);
    expect(serializedAOpp).not.toContain('12000'); // B's price
    // No customer-private data leaked.
    expect(serializedAOpp).not.toContain('حي الصفراء');

    // Winner B sees closed opportunity with approved quote.
    const providerBView = await request(app.getHttpServer())
      .get('/provider/opportunities')
      .set('Authorization', providerB.authorization)
      .expect(200);
    const bOpps = providerBView.body as Record<string, unknown>[];
    const bOpp = bOpps.find((o) => o.requestId === requestId) as Record<
      string,
      unknown
    >;
    expect(bOpp.opportunityStatus).toBe('closed');
    expect((bOpp.myQuote as Record<string, unknown>).status).toBe('approved');
  });

  it('includes providerSummary with name, average rating and rating count in customer quote views', async () => {
    // 1. Provider A earns one completed, rated request (rating 5/5).
    const providerA = await createProviderAuthorization(app, ['ac-cleaning']);
    const ratedCustomer = await createCustomerAuthorization(app);
    const ratedRequestId = await createCustomerServiceRequest(
      app,
      ratedCustomer,
    );
    await request(app.getHttpServer())
      .post(`/provider/opportunities/${ratedRequestId}/quotes`)
      .set('Authorization', providerA.authorization)
      .send({ amountHalalas: 10000, scope: 'تنظيف المكيف' })
      .expect(201);
    const ratedView = await request(app.getHttpServer())
      .get('/my/service-requests')
      .set('Authorization', ratedCustomer)
      .expect(200);
    const ratedRequest = (ratedView.body as Record<string, unknown>[]).find(
      (item) => item.id === ratedRequestId,
    ) as Record<string, unknown>;
    const ratedQuotes = ratedRequest.quotes as Record<string, unknown>[];
    const approvedQuote = ratedQuotes.find(
      (quote) => quote.status === 'proposed',
    ) as Record<string, unknown>;
    await request(app.getHttpServer())
      .post(
        `/my/service-requests/${ratedRequestId}/quotes/${String(approvedQuote.id)}/decision`,
      )
      .set('Authorization', ratedCustomer)
      .send({ decision: 'approved' })
      .expect(201);
    for (const status of ['on_the_way', 'in_progress', 'completed']) {
      await request(app.getHttpServer())
        .patch(`/provider/service-requests/${ratedRequestId}/status`)
        .set('Authorization', providerA.authorization)
        .send({ status })
        .expect(200);
    }
    await request(app.getHttpServer())
      .post(`/my/service-requests/${ratedRequestId}/rating`)
      .set('Authorization', ratedCustomer)
      .send({ rating: 5, comment: 'خدمة ممتازة' })
      .expect(201);

    // 2. A new request where A (rated) and B (unrated) both quote.
    const providerB = await createProviderAuthorization(app, ['ac-cleaning']);
    const customer = await createCustomerAuthorization(app);
    const requestId = await createCustomerServiceRequest(app, customer);
    await request(app.getHttpServer())
      .post(`/provider/opportunities/${requestId}/quotes`)
      .set('Authorization', providerA.authorization)
      .send({ amountHalalas: 15000, scope: 'عرض أ' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/provider/opportunities/${requestId}/quotes`)
      .set('Authorization', providerB.authorization)
      .send({ amountHalalas: 12000, scope: 'عرض ب' })
      .expect(201);

    // 3. The customer quote list carries a safe provider summary per quote.
    const view = await request(app.getHttpServer())
      .get('/my/service-requests')
      .set('Authorization', customer)
      .expect(200);
    const record = (view.body as Record<string, unknown>[]).find(
      (item) => item.id === requestId,
    ) as Record<string, unknown>;
    const quotes = record.quotes as Record<string, unknown>[];
    const quoteA = quotes.find((quote) => quote.scope === 'عرض أ') as Record<
      string,
      unknown
    >;
    const quoteB = quotes.find((quote) => quote.scope === 'عرض ب') as Record<
      string,
      unknown
    >;
    expect(quoteA.providerSummary).toEqual({
      name: providerA.name,
      averageRating: 5,
      ratingCount: 1,
    });
    expect(quoteB.providerSummary).toEqual({
      name: providerB.name,
      averageRating: null,
      ratingCount: 0,
    });
    // Existing quote fields remain present.
    expect(quoteA.amountHalalas).toBe(15000);
    expect(quoteA.status).toBe('proposed');
    // No provider identity or internal fields leak to the customer.
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(providerA.providerId);
    expect(serialized).not.toContain(providerB.providerId);
  });

  it('keeps the legacy staff quote flow unchanged when no opportunities exist', async () => {
    const customerAuthorization = await createCustomerAuthorization(app);
    // The legacy staff flow only applies when no marketplace opportunity
    // exists. Make the seeded ac-cleaning provider unavailable — this run's
    // schema is fresh, so the request is deterministically created with zero
    // eligible matching providers; then create a fresh matching provider
    // afterwards and use that (available) provider for assignment and the
    // staff-quote flow.
    await makeSeededProviderUnavailable(app, 'provider-1');
    // Q0-SEC determinism: remove exactly the providers this suite created
    // (exact registered ids) so the request is deterministically created with
    // zero eligible matching providers.
    await removeCreatedProvidersForLegacyFlow();
    const requestId = await createCustomerServiceRequest(
      app,
      customerAuthorization,
    );
    const staffAuthorization = await createStaffAuthorization(app);
    const legacyProvider = await createProviderAuthorization(app, [
      'ac-cleaning',
    ]);
    await request(app.getHttpServer())
      .patch(`/service-requests/${requestId}/assignment`)
      .set('Authorization', staffAuthorization)
      .send({ providerId: legacyProvider.providerId })
      .expect(200);
    const proposed = await request(app.getHttpServer())
      .post(`/service-requests/${requestId}/quotes`)
      .set('Authorization', staffAuthorization)
      .send({ amountHalalas: 10000, scope: 'عرض الموظف التقليدي' })
      .expect(201);
    const quoteId = requiredString(proposed.body, 'id');
    await request(app.getHttpServer())
      .post(`/my/service-requests/${requestId}/quotes/${quoteId}/decision`)
      .set('Authorization', customerAuthorization)
      .send({ decision: 'approved' })
      .expect(201);

    const view = await request(app.getHttpServer())
      .get('/my/service-requests')
      .set('Authorization', customerAuthorization)
      .expect(200);
    const myRequest = (view.body as Record<string, unknown>[]).find(
      (item) => item.id === requestId,
    ) as Record<string, unknown>;
    expect(myRequest.quote).toEqual(
      expect.objectContaining({ id: quoteId, status: 'approved' }),
    );
    expect(myRequest.quotes).toEqual([]);
    expect(myRequest.payment).toEqual(
      expect.objectContaining({ status: 'cash_due' }),
    );

    const providerJobs = await request(app.getHttpServer())
      .get('/provider/service-requests')
      .set('Authorization', legacyProvider.authorization)
      .expect(200);
    const providerJob = (providerJobs.body as Record<string, unknown>[]).find(
      (item) => item.id === requestId,
    ) as Record<string, unknown>;
    expect(providerJob.quote).toEqual(
      expect.objectContaining({
        id: quoteId,
        amountHalalas: 10000,
        scope: 'عرض الموظف التقليدي',
        status: 'approved',
      }),
    );
  });

  describe('Q0-SEC legacy-flow determinism regression', () => {
    it('removes exactly the registered provider ids and nothing else', async () => {
      const registered = await createProviderAuthorization(app, [
        'ac-cleaning',
      ]);
      // A provider NOT registered by the suite must survive the cleanup.
      const adminAuthorization = await createStaffAuthorization(app, 'admin');
      const unregisteredRes = await request(app.getHttpServer())
        .post('/providers')
        .set('Authorization', adminAuthorization)
        .send({
          name: `مقدم E2E ${randomUUID().slice(0, 8)}`,
          specialties: ['ac-cleaning'],
          serviceZone: 'بريدة',
        })
        .expect(201);
      const unregisteredId = requiredString(unregisteredRes.body, 'id');
      await request(app.getHttpServer())
        .patch(`/providers/${unregisteredId}/verification`)
        .set('Authorization', adminAuthorization)
        .expect(200);

      await removeCreatedProvidersForLegacyFlow();

      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      try {
        const gone = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM providers WHERE id = $1`,
          [registered.providerId],
        );
        expect(gone.rows[0].n).toBe(0);
        const stays = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM providers WHERE id = $1`,
          [unregisteredId],
        );
        expect(stays.rows[0].n).toBe(1);
      } finally {
        await pool.end();
      }
    });

    it('is an idempotent no-op when no ids are registered', async () => {
      await removeCreatedProvidersForLegacyFlow();
      expect(createdProviderIds.size).toBe(0);
    });

    it('never scans with prefix patterns or broad wipes', () => {
      const source = readFileSync(__filename, 'utf8');
      // The literals are assembled so this assertion cannot match itself.
      const likePattern = new RegExp("LIKE\\s+'PILOT-%'");
      const ilikePattern = new RegExp('ILI' + 'KE');
      expect(source).not.toMatch(likePattern);
      expect(source).not.toMatch(ilikePattern);
    });
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    // Q0-SEC: no shared-schema cleanup here. Each test run owns its unique
    // schema (moeen_test_<runId>) and global-teardown.ts drops it with
    // CASCADE, so nothing created by this run can leak into or collide with
    // another run.
  });
});

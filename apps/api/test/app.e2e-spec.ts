import 'dotenv/config';
import { randomUUID } from 'node:crypto';
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
): Promise<{ providerId: string; authorization: string }> {
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
    authorization: `Bearer ${requiredString(login.body, 'token')}`,
  };
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

    await request(app.getHttpServer())
      .patch(`/service-requests/${requestId}/assignment`)
      .set('Authorization', staffAuthorization)
      .send({ providerId: 'provider-1' })
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

    await request(app.getHttpServer())
      .patch(`/service-requests/${requestId}/assignment`)
      .set('Authorization', dispatcherAuthorization)
      .send({ providerId: 'provider-3' })
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

    await request(app.getHttpServer())
      .patch(`/service-requests/${ownRequestId}/assignment`)
      .set('Authorization', staffAuthorization)
      .send({ providerId: 'provider-1' })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/service-requests/${otherRequestId}/assignment`)
      .set('Authorization', staffAuthorization)
      .send({ providerId: 'provider-3' })
      .expect(200);

    const accessCode = `provider-access-${randomUUID()}`;
    await request(app.getHttpServer())
      .post('/providers/provider-1/access-code')
      .set('Authorization', staffAuthorization)
      .send({ accessCode })
      .expect(201);
    const providerLogin = await request(app.getHttpServer())
      .post('/provider/auth/login')
      .send({ accessCode })
      .expect(201);
    const providerAuthorization = `Bearer ${requiredString(providerLogin.body, 'token')}`;

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
    expect(rejectedView).toEqual({ id: quoteBId, status: 'rejected' });
    expect(afterRequest.payment).toEqual(
      expect.objectContaining({
        method: 'cash_on_completion',
        status: 'cash_due',
        amountHalalas: 15000,
      }),
    );
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

  it('keeps the legacy staff quote flow unchanged when no opportunities exist', async () => {
    const customerAuthorization = await createCustomerAuthorization(app);
    const requestId = await createCustomerServiceRequest(
      app,
      customerAuthorization,
    );
    const staffAuthorization = await createStaffAuthorization(app);
    await request(app.getHttpServer())
      .patch(`/service-requests/${requestId}/assignment`)
      .set('Authorization', staffAuthorization)
      .send({ providerId: 'provider-1' })
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
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    // Remove E2E-created pilot providers (and their dependent rows) so the
    // provider-login scrypt loop stays bounded across runs.
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    try {
      await pool.query(
        `DELETE FROM service_payments
         WHERE service_request_id IN (
           SELECT id FROM service_requests WHERE assigned_provider_id LIKE 'PILOT-%'
         )
            OR quote_id IN (
           SELECT id FROM service_quotes WHERE provider_id LIKE 'PILOT-%'
         )`,
      );
      await pool.query(
        `DELETE FROM service_request_events
         WHERE service_request_id IN (
           SELECT id FROM service_requests WHERE assigned_provider_id LIKE 'PILOT-%'
         )`,
      );
      await pool.query(
        `DELETE FROM request_provider_opportunities
         WHERE provider_id LIKE 'PILOT-%'
            OR service_request_id IN (
           SELECT id FROM service_requests WHERE assigned_provider_id LIKE 'PILOT-%'
         )`,
      );
      await pool.query(
        `DELETE FROM service_quotes
         WHERE provider_id LIKE 'PILOT-%'
            OR service_request_id IN (
           SELECT id FROM service_requests WHERE assigned_provider_id LIKE 'PILOT-%'
         )`,
      );
      await pool.query(
        `DELETE FROM service_requests WHERE assigned_provider_id LIKE 'PILOT-%'`,
      );
      await pool.query(
        `DELETE FROM provider_sessions WHERE provider_id LIKE 'PILOT-%'`,
      );
      await pool.query(
        `DELETE FROM provider_access_credentials WHERE provider_id LIKE 'PILOT-%'`,
      );
      await pool.query(`DELETE FROM providers WHERE id LIKE 'PILOT-%'`);
    } finally {
      await pool.end();
    }
  });
});

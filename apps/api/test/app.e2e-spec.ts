import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
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

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

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

    app = moduleFixture.createNestApplication();
    const clientIpSeed =
      Number.parseInt(randomUUID().replaceAll('-', '').slice(0, 8), 16) % 64_516;
    const clientIp = `198.18.${Math.floor(clientIpSeed / 254) + 1}.${
      (clientIpSeed % 254) + 1
    }`;
    app.getHttpAdapter().getInstance().set('trust proxy', true);
    app.use((request, _response, next) => {
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
      .send({ phone: `+9665${String(Date.now()).slice(-8)}` })
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
  });

  it('rejects a malformed provider access-code payload before authentication', () => {
    return request(app.getHttpServer())
      .post('/provider/auth/login')
      .send({ accessCode: { unexpected: 'object' } })
      .expect(400);
  });

  it('rejects a malformed customer service request before persistence', async () => {
    const otpChallenge = await request(app.getHttpServer())
      .post('/auth/request-otp')
      .send({ phone: '+966500001112' })
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
    const phone = '+966500000121';
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
    const phone = `+9665${String(Date.now()).slice(-8)}`;
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
    const phone = `+9665${String(Date.now()).slice(-8)}`;
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
    const phone = `+9665${String(Date.now()).slice(-8)}`;
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
        .send({ phone: `+9665${String(10_000_000 + attempt)}` })
        .expect(201);
    }

    await request(app.getHttpServer())
      .post('/auth/request-otp')
      .send({ phone: '+966510000010' })
      .expect(429);
  });

  it('rejects customer requests without a bearer token', () => {
    return request(app.getHttpServer()).get('/my/service-requests').expect(401);
  });

  afterEach(async () => {
    await app.close();
  });
});

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { App } from 'supertest/types';
import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { configureApiSecurity } from './../src/api-security';
import { StaffAuthRepository } from './../src/staff-auth.repository';
import { OTP_PROVIDER, type OtpProvider } from './../src/otp-provider';
import { hashStaffPassword, type StaffRole } from './../src/staff-auth.service';
import { MAX_ACTIVE_FCM_DEVICES_PER_OWNER } from './../src/fcm-device.contracts';

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

function uniqueTestPhone(): string {
  const suffix = String(Math.floor(Math.random() * 100_000_000)).padStart(
    8,
    '0',
  );
  return `+9665${suffix}`;
}

function uniqueFcmToken(label: string): string {
  return `fcm-token-${label}-${randomUUID()}`;
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

async function createProviderAuthorization(
  app: INestApplication<App>,
): Promise<{ providerId: string; authorization: string }> {
  const adminAuthorization = await createStaffAuthorization(app, 'admin');
  const created = await request(app.getHttpServer())
    .post('/providers')
    .set('Authorization', adminAuthorization)
    .send({
      name: `مقدم FCM ${randomUUID().slice(0, 8)}`,
      specialties: ['ac-cleaning'],
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

function expectSafeDeviceBody(body: unknown): Record<string, unknown> {
  const device = responseObject(body);
  expect(Object.keys(device).sort()).toEqual([
    'active',
    'createdAt',
    'deviceId',
    'lastSeenAt',
    'platform',
  ]);
  return device;
}

describe('FCM device registration (e2e)', () => {
  let app: NestExpressApplication;
  // Shared principals keep the suite far below the public-auth IP rate
  // limits (10 OTP requests / 20 provider logins per 10-minute window).
  let sharedCustomerAuthorization: string;
  let strangerCustomerAuthorization: string;
  let strangerProvider: { providerId: string; authorization: string };

  beforeAll(async () => {
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
    app.use((request_: Request, _response: Response, next: NextFunction) => {
      request_.headers['x-forwarded-for'] = clientIp;
      next();
    });
    configureApiSecurity(app);
    await app.init();

    sharedCustomerAuthorization = await createCustomerAuthorization(app);
    strangerCustomerAuthorization = await createCustomerAuthorization(app);
    strangerProvider = await createProviderAuthorization(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects unauthenticated customer device registration', async () => {
    await request(app.getHttpServer())
      .post('/my/devices')
      .send({ token: uniqueFcmToken('anon'), platform: 'android' })
      .expect(401);
  });

  it('rejects unauthenticated provider device registration', async () => {
    await request(app.getHttpServer())
      .post('/provider/devices')
      .send({ token: uniqueFcmToken('anon'), platform: 'android' })
      .expect(401);
  });

  it('rejects unauthenticated customer device revocation', async () => {
    await request(app.getHttpServer())
      .delete(`/my/devices/${randomUUID()}`)
      .expect(401);
  });

  it('rejects unauthenticated provider device revocation', async () => {
    await request(app.getHttpServer())
      .delete(`/provider/devices/${randomUUID()}`)
      .expect(401);
  });

  it('registers a customer device without echoing the token', async () => {
    const token = uniqueFcmToken('customer-echo');

    const response = await request(app.getHttpServer())
      .post('/my/devices')
      .set('Authorization', sharedCustomerAuthorization)
      .send({ token, platform: 'android' })
      .expect(201);

    const device = expectSafeDeviceBody(response.body);
    expect(device.active).toBe(true);
    expect(device.platform).toBe('android');
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('hash');
  });

  it('derives ownership from the authenticated session, not the body', async () => {
    const token = uniqueFcmToken('ownership');

    const response = await request(app.getHttpServer())
      .post('/my/devices')
      .set('Authorization', sharedCustomerAuthorization)
      .send({
        token,
        platform: 'android',
        customerId: 'CUS-999999',
        providerId: 'provider-attacker',
      })
      .expect(201);
    const deviceId = requiredString(response.body, 'deviceId');

    // The REAL customer (from the session) can revoke it...
    await request(app.getHttpServer())
      .delete(`/my/devices/${deviceId}`)
      .set('Authorization', sharedCustomerAuthorization)
      .expect(200);
  });

  it('registers a provider device', async () => {
    const response = await request(app.getHttpServer())
      .post('/provider/devices')
      .set('Authorization', strangerProvider.authorization)
      .send({ token: uniqueFcmToken('provider'), platform: 'ios' })
      .expect(201);

    const device = expectSafeDeviceBody(response.body);
    expect(device.active).toBe(true);
    expect(device.platform).toBe('ios');
  });

  it('validates registration input', async () => {
    await request(app.getHttpServer())
      .post('/my/devices')
      .set('Authorization', sharedCustomerAuthorization)
      .send({ token: uniqueFcmToken('platform'), platform: 'windows' })
      .expect(400);

    await request(app.getHttpServer())
      .post('/my/devices')
      .set('Authorization', sharedCustomerAuthorization)
      .send({ token: 'too-short', platform: 'android' })
      .expect(400);

    await request(app.getHttpServer())
      .post('/my/devices')
      .set('Authorization', sharedCustomerAuthorization)
      .send({ platform: 'android' })
      .expect(400);

    await request(app.getHttpServer())
      .post('/my/devices')
      .set('Authorization', sharedCustomerAuthorization)
      .send({ token: 12345, platform: 'android' })
      .expect(400);
  });

  it('is idempotent for the same token registered by the same customer', async () => {
    const authorization = await createCustomerAuthorization(app);
    const token = uniqueFcmToken('idempotent');

    const first = await request(app.getHttpServer())
      .post('/my/devices')
      .set('Authorization', authorization)
      .send({ token, platform: 'android' })
      .expect(201);
    const second = await request(app.getHttpServer())
      .post('/my/devices')
      .set('Authorization', authorization)
      .send({ token, platform: 'android' })
      .expect(201);

    expect(requiredString(second.body, 'deviceId')).toBe(
      requiredString(first.body, 'deviceId'),
    );
  });

  it('rebinds a token when it moves to a different account', async () => {
    const firstAuthorization = await createCustomerAuthorization(app);
    const secondAuthorization = await createCustomerAuthorization(app);
    const token = uniqueFcmToken('rebind');

    const first = await request(app.getHttpServer())
      .post('/my/devices')
      .set('Authorization', firstAuthorization)
      .send({ token, platform: 'android' })
      .expect(201);
    const second = await request(app.getHttpServer())
      .post('/my/devices')
      .set('Authorization', secondAuthorization)
      .send({ token, platform: 'android' })
      .expect(201);

    const firstDeviceId = requiredString(first.body, 'deviceId');
    expect(requiredString(second.body, 'deviceId')).not.toBe(firstDeviceId);

    const revoked = await request(app.getHttpServer())
      .delete(`/my/devices/${firstDeviceId}`)
      .set('Authorization', firstAuthorization)
      .expect(200);
    expect(responseObject(revoked.body).active).toBe(false);
  });

  it('enforces the 10-active-device cap with a bounded 409', async () => {
    const authorization = await createCustomerAuthorization(app);
    for (let index = 0; index < MAX_ACTIVE_FCM_DEVICES_PER_OWNER; index++) {
      await request(app.getHttpServer())
        .post('/my/devices')
        .set('Authorization', authorization)
        .send({ token: uniqueFcmToken(`cap-${index}`), platform: 'android' })
        .expect(201);
    }

    const overflow = await request(app.getHttpServer())
      .post('/my/devices')
      .set('Authorization', authorization)
      .send({ token: uniqueFcmToken('cap-overflow'), platform: 'android' })
      .expect(409);
    expect(responseObject(overflow.body).message).toBe(
      'At most 10 active devices per account',
    );
  });

  it('revokes only the owning customer’s device', async () => {
    const ownerAuthorization = await createCustomerAuthorization(app);

    const created = await request(app.getHttpServer())
      .post('/my/devices')
      .set('Authorization', ownerAuthorization)
      .send({ token: uniqueFcmToken('revoke-customer'), platform: 'android' })
      .expect(201);
    const deviceId = requiredString(created.body, 'deviceId');

    await request(app.getHttpServer())
      .delete(`/my/devices/${deviceId}`)
      .set('Authorization', strangerCustomerAuthorization)
      .expect(404);

    const revoked = await request(app.getHttpServer())
      .delete(`/my/devices/${deviceId}`)
      .set('Authorization', ownerAuthorization)
      .expect(200);
    expect(responseObject(revoked.body).active).toBe(false);

    // Re-revoking an own device stays a safe idempotent success.
    await request(app.getHttpServer())
      .delete(`/my/devices/${deviceId}`)
      .set('Authorization', ownerAuthorization)
      .expect(200);
  });

  it('revokes only the owning provider’s device', async () => {
    const owner = await createProviderAuthorization(app);

    const created = await request(app.getHttpServer())
      .post('/provider/devices')
      .set('Authorization', owner.authorization)
      .send({ token: uniqueFcmToken('revoke-provider'), platform: 'android' })
      .expect(201);
    const deviceId = requiredString(created.body, 'deviceId');

    await request(app.getHttpServer())
      .delete(`/provider/devices/${deviceId}`)
      .set('Authorization', strangerProvider.authorization)
      .expect(404);

    const revoked = await request(app.getHttpServer())
      .delete(`/provider/devices/${deviceId}`)
      .set('Authorization', owner.authorization)
      .expect(200);
    expect(responseObject(revoked.body).active).toBe(false);
  });

  it('keeps customer and provider devices isolated across roles', async () => {
    const customerDevice = await request(app.getHttpServer())
      .post('/my/devices')
      .set('Authorization', strangerCustomerAuthorization)
      .send({
        token: uniqueFcmToken('isolation-customer'),
        platform: 'android',
      })
      .expect(201);
    const providerDevice = await request(app.getHttpServer())
      .post('/provider/devices')
      .set('Authorization', strangerProvider.authorization)
      .send({
        token: uniqueFcmToken('isolation-provider'),
        platform: 'android',
      })
      .expect(201);

    await request(app.getHttpServer())
      .delete(
        `/provider/devices/${requiredString(customerDevice.body, 'deviceId')}`,
      )
      .set('Authorization', strangerProvider.authorization)
      .expect(404);
    await request(app.getHttpServer())
      .delete(`/my/devices/${requiredString(providerDevice.body, 'deviceId')}`)
      .set('Authorization', strangerCustomerAuthorization)
      .expect(404);
  });

  it('returns 404 for a malformed device id', async () => {
    await request(app.getHttpServer())
      .delete('/my/devices/not-a-uuid')
      .set('Authorization', sharedCustomerAuthorization)
      .expect(404);
  });
});

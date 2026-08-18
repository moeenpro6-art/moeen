import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CustomerSessionGuard } from './customer-session.guard';
import { ServiceRequestRepository } from './service-request.repository';
import { StaffAuthService } from './staff-auth.service';
import { StaffAuditService } from './staff-audit.service';
import { CustomerAuthService } from './customer-auth.service';
import { ProviderAuthService } from './provider-auth.service';
import { PublicAuthRateLimiter } from './public-auth-rate-limiter.service';

const VALID_IDEMPOTENCY_KEY = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = { id: 'CUS-1001', phone: '+966500000001' };
const CREATED = {
  id: 'MOE-2001',
  serviceId: 'ac-cleaning',
  address: 'حي الصفراء، بريدة',
  details: 'تنظيف مكيفات',
  timing: 'as-soon-as-possible' as const,
  status: 'pending_dispatch' as const,
  createdAt: '2026-08-16T12:00:00.000Z',
};

type AppServiceMock = {
  createAuthenticatedServiceRequest: jest.Mock;
  createAuthenticatedServiceRequestWithImages: jest.Mock;
};

type SessionStoreMock = {
  findCustomerBySession: jest.Mock;
};

function multipart(target: App) {
  return request(target)
    .post('/service-requests')
    .set('Authorization', 'Bearer customer-session')
    .set('Idempotency-Key', VALID_IDEMPOTENCY_KEY)
    .field('serviceId', 'ac-cleaning')
    .field('address', 'حي الصفراء، بريدة')
    .field('details', 'تنظيف مكيفات')
    .field('timing', 'as-soon-as-possible');
}

describe('POST /service-requests multipart entry', () => {
  let app: INestApplication<App>;
  let appService: AppServiceMock;
  let sessionStore: SessionStoreMock;

  beforeEach(async () => {
    appService = {
      createAuthenticatedServiceRequest: jest.fn().mockResolvedValue(CREATED),
      createAuthenticatedServiceRequestWithImages: jest
        .fn()
        .mockResolvedValue(CREATED),
    };
    sessionStore = {
      findCustomerBySession: jest.fn().mockResolvedValue(CUSTOMER),
    };
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        CustomerSessionGuard,
        { provide: AppService, useValue: appService },
        { provide: ServiceRequestRepository, useValue: sessionStore },
        { provide: StaffAuthService, useValue: {} },
        { provide: StaffAuditService, useValue: {} },
        { provide: CustomerAuthService, useValue: {} },
        { provide: ProviderAuthService, useValue: {} },
        { provide: PublicAuthRateLimiter, useValue: {} },
      ],
    }).compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('preserves legacy JSON creation without requiring Idempotency-Key', async () => {
    await request(app.getHttpServer())
      .post('/service-requests')
      .set('Authorization', 'Bearer customer-session')
      .send({
        serviceId: 'ac-cleaning',
        address: 'حي الصفراء، بريدة',
        timing: 'as-soon-as-possible',
      })
      .expect(201)
      .expect(CREATED);

    expect(appService.createAuthenticatedServiceRequest).toHaveBeenCalledWith(
      CUSTOMER,
      {
        serviceId: 'ac-cleaning',
        address: 'حي الصفراء، بريدة',
        timing: 'as-soon-as-possible',
      },
    );
    expect(
      appService.createAuthenticatedServiceRequestWithImages,
    ).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['malformed', 'not-a-uuid'],
    ['non-v4', '11111111-1111-1111-8111-111111111111'],
  ])('rejects a %s multipart Idempotency-Key', async (_name, key) => {
    let pending = request(app.getHttpServer())
      .post('/service-requests')
      .set('Authorization', 'Bearer customer-session');
    if (key) pending = pending.set('Idempotency-Key', key);

    await pending
      .field('serviceId', 'ac-cleaning')
      .field('address', 'حي الصفراء، بريدة')
      .field('timing', 'as-soon-as-possible')
      .expect(400);

    expect(
      appService.createAuthenticatedServiceRequestWithImages,
    ).not.toHaveBeenCalled();
  });

  it('accepts a valid UUID v4 and zero images', async () => {
    await multipart(app.getHttpServer()).expect(201).expect(CREATED);

    expect(
      appService.createAuthenticatedServiceRequestWithImages,
    ).toHaveBeenCalledWith(
      CUSTOMER,
      {
        serviceId: 'ac-cleaning',
        address: 'حي الصفراء، بريدة',
        details: 'تنظيف مكيفات',
        timing: 'as-soon-as-possible',
        images: [],
      },
      VALID_IDEMPOTENCY_KEY,
    );
  });

  it.each([1, 5])('accepts %i image files in order', async (count) => {
    let pending = multipart(app.getHttpServer());
    for (let index = 0; index < count; index += 1) {
      pending = pending.attach('images', Buffer.from(`image-${index}`), {
        filename: `customer-${index}.jpg`,
        contentType: 'image/jpeg',
      });
    }

    await pending.expect(201);

    const calls = appService.createAuthenticatedServiceRequestWithImages.mock
      .calls as unknown as Array<
      [unknown, { images: Array<{ buffer: Buffer; size: number }> }]
    >;
    const input = calls[0][1];
    expect(input.images).toHaveLength(count);
    expect(input.images.map((image) => image.buffer.toString())).toEqual(
      Array.from({ length: count }, (_, index) => `image-${index}`),
    );
  });

  it('rejects 6 images in the bounded multipart interceptor', async () => {
    let pending = multipart(app.getHttpServer());
    for (let index = 0; index < 6; index += 1) {
      pending = pending.attach('images', Buffer.from(`image-${index}`), {
        filename: `${index}.jpg`,
        contentType: 'image/jpeg',
      });
    }

    await pending.expect(400);
    expect(
      appService.createAuthenticatedServiceRequestWithImages,
    ).not.toHaveBeenCalled();
  });

  it('rejects a file larger than 5 MiB before the handler', async () => {
    await multipart(app.getHttpServer())
      .attach('images', Buffer.alloc(5 * 1024 * 1024 + 1), {
        filename: 'large.jpg',
        contentType: 'image/jpeg',
      })
      .expect(413);

    expect(
      appService.createAuthenticatedServiceRequestWithImages,
    ).not.toHaveBeenCalled();
  });

  it('rejects aggregate image bytes over 20 MiB before image processing', async () => {
    let pending = multipart(app.getHttpServer());
    for (let index = 0; index < 5; index += 1) {
      pending = pending.attach(
        'images',
        Buffer.alloc(4 * 1024 * 1024 + 1, index),
        {
          filename: `${index}.jpg`,
          contentType: 'image/jpeg',
        },
      );
    }

    await pending.expect(400);
    expect(
      appService.createAuthenticatedServiceRequestWithImages,
    ).not.toHaveBeenCalled();
  });

  it('rejects missing auth before multipart parsing and request creation', async () => {
    await request(app.getHttpServer())
      .post('/service-requests')
      .set('Idempotency-Key', VALID_IDEMPOTENCY_KEY)
      .field('serviceId', 'ac-cleaning')
      .field('address', 'حي الصفراء، بريدة')
      .field('timing', 'as-soon-as-possible')
      .attach('images', Buffer.alloc(5 * 1024 * 1024 + 1), {
        filename: 'would-be-oversized.jpg',
        contentType: 'image/jpeg',
      })
      .expect(401);

    expect(sessionStore.findCustomerBySession).not.toHaveBeenCalled();
    expect(appService.createAuthenticatedServiceRequest).not.toHaveBeenCalled();
    expect(
      appService.createAuthenticatedServiceRequestWithImages,
    ).not.toHaveBeenCalled();
  });

  it('rejects invalid or expired auth before multipart parsing and request creation', async () => {
    sessionStore.findCustomerBySession.mockResolvedValue(undefined);

    await request(app.getHttpServer())
      .post('/service-requests')
      .set('Authorization', 'Bearer invalid-session')
      .set('Idempotency-Key', VALID_IDEMPOTENCY_KEY)
      .field('serviceId', 'ac-cleaning')
      .field('address', 'حي الصفراء، بريدة')
      .field('timing', 'as-soon-as-possible')
      .attach('images', Buffer.alloc(5 * 1024 * 1024 + 1), {
        filename: 'would-be-oversized.jpg',
        contentType: 'image/jpeg',
      })
      .expect(401);

    expect(sessionStore.findCustomerBySession).toHaveBeenCalledWith(
      'invalid-session',
    );
    expect(appService.createAuthenticatedServiceRequest).not.toHaveBeenCalled();
    expect(
      appService.createAuthenticatedServiceRequestWithImages,
    ).not.toHaveBeenCalled();
  });
});

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { configureApiSecurity } from './../src/api-security';
import { OTP_PROVIDER, type OtpProvider } from './../src/otp-provider';

describe('provider login IP rate limiting (e2e)', () => {
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

  afterEach(async () => {
    await app.close();
  });

  it('rate limits provider logins by client IP across rotating access codes', async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await request(app.getHttpServer())
        .post('/provider/auth/login')
        .send({ accessCode: `rotating-invalid-${randomUUID()}` })
        .expect(401);
    }
    await request(app.getHttpServer())
      .post('/provider/auth/login')
      .send({ accessCode: `rotating-invalid-${randomUUID()}` })
      .expect(429);
  });
});

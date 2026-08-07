import { HttpException } from '@nestjs/common';
import {
  PublicAuthRateLimiter,
  type PublicAuthAttemptStore,
} from './public-auth-rate-limiter.service';

describe('PublicAuthRateLimiter', () => {
  it('rejects an eleventh OTP request from the same client IP in one window', async () => {
    const reservePublicAuthAttempt = jest.fn().mockResolvedValue(11);
    const store: jest.Mocked<PublicAuthAttemptStore> = {
      reservePublicAuthAttempt,
    };
    const limiter = new PublicAuthRateLimiter(store, () => 0);

    await expect(
      limiter.reserveOtpRequest('198.51.100.7'),
    ).rejects.toMatchObject<HttpException>({ status: 429 });
    expect(reservePublicAuthAttempt).toHaveBeenCalledWith(
      'customer_otp_request',
      expect.stringMatching(/^[a-f0-9]{64}$/),
      new Date(0),
    );
  });

  it('allows OTP verification attempts below the client-IP limit', async () => {
    const reservePublicAuthAttempt = jest.fn().mockResolvedValue(20);
    const store: jest.Mocked<PublicAuthAttemptStore> = {
      reservePublicAuthAttempt,
    };
    const limiter = new PublicAuthRateLimiter(store, () => 0);

    await expect(
      limiter.reserveOtpVerification('2001:db8::1'),
    ).resolves.toBeUndefined();
  });

  it('reserves provider login attempts with the provider_login scope', async () => {
    const reservePublicAuthAttempt = jest.fn().mockResolvedValue(1);
    const store: jest.Mocked<PublicAuthAttemptStore> = {
      reservePublicAuthAttempt,
    };
    const limiter = new PublicAuthRateLimiter(store, () => 0);

    await expect(
      limiter.reserveProviderLogin('198.51.100.9'),
    ).resolves.toBeUndefined();
    expect(reservePublicAuthAttempt).toHaveBeenCalledWith(
      'provider_login',
      expect.stringMatching(/^[a-f0-9]{64}$/),
      new Date(0),
    );
  });

  it('rejects provider logins beyond the client-IP limit in one window', async () => {
    const reservePublicAuthAttempt = jest.fn().mockResolvedValue(21);
    const store: jest.Mocked<PublicAuthAttemptStore> = {
      reservePublicAuthAttempt,
    };
    const limiter = new PublicAuthRateLimiter(store, () => 0);

    await expect(
      limiter.reserveProviderLogin('198.51.100.10'),
    ).rejects.toMatchObject<HttpException>({ status: 429 });
  });
});

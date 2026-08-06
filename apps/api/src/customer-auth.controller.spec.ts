import { AppController } from './app.controller';
import type { AppService } from './app.service';
import type { CustomerAuthService } from './customer-auth.service';
import type { StaffAuditService } from './staff-audit.service';
import type { StaffAuthService } from './staff-auth.service';

describe('AppController customer OTP integration', () => {
  it('uses the production customer-auth service without returning a development OTP', async () => {
    const legacyAppService = {
      requestOtp: jest.fn().mockReturnValue({
        challengeId: 'legacy-challenge',
        devOtp: '123456',
      }),
    };
    const customerAuthService = {
      requestOtp: jest.fn().mockResolvedValue({
        challengeId: 'opaque-challenge',
      }),
      verifyOtp: jest.fn(),
    };
    const publicAuthRateLimiter = {
      reserveOtpRequest: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new AppController(
      legacyAppService as unknown as AppService,
      {} as StaffAuthService,
      {} as StaffAuditService,
      customerAuthService as unknown as CustomerAuthService,
      undefined,
      publicAuthRateLimiter as never,
    );

    await expect(
      controller.requestOtp(
        { ip: '198.51.100.7' } as import('express').Request,
        { phone: '+966500000001' },
      ),
    ).resolves.toEqual({
      challengeId: 'opaque-challenge',
    });
    expect(publicAuthRateLimiter.reserveOtpRequest).toHaveBeenCalledWith(
      '198.51.100.7',
    );
    expect(customerAuthService.requestOtp).toHaveBeenCalledWith(
      '+966500000001',
    );
    expect(legacyAppService.requestOtp).not.toHaveBeenCalled();
  });
});

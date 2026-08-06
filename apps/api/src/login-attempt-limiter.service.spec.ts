import { HttpException } from '@nestjs/common';
import {
  LoginAttemptLimiter,
  type LoginAttemptStore,
} from './login-attempt-limiter.service';

describe('LoginAttemptLimiter', () => {
  it('blocks an authentication subject after the configured failure limit', async () => {
    const store: jest.Mocked<LoginAttemptStore> = {
      countRecentLoginFailures: jest.fn().mockResolvedValue(5),
      recordLoginFailure: jest.fn(),
      clearLoginFailures: jest.fn(),
    };
    const limiter = new LoginAttemptLimiter(store);

    await expect(
      limiter.assertAllowed('staff_login', 'operator@example.com'),
    ).rejects.toMatchObject<HttpException>({ status: 429 });
  });

  it('hashes the subject before recording and clearing failures', async () => {
    const recordLoginFailure = jest.fn().mockResolvedValue(undefined);
    const clearLoginFailures = jest.fn().mockResolvedValue(undefined);
    const store: jest.Mocked<LoginAttemptStore> = {
      countRecentLoginFailures: jest.fn().mockResolvedValue(0),
      recordLoginFailure,
      clearLoginFailures,
    };
    const limiter = new LoginAttemptLimiter(store);

    await limiter.recordFailure('provider_login', 'provider-access-code');
    await limiter.clearFailures('provider_login', 'provider-access-code');

    expect(recordLoginFailure).toHaveBeenCalledWith(
      'provider_login',
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
    expect(clearLoginFailures).toHaveBeenCalledWith(
      'provider_login',
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
  });
});

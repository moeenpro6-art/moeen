/* eslint-disable @typescript-eslint/unbound-method */

import { CustomerAuthService } from './customer-auth.service';
import type { OtpProvider } from './otp-provider';

describe('CustomerAuthService', () => {
  it('starts an Arabic OTP verification and returns only an opaque challenge ID', async () => {
    const otpProvider: jest.Mocked<OtpProvider> = {
      startVerification: jest.fn().mockResolvedValue(undefined),
      checkVerification: jest.fn(),
    };
    const service = new CustomerAuthService(
      {
        upsertCustomer: jest.fn(),
        createCustomerSession: jest.fn(),
      },
      otpProvider,
    );

    const result = await service.requestOtp('+966500000001');
    expect(typeof result.challengeId).toBe('string');
    expect(otpProvider.startVerification).toHaveBeenCalledWith({
      phone: '+966500000001',
      locale: 'ar',
    });
  });

  it('creates a customer session only after the provider approves the code', async () => {
    const customer = { id: 'CUS-1001', phone: '+966500000001' };
    const store = {
      upsertCustomer: jest.fn().mockResolvedValue(customer),
      createCustomerSession: jest.fn().mockResolvedValue(undefined),
    };
    const otpProvider: jest.Mocked<OtpProvider> = {
      startVerification: jest.fn().mockResolvedValue(undefined),
      checkVerification: jest.fn().mockResolvedValue('approved'),
    };
    const service = new CustomerAuthService(store, otpProvider);
    const challenge = await service.requestOtp(customer.phone);

    const verified = await service.verifyOtp(challenge.challengeId, '123456');

    expect(otpProvider.checkVerification).toHaveBeenCalledWith({
      phone: customer.phone,
      code: '123456',
    });
    expect(store.upsertCustomer).toHaveBeenCalledWith(customer.phone);
    expect(store.createCustomerSession).toHaveBeenCalledWith(
      customer.id,
      verified.token,
    );
  });

  it('recovers an OTP challenge after the API service is recreated', async () => {
    const challenges = new Map<
      string,
      {
        challengeId: string;
        phone: string;
        expiresAt: Date;
        failedAttempts: number;
      }
    >();
    const customer = { id: 'CUS-1001', phone: '+966500000001' };
    const store = {
      upsertCustomer: jest.fn().mockResolvedValue(customer),
      createCustomerSession: jest.fn().mockResolvedValue(undefined),
      createOtpChallenge: jest
        .fn()
        .mockImplementation(
          (challenge: {
            challengeId: string;
            phone: string;
            expiresAt: Date;
          }) => {
            challenges.set(challenge.challengeId, {
              ...challenge,
              failedAttempts: 0,
            });
            return Promise.resolve();
          },
        ),
      findOtpChallenge: jest
        .fn()
        .mockImplementation((challengeId: string) =>
          Promise.resolve(challenges.get(challengeId)),
        ),
    };
    const otpProvider: jest.Mocked<OtpProvider> = {
      startVerification: jest.fn().mockResolvedValue(undefined),
      checkVerification: jest.fn().mockResolvedValue('approved'),
    };
    const firstService = new CustomerAuthService(store, otpProvider);
    const challenge = await firstService.requestOtp(customer.phone);
    const restartedService = new CustomerAuthService(store, otpProvider);

    await expect(
      restartedService.verifyOtp(challenge.challengeId, '123456'),
    ).resolves.toMatchObject({ customer });
  });

  it('reserves a persisted OTP attempt before calling the verification provider', async () => {
    const customer = { id: 'CUS-1001', phone: '+966****0001' };
    const reserveOtpVerificationAttempt = jest.fn().mockResolvedValue({
      phone: customer.phone,
      expiresAt: new Date(Date.now() + 60_000),
      failedAttempts: 1,
    });
    const store = {
      upsertCustomer: jest.fn().mockResolvedValue(customer),
      createCustomerSession: jest.fn().mockResolvedValue(undefined),
      reserveOtpVerificationAttempt,
      consumeOtpChallenge: jest.fn().mockResolvedValue(true),
    };
    const otpProvider: jest.Mocked<OtpProvider> = {
      startVerification: jest.fn(),
      checkVerification: jest.fn().mockResolvedValue('approved'),
    };
    const service = new CustomerAuthService(store, otpProvider);

    await expect(service.verifyOtp('challenge-id', '123456')).resolves.toEqual(
      expect.objectContaining({ customer }),
    );
    expect(reserveOtpVerificationAttempt).toHaveBeenCalledWith('challenge-id');
    expect(otpProvider.checkVerification).toHaveBeenCalledWith({
      phone: customer.phone,
      code: '123456',
    });
  });

  it('allows a persisted approved OTP challenge to create only one session', async () => {
    let storedChallenge:
      | {
          challengeId: string;
          phone: string;
          expiresAt: Date;
          failedAttempts: number;
        }
      | undefined;
    let consumed = false;
    const store = {
      upsertCustomer: jest.fn().mockResolvedValue({
        id: 'CUS-1001',
        phone: '+966500000001',
      }),
      createCustomerSession: jest.fn(),
      createOtpChallenge: jest
        .fn()
        .mockImplementation(
          (challenge: {
            challengeId: string;
            phone: string;
            expiresAt: Date;
          }) => {
            storedChallenge = { ...challenge, failedAttempts: 0 };
            return Promise.resolve();
          },
        ),
      findOtpChallenge: jest
        .fn()
        .mockImplementation(() => Promise.resolve(storedChallenge)),
      consumeOtpChallenge: jest.fn().mockImplementation(() => {
        if (!storedChallenge || consumed) return Promise.resolve(false);
        consumed = true;
        return Promise.resolve(true);
      }),
    };
    const otpProvider: jest.Mocked<OtpProvider> = {
      startVerification: jest.fn().mockResolvedValue(undefined),
      checkVerification: jest.fn().mockResolvedValue('approved'),
    };
    const service = new CustomerAuthService(store, otpProvider);
    const challenge = await service.requestOtp('+966500000001');

    await expect(
      service.verifyOtp(challenge.challengeId, '123456'),
    ).resolves.toBeDefined();
    await expect(
      service.verifyOtp(challenge.challengeId, '123456'),
    ).rejects.toMatchObject({ status: 401 });
    expect(store.createCustomerSession).toHaveBeenCalledTimes(1);
  });

  it('preserves failed-attempt limits after the API service is recreated', async () => {
    const challenges = new Map<
      string,
      {
        challengeId: string;
        phone: string;
        expiresAt: Date;
        failedAttempts: number;
      }
    >();
    const store = {
      upsertCustomer: jest.fn(),
      createCustomerSession: jest.fn(),
      createOtpChallenge: jest
        .fn()
        .mockImplementation(
          (challenge: {
            challengeId: string;
            phone: string;
            expiresAt: Date;
          }) => {
            challenges.set(challenge.challengeId, {
              ...challenge,
              failedAttempts: 0,
            });
            return Promise.resolve();
          },
        ),
      findOtpChallenge: jest.fn().mockImplementation((challengeId: string) => {
        const challenge = challenges.get(challengeId);
        return Promise.resolve(challenge ? { ...challenge } : undefined);
      }),
      recordOtpFailure: jest.fn().mockImplementation((challengeId: string) => {
        const challenge = challenges.get(challengeId);
        if (!challenge) return Promise.resolve(undefined);
        challenge.failedAttempts += 1;
        return Promise.resolve(challenge.failedAttempts);
      }),
    };
    const otpProvider: jest.Mocked<OtpProvider> = {
      startVerification: jest.fn().mockResolvedValue(undefined),
      checkVerification: jest.fn().mockResolvedValue('pending'),
    };
    const firstService = new CustomerAuthService(store, otpProvider);
    const challenge = await firstService.requestOtp('+966500000001');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        firstService.verifyOtp(challenge.challengeId, 'incorrect'),
      ).rejects.toMatchObject({ status: 401 });
    }

    const restartedService = new CustomerAuthService(store, otpProvider);
    await expect(
      restartedService.verifyOtp(challenge.challengeId, 'incorrect'),
    ).rejects.toMatchObject({ status: 429 });
  });

  it('uses the durable resend limit after the API service is recreated', async () => {
    const otpProvider: jest.Mocked<OtpProvider> = {
      startVerification: jest.fn().mockResolvedValue(undefined),
      checkVerification: jest.fn(),
    };
    const store = {
      upsertCustomer: jest.fn(),
      createCustomerSession: jest.fn(),
      reserveOtpRequest: jest
        .fn()
        .mockResolvedValueOnce('accepted')
        .mockResolvedValueOnce('cooldown'),
    };
    const firstService = new CustomerAuthService(store, otpProvider);
    await firstService.requestOtp('+966500000001');

    const restartedService = new CustomerAuthService(store, otpProvider);
    await expect(
      restartedService.requestOtp('+966500000001'),
    ).rejects.toMatchObject({ status: 429 });
    expect(otpProvider.startVerification).toHaveBeenCalledTimes(1);
  });

  it('enforces a resend cooldown without calling the provider again', async () => {
    const otpProvider: jest.Mocked<OtpProvider> = {
      startVerification: jest.fn().mockResolvedValue(undefined),
      checkVerification: jest.fn(),
    };
    const service = new CustomerAuthService(
      {
        upsertCustomer: jest.fn(),
        createCustomerSession: jest.fn(),
      },
      otpProvider,
    );

    await service.requestOtp('+966500000001');

    await expect(service.requestOtp('+966500000001')).rejects.toMatchObject({
      status: 429,
    });
    expect(otpProvider.startVerification).toHaveBeenCalledTimes(1);
  });

  it('does not check an expired challenge with the provider', async () => {
    let now = 0;
    const otpProvider: jest.Mocked<OtpProvider> = {
      startVerification: jest.fn().mockResolvedValue(undefined),
      checkVerification: jest.fn().mockResolvedValue('approved'),
    };
    const service = new CustomerAuthService(
      {
        upsertCustomer: jest.fn(),
        createCustomerSession: jest.fn(),
      },
      otpProvider,
      () => now,
    );
    const challenge = await service.requestOtp('+966500000001');
    now += 10 * 60_000 + 1;

    await expect(
      service.verifyOtp(challenge.challengeId, '123456'),
    ).rejects.toMatchObject({
      status: 401,
    });
    expect(otpProvider.checkVerification).not.toHaveBeenCalled();
  });

  it('blocks further checks after five failed attempts for one challenge', async () => {
    const otpProvider: jest.Mocked<OtpProvider> = {
      startVerification: jest.fn().mockResolvedValue(undefined),
      checkVerification: jest.fn().mockResolvedValue('pending'),
    };
    const service = new CustomerAuthService(
      {
        upsertCustomer: jest.fn(),
        createCustomerSession: jest.fn(),
      },
      otpProvider,
    );
    const challenge = await service.requestOtp('+966500000001');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        service.verifyOtp(challenge.challengeId, 'incorrect'),
      ).rejects.toMatchObject({ status: 401 });
    }

    await expect(
      service.verifyOtp(challenge.challengeId, 'incorrect'),
    ).rejects.toMatchObject({ status: 429 });
    expect(otpProvider.checkVerification).toHaveBeenCalledTimes(5);
  });

  it('limits each phone to five OTP requests per hour', async () => {
    let now = 0;
    const otpProvider: jest.Mocked<OtpProvider> = {
      startVerification: jest.fn().mockResolvedValue(undefined),
      checkVerification: jest.fn(),
    };
    const service = new CustomerAuthService(
      {
        upsertCustomer: jest.fn(),
        createCustomerSession: jest.fn(),
      },
      otpProvider,
      () => now,
    );

    for (let request = 0; request < 5; request += 1) {
      await service.requestOtp('+966500000001');
      now += 60_000;
    }

    await expect(service.requestOtp('+966500000001')).rejects.toMatchObject({
      status: 429,
    });
    expect(otpProvider.startVerification).toHaveBeenCalledTimes(5);
  });
});

/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import { OtpProviderUnavailableError } from './otp-provider';
import { TwilioVerifyProvider } from './twilio-verify.provider';

describe('TwilioVerifyProvider', () => {
  it('starts an Arabic SMS verification through the configured Verify Service', async () => {
    const request = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: jest.fn().mockResolvedValue({ sid: 'VE123', status: 'pending' }),
    });
    const provider = new TwilioVerifyProvider(
      {
        apiKey: 'SK_test_key',
        apiSecret: 'test-secret',
        verifyServiceSid: 'VA123',
      },
      request,
    );

    await provider.startVerification({
      phone: '+966500000001',
      locale: 'ar',
    });

    expect(request).toHaveBeenCalledWith(
      'https://verify.twilio.com/v2/Services/VA123/Verifications',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: expect.stringMatching(/^Basic /),
        }),
        body: 'To=%2B966500000001&Channel=sms&Locale=ar',
      }),
    );
  });

  it('returns approval only when Twilio approves the submitted code', async () => {
    const request = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({ status: 'approved' }),
    });
    const provider = new TwilioVerifyProvider(
      {
        apiKey: 'SK_test_key',
        apiSecret: 'test-secret',
        verifyServiceSid: 'VA123',
      },
      request,
    );

    await expect(
      provider.checkVerification({
        phone: '+966500000001',
        code: '123456',
      }),
    ).resolves.toBe('approved');

    expect(request).toHaveBeenCalledWith(
      'https://verify.twilio.com/v2/Services/VA123/VerificationCheck',
      expect.objectContaining({
        method: 'POST',
        body: 'To=%2B966500000001&Code=123456',
      }),
    );
  });

  it('maps a provider rejection to a safe availability error', async () => {
    const request = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: jest.fn(),
    });
    const provider = new TwilioVerifyProvider(
      {
        apiKey: 'SK_test_key',
        apiSecret: 'test-secret',
        verifyServiceSid: 'VA123',
      },
      request,
    );

    await expect(
      provider.startVerification({ phone: '+966500000001', locale: 'ar' }),
    ).rejects.toBeInstanceOf(OtpProviderUnavailableError);
  });

  it('does not leak transport failures from Twilio', async () => {
    const request = jest.fn().mockRejectedValue(new Error('socket failure'));
    const provider = new TwilioVerifyProvider(
      {
        apiKey: 'SK_test_key',
        apiSecret: 'test-secret',
        verifyServiceSid: 'VA123',
      },
      request,
    );

    await expect(
      provider.startVerification({ phone: '+966500000001', locale: 'ar' }),
    ).rejects.toBeInstanceOf(OtpProviderUnavailableError);
  });
});

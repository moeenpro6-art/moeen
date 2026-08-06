import { otpProviderFromEnvironment } from './otp-provider.factory';
import { TwilioVerifyProvider } from './twilio-verify.provider';

describe('otpProviderFromEnvironment', () => {
  it('selects Twilio Verify only when it is explicitly configured', () => {
    expect(
      otpProviderFromEnvironment({
        OTP_PROVIDER: 'twilio_verify',
        TWILIO_API_KEY: 'SK_key',
        TWILIO_API_SECRET: 'secret',
        TWILIO_VERIFY_SERVICE_SID: 'VA_service',
      }),
    ).toBeInstanceOf(TwilioVerifyProvider);
  });
});

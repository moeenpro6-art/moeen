import { twilioVerifyConfigFromEnvironment } from './twilio-verify.config';

describe('twilioVerifyConfigFromEnvironment', () => {
  it('loads the three required Twilio Verify settings', () => {
    expect(
      twilioVerifyConfigFromEnvironment({
        TWILIO_API_KEY: 'SK_key',
        TWILIO_API_SECRET: 'secret',
        TWILIO_VERIFY_SERVICE_SID: 'VA_service',
      }),
    ).toEqual({
      apiKey: 'SK_key',
      apiSecret: 'secret',
      verifyServiceSid: 'VA_service',
    });
  });
});

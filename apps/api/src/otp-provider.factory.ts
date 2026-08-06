import type { OtpProvider } from './otp-provider';
import { twilioVerifyConfigFromEnvironment } from './twilio-verify.config';
import { TwilioVerifyProvider } from './twilio-verify.provider';

type OtpEnvironment = Partial<
  Pick<
    NodeJS.ProcessEnv,
    | 'OTP_PROVIDER'
    | 'TWILIO_API_KEY'
    | 'TWILIO_API_SECRET'
    | 'TWILIO_VERIFY_SERVICE_SID'
  >
>;

export function otpProviderFromEnvironment(
  environment: OtpEnvironment,
): OtpProvider {
  if (environment.OTP_PROVIDER?.trim() !== 'twilio_verify') {
    throw new Error('OTP_PROVIDER must be set to twilio_verify');
  }

  return new TwilioVerifyProvider(
    twilioVerifyConfigFromEnvironment(environment),
  );
}

import type { TwilioVerifyConfig } from './twilio-verify.provider';

type TwilioEnvironment = Partial<
  Pick<
    NodeJS.ProcessEnv,
    'TWILIO_API_KEY' | 'TWILIO_API_SECRET' | 'TWILIO_VERIFY_SERVICE_SID'
  >
>;

export function twilioVerifyConfigFromEnvironment(
  environment: TwilioEnvironment,
): TwilioVerifyConfig {
  return {
    apiKey: requiredEnvironmentValue(environment, 'TWILIO_API_KEY'),
    apiSecret: requiredEnvironmentValue(environment, 'TWILIO_API_SECRET'),
    verifyServiceSid: requiredEnvironmentValue(
      environment,
      'TWILIO_VERIFY_SERVICE_SID',
    ),
  };
}

function requiredEnvironmentValue(
  environment: TwilioEnvironment,
  name: keyof TwilioEnvironment,
): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

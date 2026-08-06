import { OtpProviderUnavailableError } from './otp-provider';
import type {
  CheckOtpVerification,
  OtpProvider,
  OtpVerificationStatus,
  StartOtpVerification,
} from './otp-provider';

export type TwilioVerifyConfig = {
  apiKey: string;
  apiSecret: string;
  verifyServiceSid: string;
};

type TwilioResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

export type TwilioRequest = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
  },
) => Promise<TwilioResponse>;

export class TwilioVerifyProvider implements OtpProvider {
  private static readonly baseUrl = 'https://verify.twilio.com/v2';

  constructor(
    private readonly config: TwilioVerifyConfig,
    private readonly request: TwilioRequest = globalThis.fetch,
  ) {}

  async startVerification(input: StartOtpVerification): Promise<void> {
    const response = await this.post('/Verifications', {
      To: input.phone,
      Channel: 'sms',
      Locale: input.locale,
    });
    if (!response.ok) {
      throw new OtpProviderUnavailableError();
    }
  }

  async checkVerification(
    input: CheckOtpVerification,
  ): Promise<OtpVerificationStatus> {
    const response = await this.post('/VerificationCheck', {
      To: input.phone,
      Code: input.code,
    });
    if (!response.ok) {
      throw new OtpProviderUnavailableError();
    }

    const body = (await response.json()) as { status?: unknown };
    return body.status === 'approved' ? 'approved' : 'pending';
  }

  private async post(
    resource: '/Verifications' | '/VerificationCheck',
    values: Record<string, string>,
  ): Promise<TwilioResponse> {
    const authorization = Buffer.from(
      `${this.config.apiKey}:${this.config.apiSecret}`,
    ).toString('base64');
    try {
      return await this.request(
        `${TwilioVerifyProvider.baseUrl}/Services/${this.config.verifyServiceSid}${resource}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${authorization}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams(values).toString(),
        },
      );
    } catch {
      throw new OtpProviderUnavailableError();
    }
  }
}

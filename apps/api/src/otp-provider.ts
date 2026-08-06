export const OTP_PROVIDER = Symbol('OTP_PROVIDER');

export type StartOtpVerification = {
  phone: string;
  locale: 'ar';
};

export type CheckOtpVerification = {
  phone: string;
  code: string;
};

export type OtpVerificationStatus = 'approved' | 'pending';

export class OtpProviderUnavailableError extends Error {
  constructor() {
    super('OTP provider is currently unavailable');
    this.name = 'OtpProviderUnavailableError';
  }
}

export interface OtpProvider {
  startVerification(input: StartOtpVerification): Promise<void>;
  checkVerification(
    input: CheckOtpVerification,
  ): Promise<OtpVerificationStatus>;
}

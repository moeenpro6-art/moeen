import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import type { ServiceRequestStore } from './app.service';
import { ServiceRequestRepository } from './service-request.repository';
import { OTP_PROVIDER, type OtpProvider } from './otp-provider';

const RESEND_COOLDOWN_MS = 60_000;
const OTP_CHALLENGE_TTL_MS = 10 * 60_000;
const OTP_REQUEST_WINDOW_MS = 60 * 60_000;
const MAX_OTP_REQUESTS_PER_PHONE_PER_WINDOW = 5;
const MAX_VERIFICATION_ATTEMPTS = 5;

type OtpChallenge = {
  phone: string;
  expiresAt: Date;
  failedAttempts: number;
};

type CustomerAuthStore = Pick<
  ServiceRequestStore,
  'upsertCustomer' | 'createCustomerSession'
> & {
  revokeCustomerSession?: (token: string) => Promise<void>;
  createOtpChallenge?: (input: {
    challengeId: string;
    phone: string;
    expiresAt: Date;
  }) => Promise<void>;
  reserveOtpVerificationAttempt?: (challengeId: string) => Promise<
    | {
        phone: string;
        expiresAt: Date;
        failedAttempts: number;
      }
    | undefined
  >;
  findOtpChallenge?: (challengeId: string) => Promise<
    | {
        phone: string;
        expiresAt: Date;
        failedAttempts: number;
      }
    | undefined
  >;
  recordOtpFailure?: (challengeId: string) => Promise<number | undefined>;
  consumeOtpChallenge?: (challengeId: string) => Promise<boolean>;
  reserveOtpRequest?: (
    phone: string,
    requestedAt: Date,
  ) => Promise<'accepted' | 'cooldown' | 'limit'>;
};

@Injectable()
export class CustomerAuthService {
  private readonly challenges = new Map<string, OtpChallenge>();
  private readonly requestTimesByPhone = new Map<string, number[]>();

  constructor(
    @Inject(ServiceRequestRepository)
    private readonly store: CustomerAuthStore,
    @Inject(OTP_PROVIDER)
    private readonly otpProvider: OtpProvider,
    @Optional()
    private readonly now: () => number = Date.now,
  ) {}

  async requestOtp(phone: string): Promise<{ challengeId: string }> {
    if (!/^\+9665\d{8}$/.test(phone)) {
      throw new BadRequestException('Invalid Saudi mobile number');
    }

    const requestedAt = this.now();
    if (this.store.reserveOtpRequest) {
      const reservation = await this.store.reserveOtpRequest(
        phone,
        new Date(requestedAt),
      );
      if (reservation === 'cooldown') {
        throw new HttpException(
          'Please wait before requesting another OTP',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (reservation === 'limit') {
        throw new HttpException(
          'OTP request limit exceeded',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    } else {
      const recentRequestTimes = (
        this.requestTimesByPhone.get(phone) ?? []
      ).filter((time) => requestedAt - time < OTP_REQUEST_WINDOW_MS);
      const previousRequestAt = recentRequestTimes.at(-1);
      if (
        previousRequestAt !== undefined &&
        requestedAt - previousRequestAt < RESEND_COOLDOWN_MS
      ) {
        throw new HttpException(
          'Please wait before requesting another OTP',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (recentRequestTimes.length >= MAX_OTP_REQUESTS_PER_PHONE_PER_WINDOW) {
        throw new HttpException(
          'OTP request limit exceeded',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      this.requestTimesByPhone.set(phone, [...recentRequestTimes, requestedAt]);
    }

    await this.otpProvider.startVerification({ phone, locale: 'ar' });
    const challengeId = randomUUID();
    const challenge = {
      phone,
      expiresAt: new Date(requestedAt + OTP_CHALLENGE_TTL_MS),
      failedAttempts: 0,
    };
    if (this.store.createOtpChallenge) {
      await this.store.createOtpChallenge({ challengeId, ...challenge });
    } else {
      this.challenges.set(challengeId, challenge);
    }
    return { challengeId };
  }

  async verifyOtp(
    challengeId: string,
    code: string,
  ): Promise<{
    customer: Awaited<ReturnType<CustomerAuthStore['upsertCustomer']>>;
    token: string;
  }> {
    const usedPersistentReservation =
      !!this.store.reserveOtpVerificationAttempt;
    const challenge = usedPersistentReservation
      ? await this.store.reserveOtpVerificationAttempt!(challengeId)
      : this.store.findOtpChallenge
        ? await this.store.findOtpChallenge(challengeId)
        : this.challenges.get(challengeId);
    if (!challenge) {
      const existingChallenge = this.store.findOtpChallenge
        ? await this.store.findOtpChallenge(challengeId)
        : undefined;
      if (
        existingChallenge &&
        this.now() <= existingChallenge.expiresAt.getTime() &&
        existingChallenge.failedAttempts >= MAX_VERIFICATION_ATTEMPTS
      ) {
        throw new HttpException(
          'OTP verification attempts exceeded',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw new UnauthorizedException('Invalid OTP challenge');
    }
    if (
      !usedPersistentReservation &&
      this.now() > challenge.expiresAt.getTime()
    ) {
      this.challenges.delete(challengeId);
      throw new UnauthorizedException('OTP challenge expired');
    }
    if (
      !usedPersistentReservation &&
      challenge.failedAttempts >= MAX_VERIFICATION_ATTEMPTS
    ) {
      throw new HttpException(
        'OTP verification attempts exceeded',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const status = await this.otpProvider.checkVerification({
      phone: challenge.phone,
      code,
    });
    if (status !== 'approved') {
      if (!usedPersistentReservation && this.store.recordOtpFailure) {
        await this.store.recordOtpFailure(challengeId);
      } else if (!usedPersistentReservation) {
        challenge.failedAttempts += 1;
      }
      throw new UnauthorizedException('Invalid OTP');
    }

    if (this.store.consumeOtpChallenge) {
      const consumed = await this.store.consumeOtpChallenge(challengeId);
      if (!consumed) {
        throw new UnauthorizedException('Invalid OTP challenge');
      }
    } else {
      this.challenges.delete(challengeId);
    }
    const customer = await this.store.upsertCustomer(challenge.phone);
    const token = randomUUID();
    await this.store.createCustomerSession(customer.id, token);
    return { customer, token };
  }

  async logout(token: string): Promise<void> {
    if (!this.store.revokeCustomerSession) {
      throw new Error('Customer session revocation is not configured');
    }
    await this.store.revokeCustomerSession(token);
  }
}

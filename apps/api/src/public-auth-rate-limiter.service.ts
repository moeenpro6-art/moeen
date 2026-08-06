import { createHash } from 'node:crypto';
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { StaffAuthRepository } from './staff-auth.repository';

export type PublicAuthAttemptScope =
  'customer_otp_request' | 'customer_otp_verification';

export interface PublicAuthAttemptStore {
  reservePublicAuthAttempt(
    scope: PublicAuthAttemptScope,
    subjectHash: string,
    windowStartedAt: Date,
  ): Promise<number>;
}

@Injectable()
export class PublicAuthRateLimiter {
  private static readonly windowMs = 10 * 60_000;
  private static readonly maximumOtpRequests = 10;
  private static readonly maximumOtpVerifications = 20;

  constructor(
    @Inject(StaffAuthRepository)
    private readonly store: PublicAuthAttemptStore,
    @Optional() private readonly now: () => number = Date.now,
  ) {}

  reserveOtpRequest(clientIp: string): Promise<void> {
    return this.reserve(
      'customer_otp_request',
      clientIp,
      PublicAuthRateLimiter.maximumOtpRequests,
    );
  }

  reserveOtpVerification(clientIp: string): Promise<void> {
    return this.reserve(
      'customer_otp_verification',
      clientIp,
      PublicAuthRateLimiter.maximumOtpVerifications,
    );
  }

  private async reserve(
    scope: PublicAuthAttemptScope,
    clientIp: string,
    maximumAttempts: number,
  ): Promise<void> {
    const attempts = await this.store.reservePublicAuthAttempt(
      scope,
      this.subjectHash(scope, clientIp),
      this.windowStartedAt(),
    );
    if (attempts > maximumAttempts) {
      throw new HttpException(
        'Too many authentication attempts',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private windowStartedAt(): Date {
    const now = this.now();
    return new Date(
      Math.floor(now / PublicAuthRateLimiter.windowMs) *
        PublicAuthRateLimiter.windowMs,
    );
  }

  private subjectHash(scope: PublicAuthAttemptScope, clientIp: string): string {
    return createHash('sha256')
      .update(`${scope}\u0000${clientIp}`)
      .digest('hex');
  }
}

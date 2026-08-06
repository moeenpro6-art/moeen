import { createHash } from 'node:crypto';
import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { StaffAuthRepository } from './staff-auth.repository';

export type LoginAttemptScope = 'staff_login' | 'provider_login';

export interface LoginAttemptStore {
  countRecentLoginFailures(
    scope: LoginAttemptScope,
    subjectHash: string,
    since: Date,
  ): Promise<number>;
  recordLoginFailure(
    scope: LoginAttemptScope,
    subjectHash: string,
  ): Promise<void>;
  clearLoginFailures(
    scope: LoginAttemptScope,
    subjectHash: string,
  ): Promise<void>;
}

@Injectable()
export class LoginAttemptLimiter {
  private static readonly maximumFailures = 5;
  private static readonly failureWindowMs = 15 * 60_000;

  constructor(
    @Inject(StaffAuthRepository) private readonly store: LoginAttemptStore,
  ) {}

  async assertAllowed(
    scope: LoginAttemptScope,
    subject: string,
  ): Promise<void> {
    const failures = await this.store.countRecentLoginFailures(
      scope,
      this.subjectHash(scope, subject),
      new Date(Date.now() - LoginAttemptLimiter.failureWindowMs),
    );
    if (failures >= LoginAttemptLimiter.maximumFailures) {
      throw new HttpException(
        'Too many login attempts',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  recordFailure(scope: LoginAttemptScope, subject: string): Promise<void> {
    return this.store.recordLoginFailure(
      scope,
      this.subjectHash(scope, subject),
    );
  }

  clearFailures(scope: LoginAttemptScope, subject: string): Promise<void> {
    return this.store.clearLoginFailures(
      scope,
      this.subjectHash(scope, subject),
    );
  }

  private subjectHash(scope: LoginAttemptScope, subject: string): string {
    return createHash('sha256')
      .update(`${scope}\u0000${subject}`)
      .digest('hex');
  }
}

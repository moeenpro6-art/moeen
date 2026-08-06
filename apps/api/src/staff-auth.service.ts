import {
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { LoginAttemptLimiter } from './login-attempt-limiter.service';
import { StaffAuthRepository } from './staff-auth.repository';

const scrypt = promisify(scryptCallback);
const passwordKeyLength = 64;
const passwordHashPrefix = 'scrypt';

export type StaffRole = 'admin' | 'dispatcher' | 'support_agent';

export type StaffPrincipal = {
  id: string;
  email: string;
  displayName: string;
  role: StaffRole;
};

export type StoredStaff = StaffPrincipal & {
  passwordHash: string;
  isActive: boolean;
};

export interface StaffAuthStore {
  findStaffByEmail(email: string): Promise<StoredStaff | undefined>;
  createStaffSession(staffId: string, token: string): Promise<void>;
  findStaffBySession(token: string): Promise<StaffPrincipal | undefined>;
  revokeStaffSession(token: string): Promise<void>;
}

export async function hashStaffPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = (await scrypt(
    password,
    salt,
    passwordKeyLength,
  )) as Buffer;
  return `${passwordHashPrefix}$${salt}$${derivedKey.toString('hex')}`;
}

@Injectable()
export class StaffAuthService {
  constructor(
    @Inject(StaffAuthRepository) private readonly store: StaffAuthStore,
    private readonly loginAttemptLimiter?: LoginAttemptLimiter,
  ) {}

  static async verifyPassword(
    password: string,
    passwordHash: string,
  ): Promise<boolean> {
    const [prefix, salt, expectedKey] = passwordHash.split('$');
    if (
      prefix !== passwordHashPrefix ||
      !salt ||
      !expectedKey ||
      !/^[a-f0-9]+$/i.test(expectedKey)
    ) {
      return false;
    }

    const expected = Buffer.from(expectedKey, 'hex');
    const actual = (await scrypt(password, salt, passwordKeyLength)) as Buffer;
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }

  async login(
    email: string,
    password: string,
  ): Promise<{ staff: StaffPrincipal; token: string }> {
    const normalizedEmail = email.trim().toLowerCase();
    await this.loginAttemptLimiter?.assertAllowed(
      'staff_login',
      normalizedEmail,
    );
    const staff = normalizedEmail
      ? await this.store.findStaffByEmail(normalizedEmail)
      : undefined;
    const passwordIsValid =
      !!staff &&
      staff.isActive &&
      (await StaffAuthService.verifyPassword(password, staff.passwordHash));

    if (!passwordIsValid || !staff) {
      await this.loginAttemptLimiter?.recordFailure(
        'staff_login',
        normalizedEmail,
      );
      throw new UnauthorizedException('Invalid staff credentials');
    }

    const token = randomUUID();
    const principal: StaffPrincipal = {
      id: staff.id,
      email: staff.email,
      displayName: staff.displayName,
      role: staff.role,
    };
    await this.store.createStaffSession(principal.id, token);
    await this.loginAttemptLimiter?.clearFailures(
      'staff_login',
      normalizedEmail,
    );
    return { staff: principal, token };
  }

  async getCurrentStaff(token: string): Promise<StaffPrincipal> {
    const staff = await this.store.findStaffBySession(token);
    if (!staff) throw new UnauthorizedException('Unauthorized');
    return staff;
  }

  logout(token: string): Promise<void> {
    return this.store.revokeStaffSession(token);
  }
}

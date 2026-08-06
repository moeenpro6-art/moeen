import { randomUUID } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { ProviderAppPrincipal } from './app.service';
import { LoginAttemptLimiter } from './login-attempt-limiter.service';
import { ServiceRequestRepository } from './service-request.repository';

export interface ProviderAuthStore {
  findProviderByAccessCode(
    accessCode: string,
  ): Promise<ProviderAppPrincipal | undefined>;
  createProviderSession(providerId: string, token: string): Promise<void>;
  revokeProviderSession(token: string): Promise<void>;
  findProviderBySession(
    token: string,
  ): Promise<ProviderAppPrincipal | undefined>;
  updateProviderAvailability(
    providerId: string,
    available: boolean,
  ): Promise<ProviderAppPrincipal>;
}

@Injectable()
export class ProviderAuthService {
  constructor(
    @Inject(ServiceRequestRepository) private readonly store: ProviderAuthStore,
    private readonly loginAttemptLimiter?: LoginAttemptLimiter,
  ) {}

  async login(
    accessCode: string,
  ): Promise<{ provider: ProviderAppPrincipal; token: string }> {
    const normalizedAccessCode = accessCode.trim();
    await this.loginAttemptLimiter?.assertAllowed(
      'provider_login',
      normalizedAccessCode,
    );
    const provider =
      normalizedAccessCode.length >= 16
        ? await this.store.findProviderByAccessCode(normalizedAccessCode)
        : undefined;
    if (!provider) {
      await this.loginAttemptLimiter?.recordFailure(
        'provider_login',
        normalizedAccessCode,
      );
      throw new UnauthorizedException('Invalid provider credentials');
    }

    const token = randomUUID();
    await this.store.createProviderSession(provider.id, token);
    await this.loginAttemptLimiter?.clearFailures(
      'provider_login',
      normalizedAccessCode,
    );
    return { provider, token };
  }

  async getCurrentProvider(token: string): Promise<ProviderAppPrincipal> {
    const provider = await this.store.findProviderBySession(token);
    if (!provider) throw new UnauthorizedException('Unauthorized');
    return provider;
  }

  async logout(token: string): Promise<void> {
    await this.getCurrentProvider(token);
    await this.store.revokeProviderSession(token);
  }

  async updateMyAvailability(
    token: string,
    available: boolean,
  ): Promise<ProviderAppPrincipal> {
    if (typeof available !== 'boolean') {
      throw new UnauthorizedException('Invalid availability');
    }
    const provider = await this.getCurrentProvider(token);
    return this.store.updateProviderAvailability(provider.id, available);
  }
}

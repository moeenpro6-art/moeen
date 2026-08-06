import { UnauthorizedException } from '@nestjs/common';
import {
  ProviderAuthService,
  type ProviderAuthStore,
} from './provider-auth.service';

describe('ProviderAuthService', () => {
  const principal = {
    id: 'provider-1',
    name: 'فريق التبريد السريع',
    specialties: ['ac-cleaning'],
    serviceZone: 'بريدة',
    available: true,
  };

  it('creates an opaque provider session from an approved access code', async () => {
    const createProviderSession = jest.fn().mockResolvedValue(undefined);
    const store: jest.Mocked<ProviderAuthStore> = {
      findProviderByAccessCode: jest.fn().mockResolvedValue(principal),
      createProviderSession,
      revokeProviderSession: jest.fn(),
      findProviderBySession: jest.fn(),
      updateProviderAvailability: jest.fn(),
    };
    const service = new ProviderAuthService(store);

    const result = await service.login('provider-access-code-for-test');

    expect(result.provider).toEqual(principal);
    expect(result.token).toEqual(expect.any(String));
    expect(createProviderSession).toHaveBeenCalledWith(
      principal.id,
      result.token,
    );
  });

  it('rejects a short or unknown provider access code without creating a session', async () => {
    const createProviderSession = jest.fn();
    const store: jest.Mocked<ProviderAuthStore> = {
      findProviderByAccessCode: jest.fn().mockResolvedValue(undefined),
      createProviderSession,
      revokeProviderSession: jest.fn(),
      findProviderBySession: jest.fn(),
      updateProviderAvailability: jest.fn(),
    };
    const service = new ProviderAuthService(store);

    await expect(service.login('short')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(
      service.login('provider-access-code-for-test'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(createProviderSession).not.toHaveBeenCalled();
  });
});

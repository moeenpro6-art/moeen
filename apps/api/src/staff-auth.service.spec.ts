import { UnauthorizedException } from '@nestjs/common';
import {
  StaffAuthService,
  hashStaffPassword,
  type StaffAuthStore,
} from './staff-auth.service';

const activeStaff = {
  id: 'STAFF-1001',
  email: 'dispatcher@example.test',
  displayName: 'موظف التشغيل',
  role: 'dispatcher' as const,
};

describe('StaffAuthService', () => {
  it('verifies the password that was hashed and rejects a different password', async () => {
    const passwordHash = await hashStaffPassword('test-only password');

    await expect(
      StaffAuthService.verifyPassword('test-only password', passwordHash),
    ).resolves.toBe(true);
    await expect(
      StaffAuthService.verifyPassword('a different password', passwordHash),
    ).resolves.toBe(false);
  });

  it('creates a session and returns only a role-safe profile for valid credentials', async () => {
    const passwordHash = await hashStaffPassword('test-only password');
    const store: jest.Mocked<StaffAuthStore> = {
      findStaffByEmail: jest.fn().mockResolvedValue({
        ...activeStaff,
        passwordHash,
        isActive: true,
      }),
      createStaffSession: jest.fn().mockResolvedValue(undefined),
      findStaffBySession: jest.fn(),
      revokeStaffSession: jest.fn().mockResolvedValue(undefined),
    };
    const service = new StaffAuthService(store);

    const result = await service.login(
      '  DISPATCHER@example.test ',
      'test-only password',
    );

    expect(result.staff).toEqual(activeStaff);
    expect(result.staff).not.toHaveProperty('passwordHash');
    expect(result.token).toEqual(expect.any(String));
    expect(store.findStaffByEmail.mock.calls).toEqual([
      ['dispatcher@example.test'],
    ]);
    expect(store.createStaffSession.mock.calls).toEqual([
      [activeStaff.id, result.token],
    ]);
  });

  it('returns the same unauthorized error for a bad password and an inactive account', async () => {
    const passwordHash = await hashStaffPassword('test-only password');
    const inactiveStore: jest.Mocked<StaffAuthStore> = {
      findStaffByEmail: jest.fn().mockResolvedValue({
        ...activeStaff,
        passwordHash,
        isActive: false,
      }),
      createStaffSession: jest.fn(),
      findStaffBySession: jest.fn(),
      revokeStaffSession: jest.fn(),
    };
    const badPasswordStore: jest.Mocked<StaffAuthStore> = {
      findStaffByEmail: jest.fn().mockResolvedValue({
        ...activeStaff,
        passwordHash,
        isActive: true,
      }),
      createStaffSession: jest.fn(),
      findStaffBySession: jest.fn(),
      revokeStaffSession: jest.fn(),
    };

    await expect(
      new StaffAuthService(inactiveStore).login(
        activeStaff.email,
        'test-only password',
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      new StaffAuthService(badPasswordStore).login(
        activeStaff.email,
        'wrong test password',
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an unknown staff session and revokes a known session on logout', async () => {
    const store: jest.Mocked<StaffAuthStore> = {
      findStaffByEmail: jest.fn(),
      createStaffSession: jest.fn(),
      findStaffBySession: jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(activeStaff),
      revokeStaffSession: jest.fn().mockResolvedValue(undefined),
    };
    const service = new StaffAuthService(store);

    await expect(
      service.getCurrentStaff('unknown-session'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.getCurrentStaff('known-session')).resolves.toEqual(
      activeStaff,
    );
    await service.logout('known-session');

    expect(store.revokeStaffSession.mock.calls).toEqual([['known-session']]);
  });
});

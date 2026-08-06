import {
  StaffBootstrapService,
  readInitialAdminConfig,
  type StaffBootstrapStore,
} from './staff-bootstrap.service';
import { StaffAuthService } from './staff-auth.service';

describe('staff bootstrap', () => {
  it('does not bootstrap when all initial-admin settings are absent', () => {
    expect(readInitialAdminConfig({})).toBeUndefined();
  });

  it('rejects partially configured initial-admin settings', () => {
    expect(() =>
      readInitialAdminConfig({
        MOEEN_INITIAL_ADMIN_EMAIL: 'admin@example.test',
      }),
    ).toThrow('Initial staff administrator configuration is incomplete');
  });

  it('creates the configured initial admin without exposing the password', async () => {
    const store: jest.Mocked<StaffBootstrapStore> = {
      bootstrapInitialAdmin: jest.fn().mockResolvedValue({
        id: 'STF-1001',
        email: 'admin@example.test',
        displayName: 'مدير معين',
        role: 'admin',
      }),
    };
    const service = new StaffBootstrapService(store, {
      MOEEN_INITIAL_ADMIN_EMAIL: 'admin@example.test',
      MOEEN_INITIAL_ADMIN_NAME: 'مدير معين',
      MOEEN_INITIAL_ADMIN_PASSWORD: 'test-only password',
    });

    await service.bootstrap();

    const input = store.bootstrapInitialAdmin.mock.calls[0]?.[0];
    expect(input).toEqual(
      expect.objectContaining({
        email: 'admin@example.test',
        displayName: 'مدير معين',
      }),
    );
    expect(input).not.toHaveProperty('password');
    await expect(
      StaffAuthService.verifyPassword('test-only password', input.passwordHash),
    ).resolves.toBe(true);
  });
});

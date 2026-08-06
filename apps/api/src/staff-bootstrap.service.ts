import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { StaffAuthRepository } from './staff-auth.repository';
import { hashStaffPassword, type StaffPrincipal } from './staff-auth.service';

export const STAFF_ENVIRONMENT = 'staff_environment';

type Environment = Record<string, string | undefined>;

type InitialAdminConfig = {
  email: string;
  displayName: string;
  password: string;
};

export interface StaffBootstrapStore {
  bootstrapInitialAdmin(input: {
    email: string;
    displayName: string;
    passwordHash: string;
  }): Promise<StaffPrincipal>;
}

export function readInitialAdminConfig(
  environment: Environment,
): InitialAdminConfig | undefined {
  const email = environment.MOEEN_INITIAL_ADMIN_EMAIL?.trim();
  const displayName = environment.MOEEN_INITIAL_ADMIN_NAME?.trim();
  const password = environment.MOEEN_INITIAL_ADMIN_PASSWORD;
  const configuredValues = [email, displayName, password].filter(Boolean);

  if (configuredValues.length === 0) return undefined;
  if (configuredValues.length !== 3) {
    throw new Error('Initial staff administrator configuration is incomplete');
  }

  return { email: email!, displayName: displayName!, password: password! };
}

@Injectable()
export class StaffBootstrapService implements OnApplicationBootstrap {
  constructor(
    @Inject(StaffAuthRepository) private readonly store: StaffBootstrapStore,
    @Inject(STAFF_ENVIRONMENT) private readonly environment: Environment,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bootstrap();
  }

  async bootstrap(): Promise<void> {
    const config = readInitialAdminConfig(this.environment);
    if (!config) return;
    await this.store.bootstrapInitialAdmin({
      email: config.email,
      displayName: config.displayName,
      passwordHash: await hashStaffPassword(config.password),
    });
  }
}

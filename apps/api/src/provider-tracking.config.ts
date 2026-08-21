export const PROVIDER_TRACKING_CONFIG = Symbol('PROVIDER_TRACKING_CONFIG');

export type ProviderTrackingConfig = { enabled: boolean };

export function providerTrackingConfigFromEnvironment(
  environment: NodeJS.ProcessEnv,
): ProviderTrackingConfig {
  const mode = environment.MOEEN_PROVIDER_TRACKING_MODE?.trim() || 'off';
  if (!['off', 'enabled'].includes(mode)) {
    throw new Error('Invalid provider tracking configuration');
  }
  return { enabled: mode === 'enabled' };
}

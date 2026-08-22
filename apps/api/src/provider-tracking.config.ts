export const PROVIDER_TRACKING_CONFIG = Symbol('PROVIDER_TRACKING_CONFIG');

export const DEFAULT_PROVIDER_TRACKING_CONFIG: ProviderTrackingConfig = {
  enabled: false,
  onTheWayCadenceMs: 15_000,
  inProgressCadenceMs: 60_000,
};

export type ProviderTrackingConfig = {
  enabled: boolean;
  onTheWayCadenceMs: number;
  inProgressCadenceMs: number;
};

const CONFIGURATION_ERROR = 'Invalid provider tracking configuration';

function cadence(
  value: string | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return defaultValue;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) throw new Error(CONFIGURATION_ERROR);
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(CONFIGURATION_ERROR);
  }
  return parsed;
}

export function providerTrackingConfigFromEnvironment(
  environment: NodeJS.ProcessEnv,
): ProviderTrackingConfig {
  const mode = environment.MOEEN_PROVIDER_TRACKING_MODE?.trim() || 'off';
  if (!['off', 'enabled'].includes(mode)) {
    throw new Error(CONFIGURATION_ERROR);
  }
  const onTheWayCadenceMs = cadence(
    environment.MOEEN_PROVIDER_TRACKING_ON_THE_WAY_CADENCE_MS,
    DEFAULT_PROVIDER_TRACKING_CONFIG.onTheWayCadenceMs,
    10_000,
    60_000,
  );
  const inProgressCadenceMs = cadence(
    environment.MOEEN_PROVIDER_TRACKING_IN_PROGRESS_CADENCE_MS,
    DEFAULT_PROVIDER_TRACKING_CONFIG.inProgressCadenceMs,
    30_000,
    300_000,
  );
  if (inProgressCadenceMs < onTheWayCadenceMs) {
    throw new Error(CONFIGURATION_ERROR);
  }
  return {
    enabled: mode === 'enabled',
    onTheWayCadenceMs,
    inProgressCadenceMs,
  };
}

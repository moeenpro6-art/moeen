export const SERVICE_LOCATION_CONFIG = Symbol('SERVICE_LOCATION_CONFIG');

export type ServiceLocationMode = 'off' | 'optional' | 'required';

export type ServiceLocationBounds = {
  minimumLatitude: number;
  maximumLatitude: number;
  minimumLongitude: number;
  maximumLongitude: number;
};

export type ServiceLocationConfig =
  | { mode: 'off' }
  | {
      mode: Exclude<ServiceLocationMode, 'off'>;
      bounds: ServiceLocationBounds;
    };

const configurationError = 'Invalid service location configuration';

function coordinate(
  value: string | undefined,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === '') {
    throw new Error(configurationError);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(configurationError);
  }
  return parsed;
}

export function serviceLocationConfigFromEnvironment(
  environment: NodeJS.ProcessEnv,
): ServiceLocationConfig {
  const rawMode = environment.MOEEN_SERVICE_LOCATION_MODE?.trim() || 'off';
  if (!['off', 'optional', 'required'].includes(rawMode)) {
    throw new Error(configurationError);
  }
  const mode = rawMode as ServiceLocationMode;
  if (mode === 'off') return { mode };

  const bounds: ServiceLocationBounds = {
    minimumLatitude: coordinate(
      environment.MOEEN_SERVICE_LOCATION_MIN_LATITUDE,
      -90,
      90,
    ),
    maximumLatitude: coordinate(
      environment.MOEEN_SERVICE_LOCATION_MAX_LATITUDE,
      -90,
      90,
    ),
    minimumLongitude: coordinate(
      environment.MOEEN_SERVICE_LOCATION_MIN_LONGITUDE,
      -180,
      180,
    ),
    maximumLongitude: coordinate(
      environment.MOEEN_SERVICE_LOCATION_MAX_LONGITUDE,
      -180,
      180,
    ),
  };
  if (
    bounds.minimumLatitude >= bounds.maximumLatitude ||
    bounds.minimumLongitude >= bounds.maximumLongitude
  ) {
    throw new Error(configurationError);
  }
  return { mode, bounds };
}

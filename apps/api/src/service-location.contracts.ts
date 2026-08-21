import { BadRequestException } from '@nestjs/common';
import type { ServiceLocationConfig } from './service-location.config';

export type ServiceLocationSource = 'current_location' | 'map_pin';

export type ServiceLocationInput = {
  point: {
    latitude: number;
    longitude: number;
  };
  displayAddress: string;
  source: ServiceLocationSource;
  confirmed: true;
};

export type ServiceLocation = {
  point: {
    latitude: number;
    longitude: number;
  };
  displayAddress: string;
  source: ServiceLocationSource;
  confirmedAt: string;
};

export type ResolvedServiceLocation = {
  address: string;
  location?: ServiceLocation;
};

const invalidLocationError = 'Invalid service location';
const missingLocationError = 'Confirmed service location is required';
const locationDisabledError = 'Service location is disabled';
const locationKeySet = new Set([
  'point',
  'displayAddress',
  'source',
  'confirmed',
]);
const pointKeySet = new Set(['latitude', 'longitude']);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  candidate: Record<string, unknown>,
  expected: ReadonlySet<string>,
): boolean {
  const keys = Object.keys(candidate);
  return (
    keys.length === expected.size && keys.every((key) => expected.has(key))
  );
}

export function normalizeServiceAddress(value: unknown): string {
  if (typeof value !== 'string') {
    throw new BadRequestException(invalidLocationError);
  }
  const normalized = value.trim();
  if (normalized.length < 3 || normalized.length > 240) {
    throw new BadRequestException(invalidLocationError);
  }
  return normalized;
}

function canonicalCoordinate(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new BadRequestException(invalidLocationError);
  }
  return Number(value.toFixed(6));
}

export function validateServiceLocationInput(
  input: unknown,
  config: Exclude<ServiceLocationConfig, { mode: 'off' }>,
  now: () => Date = () => new Date(),
): ServiceLocation {
  if (!isPlainRecord(input) || !hasExactKeys(input, locationKeySet)) {
    throw new BadRequestException(invalidLocationError);
  }
  if (
    input.confirmed !== true ||
    !isPlainRecord(input.point) ||
    !hasExactKeys(input.point, pointKeySet) ||
    !['current_location', 'map_pin'].includes(String(input.source))
  ) {
    throw new BadRequestException(invalidLocationError);
  }
  const latitude = canonicalCoordinate(input.point.latitude, -90, 90);
  const longitude = canonicalCoordinate(input.point.longitude, -180, 180);
  if (
    latitude < config.bounds.minimumLatitude ||
    latitude > config.bounds.maximumLatitude ||
    longitude < config.bounds.minimumLongitude ||
    longitude > config.bounds.maximumLongitude
  ) {
    throw new BadRequestException(invalidLocationError);
  }
  return {
    point: { latitude, longitude },
    displayAddress: normalizeServiceAddress(input.displayAddress),
    source: input.source as ServiceLocationSource,
    confirmedAt: now().toISOString(),
  };
}

export function resolveServiceLocation(
  legacyAddress: unknown,
  input: unknown,
  config: ServiceLocationConfig,
  now: () => Date = () => new Date(),
): ResolvedServiceLocation {
  if (input === undefined) {
    if (config.mode === 'required') {
      throw new BadRequestException(missingLocationError);
    }
    return { address: normalizeServiceAddress(legacyAddress) };
  }
  if (config.mode === 'off') {
    throw new BadRequestException(locationDisabledError);
  }
  const location = validateServiceLocationInput(input, config, now);
  if (
    legacyAddress !== undefined &&
    normalizeServiceAddress(legacyAddress) !== location.displayAddress
  ) {
    throw new BadRequestException(invalidLocationError);
  }
  return { address: location.displayAddress, location };
}

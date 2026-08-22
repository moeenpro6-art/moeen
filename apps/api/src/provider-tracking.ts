import { BadRequestException } from '@nestjs/common';
import type { ProviderTrackingConfig } from './provider-tracking.config';

export const ARRIVAL_DISTANCE_METERS = 100;
export const ARRIVAL_MAXIMUM_ACCURACY_METERS = 50;
export const ARRIVAL_REQUIRED_SAMPLE_COUNT = 3;
export const ARRIVAL_REQUIRED_SPAN_MILLISECONDS = 30_000;
export const SAMPLE_MAXIMUM_AGE_MILLISECONDS = 5 * 60_000;
export const SAMPLE_MAXIMUM_FUTURE_SKEW_MILLISECONDS = 60_000;

export type ProviderTrackingRequestStatus =
  'assigned' | 'on_the_way' | 'in_progress' | 'completed' | 'cancelled';

export type ProviderTrackingAuthorityRecord = {
  requestId: string;
  status: ProviderTrackingRequestStatus;
  trackingSessionState: 'active' | 'stopped' | null;
};

export type ProviderTrackingStatusResponseDto = {
  tracking: {
    active: boolean;
    requestId: string;
    status: ProviderTrackingRequestStatus;
    onTheWayCadenceMs: number;
    inProgressCadenceMs: number;
  };
};

const TRACKABLE_REQUEST_STATUSES = new Set<ProviderTrackingRequestStatus>([
  'on_the_way',
  'in_progress',
]);

export function projectProviderTrackingStatus(
  record: ProviderTrackingAuthorityRecord,
  config: ProviderTrackingConfig,
): ProviderTrackingStatusResponseDto {
  return {
    tracking: {
      active:
        config.enabled &&
        TRACKABLE_REQUEST_STATUSES.has(record.status) &&
        record.trackingSessionState === 'active',
      requestId: record.requestId,
      status: record.status,
      onTheWayCadenceMs: config.onTheWayCadenceMs,
      inProgressCadenceMs: config.inProgressCadenceMs,
    },
  };
}

export type GeographicPoint = {
  latitude: number;
  longitude: number;
};

export type ProviderLocationSample = GeographicPoint & {
  accuracyMeters: number;
  capturedAt: Date;
};

export function canonicalizeProviderLocationSample(
  sample: ProviderLocationSample,
): ProviderLocationSample {
  return {
    latitude: Number(sample.latitude.toFixed(6)),
    longitude: Number(sample.longitude.toFixed(6)),
    accuracyMeters: Number(sample.accuracyMeters.toFixed(3)),
    capturedAt: sample.capturedAt,
  };
}

export type ObservedArrivalEvidence = {
  qualifyingSampleCount: number;
  firstQualifyingCapturedAt: Date | null;
  lastQualifyingCapturedAt: Date | null;
};

const ALLOWED_SAMPLE_KEYS = new Set([
  'latitude',
  'longitude',
  'accuracyMeters',
  'capturedAt',
]);

export function haversineDistanceMeters(
  from: GeographicPoint,
  to: GeographicPoint,
): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = radians(to.latitude - from.latitude);
  const longitudeDelta = radians(to.longitude - from.longitude);
  const fromLatitude = radians(from.latitude);
  const toLatitude = radians(to.latitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(fromLatitude) *
      Math.cos(toLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(haversine));
}

export function arrivalSampleQualifies(
  distanceMeters: number,
  accuracyMeters: number,
): boolean {
  return (
    Number.isFinite(distanceMeters) &&
    distanceMeters <= ARRIVAL_DISTANCE_METERS &&
    Number.isFinite(accuracyMeters) &&
    accuracyMeters <= ARRIVAL_MAXIMUM_ACCURACY_METERS
  );
}

export function evaluateObservedArrival(
  evidence: ObservedArrivalEvidence,
): boolean {
  if (
    evidence.qualifyingSampleCount < ARRIVAL_REQUIRED_SAMPLE_COUNT ||
    !evidence.firstQualifyingCapturedAt ||
    !evidence.lastQualifyingCapturedAt
  ) {
    return false;
  }
  return (
    evidence.lastQualifyingCapturedAt.getTime() -
      evidence.firstQualifyingCapturedAt.getTime() >=
    ARRIVAL_REQUIRED_SPAN_MILLISECONDS
  );
}

export function validateProviderLocationSample(
  input: unknown,
  receivedAt = new Date(),
): ProviderLocationSample {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BadRequestException('Invalid provider location sample');
  }
  const candidate = input as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !ALLOWED_SAMPLE_KEYS.has(key))) {
    throw new BadRequestException('Invalid provider location sample');
  }
  const { latitude, longitude, accuracyMeters, capturedAt } = candidate;
  if (
    typeof latitude !== 'number' ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    typeof longitude !== 'number' ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180 ||
    typeof accuracyMeters !== 'number' ||
    !Number.isFinite(accuracyMeters) ||
    accuracyMeters < 0 ||
    typeof capturedAt !== 'string'
  ) {
    throw new BadRequestException('Invalid provider location sample');
  }
  const captured = new Date(capturedAt);
  if (
    !Number.isFinite(captured.getTime()) ||
    captured.getTime() <
      receivedAt.getTime() - SAMPLE_MAXIMUM_AGE_MILLISECONDS ||
    captured.getTime() >
      receivedAt.getTime() + SAMPLE_MAXIMUM_FUTURE_SKEW_MILLISECONDS
  ) {
    throw new BadRequestException('Invalid provider location sample');
  }
  return { latitude, longitude, accuracyMeters, capturedAt: captured };
}

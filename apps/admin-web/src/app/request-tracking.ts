import { staffCapabilities } from './auth/roles';
import type { StaffRole } from './auth/session';

export type ProviderPosition = {
  requestId: string;
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  capturedAt: string;
  receivedAt: string;
  arrivalObserved: boolean;
};

export type ProviderPositionFreshness = 'fresh' | 'stale' | 'offline';

export function providerTrackingAllowedForRole(role: StaffRole): boolean {
  return staffCapabilities(role).canDispatch;
}

export function providerTrackingPollAllowed(
  panelOpen: boolean,
  visibilityState: DocumentVisibilityState,
): boolean {
  return panelOpen && visibilityState === 'visible';
}

export const providerTrackingPollIntervalMs = 10_000;

export const providerPositionFreshThresholdMs = 45_000;
export const providerPositionOfflineThresholdMs = 120_000;

/**
 * Validates an untrusted API payload into the provider-position DTO the
 * dashboard is allowed to render. Coordinates are never stored or logged by
 * the dashboard; they exist only in the client component's in-memory state.
 */
export function isProviderPosition(value: unknown): value is ProviderPosition {
  if (typeof value !== 'object' || value === null) return false;
  const position = value as Record<string, unknown>;
  return (
    typeof position.requestId === 'string' &&
    typeof position.latitude === 'number' &&
    Number.isFinite(position.latitude) &&
    position.latitude >= -90 &&
    position.latitude <= 90 &&
    typeof position.longitude === 'number' &&
    Number.isFinite(position.longitude) &&
    position.longitude >= -180 &&
    position.longitude <= 180 &&
    typeof position.accuracyMeters === 'number' &&
    Number.isFinite(position.accuracyMeters) &&
    position.accuracyMeters >= 0 &&
    typeof position.capturedAt === 'string' &&
    typeof position.receivedAt === 'string' &&
    typeof position.arrivalObserved === 'boolean'
  );
}

/**
 * Classifies a receivedAt timestamp against the approved thresholds, relative
 * to `now`. Unparseable timestamps fail closed to `offline`.
 */
export function providerPositionFreshness(
  receivedAt: string,
  now: number,
): ProviderPositionFreshness {
  const received = Date.parse(receivedAt);
  if (!Number.isFinite(received)) return 'offline';
  const age = now - received;
  if (age < providerPositionFreshThresholdMs) return 'fresh';
  if (age < providerPositionOfflineThresholdMs) return 'stale';
  return 'offline';
}

export type ProviderPollDecision =
  | { kind: 'position'; position: ProviderPosition }
  | { kind: 'stop' };

/**
 * Maps one polling HTTP outcome to the client component's next action.
 *
 * Every HTTP or payload error is terminal for this open panel. Polling stops
 * and any on-screen position clears so an old point is never shown as live.
 */
export function decideProviderPoll(
  status: number,
  body: unknown,
): ProviderPollDecision {
  if (status !== 200) return { kind: 'stop' };
  return isProviderPosition(body)
    ? { kind: 'position', position: body }
    : { kind: 'stop' };
}

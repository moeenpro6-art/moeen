import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';

/**
 * Bounded FCM device-registration contract (FCM-1).
 *
 * The raw FCM token is a bearer secret: it is validated here, hashed with
 * SHA-256 for storage/lookup/logging, and never propagated further than the
 * persistence layer that stores it for future delivery. Nothing in this
 * module (or any API response) may return the raw token or its hash.
 */

export type FcmDevicePlatform = 'android' | 'ios';

export type FcmDeviceRegistrationInput = {
  token: string;
  platform: FcmDevicePlatform;
};

/**
 * Safe public projection of a registered device. Deliberately excludes the
 * raw FCM token AND its hash: clients only need device-management data.
 */
export type FcmDevice = {
  deviceId: string;
  platform: FcmDevicePlatform;
  createdAt: string;
  lastSeenAt: string;
  active: boolean;
};

/** Approved pilot cap: at most 10 ACTIVE devices per account. */
export const MAX_ACTIVE_FCM_DEVICES_PER_OWNER = 10;

export const fcmDeviceRegistrationError = 'Invalid FCM device registration';
export const fcmDeviceLimitError = 'At most 10 active devices per account';
export const fcmTokenConflictError =
  'Device token is already registered to another account';

/**
 * FCM tokens are long opaque strings (typically 150-200 chars). Bounds exist
 * to reject garbage without risking legitimate tokens; no trimming is applied
 * because token whitespace would corrupt the stored secret.
 */
const FCM_TOKEN_MIN_LENGTH = 16;
const FCM_TOKEN_MAX_LENGTH = 512;

const FCM_PLATFORMS = new Set<FcmDevicePlatform>(['android', 'ios']);

export function validateFcmDeviceRegistration(
  input: unknown,
): FcmDeviceRegistrationInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BadRequestException(fcmDeviceRegistrationError);
  }
  const candidate = input as Record<string, unknown>;
  const token = candidate.token;
  const platform = candidate.platform;
  if (
    typeof token !== 'string' ||
    token.length < FCM_TOKEN_MIN_LENGTH ||
    token.length > FCM_TOKEN_MAX_LENGTH ||
    typeof platform !== 'string' ||
    !FCM_PLATFORMS.has(platform as FcmDevicePlatform)
  ) {
    throw new BadRequestException(fcmDeviceRegistrationError);
  }
  return { token, platform: platform as FcmDevicePlatform };
}

/** SHA-256 hex digest used for uniqueness, lookups and log-safe references. */
export function fcmTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Short hash prefix for diagnostics/logging. Never log the token itself;
 * this is the only token-derived identifier that may appear in logs.
 */
export function fcmTokenShortRef(token: string): string {
  return fcmTokenHash(token).slice(0, 12);
}

/** Thrown when registering an 11th active device for one account. */
export class FcmDeviceLimitExceededError extends Error {
  constructor() {
    super(fcmDeviceLimitError);
  }
}

/**
 * Thrown when the same token is concurrently registered by a second account
 * (the active-token partial unique index arbitrates the race).
 */
export class FcmTokenConflictError extends Error {
  constructor() {
    super(fcmTokenConflictError);
  }
}

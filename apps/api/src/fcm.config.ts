import { createPrivateKey } from 'node:crypto';

/**
 * FCM notification configuration (FCM-2).
 *
 * Follows the request-image config convention: a symbol DI token plus a pure
 * environment factory. When FCM notifications are disabled (the DEFAULT),
 * no Firebase credentials are required and nothing outside this module
 * changes. When enabled, every Firebase credential is validated here and any
 * missing or malformed value makes STARTUP fail loudly -- never silently
 * missing pushes. No error message ever contains a credential VALUE (field
 * names only), and the private key is never logged.
 *
 * Worker/send tuning constants are code constants for the Pilot (no env
 * vars), documented here so the retry ladder is a single source of truth.
 */

/** Nest DI token for the FCM notification configuration. */
export const FCM_CONFIG = Symbol('FCM_CONFIG');

/** Poll interval of the in-process dispatch worker. */
export const FCM_DISPATCH_POLL_INTERVAL_MS = 5_000;

/** Maximum rows claimed per worker cycle. */
export const FCM_DISPATCH_BATCH_SIZE = 50;

/** A claimed row older than this is considered orphaned and reclaimed. */
export const FCM_DISPATCH_LEASE_TTL_SECONDS = 300;

/**
 * Heartbeat cadence for renewing the leases of rows this worker is STILL
 * actively processing (FCM-2 HIGH #1). While a worker holds rows in its
 * current batch it refreshes their `lease_claimed_at` every interval, so a
 * long sequential batch can never have its lease expire mid-send and get
 * reclaimed by a second instance. Must be well below the lease TTL: worst
 * case a full batch (50 rows x 10s send timeout ≈ 500s) is still owned,
 * and the heartbeat refresh is bounded (one UPDATE per still-owned row per
 * interval). Stale rows from a CRASHED worker are never renewed (their
 * worker is gone) and remain reclaimable.
 */
export const FCM_DISPATCH_LEASE_RENEW_INTERVAL_MS = 30_000;

/** Per-send network timeout (bounded worker cycle). */
export const FCM_SEND_TIMEOUT_MS = 10_000;

/**
 * Maximum delivery attempts for one outbox row (attempt 1 = first send).
 * Attempts are NOT incremented for zero-device or all-permanent-token
 * terminal outcomes, only for retryable failures.
 */
export const FCM_MAX_DELIVERY_ATTEMPTS = 5;

/**
 * Retry ladder: delay applied after the N-th failed attempt (1-based),
 * before the next attempt. Four entries cover attempts 1-4; a 5th failure
 * dead-letters the row. 1m / 5m / 15m / 1h (architecture report values).
 */
export const FCM_RETRY_BACKOFF_MS: readonly number[] = [
  60_000, 300_000, 900_000, 3_600_000,
];

/**
 * Delay before the next attempt after the given 1-based attempt number
 * failed. Returns undefined when the attempt number reaches the maximum
 * (the row must dead-letter instead of retrying).
 */
export function fcmRetryDelayMs(attemptNumber: number): number | undefined {
  const index = attemptNumber - 1;
  if (index < 0 || index >= FCM_RETRY_BACKOFF_MS.length) return undefined;
  return FCM_RETRY_BACKOFF_MS[index];
}

export type DisabledFcmConfig = {
  enabled: false;
  environment: string;
};

export type EnabledFcmConfig = {
  enabled: true;
  environment: string;
  projectId: string;
  clientEmail: string;
  privateKey: string;
};

export type FcmConfig = DisabledFcmConfig | EnabledFcmConfig;

/** Default config used by direct constructions (tests, optional wiring). */
export const DISABLED_FCM_CONFIG: DisabledFcmConfig = {
  enabled: false,
  environment: 'development',
};

const FCM_CONFIGURATION_ERROR = 'Invalid FCM notification configuration';

function parseFcmBoolean(
  value: string | undefined,
  fallback: boolean,
): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(FCM_CONFIGURATION_ERROR);
}

function requiredProjectId(value: string | undefined): string {
  const normalized = value?.trim();
  if (
    !normalized ||
    normalized.length > 100 ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(normalized)
  ) {
    throw new Error(
      `${FCM_CONFIGURATION_ERROR}: FIREBASE_PROJECT_ID is missing or malformed`,
    );
  }
  return normalized;
}

function requiredClientEmail(value: string | undefined): string {
  const normalized = value?.trim();
  if (
    !normalized ||
    normalized.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  ) {
    throw new Error(
      `${FCM_CONFIGURATION_ERROR}: FIREBASE_CLIENT_EMAIL is missing or malformed`,
    );
  }
  return normalized;
}

/**
 * Normalizes a service-account private key. Railway (and .env files) may
 * deliver the PEM with literal backslash-n escape sequences instead of real
 * newlines; both spellings are accepted and normalized to real newlines.
 * The value itself is never included in any error message.
 *
 * Validation is LOCAL (startup, no network): the value must be a PKCS#8 PEM
 * private key with the standard BEGIN/END PRIVATE KEY markers and must parse
 * via Node's crypto, so a malformed or unusable key fails startup loudly.
 * Full Firebase Admin app/credential initialization (proving the material
 * constructs into a usable SDK credential) runs separately in fcm.sender.
 * Remote authorization (whether Google accepts the key to mint a token) is
 * not verifiable without a network call and is deliberately out of scope.
 */
export function normalizeFcmPrivateKey(value: string | undefined): string {
  if (!value || value.trim().length === 0) {
    throw new Error(
      `${FCM_CONFIGURATION_ERROR}: FIREBASE_PRIVATE_KEY is missing`,
    );
  }
  const normalized = value.replace(/\\n/g, '\n').trim();
  if (
    normalized.length > 16_384 ||
    !normalized.includes('-----BEGIN PRIVATE KEY-----') ||
    !normalized.includes('-----END PRIVATE KEY-----')
  ) {
    throw new Error(
      `${FCM_CONFIGURATION_ERROR}: FIREBASE_PRIVATE_KEY is not a valid PEM private key`,
    );
  }
  try {
    // Parse the key at startup rather than deferring malformed DER/base64
    // failures until the first notification is sent after a domain commit.
    createPrivateKey(normalized);
  } catch {
    throw new Error(
      `${FCM_CONFIGURATION_ERROR}: FIREBASE_PRIVATE_KEY is not a valid PEM private key`,
    );
  }
  return normalized;
}

export function fcmConfigFromEnvironment(
  environment: NodeJS.ProcessEnv,
): FcmConfig {
  const keyEnvironment = (environment.NODE_ENV ?? 'development').trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(keyEnvironment)) {
    throw new Error('Invalid FCM notification environment');
  }
  const enabled = parseFcmBoolean(environment.FCM_NOTIFICATIONS_ENABLED, false);
  if (!enabled) {
    return { enabled: false, environment: keyEnvironment };
  }
  return {
    enabled: true,
    environment: keyEnvironment,
    projectId: requiredProjectId(environment.FIREBASE_PROJECT_ID),
    clientEmail: requiredClientEmail(environment.FIREBASE_CLIENT_EMAIL),
    privateKey: normalizeFcmPrivateKey(environment.FIREBASE_PRIVATE_KEY),
  };
}

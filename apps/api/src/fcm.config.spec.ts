import { generateKeyPairSync } from 'node:crypto';
import {
  DISABLED_FCM_CONFIG,
  FCM_MAX_DELIVERY_ATTEMPTS,
  FCM_RETRY_BACKOFF_MS,
  fcmConfigFromEnvironment,
  fcmRetryDelayMs,
  normalizeFcmPrivateKey,
} from './fcm.config';

const PRIVATE_KEY = generateKeyPairSync('rsa', { modulusLength: 1024 })
  .privateKey.export({ format: 'pem', type: 'pkcs8' })
  .toString()
  .trim();
const ESCAPED_PRIVATE_KEY = PRIVATE_KEY.replace(/\n/g, '\\n');

describe('FCM notification configuration', () => {
  it('is disabled by default without requiring Firebase credentials', () => {
    expect(fcmConfigFromEnvironment({})).toEqual({
      enabled: false,
      environment: 'development',
    });
    expect(DISABLED_FCM_CONFIG.enabled).toBe(false);
  });

  it('accepts explicit false without requiring Firebase credentials', () => {
    expect(
      fcmConfigFromEnvironment({
        NODE_ENV: 'production',
        FCM_NOTIFICATIONS_ENABLED: 'false',
      }),
    ).toEqual({ enabled: false, environment: 'production' });
  });

  it('fails closed when enabled credentials are missing or malformed', () => {
    expect(() =>
      fcmConfigFromEnvironment({ FCM_NOTIFICATIONS_ENABLED: 'true' }),
    ).toThrow('FIREBASE_PROJECT_ID');
    expect(() =>
      fcmConfigFromEnvironment({
        FCM_NOTIFICATIONS_ENABLED: 'true',
        FIREBASE_PROJECT_ID: 'valid-project',
      }),
    ).toThrow('FIREBASE_CLIENT_EMAIL');
    expect(() =>
      fcmConfigFromEnvironment({
        FCM_NOTIFICATIONS_ENABLED: 'true',
        FIREBASE_PROJECT_ID: 'valid-project',
        FIREBASE_CLIENT_EMAIL:
          'firebase-adminsdk@example.iam.gserviceaccount.com',
      }),
    ).toThrow('FIREBASE_PRIVATE_KEY');
    expect(() =>
      fcmConfigFromEnvironment({
        FCM_NOTIFICATIONS_ENABLED: 'true',
        FIREBASE_PROJECT_ID: 'INVALID PROJECT',
        FIREBASE_CLIENT_EMAIL:
          'firebase-adminsdk@example.iam.gserviceaccount.com',
        FIREBASE_PRIVATE_KEY: ESCAPED_PRIVATE_KEY,
      }),
    ).toThrow('FIREBASE_PROJECT_ID');
  });

  it('normalizes Railway-style escaped newlines in a PEM private key', () => {
    const normalized = normalizeFcmPrivateKey(ESCAPED_PRIVATE_KEY);
    expect(normalized).toBe(PRIVATE_KEY);
    expect(normalized).not.toContain('\\n');
  });

  it('rejects the placeholder and malformed private keys at startup', () => {
    // The `.env.example` placeholder must never be accepted as a usable key:
    // it is not a PEM, and treating it as one would let the app boot with
    // unusable credentials (FCM-2 HIGH #3).
    expect(() => normalizeFcmPrivateKey('[REDACTED PRIVATE KEY]')).toThrow(
      'FIREBASE_PRIVATE_KEY',
    );
    // Well-formed markers but garbage body: must fail crypto parsing.
    expect(() =>
      normalizeFcmPrivateKey(
        '-----BEGIN PRIVATE KEY-----\nbm90LWEta2V5\n-----END PRIVATE KEY-----',
      ),
    ).toThrow('FIREBASE_PRIVATE_KEY');
    // Missing markers entirely.
    expect(() => normalizeFcmPrivateKey('this-secret-must-not-appear')).toThrow(
      'FIREBASE_PRIVATE_KEY',
    );
  });

  it('rejects a malformed enabled configuration with an unusable private key', () => {
    expect(() =>
      fcmConfigFromEnvironment({
        NODE_ENV: 'production',
        FCM_NOTIFICATIONS_ENABLED: 'true',
        FIREBASE_PROJECT_ID: 'moeen-pilot-123',
        FIREBASE_CLIENT_EMAIL:
          'firebase-adminsdk@example.iam.gserviceaccount.com',
        FIREBASE_PRIVATE_KEY: '[REDACTED PRIVATE KEY]',
      }),
    ).toThrow('FIREBASE_PRIVATE_KEY');
  });

  it('accepts an enabled configuration and never includes private-key bytes in errors', () => {
    const config = fcmConfigFromEnvironment({
      NODE_ENV: 'production',
      FCM_NOTIFICATIONS_ENABLED: 'true',
      FIREBASE_PROJECT_ID: 'moeen-pilot-123',
      FIREBASE_CLIENT_EMAIL:
        'firebase-adminsdk@example.iam.gserviceaccount.com',
      FIREBASE_PRIVATE_KEY: ESCAPED_PRIVATE_KEY,
    });
    expect(config).toEqual({
      enabled: true,
      environment: 'production',
      projectId: 'moeen-pilot-123',
      clientEmail: 'firebase-adminsdk@example.iam.gserviceaccount.com',
      privateKey: PRIVATE_KEY,
    });

    const secret = 'this-secret-must-not-appear';
    try {
      normalizeFcmPrivateKey(secret);
      throw new Error('expected invalid key');
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).message).toContain('FIREBASE_PRIVATE_KEY');
    }
  });

  it('rejects ambiguous feature flag and malformed environment values', () => {
    expect(() =>
      fcmConfigFromEnvironment({ FCM_NOTIFICATIONS_ENABLED: 'TRUE' }),
    ).toThrow('Invalid FCM notification configuration');
    expect(() =>
      fcmConfigFromEnvironment({ NODE_ENV: '../production' }),
    ).toThrow('Invalid FCM notification environment');
  });

  it('uses the approved bounded retry ladder', () => {
    expect(FCM_MAX_DELIVERY_ATTEMPTS).toBe(5);
    expect(FCM_RETRY_BACKOFF_MS).toEqual([60_000, 300_000, 900_000, 3_600_000]);
    expect([1, 2, 3, 4, 5].map(fcmRetryDelayMs)).toEqual([
      60_000,
      300_000,
      900_000,
      3_600_000,
      undefined,
    ]);
  });
});

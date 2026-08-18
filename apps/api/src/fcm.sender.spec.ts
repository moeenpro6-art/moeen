import {
  DisabledFcmSender,
  FirebaseFcmSender,
  classifyFcmSendError,
  firebaseMulticastInput,
  type FirebaseAdminAppApi,
} from './fcm.sender';
import type { EnabledFcmConfig } from './fcm.config';
import { generateKeyPairSync } from 'node:crypto';

const ENABLED_CONFIG: EnabledFcmConfig = {
  enabled: true,
  environment: 'test',
  projectId: 'moeen-pilot-123',
  clientEmail: 'firebase-adminsdk@example.iam.gserviceaccount.com',
  privateKey: generateKeyPairSync('rsa', { modulusLength: 1024 })
    .privateKey.export({ format: 'pem', type: 'pkcs8' })
    .toString()
    .trim(),
};

function adapter(): FirebaseAdminAppApi & {
  apps: Array<{ name: string; options: { projectId?: string } }>;
  initializeCount: number;
  certSeen: Array<{
    projectId: string;
    clientEmail: string;
    privateKey: string;
  }>;
} {
  const apps: Array<{ name: string; options: { projectId?: string } }> = [];
  const certSeen: Array<{
    projectId: string;
    clientEmail: string;
    privateKey: string;
  }> = [];
  const state = { initializeCount: 0 };
  return {
    apps,
    get initializeCount() {
      return state.initializeCount;
    },
    certSeen,
    cert(serviceAccount) {
      certSeen.push(serviceAccount);
      return { kind: 'cert', serviceAccount };
    },
    getApps() {
      return apps.map((app) => ({ name: app.name }));
    },
    getApp(name) {
      const app = apps.find((entry) => entry.name === name);
      if (!app) throw new Error(`app ${name} not found`);
      return app;
    },
    initializeApp(options, name) {
      state.initializeCount += 1;
      const app = { name, options };
      apps.push(app);
      return app;
    },
  };
}

describe('FCM sender error classification', () => {
  it.each([
    ['messaging/registration-token-not-registered', 'unregistered_token'],
    ['messaging/invalid-registration-token', 'invalid_token'],
    ['messaging/sender-id-mismatch', 'invalid_token'],
  ] as const)('classifies %s as permanent %s', (code, outcome) => {
    expect(classifyFcmSendError({ code })).toEqual({
      outcome,
      errorCode: code,
      throttled: false,
    });
  });

  it.each([
    'messaging/mismatched-credential',
    'messaging/invalid-package-name',
    'messaging/invalid-apns-credentials',
    'messaging/invalid-argument',
  ])('classifies %s as a non-retryable configuration error', (code) => {
    expect(classifyFcmSendError({ code })).toEqual({
      outcome: 'config_error',
      errorCode: code,
      throttled: false,
    });
  });

  it.each([
    'messaging/quota-exceeded',
    'messaging/resource-exhausted',
    'messaging/message-rate-exceeded',
  ])('classifies %s as a throttled transient error', (code) => {
    expect(classifyFcmSendError({ code })).toEqual({
      outcome: 'transient_error',
      errorCode: code,
      throttled: true,
    });
  });

  it.each([
    'messaging/server-unavailable',
    'messaging/internal-error',
    'messaging/unknown-runtime-error',
  ])('classifies %s as retryable without revoking a token', (code) => {
    expect(classifyFcmSendError({ code })).toEqual({
      outcome: 'transient_error',
      errorCode: code,
      throttled: false,
    });
  });

  it('uses a bounded safe classification for errors without a code', () => {
    expect(classifyFcmSendError(new Error('network failed'))).toEqual({
      outcome: 'transient_error',
      errorCode: 'unknown_error',
      throttled: false,
    });
  });

  it('never includes a token or error message in the returned classification', () => {
    const rawToken = 'raw-fcm-token-that-must-not-leak';
    const classification = classifyFcmSendError({
      code: 'messaging/internal-error',
      message: `failed for ${rawToken}`,
      token: rawToken,
    });
    expect(JSON.stringify(classification)).not.toContain(rawToken);
    expect(Object.keys(classification).sort()).toEqual([
      'errorCode',
      'outcome',
      'throttled',
    ]);
  });

  it('sanitizes arbitrary error codes that could contain a token', () => {
    const rawToken = 'raw-fcm-token-that-must-not-leak';
    const classification = classifyFcmSendError({ code: rawToken });
    expect(classification).toEqual({
      outcome: 'transient_error',
      errorCode: 'unknown_error',
      throttled: false,
    });
    expect(JSON.stringify(classification)).not.toContain(rawToken);
  });

  it('uses only the platform default sound and preserves the safe message', () => {
    const input = firebaseMulticastInput(
      ['token-used-only-for-firebase-call'],
      {
        title: 'عنوان آمن',
        body: 'نص آمن',
        data: {
          type: 'request_created',
          requestId: 'MOE-1001',
          navigate: 'customer_requests_list',
          eventId: '1',
          v: '1',
        },
      },
    );
    expect(input.android).toEqual({ notification: { sound: 'default' } });
    expect(input.apns).toEqual({ payload: { aps: { sound: 'default' } } });
    expect(input).not.toHaveProperty('android.notification.imageUrl');
    expect(input).not.toHaveProperty('apns.payload.aps.mutableContent');
  });

  it('refuses calls through the disabled sender instead of making an external call', async () => {
    const sender = new DisabledFcmSender();
    await expect(sender.sendToDevices()).rejects.toThrow(
      'FCM notifications are disabled',
    );
  });
});

describe('FirebaseFcmSender credential usability validation (FCM-2 HIGH #3)', () => {
  it('constructs a credential and app from usable material without network I/O', async () => {
    const api = adapter();
    const sender = new FirebaseFcmSender(ENABLED_CONFIG, api);

    await expect(sender.validateCredentialsUsable()).resolves.toBeUndefined();

    // cert() was fed the configured service account; initializeApp was called
    // exactly once with the configured project id.
    expect(api.certSeen).toHaveLength(1);
    expect(api.certSeen[0]).toMatchObject({
      projectId: 'moeen-pilot-123',
      clientEmail: 'firebase-adminsdk@example.iam.gserviceaccount.com',
    });
    expect(api.certSeen[0].privateKey).toBe(ENABLED_CONFIG.privateKey);
    expect(api.initializeCount).toBe(1);
    expect(api.apps[0].options.projectId).toBe('moeen-pilot-123');
  });

  it('is idempotent: a second validation reuses the already-initialized app', async () => {
    const api = adapter();
    const sender = new FirebaseFcmSender(ENABLED_CONFIG, api);

    await sender.validateCredentialsUsable();
    await sender.validateCredentialsUsable();

    expect(api.initializeCount).toBe(1);
  });

  it('fails startup when the configured project id mismatches an already-initialized app', async () => {
    const api = adapter();
    // Pre-seed an app with a DIFFERENT project id under the same name.
    api.apps.push({
      name: 'moeen-fcm',
      options: { projectId: 'other-project' },
    });
    const sender = new FirebaseFcmSender(ENABLED_CONFIG, api);

    await expect(sender.validateCredentialsUsable()).rejects.toThrow(
      'different project',
    );
  });

  it('never leaks private-key bytes through its error messages', async () => {
    const api = adapter();
    api.apps.push({
      name: 'moeen-fcm',
      options: { projectId: 'other-project' },
    });
    const sender = new FirebaseFcmSender(ENABLED_CONFIG, api);

    const error = (await sender
      .validateCredentialsUsable()
      .catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(String(error.message)).not.toContain(ENABLED_CONFIG.privateKey);
    expect(String(error.message)).not.toContain('PRIVATE KEY');
  });
});

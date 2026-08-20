/**
 * FCM send adapter (FCM-2).
 *
 * The sender is the ONLY component allowed to touch Firebase. It is
 * isolated from domain repositories, initialized lazily and exactly once
 * per process, and never returns or logs raw tokens (results carry only the
 * SHA-256 short reference from fcm-device.contracts). The disabled variant
 * throws if ever called -- by construction it never is, because the worker
 * and writer both no-op while FCM is disabled.
 */

import { fcmTokenShortRef } from './fcm-device.contracts';
import type { EnabledFcmConfig } from './fcm.config';
import type { FcmNotificationMessage } from './notification-templates';

/** Nest DI token for the FCM send adapter. */
export const FCM_SENDER = Symbol('FCM_SENDER');

export type FcmSendOutcome =
  | 'delivered'
  | 'invalid_token'
  | 'unregistered_token'
  | 'transient_error'
  | 'config_error';

/**
 * Per-token send result. NEVER contains the raw token: the short hash
 * reference is the only token-derived identifier allowed in results, logs
 * or error representations.
 */
export type FcmDeviceSendResult = {
  tokenShortRef: string;
  outcome: FcmSendOutcome;
  errorCode?: string;
};

export interface FcmSender {
  sendToDevices(
    tokens: string[],
    message: FcmNotificationMessage,
  ): Promise<FcmDeviceSendResult[]>;
}

/** Firebase error codes whose token is permanently unusable. */
const PERMANENT_TOKEN_ERROR_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  // Do NOT revoke on generic messaging/invalid-argument: Firebase also uses
  // it for malformed message/payload input, which is not evidence that this
  // particular device token is bad.
  'messaging/sender-id-mismatch',
]);

/** Firebase error codes indicating a permanent server configuration problem. */
const CONFIG_ERROR_CODES = new Set([
  'messaging/mismatched-credential',
  'messaging/invalid-package-name',
  'messaging/invalid-apns-credentials',
  'messaging/authentication-error',
  'messaging/invalid-credential',
  'messaging/invalid-recipient',
  'messaging/invalid-payload',
  'messaging/invalid-data-payload-key',
  'messaging/payload-size-limit-exceeded',
  'messaging/invalid-options',
  'app/invalid-credential',
  'app/invalid-argument',
]);

/** Firebase error codes worth retrying with explicit backoff. */
const THROTTLED_ERROR_CODES = new Set([
  'messaging/quota-exceeded',
  'messaging/resource-exhausted',
  'messaging/message-rate-exceeded',
  'messaging/device-message-rate-exceeded',
  'messaging/topics-message-rate-exceeded',
]);

export type FcmErrorClassification = {
  outcome: FcmSendOutcome;
  errorCode?: string;
  throttled: boolean;
};

/**
 * Deterministic Firebase error classification. Anything not explicitly
 * permanent is treated as transient (retried with the bounded ladder) --
 * unknown errors must never revoke a healthy token or retry forever.
 */
export function classifyFcmSendError(error: unknown): FcmErrorClassification {
  const rawCode =
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : undefined;
  // SDK codes have a bounded namespace/name shape. Never propagate an
  // arbitrary error `code`: custom transports can put a token or secret in
  // that field, and classifications are allowed in logs.
  const code =
    rawCode && /^(?:messaging|app|auth)\/[a-z0-9-]{1,80}$/.test(rawCode)
      ? rawCode
      : undefined;
  if (!code) {
    return {
      outcome: 'transient_error',
      errorCode: 'unknown_error',
      throttled: false,
    };
  }
  if (PERMANENT_TOKEN_ERROR_CODES.has(code)) {
    return {
      outcome:
        code === 'messaging/registration-token-not-registered'
          ? 'unregistered_token'
          : 'invalid_token',
      errorCode: code,
      throttled: false,
    };
  }
  if (CONFIG_ERROR_CODES.has(code) || code === 'messaging/invalid-argument') {
    return { outcome: 'config_error', errorCode: code, throttled: false };
  }
  if (THROTTLED_ERROR_CODES.has(code)) {
    return { outcome: 'transient_error', errorCode: code, throttled: true };
  }
  return { outcome: 'transient_error', errorCode: code, throttled: false };
}

export type FcmBatchErrorKind = 'network_error' | 'throttled' | 'config_error';

/** Safe batch-level failure: bounded classification/code, never tokens. */
export class FcmBatchSendError extends Error {
  constructor(
    readonly kind: FcmBatchErrorKind,
    readonly safeCode: string,
  ) {
    super('FCM batch send failed');
  }
}

/** Minimal structural contract of firebase-admin's messaging client. */
type MessagingClient = {
  sendEachForMulticast(input: {
    tokens: string[];
    notification: { title: string; body: string };
    data: Record<string, string>;
    android: { notification: { sound: 'default' } };
    apns: { payload: { aps: { sound: 'default' } } };
  }): Promise<{
    responses: Array<{
      success: boolean;
      messageId?: string;
      error?: { code?: string; message?: string };
    }>;
  }>;
};

/**
 * Stable Firebase app name. The Admin SDK app registry (not a module-local
 * singleton) guards duplicate initialization across hot reloads and tests.
 */
const FIREBASE_APP_NAME = 'moeen-fcm';

/**
 * Minimal structural contract of the `firebase-admin/app` module surface used
 * for credential usability validation and app initialization. Test adapters
 * inject a fake of this shape so startup validation can be exercised without
 * a network call or a real Firebase project.
 */
export type FirebaseAdminAppApi = {
  cert(serviceAccount: {
    projectId: string;
    clientEmail: string;
    privateKey: string;
  }): unknown;
  getApps(): Array<{ name: string }>;
  getApp(name: string): { options: { projectId?: string } };
  initializeApp(
    options: { projectId: string; credential: unknown },
    name: string,
  ): { options: { projectId?: string } };
};

export function firebaseMulticastInput(
  tokens: string[],
  message: FcmNotificationMessage,
): {
  tokens: string[];
  notification: { title: string; body: string };
  data: Record<string, string>;
  android: { notification: { sound: 'default' } };
  apns: { payload: { aps: { sound: 'default' } } };
} {
  return {
    tokens,
    notification: { title: message.title, body: message.body },
    data: message.data,
    android: { notification: { sound: 'default' } },
    apns: { payload: { aps: { sound: 'default' } } },
  };
}

export class FirebaseFcmSender implements FcmSender {
  private messagingPromise: Promise<MessagingClient> | undefined;

  constructor(
    private readonly config: EnabledFcmConfig,
    private readonly adminAppApi?: FirebaseAdminAppApi,
  ) {}

  /**
   * Startup credential-usability validation (FCM-2 HIGH #3). Runs BEFORE the
   * app starts serving: builds the Admin credential via `cert` and calls
   * `initializeApp` so the SDK constructs a real credential/app from the
   * configured material. A malformed/unusable key or an inconsistent project
   * id fails here (throwing), so the app never serves FCM-enabled traffic
   * with broken credentials. It is idempotent: a second call reuses the
   * already-initialized app (the Admin registry enforces one app per name).
   *
   * This performs NO network I/O and sends NO push. It proves the credential
   * material is locally usable (parseable PEM + constructable credential +
   * constructable app). Whether Google's token server will actually authorize
   * this key to mint an access token cannot be established without a network
   * call and is deliberately outside startup scope (documented boundary).
   *
   * The private key is passed to the SDK but never logged or echoed.
   */
  async validateCredentialsUsable(): Promise<void> {
    const app = await this.buildAdminApp();
    if (app.options.projectId !== this.config.projectId) {
      throw new Error(
        'Firebase app is already initialized for a different project',
      );
    }
  }

  private async buildAdminApp(): Promise<{ options: { projectId?: string } }> {
    if (this.adminAppApi) {
      // Test adapter path: exercise the same cert/initializeApp sequence.
      const api = this.adminAppApi;
      const registered = api
        .getApps()
        .find((app) => app.name === FIREBASE_APP_NAME);
      const app = registered
        ? api.getApp(FIREBASE_APP_NAME)
        : api.initializeApp(
            {
              projectId: this.config.projectId,
              credential: api.cert({
                projectId: this.config.projectId,
                clientEmail: this.config.clientEmail,
                privateKey: this.config.privateKey,
              }),
            },
            FIREBASE_APP_NAME,
          );
      return app;
    }
    // Dynamic import: firebase-admin is never loaded while FCM is disabled.
    const { cert, getApp, getApps, initializeApp } =
      await import('firebase-admin/app');
    const registered = getApps().find((app) => app.name === FIREBASE_APP_NAME);
    return registered
      ? getApp(FIREBASE_APP_NAME)
      : initializeApp(
          {
            projectId: this.config.projectId,
            credential: cert({
              projectId: this.config.projectId,
              clientEmail: this.config.clientEmail,
              privateKey: this.config.privateKey,
            }),
          },
          FIREBASE_APP_NAME,
        );
  }

  private getMessaging(): Promise<MessagingClient> {
    if (!this.messagingPromise) {
      this.messagingPromise = this.initializeMessaging();
    }
    return this.messagingPromise;
  }

  private async initializeMessaging(): Promise<MessagingClient> {
    // Dynamic imports: firebase-admin is never loaded while FCM is disabled.
    const [{ cert, getApp, getApps, initializeApp }, { getMessaging }] =
      await Promise.all([
        import('firebase-admin/app'),
        import('firebase-admin/messaging'),
      ]);
    const registered = getApps().find((app) => app.name === FIREBASE_APP_NAME);
    const app = registered
      ? getApp(FIREBASE_APP_NAME)
      : initializeApp(
          {
            projectId: this.config.projectId,
            credential: cert({
              projectId: this.config.projectId,
              clientEmail: this.config.clientEmail,
              privateKey: this.config.privateKey,
            }),
          },
          FIREBASE_APP_NAME,
        );
    if (app.options.projectId !== this.config.projectId) {
      throw new Error(
        'Firebase app is already initialized for a different project',
      );
    }
    return getMessaging(app);
  }

  async sendToDevices(
    tokens: string[],
    message: FcmNotificationMessage,
  ): Promise<FcmDeviceSendResult[]> {
    const messaging = await this.getMessaging();
    let response: Awaited<ReturnType<MessagingClient['sendEachForMulticast']>>;
    try {
      response = await messaging.sendEachForMulticast(
        firebaseMulticastInput(tokens, message),
      );
    } catch (error) {
      const classification = classifyFcmSendError(error);
      const kind: FcmBatchErrorKind =
        classification.outcome === 'config_error'
          ? 'config_error'
          : classification.throttled
            ? 'throttled'
            : 'network_error';
      throw new FcmBatchSendError(
        kind,
        classification.errorCode ?? 'unknown_error',
      );
    }
    return response.responses.map((single, index) => {
      const tokenShortRef = fcmTokenShortRef(tokens[index]);
      if (single.success) {
        return { tokenShortRef, outcome: 'delivered' };
      }
      const classification = classifyFcmSendError(single.error);
      return {
        tokenShortRef,
        outcome: classification.outcome,
        errorCode: classification.errorCode,
      };
    });
  }
}

/** Defensive no-op replacement used while FCM notifications are disabled. */
export class DisabledFcmSender implements FcmSender {
  sendToDevices(): Promise<FcmDeviceSendResult[]> {
    return Promise.reject(
      new Error(
        'FCM notifications are disabled; the sender must never be called',
      ),
    );
  }
}

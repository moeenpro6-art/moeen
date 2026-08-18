/**
 * Transactional notification-outbox writer (FCM-2).
 *
 * Producers (ServiceRequestRepository) call writeOnClient INSIDE their
 * domain transaction, on the same pool client. The outbox INSERT is a local
 * statement in that transaction: it commits with the domain mutation or
 * rolls back with it -- a FCM outage can never be involved here, because no
 * network I/O exists in the transaction path. Delivery happens strictly
 * post-commit in the dispatch worker.
 *
 * When FCM notifications are disabled (default) the writer is a complete
 * no-op and zero outbox rows are created (architecture report section 14).
 *
 * Deterministic dedupe: INSERT ... ON CONFLICT (dedupe_key) DO NOTHING
 * means a replayed/repeated domain operation can never create a second row
 * for the same semantic event.
 */

import { EventEmitter } from 'node:events';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  DISABLED_FCM_CONFIG,
  FCM_CONFIG,
  FCM_MAX_DELIVERY_ATTEMPTS,
  type FcmConfig,
} from './fcm.config';
import {
  assertOutboxPayloadSafe,
  buildOutboxPayload,
  type FcmNotificationType,
} from './notification-templates';

/** Nest DI token for the post-commit wake channel (Node EventEmitter). */
export const FCM_DISPATCH_WAKE = Symbol('FCM_DISPATCH_WAKE');

/** Event name emitted after a transaction that enqueued rows commits. */
export const FCM_DISPATCH_WAKE_EVENT = 'outbox-enqueued';

export type FcmDispatchWake = EventEmitter;

export type NotificationOutboxEnqueueSpec = {
  notificationType: FcmNotificationType;
  serviceRequestDatabaseId: number;
  /**
   * The server-side recipient identity captured at the mutation site. When
   * the mutation legitimately has no notify-able recipient -- a legacy
   * service-request row whose nullable customer ownership is absent (see
   * FCM-2 HIGH #2) -- this is undefined and the writer deterministically
   * SKIPS the notification rather than fabricating an owner, redirecting to
   * another account, or rolling back an otherwise-valid domain mutation.
   * A modern row with a real recipient always carries a defined recipient,
   * so MUST-ENQUEUE transactional reliability is unchanged.
   */
  recipient?:
    | { ownerKind: 'customer'; customerDatabaseId: number }
    | { ownerKind: 'provider'; providerId: string };
  dedupeKey: string;
  requestPublicId: string;
  /**
   * Reliability class from the architecture report: 'required' events use the
   * full retry ladder to dead-letter; 'best-effort' events (C1 only) start
   * one attempt from the ceiling so a single temporary failure retries once
   * and then dies. Defaults to 'required'.
   */
  reliability?: 'required' | 'best-effort';
};

@Injectable()
export class NotificationOutboxWriter {
  private readonly config: FcmConfig;
  private readonly wake: FcmDispatchWake;
  private readonly logger = new Logger(NotificationOutboxWriter.name);

  constructor(
    @Optional() @Inject(FCM_CONFIG) config?: FcmConfig,
    @Optional() @Inject(FCM_DISPATCH_WAKE) wake?: FcmDispatchWake,
  ) {
    this.config = config ?? DISABLED_FCM_CONFIG;
    this.wake = wake ?? new EventEmitter();
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Privacy-safe, bounded observability for the deterministic no-recipient
   * skip. Emits only enum notification type and the public MOE-XXXX request
   * id -- never any account id, token, phone or payload content.
   */
  private logSkippedForMissingRecipient(
    spec: NotificationOutboxEnqueueSpec,
  ): void {
    this.logger.log(
      JSON.stringify({
        event: 'fcm_outbox_skipped_missing_recipient',
        notificationType: spec.notificationType,
        requestPublicId: spec.requestPublicId,
      }),
    );
  }

  /**
   * Enqueues one notification on the CALLER'S transaction client. A no-op
   * while disabled. When `recipient` is undefined (a legacy service-request
   * row with no notify-able owner) the notification is SKIPPED without any
   * outbox row -- the domain mutation proceeds and commits normally. Never
   * performs network I/O; never throws for dedupe (the semantic event
   * already exists). Any other failure propagates and rolls the caller's
   * transaction back -- domain and outbox state can never half-commit.
   *
   * The undefined-recipient skip is NARROWLY scoped: it fires only when the
   * caller could not resolve a recipient identity at the mutation site. It
   * must not be used to swallow arbitrary enqueue/DB errors.
   */
  async writeOnClient(
    client: PoolClient,
    spec: NotificationOutboxEnqueueSpec,
  ): Promise<void> {
    if (!this.config.enabled) return;
    if (spec.recipient === undefined) {
      // No notify-able recipient exists (verified nullable legacy owner).
      // Notification infrastructure must never make a valid domain mutation
      // fail just because an old record has no recipient.
      this.logSkippedForMissingRecipient(spec);
      return;
    }
    const payload = buildOutboxPayload(
      spec.notificationType,
      spec.requestPublicId,
    );
    assertOutboxPayloadSafe(payload);
    // Reliability class (architecture report section 9): 'required' events
    // start at attempts 0 and climb the full retry ladder to dead-letter;
    // 'best-effort' events (C1 only) start one below the ceiling so their
    // single send attempt never retries. The class is recorded ONLY as the
    // starting attempts value -- the outbox rows themselves remain
    // privacy-safe and carry no reliability metadata beyond the standard
    // status/attempts columns.
    const initialAttempts =
      spec.reliability === 'best-effort' ? FCM_MAX_DELIVERY_ATTEMPTS - 1 : 0;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO notification_outbox
         (dedupe_key, recipient_owner_kind, recipient_customer_id,
          recipient_provider_id, notification_type, service_request_id,
          payload, attempts)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id::text`,
      [
        spec.dedupeKey,
        spec.recipient.ownerKind,
        spec.recipient.ownerKind === 'customer'
          ? spec.recipient.customerDatabaseId
          : null,
        spec.recipient.ownerKind === 'provider'
          ? spec.recipient.providerId
          : null,
        spec.notificationType,
        spec.serviceRequestDatabaseId,
        JSON.stringify(payload),
        initialAttempts,
      ],
    );
    const row = inserted.rows[0];
    if (!row) return; // Dedupe: the semantic event was already enqueued.
    await client.query(
      `UPDATE notification_outbox
          SET payload = payload || jsonb_build_object('eventId', id::text)
        WHERE id = $1::bigint`,
      [row.id],
    );
  }

  /**
   * Post-commit wake for near-zero dispatch latency. Producers call this
   * AFTER their transaction commits; the dispatch worker's poller remains
   * the crash-safe fallback. No-op while disabled.
   */
  notifyEnqueued(): void {
    if (!this.config.enabled) return;
    try {
      this.wake.emit(FCM_DISPATCH_WAKE_EVENT);
    } catch {
      // This is only a latency optimization. The database poller is the
      // crash-safe delivery path, so a faulty wake listener must never turn a
      // domain operation into a post-COMMIT 500 response.
    }
  }
}

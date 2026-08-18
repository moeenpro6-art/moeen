/**
 * FCM dispatch worker (FCM-2) -- bounded in-process Pilot dispatcher.
 *
 * Post-commit delivery model (architecture report section 9):
 *   - producers enqueue inside their domain transaction (writer);
 *   - this worker claims committed rows AFTER the fact and sends outside
 *     any domain transaction;
 *   - the database row lock is NEVER held during the FCM network call
 *     (claim commits first, send runs unlocked, then a finalize UPDATE);
 *   - at-least-once delivery: a crash between send and finalize re-sends
 *     after the lease reclaim (accepted for the Pilot; dedupe protects the
 *     enqueue side, not the wire).
 *
 * Concurrency: FOR UPDATE SKIP LOCKED claims disjoint rows across multiple
 * API instances; a stale-'sending' reclaim recovers rows orphaned by a
 * crashed worker. Bounded: fixed batch size, fixed poll interval, sequential
 * sends, per-send timeout, no hot loop (cycle guard + wake coalescing).
 */

import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Pool } from 'pg';
import { resolveDatabaseConnectionString } from './database.config';
import {
  FCM_CONFIG,
  FCM_DISPATCH_BATCH_SIZE,
  FCM_DISPATCH_LEASE_RENEW_INTERVAL_MS,
  FCM_DISPATCH_LEASE_TTL_SECONDS,
  FCM_DISPATCH_POLL_INTERVAL_MS,
  FCM_MAX_DELIVERY_ATTEMPTS,
  FCM_SEND_TIMEOUT_MS,
  fcmRetryDelayMs,
  type FcmConfig,
} from './fcm.config';
import {
  FcmBatchSendError,
  FCM_SENDER,
  type FcmDeviceSendResult,
  type FcmSender,
} from './fcm.sender';
import {
  FCM_DISPATCH_WAKE,
  FCM_DISPATCH_WAKE_EVENT,
  type FcmDispatchWake,
} from './notification-outbox.writer';
import {
  notificationMessageFromPayload,
  type FcmNotificationMessage,
} from './notification-templates';

export type ClaimedFcmOutboxRow = {
  id: number;
  recipientOwnerKind: 'customer' | 'provider';
  recipientCustomerId: number | null;
  recipientProviderId: string | null;
  notificationType: string;
  payload: Record<string, unknown>;
  attempts: number;
};

type OutboxRow = ClaimedFcmOutboxRow;

type DeviceRow = {
  id: string;
  tokenSecret: string;
};

type OutboxRowErrorKind =
  | 'no_active_device'
  | 'invalid_token'
  | 'unregistered_token'
  | 'network_error'
  | 'throttled'
  | 'config_error'
  | 'unknown';

const CLAIM_SQL = `
  WITH batch AS (
    SELECT id
      FROM notification_outbox
     WHERE status = 'pending' AND available_at <= NOW()
     ORDER BY available_at, id
     LIMIT $1
     FOR UPDATE SKIP LOCKED
  )
  UPDATE notification_outbox AS o
     SET status = 'sending',
         lease_claimed_at = NOW(),
         lease_claimed_by = $2
    FROM batch
   WHERE o.id = batch.id
   RETURNING o.id, o.recipient_owner_kind, o.recipient_customer_id,
             o.recipient_provider_id, o.notification_type, o.payload,
             o.attempts`;

const RECLAIM_SQL = `
  UPDATE notification_outbox
     SET status = 'pending',
         lease_claimed_at = NULL,
         lease_claimed_by = NULL,
         available_at = NOW()
   WHERE status = 'sending'
     AND lease_claimed_at IS NOT NULL
     AND lease_claimed_at <= NOW() - make_interval(secs => $1::double precision)`;

const RENEW_LEASE_SQL = `
  UPDATE notification_outbox
     SET lease_claimed_at = NOW()
   WHERE status = 'sending'
     AND lease_claimed_by = $1
     AND id = ANY($2::bigint[])`;

const DEVICES_CUSTOMER_SQL = `
  SELECT id, token_secret
    FROM fcm_devices
   WHERE customer_id = $1 AND revoked_at IS NULL
   ORDER BY created_at, id
   LIMIT 10`;

const DEVICES_PROVIDER_SQL = `
  SELECT id, token_secret
    FROM fcm_devices
   WHERE provider_id = $1 AND revoked_at IS NULL
   ORDER BY created_at, id
   LIMIT 10`;

const DELIVERED_SQL = `
  UPDATE notification_outbox
     SET status = 'delivered',
         delivered_at = NOW(),
         last_error_kind = $2,
         lease_claimed_at = NULL,
         lease_claimed_by = NULL,
         next_attempt_at = NULL
   WHERE id = $1::bigint`;

const RETRY_SQL = `
  UPDATE notification_outbox
     SET status = 'pending',
         attempts = $2,
         next_attempt_at = $3,
         available_at = $3,
         last_error_kind = $4,
         lease_claimed_at = NULL,
         lease_claimed_by = NULL
   WHERE id = $1::bigint`;

const DEAD_SQL = `
  UPDATE notification_outbox
     SET status = 'dead',
         attempts = $2,
         last_error_kind = $3,
         lease_claimed_at = NULL,
         lease_claimed_by = NULL
   WHERE id = $1::bigint`;

const REVOKE_DEVICE_SQL = `
  UPDATE fcm_devices
     SET revoked_at = COALESCE(revoked_at, NOW())
   WHERE id = $1 AND revoked_at IS NULL`;

class FcmSendTimeoutError extends Error {
  constructor() {
    super('FCM send timed out');
  }
}

@Injectable()
export class FcmDispatchWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FcmDispatchWorker.name);
  private readonly pool = new Pool({
    connectionString: resolveDatabaseConnectionString(),
  });
  private readonly workerId = `fcm-worker-${randomUUID().slice(0, 8)}`;
  private timer: NodeJS.Timeout | undefined;
  private inFlight = false;
  private rerunRequested = false;
  private stopped = false;
  private activeRowIds: number[] = [];
  private lastLeaseRenewalAt = 0;

  constructor(
    @Optional() @Inject(FCM_CONFIG) private readonly config?: FcmConfig,
    @Optional() @Inject(FCM_SENDER) private readonly sender?: FcmSender,
    @Optional()
    @Inject(FCM_DISPATCH_WAKE)
    private readonly wake?: FcmDispatchWake,
  ) {}

  onModuleInit(): void {
    this.start();
  }

  onModuleDestroy(): Promise<void> {
    return this.stop();
  }

  /** Starts polling + wake subscription. Idempotent; no-op when disabled. */
  start(): void {
    if (this.config?.enabled !== true || this.timer) return;
    if (!this.sender) {
      this.logger.error(
        JSON.stringify({
          event: 'fcm_dispatch_start_refused',
          reason: 'FCM sender is not configured',
        }),
      );
      return;
    }
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.runCycle();
    }, FCM_DISPATCH_POLL_INTERVAL_MS);
    // The HTTP server keeps the process alive; the poller alone must not.
    this.timer.unref?.();
    this.wake?.on(FCM_DISPATCH_WAKE_EVENT, this.handleWake);
  }

  /** Graceful shutdown: stop polling, drain the in-flight cycle, close DB. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.wake?.removeListener(FCM_DISPATCH_WAKE_EVENT, this.handleWake);
    if (this.inFlightPromise) {
      await Promise.race([
        this.inFlightPromise,
        new Promise<void>((resolve) =>
          setTimeout(resolve, FCM_SEND_TIMEOUT_MS + 2_000),
        ),
      ]);
    }
    await this.pool.end();
  }

  private inFlightPromise: Promise<void> | undefined;

  private readonly handleWake = (): void => {
    void this.runCycle();
  };

  /**
   * One claim/send/finalize pass. Concurrent callers (interval + wake) are
   * coalesced into a single rerun so sends never overlap.
   */
  async runCycle(): Promise<void> {
    if (this.stopped) return;
    if (this.inFlight) {
      this.rerunRequested = true;
      return;
    }
    this.inFlight = true;
    const cyclePromise = this.tickOnce().finally(() => {
      this.inFlight = false;
      if (this.rerunRequested && !this.stopped) {
        this.rerunRequested = false;
        void this.runCycle();
      }
    });
    this.inFlightPromise = cyclePromise;
    await cyclePromise;
  }

  private async tickOnce(): Promise<void> {
    let claimed = 0;
    let delivered = 0;
    let retried = 0;
    let dead = 0;
    this.activeRowIds = [];
    this.lastLeaseRenewalAt = 0;
    try {
      await this.reclaimStale();
      const rows = await this.claimBatch();
      claimed = rows.length;
      this.activeRowIds = rows.map((row) => row.id);
      for (const row of rows) {
        // HIGH #1: renew our still-owned leases before each send so a long
        // sequential batch can never age past the TTL mid-cycle and be
        // reclaimed by a healthy sibling instance. Finalized rows (delivered/
        // retry/dead) are dropped from the active set so their lease is never
        // renewed after they stop being 'sending'.
        await this.renewLeasesIfDue();
        const outcome = await this.processClaimedRow(row);
        this.activeRowIds = this.activeRowIds.filter((id) => id !== row.id);
        if (outcome === 'delivered') delivered += 1;
        else if (outcome === 'retry') retried += 1;
        else if (outcome === 'dead') dead += 1;
        this.logRow(row, outcome);
      }
      const depth = await this.pendingDepth();
      this.logger.log(
        JSON.stringify({
          event: 'fcm_dispatch_cycle',
          claimed,
          delivered,
          retried,
          dead,
          pendingDepth: depth,
        }),
      );
    } catch (error) {
      // A cycle-level failure (DB hiccup) must never crash the process; the
      // next poll retries. Log the classification, never error objects that
      // could carry sensitive content.
      this.logger.error(
        JSON.stringify({
          event: 'fcm_dispatch_cycle_error',
          message: error instanceof Error ? error.message : 'unknown error',
        }),
      );
    } finally {
      this.activeRowIds = [];
    }
  }

  /**
   * Heartbeat: refresh `lease_claimed_at` on every row this worker still
   * owns ('sending' + this worker's lease id) at most once per
   * {@link FCM_DISPATCH_LEASE_RENEW_INTERVAL_MS}. No DB lock is held during
   * Firebase I/O; this is a bounded, interval-throttled UPDATE. A crashed
   * worker never calls this, so its orphaned rows age out and are reclaimed
   * by {@link reclaimStale} exactly as before.
   */
  private async renewLeasesIfDue(): Promise<void> {
    if (this.activeRowIds.length === 0) return;
    const now = Date.now();
    if (now - this.lastLeaseRenewalAt < FCM_DISPATCH_LEASE_RENEW_INTERVAL_MS) {
      return;
    }
    this.lastLeaseRenewalAt = now;
    await this.renewOwnedLeases(this.activeRowIds);
  }

  /**
   * Public test seam + heartbeat body: refresh the lease of the given rows
   * IFF they are still 'sending' and owned by this worker. A row is never
   * renewed once it has left 'sending' (delivered/retry/dead) and never for
   * another worker's id, so a crashed worker's rows are untouched and remain
   * reclaimable.
   */
  async renewOwnedLeases(rowIds: number[]): Promise<void> {
    if (rowIds.length === 0) return;
    await this.pool.query(RENEW_LEASE_SQL, [this.workerId, rowIds]);
  }

  private logRow(row: OutboxRow, outcome: string): void {
    this.logger.log(
      JSON.stringify({
        event: 'fcm_dispatch_row',
        outboxId: row.id,
        type: row.notificationType,
        recipient: row.recipientOwnerKind,
        attempt: row.attempts + 1,
        outcome,
      }),
    );
  }

  /**
   * Recovers rows orphaned by a crashed worker: 'sending' rows whose lease
   * expired return to pending without incrementing attempts (a crash is not
   * a send failure). Re-send after a crash is the accepted at-least-once
   * trade-off.
   */
  async reclaimStale(): Promise<void> {
    await this.pool.query(RECLAIM_SQL, [FCM_DISPATCH_LEASE_TTL_SECONDS]);
  }

  /**
   * Claims up to FCM_DISPATCH_BATCH_SIZE due rows. When a client is passed
   * (tests), the claim joins the CALLER'S transaction so concurrent-claim
   * behavior can be exercised deterministically; by default each claim is
   * its own immediate transaction and the row lock is dropped before any
   * network call happens.
   */
  async claimBatch(client?: import('pg').PoolClient): Promise<OutboxRow[]> {
    const executor = client ?? this.pool;
    const result = await executor.query<{
      id: string;
      recipient_owner_kind: 'customer' | 'provider';
      recipient_customer_id: string | null;
      recipient_provider_id: string | null;
      notification_type: string;
      payload: Record<string, unknown>;
      attempts: number;
    }>(CLAIM_SQL, [FCM_DISPATCH_BATCH_SIZE, this.workerId]);
    return result.rows.map((row) => ({
      id: Number(row.id),
      recipientOwnerKind: row.recipient_owner_kind,
      recipientCustomerId:
        row.recipient_customer_id === null
          ? null
          : Number(row.recipient_customer_id),
      recipientProviderId: row.recipient_provider_id,
      notificationType: row.notification_type,
      payload: row.payload,
      attempts: row.attempts,
    }));
  }

  private async pendingDepth(): Promise<number> {
    const result = await this.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM notification_outbox
        WHERE status = 'pending' AND available_at <= NOW()`,
    );
    return result.rows[0]?.count ?? 0;
  }

  /**
   * Processes one claimed row: resolve ACTIVE devices for the account (never
   * revoked ones, never a client-supplied identity), send outside any
   * transaction, classify per-token results, revoke permanently-invalid
   * tokens, then finalize.
   *
   * Delivery semantics (architecture decision): a notification counts as
   * DELIVERED when at least one active device accepted it, or when there were
   * no active devices / only permanently-invalid tokens. This deterministic
   * partial-success policy avoids duplicating a push on devices that already
   * received it. Retry occurs only when no device accepted the message and at
   * least one failure was transient.
   */
  async processClaimedRow(
    row: ClaimedFcmOutboxRow,
  ): Promise<'delivered' | 'retry' | 'dead'> {
    const attemptNumber = row.attempts + 1;
    try {
      const devices = await this.resolveActiveDevices(row);
      if (devices.length === 0) {
        await this.markDelivered(row.id, 'no_active_device');
        return 'delivered';
      }
      let message: FcmNotificationMessage;
      try {
        message = notificationMessageFromPayload(row.payload);
      } catch {
        // Stored payload violates the privacy contract: never send it.
        await this.markDead(row.id, attemptNumber, 'unknown');
        return 'dead';
      }
      let results: FcmDeviceSendResult[];
      try {
        results = await this.sendWithTimeout(devices, message);
      } catch (error) {
        if (error instanceof FcmBatchSendError) {
          if (error.kind === 'config_error') {
            await this.markDead(row.id, attemptNumber, 'config_error');
            return 'dead';
          }
          return this.finalizeRetry(
            row,
            attemptNumber,
            error.kind === 'throttled' ? 'throttled' : 'network_error',
          );
        }
        return this.finalizeRetry(row, attemptNumber, 'network_error');
      }
      const byIndex = devices.map((device, index) => ({
        device,
        result: results[index] ?? {
          tokenShortRef: 'missing-result',
          outcome: 'transient_error' as const,
          errorCode: 'missing_response',
        },
      }));
      const permanent = byIndex.filter(
        (entry) =>
          entry.result.outcome === 'invalid_token' ||
          entry.result.outcome === 'unregistered_token',
      );
      const configErrors = byIndex.filter(
        (entry) => entry.result.outcome === 'config_error',
      );
      const delivered = byIndex.filter(
        (entry) => entry.result.outcome === 'delivered',
      );
      for (const entry of permanent) {
        await this.revokeDevice(entry.device.id);
      }
      if (configErrors.length > 0) {
        // Configuration errors are global, not per-token: no retry helps.
        await this.markDead(row.id, attemptNumber, 'config_error');
        return 'dead';
      }
      if (delivered.length > 0) {
        await this.markDelivered(row.id, undefined);
        return 'delivered';
      }
      if (permanent.length === byIndex.length) {
        const kind: OutboxRowErrorKind = permanent.some(
          (entry) => entry.result.outcome === 'unregistered_token',
        )
          ? 'unregistered_token'
          : 'invalid_token';
        await this.markDelivered(row.id, kind);
        return 'delivered';
      }
      const throttled = byIndex.some(
        (entry) =>
          entry.result.errorCode === 'messaging/quota-exceeded' ||
          entry.result.errorCode === 'messaging/resource-exhausted' ||
          entry.result.errorCode === 'messaging/message-rate-exceeded',
      );
      return this.finalizeRetry(
        row,
        attemptNumber,
        throttled ? 'throttled' : 'network_error',
      );
    } catch (error) {
      // Finalize/revoke failures: leave the row 'sending' so the stale
      // lease reclaim retries it; never crash the cycle. Log safely.
      this.logger.error(
        JSON.stringify({
          event: 'fcm_dispatch_row_error',
          outboxId: row.id,
          type: row.notificationType,
          recipient: row.recipientOwnerKind,
          message: error instanceof Error ? error.message : 'unknown error',
        }),
      );
      return 'retry';
    }
  }

  private async resolveActiveDevices(row: OutboxRow): Promise<DeviceRow[]> {
    const result =
      row.recipientOwnerKind === 'customer'
        ? await this.pool.query<{ id: string; token_secret: string }>(
            DEVICES_CUSTOMER_SQL,
            [row.recipientCustomerId],
          )
        : await this.pool.query<{ id: string; token_secret: string }>(
            DEVICES_PROVIDER_SQL,
            [row.recipientProviderId],
          );
    return result.rows.map((device) => ({
      id: device.id,
      tokenSecret: device.token_secret,
    }));
  }

  private async sendWithTimeout(
    devices: DeviceRow[],
    message: FcmNotificationMessage,
  ): Promise<FcmDeviceSendResult[]> {
    const tokens = devices.map((device) => device.tokenSecret);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new FcmSendTimeoutError()),
        FCM_SEND_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([
        this.sender!.sendToDevices(tokens, message),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async finalizeRetry(
    row: OutboxRow,
    attemptNumber: number,
    kind: OutboxRowErrorKind,
  ): Promise<'retry' | 'dead'> {
    if (attemptNumber >= FCM_MAX_DELIVERY_ATTEMPTS) {
      await this.markDead(row.id, attemptNumber, kind);
      return 'dead';
    }
    const delay = fcmRetryDelayMs(attemptNumber) ?? 60_000;
    const nextAttemptAt = new Date(Date.now() + delay);
    await this.pool.query(RETRY_SQL, [
      row.id,
      attemptNumber,
      nextAttemptAt,
      kind,
    ]);
    return 'retry';
  }

  private async markDelivered(
    id: number,
    kind: OutboxRowErrorKind | undefined,
  ): Promise<void> {
    await this.pool.query(DELIVERED_SQL, [id, kind ?? null]);
  }

  private async markDead(
    id: number,
    attempts: number,
    kind: OutboxRowErrorKind,
  ): Promise<void> {
    await this.pool.query(DEAD_SQL, [id, attempts, kind]);
  }

  private async revokeDevice(deviceId: string): Promise<void> {
    await this.pool.query(REVOKE_DEVICE_SQL, [deviceId]);
  }
}

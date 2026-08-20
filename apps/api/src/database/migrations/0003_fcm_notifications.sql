-- Moeen FCM notifications foundation (FCM-1).
--
-- This migration provides the persistence layer for the notifications pilot
-- and NOTHING more: no dispatcher, no worker, no Firebase integration. The
-- outbox schema is shaped for the FCM-2 dispatcher (FOR UPDATE SKIP LOCKED,
-- stale-sending reclaim, retry/backoff, dead-letter, dedupe).
--
-- Token security:
--   - token_hash  : SHA-256 of the FCM token; used for uniqueness, lookups
--                   and log-safe references. Never displayed to clients.
--   - token_secret: the raw FCM token, REQUIRED for actual delivery later.
--                   This column is selected ONLY by the future sending path.
--                   It must never appear in API responses, logs, audit
--                   events, or notification payloads.

CREATE TABLE fcm_devices (
  id UUID PRIMARY KEY,
  customer_id BIGINT REFERENCES customers(id),
  provider_id TEXT REFERENCES providers(id),
  token_secret TEXT NOT NULL,
  token_hash CHAR(64) NOT NULL
    CONSTRAINT fcm_devices_token_hash_check
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  platform TEXT NOT NULL
    CONSTRAINT fcm_devices_platform_check
    CHECK (platform IN ('android', 'ios')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  CONSTRAINT fcm_devices_single_owner_check
    CHECK ((customer_id IS NULL) <> (provider_id IS NULL))
);

-- Efficient "active devices per owner" reads (10-device cap + delivery
-- fan-out by account).
CREATE INDEX fcm_devices_customer_active_idx
  ON fcm_devices (customer_id)
  WHERE revoked_at IS NULL;

CREATE INDEX fcm_devices_provider_active_idx
  ON fcm_devices (provider_id)
  WHERE revoked_at IS NULL;

-- At most ONE ACTIVE device may hold a given token. Revoked rows keep the
-- hash for diagnostics, which is what allows safe token rebinding across
-- owners (revoke old owner + create new owner).
CREATE UNIQUE INDEX fcm_devices_active_token_hash_unique
  ON fcm_devices (token_hash)
  WHERE revoked_at IS NULL;

CREATE TABLE notification_outbox (
  id BIGSERIAL PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  recipient_owner_kind TEXT NOT NULL
    CONSTRAINT notification_outbox_recipient_owner_kind_check
    CHECK (recipient_owner_kind IN ('customer', 'provider')),
  recipient_customer_id BIGINT REFERENCES customers(id),
  recipient_provider_id TEXT REFERENCES providers(id),
  notification_type TEXT NOT NULL
    CONSTRAINT notification_outbox_notification_type_check
    CHECK (notification_type IN (
      'request_created',
      'provider_assigned',
      'provider_on_the_way',
      'request_completed',
      'opportunity_invited',
      'quote_approved'
    )),
  service_request_id BIGINT REFERENCES service_requests(id),
  payload JSONB NOT NULL
    CONSTRAINT notification_outbox_payload_check
    CHECK (jsonb_typeof(payload) = 'object'),
  status TEXT NOT NULL DEFAULT 'pending'
    CONSTRAINT notification_outbox_status_check
    CHECK (status IN ('pending', 'sending', 'delivered', 'dead')),
  attempts SMALLINT NOT NULL DEFAULT 0
    CONSTRAINT notification_outbox_attempts_check
    CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  next_attempt_at TIMESTAMPTZ,
  lease_claimed_at TIMESTAMPTZ,
  lease_claimed_by TEXT,
  last_error_kind TEXT
    CONSTRAINT notification_outbox_last_error_kind_check
    CHECK (last_error_kind IN (
      'no_active_device',
      'invalid_token',
      'unregistered_token',
      'network_error',
      'throttled',
      'unknown'
    )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  CONSTRAINT notification_outbox_single_recipient_check
    CHECK ((recipient_customer_id IS NULL) <> (recipient_provider_id IS NULL))
);

-- FCM-2 dispatcher work queue: next pending row with FOR UPDATE SKIP LOCKED.
CREATE INDEX notification_outbox_pending_available_idx
  ON notification_outbox (available_at, id)
  WHERE status = 'pending';

-- FCM-2 stale-sending reclaim: rows stuck in 'sending' beyond their lease.
CREATE INDEX notification_outbox_sending_claimed_idx
  ON notification_outbox (lease_claimed_at)
  WHERE status = 'sending';

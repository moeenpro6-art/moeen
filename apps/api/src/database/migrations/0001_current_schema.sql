-- Moeen schema baseline at B1 (origin/main e793df4 after B5).
-- This migration deliberately retains the former startup DDL's additive guards
-- so known pre-B1 databases can converge safely. The runner validates the
-- resulting schema before recording this migration.

CREATE TABLE IF NOT EXISTS customers (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_sessions (
  token_hash TEXT PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_otp_challenges (
  challenge_id UUID PRIMARY KEY,
  phone TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  failed_attempts SMALLINT NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS customer_otp_challenges_expires_at_idx
  ON customer_otp_challenges (expires_at);

CREATE TABLE IF NOT EXISTS customer_otp_request_attempts (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS customer_otp_request_attempts_phone_requested_at_idx
  ON customer_otp_request_attempts (phone, requested_at DESC);

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  specialties TEXT[] NOT NULL,
  available BOOLEAN NOT NULL DEFAULT TRUE
);

ALTER TABLE providers
  ADD COLUMN IF NOT EXISTS service_zone TEXT NOT NULL DEFAULT 'بريدة';
ALTER TABLE providers
  ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending', 'verified', 'suspended'));

CREATE TABLE IF NOT EXISTS provider_access_credentials (
  provider_id TEXT PRIMARY KEY REFERENCES providers(id),
  access_code_hash TEXT UNIQUE NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE provider_access_credentials
  ADD COLUMN IF NOT EXISTS lookup_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS provider_access_lookup_idx
  ON provider_access_credentials (lookup_id)
  WHERE lookup_id IS NOT NULL;

UPDATE provider_access_credentials
   SET lookup_id = access_code_hash
 WHERE lookup_id IS NULL
   AND access_code_hash ~ '^[a-f0-9]{64}$';

CREATE TABLE IF NOT EXISTS provider_sessions (
  token_hash TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS provider_sessions_provider_expires_idx
  ON provider_sessions (provider_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS service_requests (
  id BIGSERIAL PRIMARY KEY,
  service_id TEXT NOT NULL,
  address TEXT NOT NULL,
  details TEXT,
  timing TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_dispatch',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE service_requests
  ADD COLUMN IF NOT EXISTS assigned_provider_id TEXT REFERENCES providers(id);
ALTER TABLE service_requests
  ADD COLUMN IF NOT EXISTS customer_id BIGINT REFERENCES customers(id);
ALTER TABLE service_requests
  ADD COLUMN IF NOT EXISTS rating SMALLINT CHECK (rating BETWEEN 1 AND 5);
ALTER TABLE service_requests
  ADD COLUMN IF NOT EXISTS rating_comment TEXT;

CREATE TABLE IF NOT EXISTS service_request_events (
  id BIGSERIAL PRIMARY KEY,
  service_request_id BIGINT NOT NULL REFERENCES service_requests(id),
  type TEXT NOT NULL CHECK (type IN (
    'request_created',
    'provider_assigned',
    'status_updated',
    'quote_proposed',
    'quote_approved',
    'quote_rejected',
    'opportunity_invited',
    'opportunity_closed',
    'provider_quote_submitted',
    'provider_quote_withdrawn'
  )),
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS service_request_events_request_created_idx
  ON service_request_events (service_request_id, id);

CREATE TABLE IF NOT EXISTS service_quotes (
  id BIGSERIAL PRIMARY KEY,
  service_request_id BIGINT NOT NULL REFERENCES service_requests(id),
  amount_halalas INTEGER NOT NULL CHECK (amount_halalas > 0),
  scope TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected', 'withdrawn'))
    DEFAULT 'proposed',
  proposed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS service_quotes_request_latest_idx
  ON service_quotes (service_request_id, id DESC);

ALTER TABLE service_quotes
  ADD COLUMN IF NOT EXISTS provider_id TEXT REFERENCES providers(id);

CREATE INDEX IF NOT EXISTS service_quotes_provider_idx
  ON service_quotes (provider_id);

CREATE UNIQUE INDEX IF NOT EXISTS service_quotes_one_active_per_provider
  ON service_quotes (service_request_id, provider_id)
  WHERE status IN ('proposed', 'approved') AND provider_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS request_provider_opportunities (
  id BIGSERIAL PRIMARY KEY,
  service_request_id BIGINT NOT NULL REFERENCES service_requests(id),
  provider_id TEXT NOT NULL REFERENCES providers(id),
  status TEXT NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited', 'quoted', 'withdrawn', 'closed', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (service_request_id, provider_id)
);

CREATE INDEX IF NOT EXISTS opportunities_provider_idx
  ON request_provider_opportunities (provider_id, status);

DO $$
DECLARE
  exact_schema text := current_schema();
  selected_constraint_oid oid;
  constraint_def text;
BEGIN
  EXECUTE format(
    'LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE',
    exact_schema, 'service_quotes'
  );
  SELECT c.oid
    INTO selected_constraint_oid
    FROM pg_constraint c
   WHERE c.conrelid = to_regclass(format('%I.%I', exact_schema, 'service_quotes'))
     AND c.conname = 'service_quotes_status_check';

  IF selected_constraint_oid IS NOT NULL THEN
    SELECT pg_get_constraintdef(selected_constraint_oid)
      INTO constraint_def;
  ELSE
    constraint_def := NULL;
  END IF;

  IF constraint_def IS NULL OR NOT (
    constraint_def LIKE '%proposed%'
    AND constraint_def LIKE '%approved%'
    AND constraint_def LIKE '%rejected%'
    AND constraint_def LIKE '%withdrawn%'
  ) THEN
    EXECUTE format(
      'ALTER TABLE %I.%I DROP CONSTRAINT IF EXISTS service_quotes_status_check, ADD CONSTRAINT service_quotes_status_check CHECK (status IN (''proposed'', ''approved'', ''rejected'', ''withdrawn''))',
      exact_schema, 'service_quotes'
    );
  END IF;
END $$;

DO $$
DECLARE
  exact_schema text := current_schema();
  selected_constraint_oid oid;
  constraint_def text;
BEGIN
  EXECUTE format(
    'LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE',
    exact_schema, 'service_request_events'
  );
  SELECT c.oid
    INTO selected_constraint_oid
    FROM pg_constraint c
   WHERE c.conrelid = to_regclass(format('%I.%I', exact_schema, 'service_request_events'))
     AND c.conname = 'service_request_events_type_check';

  IF selected_constraint_oid IS NOT NULL THEN
    SELECT pg_get_constraintdef(selected_constraint_oid)
      INTO constraint_def;
  ELSE
    constraint_def := NULL;
  END IF;

  IF constraint_def IS NULL OR NOT (
    constraint_def LIKE '%request_created%'
    AND constraint_def LIKE '%provider_assigned%'
    AND constraint_def LIKE '%status_updated%'
    AND constraint_def LIKE '%quote_proposed%'
    AND constraint_def LIKE '%quote_approved%'
    AND constraint_def LIKE '%quote_rejected%'
    AND constraint_def LIKE '%opportunity_invited%'
    AND constraint_def LIKE '%opportunity_closed%'
    AND constraint_def LIKE '%provider_quote_submitted%'
    AND constraint_def LIKE '%provider_quote_withdrawn%'
  ) THEN
    EXECUTE format(
      'ALTER TABLE %I.%I DROP CONSTRAINT IF EXISTS service_request_events_type_check, ADD CONSTRAINT service_request_events_type_check CHECK (type IN (''request_created'', ''provider_assigned'', ''status_updated'', ''quote_proposed'', ''quote_approved'', ''quote_rejected'', ''opportunity_invited'', ''opportunity_closed'', ''provider_quote_submitted'', ''provider_quote_withdrawn''))',
      exact_schema, 'service_request_events'
    );
  END IF;
END $$;

DO $$
DECLARE
  exact_schema text := current_schema();
  selected_constraint_oid oid;
  constraint_def text;
BEGIN
  EXECUTE format(
    'LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE',
    exact_schema, 'request_provider_opportunities'
  );
  SELECT c.oid
    INTO selected_constraint_oid
    FROM pg_constraint c
   WHERE c.conrelid = to_regclass(
           format('%I.%I', exact_schema, 'request_provider_opportunities')
         )
     AND c.conname = 'request_provider_opportunities_status_check';

  IF selected_constraint_oid IS NOT NULL THEN
    SELECT pg_get_constraintdef(selected_constraint_oid)
      INTO constraint_def;
  ELSE
    constraint_def := NULL;
  END IF;

  IF constraint_def IS NULL OR NOT (
    constraint_def LIKE '%invited%'
    AND constraint_def LIKE '%quoted%'
    AND constraint_def LIKE '%withdrawn%'
    AND constraint_def LIKE '%closed%'
    AND constraint_def LIKE '%rejected%'
  ) THEN
    EXECUTE format(
      'ALTER TABLE %I.%I DROP CONSTRAINT IF EXISTS request_provider_opportunities_status_check, ADD CONSTRAINT request_provider_opportunities_status_check CHECK (status IN (''invited'', ''quoted'', ''withdrawn'', ''closed'', ''rejected''))',
      exact_schema, 'request_provider_opportunities'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS service_payments (
  id BIGSERIAL PRIMARY KEY,
  service_request_id BIGINT NOT NULL REFERENCES service_requests(id),
  quote_id BIGINT NOT NULL UNIQUE REFERENCES service_quotes(id),
  amount_halalas INTEGER NOT NULL CHECK (amount_halalas > 0),
  currency CHAR(3) NOT NULL DEFAULT 'SAR' CHECK (currency = 'SAR'),
  method TEXT NOT NULL CHECK (method IN ('cash_on_completion', 'paymob')),
  status TEXT NOT NULL CHECK (status IN (
    'cash_due',
    'cash_collected',
    'checkout_created',
    'paid',
    'failed',
    'refund_pending',
    'refunded'
  )),
  collected_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (service_request_id, quote_id)
);

ALTER TABLE service_payments
  ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS service_payments_request_created_idx
  ON service_payments (service_request_id, id DESC);

CREATE TABLE IF NOT EXISTS support_tickets (
  id BIGSERIAL PRIMARY KEY,
  service_request_id BIGINT NOT NULL REFERENCES service_requests(id),
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  category TEXT NOT NULL,
  comment TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS staff_users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'dispatcher', 'support_agent')),
  password_hash TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS staff_sessions (
  token_hash TEXT PRIMARY KEY,
  staff_user_id BIGINT NOT NULL REFERENCES staff_users(id),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auth_login_failures (
  scope TEXT NOT NULL CHECK (scope IN ('staff_login', 'provider_login')),
  subject_hash CHAR(64) NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public_auth_rate_limits (
  scope TEXT NOT NULL CHECK (scope IN (
    'customer_otp_request',
    'customer_otp_verification',
    'provider_login'
  )),
  subject_hash CHAR(64) NOT NULL,
  window_started_at TIMESTAMPTZ NOT NULL,
  attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
  PRIMARY KEY (scope, subject_hash)
);

DO $$
DECLARE
  exact_schema text := current_schema();
  selected_constraint_oid oid;
  constraint_def text;
BEGIN
  EXECUTE format(
    'LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE',
    exact_schema, 'public_auth_rate_limits'
  );
  SELECT c.oid
    INTO selected_constraint_oid
    FROM pg_constraint c
   WHERE c.conrelid = to_regclass(format('%I.%I', exact_schema, 'public_auth_rate_limits'))
     AND c.conname = 'public_auth_rate_limits_scope_check';

  IF selected_constraint_oid IS NOT NULL THEN
    SELECT pg_get_constraintdef(selected_constraint_oid)
      INTO constraint_def;
  ELSE
    constraint_def := NULL;
  END IF;

  IF constraint_def IS NULL OR NOT (
    constraint_def LIKE '%customer_otp_request%'
    AND constraint_def LIKE '%customer_otp_verification%'
    AND constraint_def LIKE '%provider_login%'
  ) THEN
    EXECUTE format(
      'ALTER TABLE %I.%I DROP CONSTRAINT IF EXISTS public_auth_rate_limits_scope_check, ADD CONSTRAINT public_auth_rate_limits_scope_check CHECK (scope IN (''customer_otp_request'', ''customer_otp_verification'', ''provider_login''))',
      exact_schema, 'public_auth_rate_limits'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS staff_audit_events (
  id BIGSERIAL PRIMARY KEY,
  staff_user_id BIGINT NOT NULL REFERENCES staff_users(id),
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  old_state JSONB,
  new_state JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS staff_sessions_expires_at_idx
  ON staff_sessions (expires_at);
CREATE INDEX IF NOT EXISTS auth_login_failures_lookup_idx
  ON auth_login_failures (scope, subject_hash, attempted_at DESC);
CREATE INDEX IF NOT EXISTS staff_audit_events_actor_created_at_idx
  ON staff_audit_events (staff_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS staff_audit_events_subject_created_at_idx
  ON staff_audit_events (subject_type, subject_id, created_at DESC);

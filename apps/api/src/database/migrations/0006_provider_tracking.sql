-- Request-scoped provider live tracking foundation.
-- Exact raw samples are bounded operational evidence (30-day target); derived
-- session/arrival evidence has a separate 180-day retention target.

-- This migration runs inside the shared migration transaction. Bound both
-- lock acquisition and the composite UNIQUE index build so deployment fails
-- fast instead of imposing an unbounded write outage on service_requests.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE service_requests
  ADD CONSTRAINT service_requests_id_assigned_provider_key
  UNIQUE (id, assigned_provider_id);

CREATE TABLE provider_tracking_sessions (
  service_request_id BIGINT PRIMARY KEY REFERENCES service_requests(id),
  provider_id TEXT NOT NULL REFERENCES providers(id),
  state TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  stopped_at TIMESTAMPTZ,
  stop_reason TEXT CHECK (
    stop_reason IS NULL OR stop_reason IN (
      'completed',
      'cancelled',
      'provider_suspended',
      'operations_emergency'
    )
  ),
  arrival_observed_at TIMESTAMPTZ,
  arrival_first_qualifying_at TIMESTAMPTZ,
  arrival_last_qualifying_at TIMESTAMPTZ,
  arrival_qualifying_sample_count INTEGER NOT NULL DEFAULT 0
    CONSTRAINT provider_tracking_sessions_arrival_count_check
    CHECK (arrival_qualifying_sample_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT provider_tracking_sessions_state_check
    CHECK (
      (state = 'active' AND stopped_at IS NULL AND stop_reason IS NULL)
      OR
      (state = 'stopped' AND stopped_at IS NOT NULL AND stop_reason IS NOT NULL)
    ),
  CONSTRAINT provider_tracking_sessions_arrival_check
    CHECK (
      (arrival_qualifying_sample_count = 0
        AND arrival_first_qualifying_at IS NULL
        AND arrival_last_qualifying_at IS NULL
        AND arrival_observed_at IS NULL)
      OR
      (arrival_qualifying_sample_count > 0
        AND arrival_first_qualifying_at IS NOT NULL
        AND arrival_last_qualifying_at IS NOT NULL
        AND arrival_last_qualifying_at >= arrival_first_qualifying_at
        AND (
          arrival_observed_at IS NULL
          OR (
            arrival_qualifying_sample_count >= 3
            AND arrival_last_qualifying_at - arrival_first_qualifying_at
              >= INTERVAL '30 seconds'
          )
        ))
    ),
  CONSTRAINT provider_tracking_sessions_request_provider_fkey
    FOREIGN KEY (service_request_id, provider_id)
    REFERENCES service_requests(id, assigned_provider_id),
  UNIQUE (service_request_id, provider_id)
);

CREATE INDEX provider_tracking_sessions_provider_state_idx
  ON provider_tracking_sessions (provider_id, state);
CREATE INDEX provider_tracking_sessions_stopped_at_idx
  ON provider_tracking_sessions (stopped_at)
  WHERE stopped_at IS NOT NULL;

CREATE TABLE provider_location_samples (
  id BIGSERIAL PRIMARY KEY,
  service_request_id BIGINT NOT NULL,
  provider_id TEXT NOT NULL,
  latitude NUMERIC(9,6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude NUMERIC(10,6) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy_meters NUMERIC(10,3) NOT NULL CHECK (accuracy_meters >= 0),
  captured_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  distance_meters NUMERIC(12,3),
  arrival_qualifying BOOLEAN NOT NULL,
  FOREIGN KEY (service_request_id, provider_id)
    REFERENCES provider_tracking_sessions(service_request_id, provider_id),
  UNIQUE (service_request_id, provider_id, captured_at)
);

CREATE INDEX provider_location_samples_retention_idx
  ON provider_location_samples (received_at);
CREATE INDEX provider_location_samples_request_captured_idx
  ON provider_location_samples (service_request_id, captured_at DESC);

CREATE TABLE provider_current_positions (
  service_request_id BIGINT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  latitude NUMERIC(9,6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude NUMERIC(10,6) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy_meters NUMERIC(10,3) NOT NULL CHECK (accuracy_meters >= 0),
  captured_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (service_request_id, provider_id)
    REFERENCES provider_tracking_sessions(service_request_id, provider_id)
);

CREATE INDEX provider_current_positions_provider_idx
  ON provider_current_positions (provider_id);

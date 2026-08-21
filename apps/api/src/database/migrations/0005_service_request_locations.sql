-- Customer-confirmed immutable service location foundation.
-- Existing service requests remain truthful with all four new columns NULL.
-- The existing address column stores the customer-confirmed display address.

ALTER TABLE service_requests
  ADD COLUMN location_latitude NUMERIC(9,6),
  ADD COLUMN location_longitude NUMERIC(10,6),
  ADD COLUMN location_source TEXT,
  ADD COLUMN location_confirmed_at TIMESTAMPTZ,
  ADD CONSTRAINT service_requests_location_completeness_check
    CHECK (
      (location_latitude IS NULL
        AND location_longitude IS NULL
        AND location_source IS NULL
        AND location_confirmed_at IS NULL)
      OR
      (location_latitude IS NOT NULL
        AND location_longitude IS NOT NULL
        AND location_source IS NOT NULL
        AND location_confirmed_at IS NOT NULL)
    ),
  ADD CONSTRAINT service_requests_location_latitude_check
    CHECK (location_latitude IS NULL OR location_latitude BETWEEN -90 AND 90),
  ADD CONSTRAINT service_requests_location_longitude_check
    CHECK (location_longitude IS NULL OR location_longitude BETWEEN -180 AND 180),
  ADD CONSTRAINT service_requests_location_source_check
    CHECK (
      location_source IS NULL
      OR location_source IN ('current_location', 'map_pin')
    );

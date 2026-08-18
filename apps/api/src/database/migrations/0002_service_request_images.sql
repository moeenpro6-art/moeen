ALTER TABLE service_requests
  ADD COLUMN client_submission_id UUID,
  ADD COLUMN submission_fingerprint CHAR(64),
  ADD CONSTRAINT service_requests_submission_pair_check
    CHECK (
      (client_submission_id IS NULL) =
      (submission_fingerprint IS NULL)
    ),
  ADD CONSTRAINT service_requests_submission_fingerprint_check
    CHECK (
      submission_fingerprint IS NULL
      OR submission_fingerprint ~ '^[0-9a-f]{64}$'
    );

CREATE UNIQUE INDEX service_requests_customer_submission_unique
  ON service_requests (customer_id, client_submission_id)
  WHERE client_submission_id IS NOT NULL;

CREATE TABLE service_request_images (
  id UUID PRIMARY KEY,
  service_request_id BIGINT NOT NULL
    REFERENCES service_requests(id) ON DELETE NO ACTION,
  storage_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL
    CONSTRAINT service_request_images_mime_type_check
    CHECK (mime_type = 'image/jpeg'),
  byte_size INTEGER NOT NULL
    CONSTRAINT service_request_images_byte_size_check
    CHECK (byte_size > 0 AND byte_size <= 5242880),
  content_sha256 CHAR(64) NOT NULL
    CONSTRAINT service_request_images_content_sha256_check
    CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  sort_order SMALLINT NOT NULL
    CONSTRAINT service_request_images_sort_order_check
    CHECK (sort_order BETWEEN 0 AND 4),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT service_request_images_request_sort_unique
    UNIQUE (service_request_id, sort_order),
  CONSTRAINT service_request_images_request_content_unique
    UNIQUE (service_request_id, content_sha256)
);

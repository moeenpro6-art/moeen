-- Moeen FCM notification types widening (FCM-2).
--
-- FCM-1's notification_outbox CHECK lists covered only the six foundation
-- notification types and six error kinds. FCM-2 wires the approved Pilot
-- event matrix (customer C1-C7, provider P1-P3; the provider "own quote
-- rejected" push is explicitly OUT of the Pilot) plus one permanent
-- configuration-error classification. This migration ONLY widens the two
-- CHECK lists -- purely additive: no column changes, no data migration, no
-- index changes. Existing rows are unaffected and every FCM-1 value remains
-- accepted ('quote_approved' is retained for FCM-1 compatibility even
-- though the Pilot wiring never emits it).

ALTER TABLE notification_outbox
  DROP CONSTRAINT notification_outbox_notification_type_check,
  ADD CONSTRAINT notification_outbox_notification_type_check
    CHECK (notification_type IN (
      'request_created',
      'quote_received',
      'assignment_confirmed',
      'provider_on_the_way',
      'service_in_progress',
      'request_completed',
      'request_cancelled',
      'opportunity_invited',
      'provider_assigned',
      'opportunity_closed',
      'quote_approved'
    ));

ALTER TABLE notification_outbox
  DROP CONSTRAINT notification_outbox_last_error_kind_check,
  ADD CONSTRAINT notification_outbox_last_error_kind_check
    CHECK (last_error_kind IN (
      'no_active_device',
      'invalid_token',
      'unregistered_token',
      'network_error',
      'throttled',
      'config_error',
      'unknown'
    ));

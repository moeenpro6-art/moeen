import {
  FCM_NAVIGATE_TARGETS,
  FCM_NOTIFICATION_TYPES,
  FCM_PAYLOAD_ALLOWED_FIELDS,
  FCM_PAYLOAD_FORBIDDEN_FIELDS,
  FCM_PAYLOAD_VERSION,
  assertFcmPushPayloadSafe,
  assertOutboxPayloadSafe,
  buildOutboxPayload,
  buildPushPayload,
  customerStatusNotificationType,
  notificationMessageFromPayload,
  toRequestPublicId,
  type FcmNavigateTarget,
  type FcmNotificationType,
} from './notification-templates';

const EXPECTED_NAVIGATION: Record<FcmNotificationType, FcmNavigateTarget> = {
  request_created: 'customer_requests_list',
  quote_received: 'customer_request_detail',
  assignment_confirmed: 'customer_request_detail',
  provider_on_the_way: 'customer_request_detail',
  service_in_progress: 'customer_request_detail',
  request_completed: 'customer_request_detail',
  request_cancelled: 'customer_requests_list',
  opportunity_invited: 'provider_opportunity',
  provider_assigned: 'provider_job',
  opportunity_closed: 'provider_dashboard',
};

describe('canonical FCM notification contract', () => {
  it('maps every approved Pilot event to its exact navigation target', () => {
    expect(FCM_NOTIFICATION_TYPES).toEqual(Object.keys(EXPECTED_NAVIGATION));
    expect(new Set(FCM_NAVIGATE_TARGETS)).toEqual(
      new Set(Object.values(EXPECTED_NAVIGATION)),
    );
    for (const type of FCM_NOTIFICATION_TYPES) {
      expect(buildOutboxPayload(type, 'MOE-1007')).toEqual({
        type,
        requestId: 'MOE-1007',
        navigate: EXPECTED_NAVIGATION[type],
        v: FCM_PAYLOAD_VERSION,
      });
    }
  });

  it('builds exactly the five-field privacy-safe push payload', () => {
    const payload = buildPushPayload(
      'quote_received',
      'MOE-1007',
      'outbox-event-11',
    );
    expect(Object.keys(payload).sort()).toEqual(
      [...FCM_PAYLOAD_ALLOWED_FIELDS].sort(),
    );
    expect(payload).toEqual({
      type: 'quote_received',
      requestId: 'MOE-1007',
      navigate: 'customer_request_detail',
      eventId: 'outbox-event-11',
      v: 1,
    });
    expect(() => assertFcmPushPayloadSafe(payload)).not.toThrow();
  });

  it.each(FCM_PAYLOAD_FORBIDDEN_FIELDS)(
    'rejects forbidden payload field %s',
    (forbiddenField) => {
      const payload: Record<string, unknown> = {
        ...buildPushPayload('request_created', 'MOE-1001', '1'),
        [forbiddenField]: 'forbidden-value',
      };
      expect(() => assertFcmPushPayloadSafe(payload)).toThrow(
        'outside the approved whitelist',
      );
      expect(() =>
        assertOutboxPayloadSafe({
          ...buildOutboxPayload('request_created', 'MOE-1001'),
          [forbiddenField]: 'forbidden-value',
        }),
      ).toThrow('outside the approved whitelist');
    },
  );

  it('rejects unknown types, navigation targets, request ids and versions', () => {
    const valid = buildPushPayload('request_created', 'MOE-1001', '1');
    expect(() =>
      assertFcmPushPayloadSafe({ ...valid, type: 'secret_event' }),
    ).toThrow('unknown notification type');
    expect(() =>
      assertFcmPushPayloadSafe({ ...valid, navigate: 'https://evil.test' }),
    ).toThrow('unknown navigation target');
    expect(() =>
      assertFcmPushPayloadSafe({ ...valid, requestId: '1' }),
    ).toThrow('invalid public request id');
    expect(() => assertFcmPushPayloadSafe({ ...valid, v: 2 })).toThrow(
      'unsupported version',
    );
    expect(() => assertFcmPushPayloadSafe({ ...valid, eventId: '' })).toThrow(
      'missing its event identifier',
    );
  });

  it('renders generic Arabic copy and string-only FCM data from safe payloads', () => {
    for (const type of FCM_NOTIFICATION_TYPES) {
      const message = notificationMessageFromPayload(
        buildPushPayload(type, 'MOE-1015', '87'),
      );
      expect(message.title).toMatch(/[\u0600-\u06ff]/);
      expect(message.body).toMatch(/[\u0600-\u06ff]/);
      expect(message.data).toEqual({
        type,
        requestId: 'MOE-1015',
        navigate: EXPECTED_NAVIGATION[type],
        eventId: '87',
        v: '1',
      });
      expect(
        Object.values(message.data).every((value) => typeof value === 'string'),
      ).toBe(true);
    }
  });

  it('contains no provider own-quote-rejected Pilot notification', () => {
    expect(FCM_NOTIFICATION_TYPES).not.toContain(
      'quote_rejected' as FcmNotificationType,
    );
    expect(FCM_NOTIFICATION_TYPES).not.toContain(
      'own_quote_rejected' as FcmNotificationType,
    );
  });

  it('maps only approved customer status transitions', () => {
    expect(customerStatusNotificationType('on_the_way')).toBe(
      'provider_on_the_way',
    );
    expect(customerStatusNotificationType('in_progress')).toBe(
      'service_in_progress',
    );
    expect(customerStatusNotificationType('completed')).toBe(
      'request_completed',
    );
    expect(customerStatusNotificationType('cancelled')).toBe(
      'request_cancelled',
    );
    expect(customerStatusNotificationType('assigned')).toBeUndefined();
    expect(customerStatusNotificationType('pending_dispatch')).toBeUndefined();
  });

  it('derives the existing public request identifier without exposing a DB-id field', () => {
    expect(toRequestPublicId(7)).toBe('MOE-1007');
    expect(
      buildPushPayload('request_created', toRequestPublicId(7), '1'),
    ).not.toHaveProperty('serviceRequestDatabaseId');
  });
});

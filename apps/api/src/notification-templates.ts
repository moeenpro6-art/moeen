/**
 * Canonical FCM notification contract (FCM-2) -- the single choke point for
 * every push payload and all Pilot notification copy.
 *
 * Privacy rules (architecture report section 4, enforced by tests):
 * a push payload may contain ONLY the approved fields below. Customer
 * contact data, names, DB ids, tokens, addresses, details, images, storage
 * keys, quote scope/free text and amounts are all FORBIDDEN. Full data is
 * always re-fetched from the authenticated API after the app opens. The
 * only request identifier allowed anywhere is the existing public MOE-XXXX
 * form.
 */

export type FcmNotificationType =
  | 'request_created'
  | 'quote_received'
  | 'assignment_confirmed'
  | 'provider_on_the_way'
  | 'service_in_progress'
  | 'request_completed'
  | 'request_cancelled'
  | 'opportunity_invited'
  | 'provider_assigned'
  | 'opportunity_closed';

export type FcmNavigateTarget =
  | 'customer_requests_list'
  | 'customer_request_detail'
  | 'provider_opportunity'
  | 'provider_job'
  | 'provider_dashboard';

export const FCM_PAYLOAD_VERSION = 1;

/** Exact whitelist of push data-payload fields. Nothing else may appear. */
export const FCM_PAYLOAD_ALLOWED_FIELDS = [
  'type',
  'requestId',
  'navigate',
  'eventId',
  'v',
] as const;

export const FCM_NOTIFICATION_TYPES: readonly FcmNotificationType[] = [
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
];

export const FCM_NAVIGATE_TARGETS: readonly FcmNavigateTarget[] = [
  'customer_requests_list',
  'customer_request_detail',
  'provider_opportunity',
  'provider_job',
  'provider_dashboard',
];

const FCM_NOTIFICATION_TYPE_SET = new Set<string>(FCM_NOTIFICATION_TYPES);
const FCM_NAVIGATE_TARGET_SET = new Set<string>(FCM_NAVIGATE_TARGETS);

/**
 * Fields that MUST NEVER enter a push payload. Tests iterate this list and
 * assert every one is rejected by the payload contract.
 */
export const FCM_PAYLOAD_FORBIDDEN_FIELDS = [
  'customerPhone',
  'customerName',
  'customerEmail',
  'customerId',
  'providerId',
  'phone',
  'email',
  'address',
  'latitude',
  'longitude',
  'location',
  'locationLatitude',
  'locationLongitude',
  'serviceLocation',
  'providerLocation',
  'liveLocation',
  'trackingHistory',
  'coordinates',
  'coordinate',
  'mapUrl',
  'mapURL',
  'mapsUrl',
  'mapsURL',
  'details',
  'description',
  'images',
  'imageUrl',
  'imageUrls',
  'signedUrl',
  'storageKey',
  'scope',
  'quoteScope',
  'amount',
  'amountHalalas',
  'token',
  'fcmToken',
  'authToken',
  'sessionToken',
] as const;

export type FcmPushPayload = {
  type: FcmNotificationType;
  requestId: string;
  navigate: FcmNavigateTarget;
  eventId: string;
  v: typeof FCM_PAYLOAD_VERSION;
};

/** Public MOE-XXXX request identifier from the internal database id. */
export function toRequestPublicId(databaseId: number): string {
  return `MOE-${1000 + databaseId}`;
}

const NAVIGATE_BY_TYPE: Record<FcmNotificationType, FcmNavigateTarget> = {
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

/**
 * The only statuses that produce a customer push; mirrors the transitions
 * accepted by ServiceRequestRepository.updateStatus /
 * updateStatusForProvider. Returns undefined for statuses that never push.
 */
export function customerStatusNotificationType(
  status: string,
): FcmNotificationType | undefined {
  switch (status) {
    case 'on_the_way':
      return 'provider_on_the_way';
    case 'in_progress':
      return 'service_in_progress';
    case 'completed':
      return 'request_completed';
    case 'cancelled':
      return 'request_cancelled';
    default:
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Full push payload (all five fields present): enforces the exact key
 * whitelist and the enum values. Throws on ANY deviation -- including any
 * attempt to smuggle a forbidden field alongside the allowed ones.
 */
export function assertFcmPushPayloadSafe(
  value: unknown,
): asserts value is FcmPushPayload {
  if (!isRecord(value)) throw new Error('FCM payload must be an object');
  const keys = Object.keys(value).sort();
  const expected = [...FCM_PAYLOAD_ALLOWED_FIELDS].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new Error(
      'FCM payload contains fields outside the approved whitelist',
    );
  }
  if (
    typeof value.type !== 'string' ||
    !FCM_NOTIFICATION_TYPE_SET.has(value.type)
  ) {
    throw new Error('FCM payload has an unknown notification type');
  }
  if (
    typeof value.requestId !== 'string' ||
    !/^MOE-\d+$/.test(value.requestId)
  ) {
    throw new Error('FCM payload has an invalid public request id');
  }
  if (
    typeof value.navigate !== 'string' ||
    !FCM_NAVIGATE_TARGET_SET.has(value.navigate)
  ) {
    throw new Error('FCM payload has an unknown navigation target');
  }
  if (typeof value.eventId !== 'string' || value.eventId.length === 0) {
    throw new Error('FCM payload is missing its event identifier');
  }
  if (value.v !== FCM_PAYLOAD_VERSION) {
    throw new Error('FCM payload has an unsupported version');
  }
}

/**
 * Outbox pre-insert payload (eventId is added after the row id exists):
 * same whitelist minus eventId.
 */
export function assertOutboxPayloadSafe(value: unknown): asserts value is {
  type: FcmNotificationType;
  requestId: string;
  navigate: FcmNavigateTarget;
  v: typeof FCM_PAYLOAD_VERSION;
} {
  if (!isRecord(value)) throw new Error('FCM payload must be an object');
  const keys = Object.keys(value).sort();
  const expected = [...FCM_PAYLOAD_ALLOWED_FIELDS]
    .filter((key) => key !== 'eventId')
    .sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new Error(
      'FCM payload contains fields outside the approved whitelist',
    );
  }
  if (
    typeof value.type !== 'string' ||
    !FCM_NOTIFICATION_TYPE_SET.has(value.type)
  ) {
    throw new Error('FCM payload has an unknown notification type');
  }
  if (
    typeof value.requestId !== 'string' ||
    !/^MOE-\d+$/.test(value.requestId)
  ) {
    throw new Error('FCM payload has an invalid public request id');
  }
  if (
    typeof value.navigate !== 'string' ||
    !FCM_NAVIGATE_TARGET_SET.has(value.navigate)
  ) {
    throw new Error('FCM payload has an unknown navigation target');
  }
  if (value.v !== FCM_PAYLOAD_VERSION) {
    throw new Error('FCM payload has an unsupported version');
  }
}

/** Payload for a fresh outbox INSERT (eventId not yet known). */
export function buildOutboxPayload(
  type: FcmNotificationType,
  requestId: string,
): {
  type: FcmNotificationType;
  requestId: string;
  navigate: FcmNavigateTarget;
  v: typeof FCM_PAYLOAD_VERSION;
} {
  return {
    type,
    requestId,
    navigate: NAVIGATE_BY_TYPE[type],
    v: FCM_PAYLOAD_VERSION,
  };
}

/** Full contract payload including the outbox event identifier. */
export function buildPushPayload(
  type: FcmNotificationType,
  requestId: string,
  eventId: string,
): FcmPushPayload {
  return {
    ...buildOutboxPayload(type, requestId),
    eventId,
  };
}

/**
 * Generic, privacy-safe Arabic copy. Bodies interpolate ONLY the public
 * MOE-XXXX request identifier; titles are constant. Exact wording is a
 * product-approval item (architecture open decision #1).
 */
const ARABIC_COPY: Record<
  FcmNotificationType,
  { title: string; body: (requestId: string) => string }
> = {
  request_created: {
    title: 'تم استلام طلبك',
    body: () => 'تم استلام طلبك بنجاح، وسيتم إرسال عروض الأسعار إليك قريبًا.',
  },
  quote_received: {
    title: 'وصل عرض سعر جديد',
    body: (requestId) =>
      `وصل عرض سعر على طلبك ${requestId}. افتح التطبيق للاطلاع عليه.`,
  },
  assignment_confirmed: {
    title: 'تم تأكيد طلبك',
    body: (requestId) =>
      `تم تأكيد طلبك ${requestId}. تابع حالة الطلب من التطبيق.`,
  },
  provider_on_the_way: {
    title: 'مقدم الخدمة في الطريق',
    body: (requestId) => `مقدم الخدمة في الطريق إليك لطلبك ${requestId}.`,
  },
  service_in_progress: {
    title: 'بدأ تنفيذ الخدمة',
    body: (requestId) => `بدأ مقدم الخدمة تنفيذ طلبك ${requestId}.`,
  },
  request_completed: {
    title: 'اكتملت الخدمة',
    body: (requestId) => `اكتمل تنفيذ طلبك ${requestId}. فضلًا قيّم تجربتك.`,
  },
  request_cancelled: {
    title: 'تم إلغاء الطلب',
    body: (requestId) => `تم إلغاء طلبك ${requestId}.`,
  },
  opportunity_invited: {
    title: 'فرصة عمل جديدة',
    body: (requestId) => `طلب جديد متاح لك برقم ${requestId}. قدّم عرضك الآن.`,
  },
  provider_assigned: {
    title: 'تم إسناد طلب إليك',
    body: (requestId) => `تم إسناد الطلب ${requestId} إليك. اطلع على التفاصيل.`,
  },
  opportunity_closed: {
    title: 'تم إغلاق فرصة عمل',
    body: (requestId) => `تم إغلاق فرصة الطلب ${requestId} لاختيار مقدم آخر.`,
  },
};

export type FcmNotificationMessage = {
  title: string;
  body: string;
  data: Record<string, string>;
};

/**
 * Message for FCM send, built ONLY from the stored outbox payload. Validates
 * the stored payload against the contract (unknown type, extra fields, or
 * missing eventId throw -- the row is dead-lettered, never sent).
 */
export function notificationMessageFromPayload(
  payload: unknown,
): FcmNotificationMessage {
  assertFcmPushPayloadSafe(payload);
  const copy = ARABIC_COPY[payload.type];
  return {
    title: copy.title,
    body: copy.body(payload.requestId),
    data: {
      type: payload.type,
      requestId: payload.requestId,
      navigate: payload.navigate,
      eventId: payload.eventId,
      v: String(payload.v),
    },
  };
}

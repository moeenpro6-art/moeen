export type ApiServiceRequestEvent = {
  type: string;
  status: string;
  createdAt: string;
};

export type ApiServiceQuote = {
  id: string;
  providerId?: string;
  providerName?: string;
  amountHalalas: number;
  scope: string;
  status: 'proposed' | 'approved' | 'rejected' | 'withdrawn';
};

export type ApiServiceOpportunitySummary = {
  invited: number;
  quoted: number;
  withdrawn: number;
  closed: number;
  rejected: number;
  total: number;
};

/**
 * Public projection of a committed request image (`RequestImageDto`).
 * Only safe public fields are kept: no storage keys, bucket details,
 * credentials, or internal URLs ever reach the dashboard.
 */
export type ApiRequestImage = {
  id: string;
  mimeType: string;
  byteSize: number;
  sortOrder: number;
  url: string;
  urlExpiresAt?: string;
};

export type ApiServicePayment = {
  id: string;
  amountHalalas: number;
  currency: 'SAR';
  method: 'cash_on_completion' | 'paymob';
  status:
    | 'cash_due'
    | 'cash_collected'
    | 'checkout_created'
    | 'paid'
    | 'failed'
    | 'refund_pending'
    | 'refunded';
  createdAt: string;
  collectedAt?: string;
  refundedAt?: string;
};

export type ApiServiceRequest = {
  id: string;
  serviceId: string;
  address: string;
  details?: string;
  timing: string;
  status: string;
  location?: {
    point: { latitude: number; longitude: number };
    displayAddress: string;
    source: string;
    confirmedAt: string;
  };
  assignedProvider?: { name: string };
  quote?: ApiServiceQuote;
  opportunities?: ApiServiceOpportunitySummary;
  payment?: ApiServicePayment;
  rating?: number;
  ratingComment?: string;
  images?: ApiRequestImage[];
  createdAt: string;
};

export type DashboardQuote = ApiServiceQuote;

export type DashboardRequest = {
  id: string;
  serviceId: string;
  service: string;
  area: string;
  status: string;
  statusKey: string;
  provider: string;
  serviceLocation?: { latitude: number; longitude: number };
  quote?: DashboardQuote;
  opportunities?: ApiServiceOpportunitySummary;
  payment?: ApiServicePayment;
  rating?: number;
  ratingComment?: string;
  images?: ApiRequestImage[];
};

const serviceNames: Record<string, string> = {
  'ac-cleaning': 'تنظيف المكيفات',
  upholstery: 'غسيل الكنب والمجالس',
  'home-cleaning': 'تنظيف المنازل',
  'tank-cleaning': 'تنظيف الخزانات',
  plumbing: 'سباكة وتسربات',
};

const statuses: Record<string, string> = {
  pending_dispatch: 'بانتظار التوزيع',
  assigned: 'تم التعيين',
  on_the_way: 'الفني في الطريق',
  in_progress: 'قيد التنفيذ',
  completed: 'مكتمل',
  cancelled: 'ملغي',
};

export function isApiServiceRequestEvent(
  value: unknown,
): value is ApiServiceRequestEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.type === 'string' &&
    typeof event.status === 'string' &&
    typeof event.createdAt === 'string'
  );
}

export function requestEventLabel(event: ApiServiceRequestEvent): string {
  if (event.type === 'request_created') return 'تم استلام الطلب';
  if (event.type === 'provider_assigned') return 'تم تعيين مقدم الخدمة';
  if (event.type === 'quote_proposed') return 'تم إرسال عرض السعر';
  if (event.type === 'quote_approved') return 'وافق العميل على عرض السعر';
  if (event.type === 'quote_rejected') return 'رفض العميل عرض السعر';
  if (event.type === 'opportunity_invited') return 'تمت دعوة مقدم خدمة من السوق';
  if (event.type === 'opportunity_closed') return 'أُغلقت فرصة السوق';
  if (event.type === 'provider_quote_submitted') return 'قدّم مقدم الخدمة عرضًا من السوق';
  if (event.type === 'provider_quote_withdrawn') return 'سحب مقدم الخدمة عرضه';
  if (event.type === 'status_updated') {
    return `تحديث الحالة: ${statuses[event.status] ?? event.status}`;
  }
  return event.type;
}

export function toDashboardRequest(request: ApiServiceRequest): DashboardRequest {
  return {
    id: request.id,
    serviceId: request.serviceId,
    service: serviceNames[request.serviceId] ?? request.serviceId,
    area: request.address,
    status: statuses[request.status] ?? request.status,
    statusKey: request.status,
    provider: request.assignedProvider?.name ?? 'لم يُعيّن بعد',
    ...(request.location?.point ? { serviceLocation: request.location.point } : {}),
    ...(request.quote ? { quote: request.quote } : {}),
    ...(request.opportunities
      ? { opportunities: request.opportunities }
      : {}),
    ...(request.payment ? { payment: request.payment } : {}),
    ...(request.images && request.images.length > 0
      ? {
          // Preserve the server sort order deterministically.
          images: [...request.images].sort(
            (left, right) => left.sortOrder - right.sortOrder,
          ),
        }
      : {}),
    rating: request.rating,
    ratingComment: request.ratingComment,
  };
}

function isApiServiceQuote(value: unknown): value is ApiServiceQuote {
  if (typeof value !== 'object' || value === null) return false;
  const quote = value as Record<string, unknown>;
  return (
    typeof quote.id === 'string' &&
    Number.isInteger(quote.amountHalalas) &&
    Number(quote.amountHalalas) > 0 &&
    typeof quote.scope === 'string' &&
    ['proposed', 'approved', 'rejected', 'withdrawn'].includes(
      String(quote.status),
    ) &&
    (quote.providerId === undefined || typeof quote.providerId === 'string') &&
    (quote.providerName === undefined ||
      typeof quote.providerName === 'string')
  );
}

function isApiServiceOpportunitySummary(
  value: unknown,
): value is ApiServiceOpportunitySummary {
  if (typeof value !== 'object' || value === null) return false;
  const summary = value as Record<string, unknown>;
  return (
    ['invited', 'quoted', 'withdrawn', 'closed', 'rejected', 'total'].every(
      (key) => Number.isInteger(summary[key]) && Number(summary[key]) >= 0,
    )
  );
}

function isApiServicePayment(value: unknown): value is ApiServicePayment {
  if (typeof value !== 'object' || value === null) return false;
  const payment = value as Record<string, unknown>;
  return (
    typeof payment.id === 'string' &&
    Number.isInteger(payment.amountHalalas) &&
    Number(payment.amountHalalas) > 0 &&
    payment.currency === 'SAR' &&
    ['cash_on_completion', 'paymob'].includes(String(payment.method)) &&
    [
      'cash_due',
      'cash_collected',
      'checkout_created',
      'paid',
      'failed',
      'refund_pending',
      'refunded',
    ].includes(String(payment.status)) &&
    typeof payment.createdAt === 'string' &&
    (payment.collectedAt === undefined || typeof payment.collectedAt === 'string') &&
    (payment.refundedAt === undefined || typeof payment.refundedAt === 'string')
  );
}

export function isApiRequestImage(value: unknown): value is ApiRequestImage {
  if (typeof value !== 'object' || value === null) return false;
  const image = value as Record<string, unknown>;
  if (typeof image.id !== 'string' || image.id.length === 0) return false;
  if (typeof image.mimeType !== 'string') return false;
  if (!Number.isInteger(image.byteSize) || Number(image.byteSize) < 0) {
    return false;
  }
  if (!Number.isInteger(image.sortOrder)) return false;
  if (typeof image.url !== 'string') return false;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(image.url);
  } catch {
    return false;
  }
  // Only http(s) URLs are accepted: javascript:/data:/file: schemes and
  // malformed URLs never reach an <img> src on the dashboard.
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return false;
  }
  return (
    image.urlExpiresAt === undefined || typeof image.urlExpiresAt === 'string'
  );
}

export function isApiServiceRequest(value: unknown): value is ApiServiceRequest {
  if (typeof value !== 'object' || value === null) return false;

  const request = value as Record<string, unknown>;
  return (
    [
      'id',
      'serviceId',
      'address',
      'timing',
      'status',
      'createdAt',
    ].every((key) => typeof request[key] === 'string') &&
    (request.quote === undefined || isApiServiceQuote(request.quote)) &&
    (request.opportunities === undefined ||
      isApiServiceOpportunitySummary(request.opportunities)) &&
    (request.payment === undefined || isApiServicePayment(request.payment)) &&
    (request.images === undefined ||
      (Array.isArray(request.images) &&
        request.images.every(isApiRequestImage)))
  );
}

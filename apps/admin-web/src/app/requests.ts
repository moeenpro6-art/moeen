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
  assignedProvider?: { name: string };
  quote?: ApiServiceQuote;
  opportunities?: ApiServiceOpportunitySummary;
  payment?: ApiServicePayment;
  rating?: number;
  ratingComment?: string;
  createdAt: string;
};

export type DashboardQuote = ApiServiceQuote;

export type DashboardRequest = {
  id: string;
  serviceId: string;
  service: string;
  area: string;
  status: string;
  provider: string;
  quote?: DashboardQuote;
  opportunities?: ApiServiceOpportunitySummary;
  payment?: ApiServicePayment;
  rating?: number;
  ratingComment?: string;
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
    provider: request.assignedProvider?.name ?? 'لم يُعيّن بعد',
    ...(request.quote ? { quote: request.quote } : {}),
    ...(request.opportunities
      ? { opportunities: request.opportunities }
      : {}),
    ...(request.payment ? { payment: request.payment } : {}),
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
    (request.payment === undefined || isApiServicePayment(request.payment))
  );
}

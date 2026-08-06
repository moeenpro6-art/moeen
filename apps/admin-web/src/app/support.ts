export type ApiSupportTicket = {
  id: string;
  requestId: string;
  category: string;
  comment: string;
  status: string;
  createdAt: string;
};

export type DashboardSupportTicket = {
  id: string;
  requestId: string;
  category: string;
  comment: string;
  status: string;
};

const categories: Record<string, string> = {
  no_show: 'الفني لم يصل',
  price: 'السعر مختلف عن المتوقع',
  quality: 'الخدمة غير مرضية',
  payment: 'مشكلة في الدفع',
  other: 'سبب آخر',
};

const statuses: Record<string, string> = {
  open: 'جديد',
  in_progress: 'قيد المتابعة',
  resolved: 'تم الحل',
};

export function toDashboardSupportTicket(
  ticket: ApiSupportTicket,
): DashboardSupportTicket {
  return {
    id: ticket.id,
    requestId: ticket.requestId,
    category: categories[ticket.category] ?? ticket.category,
    comment: ticket.comment,
    status: statuses[ticket.status] ?? ticket.status,
  };
}

export function isApiSupportTicket(value: unknown): value is ApiSupportTicket {
  if (typeof value !== 'object' || value === null) return false;
  const ticket = value as Record<string, unknown>;
  return ['id', 'requestId', 'category', 'comment', 'status', 'createdAt'].every(
    (key) => typeof ticket[key] === 'string',
  );
}

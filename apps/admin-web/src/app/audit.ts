type AuditState = Record<string, unknown> | undefined;

export type ApiAuditEvent = {
  id: string;
  actor: { id: string; displayName: string };
  action: string;
  subjectType: string;
  subjectId: string;
  oldState?: AuditState;
  newState?: AuditState;
  createdAt: string;
};

export type DashboardAuditEvent = {
  id: string;
  actorName: string;
  action: string;
  subjectId: string;
  oldStatus?: string;
  newStatus?: string;
  createdAt: string;
};

const actionLabels: Record<string, string> = {
  'request.provider_assigned': 'تعيين مقدم خدمة',
  'request.status_updated': 'تحديث حالة الطلب',
  'support_ticket.status_updated': 'تحديث حالة طلب المساعدة',
};

const statusLabels: Record<string, string> = {
  pending_dispatch: 'بانتظار التوزيع',
  assigned: 'تم التعيين',
  on_the_way: 'الفني في الطريق',
  in_progress: 'قيد التنفيذ',
  completed: 'مكتمل',
  cancelled: 'ملغي',
  open: 'جديد',
  resolved: 'تم الحل',
};

function stateStatus(state: AuditState): string | undefined {
  const status = state?.status;
  return typeof status === 'string' ? statusLabels[status] ?? status : undefined;
}

export function isApiAuditEvent(value: unknown): value is ApiAuditEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const actor = candidate.actor;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.action === 'string' &&
    typeof candidate.subjectType === 'string' &&
    typeof candidate.subjectId === 'string' &&
    typeof candidate.createdAt === 'string' &&
    typeof actor === 'object' &&
    actor !== null &&
    typeof (actor as Record<string, unknown>).id === 'string' &&
    typeof (actor as Record<string, unknown>).displayName === 'string'
  );
}

export function toDashboardAuditEvent(
  event: ApiAuditEvent,
): DashboardAuditEvent {
  return {
    id: event.id,
    actorName: event.actor.displayName,
    action: actionLabels[event.action] ?? 'إجراء تشغيلي',
    subjectId: event.subjectId,
    oldStatus: stateStatus(event.oldState),
    newStatus: stateStatus(event.newState),
    createdAt: event.createdAt,
  };
}

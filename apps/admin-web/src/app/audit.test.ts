import assert from 'node:assert/strict';
import test from 'node:test';
import { isApiAuditEvent, toDashboardAuditEvent } from './audit';

test('toDashboardAuditEvent translates a safe request status audit event', () => {
  assert.deepEqual(
    toDashboardAuditEvent({
      id: 'AUD-1001',
      actor: { id: 'STF-1001', displayName: 'مدير معين' },
      action: 'request.status_updated',
      subjectType: 'service_request',
      subjectId: 'MOE-1048',
      oldState: { status: 'assigned' },
      newState: { status: 'on_the_way' },
      createdAt: '2026-08-04T12:00:00.000Z',
    }),
    {
      id: 'AUD-1001',
      actorName: 'مدير معين',
      action: 'تحديث حالة الطلب',
      subjectId: 'MOE-1048',
      oldStatus: 'تم التعيين',
      newStatus: 'الفني في الطريق',
      createdAt: '2026-08-04T12:00:00.000Z',
    },
  );
});

test('isApiAuditEvent rejects malformed events before they reach the audit UI', () => {
  assert.equal(
    isApiAuditEvent({
      id: 'AUD-1002',
      actor: { id: 'STF-1001', displayName: 'مدير معين' },
      action: 'request.status_updated',
      subjectId: 'MOE-1048',
    }),
    false,
  );
});

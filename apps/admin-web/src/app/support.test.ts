import assert from 'node:assert/strict';
import test from 'node:test';
import { toDashboardSupportTicket } from './support';

test('toDashboardSupportTicket translates an open quality complaint for operations', () => {
  assert.deepEqual(
    toDashboardSupportTicket({
      id: 'SUP-1001',
      requestId: 'MOE-1042',
      category: 'quality',
      comment: 'الخدمة غير مرضية',
      status: 'open',
      createdAt: '2026-08-04T10:00:00.000Z',
    }),
    {
      id: 'SUP-1001',
      requestId: 'MOE-1042',
      category: 'الخدمة غير مرضية',
      comment: 'الخدمة غير مرضية',
      status: 'جديد',
    },
  );
});

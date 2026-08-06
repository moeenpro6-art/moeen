import { StaffAuditService, type StaffAuditStore } from './staff-audit.service';

const actor = {
  id: 'STF-1001',
  email: 'admin@example.test',
  displayName: 'مدير معين',
  role: 'admin' as const,
};

describe('StaffAuditService', () => {
  it('records a role-safe request status transition for the authenticated actor', async () => {
    const store: jest.Mocked<StaffAuditStore> = {
      appendAuditEvent: jest.fn().mockResolvedValue(undefined),
      listAuditEvents: jest.fn(),
    };
    const service = new StaffAuditService(store);

    await service.record(actor, {
      action: 'request.status_updated',
      subjectType: 'service_request',
      subjectId: 'MOE-1048',
      oldState: { status: 'assigned' },
      newState: { status: 'on_the_way' },
    });

    expect(store.appendAuditEvent.mock.calls).toEqual([
      [
        {
          staffId: actor.id,
          action: 'request.status_updated',
          subjectType: 'service_request',
          subjectId: 'MOE-1048',
          oldState: { status: 'assigned' },
          newState: { status: 'on_the_way' },
        },
      ],
    ]);
  });
});

import { AppController } from './app.controller';
import type { AppService } from './app.service';
import type { StaffAuditService } from './staff-audit.service';
import type { StaffAuthService } from './staff-auth.service';
import type { CustomerAuthService } from './customer-auth.service';

const actor = {
  id: 'STF-1001',
  email: 'dispatcher@example.test',
  displayName: 'موظف التشغيل',
  role: 'dispatcher' as const,
};

describe('AppController staff audit integration', () => {
  it('registers a pilot provider as pending and records the admin action', async () => {
    const adminActor = { ...actor, role: 'admin' as const };
    const provider = {
      id: 'PILOT-provider',
      name: 'فريق اختبار التبريد',
      specialties: ['ac-cleaning'],
      serviceZone: 'حي الصفراء، بريدة',
      verificationStatus: 'pending',
      available: false,
    };
    const appService = {
      registerPilotProvider: jest.fn().mockResolvedValue(provider),
    };
    const staffAuthService = {
      getCurrentStaff: jest.fn().mockResolvedValue(adminActor),
    };
    const auditService = { record: jest.fn().mockResolvedValue(undefined) };
    const controller = new AppController(
      appService as unknown as AppService,
      staffAuthService as unknown as StaffAuthService,
      auditService as unknown as StaffAuditService,
    );

    await (
      controller as unknown as {
        createPilotProvider: (
          authorization: string,
          input: {
            name: string;
            specialties: string[];
            serviceZone: string;
          },
        ) => Promise<typeof provider>;
      }
    ).createPilotProvider('Bearer staff-session', {
      name: provider.name,
      specialties: provider.specialties,
      serviceZone: provider.serviceZone,
    });

    expect(auditService.record).toHaveBeenCalledWith(adminActor, {
      action: 'provider.pilot_registered',
      subjectType: 'provider',
      subjectId: provider.id,
      newState: {
        verificationStatus: 'pending',
        serviceZone: provider.serviceZone,
      },
    });
  });

  it('verifies a pilot provider and retains the previous state in the audit trail', async () => {
    const adminActor = { ...actor, role: 'admin' as const };
    const pendingProvider = {
      id: 'PILOT-provider',
      name: 'فريق اختبار التبريد',
      specialties: ['ac-cleaning'],
      serviceZone: 'حي الصفراء، بريدة',
      verificationStatus: 'pending',
      available: false,
    };
    const verifiedProvider = {
      ...pendingProvider,
      verificationStatus: 'verified',
      available: true,
    };
    const appService = {
      getProviders: jest.fn().mockResolvedValue([pendingProvider]),
      verifyPilotProvider: jest.fn().mockResolvedValue(verifiedProvider),
    };
    const staffAuthService = {
      getCurrentStaff: jest.fn().mockResolvedValue(adminActor),
    };
    const auditService = { record: jest.fn().mockResolvedValue(undefined) };
    const controller = new AppController(
      appService as unknown as AppService,
      staffAuthService as unknown as StaffAuthService,
      auditService as unknown as StaffAuditService,
    );

    await (
      controller as unknown as {
        verifyPilotProvider: (
          authorization: string,
          providerId: string,
        ) => Promise<typeof verifiedProvider>;
      }
    ).verifyPilotProvider('Bearer staff-session', pendingProvider.id);

    expect(auditService.record).toHaveBeenCalledWith(adminActor, {
      action: 'provider.pilot_verified',
      subjectType: 'provider',
      subjectId: pendingProvider.id,
      oldState: { verificationStatus: 'pending', available: false },
      newState: { verificationStatus: 'verified', available: true },
    });
  });

  it('suspends a verified pilot provider and removes dispatch availability', async () => {
    const adminActor = { ...actor, role: 'admin' as const };
    const activeProvider = {
      id: 'PILOT-provider',
      name: 'فريق اختبار التبريد',
      specialties: ['ac-cleaning'],
      serviceZone: 'حي الصفراء، بريدة',
      verificationStatus: 'verified',
      available: true,
    };
    const suspendedProvider = {
      ...activeProvider,
      verificationStatus: 'suspended',
      available: false,
    };
    const appService = {
      getProviders: jest.fn().mockResolvedValue([activeProvider]),
      suspendPilotProvider: jest.fn().mockResolvedValue(suspendedProvider),
    };
    const staffAuthService = {
      getCurrentStaff: jest.fn().mockResolvedValue(adminActor),
    };
    const auditService = { record: jest.fn().mockResolvedValue(undefined) };
    const controller = new AppController(
      appService as unknown as AppService,
      staffAuthService as unknown as StaffAuthService,
      auditService as unknown as StaffAuditService,
    );

    await (
      controller as unknown as {
        suspendPilotProvider: (
          authorization: string,
          providerId: string,
        ) => Promise<typeof suspendedProvider>;
      }
    ).suspendPilotProvider('Bearer staff-session', activeProvider.id);

    expect(auditService.record).toHaveBeenCalledWith(adminActor, {
      action: 'provider.pilot_suspended',
      subjectType: 'provider',
      subjectId: activeProvider.id,
      oldState: { verificationStatus: 'verified', available: true },
      newState: { verificationStatus: 'suspended', available: false },
    });
  });

  it('reactivates a suspended pilot provider only through the admin workflow', async () => {
    const adminActor = { ...actor, role: 'admin' as const };
    const suspendedProvider = {
      id: 'PILOT-provider',
      name: 'فريق اختبار التبريد',
      specialties: ['ac-cleaning'],
      serviceZone: 'حي الصفراء، بريدة',
      verificationStatus: 'suspended',
      available: false,
    };
    const reactivatedProvider = {
      ...suspendedProvider,
      verificationStatus: 'verified',
      available: true,
    };
    const appService = {
      getProviders: jest.fn().mockResolvedValue([suspendedProvider]),
      reactivatePilotProvider: jest.fn().mockResolvedValue(reactivatedProvider),
    };
    const staffAuthService = {
      getCurrentStaff: jest.fn().mockResolvedValue(adminActor),
    };
    const auditService = { record: jest.fn().mockResolvedValue(undefined) };
    const controller = new AppController(
      appService as unknown as AppService,
      staffAuthService as unknown as StaffAuthService,
      auditService as unknown as StaffAuditService,
    );

    await (
      controller as unknown as {
        reactivatePilotProvider: (
          authorization: string,
          providerId: string,
        ) => Promise<typeof reactivatedProvider>;
      }
    ).reactivatePilotProvider('Bearer staff-session', suspendedProvider.id);

    expect(auditService.record).toHaveBeenCalledWith(adminActor, {
      action: 'provider.pilot_reactivated',
      subjectType: 'provider',
      subjectId: suspendedProvider.id,
      oldState: { verificationStatus: 'suspended', available: false },
      newState: { verificationStatus: 'verified', available: true },
    });
  });

  it('records the old and new support ticket status for an authorized support agent', async () => {
    const supportActor = { ...actor, role: 'support_agent' as const };
    const appService = {
      getSupportTickets: jest
        .fn()
        .mockResolvedValue([{ id: 'SUP-1006', status: 'open' }]),
      updateSupportTicketStatus: jest.fn().mockResolvedValue({
        id: 'SUP-1006',
        status: 'in_progress',
      }),
    };
    const staffAuthService = {
      getCurrentStaff: jest.fn().mockResolvedValue(supportActor),
    };
    const auditService = { record: jest.fn().mockResolvedValue(undefined) };
    const controller = new AppController(
      appService as unknown as AppService,
      staffAuthService as unknown as StaffAuthService,
      auditService as unknown as StaffAuditService,
    );

    await controller.updateSupportTicketStatus(
      'Bearer staff-session',
      'SUP-1006',
      {
        status: 'in_progress',
      },
    );

    expect(auditService.record).toHaveBeenCalledWith(supportActor, {
      action: 'support_ticket.status_updated',
      subjectType: 'support_ticket',
      subjectId: 'SUP-1006',
      oldState: { status: 'open' },
      newState: { status: 'in_progress' },
    });
  });

  it('records the previous request state after an authorized provider assignment', async () => {
    const appService = {
      getServiceRequests: jest
        .fn()
        .mockResolvedValue([{ id: 'MOE-1048', status: 'pending_dispatch' }]),
      assignProvider: jest.fn().mockResolvedValue({
        id: 'MOE-1048',
        status: 'assigned',
        assignedProvider: { id: 'provider-2' },
      }),
    };
    const staffAuthService = {
      getCurrentStaff: jest.fn().mockResolvedValue(actor),
    };
    const auditService = { record: jest.fn().mockResolvedValue(undefined) };
    const controller = new AppController(
      appService as unknown as AppService,
      staffAuthService as unknown as StaffAuthService,
      auditService as unknown as StaffAuditService,
    );

    await controller.assignProvider('Bearer staff-session', 'MOE-1048', {
      providerId: 'provider-2',
    });

    expect(auditService.record).toHaveBeenCalledWith(actor, {
      action: 'request.provider_assigned',
      subjectType: 'service_request',
      subjectId: 'MOE-1048',
      oldState: { status: 'pending_dispatch', providerId: null },
      newState: { status: 'assigned', providerId: 'provider-2' },
    });
  });

  it('returns the lifecycle history for an authenticated customer request', async () => {
    const events = [
      {
        type: 'request_created' as const,
        status: 'pending_dispatch' as const,
        createdAt: '2026-08-05T01:00:00.000Z',
      },
    ];
    const appService = {
      getMyServiceRequestEvents: jest.fn().mockResolvedValue(events),
    };
    const controller = new AppController(
      appService as unknown as AppService,
      {} as StaffAuthService,
      {} as StaffAuditService,
      {} as CustomerAuthService,
    );
    const historyController = controller as unknown as {
      getMyServiceRequestEvents: (
        authorization: string,
        requestId: string,
      ) => Promise<typeof events>;
    };
    expect(typeof historyController.getMyServiceRequestEvents).toBe('function');

    await expect(
      historyController.getMyServiceRequestEvents(
        'Bearer customer-session',
        'MOE-1048',
      ),
    ).resolves.toEqual(events);
    expect(appService.getMyServiceRequestEvents).toHaveBeenCalledWith(
      'customer-session',
      'MOE-1048',
    );
  });

  it('records an authorized quote proposal in the staff audit trail', async () => {
    const quote = {
      id: 'QTE-7',
      amountHalalas: 15_000,
      scope: 'إصلاح تسرب تحت المغسلة',
      status: 'proposed' as const,
      proposedAt: '2026-08-05T01:00:00.000Z',
    };
    const appService = { proposeQuote: jest.fn().mockResolvedValue(quote) };
    const staffAuthService = {
      getCurrentStaff: jest.fn().mockResolvedValue(actor),
    };
    const auditService = { record: jest.fn().mockResolvedValue(undefined) };
    const controller = new AppController(
      appService as unknown as AppService,
      staffAuthService as unknown as StaffAuthService,
      auditService as unknown as StaffAuditService,
      {} as CustomerAuthService,
    );
    const quoteController = controller as unknown as {
      proposeQuote: (
        authorization: string,
        requestId: string,
        input: { amountHalalas: number; scope: string },
      ) => Promise<typeof quote>;
    };
    expect(typeof quoteController.proposeQuote).toBe('function');

    await expect(
      quoteController.proposeQuote('Bearer staff-session', 'MOE-1048', {
        amountHalalas: 15_000,
        scope: quote.scope,
      }),
    ).resolves.toEqual(quote);
    expect(auditService.record).toHaveBeenCalledWith(actor, {
      action: 'request.quote_proposed',
      subjectType: 'service_request',
      subjectId: 'MOE-1048',
      newState: { quoteStatus: 'proposed', amountHalalas: 15_000 },
    });
  });

  it('returns lifecycle history to an authorized dispatcher', async () => {
    const events = [
      {
        type: 'provider_assigned' as const,
        status: 'assigned' as const,
        createdAt: '2026-08-05T01:00:00.000Z',
      },
    ];
    const appService = {
      getServiceRequestEvents: jest.fn().mockResolvedValue(events),
    };
    const staffAuthService = {
      getCurrentStaff: jest.fn().mockResolvedValue(actor),
    };
    const controller = new AppController(
      appService as unknown as AppService,
      staffAuthService as unknown as StaffAuthService,
      {} as StaffAuditService,
      {} as CustomerAuthService,
    );
    const historyController = controller as unknown as {
      getServiceRequestEvents: (
        authorization: string,
        requestId: string,
      ) => Promise<typeof events>;
    };
    expect(typeof historyController.getServiceRequestEvents).toBe('function');

    await expect(
      historyController.getServiceRequestEvents(
        'Bearer staff-session',
        'MOE-1048',
      ),
    ).resolves.toEqual(events);
    expect(appService.getServiceRequestEvents).toHaveBeenCalledWith('MOE-1048');
  });

  it('records the old and new request status after an authorized update', async () => {
    const appService = {
      getServiceRequests: jest
        .fn()
        .mockResolvedValue([{ id: 'MOE-1048', status: 'assigned' }]),
      updateStatus: jest.fn().mockResolvedValue({
        id: 'MOE-1048',
        status: 'on_the_way',
      }),
    };
    const staffAuthService = {
      getCurrentStaff: jest.fn().mockResolvedValue(actor),
    };
    const auditService = { record: jest.fn().mockResolvedValue(undefined) };
    const controller = new AppController(
      appService as unknown as AppService,
      staffAuthService as unknown as StaffAuthService,
      auditService as unknown as StaffAuditService,
    );

    await controller.updateStatus('Bearer staff-session', 'MOE-1048', {
      status: 'on_the_way',
    });

    expect(auditService.record).toHaveBeenCalledWith(actor, {
      action: 'request.status_updated',
      subjectType: 'service_request',
      subjectId: 'MOE-1048',
      oldState: { status: 'assigned' },
      newState: { status: 'on_the_way' },
    });
  });
});

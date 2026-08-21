import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { AppController } from './app.controller';
import type { AppService } from './app.service';
import type { StaffAuditService } from './staff-audit.service';
import type { StaffAuthService } from './staff-auth.service';
import type { CustomerAuthService } from './customer-auth.service';
import type { ProviderAuthService } from './provider-auth.service';
import { ProviderUnavailableForApprovalError } from './service-request.repository';

describe('AppController provider tracking authorization', () => {
  const position = {
    requestId: 'MOE-1001',
    latitude: 26.359123,
    longitude: 43.981988,
    accuracyMeters: 10,
    capturedAt: '2026-08-21T12:00:00.000Z',
    receivedAt: '2026-08-21T12:00:01.000Z',
    arrivalObserved: false,
  };

  it('derives provider authority from the session and never accepts providerId in the body', async () => {
    const appService = {
      submitProviderLocationSample: jest.fn().mockResolvedValue({
        ...position,
        duplicate: false,
      }),
    };
    const providerAuthService = {
      getCurrentProvider: jest.fn().mockResolvedValue({ id: 'provider-owner' }),
    };
    const controller = createTrackingController(
      appService,
      {},
      providerAuthService,
    );

    await controller.submitMyProviderLocation(
      'Bearer provider-session',
      position.requestId,
      {
        latitude: position.latitude,
        longitude: position.longitude,
        accuracyMeters: position.accuracyMeters,
        capturedAt: position.capturedAt,
      },
    );

    expect(appService.submitProviderLocationSample).toHaveBeenCalledWith(
      'provider-owner',
      position.requestId,
      expect.objectContaining({ latitude: position.latitude }),
    );
  });

  it('permits admin/dispatcher operations reads and denies support', async () => {
    const appService = {
      getOperationsProviderCurrentPosition: jest
        .fn()
        .mockResolvedValue(position),
    };
    const staffAuthService = {
      getCurrentStaff: jest
        .fn()
        .mockResolvedValueOnce({ ...actor, role: 'dispatcher' })
        .mockResolvedValueOnce({ ...actor, role: 'support_agent' }),
    };
    const controller = createTrackingController(
      appService,
      staffAuthService,
      {},
    );

    await expect(
      controller.getOperationsProviderCurrentPosition(
        'Bearer dispatcher-session',
        position.requestId,
      ),
    ).resolves.toEqual(position);
    await expect(
      controller.getOperationsProviderCurrentPosition(
        'Bearer support-session',
        position.requestId,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('denies an unauthenticated provider current-position read', async () => {
    const providerAuthService = {
      getCurrentProvider: jest
        .fn()
        .mockRejectedValue(new UnauthorizedException('Unauthorized')),
    };
    const controller = createTrackingController({}, {}, providerAuthService);

    await expect(
      controller.getMyProviderCurrentPosition(undefined, position.requestId),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('maps staff attempts to start tracking to a deliberate conflict', async () => {
    const appService = {
      updateStatus: jest
        .fn()
        .mockRejectedValue(
          new Error('Provider must start tracking through the provider action'),
        ),
    };
    const staffAuthService = {
      getCurrentStaff: jest.fn().mockResolvedValue(actor),
    };
    const controller = createTrackingController(
      appService,
      staffAuthService,
      {},
    );

    await expect(
      controller.updateStatus('Bearer dispatcher-session', position.requestId, {
        status: 'on_the_way',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  function createTrackingController(
    appService: object,
    staffAuthService: object,
    providerAuthService: object,
  ): AppController {
    return new AppController(
      appService as AppService,
      staffAuthService as StaffAuthService,
      {} as StaffAuditService,
      {} as CustomerAuthService,
      providerAuthService as ProviderAuthService,
    );
  }
});

const actor = {
  id: 'STF-1001',
  email: 'dispatcher@example.test',
  displayName: 'موظف التشغيل',
  role: 'dispatcher' as const,
};

describe('AppController staff audit integration', () => {
  it('passes pilot registration audit metadata into the atomic command', async () => {
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
      {} as CustomerAuthService,
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

    expect(appService.registerPilotProvider).toHaveBeenCalledWith(
      {
        name: provider.name,
        specialties: provider.specialties,
        serviceZone: provider.serviceZone,
      },
      {
        staffId: adminActor.id,
        action: 'provider.pilot_registered',
        subjectType: 'provider',
      },
    );
    expect(auditService.record).not.toHaveBeenCalled();
  });

  it('passes verification audit metadata without a stale provider pre-read', async () => {
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
      {} as CustomerAuthService,
    );

    await (
      controller as unknown as {
        verifyPilotProvider: (
          authorization: string,
          providerId: string,
        ) => Promise<typeof verifiedProvider>;
      }
    ).verifyPilotProvider('Bearer staff-session', pendingProvider.id);

    expect(appService.getProviders).not.toHaveBeenCalled();
    expect(appService.verifyPilotProvider).toHaveBeenCalledWith(
      pendingProvider.id,
      {
        staffId: adminActor.id,
        action: 'provider.pilot_verified',
        subjectType: 'provider',
        subjectId: pendingProvider.id,
      },
    );
    expect(auditService.record).not.toHaveBeenCalled();
  });

  it('passes suspension audit metadata without a stale provider pre-read', async () => {
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
      {} as CustomerAuthService,
    );

    await (
      controller as unknown as {
        suspendPilotProvider: (
          authorization: string,
          providerId: string,
        ) => Promise<typeof suspendedProvider>;
      }
    ).suspendPilotProvider('Bearer staff-session', activeProvider.id);

    expect(appService.getProviders).not.toHaveBeenCalled();
    expect(appService.suspendPilotProvider).toHaveBeenCalledWith(
      activeProvider.id,
      {
        staffId: adminActor.id,
        action: 'provider.pilot_suspended',
        subjectType: 'provider',
        subjectId: activeProvider.id,
      },
    );
    expect(auditService.record).not.toHaveBeenCalled();
  });

  it('passes reactivation audit metadata without a stale provider pre-read', async () => {
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
      {} as CustomerAuthService,
    );

    await (
      controller as unknown as {
        reactivatePilotProvider: (
          authorization: string,
          providerId: string,
        ) => Promise<typeof reactivatedProvider>;
      }
    ).reactivatePilotProvider('Bearer staff-session', suspendedProvider.id);

    expect(appService.getProviders).not.toHaveBeenCalled();
    expect(appService.reactivatePilotProvider).toHaveBeenCalledWith(
      suspendedProvider.id,
      {
        staffId: adminActor.id,
        action: 'provider.pilot_reactivated',
        subjectType: 'provider',
        subjectId: suspendedProvider.id,
      },
    );
    expect(auditService.record).not.toHaveBeenCalled();
  });

  it('passes support status audit metadata without a stale ticket pre-read', async () => {
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
      {} as CustomerAuthService,
    );

    await controller.updateSupportTicketStatus(
      'Bearer staff-session',
      'SUP-1006',
      {
        status: 'in_progress',
      },
    );

    expect(appService.getSupportTickets).not.toHaveBeenCalled();
    expect(appService.updateSupportTicketStatus).toHaveBeenCalledWith(
      'SUP-1006',
      'in_progress',
      {
        staffId: supportActor.id,
        action: 'support_ticket.status_updated',
        subjectType: 'support_ticket',
        subjectId: 'SUP-1006',
      },
    );
    expect(auditService.record).not.toHaveBeenCalled();
  });

  it('passes assignment audit metadata without a stale request pre-read', async () => {
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
      {} as CustomerAuthService,
    );

    await controller.assignProvider('Bearer staff-session', 'MOE-1048', {
      providerId: 'provider-2',
    });

    expect(appService.getServiceRequests).not.toHaveBeenCalled();
    expect(appService.assignProvider).toHaveBeenCalledWith(
      'MOE-1048',
      'provider-2',
      {
        staffId: actor.id,
        action: 'request.provider_assigned',
        subjectType: 'service_request',
        subjectId: 'MOE-1048',
      },
    );
    expect(auditService.record).not.toHaveBeenCalled();
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

  it('passes quote audit metadata into the atomic command', async () => {
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
    expect(appService.proposeQuote).toHaveBeenCalledWith(
      'MOE-1048',
      15_000,
      quote.scope,
      {
        staffId: actor.id,
        action: 'request.quote_proposed',
        subjectType: 'service_request',
        subjectId: 'MOE-1048',
      },
    );
    expect(auditService.record).not.toHaveBeenCalled();
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

  it.each(['admin', 'dispatcher'] as const)(
    'returns exact confirmed service location to authorized %s staff',
    async (role) => {
      const requests = [
        {
          id: 'MOE-1048',
          serviceId: 'ac-cleaning',
          address: 'حي الصفراء، بريدة',
          timing: 'scheduled' as const,
          status: 'assigned' as const,
          location: {
            point: { latitude: 26.359123, longitude: 43.981988 },
            displayAddress: 'حي الصفراء، بريدة',
            source: 'map_pin' as const,
            confirmedAt: '2026-08-21T12:00:00.000Z',
          },
          createdAt: '2026-08-21T12:00:00.000Z',
        },
      ];
      const appService = {
        getServiceRequests: jest.fn().mockResolvedValue(requests),
      };
      const staffAuthService = {
        getCurrentStaff: jest.fn().mockResolvedValue({ ...actor, role }),
      };
      const controller = new AppController(
        appService as unknown as AppService,
        staffAuthService as unknown as StaffAuthService,
        {} as StaffAuditService,
        {} as CustomerAuthService,
      );

      await expect(
        controller.getServiceRequests('Bearer staff-session'),
      ).resolves.toEqual(requests);
    },
  );

  it('does not expand broad service-request access to support agents', async () => {
    const appService = { getServiceRequests: jest.fn() };
    const staffAuthService = {
      getCurrentStaff: jest
        .fn()
        .mockResolvedValue({ ...actor, role: 'support_agent' as const }),
    };
    const controller = new AppController(
      appService as unknown as AppService,
      staffAuthService as unknown as StaffAuthService,
      {} as StaffAuditService,
      {} as CustomerAuthService,
    );

    await expect(
      controller.getServiceRequests('Bearer staff-session'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(appService.getServiceRequests).not.toHaveBeenCalled();
  });

  it('passes request status audit metadata without a stale pre-read', async () => {
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
      {} as CustomerAuthService,
    );

    await controller.updateStatus('Bearer staff-session', 'MOE-1048', {
      status: 'on_the_way',
    });

    expect(appService.getServiceRequests).not.toHaveBeenCalled();
    expect(appService.updateStatus).toHaveBeenCalledWith(
      'MOE-1048',
      'on_the_way',
      {
        staffId: actor.id,
        action: 'request.status_updated',
        subjectType: 'service_request',
        subjectId: 'MOE-1048',
      },
    );
    expect(auditService.record).not.toHaveBeenCalled();
  });

  it('rejects invalid provider invitation input before the store and records the audit trail', async () => {
    const appService = { inviteProvidersToRequest: jest.fn() };
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
    const inviteController = controller as unknown as {
      inviteProviders: (
        authorization: string,
        requestId: string,
        body: unknown,
      ) => Promise<unknown[]>;
    };

    await expect(
      inviteController.inviteProviders('Bearer staff-session', 'MOE-1048', {
        providerIds: [],
      }),
    ).rejects.toThrow('providerIds must not be empty');
    await expect(
      inviteController.inviteProviders('Bearer staff-session', 'MOE-1048', {
        providerIds: 'provider-1',
      }),
    ).rejects.toThrow('providerIds must be an array of strings');
    expect(appService.inviteProvidersToRequest).not.toHaveBeenCalled();
  });

  it('passes invitation audit metadata into the atomic command', async () => {
    const opportunity = {
      requestId: 'MOE-1048',
      serviceId: 'ac-cleaning',
      timing: 'as-soon-as-possible' as const,
      opportunityStatus: 'invited' as const,
    };
    const appService = {
      inviteProvidersToRequest: jest.fn().mockResolvedValue([opportunity]),
    };
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
    const inviteController = controller as unknown as {
      inviteProviders: (
        authorization: string,
        requestId: string,
        body: { providerIds: string[] },
      ) => Promise<unknown[]>;
    };

    await expect(
      inviteController.inviteProviders('Bearer staff-session', 'MOE-1048', {
        providerIds: ['provider-1', 'provider-1'],
      }),
    ).resolves.toEqual([opportunity]);
    expect(appService.inviteProvidersToRequest).toHaveBeenCalledWith(
      'MOE-1048',
      ['provider-1', 'provider-1'],
      {
        staffId: actor.id,
        action: 'request.opportunities_invited',
        subjectType: 'service_request',
        subjectId: 'MOE-1048',
      },
    );
    expect(auditService.record).not.toHaveBeenCalled();
  });

  it('passes audit metadata for access-code, opportunity, and cash commands', async () => {
    const adminActor = { ...actor, role: 'admin' as const };
    const collected = {
      id: 'PAY-1001',
      amountHalalas: 15_000,
      currency: 'SAR',
      method: 'cash_on_completion' as const,
      status: 'cash_collected' as const,
      createdAt: '2026-08-05T01:00:00.000Z',
    };
    const refunded = { ...collected, status: 'refunded' as const };
    const appService = {
      setPilotProviderAccessCode: jest.fn().mockResolvedValue(undefined),
      closeProviderOpportunity: jest.fn().mockResolvedValue({ closed: true }),
      collectCashPayment: jest.fn().mockResolvedValue(collected),
      refundCashPayment: jest.fn().mockResolvedValue(refunded),
    };
    const staffAuthService = {
      getCurrentStaff: jest.fn().mockResolvedValue(adminActor),
    };
    const auditService = { record: jest.fn().mockResolvedValue(undefined) };
    const controller = new AppController(
      appService as unknown as AppService,
      staffAuthService as unknown as StaffAuthService,
      auditService as unknown as StaffAuditService,
      {} as CustomerAuthService,
    );

    await controller.setPilotProviderAccessCode(
      'Bearer staff-session',
      'PILOT-provider',
      { accessCode: 'test-access-code-1234' },
    );
    await controller.closeProviderOpportunity(
      'Bearer staff-session',
      'MOE-1048',
      'provider-1',
    );
    await controller.collectCashPayment('Bearer staff-session', 'MOE-1048');
    await controller.refundCashPayment('Bearer staff-session', 'MOE-1048');

    expect(appService.setPilotProviderAccessCode).toHaveBeenCalledWith(
      'PILOT-provider',
      'test-access-code-1234',
      {
        staffId: adminActor.id,
        action: 'provider.access_code_rotated',
        subjectType: 'provider',
        subjectId: 'PILOT-provider',
      },
    );
    expect(appService.closeProviderOpportunity).toHaveBeenCalledWith(
      'MOE-1048',
      'provider-1',
      {
        staffId: adminActor.id,
        action: 'request.opportunity_closed',
        subjectType: 'service_request',
        subjectId: 'MOE-1048',
      },
    );
    expect(appService.collectCashPayment).toHaveBeenCalledWith('MOE-1048', {
      staffId: adminActor.id,
      action: 'payment.cash_collected',
      subjectType: 'service_request',
      subjectId: 'MOE-1048',
    });
    expect(appService.refundCashPayment).toHaveBeenCalledWith('MOE-1048', {
      staffId: adminActor.id,
      action: 'payment.cash_refunded',
      subjectType: 'service_request',
      subjectId: 'MOE-1048',
    });
    expect(auditService.record).not.toHaveBeenCalled();
  });

  it.each([
    [
      'verifyPilotProvider',
      'verifyPilotProvider',
      'Pending pilot provider not found',
    ],
    [
      'suspendPilotProvider',
      'suspendPilotProvider',
      'Verified pilot provider not found',
    ],
    [
      'reactivatePilotProvider',
      'reactivatePilotProvider',
      'Suspended pilot provider not found',
    ],
  ] as const)(
    'preserves 404 mapping for the %s lifecycle precondition',
    async (controllerMethod, serviceMethod, message) => {
      const adminActor = { ...actor, role: 'admin' as const };
      const appService = {
        [serviceMethod]: jest.fn().mockRejectedValue(new Error(message)),
      };
      const controller = new AppController(
        appService as unknown as AppService,
        {
          getCurrentStaff: jest.fn().mockResolvedValue(adminActor),
        } as unknown as StaffAuthService,
        {} as StaffAuditService,
        {} as CustomerAuthService,
      );

      let thrown: unknown;
      try {
        await controller[controllerMethod](
          'Bearer staff-session',
          'PILOT-provider',
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(NotFoundException);
      expect((thrown as NotFoundException).message).toBe(message);
    },
  );

  it('returns a generic 404 for every provider quote withdrawal failure', async () => {
    const appService = {
      withdrawProviderQuote: jest
        .fn()
        .mockRejectedValue(new Error('Pending provider quote not found')),
    };
    const providerAuthService = {
      getCurrentProvider: jest
        .fn()
        .mockResolvedValue({ id: 'provider-1', name: 'مقدم' }),
    };
    const controller = new AppController(
      appService as unknown as AppService,
      {} as StaffAuthService,
      {} as StaffAuditService,
      {} as CustomerAuthService,
      providerAuthService as unknown as ProviderAuthService,
    );
    const withdrawController = controller as unknown as {
      withdrawMyProviderQuote: (
        authorization: string,
        quoteId: string,
      ) => Promise<unknown>;
    };

    await expect(
      withdrawController.withdrawMyProviderQuote(
        'Bearer provider-session',
        'QTE-7',
      ),
    ).rejects.toThrow('Quote is not available for withdrawal');
    expect(appService.withdrawProviderQuote).toHaveBeenCalledWith(
      'provider-1',
      'QTE-7',
    );
  });

  it('maps an unavailable winning provider to a customer-safe 409 on decision', async () => {
    const appService = {
      decideMyQuote: jest
        .fn()
        .mockRejectedValue(new ProviderUnavailableForApprovalError()),
    };
    const controller = new AppController(
      appService as unknown as AppService,
      {} as StaffAuthService,
      {} as StaffAuditService,
      {} as CustomerAuthService,
    );
    const decisionController = controller as unknown as {
      decideMyQuote: (
        authorization: string,
        requestId: string,
        quoteId: string,
        body: { decision: 'approved' | 'rejected' },
      ) => Promise<unknown>;
    };

    await expect(
      decisionController.decideMyQuote(
        'Bearer customer-session',
        'MOE-1048',
        'QTE-7',
        { decision: 'approved' },
      ),
    ).rejects.toThrow(
      'The selected provider is not available; please choose another quote',
    );
  });
});

import { AppService, type ServiceRequest } from './app.service';

const persistedRequest: ServiceRequest = {
  id: 'MOE-1042',
  serviceId: 'ac-cleaning',
  address: 'حي الصفراء، بريدة',
  details: 'تنظيف مكيفات',
  timing: 'as-soon-as-possible',
  status: 'pending_dispatch',
  createdAt: '2026-08-03T20:30:00.000Z',
};

describe('AppService', () => {
  it('returns the five launch service categories for Moeen', () => {
    const service = new AppService({
      create: jest.fn(),
      findAll: jest.fn(),
    });

    expect(service.getLaunchServices()).toEqual([
      { id: 'ac-cleaning', nameAr: 'تنظيف المكيفات' },
      { id: 'upholstery', nameAr: 'غسيل الكنب والمجالس' },
      { id: 'home-cleaning', nameAr: 'تنظيف المنازل' },
      { id: 'tank-cleaning', nameAr: 'تنظيف الخزانات' },
      { id: 'plumbing', nameAr: 'سباكة وتسربات' },
    ]);
  });

  it('registers a Buraidah pilot provider with a valid in-scope category', async () => {
    const provider = {
      id: 'PILOT-provider',
      name: 'فريق اختبار التبريد',
      specialties: ['ac-cleaning'],
      serviceZone: 'حي الصفراء، بريدة',
      verificationStatus: 'pending',
      available: false,
    };
    const store = {
      createPilotProvider: jest.fn().mockResolvedValue(provider),
    };
    const service = new AppService(store as never);

    await expect(
      (
        service as unknown as {
          registerPilotProvider: (input: {
            name: string;
            specialties: string[];
            serviceZone: string;
          }) => Promise<typeof provider>;
        }
      ).registerPilotProvider({
        name: '  فريق اختبار التبريد  ',
        specialties: ['ac-cleaning'],
        serviceZone: '  حي الصفراء، بريدة  ',
      }),
    ).resolves.toEqual(provider);
    expect(store.createPilotProvider).toHaveBeenCalledWith({
      name: 'فريق اختبار التبريد',
      specialties: ['ac-cleaning'],
      serviceZone: 'حي الصفراء، بريدة',
    });
  });

  it('allows an admin workflow to verify a pending pilot provider', async () => {
    const verifiedProvider = {
      id: 'PILOT-provider',
      name: 'فريق اختبار التبريد',
      specialties: ['ac-cleaning'],
      serviceZone: 'حي الصفراء، بريدة',
      verificationStatus: 'verified' as const,
      available: true,
    };
    const store = {
      updatePilotProviderVerification: jest
        .fn()
        .mockResolvedValue(verifiedProvider),
    };
    const service = new AppService(store as never);

    await expect(
      (
        service as unknown as {
          verifyPilotProvider: (id: string) => Promise<typeof verifiedProvider>;
        }
      ).verifyPilotProvider('PILOT-provider'),
    ).resolves.toEqual(verifiedProvider);
    expect(store.updatePilotProviderVerification).toHaveBeenCalledWith(
      'PILOT-provider',
      'verified',
    );
  });

  it('allows an admin workflow to suspend an active pilot provider', async () => {
    const suspendedProvider = {
      id: 'PILOT-provider',
      name: 'فريق اختبار التبريد',
      specialties: ['ac-cleaning'],
      serviceZone: 'حي الصفراء، بريدة',
      verificationStatus: 'suspended' as const,
      available: false,
    };
    const store = {
      updatePilotProviderVerification: jest
        .fn()
        .mockResolvedValue(suspendedProvider),
    };
    const service = new AppService(store as never);

    await expect(
      (
        service as unknown as {
          suspendPilotProvider: (
            id: string,
          ) => Promise<typeof suspendedProvider>;
        }
      ).suspendPilotProvider('PILOT-provider'),
    ).resolves.toEqual(suspendedProvider);
    expect(store.updatePilotProviderVerification).toHaveBeenCalledWith(
      'PILOT-provider',
      'suspended',
    );
  });

  it('allows an admin workflow to reactivate a suspended pilot provider after review', async () => {
    const reactivatedProvider = {
      id: 'PILOT-provider',
      name: 'فريق اختبار التبريد',
      specialties: ['ac-cleaning'],
      serviceZone: 'حي الصفراء، بريدة',
      verificationStatus: 'verified' as const,
      available: true,
    };
    const store = {
      updatePilotProviderVerification: jest
        .fn()
        .mockResolvedValue(reactivatedProvider),
    };
    const service = new AppService(store as never);

    await expect(
      (
        service as unknown as {
          reactivatePilotProvider: (
            id: string,
          ) => Promise<typeof reactivatedProvider>;
        }
      ).reactivatePilotProvider('PILOT-provider'),
    ).resolves.toEqual(reactivatedProvider);
    expect(store.updatePilotProviderVerification).toHaveBeenCalledWith(
      'PILOT-provider',
      'verified',
    );
  });

  it('does not retain a development OTP path now that customer auth is provider-backed', () => {
    const service = new AppService({} as never);

    expect('requestOtp' in service).toBe(false);
    expect('verifyOtp' in service).toBe(false);
  });

  it('creates a booking for the authenticated customer only', async () => {
    const customer = { id: 'CUS-1001', phone: '+966500000001' };
    const store = {
      create: jest.fn().mockResolvedValue(persistedRequest),
      findCustomerBySession: jest.fn().mockResolvedValue(customer),
    };
    const service = new AppService(store);

    const created = await service.createMyServiceRequest(
      'customer-session-token',
      {
        serviceId: 'ac-cleaning',
        address: 'حي الصفراء، بريدة',
        details: 'تنظيف مكيفات',
        timing: 'as-soon-as-possible',
      },
    );

    expect(created).toEqual(persistedRequest);
    expect(store.create).toHaveBeenCalledWith(expect.any(Object), customer.id);
  });

  it('returns only the authenticated customer’s requests', async () => {
    const customer = { id: 'CUS-1001', phone: '+966500000001' };
    const store = {
      findCustomerBySession: jest.fn().mockResolvedValue(customer),
      findByCustomerId: jest.fn().mockResolvedValue([persistedRequest]),
    };
    const service = new AppService(store);

    await expect(
      service.getMyServiceRequests('customer-session-token'),
    ).resolves.toEqual([persistedRequest]);
    expect(store.findCustomerBySession).toHaveBeenCalledWith(
      'customer-session-token',
    );
    expect(store.findByCustomerId).toHaveBeenCalledWith(customer.id);
  });

  it('normalizes an operations quote before it is proposed', async () => {
    const quote = {
      id: 'QTE-7',
      amountHalalas: 15_000,
      scope: 'إصلاح تسرب تحت المغسلة',
      status: 'proposed' as const,
      proposedAt: '2026-08-05T01:00:00.000Z',
    };
    const store = { proposeQuote: jest.fn().mockResolvedValue(quote) };
    const service = new AppService(store as never);
    const quoteService = service as unknown as {
      proposeQuote: (
        requestId: string,
        amountHalalas: number,
        scope: string,
      ) => Promise<typeof quote>;
    };
    expect(typeof quoteService.proposeQuote).toBe('function');

    await expect(
      quoteService.proposeQuote(
        'MOE-1042',
        15_000,
        '  إصلاح تسرب تحت المغسلة  ',
      ),
    ).resolves.toEqual(quote);
    expect(store.proposeQuote).toHaveBeenCalledWith(
      'MOE-1042',
      15_000,
      'إصلاح تسرب تحت المغسلة',
    );
  });

  it('returns lifecycle events only for the authenticated customer request', async () => {
    const customer = { id: 'CUS-1001', phone: '+966****0001' };
    const events = [
      {
        type: 'request_created' as const,
        status: 'pending_dispatch' as const,
        createdAt: '2026-08-05T01:00:00.000Z',
      },
    ];
    const store = {
      findCustomerBySession: jest.fn().mockResolvedValue(customer),
      findByCustomerId: jest.fn().mockResolvedValue([persistedRequest]),
      findRequestEvents: jest.fn().mockResolvedValue(events),
    };
    const service = new AppService(store as never);
    const historyService = service as unknown as {
      getMyServiceRequestEvents: (
        token: string,
        requestId: string,
      ) => Promise<typeof events>;
    };
    expect(typeof historyService.getMyServiceRequestEvents).toBe('function');

    await expect(
      historyService.getMyServiceRequestEvents(
        'customer-session-token',
        persistedRequest.id,
      ),
    ).resolves.toEqual(events);
    expect(store.findRequestEvents).toHaveBeenCalledWith(persistedRequest.id);
  });

  it('rejects a request list when the customer session token is unknown', async () => {
    const service = new AppService({
      findCustomerBySession: jest.fn().mockResolvedValue(undefined),
    });

    await expect(service.getMyServiceRequests('invalid-token')).rejects.toThrow(
      'Unauthorized',
    );
  });

  it('allows the owning customer to rate a completed request once', async () => {
    const customer = { id: 'CUS-1001', phone: '+966500000001' };
    const rated = {
      ...persistedRequest,
      status: 'completed' as const,
      rating: 5,
      ratingComment: 'خدمة ممتازة',
    };
    const store = {
      findCustomerBySession: jest.fn().mockResolvedValue(customer),
      rateRequest: jest.fn().mockResolvedValue(rated),
    };
    const service = new AppService(store);

    await expect(
      service.rateMyServiceRequest(
        'customer-session-token',
        'MOE-1042',
        5,
        'خدمة ممتازة',
      ),
    ).resolves.toEqual(rated);
    expect(store.rateRequest).toHaveBeenCalledWith(
      'MOE-1042',
      customer.id,
      5,
      'خدمة ممتازة',
    );
  });

  it('creates a customer-owned support ticket for an existing request', async () => {
    const customer = { id: 'CUS-1001', phone: '+966****0001' };
    const ticket = {
      id: 'SUP-1001',
      requestId: 'MOE-1042',
      category: 'quality',
      comment: 'الخدمة غير مرضية',
      status: 'open',
      createdAt: '2026-08-04T10:00:00.000Z',
    } as const;
    const store = {
      findCustomerBySession: jest.fn().mockResolvedValue(customer),
      createSupportTicket: jest.fn().mockResolvedValue(ticket),
    };
    const service = new AppService(store);

    await expect(
      service.createMySupportTicket(
        'customer-session-token',
        'MOE-1042',
        'quality',
        '  الخدمة غير مرضية  ',
      ),
    ).resolves.toEqual(ticket);
    expect(store.createSupportTicket).toHaveBeenCalledWith(
      'MOE-1042',
      customer.id,
      'quality',
      'الخدمة غير مرضية',
    );
  });

  it('rejects empty and non-array provider invitation lists and deduplicates ids', async () => {
    const store = {
      inviteProvidersToRequest: jest.fn().mockResolvedValue([]),
    };
    const service = new AppService(store as never);
    const inviteService = service as unknown as {
      inviteProvidersToRequest: (
        requestId: string,
        providerIds: unknown,
      ) => Promise<unknown[]>;
    };

    await expect(
      inviteService.inviteProvidersToRequest('MOE-1042', []),
    ).rejects.toThrow('Provider invitation list is empty');
    await expect(
      inviteService.inviteProvidersToRequest('MOE-1042', 'not-an-array'),
    ).rejects.toThrow('Provider invitation list must be an array');
    await expect(
      inviteService.inviteProvidersToRequest('MOE-1042', ['p1', 7]),
    ).rejects.toThrow(
      'Provider invitation list must contain only provider ids',
    );

    await expect(
      inviteService.inviteProvidersToRequest('MOE-1042', [
        '  p1  ',
        'p1',
        'p2',
      ]),
    ).resolves.toEqual([]);
    expect(store.inviteProvidersToRequest).toHaveBeenCalledWith('MOE-1042', [
      'p1',
      'p2',
    ]);
  });

  it('normalizes a provider quote before it is submitted', async () => {
    const quote = {
      id: 'QTE-9',
      providerId: 'provider-1',
      amountHalalas: 15_000,
      scope: 'تنظيف شامل',
      status: 'proposed' as const,
      proposedAt: '2026-08-05T01:00:00.000Z',
    };
    const store = { submitProviderQuote: jest.fn().mockResolvedValue(quote) };
    const service = new AppService(store as never);
    const submitService = service as unknown as {
      submitProviderQuote: (
        providerId: string,
        requestId: string,
        amountHalalas: number,
        scope: string,
      ) => Promise<typeof quote>;
    };

    await expect(
      submitService.submitProviderQuote(
        'provider-1',
        'MOE-1042',
        15_000,
        '  تنظيف شامل  ',
      ),
    ).resolves.toEqual(quote);
    expect(store.submitProviderQuote).toHaveBeenCalledWith(
      'MOE-1042',
      'provider-1',
      15_000,
      'تنظيف شامل',
    );

    await expect(
      submitService.submitProviderQuote('provider-1', 'MOE-1042', -5, 'x'),
    ).rejects.toThrow('Invalid quote');
  });

  it('withdraws a provider quote through the store', async () => {
    const quote = {
      id: 'QTE-10',
      providerId: 'provider-1',
      amountHalalas: 10_000,
      scope: 'عرض',
      status: 'withdrawn' as const,
      proposedAt: '2026-08-05T01:00:00.000Z',
      decidedAt: '2026-08-05T02:00:00.000Z',
    };
    const store = { withdrawProviderQuote: jest.fn().mockResolvedValue(quote) };
    const service = new AppService(store as never);
    const withdrawService = service as unknown as {
      withdrawProviderQuote: (
        providerId: string,
        quoteId: string,
      ) => Promise<typeof quote>;
    };

    await expect(
      withdrawService.withdrawProviderQuote('provider-1', 'QTE-10'),
    ).resolves.toEqual(quote);
    expect(store.withdrawProviderQuote).toHaveBeenCalledWith(
      'QTE-10',
      'provider-1',
    );
  });

  it('lists provider opportunities through the store', async () => {
    const opportunity = {
      requestId: 'MOE-1042',
      serviceId: 'ac-cleaning',
      timing: 'as-soon-as-possible',
      opportunityStatus: 'invited' as const,
    };
    const store = {
      listProviderOpportunities: jest.fn().mockResolvedValue([opportunity]),
    };
    const service = new AppService(store as never);
    const opportunityService = service as unknown as {
      getProviderOpportunities: (providerId: string) => Promise<unknown[]>;
    };

    await expect(
      opportunityService.getProviderOpportunities('provider-1'),
    ).resolves.toEqual([opportunity]);
    expect(store.listProviderOpportunities).toHaveBeenCalledWith('provider-1');
  });
});

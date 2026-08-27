import { ConflictException } from '@nestjs/common';
import {
  AppService,
  type ServiceRequest,
  type ServiceRequestStore,
} from './app.service';
import {
  RequestSubmissionConflictError,
  RequestSubmissionReplayError,
} from './request-image-create.contracts';

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
    } as unknown as ServiceRequestStore);

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
    expect(store.createPilotProvider).toHaveBeenCalledWith(
      {
        name: 'فريق اختبار التبريد',
        specialties: ['ac-cleaning'],
        serviceZone: 'حي الصفراء، بريدة',
      },
      undefined,
    );
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
      undefined,
      'pending',
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
      undefined,
      'verified',
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
      undefined,
      'suspended',
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
    const service = new AppService(store as unknown as ServiceRequestStore);

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
    const customer = { id: 'CUS-1001', phone: '+966****0001' };
    const store = {
      findCustomerBySession: jest.fn().mockResolvedValue(customer),
      findByCustomerId: jest.fn().mockResolvedValue([persistedRequest]),
      findRequestImagesByRequestIds: jest
        .fn()
        .mockResolvedValue(new Map<string, never[]>()),
    };
    const service = new AppService(store as unknown as ServiceRequestStore);

    await expect(
      service.getMyServiceRequests('customer-session-token'),
    ).resolves.toEqual([persistedRequest]);
    expect(store.findCustomerBySession).toHaveBeenCalledWith(
      'customer-session-token',
    );
    expect(store.findByCustomerId).toHaveBeenCalledWith(customer.id);
    expect(store.findRequestImagesByRequestIds).toHaveBeenCalledWith([
      persistedRequest.id,
    ]);
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
      undefined,
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
    } as unknown as ServiceRequestStore);

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
    const service = new AppService(store as unknown as ServiceRequestStore);

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
    const service = new AppService(store as unknown as ServiceRequestStore);

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
    expect(store.inviteProvidersToRequest).toHaveBeenCalledWith(
      'MOE-1042',
      ['p1', 'p2'],
      undefined,
    );
  });

  it('passes staff audit metadata through opportunity closure and cash operations', async () => {
    const audit = {
      staffId: 'STF-1001',
      action: 'test.action',
      subjectType: 'service_request',
      subjectId: 'MOE-1042',
    };
    const closed = { closed: true };
    const payment = {
      id: 'PAY-1001',
      amountHalalas: 15_000,
      currency: 'SAR',
      method: 'cash_on_completion' as const,
      status: 'cash_collected' as const,
      createdAt: '2026-08-05T01:00:00.000Z',
    };
    const refunded = { ...payment, status: 'refunded' as const };
    const store = {
      closeProviderOpportunity: jest.fn().mockResolvedValue(closed),
      collectCashPayment: jest.fn().mockResolvedValue(payment),
      refundCashPayment: jest.fn().mockResolvedValue(refunded),
    };
    const service = new AppService(store as never);

    await expect(
      service.closeProviderOpportunity('MOE-1042', 'provider-1', audit),
    ).resolves.toEqual(closed);
    await expect(
      service.collectCashPayment('MOE-1042', audit),
    ).resolves.toEqual(payment);
    await expect(service.refundCashPayment('MOE-1042', audit)).resolves.toEqual(
      refunded,
    );

    expect(store.closeProviderOpportunity).toHaveBeenCalledWith(
      'MOE-1042',
      'provider-1',
      audit,
    );
    expect(store.collectCashPayment).toHaveBeenCalledWith('MOE-1042', audit);
    expect(store.refundCashPayment).toHaveBeenCalledWith('MOE-1042', audit);
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
    await expect(
      submitService.submitProviderQuote(
        'provider-1',
        'MOE-1042',
        Number.MAX_SAFE_INTEGER + 1,
        'تنظيف',
      ),
    ).rejects.toThrow('Invalid quote');
  });

  it('hides provider ids from an approved customer quote decision', async () => {
    const store = {
      findCustomerBySession: jest.fn().mockResolvedValue({
        id: 'CUS-1',
        phone: '+966512345678',
      }),
      decideQuote: jest.fn().mockResolvedValue({
        id: 'QTE-3',
        providerId: 'provider-9',
        amountHalalas: 15_000,
        scope: 'عرض اختبار',
        status: 'approved',
        proposedAt: '2026-08-05T01:00:00.000Z',
        decidedAt: '2026-08-05T02:00:00.000Z',
      }),
    };
    const service = new AppService(store as never);
    const decisionService = service as unknown as {
      decideMyQuote: (
        token: string,
        requestId: string,
        quoteId: string,
        decision: 'approved' | 'rejected',
      ) => Promise<Record<string, unknown>>;
    };

    const result = await decisionService.decideMyQuote(
      'customer-token',
      'MOE-1002',
      'QTE-3',
      'approved',
    );

    expect(result).toEqual({
      id: 'QTE-3',
      amountHalalas: 15_000,
      scope: 'عرض اختبار',
      status: 'approved',
      proposedAt: '2026-08-05T01:00:00.000Z',
      decidedAt: '2026-08-05T02:00:00.000Z',
    });
    expect(result).not.toHaveProperty('providerId');
  });

  it('hides provider ids from a rejected customer quote decision', async () => {
    const store = {
      findCustomerBySession: jest.fn().mockResolvedValue({
        id: 'CUS-1',
        phone: '+966512345678',
      }),
      decideQuote: jest.fn().mockResolvedValue({
        id: 'QTE-3',
        providerId: 'provider-9',
        amountHalalas: 15_000,
        scope: 'عرض اختبار',
        status: 'rejected',
        proposedAt: '2026-08-05T01:00:00.000Z',
        decidedAt: '2026-08-05T02:00:00.000Z',
      }),
    };
    const service = new AppService(store as never);
    const decisionService = service as unknown as {
      decideMyQuote: (
        token: string,
        requestId: string,
        quoteId: string,
        decision: 'approved' | 'rejected',
      ) => Promise<Record<string, unknown>>;
    };

    const result = await decisionService.decideMyQuote(
      'customer-token',
      'MOE-1002',
      'QTE-3',
      'rejected',
    );

    expect(result.status).toBe('rejected');
    expect(result).not.toHaveProperty('providerId');
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

  it('exposes quote inputs while redacting exact location and identity data', async () => {
    const image = {
      id: 'image-1',
      storageKey: 'request-images/internal/image-1.jpg',
      mimeType: 'image/jpeg' as const,
      byteSize: 100,
      contentSha256: 'a'.repeat(64),
      sortOrder: 0,
    };
    const imageDto = {
      id: image.id,
      mimeType: image.mimeType,
      byteSize: image.byteSize,
      sortOrder: image.sortOrder,
      url: 'https://signed.example.test/image-1',
      urlExpiresAt: '2026-08-21T12:05:00.000Z',
    };
    const opportunity = {
      requestId: 'MOE-1042',
      serviceId: 'ac-cleaning',
      timing: 'as-soon-as-possible' as const,
      opportunityStatus: 'quoted' as const,
      address: 'sensitive-address',
      details: 'details-needed-to-price',
      location: {
        point: { latitude: 26.359123, longitude: 43.981988 },
        displayAddress: 'sensitive-address',
        source: 'map_pin' as const,
        confirmedAt: '2026-08-21T12:00:00.000Z',
      },
      requestStatus: 'pending_dispatch' as const,
      customerId: 'CUS-sensitive',
      customerPhone: '+966-sensitive',
      myQuote: {
        id: 'QTE-9',
        providerId: 'provider-1',
        providerName: 'Sensitive provider name',
        amountHalalas: 15_000,
        scope: 'عرض الخدمة',
        status: 'proposed' as const,
        proposedAt: '2026-08-21T12:00:00.000Z',
      },
    };
    const store = {
      listProviderOpportunities: jest.fn().mockResolvedValue([opportunity]),
      findRequestImagesByRequestIds: jest
        .fn()
        .mockResolvedValue(new Map([[opportunity.requestId, [image]]])),
    };
    const toDtos = jest.fn().mockResolvedValue([imageDto]);
    const service = new AppService(store as never, { toDtos } as never);

    const [projected] = await service.getProviderOpportunities('provider-1');

    expect(projected).toEqual({
      requestId: opportunity.requestId,
      serviceId: opportunity.serviceId,
      timing: opportunity.timing,
      opportunityStatus: opportunity.opportunityStatus,
      details: opportunity.details,
      images: [imageDto],
      approximateLocation: {
        point: { latitude: 26.4, longitude: 44 },
        precisionKm: 10,
      },
      myQuote: {
        id: opportunity.myQuote.id,
        providerId: opportunity.myQuote.providerId,
        amountHalalas: opportunity.myQuote.amountHalalas,
        scope: opportunity.myQuote.scope,
        status: opportunity.myQuote.status,
        proposedAt: opportunity.myQuote.proposedAt,
        decidedAt: undefined,
      },
    });
    expect(projected).not.toHaveProperty('address');
    expect(projected).not.toHaveProperty('location');
    expect(JSON.stringify(projected)).not.toContain('26.359123');
    expect(JSON.stringify(projected)).not.toContain('43.981988');
    expect(projected).not.toHaveProperty('customerId');
    expect(projected).not.toHaveProperty('customerPhone');
    expect(projected.myQuote).not.toHaveProperty('providerName');
    expect(JSON.stringify(projected)).not.toContain(image.storageKey);
    expect(toDtos).toHaveBeenCalledWith([image]);
  });
});

describe('AppService multipart image creation (Slice 2B)', () => {
  const customer = { id: 'CUS-1001', phone: '+966****0001' };
  const key = '11111111-1111-4111-8111-111111111111';

  const canonical = {
    id: 'image-0',
    storageKey: 'request-images/test/2026/08/image-0.jpg',
    mimeType: 'image/jpeg' as const,
    byteSize: 100,
    contentSha256: 'a'.repeat(64),
    sortOrder: 0,
    body: Buffer.from('body'),
  };

  const storedImage = {
    id: canonical.id,
    storageKey: canonical.storageKey,
    mimeType: canonical.mimeType,
    byteSize: canonical.byteSize,
    contentSha256: canonical.contentSha256,
    sortOrder: canonical.sortOrder,
  };

  const dto = {
    id: 'image-0',
    mimeType: 'image/jpeg' as const,
    byteSize: 100,
    sortOrder: 0,
    url: 'https://signed.example/image-0',
    urlExpiresAt: '2026-08-16T12:05:00.000Z',
  };

  const multipartInput = {
    serviceId: 'ac-cleaning',
    address: 'حي الصفراء، بريدة',
    details: 'تنظيف مكيفات',
    timing: 'as-soon-as-possible' as const,
    images: [
      {
        buffer: Buffer.from('buffer'),
        mimetype: 'image/jpeg',
        size: 6,
      },
    ],
  };

  const createInput = {
    serviceId: 'ac-cleaning',
    address: 'حي الصفراء، بريدة',
    details: 'تنظيف مكيفات',
    timing: 'as-soon-as-possible' as const,
  };

  function imageService(overrides: Record<string, jest.Mock> = {}) {
    return {
      canonicalize: jest.fn().mockResolvedValue([canonical]),
      fingerprint: jest.fn().mockReturnValue('fingerprint-value'),
      upload: jest.fn().mockResolvedValue([canonical.storageKey]),
      deleteBestEffort: jest.fn().mockResolvedValue(undefined),
      toDtos: jest.fn().mockResolvedValue([dto]),
      ...overrides,
    };
  }

  function storeWith(overrides: Record<string, jest.Mock> = {}) {
    return {
      create: jest.fn().mockResolvedValue(persistedRequest),
      findRequestByCustomerSubmission: jest.fn(),
      findRequestImages: jest.fn().mockResolvedValue([]),
      ...overrides,
    };
  }

  it('canonicalizes, fingerprints, uploads, and persists with the submission context', async () => {
    const store = storeWith();
    const images = imageService();
    const service = new AppService(store as never, images as never);

    const created = await service.createAuthenticatedServiceRequestWithImages(
      customer,
      multipartInput,
      key,
    );

    expect(created).toEqual({ ...persistedRequest, images: [dto] });
    expect(images.canonicalize).toHaveBeenCalledWith(multipartInput.images);
    expect(images.fingerprint).toHaveBeenCalledWith(createInput, [
      canonical.contentSha256,
    ]);
    expect(images.upload).toHaveBeenCalledWith([canonical]);
    expect(store.create).toHaveBeenCalledWith(
      createInput,
      'CUS-1001',
      {
        clientSubmissionId: key,
        submissionFingerprint: 'fingerprint-value',
      },
      [storedImage],
    );
    expect(images.toDtos).toHaveBeenCalledWith([storedImage]);
    expect(images.deleteBestEffort).not.toHaveBeenCalled();
  });

  it('persists the submission context for zero-image multipart requests without signing URLs', async () => {
    const store = storeWith();
    const images = imageService({
      canonicalize: jest.fn().mockResolvedValue([]),
      upload: jest.fn().mockResolvedValue([]),
    });
    const service = new AppService(store as never, images as never);

    const created = await service.createAuthenticatedServiceRequestWithImages(
      customer,
      { ...multipartInput, images: [] },
      key,
    );

    expect(created).toEqual(persistedRequest);
    expect(store.create).toHaveBeenCalledWith(
      {
        serviceId: 'ac-cleaning',
        address: 'حي الصفراء، بريدة',
        details: 'تنظيف مكيفات',
        timing: 'as-soon-as-possible',
      },
      'CUS-1001',
      {
        clientSubmissionId: key,
        submissionFingerprint: 'fingerprint-value',
      },
      [],
    );
    expect(images.toDtos).not.toHaveBeenCalled();
    expect(images.deleteBestEffort).not.toHaveBeenCalled();
  });

  it('turns a same-key different-content conflict into a 409 and compensates uploaded objects', async () => {
    const store = storeWith({
      create: jest.fn().mockRejectedValue(new RequestSubmissionConflictError()),
    });
    const images = imageService();
    const service = new AppService(store as never, images as never);

    await expect(
      service.createAuthenticatedServiceRequestWithImages(
        customer,
        multipartInput,
        key,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(images.deleteBestEffort).toHaveBeenCalledWith([
      canonical.storageKey,
    ]);
  });

  it('replays the committed request with its committed image DTOs', async () => {
    const committedImage = {
      ...storedImage,
      id: 'committed-image',
      storageKey: 'request-images/test/2026/08/committed.jpg',
    };
    const store = storeWith({
      create: jest.fn().mockRejectedValue(new RequestSubmissionReplayError()),
      findRequestByCustomerSubmission: jest
        .fn()
        .mockResolvedValue(persistedRequest),
      findRequestImages: jest.fn().mockResolvedValue([committedImage]),
    });
    const images = imageService();
    const service = new AppService(store as never, images as never);

    const replayed = await service.createAuthenticatedServiceRequestWithImages(
      customer,
      multipartInput,
      key,
    );

    expect(replayed).toEqual({ ...persistedRequest, images: [dto] });
    expect(store.findRequestByCustomerSubmission).toHaveBeenCalledWith(
      'CUS-1001',
      key,
    );
    expect(store.findRequestImages).toHaveBeenCalledWith(persistedRequest.id);
    expect(images.toDtos).toHaveBeenCalledWith([committedImage]);
    expect(images.deleteBestEffort).toHaveBeenCalledWith([
      canonical.storageKey,
    ]);
  });

  it('never deletes committed objects when DTO signing fails after the DB create commits', async () => {
    const store = storeWith();
    const images = imageService({
      toDtos: jest.fn().mockRejectedValue(new Error('signing failed')),
    });
    const service = new AppService(store as never, images as never);

    await expect(
      service.createAuthenticatedServiceRequestWithImages(
        customer,
        multipartInput,
        key,
      ),
    ).rejects.toThrow('signing failed');
    expect(store.create).toHaveBeenCalledTimes(1);
    expect(images.toDtos).toHaveBeenCalledWith([storedImage]);
    expect(images.deleteBestEffort).not.toHaveBeenCalled();
  });

  it('replays the committed request and images once signing recovers on retry', async () => {
    const committedImage = {
      ...storedImage,
      id: 'committed-image',
      storageKey: 'request-images/test/2026/08/committed.jpg',
    };
    const attemptImage = {
      ...canonical,
      storageKey: 'request-images/test/2026/08/attempt.jpg',
    };
    const retryImage = {
      ...canonical,
      storageKey: 'request-images/test/2026/08/retry.jpg',
    };
    const store = storeWith();
    store.create
      .mockResolvedValueOnce(persistedRequest)
      .mockRejectedValueOnce(new RequestSubmissionReplayError());
    store.findRequestByCustomerSubmission = jest
      .fn()
      .mockResolvedValue(persistedRequest);
    store.findRequestImages = jest.fn().mockResolvedValue([committedImage]);

    const images = imageService();
    images.canonicalize
      .mockResolvedValueOnce([attemptImage])
      .mockResolvedValueOnce([retryImage]);
    images.upload
      .mockResolvedValueOnce([attemptImage.storageKey])
      .mockResolvedValueOnce([retryImage.storageKey]);
    images.toDtos
      .mockRejectedValueOnce(new Error('signing failed'))
      .mockResolvedValueOnce([dto]);

    const service = new AppService(store as never, images as never);

    // First attempt: the DB create commits, then signing fails. Committed
    // objects must never be compensated.
    await expect(
      service.createAuthenticatedServiceRequestWithImages(
        customer,
        multipartInput,
        key,
      ),
    ).rejects.toThrow('signing failed');
    expect(images.deleteBestEffort).not.toHaveBeenCalled();

    // Retry with the same Idempotency-Key replays the committed request and
    // its committed image metadata once signing succeeds; only the retry
    // attempt's own orphan upload is compensated, never the winner's.
    const replayed = await service.createAuthenticatedServiceRequestWithImages(
      customer,
      multipartInput,
      key,
    );

    expect(replayed).toEqual({ ...persistedRequest, images: [dto] });
    expect(store.findRequestByCustomerSubmission).toHaveBeenCalledWith(
      'CUS-1001',
      key,
    );
    expect(store.findRequestImages).toHaveBeenCalledWith(persistedRequest.id);
    expect(images.toDtos).toHaveBeenLastCalledWith([committedImage]);
    expect(images.deleteBestEffort).toHaveBeenCalledTimes(1);
    expect(images.deleteBestEffort).toHaveBeenCalledWith([
      retryImage.storageKey,
    ]);
    expect(images.deleteBestEffort).not.toHaveBeenCalledWith([
      committedImage.storageKey,
    ]);
  });

  it('compensates uploaded objects and rethrows a database failure', async () => {
    const store = storeWith({
      create: jest.fn().mockRejectedValue(new Error('transaction failed')),
    });
    const images = imageService();
    const service = new AppService(store as never, images as never);

    await expect(
      service.createAuthenticatedServiceRequestWithImages(
        customer,
        multipartInput,
        key,
      ),
    ).rejects.toThrow('transaction failed');
    expect(images.deleteBestEffort).toHaveBeenCalledWith([
      canonical.storageKey,
    ]);
    expect(store.findRequestByCustomerSubmission).not.toHaveBeenCalled();
  });

  it('keeps the primary failure when compensating cleanup itself fails', async () => {
    const store = storeWith({
      create: jest.fn().mockRejectedValue(new Error('transaction failed')),
    });
    const images = imageService({
      deleteBestEffort: jest
        .fn()
        .mockRejectedValue(new Error('cleanup failed')),
    });
    const service = new AppService(store as never, images as never);

    await expect(
      service.createAuthenticatedServiceRequestWithImages(
        customer,
        multipartInput,
        key,
      ),
    ).rejects.toThrow('transaction failed');
    expect(images.deleteBestEffort).toHaveBeenCalledTimes(1);
  });
});

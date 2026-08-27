import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AppController } from './app.controller';
import {
  AppService,
  type ProviderOpportunityAccess,
  type ServiceRequest,
  type ServiceRequestStore,
} from './app.service';
import type { StaffAuditService } from './staff-audit.service';
import type { StaffAuthService } from './staff-auth.service';
import type { CustomerAuthService } from './customer-auth.service';
import type { RequestImageService } from './request-image.service';
import type {
  RequestImageDto,
  StoredRequestImage,
} from './request-image.types';

const REQUEST = {
  id: 'MOE-1042',
  serviceId: 'ac-cleaning',
  address: 'حي الصفراء، بريدة',
  details: 'تنظيف مكيفين اثنين',
  timing: 'as-soon-as-possible' as const,
  status: 'pending_dispatch' as const,
  createdAt: '2026-08-16T12:00:00.000Z',
};

function storedImage(sortOrder: number): StoredRequestImage {
  return {
    id: `00000000-0000-4000-8000-${String(sortOrder).padStart(12, '0')}`,
    storageKey: `request-images/test/2026/08/img-${sortOrder}.jpg`,
    mimeType: 'image/jpeg',
    byteSize: 100 + sortOrder,
    contentSha256: `${String(sortOrder).padStart(2, 'a').padEnd(64, 'a')}`,
    sortOrder,
  };
}

function signedDto(image: StoredRequestImage): RequestImageDto {
  return {
    id: image.id,
    mimeType: image.mimeType,
    byteSize: image.byteSize,
    sortOrder: image.sortOrder,
    url: `https://signed.example.test/${encodeURIComponent(image.storageKey)}?sig=test`,
    urlExpiresAt: '2026-08-17T12:05:00.000Z',
  };
}

function imageService(images: StoredRequestImage[] = []) {
  const toDtos = jest.fn((stored: StoredRequestImage[]) =>
    stored.map((image) => signedDto(image)),
  );
  return { toDtos, images };
}

function requestWithImages(images: StoredRequestImage[]): ServiceRequest {
  return { ...REQUEST, images: images.map((image) => signedDto(image)) };
}

const SENSITIVE_CUSTOMER_MARKERS = [
  'customerId',
  'customerName',
  'phone',
  'email',
  'CUS-',
];

describe('provider pre-quote visibility (Slice 3)', () => {
  it('shows details and signed images while redacting exact location for an invited opportunity', async () => {
    const images = [storedImage(1), storedImage(0)];
    const { toDtos } = imageService(images);
    const opportunity = {
      requestId: REQUEST.id,
      serviceId: REQUEST.serviceId,
      timing: REQUEST.timing,
      opportunityStatus: 'invited',
      address: REQUEST.address,
      details: REQUEST.details,
      location: {
        point: { latitude: 26.359123, longitude: 43.981988 },
        displayAddress: REQUEST.address,
        source: 'map_pin',
        confirmedAt: '2026-08-21T12:00:00.000Z',
      },
      requestStatus: 'pending_dispatch',
    } as unknown as ProviderOpportunityAccess;
    const store = {
      listProviderOpportunities: jest.fn().mockResolvedValue([opportunity]),
      findRequestImagesByRequestIds: jest
        .fn()
        .mockResolvedValue(new Map([[REQUEST.id, images]])),
    };
    const appService = new AppService(
      store as unknown as ServiceRequestStore,
      { toDtos } as unknown as RequestImageService,
    );

    const [result] = await appService.getProviderOpportunities('provider-1');

    expect(result).toEqual({
      requestId: REQUEST.id,
      serviceId: REQUEST.serviceId,
      timing: REQUEST.timing,
      opportunityStatus: 'invited',
      details: REQUEST.details,
      // Signed DTOs preserve the store's sort_order order exactly.
      images: images.map((image) => signedDto(image)),
      approximateLocation: {
        point: { latitude: 26.4, longitude: 44 },
        precisionKm: 10,
      },
    });
    expect(store.listProviderOpportunities).toHaveBeenCalledWith('provider-1');
    expect(store.findRequestImagesByRequestIds).toHaveBeenCalledWith([
      REQUEST.id,
    ]);
    expect(result).not.toHaveProperty('address');
    expect(result).not.toHaveProperty('location');
    expect(JSON.stringify(result)).not.toContain('26.359123');
    expect(JSON.stringify(result)).not.toContain('43.981988');
  });

  it('never exposes customer identity or contact fields in the pre-quote projection', async () => {
    const { toDtos } = imageService([]);
    // Even if a hostile store returned customer data, the whitelist
    // projection must drop it.
    const opportunity = {
      requestId: REQUEST.id,
      serviceId: REQUEST.serviceId,
      timing: REQUEST.timing,
      opportunityStatus: 'invited',
      address: REQUEST.address,
      details: REQUEST.details,
      location: {
        point: { latitude: 26.359123, longitude: 43.981988 },
        displayAddress: REQUEST.address,
        source: 'map_pin',
        confirmedAt: '2026-08-21T12:00:00.000Z',
      },
      requestStatus: 'pending_dispatch',
      customerId: 'CUS-1001',
      customerName: 'عميل مسرب',
      customerPhone: '+966****0000',
      customerEmail: 'leak@example.test',
      sessionToken: 'provider-session-leak',
      storageKey: 'request-images/internal/secret.jpg',
      bucket: 'internal-bucket',
      myQuote: {
        id: 'QTE-7',
        providerId: 'provider-1',
        amountHalalas: 15_000,
        scope: 'عرض',
        status: 'proposed',
        proposedAt: '2026-08-16T12:00:00.000Z',
        customerName: 'عميل مسرب',
      },
    } as unknown as ProviderOpportunityAccess;
    const store = {
      listProviderOpportunities: jest.fn().mockResolvedValue([opportunity]),
      findRequestImagesByRequestIds: jest.fn().mockResolvedValue(new Map()),
    };
    const appService = new AppService(
      store as unknown as ServiceRequestStore,
      { toDtos } as unknown as RequestImageService,
    );

    const [result] = await appService.getProviderOpportunities('provider-1');

    expect(Object.keys(result).sort()).toEqual(
      [
        'details',
        'images',
        'approximateLocation',
        'myQuote',
        'opportunityStatus',
        'requestId',
        'serviceId',
        'timing',
      ].sort(),
    );
    const serialized = JSON.stringify(result);
    for (const marker of SENSITIVE_CUSTOMER_MARKERS) {
      expect(serialized).not.toContain(marker);
    }
    expect(serialized).not.toContain('leak@example.test');
    expect(serialized).not.toContain('عميل مسرب');
    expect(serialized).not.toContain('provider-session-leak');
    expect(serialized).not.toContain('request-images/internal/secret.jpg');
    expect(serialized).not.toContain('internal-bucket');
    expect(result).not.toHaveProperty('address');
    expect(result).not.toHaveProperty('location');
  });

  it('signs images only for opportunities the authenticated provider actually owns', async () => {
    const { toDtos } = imageService([]);
    const store = {
      listProviderOpportunities: jest.fn().mockResolvedValue([]),
      findRequestImagesByRequestIds: jest.fn().mockResolvedValue(new Map()),
    };
    const appService = new AppService(
      store as unknown as ServiceRequestStore,
      { toDtos } as unknown as RequestImageService,
    );

    await expect(
      appService.getProviderOpportunities('provider-other'),
    ).resolves.toEqual([]);
    // No authorization, no signing, no image metadata read.
    expect(store.findRequestImagesByRequestIds).not.toHaveBeenCalled();
    expect(toDtos).not.toHaveBeenCalled();
    expect(store.listProviderOpportunities).toHaveBeenCalledWith(
      'provider-other',
    );
  });

  it.each([
    [
      'withdrawn',
      { opportunityStatus: 'withdrawn', requestStatus: 'pending_dispatch' },
    ],
    [
      'closed',
      { opportunityStatus: 'closed', requestStatus: 'pending_dispatch' },
    ],
    [
      'rejected',
      { opportunityStatus: 'rejected', requestStatus: 'pending_dispatch' },
    ],
    [
      'quoted but assigned elsewhere',
      { opportunityStatus: 'quoted', requestStatus: 'assigned' },
    ],
    [
      'invited but cancelled',
      { opportunityStatus: 'invited', requestStatus: 'cancelled' },
    ],
  ] as const)(
    'withholds address/details/images for the terminal or ineligible state %s',
    async (_name, state) => {
      const { toDtos } = imageService([storedImage(0)]);
      const opportunity: ProviderOpportunityAccess = {
        requestId: REQUEST.id,
        serviceId: REQUEST.serviceId,
        timing: REQUEST.timing,
        address: REQUEST.address,
        details: REQUEST.details,
        ...state,
      };
      const store = {
        listProviderOpportunities: jest.fn().mockResolvedValue([opportunity]),
        findRequestImagesByRequestIds: jest.fn().mockResolvedValue(new Map()),
      };
      const appService = new AppService(
        store as unknown as ServiceRequestStore,
        { toDtos } as unknown as RequestImageService,
      );

      const [result] = await appService.getProviderOpportunities('provider-1');

      expect(result).toEqual({
        requestId: REQUEST.id,
        serviceId: REQUEST.serviceId,
        timing: REQUEST.timing,
        opportunityStatus: state.opportunityStatus,
      });
      expect(store.findRequestImagesByRequestIds).not.toHaveBeenCalled();
      expect(toDtos).not.toHaveBeenCalled();
    },
  );
});

describe('customer / staff / assigned provider image reads (Slice 3)', () => {
  it('attaches signed image DTOs to the authenticated customer’s own requests', async () => {
    const images = [storedImage(0)];
    const { toDtos } = imageService(images);
    const store = {
      findCustomerBySession: jest
        .fn()
        .mockResolvedValue({ id: 'CUS-1001', phone: '+966500000000' }),
      findByCustomerId: jest.fn().mockResolvedValue([REQUEST]),
      findRequestImagesByRequestIds: jest
        .fn()
        .mockResolvedValue(new Map([[REQUEST.id, images]])),
    };
    const appService = new AppService(
      store as unknown as ServiceRequestStore,
      { toDtos } as unknown as RequestImageService,
    );

    const [result] = await appService.getMyServiceRequests('session-token');

    expect(result).toEqual(requestWithImages(images));
    expect(store.findRequestImagesByRequestIds).toHaveBeenCalledWith([
      REQUEST.id,
    ]);
    expect(toDtos).toHaveBeenCalledWith(images);
  });

  it('cannot return images for a request the customer does not own', async () => {
    const images = [storedImage(0)];
    const { toDtos } = imageService([]);
    const store = {
      findCustomerBySession: jest
        .fn()
        .mockResolvedValue({ id: 'CUS-1001', phone: '+966500000000' }),
      // The store returns only the customer's own requests; the images map
      // handed back is for a different request id (MOE-9999) and must not
      // leak onto MOE-1042.
      findByCustomerId: jest.fn().mockResolvedValue([REQUEST]),
      findRequestImagesByRequestIds: jest
        .fn()
        .mockResolvedValue(new Map([['MOE-9999', images]])),
    };
    const appService = new AppService(
      store as unknown as ServiceRequestStore,
      { toDtos } as unknown as RequestImageService,
    );

    const [result] = await appService.getMyServiceRequests('session-token');

    expect(result).toEqual(REQUEST);
    // The security property: images owned by another request id are never
    // attached to this customer's request. (Signing for that unrelated id is
    // the store mock's affair and cannot reach the response for REQUEST.id.)
    expect(result.images).toBeUndefined();
    expect(toDtos).toHaveBeenCalledWith(images);
  });

  it('attaches images for the assigned provider and only for its assigned requests', async () => {
    const images = [storedImage(0)];
    const { toDtos } = imageService(images);
    const assignedRequest = {
      ...REQUEST,
      status: 'assigned' as const,
    };
    const store = {
      findByProviderId: jest.fn().mockResolvedValue([assignedRequest]),
      findRequestImagesByRequestIds: jest
        .fn()
        .mockResolvedValue(new Map([[REQUEST.id, images]])),
    };
    const appService = new AppService(
      store as unknown as ServiceRequestStore,
      { toDtos } as unknown as RequestImageService,
    );

    const [result] = await appService.getProviderServiceRequests('provider-1');

    expect(result).toEqual({
      ...assignedRequest,
      images: images.map((image) => signedDto(image)),
    });
    expect(store.findByProviderId).toHaveBeenCalledWith('provider-1');
    expect(store.findRequestImagesByRequestIds).toHaveBeenCalledWith([
      REQUEST.id,
    ]);
  });

  it('carries the customer phone through the assigned-provider read exactly as the store authorized it', async () => {
    // The store is the authorization boundary: it may disclose the phone
    // only for the authenticated assigned provider in an active lifecycle
    // state. The service layer must pass that through without adding or
    // stripping it.
    const { toDtos } = imageService([]);
    const assignedRequest = {
      ...REQUEST,
      status: 'assigned' as const,
      customerPhone: '+966****0012',
    };
    const store = {
      findByProviderId: jest.fn().mockResolvedValue([assignedRequest]),
      findRequestImagesByRequestIds: jest.fn().mockResolvedValue(new Map()),
    };
    const appService = new AppService(
      store as unknown as ServiceRequestStore,
      { toDtos } as unknown as RequestImageService,
    );

    const [result] = await appService.getProviderServiceRequests('provider-1');

    expect(result.customerPhone).toBe('+966****0012');
    expect(store.findByProviderId).toHaveBeenCalledWith('provider-1');
  });

  it('returns nothing for a provider with no assigned requests (no image reads)', async () => {
    const { toDtos } = imageService([]);
    const store = {
      findByProviderId: jest.fn().mockResolvedValue([]),
      findRequestImagesByRequestIds: jest.fn().mockResolvedValue(new Map()),
    };
    const appService = new AppService(
      store as unknown as ServiceRequestStore,
      { toDtos } as unknown as RequestImageService,
    );

    await expect(
      appService.getProviderServiceRequests('provider-other'),
    ).resolves.toEqual([]);
    expect(store.findRequestImagesByRequestIds).not.toHaveBeenCalled();
    expect(toDtos).not.toHaveBeenCalled();
  });

  it('attaches image DTOs on the staff request list with one batch query', async () => {
    const images = [storedImage(0), storedImage(1)];
    const { toDtos } = imageService(images);
    const store = {
      findAll: jest.fn().mockResolvedValue([REQUEST]),
      findRequestImagesByRequestIds: jest
        .fn()
        .mockResolvedValue(new Map([[REQUEST.id, images]])),
    };
    const appService = new AppService(
      store as unknown as ServiceRequestStore,
      { toDtos } as unknown as RequestImageService,
    );

    const [result] = await appService.getServiceRequests();

    expect(result).toEqual(requestWithImages(images));
    expect(store.findRequestImagesByRequestIds).toHaveBeenCalledWith([
      REQUEST.id,
    ]);
  });

  it('orders image DTOs by stored sort_order ascending', async () => {
    const unordered = [storedImage(2), storedImage(0), storedImage(1)];
    const { toDtos } = imageService(unordered);
    const store = {
      findAll: jest.fn().mockResolvedValue([REQUEST]),
      findRequestImagesByRequestIds: jest
        .fn()
        .mockResolvedValue(
          new Map([
            [REQUEST.id, [storedImage(0), storedImage(1), storedImage(2)]],
          ]),
        ),
    };
    const appService = new AppService(
      store as unknown as ServiceRequestStore,
      { toDtos } as unknown as RequestImageService,
    );

    const [result] = await appService.getServiceRequests();

    expect(result.images?.map((image) => image.sortOrder)).toEqual([0, 1, 2]);
  });

  it('propagates a signing failure on an authorized read without any deletion', async () => {
    const images = [storedImage(0)];
    const store = {
      findCustomerBySession: jest
        .fn()
        .mockResolvedValue({ id: 'CUS-1001', phone: '+966****0000' }),
      findByCustomerId: jest.fn().mockResolvedValue([REQUEST]),
      findRequestImagesByRequestIds: jest
        .fn()
        .mockResolvedValue(new Map([[REQUEST.id, images]])),
    };
    const appService = new AppService(
      store as unknown as ServiceRequestStore,
      {
        toDtos: jest.fn().mockRejectedValue(new Error('signing failed')),
      } as unknown as RequestImageService,
    );

    await expect(
      appService.getMyServiceRequests('session-token'),
    ).rejects.toThrow('signing failed');
    // The read path has no deletion capability at all: nothing on the store
    // may receive delete/compensation calls.
    expect(
      Object.keys(store).some((key) => /delete|compensat/i.test(key)),
    ).toBe(false);
  });

  it('keeps storage keys out of every public DTO', async () => {
    const images = [storedImage(0)];
    const { toDtos } = imageService(images);
    const store = {
      findAll: jest.fn().mockResolvedValue([REQUEST]),
      findRequestImagesByRequestIds: jest
        .fn()
        .mockResolvedValue(new Map([[REQUEST.id, images]])),
    };
    const appService = new AppService(
      store as unknown as ServiceRequestStore,
      { toDtos } as unknown as RequestImageService,
    );

    const [result] = await appService.getServiceRequests();

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('storage_key');
    expect(serialized).not.toContain(images[0].storageKey);
    // Signed URLs are generated on demand and never handed to the store for
    // persistence: the only store method called received plain request ids.
    expect(store.findRequestImagesByRequestIds).toHaveBeenCalledWith([
      REQUEST.id,
    ]);
  });
});

describe('staff authorization for image reads (Slice 3)', () => {
  function controllerWith(
    appService: Partial<AppService>,
    staff: { role: string },
  ) {
    const staffAuthService = {
      getCurrentStaff: jest.fn().mockResolvedValue({
        id: 'STF-1001',
        email: 'staff@example.test',
        displayName: 'موظف',
        role: staff.role,
      }),
    };
    const controller = new AppController(
      appService as AppService,
      staffAuthService as unknown as StaffAuthService,
      {} as StaffAuditService,
      {} as CustomerAuthService,
    );
    return { controller, staffAuthService };
  }

  it('lets authorized staff read requests with image DTOs', async () => {
    const images = [storedImage(0)];
    const withImages = requestWithImages(images);
    const appService = {
      getServiceRequests: jest.fn().mockResolvedValue([withImages]),
    };
    const { controller } = controllerWith(appService, {
      role: 'dispatcher',
    });

    await expect(
      controller.getServiceRequests('Bearer staff-session'),
    ).resolves.toEqual([withImages]);
    expect(appService.getServiceRequests).toHaveBeenCalledTimes(1);
  });

  it('rejects non-operations staff before any request read happens', async () => {
    const appService = {
      getServiceRequests: jest.fn(),
    };
    const { controller } = controllerWith(appService, {
      role: 'support_agent',
    });

    await expect(
      controller.getServiceRequests('Bearer staff-session'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(appService.getServiceRequests).not.toHaveBeenCalled();
  });

  it('rejects a request without a bearer token', async () => {
    const appService = { getServiceRequests: jest.fn() };
    const { controller } = controllerWith(appService, { role: 'admin' });

    await expect(
      controller.getServiceRequests(undefined),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(appService.getServiceRequests).not.toHaveBeenCalled();
  });
});

import {
  AppService,
  projectServiceRequestForProvider,
  type ProviderOpportunityAccess,
  type ServiceRequest,
  type ServiceRequestStore,
} from './app.service';

const request: ServiceRequest = {
  id: 'MOE-1042',
  serviceId: 'ac-cleaning',
  address: 'شارع الأمير سلطان، حي الصفراء، بريدة',
  details: 'البوابة الشمالية',
  timing: 'scheduled',
  status: 'assigned',
  customerPhone: '+966****0001',
  location: {
    point: { latitude: 26.359123, longitude: 43.981988 },
    displayAddress: 'شارع الأمير سلطان، حي الصفراء، بريدة',
    source: 'map_pin',
    confirmedAt: '2026-08-21T12:00:00.000Z',
  },
  createdAt: '2026-08-21T12:00:00.000Z',
};

const approximateLocation = {
  point: { latitude: 26.4, longitude: 44 },
  precisionKm: 10,
};

describe('actor-specific service location projections', () => {
  it.each(['assigned', 'on_the_way', 'in_progress'] as const)(
    'allows the active assigned provider exact location in %s',
    (status) => {
      const projected = projectServiceRequestForProvider({
        ...request,
        status,
      });

      expect(projected).toMatchObject({
        address: request.address,
        location: request.location,
      });
      expect(projected).not.toHaveProperty('approximateLocation');
    },
  );

  it('returns an approximate ~10 km bucket, never the exact pin, before assignment', () => {
    const projected = projectServiceRequestForProvider({
      ...request,
      status: 'pending_dispatch',
    });

    expect(projected).toMatchObject({
      id: request.id,
      status: 'pending_dispatch',
      approximateLocation,
    });
    expect(projected).not.toHaveProperty('address');
    expect(projected).not.toHaveProperty('location');
    expect(projected).not.toHaveProperty('customerPhone');
    expect(JSON.stringify(projected)).not.toContain('26.359123');
    expect(JSON.stringify(projected)).not.toContain('43.981988');
  });

  it.each(['completed', 'cancelled'] as const)(
    'returns no location or private request fields in terminal state %s',
    (status) => {
      const projected = projectServiceRequestForProvider({
        ...request,
        status,
      });
      expect(projected).not.toHaveProperty('address');
      expect(projected).not.toHaveProperty('location');
      expect(projected).not.toHaveProperty('approximateLocation');
      expect(projected).not.toHaveProperty('customerPhone');
    },
  );

  it('returns approximate-only location to an eligible invited provider opportunity', async () => {
    const opportunity: ProviderOpportunityAccess = {
      requestId: request.id,
      serviceId: request.serviceId,
      timing: request.timing,
      opportunityStatus: 'invited',
      details: request.details,
      requestStatus: 'pending_dispatch',
      location: request.location,
    };
    const store = {
      listProviderOpportunities: jest.fn().mockResolvedValue([opportunity]),
      findRequestImagesByRequestIds: jest.fn().mockResolvedValue(new Map()),
    };
    const service = new AppService(store as unknown as ServiceRequestStore);

    const [projected] = await service.getProviderOpportunities('PILOT-1');

    expect(projected).toMatchObject({
      requestId: request.id,
      opportunityStatus: 'invited',
      approximateLocation,
    });
    expect(projected).not.toHaveProperty('location');
    expect(projected).not.toHaveProperty('address');
    expect(projected).not.toHaveProperty('customerPhone');
    expect(JSON.stringify(projected)).not.toContain('26.359123');
    expect(JSON.stringify(projected)).not.toContain('43.981988');
  });

  it.each([
    ['closed', 'pending_dispatch'],
    ['rejected', 'pending_dispatch'],
    ['invited', 'cancelled'],
    ['quoted', 'assigned'],
  ] as const)(
    'returns no approximate location for ineligible opportunity %s/%s',
    async (opportunityStatus, requestStatus) => {
      const opportunity: ProviderOpportunityAccess = {
        requestId: request.id,
        serviceId: request.serviceId,
        timing: request.timing,
        opportunityStatus,
        requestStatus,
        location: request.location,
      };
      const store = {
        listProviderOpportunities: jest.fn().mockResolvedValue([opportunity]),
        findRequestImagesByRequestIds: jest.fn().mockResolvedValue(new Map()),
      };
      const service = new AppService(store as unknown as ServiceRequestStore);

      const [projected] = await service.getProviderOpportunities('PILOT-1');

      expect(projected).not.toHaveProperty('location');
      expect(projected).not.toHaveProperty('approximateLocation');
      expect(store.findRequestImagesByRequestIds).not.toHaveBeenCalled();
    },
  );

  it('redacts exact location from the provider completed-transition response', async () => {
    const store = {
      updateStatusForProvider: jest.fn().mockResolvedValue({
        ...request,
        status: 'completed',
      }),
      findProviderTrackingAuthority: jest.fn().mockResolvedValue({
        requestId: request.id,
        status: 'completed',
        trackingSessionState: 'stopped',
      }),
    };
    const service = new AppService(store as unknown as ServiceRequestStore);

    const projected = await service.updateProviderServiceRequestStatus(
      'PILOT-1',
      request.id,
      'completed',
    );

    expect(projected).not.toHaveProperty('address');
    expect(projected).not.toHaveProperty('location');
    expect(projected).not.toHaveProperty('approximateLocation');
    expect(projected).not.toHaveProperty('details');
    expect(projected).not.toHaveProperty('customerPhone');
    expect(projected.tracking.active).toBe(false);
  });
});

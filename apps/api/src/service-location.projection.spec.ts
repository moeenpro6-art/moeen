import {
  AppService,
  projectServiceRequestForProvider,
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

describe('actor-specific service location projections', () => {
  it.each(['assigned', 'on_the_way', 'in_progress'] as const)(
    'allows the active assigned provider exact location in %s',
    (status) => {
      expect(
        projectServiceRequestForProvider({ ...request, status }),
      ).toMatchObject({
        address: request.address,
        location: request.location,
      });
    },
  );

  it.each(['completed', 'cancelled', 'pending_dispatch'] as const)(
    'redacts exact address and coordinates from provider history in %s',
    (status) => {
      const projected = projectServiceRequestForProvider({
        ...request,
        status,
      });
      expect(projected).not.toHaveProperty('address');
      expect(projected).not.toHaveProperty('location');
      expect(projected).not.toHaveProperty('customerPhone');
    },
  );

  it('redacts exact location from the provider completed-transition response', async () => {
    const store = {
      updateStatusForProvider: jest.fn().mockResolvedValue({
        ...request,
        status: 'completed',
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
    expect(projected).not.toHaveProperty('details');
    expect(projected).not.toHaveProperty('customerPhone');
  });
});

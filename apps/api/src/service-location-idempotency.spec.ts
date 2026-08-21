import { RequestImageService } from './request-image.service';
import type { CreateServiceRequest } from './app.service';

const service = new RequestImageService(
  { enabled: false, environment: 'test' } as never,
  {} as never,
);

const legacy: CreateServiceRequest = {
  serviceId: 'ac-cleaning',
  address: 'حي الصفراء، بريدة',
  details: 'تنظيف مكيفات',
  timing: 'scheduled',
};

const withLocation: CreateServiceRequest = {
  ...legacy,
  location: {
    point: { latitude: 26.359123, longitude: 43.981988 },
    displayAddress: 'حي الصفراء، بريدة',
    source: 'map_pin',
    confirmedAt: '2026-08-21T12:00:00.000Z',
  },
};

describe('location-aware request idempotency fingerprint', () => {
  it('preserves the exact legacy fingerprint vector when no location exists', () => {
    expect(service.fingerprint(legacy, ['a'.repeat(64)])).toBe(
      '5fc0606d945f6f7db57799292faa47ba5ae664c3b719d11eca732d7ae2ce8741',
    );
  });

  it.each([
    [
      'latitude',
      {
        ...withLocation,
        location: {
          ...withLocation.location!,
          point: { ...withLocation.location!.point, latitude: 26.359124 },
        },
      },
    ],
    [
      'longitude',
      {
        ...withLocation,
        location: {
          ...withLocation.location!,
          point: { ...withLocation.location!.point, longitude: 43.981989 },
        },
      },
    ],
    [
      'source',
      {
        ...withLocation,
        location: {
          ...withLocation.location!,
          source: 'current_location' as const,
        },
      },
    ],
    [
      'displayAddress',
      {
        ...withLocation,
        location: {
          ...withLocation.location!,
          displayAddress: 'حي الريان، بريدة',
        },
        address: 'حي الريان، بريدة',
      },
    ],
  ])('changes when canonical %s changes', (_field, changed) => {
    expect(service.fingerprint(changed, [])).not.toBe(
      service.fingerprint(withLocation, []),
    );
  });

  it('does not include the server-generated confirmation timestamp in identity', () => {
    expect(
      service.fingerprint(
        {
          ...withLocation,
          location: {
            ...withLocation.location!,
            confirmedAt: '2030-01-01T00:00:00.000Z',
          },
        },
        [],
      ),
    ).toBe(service.fingerprint(withLocation, []));
  });
});

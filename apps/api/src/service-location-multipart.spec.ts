import { BadRequestException } from '@nestjs/common';
import { validateCreateServiceRequestMultipart } from './request-image-create.contracts';

const locationJson = JSON.stringify({
  point: { latitude: 26.3591234, longitude: 43.9819876 },
  displayAddress: 'حي الصفراء، بريدة',
  source: 'map_pin',
  confirmed: true,
});

function valid(overrides: Record<string, unknown> = {}) {
  return {
    serviceId: 'ac-cleaning',
    timing: 'scheduled',
    images: [],
    location: locationJson,
    ...overrides,
  };
}

describe('multipart service location field', () => {
  it('parses exactly one UTF-8 JSON location field', () => {
    expect(validateCreateServiceRequestMultipart(valid())).toEqual({
      serviceId: 'ac-cleaning',
      timing: 'scheduled',
      images: [],
      location: {
        point: { latitude: 26.3591234, longitude: 43.9819876 },
        displayAddress: 'حي الصفراء، بريدة',
        source: 'map_pin',
        confirmed: true,
      },
    });
  });

  it.each([
    ['malformed JSON', '{'],
    ['non-object JSON', '[]'],
    ['duplicate field values', [locationJson, locationJson]],
    ['oversized field', 'x'.repeat(2049)],
  ])('rejects %s', (_case, location) => {
    expect(() =>
      validateCreateServiceRequestMultipart(valid({ location })),
    ).toThrow(BadRequestException);
  });

  it('rejects unknown multipart fields', () => {
    expect(() =>
      validateCreateServiceRequestMultipart(valid({ providerId: 'PILOT-1' })),
    ).toThrow(BadRequestException);
  });

  it('keeps legacy address-only multipart input valid', () => {
    expect(
      validateCreateServiceRequestMultipart({
        serviceId: 'plumbing',
        address: ' حي الريان، بريدة ',
        timing: 'as-soon-as-possible',
        images: [],
      }),
    ).toEqual({
      serviceId: 'plumbing',
      address: 'حي الريان، بريدة',
      timing: 'as-soon-as-possible',
      images: [],
    });
  });
});

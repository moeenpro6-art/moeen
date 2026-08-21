import { BadRequestException } from '@nestjs/common';
import {
  validateCreateServiceRequest,
  type CreateServiceRequest,
} from './app.service';
import type { ServiceLocationConfig } from './service-location.config';

const optionalConfig: ServiceLocationConfig = {
  mode: 'optional',
  bounds: {
    minimumLatitude: 26.2,
    maximumLatitude: 26.5,
    minimumLongitude: 43.8,
    maximumLongitude: 44.2,
  },
};
const now = () => new Date('2026-08-21T12:00:00.000Z');

const location = {
  point: { latitude: 26.3591234, longitude: 43.9819876 },
  displayAddress: ' حي الصفراء، بريدة ',
  source: 'current_location',
  confirmed: true,
};

function validate(
  input: unknown,
  config = optionalConfig,
): CreateServiceRequest {
  return validateCreateServiceRequest(input, config, now);
}

describe('service request creation with canonical location', () => {
  it('accepts location-only JSON input and derives the persisted address', () => {
    expect(
      validate({
        serviceId: 'ac-cleaning',
        location,
        timing: 'scheduled',
      }),
    ).toEqual({
      serviceId: 'ac-cleaning',
      address: 'حي الصفراء، بريدة',
      timing: 'scheduled',
      location: {
        point: { latitude: 26.359123, longitude: 43.981988 },
        displayAddress: 'حي الصفراء، بريدة',
        source: 'current_location',
        confirmedAt: '2026-08-21T12:00:00.000Z',
      },
    });
  });

  it('preserves address-only input in optional mode', () => {
    expect(
      validate({
        serviceId: 'plumbing',
        address: ' حي الريان، بريدة ',
        timing: 'as-soon-as-possible',
      }),
    ).toEqual({
      serviceId: 'plumbing',
      address: 'حي الريان، بريدة',
      timing: 'as-soon-as-possible',
    });
  });

  it('requires location in required mode', () => {
    expect(() =>
      validate(
        {
          serviceId: 'plumbing',
          address: 'حي الريان، بريدة',
          timing: 'as-soon-as-possible',
        },
        { ...optionalConfig, mode: 'required' },
      ),
    ).toThrow(BadRequestException);
  });

  it('rejects unknown top-level fields rather than silently accepting them', () => {
    expect(() =>
      validate({
        serviceId: 'ac-cleaning',
        location,
        timing: 'scheduled',
        confirmedAt: '2020-01-01T00:00:00.000Z',
      }),
    ).toThrow(BadRequestException);
  });
});

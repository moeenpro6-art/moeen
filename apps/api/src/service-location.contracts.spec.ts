import { BadRequestException } from '@nestjs/common';
import {
  resolveServiceLocation,
  type ServiceLocationInput,
} from './service-location.contracts';
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
const requiredConfig: ServiceLocationConfig = {
  ...optionalConfig,
  mode: 'required',
};
const now = () => new Date('2026-08-21T12:00:00.000Z');
const validLocation: ServiceLocationInput = {
  point: { latitude: 26.35912349, longitude: 43.98198751 },
  displayAddress: '  حي الصفراء، بريدة  ',
  source: 'map_pin',
  confirmed: true,
};

describe('service location contracts', () => {
  it('canonicalizes a confirmed Pilot point and generates confirmedAt on the server', () => {
    expect(
      resolveServiceLocation(undefined, validLocation, optionalConfig, now),
    ).toEqual({
      address: 'حي الصفراء، بريدة',
      location: {
        point: { latitude: 26.359123, longitude: 43.981988 },
        displayAddress: 'حي الصفراء، بريدة',
        source: 'map_pin',
        confirmedAt: '2026-08-21T12:00:00.000Z',
      },
    });
  });

  it('keeps address-only creation compatible in off and optional modes', () => {
    expect(
      resolveServiceLocation(
        '  حي الصفراء، بريدة  ',
        undefined,
        { mode: 'off' },
        now,
      ),
    ).toEqual({ address: 'حي الصفراء، بريدة' });
    expect(
      resolveServiceLocation(
        '  حي الصفراء، بريدة  ',
        undefined,
        optionalConfig,
        now,
      ),
    ).toEqual({ address: 'حي الصفراء، بريدة' });
  });

  it('requires location in required mode', () => {
    expect(() =>
      resolveServiceLocation(
        'حي الصفراء، بريدة',
        undefined,
        requiredConfig,
        now,
      ),
    ).toThrow(BadRequestException);
  });

  it('rejects a supplied location while the feature is off', () => {
    expect(() =>
      resolveServiceLocation(undefined, validLocation, { mode: 'off' }, now),
    ).toThrow(BadRequestException);
  });

  it('rejects a normalized mismatch between legacy and location addresses', () => {
    expect(() =>
      resolveServiceLocation(
        'حي الريان، بريدة',
        validLocation,
        optionalConfig,
        now,
      ),
    ).toThrow(BadRequestException);
  });

  it.each([
    { ...validLocation, confirmed: false },
    { ...validLocation, confirmedAt: '2026-08-21T11:00:00.000Z' },
    { ...validLocation, extra: true },
    { ...validLocation, point: { ...validLocation.point, extra: true } },
    { ...validLocation, point: { latitude: '26.3', longitude: 43.9 } },
    { ...validLocation, point: { latitude: Number.NaN, longitude: 43.9 } },
    { ...validLocation, point: { latitude: 91, longitude: 43.9 } },
    { ...validLocation, point: { latitude: 26.3, longitude: 181 } },
    { ...validLocation, point: { latitude: 26.1, longitude: 43.9 } },
    { ...validLocation, point: { latitude: 26.3, longitude: 44.3 } },
    { ...validLocation, source: 'gps' },
    { ...validLocation, displayAddress: 'x' },
  ])('rejects malformed or unauthorized location input %#', (location) => {
    expect(() =>
      resolveServiceLocation(undefined, location, optionalConfig, now),
    ).toThrow(BadRequestException);
  });
});

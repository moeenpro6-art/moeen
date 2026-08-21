import { serviceLocationConfigFromEnvironment } from './service-location.config';

const pilotBounds = {
  MOEEN_SERVICE_LOCATION_MIN_LATITUDE: '26.20',
  MOEEN_SERVICE_LOCATION_MAX_LATITUDE: '26.50',
  MOEEN_SERVICE_LOCATION_MIN_LONGITUDE: '43.80',
  MOEEN_SERVICE_LOCATION_MAX_LONGITUDE: '44.20',
};

describe('service location configuration', () => {
  it('defaults to off without requiring Pilot bounds', () => {
    expect(serviceLocationConfigFromEnvironment({})).toEqual({ mode: 'off' });
  });

  it.each(['optional', 'required'] as const)(
    'accepts %s only with finite ordered server-controlled Pilot bounds',
    (mode) => {
      expect(
        serviceLocationConfigFromEnvironment({
          MOEEN_SERVICE_LOCATION_MODE: mode,
          ...pilotBounds,
        }),
      ).toEqual({
        mode,
        bounds: {
          minimumLatitude: 26.2,
          maximumLatitude: 26.5,
          minimumLongitude: 43.8,
          maximumLongitude: 44.2,
        },
      });
    },
  );

  it.each([
    { MOEEN_SERVICE_LOCATION_MODE: 'enabled' },
    { MOEEN_SERVICE_LOCATION_MODE: 'optional' },
    {
      MOEEN_SERVICE_LOCATION_MODE: 'optional',
      ...pilotBounds,
      MOEEN_SERVICE_LOCATION_MIN_LATITUDE: 'NaN',
    },
    {
      MOEEN_SERVICE_LOCATION_MODE: 'required',
      ...pilotBounds,
      MOEEN_SERVICE_LOCATION_MIN_LONGITUDE: '44.3',
    },
    {
      MOEEN_SERVICE_LOCATION_MODE: 'required',
      ...pilotBounds,
      MOEEN_SERVICE_LOCATION_MAX_LATITUDE: '91',
    },
  ])('fails startup for invalid location policy %#', (environment) => {
    expect(() => serviceLocationConfigFromEnvironment(environment)).toThrow(
      'Invalid service location configuration',
    );
  });
});

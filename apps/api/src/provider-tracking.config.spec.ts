import { providerTrackingConfigFromEnvironment } from './provider-tracking.config';

describe('provider tracking rollout config', () => {
  it('defaults tracking off with the canonical collection cadences', () => {
    expect(providerTrackingConfigFromEnvironment({})).toEqual({
      enabled: false,
      onTheWayCadenceMs: 15_000,
      inProgressCadenceMs: 60_000,
    });
  });

  it('accepts explicit rollout and cadence overrides', () => {
    expect(
      providerTrackingConfigFromEnvironment({
        MOEEN_PROVIDER_TRACKING_MODE: 'enabled',
        MOEEN_PROVIDER_TRACKING_ON_THE_WAY_CADENCE_MS: '20000',
        MOEEN_PROVIDER_TRACKING_IN_PROGRESS_CADENCE_MS: '90000',
      }),
    ).toEqual({
      enabled: true,
      onTheWayCadenceMs: 20_000,
      inProgressCadenceMs: 90_000,
    });
  });

  it.each([
    { MOEEN_PROVIDER_TRACKING_MODE: 'true' },
    { MOEEN_PROVIDER_TRACKING_ON_THE_WAY_CADENCE_MS: '15e3' },
    { MOEEN_PROVIDER_TRACKING_ON_THE_WAY_CADENCE_MS: '9999' },
    { MOEEN_PROVIDER_TRACKING_ON_THE_WAY_CADENCE_MS: '60001' },
    { MOEEN_PROVIDER_TRACKING_IN_PROGRESS_CADENCE_MS: '29999' },
    { MOEEN_PROVIDER_TRACKING_IN_PROGRESS_CADENCE_MS: '300001' },
    {
      MOEEN_PROVIDER_TRACKING_ON_THE_WAY_CADENCE_MS: '60000',
      MOEEN_PROVIDER_TRACKING_IN_PROGRESS_CADENCE_MS: '59999',
    },
  ])('fails startup for invalid tracking configuration: %o', (environment) => {
    expect(() => providerTrackingConfigFromEnvironment(environment)).toThrow(
      'Invalid provider tracking configuration',
    );
  });
});

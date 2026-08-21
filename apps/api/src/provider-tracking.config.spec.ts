import { providerTrackingConfigFromEnvironment } from './provider-tracking.config';

describe('provider tracking rollout config', () => {
  it('defaults to off', () => {
    expect(providerTrackingConfigFromEnvironment({})).toEqual({
      enabled: false,
    });
  });

  it('enables only through the explicit enabled value', () => {
    expect(
      providerTrackingConfigFromEnvironment({
        MOEEN_PROVIDER_TRACKING_MODE: 'enabled',
      }),
    ).toEqual({ enabled: true });
  });

  it('fails startup for unknown rollout values', () => {
    expect(() =>
      providerTrackingConfigFromEnvironment({
        MOEEN_PROVIDER_TRACKING_MODE: 'true',
      }),
    ).toThrow('Invalid provider tracking configuration');
  });
});

import { resolveTrustedProxyHops } from './trusted-proxy';

describe('resolveTrustedProxyHops', () => {
  it('leaves proxy trust disabled unless a numeric hop count is configured', () => {
    expect(resolveTrustedProxyHops({})).toBeUndefined();
    expect(resolveTrustedProxyHops({ MOEEN_TRUST_PROXY_HOPS: '1' })).toBe(1);
    expect(resolveTrustedProxyHops({ MOEEN_TRUST_PROXY_HOPS: ' 2 ' })).toBe(2);
  });

  it('rejects an unsafe proxy trust configuration', () => {
    expect(() =>
      resolveTrustedProxyHops({ MOEEN_TRUST_PROXY_HOPS: 'true' }),
    ).toThrow(/MOEEN_TRUST_PROXY_HOPS must be a non-negative integer/);
    expect(() =>
      resolveTrustedProxyHops({ MOEEN_TRUST_PROXY_HOPS: '-1' }),
    ).toThrow(/MOEEN_TRUST_PROXY_HOPS must be a non-negative integer/);
  });
});

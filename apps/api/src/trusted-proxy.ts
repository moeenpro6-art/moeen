type ProxyEnvironment = Partial<
  Pick<NodeJS.ProcessEnv, 'MOEEN_TRUST_PROXY_HOPS'>
>;

export function resolveTrustedProxyHops(
  environment: ProxyEnvironment = process.env,
): number | undefined {
  const configuredHops = environment.MOEEN_TRUST_PROXY_HOPS?.trim();
  if (!configuredHops) return undefined;
  if (!/^(0|[1-9]\d*)$/.test(configuredHops)) {
    throw new Error('MOEEN_TRUST_PROXY_HOPS must be a non-negative integer');
  }
  return Number(configuredHops);
}

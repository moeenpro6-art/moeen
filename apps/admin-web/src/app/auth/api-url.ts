const localDevelopmentApiUrl = 'http://localhost:3002';

type ApiUrlEnvironment = Partial<
  Pick<NodeJS.ProcessEnv, 'NODE_ENV' | 'MOEEN_API_URL'>
>;

export function resolveDashboardApiBaseUrl(
  environment: ApiUrlEnvironment = process.env,
): string {
  const configuredUrl = environment.MOEEN_API_URL?.trim();
  if (!configuredUrl) {
    if (environment.NODE_ENV === 'production') {
      throw new Error('MOEEN_API_URL must be configured in production');
    }
    return localDevelopmentApiUrl;
  }

  let url: URL;
  try {
    url = new URL(configuredUrl);
  } catch {
    throw new Error('MOEEN_API_URL must be a valid absolute URL');
  }

  if (
    environment.NODE_ENV === 'production' &&
    url.protocol !== 'https:'
  ) {
    throw new Error('MOEEN_API_URL must use HTTPS in production');
  }

  return url.origin;
}

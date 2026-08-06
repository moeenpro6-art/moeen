export function resolveDatabaseConnectionString(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (environment.NODE_ENV === 'test') {
    if (!environment.TEST_DATABASE_URL) {
      throw new Error(
        'TEST_DATABASE_URL must be configured when NODE_ENV is test',
      );
    }
    return environment.TEST_DATABASE_URL;
  }
  if (!environment.DATABASE_URL) {
    throw new Error('DATABASE_URL must be configured');
  }
  return environment.DATABASE_URL;
}

/**
 * Nest DI token for the request-image configuration. `RequestImageConfig`
 * itself is a union type, so the token (not the type) is what the module and
 * the service inject; the factory validates and returns the config object.
 */
export const REQUEST_IMAGE_CONFIG = Symbol('REQUEST_IMAGE_CONFIG');

const DEFAULT_SIGNED_URL_TTL_SECONDS = 300;
const MAX_SIGNED_URL_TTL_SECONDS = 3600;

export type DisabledRequestImageConfig = {
  enabled: false;
  environment: string;
  signedUrlTtlSeconds: number;
};

export type EnabledRequestImageConfig = {
  enabled: true;
  environment: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  signedUrlTtlSeconds: number;
};

export type RequestImageConfig =
  DisabledRequestImageConfig | EnabledRequestImageConfig;

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('Invalid request image storage configuration');
}

function parseTtl(value: string | undefined): number {
  if (value === undefined || value === '')
    return DEFAULT_SIGNED_URL_TTL_SECONDS;
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_SIGNED_URL_TTL_SECONDS
  ) {
    throw new Error('Invalid request image storage configuration');
  }
  return parsed;
}

function required(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error('Invalid request image storage configuration');
  }
  return normalized;
}

function endpoint(value: string | undefined): string {
  const normalized = required(value);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('Invalid request image storage configuration');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Invalid request image storage configuration');
  }
  return parsed.toString().replace(/\/$/, '');
}

export function requestImageConfigFromEnvironment(
  environment: NodeJS.ProcessEnv,
): RequestImageConfig {
  const keyEnvironment = (environment.NODE_ENV ?? 'development').trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(keyEnvironment)) {
    throw new Error('Invalid request image environment');
  }

  const enabled = parseBoolean(environment.REQUEST_IMAGES_ENABLED, false);
  const signedUrlTtlSeconds = parseTtl(
    environment.REQUEST_IMAGE_SIGNED_URL_TTL_SECONDS,
  );
  if (!enabled) {
    return {
      enabled: false,
      environment: keyEnvironment,
      signedUrlTtlSeconds,
    };
  }

  return {
    enabled: true,
    environment: keyEnvironment,
    endpoint: endpoint(environment.REQUEST_IMAGE_S3_ENDPOINT),
    region: required(environment.REQUEST_IMAGE_S3_REGION),
    bucket: required(environment.REQUEST_IMAGE_S3_BUCKET),
    accessKeyId: required(environment.REQUEST_IMAGE_S3_ACCESS_KEY_ID),
    secretAccessKey: required(environment.REQUEST_IMAGE_S3_SECRET_ACCESS_KEY),
    forcePathStyle: parseBoolean(
      environment.REQUEST_IMAGE_S3_FORCE_PATH_STYLE,
      false,
    ),
    signedUrlTtlSeconds,
  };
}

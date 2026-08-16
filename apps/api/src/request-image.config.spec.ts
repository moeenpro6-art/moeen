import { requestImageConfigFromEnvironment } from './request-image.config';

describe('requestImageConfigFromEnvironment', () => {
  it('keeps the feature disabled without requiring S3 credentials', () => {
    expect(
      requestImageConfigFromEnvironment({
        NODE_ENV: 'development',
        REQUEST_IMAGES_ENABLED: 'false',
      }),
    ).toEqual({
      enabled: false,
      environment: 'development',
      signedUrlTtlSeconds: 300,
    });
  });

  it('validates and returns private S3 configuration when enabled', () => {
    expect(
      requestImageConfigFromEnvironment({
        NODE_ENV: 'production',
        REQUEST_IMAGES_ENABLED: 'true',
        REQUEST_IMAGE_S3_ENDPOINT: 'https://objects.example.test',
        REQUEST_IMAGE_S3_REGION: 'auto',
        REQUEST_IMAGE_S3_BUCKET: 'moeen-private-images',
        REQUEST_IMAGE_S3_ACCESS_KEY_ID: 'test-access-key',
        REQUEST_IMAGE_S3_SECRET_ACCESS_KEY: 'test-secret-key',
        REQUEST_IMAGE_S3_FORCE_PATH_STYLE: 'true',
        REQUEST_IMAGE_SIGNED_URL_TTL_SECONDS: '600',
      }),
    ).toEqual({
      enabled: true,
      environment: 'production',
      endpoint: 'https://objects.example.test',
      region: 'auto',
      bucket: 'moeen-private-images',
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
      forcePathStyle: true,
      signedUrlTtlSeconds: 600,
    });
  });

  it.each([
    ['missing endpoint', { REQUEST_IMAGE_S3_ENDPOINT: undefined }],
    ['invalid endpoint', { REQUEST_IMAGE_S3_ENDPOINT: 'file:///tmp/images' }],
    ['missing bucket', { REQUEST_IMAGE_S3_BUCKET: '' }],
    ['invalid TTL', { REQUEST_IMAGE_SIGNED_URL_TTL_SECONDS: '0' }],
    ['invalid boolean', { REQUEST_IMAGE_S3_FORCE_PATH_STYLE: 'yes' }],
  ])('fails closed for %s', (_name, override) => {
    expect(() =>
      requestImageConfigFromEnvironment({
        NODE_ENV: 'production',
        REQUEST_IMAGES_ENABLED: 'true',
        REQUEST_IMAGE_S3_ENDPOINT: 'https://objects.example.test',
        REQUEST_IMAGE_S3_REGION: 'auto',
        REQUEST_IMAGE_S3_BUCKET: 'moeen-private-images',
        REQUEST_IMAGE_S3_ACCESS_KEY_ID: 'test-access-key',
        REQUEST_IMAGE_S3_SECRET_ACCESS_KEY: 'test-secret-key',
        REQUEST_IMAGE_S3_FORCE_PATH_STYLE: 'false',
        ...override,
      }),
    ).toThrow('Invalid request image storage configuration');
  });

  it('defaults the signed URL TTL to 300 seconds when enabled', () => {
    expect(
      requestImageConfigFromEnvironment({
        NODE_ENV: 'production',
        REQUEST_IMAGES_ENABLED: 'true',
        REQUEST_IMAGE_S3_ENDPOINT: 'https://objects.example.test',
        REQUEST_IMAGE_S3_REGION: 'auto',
        REQUEST_IMAGE_S3_BUCKET: 'moeen-private-images',
        REQUEST_IMAGE_S3_ACCESS_KEY_ID: 'test-access-key',
        REQUEST_IMAGE_S3_SECRET_ACCESS_KEY: 'test-secret-key',
      }),
    ).toMatchObject({ enabled: true, signedUrlTtlSeconds: 300 });
  });

  it('rejects an unsafe environment segment used in object keys', () => {
    expect(() =>
      requestImageConfigFromEnvironment({
        NODE_ENV: '../production',
        REQUEST_IMAGES_ENABLED: 'false',
      }),
    ).toThrow('Invalid request image environment');
  });
});

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import type { EnabledRequestImageConfig } from './request-image.config';
import { S3RequestImageStorage } from './request-image.storage';

const config: EnabledRequestImageConfig = {
  enabled: true,
  environment: 'test',
  endpoint: 'https://objects.example.test',
  region: 'auto',
  bucket: 'private-request-images',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
  forcePathStyle: true,
  signedUrlTtlSeconds: 300,
};

describe('S3RequestImageStorage', () => {
  it('stores canonical bytes privately without a public ACL', async () => {
    const send = jest.fn().mockResolvedValue({});
    const storage = new S3RequestImageStorage(
      config,
      { send },
      jest.fn(),
      () => 1_700_000_000_000,
    );
    const body = Buffer.from('canonical-jpeg');

    await storage.put({
      key: 'request-images/test/2026/08/example.jpg',
      body,
      contentType: 'image/jpeg',
    });

    const calls = send.mock.calls as unknown[][];
    const command = calls[0]?.[0] as PutObjectCommand | undefined;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command?.input).toEqual({
      Bucket: config.bucket,
      Key: 'request-images/test/2026/08/example.jpg',
      Body: body,
      ContentType: 'image/jpeg',
      CacheControl: 'private, no-store',
    });
    expect(command?.input.ACL).toBeUndefined();
  });

  it('deletes only the exact supplied object keys', async () => {
    const send = jest.fn().mockResolvedValue({});
    const storage = new S3RequestImageStorage(config, { send }, jest.fn());

    await storage.deleteMany([
      'request-images/test/a.jpg',
      'request-images/test/b.jpg',
    ]);

    const calls = send.mock.calls as unknown[][];
    const command = calls[0]?.[0] as DeleteObjectsCommand | undefined;
    expect(command).toBeInstanceOf(DeleteObjectsCommand);
    expect(command?.input).toEqual({
      Bucket: config.bucket,
      Delete: {
        Objects: [
          { Key: 'request-images/test/a.jpg' },
          { Key: 'request-images/test/b.jpg' },
        ],
        Quiet: true,
      },
    });
  });

  it('does nothing for an empty delete set', async () => {
    const send = jest.fn();
    const storage = new S3RequestImageStorage(config, { send }, jest.fn());

    await storage.deleteMany([]);

    expect(send).not.toHaveBeenCalled();
  });

  it('generates a GET-only URL with the configured short TTL', async () => {
    const send = jest.fn();
    const sign = jest
      .fn()
      .mockResolvedValue('https://signed.example.test/image?signature=secret');
    const now = 1_700_000_000_000;
    const client = { send };
    const storage = new S3RequestImageStorage(config, client, sign, () => now);

    await expect(storage.signGet('request-images/test/a.jpg')).resolves.toEqual(
      {
        url: 'https://signed.example.test/image?signature=secret',
        expiresAt: new Date(now + 300_000),
      },
    );

    expect(sign).toHaveBeenCalledWith(client, expect.any(GetObjectCommand), {
      expiresIn: 300,
    });
    const calls = sign.mock.calls as unknown[][];
    const command = calls[0]?.[1] as GetObjectCommand | undefined;
    expect(command?.input).toEqual({
      Bucket: config.bucket,
      Key: 'request-images/test/a.jpg',
      ResponseCacheControl: 'private, no-store',
    });
  });

  it('fails when S3 reports object-level deletion errors', async () => {
    const storage = new S3RequestImageStorage(
      config,
      {
        send: jest.fn().mockResolvedValue({
          Errors: [{ Key: 'request-images/test/a.jpg', Code: 'AccessDenied' }],
        }),
      },
      jest.fn(),
    );

    await expect(
      storage.deleteMany(['request-images/test/a.jpg']),
    ).rejects.toThrow('Request image deletion failed');
  });

  it('lists only the requested prefix with a bounded page size', async () => {
    const send = jest.fn().mockResolvedValue({
      Contents: [
        {
          Key: 'request-images/test/2026/08/a.jpg',
          LastModified: new Date('2026-08-01T00:00:00.000Z'),
        },
      ],
      IsTruncated: false,
    });
    const storage = new S3RequestImageStorage(config, { send }, jest.fn());

    await expect(
      storage.list({ prefix: 'request-images/test/', maxKeys: 7 }),
    ).resolves.toEqual({
      items: [
        {
          key: 'request-images/test/2026/08/a.jpg',
          lastModified: new Date('2026-08-01T00:00:00.000Z'),
        },
      ],
      isTruncated: false,
      nextContinuationToken: undefined,
    });

    const calls = send.mock.calls as unknown[][];
    const command = calls[0]?.[0] as ListObjectsV2Command | undefined;
    expect(command).toBeInstanceOf(ListObjectsV2Command);
    expect(command?.input).toEqual({
      Bucket: config.bucket,
      Prefix: 'request-images/test/',
      MaxKeys: 7,
    });
  });

  it('propagates listing pagination tokens and ignores malformed entries', async () => {
    const send = jest.fn().mockResolvedValue({
      Contents: [
        { Key: 'request-images/test/2026/08/a.jpg', LastModified: 'nope' },
        { Key: undefined, LastModified: new Date() },
        {
          Key: 'request-images/test/2026/08/b.jpg',
          LastModified: new Date('2026-08-02T00:00:00.000Z'),
        },
      ],
      IsTruncated: true,
      NextContinuationToken: 'next-page-token',
    });
    const storage = new S3RequestImageStorage(config, { send }, jest.fn());

    await expect(
      storage.list({
        prefix: 'request-images/test/',
        maxKeys: 3,
        continuationToken: 'current-token',
      }),
    ).resolves.toEqual({
      items: [
        {
          key: 'request-images/test/2026/08/b.jpg',
          lastModified: new Date('2026-08-02T00:00:00.000Z'),
        },
      ],
      isTruncated: true,
      nextContinuationToken: 'next-page-token',
    });

    const calls = send.mock.calls as unknown[][];
    const command = calls[0]?.[0] as ListObjectsV2Command | undefined;
    expect(command?.input).toEqual({
      Bucket: config.bucket,
      Prefix: 'request-images/test/',
      MaxKeys: 3,
      ContinuationToken: 'current-token',
    });
  });

  it('clamps an excessive listing page size to the S3 maximum of 1000', async () => {
    const send = jest.fn().mockResolvedValue({ Contents: [] });
    const storage = new S3RequestImageStorage(config, { send }, jest.fn());

    await storage.list({ prefix: 'request-images/test/', maxKeys: 50_000 });

    const calls = send.mock.calls as unknown[][];
    const command = calls[0]?.[0] as ListObjectsV2Command | undefined;
    expect(command?.input.MaxKeys).toBe(1000);
  });
});

import sharp from 'sharp';
import { BadRequestException } from '@nestjs/common';
import { RequestImageService } from './request-image.service';
import type { EnabledRequestImageConfig } from './request-image.config';
import type { RequestImageStorage } from './request-image.storage';

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

const storage: RequestImageStorage = {
  put: jest.fn(),
  deleteMany: jest.fn(),
  signGet: jest.fn(),
  list: jest.fn(),
};

function file(
  buffer: Buffer,
  mimetype: string,
  originalname = 'customer-name.png',
) {
  return { buffer, mimetype, size: buffer.length, originalname };
}

describe('RequestImageService canonicalization', () => {
  const uuid = '123e4567-e89b-42d3-a456-426614174000';
  const now = new Date('2026-08-16T12:00:00.000Z');
  const service = new RequestImageService(
    config,
    storage,
    () => uuid,
    () => now,
  );

  it('decodes an accepted source, strips metadata and emits a bounded canonical JPEG', async () => {
    const source = await sharp({
      create: {
        width: 3200,
        height: 1600,
        channels: 3,
        background: '#bada55',
      },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const [image] = await service.canonicalize([file(source, 'image/jpeg')]);
    const metadata = await sharp(image.body).metadata();

    expect(image).toMatchObject({
      id: uuid,
      storageKey: `request-images/test/2026/08/${uuid}.jpg`,
      mimeType: 'image/jpeg',
      byteSize: image.body.length,
      sortOrder: 0,
    });
    expect(image.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(metadata.format).toBe('jpeg');
    expect(metadata.width).toBeLessThanOrEqual(2048);
    expect(metadata.height).toBeLessThanOrEqual(2048);
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    expect(image.storageKey).not.toContain('customer-name');
  });

  it.each<[string, ReturnType<typeof file>[]]>([
    ['six files', Array(6).fill(file(Buffer.from('x'), 'image/jpeg'))],
    [
      'a raw file over 5 MiB',
      [file(Buffer.alloc(5 * 1024 * 1024 + 1), 'image/jpeg')],
    ],
    [
      'aggregate raw bytes over 20 MiB',
      Array(5).fill(file(Buffer.alloc(4 * 1024 * 1024 + 1), 'image/jpeg')),
    ],
  ])('rejects %s before decoding', async (_name, files) => {
    await expect(service.canonicalize(files)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects corrupt images', async () => {
    await expect(
      service.canonicalize([file(Buffer.from('not-an-image'), 'image/jpeg')]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a PNG source and canonicalizes it to a bounded JPEG', async () => {
    const source = await sharp({
      create: {
        width: 60,
        height: 40,
        channels: 4,
        background: { r: 20, g: 140, b: 70, alpha: 0.5 },
      },
    })
      .png()
      .withMetadata({ orientation: 5 })
      .toBuffer();

    const [image] = await service.canonicalize([
      file(source, 'image/png', 'photo.png'),
    ]);
    const metadata = await sharp(image.body).metadata();

    expect(image.mimeType).toBe('image/jpeg');
    expect(metadata.format).toBe('jpeg');
    expect(metadata.exif).toBeUndefined();
    expect(image.storageKey).not.toContain('photo');
    expect(image.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts a WebP source and canonicalizes it to a bounded JPEG', async () => {
    const source = await sharp({
      create: {
        width: 50,
        height: 70,
        channels: 3,
        background: '#6a5acd',
      },
    })
      .webp()
      .toBuffer();

    const [image] = await service.canonicalize([
      file(source, 'image/webp', 'photo.webp'),
    ]);
    const metadata = await sharp(image.body).metadata();

    expect(image.mimeType).toBe('image/jpeg');
    expect(metadata.format).toBe('jpeg');
    expect(metadata.exif).toBeUndefined();
    expect(image.storageKey).not.toContain('photo');
  });

  it('keeps canonical output deterministic across identical inputs', async () => {
    const source = await sharp({
      create: {
        width: 30,
        height: 30,
        channels: 3,
        background: '#1e90ff',
      },
    })
      .jpeg()
      .toBuffer();

    const first = await service.canonicalize([file(source, 'image/jpeg')]);
    const second = await service.canonicalize([file(source, 'image/jpeg')]);

    expect(first[0].contentSha256).toBe(second[0].contentSha256);
    expect(first[0].byteSize).toBe(second[0].byteSize);
    expect(first[0].body.equals(second[0].body)).toBe(true);
  });

  it('derives storage keys from server-controlled random ids', async () => {
    const source = await sharp({
      create: {
        width: 20,
        height: 20,
        channels: 3,
        background: '#ffa500',
      },
    })
      .jpeg()
      .toBuffer();

    const first = new RequestImageService(
      config,
      storage,
      () => '11111111-1111-4111-8111-111111111111',
      () => now,
    );
    const second = new RequestImageService(
      config,
      storage,
      () => '22222222-2222-4222-8222-222222222222',
      () => now,
    );

    const [firstImage] = await first.canonicalize([file(source, 'image/jpeg')]);
    const [secondImage] = await second.canonicalize([
      file(source, 'image/jpeg'),
    ]);

    expect(firstImage.storageKey).toMatch(
      /^request-images\/test\/2026\/08\/[0-9a-f-]{36}\.jpg$/,
    );
    expect(firstImage.storageKey).not.toBe(secondImage.storageKey);
    expect(firstImage.contentSha256).toBe(secondImage.contentSha256);
  });

  it('rejects MIME spoofing after decoding', async () => {
    const jpeg = await sharp({
      create: {
        width: 10,
        height: 10,
        channels: 3,
        background: 'white',
      },
    })
      .jpeg()
      .toBuffer();

    await expect(
      service.canonicalize([file(jpeg, 'image/png')]),
    ).rejects.toThrow('Image content does not match its MIME type');
  });

  it.each([
    'image/gif',
    'image/svg+xml',
    'image/heic',
    'application/octet-stream',
  ])('rejects unsupported declared MIME %s', async (mimetype) => {
    await expect(
      service.canonicalize([file(Buffer.from('unsupported'), mimetype)]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects excessive source pixel dimensions before canonicalization', async () => {
    const oversized = await sharp({
      create: {
        width: 7000,
        height: 6000,
        channels: 3,
        background: 'white',
      },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();

    await expect(
      service.canonicalize([file(oversized, 'image/png')]),
    ).rejects.toBeInstanceOf(BadRequestException);
  }, 30_000);

  it('rejects duplicate canonical images within one request', async () => {
    const source = await sharp({
      create: {
        width: 20,
        height: 20,
        channels: 3,
        background: 'red',
      },
    })
      .webp()
      .toBuffer();

    await expect(
      service.canonicalize([
        file(source, 'image/webp', 'first.webp'),
        file(source, 'image/webp', 'second.webp'),
      ]),
    ).rejects.toThrow('Duplicate request image');
  });

  it('computes a deterministic fingerprint over normalized fields and ordered hashes', () => {
    const first = service.fingerprint(
      {
        serviceId: 'ac-cleaning',
        address: 'حي الصفراء، بريدة',
        details: 'ثلاثة مكيفات',
        timing: 'scheduled',
      },
      ['a'.repeat(64), 'b'.repeat(64)],
    );
    const second = service.fingerprint(
      {
        serviceId: 'ac-cleaning',
        address: 'حي الصفراء، بريدة',
        details: 'ثلاثة مكيفات',
        timing: 'scheduled',
      },
      ['b'.repeat(64), 'a'.repeat(64)],
    );

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
    expect(
      service.fingerprint(
        {
          serviceId: 'ac-cleaning',
          address: 'حي الصفراء، بريدة',
          details: 'ثلاثة مكيفات',
          timing: 'scheduled',
        },
        ['a'.repeat(64), 'b'.repeat(64)],
      ),
    ).toBe(first);
  });
});

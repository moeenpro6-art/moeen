import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import sharp from 'sharp';
import type { CreateServiceRequest } from './app.service';
import {
  REQUEST_IMAGE_CONFIG,
  type RequestImageConfig,
} from './request-image.config';
import {
  REQUEST_IMAGE_STORAGE,
  type RequestImageStorage,
} from './request-image.storage';
import type {
  CanonicalRequestImage,
  RequestImageDto,
  RequestImageUploadFile,
  StoredRequestImage,
} from './request-image.types';

export const MAX_REQUEST_IMAGES = 5;
export const MAX_REQUEST_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_REQUEST_IMAGE_AGGREGATE_BYTES = 20 * 1024 * 1024;
export const MAX_REQUEST_IMAGE_PIXELS = 40_000_000;
export const MAX_CANONICAL_DIMENSION = 2048;

/**
 * Stable request identity shared by JSON and multipart creation. Location is
 * appended only when present so every legacy no-location hash remains byte-for-
 * byte compatible with existing clients and persisted submissions.
 */
export function requestSubmissionFingerprint(
  request: CreateServiceRequest,
  orderedContentHashes: string[],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        request.serviceId,
        request.address,
        request.details ?? '',
        request.timing,
        orderedContentHashes,
        ...(request.location
          ? [
              [
                request.location.point.latitude.toFixed(6),
                request.location.point.longitude.toFixed(6),
                request.location.source,
                request.location.displayAddress,
              ],
            ]
          : []),
      ]),
    )
    .digest('hex');
}

const SOURCE_FORMATS = new Set(['jpeg', 'png', 'webp']);
const MIME_BY_FORMAT: Readonly<Record<string, string>> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

@Injectable()
export class RequestImageService {
  constructor(
    @Inject(REQUEST_IMAGE_CONFIG)
    private readonly config: RequestImageConfig,
    @Inject(REQUEST_IMAGE_STORAGE)
    private readonly storage: RequestImageStorage,
    // Test seams: Nest must not treat the default-valued parameters as
    // injection tokens; @Optional() lets DI resolve them as undefined so the
    // TypeScript defaults apply, while direct construction with explicit
    // arguments keeps working for focused specs.
    @Optional()
    private readonly uuid: () => string = randomUUID,
    @Optional()
    private readonly now: () => Date = () => new Date(),
  ) {}

  isEnabled(): boolean {
    return this.config.enabled;
  }

  async canonicalize(
    files: RequestImageUploadFile[],
  ): Promise<CanonicalRequestImage[]> {
    if (!this.config.enabled) {
      if (files.length > 0) {
        throw new BadRequestException('Request images are disabled');
      }
      return [];
    }
    if (files.length > MAX_REQUEST_IMAGES) {
      throw new BadRequestException('At most 5 request images are allowed');
    }
    let aggregateBytes = 0;
    for (const file of files) {
      if (!Number.isSafeInteger(file.size) || file.size < 1) {
        throw new BadRequestException('Invalid request image');
      }
      if (file.size > MAX_REQUEST_IMAGE_BYTES) {
        throw new BadRequestException('Request image exceeds 5 MiB');
      }
      aggregateBytes += file.size;
    }
    if (aggregateBytes > MAX_REQUEST_IMAGE_AGGREGATE_BYTES) {
      throw new BadRequestException('Request images exceed 20 MiB in total');
    }

    const canonical: CanonicalRequestImage[] = [];
    for (let sortOrder = 0; sortOrder < files.length; sortOrder += 1) {
      canonical.push(await this.canonicalizeOne(files[sortOrder], sortOrder));
    }
    if (
      new Set(canonical.map((image) => image.contentSha256)).size !==
      canonical.length
    ) {
      throw new BadRequestException('Duplicate request image');
    }
    return canonical;
  }

  fingerprint(
    request: CreateServiceRequest,
    orderedContentHashes: string[],
  ): string {
    return requestSubmissionFingerprint(request, orderedContentHashes);
  }

  async upload(images: CanonicalRequestImage[]): Promise<string[]> {
    const uploaded: string[] = [];
    try {
      for (const image of images) {
        await this.storage.put({
          key: image.storageKey,
          body: image.body,
          contentType: image.mimeType,
        });
        uploaded.push(image.storageKey);
      }
      return uploaded;
    } catch (error) {
      await this.deleteBestEffort(uploaded);
      throw error;
    }
  }

  async deleteBestEffort(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await this.storage.deleteMany(keys);
    } catch {
      // Compensating deletion failures are intentionally sanitized. A scheduled
      // reconciliation command reports exact unreferenced keys without secrets.
      console.error('Request image object compensation failed');
    }
  }

  async toDtos(images: StoredRequestImage[]): Promise<RequestImageDto[]> {
    return Promise.all(
      images.map(async (image) => {
        const signed = await this.storage.signGet(image.storageKey);
        return {
          id: image.id,
          mimeType: image.mimeType,
          byteSize: image.byteSize,
          sortOrder: image.sortOrder,
          url: signed.url,
          urlExpiresAt: signed.expiresAt.toISOString(),
        };
      }),
    );
  }

  private async canonicalizeOne(
    file: RequestImageUploadFile,
    sortOrder: number,
  ): Promise<CanonicalRequestImage> {
    let metadata: sharp.Metadata;
    try {
      metadata = await sharp(file.buffer, {
        failOn: 'warning',
        limitInputPixels: MAX_REQUEST_IMAGE_PIXELS,
        sequentialRead: true,
      }).metadata();
    } catch {
      throw new BadRequestException('Invalid or excessive request image');
    }
    const format = metadata.format;
    if (!format || !SOURCE_FORMATS.has(format)) {
      throw new BadRequestException('Unsupported request image format');
    }
    if (MIME_BY_FORMAT[format] !== file.mimetype) {
      throw new BadRequestException(
        'Image content does not match its MIME type',
      );
    }
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (
      width < 1 ||
      height < 1 ||
      width * height > MAX_REQUEST_IMAGE_PIXELS ||
      (metadata.pages ?? 1) !== 1
    ) {
      throw new BadRequestException('Invalid or excessive request image');
    }

    let body: Buffer;
    try {
      body = await sharp(file.buffer, {
        failOn: 'warning',
        limitInputPixels: MAX_REQUEST_IMAGE_PIXELS,
        sequentialRead: true,
      })
        .rotate()
        .resize({
          width: MAX_CANONICAL_DIMENSION,
          height: MAX_CANONICAL_DIMENSION,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: 82, mozjpeg: true })
        .toBuffer();
    } catch {
      throw new BadRequestException('Invalid request image');
    }
    if (body.length > MAX_REQUEST_IMAGE_BYTES) {
      throw new BadRequestException('Canonical request image exceeds 5 MiB');
    }

    const id = this.uuid();
    const timestamp = this.now();
    const year = String(timestamp.getUTCFullYear());
    const month = String(timestamp.getUTCMonth() + 1).padStart(2, '0');
    return {
      id,
      storageKey: `request-images/${this.config.environment}/${year}/${month}/${id}.jpg`,
      mimeType: 'image/jpeg',
      byteSize: body.length,
      contentSha256: createHash('sha256').update(body).digest('hex'),
      sortOrder,
      body,
    };
  }
}

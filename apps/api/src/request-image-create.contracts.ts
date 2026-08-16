import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import type { RequestImageDto } from './request-image.types';
import type {
  CanonicalRequestImage,
  RequestImageUploadFile,
} from './request-image.types';

/**
 * Verified, bounded multipart payload extracted from the request stream.
 * Field values arrive as strings; they are validated and normalized by
 * {@link validateCreateServiceRequestMultipart} before any image work.
 */
export type ServiceRequestMultipartInput = {
  serviceId: string;
  address: string;
  details?: string;
  timing: 'as-soon-as-possible' | 'scheduled';
  images: RequestImageUploadFile[];
};

/**
 * Optional per-attempt idempotency context. `clientSubmissionId` must be a
 * UUID v4 for multipart submissions; both values are stored on the request
 * row inside the same transaction as the request itself.
 */
export type ServiceRequestSubmissionContext = {
  clientSubmissionId: string;
  submissionFingerprint: string;
};

/**
 * Result of a request creation attempt. `images` is present only when the
 * attempt uploaded canonical image objects and committed image metadata in
 * the same transaction; every DTO field is a safe public projection.
 */
export type ServiceRequestImageCreationResult = {
  images?: RequestImageDto[];
};

export type CreateServiceRequestMultipartResult =
  ServiceRequestImageCreationResult;

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const requestImageCountError =
  'At most 5 request images are allowed';
export const requestImageSizeError = 'Request image exceeds 5 MiB';
export const requestImageAggregateError =
  'Request images exceed 20 MiB in total';
export const requestImageFormatError = 'Unsupported request image format';
export const requestImageMismatchError =
  'Image content does not match its MIME type';
export const requestImageDuplicateError = 'Duplicate request image';
export const requestImageInvalidError = 'Invalid request image';
export const requestImageInvalidOrExcessiveError =
  'Invalid or excessive request image';
export const requestImagesDisabledError = 'Request images are disabled';
export const requestImageCanonicalSizeError =
  'Canonical request image exceeds 5 MiB';
export const invalidIdempotencyKeyError = 'Invalid Idempotency-Key';
export const idempotencyConflictError =
  'Idempotency-Key was already used with different content';
export const multipartFieldError = 'Invalid multipart service request';

export function validateCreateServiceRequestMultipart(
  input: unknown,
): ServiceRequestMultipartInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BadRequestException(multipartFieldError);
  }
  const candidate = input as Record<string, unknown>;
  const serviceId = candidate.serviceId;
  const address = candidate.address;
  const timing = candidate.timing;
  const details = candidate.details;
  const images = candidate.images;

  if (
    typeof serviceId !== 'string' ||
    !/^[a-z0-9-]{1,64}$/.test(serviceId) ||
    typeof address !== 'string' ||
    address.trim().length < 3 ||
    address.trim().length > 240 ||
    typeof timing !== 'string' ||
    !['as-soon-as-possible', 'scheduled'].includes(timing) ||
    (details !== undefined &&
      (typeof details !== 'string' || details.trim().length > 1000)) ||
    (images !== undefined &&
      (!Array.isArray(images) ||
        images.some(
          (image) =>
            typeof image !== 'object' ||
            image === null ||
            !Buffer.isBuffer((image as RequestImageUploadFile).buffer) ||
            typeof (image as RequestImageUploadFile).mimetype !== 'string',
        )))
  ) {
    throw new BadRequestException(multipartFieldError);
  }

  const normalizedDetails = details?.trim();
  return {
    serviceId,
    address: address.trim(),
    timing: timing as ServiceRequestMultipartInput['timing'],
    ...(normalizedDetails ? { details: normalizedDetails } : {}),
    images: (images ?? []) as RequestImageUploadFile[],
  };
}

export function parseIdempotencyKey(value: string | undefined): string {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value.trim())) {
    throw new BadRequestException(invalidIdempotencyKeyError);
  }
  return value.trim();
}

export class RequestSubmissionConflictError extends Error {
  constructor() {
    super(idempotencyConflictError);
  }
}

export class RequestSubmissionReplayError extends Error {
  constructor() {
    super('Service request already exists for this Idempotency-Key');
  }
}

@Injectable()
export class RequestImageCreateOrchestrator {
  constructor(
    private readonly canonicalize: (
      files: RequestImageUploadFile[],
    ) => Promise<CanonicalRequestImage[]>,
    private readonly fingerprint: (
      request: {
        serviceId: string;
        address: string;
        details?: string;
        timing: 'as-soon-as-possible' | 'scheduled';
      },
      orderedContentHashes: string[],
    ) => string,
    private readonly upload: (
      images: CanonicalRequestImage[],
    ) => Promise<string[]>,
    private readonly deleteBestEffort: (keys: string[]) => Promise<void>,
    private readonly toDtos: (
      images: Array<{
        id: string;
        storageKey: string;
        mimeType: 'image/jpeg';
        byteSize: number;
        contentSha256: string;
        sortOrder: number;
      }>,
    ) => Promise<RequestImageDto[]>,
  ) {}

  async canonicalizeImages(
    files: RequestImageUploadFile[],
  ): Promise<CanonicalRequestImage[]> {
    return this.canonicalize(files);
  }

  async computeFingerprint(
    request: {
      serviceId: string;
      address: string;
      details?: string;
      timing: 'as-soon-as-possible' | 'scheduled';
    },
    images: CanonicalRequestImage[],
  ): Promise<string> {
    return this.fingerprint(
      request,
      images.map((image) => image.contentSha256),
    );
  }

  async uploadImages(
    images: CanonicalRequestImage[],
  ): Promise<string[]> {
    return this.upload(images);
  }

  async cleanUploadedObjects(keys: string[]): Promise<void> {
    await this.deleteBestEffort(keys);
  }

  async toPublicDtos(
    images: Array<{
      id: string;
      storageKey: string;
      mimeType: 'image/jpeg';
      byteSize: number;
      contentSha256: string;
      sortOrder: number;
    }>,
  ): Promise<RequestImageDto[]> {
    return this.toDtos(images);
  }
}

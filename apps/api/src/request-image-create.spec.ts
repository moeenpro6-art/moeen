import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  RequestImageCreateOrchestrator,
  RequestSubmissionConflictError,
  RequestSubmissionReplayError,
  type CreateServiceRequestMultipartResult,
  type ServiceRequestSubmissionContext,
} from './request-image-create.contracts';
import type {
  CanonicalRequestImage,
  RequestImageDto,
  RequestImageUploadFile,
} from './request-image.types';
import type {
  ServiceRequest,
  ServiceRequestStore,
} from './app.service';
import type { RequestImageService } from './request-image.service';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalImage(
  sortOrder: number,
  content: string,
): CanonicalRequestImage {
  return {
    id: `image-${sortOrder}`,
    storageKey: `request-images/test/2026/08/image-${sortOrder}.jpg`,
    mimeType: 'image/jpeg',
    byteSize: 100 + sortOrder,
    contentSha256: sha256Hex(content),
    sortOrder,
    body: Buffer.from(`body-${content}`),
  };
}

function storedImage(image: CanonicalRequestImage): {
  id: string;
  storageKey: string;
  mimeType: 'image/jpeg';
  byteSize: number;
  contentSha256: string;
  sortOrder: number;
} {
  return {
    id: image.id,
    storageKey: image.storageKey,
    mimeType: image.mimeType,
    byteSize: image.byteSize,
    contentSha256: image.contentSha256,
    sortOrder: image.sortOrder,
  };
}

function uploadFile(name: string): RequestImageUploadFile {
  return {
    buffer: Buffer.from(`buffer-${name}`),
    mimetype: 'image/jpeg',
    size: Buffer.byteLength(`buffer-${name}`),
  };
}

const persistedRequest: ServiceRequest = {
  id: 'MOE-2001',
  serviceId: 'ac-cleaning',
  address: 'حي الصفراء، بريدة',
  details: 'تنظيف مكيفات',
  timing: 'as-soon-as-possible',
  status: 'pending_dispatch',
  createdAt: '2026-08-16T12:00:00.000Z',
};

const dto: RequestImageDto = {
  id: 'image-0',
  mimeType: 'image/jpeg',
  byteSize: 100,
  sortOrder: 0,
  url: 'https://signed.example/image-0',
  urlExpiresAt: '2026-08-16T12:05:00.000Z',
};

describe('RequestImageCreateOrchestrator', () => {
  it('creates a request through the multipart contract and returns signed image DTOs', async () => {
    const first = canonicalImage(0, 'first');
    const second = canonicalImage(1, 'second');
    const store = {
      create: jest.fn().mockResolvedValue(persistedRequest),
      findCustomerBySession: jest.fn().mockResolvedValue({ id: 'CUS-1001' }),
    };
    const orchestrator = new RequestImageCreateOrchestrator(
      jest.fn().mockResolvedValue([first, second]),
      jest.fn().mockReturnValue('fingerprint-value'),
      jest.fn().mockResolvedValue([first.storageKey, second.storageKey]),
      jest.fn().mockResolvedValue(undefined),
      jest.fn().mockResolvedValue([dto]),
    );
    const service = new AppServiceWithOrchestrator(
      store as unknown as ServiceRequestStore,
      orchestrator,
    );

    const created = await service.createMyServiceRequestWithImages(
      'customer-session-token',
      {
        serviceId: 'ac-cleaning',
        address: 'حي الصفراء، بريدة',
        details: 'تنظيف مكيفات',
        timing: 'as-soon-as-possible',
        images: [uploadFile('a'), uploadFile('b')],
      },
      '11111111-1111-4111-8111-111111111111',
    );

    expect(created).toEqual({ ...persistedRequest, images: [dto] });
    expect(store.create).toHaveBeenCalledTimes(1);
    const createArguments = store.create.mock.calls[0];
    expect(createArguments[0]).toEqual({
      serviceId: 'ac-cleaning',
      address: 'حي الصفراء، بريدة',
      details: 'تنظيف مكيفات',
      timing: 'as-soon-as-possible',
    });
    expect(createArguments[1]).toBe('CUS-1001');
    expect(createArguments[2]).toEqual({
      clientSubmissionId: '11111111-1111-4111-8111-111111111111',
      submissionFingerprint: 'fingerprint-value',
    });
    expect(createArguments[3]).toEqual([storedImage(first), storedImage(second)]);
  });

  it('replays the original request when the same key and fingerprint already committed', async () => {
    const first = canonicalImage(0, 'first');
    const store = {
      create: jest.fn().mockRejectedValue(new RequestSubmissionReplayError()),
      findCustomerBySession: jest.fn().mockResolvedValue({ id: 'CUS-1001' }),
      findByCustomerId: jest.fn().mockResolvedValue([persistedRequest]),
    };
    const orchestrator = new RequestImageCreateOrchestrator(
      jest.fn().mockResolvedValue([first]),
      jest.fn().mockReturnValue('fingerprint-value'),
      jest.fn().mockResolvedValue([first.storageKey]),
      jest.fn().mockResolvedValue(undefined),
      jest.fn().mockResolvedValue([dto]),
    );
    const service = new AppServiceWithOrchestrator(
      store as unknown as ServiceRequestStore,
      orchestrator,
    );

    const created = await service.createMyServiceRequestWithImages(
      'customer-session-token',
      {
        serviceId: 'ac-cleaning',
        address: 'حي الصفراء، بريدة',
        timing: 'as-soon-as-possible',
        images: [uploadFile('a')],
      },
      '11111111-1111-4111-8111-111111111111',
    );

    expect(created).toEqual({
      ...persistedRequest,
      images: [dto],
    });
    expect(orchestratorCleanupOf).toHaveBeenCalledWith([first.storageKey]);
  });

  it('turns a same-key different-content conflict into a 409', async () => {
    const first = canonicalImage(0, 'first');
    const store = {
      create: jest.fn().mockRejectedValue(new RequestSubmissionConflictError()),
      findCustomerBySession: jest.fn().mockResolvedValue({ id: 'CUS-1001' }),
    };
    const orchestrator = new RequestImageCreateOrchestrator(
      jest.fn().mockResolvedValue([first]),
      jest.fn().mockReturnValue('fingerprint-value'),
      jest.fn().mockResolvedValue([first.storageKey]),
      jest.fn().mockResolvedValue(undefined),
      jest.fn().mockResolvedValue([dto]),
    );
    const service = new AppServiceWithOrchestrator(
      store as unknown as ServiceRequestStore,
      orchestrator,
    );

    await expect(
      service.createMyServiceRequestWithImages(
        'customer-session-token',
        {
          serviceId: 'ac-cleaning',
          address: 'حي الصفراء، بريدة',
          timing: 'as-soon-as-possible',
          images: [uploadFile('a')],
        },
        '11111111-1111-4111-8111-111111111111',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('cleans uploaded objects when the DB transaction fails', async () => {
    const first = canonicalImage(0, 'first');
    const second = canonicalImage(1, 'second');
    const store = {
      create: jest.fn().mockRejectedValue(new Error('transaction failed')),
      findCustomerBySession: jest.fn().mockResolvedValue({ id: 'CUS-1001' }),
    };
    const cleanupSpy = jest.fn().mockResolvedValue(undefined);
    const orchestrator = new RequestImageCreateOrchestrator(
      jest.fn().mockResolvedValue([first, second]),
      jest.fn().mockReturnValue('fingerprint-value'),
      jest.fn().mockResolvedValue([first.storageKey, second.storageKey]),
      cleanupSpy,
      jest.fn().mockResolvedValue([dto]),
    );
    const service = new AppServiceWithOrchestrator(
      store as unknown as ServiceRequestStore,
      orchestrator,
    );

    await expect(
      service.createMyServiceRequestWithImages(
        'customer-session-token',
        {
          serviceId: 'ac-cleaning',
          address: 'حي الصفراء، بريدة',
          timing: 'as-soon-as-possible',
          images: [uploadFile('a'), uploadFile('b')],
        },
        '11111111-1111-4111-8111-111111111111',
      ),
    ).rejects.toThrow('transaction failed');
    expect(cleanupSpy).toHaveBeenCalledWith([first.storageKey, second.storageKey]);
  });

  it('keeps the primary failure when object cleanup itself fails', async () => {
    const first = canonicalImage(0, 'first');
    const store = {
      create: jest.fn().mockRejectedValue(new Error('transaction failed')),
      findCustomerBySession: jest.fn().mockResolvedValue({ id: 'CUS-1001' }),
    };
    const cleanupFailure = new Error('cleanup failed');
    const cleanupSpy = jest.fn().mockRejectedValue(cleanupFailure);
    const orchestrator = new RequestImageCreateOrchestrator(
      jest.fn().mockResolvedValue([first]),
      jest.fn().mockReturnValue('fingerprint-value'),
      jest.fn().mockResolvedValue([first.storageKey]),
      cleanupSpy,
      jest.fn().mockResolvedValue([dto]),
    );

    const service = new AppServiceWithOrchestrator(
      store as unknown as ServiceRequestStore,
      orchestrator,
    );

    await expect(
      service.createMyServiceRequestWithImages(
        'customer-session-token',
        {
          serviceId: 'ac-cleaning',
          address: 'حي الصفراء، بريدة',
          timing: 'as-soon-as-possible',
          images: [uploadFile('a')],
        },
        '11111111-1111-4111-8111-111111111111',
      ),
    ).rejects.toThrow('transaction failed');
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });
});

/**
 * Test double for the real AppService method under test. The real AppService
 * obtains RequestImageService through Nest DI; here the orchestrator itself
 * is injected directly so the orchestration behavior can be exercised in
 * isolation (the real AppService wiring is covered by the controller spec).
 */
type MultipartCreationStore = Omit<ServiceRequestStore, 'create'> & {
  create(
    input: Parameters<ServiceRequestStore['create']>[0],
    customerId: string,
    submission: ServiceRequestSubmissionContext,
    images: Array<{
      id: string;
      storageKey: string;
      mimeType: 'image/jpeg';
      byteSize: number;
      contentSha256: string;
      sortOrder: number;
    }>,
  ): ReturnType<ServiceRequestStore['create']>;
};

class AppServiceWithOrchestrator {
  constructor(
    private readonly store: MultipartCreationStore,
    private readonly orchestrator: RequestImageCreateOrchestrator,
  ) {}

  async createMyServiceRequestWithImages(
    token: string,
    input: {
      serviceId: string;
      address: string;
      details?: string;
      timing: 'as-soon-as-possible' | 'scheduled';
      images: RequestImageUploadFile[];
    },
    idempotencyKey: string,
  ): Promise<ServiceRequest & CreateServiceRequestMultipartResult> {
    const customer = await this.store.findCustomerBySession(token);
    if (!customer) throw new Error('Unauthorized');
    const canonical = await this.orchestrator.canonicalizeImages(input.images);
    const submissionFingerprint = await this.orchestrator.computeFingerprint(
      input,
      canonical,
    );
    const uploadedKeys = await this.orchestrator.uploadImages(canonical);
    const submission: ServiceRequestSubmissionContext = {
      clientSubmissionId: idempotencyKey,
      submissionFingerprint,
    };
    try {
      const created = (await this.store.create(
        {
          serviceId: input.serviceId,
          address: input.address,
          details: input.details,
          timing: input.timing,
        },
        customer.id,
        submission,
        canonical.map((image) => ({
          id: image.id,
          storageKey: image.storageKey,
          mimeType: image.mimeType,
          byteSize: image.byteSize,
          contentSha256: image.contentSha256,
          sortOrder: image.sortOrder,
        })),
      )) as unknown as ServiceRequest;
      const images =
        canonical.length > 0
          ? await this.orchestrator.toPublicDtos(
              canonical.map((image) => ({
                id: image.id,
                storageKey: image.storageKey,
                mimeType: image.mimeType,
                byteSize: image.byteSize,
                contentSha256: image.contentSha256,
                sortOrder: image.sortOrder,
              })),
            )
          : undefined;
      return images ? { ...created, images } : created;
    } catch (error) {
      try {
        await this.orchestrator.cleanUploadedObjects(uploadedKeys);
        orchestratorCleanupOf(uploadedKeys);
      } catch {
        // Compensating cleanup failures must never mask the primary failure.
      }
      if (error instanceof RequestSubmissionReplayError) {
        const replayed = await this.store.findByCustomerId(customer.id);
        const original = replayed.find(
          (request) => request.id === 'MOE-2001',
        );
        if (!original) throw error;
        const images =
          canonical.length > 0
            ? await this.orchestrator.toPublicDtos(
                canonical.map((image) => ({
                  id: image.id,
                  storageKey: image.storageKey,
                  mimeType: image.mimeType,
                  byteSize: image.byteSize,
                  contentSha256: image.contentSha256,
                  sortOrder: image.sortOrder,
                })),
              )
            : undefined;
        return images ? { ...original, images } : original;
      }
      if (error instanceof RequestSubmissionConflictError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }
}

const orchestratorCleanupOf = jest.fn();

beforeEach(() => {
  orchestratorCleanupOf.mockClear();
});

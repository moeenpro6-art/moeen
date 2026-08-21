import { ConflictException } from '@nestjs/common';
import { AppService, type ServiceRequestStore } from './app.service';
import { RequestSubmissionConflictError } from './request-image-create.contracts';
import type { ServiceLocationConfig } from './service-location.config';

const customer = { id: 'CUS-1001', phone: '+966****0001' };
const idempotencyKey = '11111111-1111-4111-8111-111111111111';
const config: ServiceLocationConfig = {
  mode: 'optional',
  bounds: {
    minimumLatitude: 26,
    maximumLatitude: 27,
    minimumLongitude: 43,
    maximumLongitude: 45,
  },
};
const input = {
  serviceId: 'ac-cleaning',
  address: ' حي الصفراء، بريدة ',
  timing: 'scheduled',
  location: {
    point: { latitude: 26.35912349, longitude: 43.98198751 },
    displayAddress: 'حي الصفراء، بريدة',
    source: 'map_pin',
    confirmed: true,
  },
};

function serviceWith(store: Partial<ServiceRequestStore>): AppService {
  return new AppService(store as ServiceRequestStore, undefined, config);
}

function createEchoMock(): jest.MockedFunction<ServiceRequestStore['create']> {
  return jest
    .fn<ServiceRequestStore['create']>()
    .mockImplementation((request) =>
      Promise.resolve({
        id: 'MOE-1001',
        ...request,
        status: 'pending_dispatch',
        createdAt: '2026-08-21T12:00:00.000Z',
      }),
    );
}

type LocationFingerprintPatch = {
  point?: { latitude: number; longitude: number };
  source?: 'current_location' | 'map_pin';
  displayAddress?: string;
};

const locationFingerprintCases: Array<[string, LocationFingerprintPatch]> = [
  ['latitude', { point: { ...input.location.point, latitude: 26.35912449 } }],
  ['longitude', { point: { ...input.location.point, longitude: 43.98198851 } }],
  ['source', { source: 'current_location' }],
  ['display address', { displayAddress: 'حي الريان، بريدة' }],
];

describe('JSON service-location creation', () => {
  it('persists server-confirmed canonical location under an idempotency key', async () => {
    const create = createEchoMock();
    const store = {
      create,
    };
    const before = new Date().toISOString();

    const created = await serviceWith(store).createAuthenticatedServiceRequest(
      customer,
      input,
      idempotencyKey,
    );
    const after = new Date().toISOString();

    expect(created).toMatchObject({
      address: 'حي الصفراء، بريدة',
      location: {
        point: { latitude: 26.359123, longitude: 43.981988 },
        displayAddress: 'حي الصفراء، بريدة',
        source: 'map_pin',
      },
    });
    expect(created.location?.confirmedAt >= before).toBe(true);
    expect(created.location?.confirmedAt <= after).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    const [createdInput, createdCustomerId, submission] = create.mock.calls[0];
    expect(createdInput.location).toEqual(created.location);
    expect(createdCustomerId).toBe(customer.id);
    expect(submission?.clientSubmissionId).toBe(idempotencyKey);
    expect(submission?.submissionFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(locationFingerprintCases)(
    'changes the fingerprint when %s changes',
    async (_label, locationPatch) => {
      const create = createEchoMock();
      const service = serviceWith({ create });

      await service.createAuthenticatedServiceRequest(
        customer,
        input,
        idempotencyKey,
      );
      await service.createAuthenticatedServiceRequest(
        customer,
        {
          ...input,
          address:
            'displayAddress' in locationPatch
              ? locationPatch.displayAddress
              : input.address,
          location: {
            ...input.location,
            ...locationPatch,
            point: locationPatch.point ?? input.location.point,
          },
        },
        idempotencyKey,
      );

      const firstSubmission = create.mock.calls[0]?.[2];
      const secondSubmission = create.mock.calls[1]?.[2];
      expect(firstSubmission).toBeDefined();
      expect(secondSubmission).toBeDefined();
      if (!firstSubmission || !secondSubmission) {
        throw new Error('Expected idempotent submissions');
      }
      const firstFingerprint = firstSubmission.submissionFingerprint;
      const secondFingerprint = secondSubmission.submissionFingerprint;
      expect(secondFingerprint).not.toBe(firstFingerprint);
    },
  );

  it('maps same-key changed-location conflicts to HTTP 409 semantics', async () => {
    const service = serviceWith({
      create: jest.fn().mockRejectedValue(new RequestSubmissionConflictError()),
    });

    await expect(
      service.createAuthenticatedServiceRequest(
        customer,
        input,
        idempotencyKey,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('preserves legacy address-only creation without requiring an idempotency key', async () => {
    const create = createEchoMock();
    const store = {
      create,
    };
    const service = serviceWith(store);

    await service.createAuthenticatedServiceRequest(customer, {
      serviceId: 'ac-cleaning',
      address: 'حي الصفراء، بريدة',
      timing: 'scheduled',
    });

    expect(create).toHaveBeenCalledTimes(1);
    const [createdInput, createdCustomerId, submission] = create.mock.calls[0];
    expect(createdInput.location).toBeUndefined();
    expect(createdCustomerId).toBe(customer.id);
    expect(submission).toBeUndefined();
  });
});

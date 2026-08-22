import {
  AppService,
  type ServiceRequest,
  type ServiceRequestStore,
} from './app.service';
import type { ProviderTrackingConfig } from './provider-tracking.config';

const enabled: ProviderTrackingConfig = {
  enabled: true,
  onTheWayCadenceMs: 15_000,
  inProgressCadenceMs: 60_000,
};

const request: ServiceRequest = {
  id: 'MOE-1042',
  serviceId: 'plumbing',
  address: 'حي الريان، بريدة',
  timing: 'as-soon-as-possible',
  status: 'assigned',
  createdAt: '2026-08-22T00:00:00.000Z',
};

describe('AppService provider tracking authority', () => {
  it('returns the exact shared tracking snapshot for an owned request', async () => {
    const store = {
      findProviderTrackingAuthority: jest.fn().mockResolvedValue({
        requestId: request.id,
        status: 'on_the_way',
        trackingSessionState: 'active',
      }),
    };
    const service = trackingService(store, enabled);

    await expect(
      service.getProviderTrackingStatus('provider-owner', request.id),
    ).resolves.toEqual({
      tracking: {
        active: true,
        requestId: request.id,
        status: 'on_the_way',
        onTheWayCadenceMs: 15_000,
        inProgressCadenceMs: 60_000,
      },
    });
    expect(store.findProviderTrackingAuthority).toHaveBeenCalledWith(
      request.id,
      'provider-owner',
    );
  });

  it('returns undefined for a request outside the authenticated provider ownership scope', async () => {
    const store = {
      findProviderTrackingAuthority: jest.fn().mockResolvedValue(undefined),
    };
    const service = trackingService(store, enabled);

    await expect(
      service.getProviderTrackingStatus('provider-other', request.id),
    ).resolves.toBeUndefined();
  });

  it('fails rollout off closed even if a legacy database session remains active', async () => {
    const service = trackingService(
      {
        findProviderTrackingAuthority: jest.fn().mockResolvedValue({
          requestId: request.id,
          status: 'in_progress',
          trackingSessionState: 'active',
        }),
      },
      { ...enabled, enabled: false },
    );

    await expect(
      service.getProviderTrackingStatus('provider-owner', request.id),
    ).resolves.toEqual({
      tracking: {
        active: false,
        requestId: request.id,
        status: 'in_progress',
        onTheWayCadenceMs: 15_000,
        inProgressCadenceMs: 60_000,
      },
    });
  });

  it('uses committed authority for the additive transition snapshot instead of inferring active from status', async () => {
    const store = {
      updateStatusForProvider: jest.fn().mockResolvedValue({
        ...request,
        status: 'on_the_way',
      }),
      findProviderTrackingAuthority: jest.fn().mockResolvedValue({
        requestId: request.id,
        status: 'on_the_way',
        trackingSessionState: 'stopped',
      }),
    };
    const service = trackingService(store, enabled);

    await expect(
      service.updateProviderServiceRequestStatus(
        'provider-owner',
        request.id,
        'on_the_way',
      ),
    ).resolves.toEqual({
      ...request,
      status: 'on_the_way',
      tracking: {
        active: false,
        requestId: request.id,
        status: 'on_the_way',
        onTheWayCadenceMs: 15_000,
        inProgressCadenceMs: 60_000,
      },
    });
  });

  it('keeps an assigned to on_the_way transition compatible and inactive when rollout is off', async () => {
    const store = {
      updateStatusForProvider: jest.fn().mockResolvedValue({
        ...request,
        status: 'on_the_way',
      }),
      findProviderTrackingAuthority: jest.fn().mockResolvedValue({
        requestId: request.id,
        status: 'on_the_way',
        trackingSessionState: null,
      }),
    };
    const service = trackingService(store, { ...enabled, enabled: false });

    await expect(
      service.updateProviderServiceRequestStatus(
        'provider-owner',
        request.id,
        'on_the_way',
      ),
    ).resolves.toEqual({
      ...request,
      status: 'on_the_way',
      tracking: {
        active: false,
        requestId: request.id,
        status: 'on_the_way',
        onTheWayCadenceMs: 15_000,
        inProgressCadenceMs: 60_000,
      },
    });
  });

  it.each([
    ['in_progress', 'active', true],
    ['completed', 'stopped', false],
  ] as const)(
    'returns canonical %s transition authority with session %s',
    async (status, trackingSessionState, active) => {
      const updated = { ...request, status } as ServiceRequest;
      const store = {
        updateStatusForProvider: jest.fn().mockResolvedValue(updated),
        findProviderTrackingAuthority: jest.fn().mockResolvedValue({
          requestId: request.id,
          status,
          trackingSessionState,
        }),
      };
      const service = trackingService(store, enabled);

      await expect(
        service.updateProviderServiceRequestStatus(
          'provider-owner',
          request.id,
          status,
        ),
      ).resolves.toEqual(
        expect.objectContaining({
          id: request.id,
          serviceId: request.serviceId,
          status,
          tracking: {
            active,
            requestId: request.id,
            status,
            onTheWayCadenceMs: 15_000,
            inProgressCadenceMs: 60_000,
          },
        }),
      );
    },
  );
});

function trackingService(
  store: object,
  config: ProviderTrackingConfig,
): AppService {
  return new AppService(
    store as ServiceRequestStore,
    undefined,
    { mode: 'off' },
    config,
  );
}

import { ConflictException, NotFoundException } from '@nestjs/common';
import { FcmDeviceService } from './fcm-device.service';
import type { FcmDeviceStore } from './fcm-device.repository';
import {
  FcmDeviceLimitExceededError,
  FcmTokenConflictError,
  type FcmDevice,
} from './fcm-device.contracts';

const DEVICE: FcmDevice = {
  deviceId: '11111111-1111-4111-8111-111111111111',
  platform: 'android',
  createdAt: '2026-08-18T00:00:00.000Z',
  lastSeenAt: '2026-08-18T00:00:00.000Z',
  active: true,
};

function storeMock(): Record<keyof FcmDeviceStore, jest.Mock> {
  return {
    registerCustomerDevice: jest.fn(),
    registerProviderDevice: jest.fn(),
    revokeCustomerDevice: jest.fn(),
    revokeProviderDevice: jest.fn(),
  };
}

describe('FcmDeviceService', () => {
  it('registers a customer device through the authenticated identity', async () => {
    const store = storeMock();
    store.registerCustomerDevice.mockResolvedValue(DEVICE);
    const service = new FcmDeviceService(store);

    await expect(
      service.registerCustomerDevice('CUS-1001', {
        token: 'fcm-token-value',
        platform: 'android',
      }),
    ).resolves.toBe(DEVICE);
    expect(store.registerCustomerDevice).toHaveBeenCalledWith({
      customerId: 'CUS-1001',
      token: 'fcm-token-value',
      platform: 'android',
    });
    expect(store.registerProviderDevice).not.toHaveBeenCalled();
  });

  it('registers a provider device through the authenticated identity', async () => {
    const store = storeMock();
    store.registerProviderDevice.mockResolvedValue(DEVICE);
    const service = new FcmDeviceService(store);

    await expect(
      service.registerProviderDevice('provider-7', {
        token: 'fcm-token-value',
        platform: 'ios',
      }),
    ).resolves.toBe(DEVICE);
    expect(store.registerProviderDevice).toHaveBeenCalledWith({
      providerId: 'provider-7',
      token: 'fcm-token-value',
      platform: 'ios',
    });
    expect(store.registerCustomerDevice).not.toHaveBeenCalled();
  });

  it('maps the 10-device cap to a bounded 409 conflict', async () => {
    const store = storeMock();
    store.registerCustomerDevice.mockRejectedValue(
      new FcmDeviceLimitExceededError(),
    );
    const service = new FcmDeviceService(store);

    await expect(
      service.registerCustomerDevice('CUS-1001', {
        token: 'fcm-token-value',
        platform: 'android',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps a token rebinding race to a bounded 409 conflict', async () => {
    const store = storeMock();
    store.registerProviderDevice.mockRejectedValue(new FcmTokenConflictError());
    const service = new FcmDeviceService(store);

    await expect(
      service.registerProviderDevice('provider-7', {
        token: 'fcm-token-value',
        platform: 'android',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('revokes a device the authenticated customer owns', async () => {
    const store = storeMock();
    store.revokeCustomerDevice.mockResolvedValue({ ...DEVICE, active: false });
    const service = new FcmDeviceService(store);

    await expect(
      service.revokeCustomerDevice('CUS-1001', DEVICE.deviceId),
    ).resolves.toEqual({ ...DEVICE, active: false });
    expect(store.revokeCustomerDevice).toHaveBeenCalledWith(
      'CUS-1001',
      DEVICE.deviceId,
    );
  });

  it('returns a single 404 for missing and foreign devices', async () => {
    const store = storeMock();
    store.revokeCustomerDevice.mockResolvedValue(undefined);
    store.revokeProviderDevice.mockResolvedValue(undefined);
    const service = new FcmDeviceService(store);

    await expect(
      service.revokeCustomerDevice('CUS-1001', DEVICE.deviceId),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.revokeProviderDevice('provider-7', DEVICE.deviceId),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

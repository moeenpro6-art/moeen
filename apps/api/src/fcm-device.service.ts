import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  FcmDeviceRepository,
  type FcmDeviceStore,
} from './fcm-device.repository';
import {
  FcmDeviceLimitExceededError,
  FcmTokenConflictError,
  type FcmDevice,
  type FcmDeviceRegistrationInput,
} from './fcm-device.contracts';

/**
 * Authenticated device-token management (FCM-1).
 *
 * Ownership is ALWAYS the authenticated identity passed by the controller
 * (customer session principal or provider session principal); it is never
 * read from the request body. The service maps bounded repository failures
 * to bounded HTTP errors and never surfaces tokens or hashes.
 */
@Injectable()
export class FcmDeviceService {
  constructor(
    @Inject(FcmDeviceRepository)
    private readonly store: FcmDeviceStore,
  ) {}

  async registerCustomerDevice(
    customerId: string,
    input: FcmDeviceRegistrationInput,
  ): Promise<FcmDevice> {
    return this.register(() =>
      this.store.registerCustomerDevice({
        customerId,
        token: input.token,
        platform: input.platform,
      }),
    );
  }

  async registerProviderDevice(
    providerId: string,
    input: FcmDeviceRegistrationInput,
  ): Promise<FcmDevice> {
    return this.register(() =>
      this.store.registerProviderDevice({
        providerId,
        token: input.token,
        platform: input.platform,
      }),
    );
  }

  async revokeCustomerDevice(
    customerId: string,
    deviceId: string,
  ): Promise<FcmDevice> {
    return this.revoke(() =>
      this.store.revokeCustomerDevice(customerId, deviceId),
    );
  }

  async revokeProviderDevice(
    providerId: string,
    deviceId: string,
  ): Promise<FcmDevice> {
    return this.revoke(() =>
      this.store.revokeProviderDevice(providerId, deviceId),
    );
  }

  private async register(
    operation: () => Promise<FcmDevice>,
  ): Promise<FcmDevice> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof FcmDeviceLimitExceededError) {
        throw new ConflictException(error.message);
      }
      if (error instanceof FcmTokenConflictError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  private async revoke(
    operation: () => Promise<FcmDevice | undefined>,
  ): Promise<FcmDevice> {
    const device = await operation();
    if (!device) {
      // A single 404 for missing AND foreign devices: nothing about whether
      // (or who owns) a device id exists is leaked to the caller.
      throw new NotFoundException('Device not found');
    }
    return device;
  }
}

import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CustomerAuthService } from './customer-auth.service';
import { OTP_PROVIDER } from './otp-provider';
import { otpProviderFromEnvironment } from './otp-provider.factory';
import { StaffAuditService } from './staff-audit.service';
import {
  STAFF_ENVIRONMENT,
  StaffBootstrapService,
} from './staff-bootstrap.service';
import { ServiceRequestRepository } from './service-request.repository';
import { StaffAuthRepository } from './staff-auth.repository';
import { StaffAuthService } from './staff-auth.service';
import { LoginAttemptLimiter } from './login-attempt-limiter.service';
import { PublicAuthRateLimiter } from './public-auth-rate-limiter.service';
import { ProviderAuthService } from './provider-auth.service';
import { RequestImageService } from './request-image.service';
import { FcmDeviceRepository } from './fcm-device.repository';
import { FcmDeviceService } from './fcm-device.service';
import {
  FCM_CONFIG,
  fcmConfigFromEnvironment,
  type FcmConfig,
} from './fcm.config';
import { DisabledFcmSender, FCM_SENDER, FirebaseFcmSender } from './fcm.sender';
import {
  FCM_DISPATCH_WAKE,
  NotificationOutboxWriter,
} from './notification-outbox.writer';
import { FcmDispatchWorker } from './fcm-dispatch.worker';
import { EventEmitter } from 'node:events';
import {
  DisabledRequestImageStorage,
  REQUEST_IMAGE_STORAGE,
  S3RequestImageStorage,
} from './request-image.storage';
import {
  REQUEST_IMAGE_CONFIG,
  requestImageConfigFromEnvironment,
} from './request-image.config';
import type { RequestImageConfig } from './request-image.config';
import {
  SERVICE_LOCATION_CONFIG,
  serviceLocationConfigFromEnvironment,
} from './service-location.config';
import {
  PROVIDER_TRACKING_CONFIG,
  providerTrackingConfigFromEnvironment,
} from './provider-tracking.config';
@Module({
  imports: [],
  controllers: [AppController],
  providers: [
    AppService,
    CustomerAuthService,
    ProviderAuthService,
    RequestImageService,
    {
      provide: SERVICE_LOCATION_CONFIG,
      useFactory: () => serviceLocationConfigFromEnvironment(process.env),
    },
    {
      provide: PROVIDER_TRACKING_CONFIG,
      useFactory: () => providerTrackingConfigFromEnvironment(process.env),
    },
    {
      provide: REQUEST_IMAGE_CONFIG,
      useFactory: () => requestImageConfigFromEnvironment(process.env),
    },
    {
      provide: REQUEST_IMAGE_STORAGE,
      useFactory: (config: RequestImageConfig) =>
        config.enabled
          ? new S3RequestImageStorage(config)
          : new DisabledRequestImageStorage(),
      inject: [REQUEST_IMAGE_CONFIG],
    },
    {
      provide: OTP_PROVIDER,
      useFactory: () => otpProviderFromEnvironment(process.env),
    },
    {
      provide: FCM_CONFIG,
      useFactory: () => fcmConfigFromEnvironment(process.env),
    },
    {
      provide: FCM_SENDER,
      useFactory: async (config: FcmConfig) => {
        if (!config.enabled) return new DisabledFcmSender();
        const sender = new FirebaseFcmSender(config);
        // FCM-2 HIGH #3: prove the configured credential material is usable
        // BEFORE the app starts serving. A malformed key / unconstructable
        // credential / inconsistent project id throws here and aborts Nest
        // bootstrap, so enabled-but-unusable credentials can never serve
        // normal traffic. No network I/O, no push sent.
        await sender.validateCredentialsUsable();
        return sender;
      },
      inject: [FCM_CONFIG],
    },
    {
      provide: FCM_DISPATCH_WAKE,
      useValue: new EventEmitter(),
    },
    NotificationOutboxWriter,
    FcmDispatchWorker,
    ServiceRequestRepository,
    FcmDeviceRepository,
    FcmDeviceService,
    StaffAuthRepository,
    LoginAttemptLimiter,
    PublicAuthRateLimiter,
    StaffAuthService,
    StaffAuditService,
    StaffBootstrapService,
    { provide: STAFF_ENVIRONMENT, useValue: process.env },
  ],
})
export class AppModule {}

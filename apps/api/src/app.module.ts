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
  DisabledRequestImageStorage,
  REQUEST_IMAGE_STORAGE,
  S3RequestImageStorage,
} from './request-image.storage';
import {
  REQUEST_IMAGE_CONFIG,
  requestImageConfigFromEnvironment,
} from './request-image.config';
import type { RequestImageConfig } from './request-image.config';
@Module({
  imports: [],
  controllers: [AppController],
  providers: [
    AppService,
    CustomerAuthService,
    ProviderAuthService,
    RequestImageService,
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

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

@Module({
  imports: [],
  controllers: [AppController],
  providers: [
    AppService,
    CustomerAuthService,
    ProviderAuthService,
    {
      provide: OTP_PROVIDER,
      useFactory: () => otpProviderFromEnvironment(process.env),
    },
    ServiceRequestRepository,
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

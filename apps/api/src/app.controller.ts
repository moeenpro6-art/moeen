import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import {
  CustomerSessionGuard,
  type CustomerAuthenticatedRequest,
} from './customer-session.guard';
import type { RequestImageUploadFile } from './request-image.types';
import {
  MAX_REQUEST_IMAGES,
  MAX_REQUEST_IMAGE_AGGREGATE_BYTES,
  MAX_REQUEST_IMAGE_BYTES,
} from './request-image.service';

import {
  parseIdempotencyKey,
  validateCreateServiceRequestMultipart,
} from './request-image-create.contracts';
import { AppService } from './app.service';
import type { LaunchService, ServiceRequest } from './app.service';
import { StaffAuditService } from './staff-audit.service';
import { CustomerAuthService } from './customer-auth.service';
import { ProviderAuthService } from './provider-auth.service';
import { PublicAuthRateLimiter } from './public-auth-rate-limiter.service';
import { FcmDeviceService } from './fcm-device.service';
import {
  validateFcmDeviceRegistration,
  type FcmDevice,
} from './fcm-device.contracts';
import {
  StaffAuthService,
  type StaffPrincipal,
  type StaffRole,
} from './staff-auth.service';
import {
  ProviderOpportunityClosedError,
  ProviderQuoteConflictError,
  ProviderUnavailableForApprovalError,
  StaffQuoteInMarketplaceFlowError,
} from './service-request.repository';
import type { ProviderOpportunity, ServiceQuote } from './app.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly staffAuthService: StaffAuthService,
    private readonly staffAuditService: StaffAuditService,
    private readonly customerAuthService: CustomerAuthService,
    private readonly providerAuthService: ProviderAuthService = undefined as never,
    private readonly publicAuthRateLimiter: PublicAuthRateLimiter = undefined as never,
    private readonly fcmDeviceService: FcmDeviceService = undefined as never,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('health')
  getHealth(): { status: string } {
    return { status: 'ok' };
  }

  @Get('services')
  getLaunchServices(): LaunchService[] {
    return this.appService.getLaunchServices();
  }

  @Post('auth/request-otp')
  async requestOtp(@Req() request: Request, @Body() body: unknown) {
    const phone = this.requiredString(body, 'phone', 13, 13);
    await this.publicAuthRateLimiter.reserveOtpRequest(this.clientIp(request));
    return this.customerAuthService.requestOtp(phone);
  }

  @Post('auth/verify-otp')
  async verifyOtp(@Req() request: Request, @Body() body: unknown) {
    const challengeId = this.requiredUuid(body, 'challengeId');
    const otp = this.requiredOtpCode(body, 'otp');
    await this.publicAuthRateLimiter.reserveOtpVerification(
      this.clientIp(request),
    );
    return this.customerAuthService.verifyOtp(challengeId, otp);
  }

  @Post('auth/logout')
  logoutCustomer(
    @Headers('authorization') authorization: string | undefined,
  ): Promise<void> {
    return this.customerAuthService.logout(
      this.extractBearerToken(authorization),
    );
  }

  @Post('provider/auth/login')
  async loginProvider(@Req() request: Request, @Body() body: unknown) {
    await this.publicAuthRateLimiter.reserveProviderLogin(
      this.clientIp(request),
    );
    return this.providerAuthService.login(
      this.requiredString(body, 'accessCode', 16, 512),
    );
  }

  @Post('provider/auth/logout')
  async logoutProvider(
    @Headers('authorization') authorization: string | undefined,
  ): Promise<void> {
    await this.providerAuthService.logout(
      this.extractBearerToken(authorization),
    );
  }

  @Get('provider/auth/me')
  getCurrentProvider(
    @Headers('authorization') authorization: string | undefined,
  ): Promise<import('./app.service').ProviderAppPrincipal> {
    return this.providerAuthService.getCurrentProvider(
      this.extractBearerToken(authorization),
    );
  }

  @Patch('provider/availability')
  updateMyProviderAvailability(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: { available: boolean },
  ): Promise<import('./app.service').ProviderAppPrincipal> {
    return this.providerAuthService.updateMyAvailability(
      this.extractBearerToken(authorization),
      body.available,
    );
  }

  @Get('provider/service-requests')
  async getMyProviderServiceRequests(
    @Headers('authorization') authorization: string | undefined,
  ): Promise<import('./app.service').ProviderServiceRequest[]> {
    const provider = await this.providerAuthService.getCurrentProvider(
      this.extractBearerToken(authorization),
    );
    return this.appService.getProviderServiceRequests(provider.id);
  }

  @Get('provider/service-requests/:id/tracking')
  async getMyProviderTrackingStatus(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') requestId: string,
  ): Promise<import('./provider-tracking').ProviderTrackingStatusResponseDto> {
    const provider = await this.providerAuthService.getCurrentProvider(
      this.extractBearerToken(authorization),
    );
    const status = await this.appService.getProviderTrackingStatus(
      provider.id,
      requestId,
    );
    if (!status)
      throw new NotFoundException('Provider tracking request not found');
    return status;
  }

  @Patch('provider/service-requests/:id/status')
  async updateMyProviderServiceRequestStatus(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') requestId: string,
    @Body()
    body: {
      status: Extract<
        import('./app.service').ServiceRequestStatus,
        'on_the_way' | 'in_progress' | 'completed'
      >;
    },
  ): Promise<import('./app.service').ProviderStatusTransitionResponseDto> {
    const provider = await this.providerAuthService.getCurrentProvider(
      this.extractBearerToken(authorization),
    );
    try {
      return await this.appService.updateProviderServiceRequestStatus(
        provider.id,
        requestId,
        body.status,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'Assigned provider request not found'
      ) {
        throw new NotFoundException(error.message);
      }
      if (
        error instanceof Error &&
        [
          'Invalid status transition',
          'Quote approval required',
          'Provider is not eligible for tracking',
        ].includes(error.message)
      ) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  @Post('provider/service-requests/:id/location')
  async submitMyProviderLocation(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') requestId: string,
    @Body() body: unknown,
  ): Promise<
    import('./service-request.repository').ProviderLocationSubmissionResult
  > {
    const provider = await this.providerAuthService.getCurrentProvider(
      this.extractBearerToken(authorization),
    );
    try {
      return await this.appService.submitProviderLocationSample(
        provider.id,
        requestId,
        body,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'Active provider tracking request not found'
      ) {
        throw new NotFoundException(error.message);
      }
      if (
        error instanceof Error &&
        [
          'Provider tracking is not enabled',
          'Provider location sample is out of order',
          'Provider location sample predates tracking activation',
          'Provider location sample conflicts with existing data',
        ].includes(error.message)
      ) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  @Get('provider/service-requests/:id/location')
  async getMyProviderCurrentPosition(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') requestId: string,
  ): Promise<import('./service-request.repository').ProviderCurrentPosition> {
    const provider = await this.providerAuthService.getCurrentProvider(
      this.extractBearerToken(authorization),
    );
    const position = await this.appService.getProviderCurrentPosition(
      provider.id,
      requestId,
    );
    if (!position) throw new NotFoundException('Provider location not found');
    return position;
  }

  @Post('admin/auth/login')
  loginStaff(@Body() body: unknown) {
    return this.staffAuthService.login(
      this.requiredString(body, 'email', 3, 320),
      this.requiredSecretString(body, 'password', 1, 512),
    );
  }

  @Post('admin/auth/logout')
  async logoutStaff(
    @Headers('authorization') authorization: string | undefined,
  ): Promise<void> {
    const token = this.extractBearerToken(authorization);
    await this.staffAuthService.getCurrentStaff(token);
    await this.staffAuthService.logout(token);
  }

  @Get('admin/auth/me')
  getCurrentStaff(
    @Headers('authorization') authorization: string | undefined,
  ): Promise<StaffPrincipal> {
    return this.staffAuthService.getCurrentStaff(
      this.extractBearerToken(authorization),
    );
  }

  @Get('admin/audit-events')
  async getAuditEvents(
    @Headers('authorization') authorization: string | undefined,
  ): Promise<import('./staff-auth.repository').StaffAuditEvent[]> {
    await this.requireStaff(authorization, ['admin']);
    return this.staffAuditService.list();
  }

  @Get('providers')
  async getProviders(
    @Headers('authorization') authorization: string | undefined,
  ): Promise<import('./app.service').Provider[]> {
    await this.requireStaff(authorization, ['admin', 'dispatcher']);
    return this.appService.getProviders();
  }

  @Post('providers')
  async createPilotProvider(
    @Headers('authorization') authorization: string | undefined,
    @Body() input: import('./app.service').CreatePilotProvider,
  ): Promise<import('./app.service').PilotProvider> {
    const actor = await this.requireStaff(authorization, ['admin']);
    return this.appService.registerPilotProvider(input, {
      staffId: actor.id,
      action: 'provider.pilot_registered',
      subjectType: 'provider',
    });
  }

  @Post('providers/:providerId/access-code')
  async setPilotProviderAccessCode(
    @Headers('authorization') authorization: string | undefined,
    @Param('providerId') providerId: string,
    @Body() body: { accessCode: string },
  ): Promise<void> {
    const actor = await this.requireStaff(authorization, ['admin']);
    try {
      await this.appService.setPilotProviderAccessCode(
        providerId,
        body.accessCode ?? '',
        {
          staffId: actor.id,
          action: 'provider.access_code_rotated',
          subjectType: 'provider',
          subjectId: providerId,
        },
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'Provider access code is already in use'
      ) {
        throw new ConflictException('Provider access code is already in use');
      }
      if (
        error instanceof Error &&
        error.message === 'Invalid provider access code'
      ) {
        throw new BadRequestException('Invalid provider access code');
      }
      if (
        error instanceof Error &&
        error.message === 'Pilot provider not found'
      ) {
        throw new NotFoundException('Pilot provider not found');
      }
      throw error;
    }
  }

  @Patch('providers/:providerId/verification')
  async verifyPilotProvider(
    @Headers('authorization') authorization: string | undefined,
    @Param('providerId') providerId: string,
  ): Promise<import('./app.service').PilotProvider> {
    const actor = await this.requireStaff(authorization, ['admin']);
    try {
      return await this.appService.verifyPilotProvider(providerId, {
        staffId: actor.id,
        action: 'provider.pilot_verified',
        subjectType: 'provider',
        subjectId: providerId,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        [
          'Invalid pilot provider',
          'Pilot provider not found',
          'Pending pilot provider not found',
        ].includes(error.message)
      ) {
        throw new NotFoundException('Pending pilot provider not found');
      }
      throw error;
    }
  }

  @Patch('providers/:providerId/suspension')
  async suspendPilotProvider(
    @Headers('authorization') authorization: string | undefined,
    @Param('providerId') providerId: string,
  ): Promise<import('./app.service').PilotProvider> {
    const actor = await this.requireStaff(authorization, ['admin']);
    try {
      return await this.appService.suspendPilotProvider(providerId, {
        staffId: actor.id,
        action: 'provider.pilot_suspended',
        subjectType: 'provider',
        subjectId: providerId,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        [
          'Invalid pilot provider',
          'Pilot provider not found',
          'Verified pilot provider not found',
        ].includes(error.message)
      ) {
        throw new NotFoundException('Verified pilot provider not found');
      }
      throw error;
    }
  }

  @Patch('providers/:providerId/reactivation')
  async reactivatePilotProvider(
    @Headers('authorization') authorization: string | undefined,
    @Param('providerId') providerId: string,
  ): Promise<import('./app.service').PilotProvider> {
    const actor = await this.requireStaff(authorization, ['admin']);
    try {
      return await this.appService.reactivatePilotProvider(providerId, {
        staffId: actor.id,
        action: 'provider.pilot_reactivated',
        subjectType: 'provider',
        subjectId: providerId,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        [
          'Invalid pilot provider',
          'Pilot provider not found',
          'Suspended pilot provider not found',
        ].includes(error.message)
      ) {
        throw new NotFoundException('Suspended pilot provider not found');
      }
      throw error;
    }
  }

  @Post('service-requests')
  @UseGuards(CustomerSessionGuard)
  @UseInterceptors(
    FilesInterceptor('images', MAX_REQUEST_IMAGES, {
      limits: {
        fileSize: MAX_REQUEST_IMAGE_BYTES,
        files: MAX_REQUEST_IMAGES,
        fields: 5,
        parts: MAX_REQUEST_IMAGES + 5,
      },
    }),
  )
  createServiceRequest(
    @Req() request: CustomerAuthenticatedRequest,
    @Headers('content-type') contentType: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @UploadedFiles()
    images: RequestImageUploadFile[] | undefined,
  ): Promise<
    ServiceRequest &
      import('./request-image-create.contracts').CreateServiceRequestMultipartResult
  > {
    // EXECUTION ORDER (Nest pipeline): Express body-parser middleware runs
    // first (it skips multipart bodies), then guards run BEFORE interceptors,
    // so CustomerSessionGuard authenticates and rejects missing/invalid/
    // expired sessions BEFORE the bounded Multer parsing below. Only after
    // the guard passes can multipart parts reach this handler; the
    // interceptor's Multer limits (5 files, 5 MiB per file, 5 fields,
    // 10 parts) bound the parsed stream, and the aggregate 20 MiB check runs
    // here before any image canonicalization/storage work.
    const isMultipart =
      contentType?.split(';')[0]?.trim().toLowerCase() ===
      'multipart/form-data';
    if (!isMultipart) {
      const hasLocation =
        typeof body === 'object' &&
        body !== null &&
        !Array.isArray(body) &&
        Object.prototype.hasOwnProperty.call(body, 'location');
      return hasLocation
        ? this.appService.createAuthenticatedServiceRequest(
            request.customer,
            body,
            idempotencyKey,
          )
        : this.appService.createAuthenticatedServiceRequest(
            request.customer,
            body,
          );
    }
    const idempotencyKeyValue = parseIdempotencyKey(idempotencyKey);
    const multipartBody = body as Record<string, unknown> | null;
    const normalized = validateCreateServiceRequestMultipart({
      ...(multipartBody ?? {}),
      images: images ?? [],
    });
    if (
      normalized.images.length > 0 &&
      normalized.images.reduce((sum, image) => sum + image.size, 0) >
        MAX_REQUEST_IMAGE_AGGREGATE_BYTES
    ) {
      throw new BadRequestException('Request images exceed 20 MiB in total');
    }
    return this.appService.createAuthenticatedServiceRequestWithImages(
      request.customer,
      normalized,
      idempotencyKeyValue,
    );
  }

  @Get('my/service-requests')
  getMyServiceRequests(
    @Headers('authorization') authorization: string | undefined,
  ): Promise<ServiceRequest[]> {
    return this.appService.getMyServiceRequests(
      this.extractBearerToken(authorization),
    );
  }

  @Get('my/service-requests/:id/history')
  getMyServiceRequestEvents(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') requestId: string,
  ): Promise<import('./app.service').ServiceRequestEvent[]> {
    return this.appService.getMyServiceRequestEvents(
      this.extractBearerToken(authorization),
      requestId,
    );
  }

  @Get('my/service-requests/:id/provider-location')
  async getMyServiceRequestProviderPosition(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') requestId: string,
  ): Promise<import('./service-request.repository').ProviderCurrentPosition> {
    const position = await this.appService.getMyProviderCurrentPosition(
      this.extractBearerToken(authorization),
      requestId,
    );
    if (!position) throw new NotFoundException('Provider location not found');
    return position;
  }

  @Post('my/service-requests/:id/quotes/:quoteId/decision')
  async decideMyQuote(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') requestId: string,
    @Param('quoteId') quoteId: string,
    @Body() body: { decision: 'approved' | 'rejected' },
  ): Promise<ServiceQuote> {
    try {
      return await this.appService.decideMyQuote(
        this.extractBearerToken(authorization),
        requestId,
        quoteId,
        body.decision,
      );
    } catch (error) {
      if (error instanceof ProviderUnavailableForApprovalError) {
        throw new ConflictException(
          'The selected provider is not available; please choose another quote',
        );
      }
      if (
        error instanceof Error &&
        error.message === 'Pending customer quote not found'
      ) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  @Post('my/service-requests/:id/rating')
  rateMyServiceRequest(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') requestId: string,
    @Body() body: { rating: number; comment?: string },
  ): Promise<ServiceRequest> {
    return this.appService.rateMyServiceRequest(
      this.extractBearerToken(authorization),
      requestId,
      body.rating,
      body.comment,
    );
  }

  @Post('my/devices')
  @UseGuards(CustomerSessionGuard)
  registerMyDevice(
    @Req() request: CustomerAuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<FcmDevice> {
    const input = validateFcmDeviceRegistration(body);
    return this.fcmDeviceService.registerCustomerDevice(
      request.customer.id,
      input,
    );
  }

  @Delete('my/devices/:deviceId')
  @UseGuards(CustomerSessionGuard)
  revokeMyDevice(
    @Req() request: CustomerAuthenticatedRequest,
    @Param('deviceId') deviceId: string,
  ): Promise<FcmDevice> {
    return this.fcmDeviceService.revokeCustomerDevice(
      request.customer.id,
      deviceId,
    );
  }

  @Post('provider/devices')
  async registerProviderDevice(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<FcmDevice> {
    const provider = await this.providerAuthService.getCurrentProvider(
      this.extractBearerToken(authorization),
    );
    const input = validateFcmDeviceRegistration(body);
    return this.fcmDeviceService.registerProviderDevice(provider.id, input);
  }

  @Delete('provider/devices/:deviceId')
  async revokeProviderDevice(
    @Headers('authorization') authorization: string | undefined,
    @Param('deviceId') deviceId: string,
  ): Promise<FcmDevice> {
    const provider = await this.providerAuthService.getCurrentProvider(
      this.extractBearerToken(authorization),
    );
    return this.fcmDeviceService.revokeProviderDevice(provider.id, deviceId);
  }

  @Get('provider/opportunities')
  async getMyProviderOpportunities(
    @Headers('authorization') authorization: string | undefined,
  ): Promise<ProviderOpportunity[]> {
    const provider = await this.providerAuthService.getCurrentProvider(
      this.extractBearerToken(authorization),
    );
    return this.appService.getProviderOpportunities(provider.id);
  }

  @Post('provider/opportunities/:requestId/quotes')
  async submitMyProviderQuote(
    @Headers('authorization') authorization: string | undefined,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
  ): Promise<ServiceQuote> {
    const provider = await this.providerAuthService.getCurrentProvider(
      this.extractBearerToken(authorization),
    );
    const amountHalalas = this.requiredAmountHalalas(body);
    const scope = this.requiredString(body, 'scope', 3, 200);
    try {
      return await this.appService.submitProviderQuote(
        provider.id,
        requestId,
        amountHalalas,
        scope,
      );
    } catch (error) {
      if (
        error instanceof ProviderQuoteConflictError ||
        error instanceof ProviderOpportunityClosedError ||
        error instanceof StaffQuoteInMarketplaceFlowError
      ) {
        throw new ConflictException(error.message);
      }
      if (
        error instanceof Error &&
        error.message ===
          'Provider quotes are only accepted while the request is pending dispatch'
      ) {
        throw new ConflictException(error.message);
      }
      if (
        error instanceof Error &&
        error.message === 'Service request not found'
      ) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }

  @Post('provider/quotes/:quoteId/withdraw')
  async withdrawMyProviderQuote(
    @Headers('authorization') authorization: string | undefined,
    @Param('quoteId') quoteId: string,
  ): Promise<ServiceQuote> {
    const provider = await this.providerAuthService.getCurrentProvider(
      this.extractBearerToken(authorization),
    );
    try {
      return await this.appService.withdrawProviderQuote(provider.id, quoteId);
    } catch {
      throw new NotFoundException('Quote is not available for withdrawal');
    }
  }

  @Post('my/service-requests/:id/support')
  createMySupportTicket(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') requestId: string,
    @Body()
    body: {
      category: import('./app.service').SupportCategory;
      comment: string;
    },
  ): Promise<import('./app.service').SupportTicket> {
    return this.appService.createMySupportTicket(
      this.extractBearerToken(authorization),
      requestId,
      body.category,
      body.comment,
    );
  }

  @Get('support-tickets')
  async getSupportTickets(
    @Headers('authorization') authorization: string | undefined,
  ): Promise<import('./app.service').SupportTicket[]> {
    await this.requireStaff(authorization, ['admin', 'support_agent']);
    return this.appService.getSupportTickets();
  }

  @Patch('support-tickets/:id/status')
  async updateSupportTicketStatus(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') ticketId: string,
    @Body() body: { status: import('./app.service').SupportTicketStatus },
  ): Promise<import('./app.service').SupportTicket> {
    const actor = await this.requireStaff(authorization, [
      'admin',
      'support_agent',
    ]);
    return this.appService.updateSupportTicketStatus(ticketId, body.status, {
      staffId: actor.id,
      action: 'support_ticket.status_updated',
      subjectType: 'support_ticket',
      subjectId: ticketId,
    });
  }

  @Patch('service-requests/:id/assignment')
  async assignProvider(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') requestId: string,
    @Body() body: { providerId: string },
  ): Promise<ServiceRequest> {
    const actor = await this.requireStaff(authorization, [
      'admin',
      'dispatcher',
    ]);
    return this.appService.assignProvider(requestId, body.providerId, {
      staffId: actor.id,
      action: 'request.provider_assigned',
      subjectType: 'service_request',
      subjectId: requestId,
    });
  }

  @Post('service-requests/:id/quotes')
  async proposeQuote(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') requestId: string,
    @Body() body: { amountHalalas: number; scope: string },
  ): Promise<import('./app.service').ServiceQuote> {
    const actor = await this.requireStaff(authorization, [
      'admin',
      'dispatcher',
    ]);
    try {
      const quote = await this.appService.proposeQuote(
        requestId,
        body.amountHalalas,
        body.scope,
        {
          staffId: actor.id,
          action: 'request.quote_proposed',
          subjectType: 'service_request',
          subjectId: requestId,
        },
      );
      return quote;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message ===
          'Request is in the marketplace quote flow; staff quotes are not allowed'
      ) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  @Post('service-requests/:id/opportunities')
  async inviteProviders(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') requestId: string,
    @Body() body: unknown,
  ): Promise<ProviderOpportunity[]> {
    const actor = await this.requireStaff(authorization, [
      'admin',
      'dispatcher',
    ]);
    const providerIds = this.requiredProviderIds(body);
    const created = await this.appService.inviteProvidersToRequest(
      requestId,
      providerIds,
      {
        staffId: actor.id,
        action: 'request.opportunities_invited',
        subjectType: 'service_request',
        subjectId: requestId,
      },
    );
    return created;
  }

  @Delete('service-requests/:id/opportunities/:providerId')
  async closeProviderOpportunity(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') requestId: string,
    @Param('providerId') providerId: string,
  ): Promise<{ closed: boolean }> {
    const actor = await this.requireStaff(authorization, [
      'admin',
      'dispatcher',
    ]);
    const result = await this.appService.closeProviderOpportunity(
      requestId,
      providerId,
      {
        staffId: actor.id,
        action: 'request.opportunity_closed',
        subjectType: 'service_request',
        subjectId: requestId,
      },
    );
    return result;
  }

  @Post('service-requests/:id/payments/cash/collect')
  async collectCashPayment(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') requestId: string,
  ): Promise<import('./app.service').ServicePayment> {
    const actor = await this.requireStaff(authorization, [
      'admin',
      'dispatcher',
    ]);
    try {
      return await this.appService.collectCashPayment(requestId, {
        staffId: actor.id,
        action: 'payment.cash_collected',
        subjectType: 'service_request',
        subjectId: requestId,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        [
          'Cash payment not found',
          'Cash payment is not due',
          'Cash can only be collected after completion',
        ].includes(error.message)
      ) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  @Post('service-requests/:id/payments/cash/refund')
  async refundCashPayment(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') requestId: string,
  ): Promise<import('./app.service').ServicePayment> {
    const actor = await this.requireStaff(authorization, ['admin']);
    try {
      return await this.appService.refundCashPayment(requestId, {
        staffId: actor.id,
        action: 'payment.cash_refunded',
        subjectType: 'service_request',
        subjectId: requestId,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        [
          'Cash payment not found',
          'Cash payment is not eligible for refund',
        ].includes(error.message)
      ) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  @Patch('service-requests/:id/status')
  async updateStatus(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') requestId: string,
    @Body() body: { status: import('./app.service').ServiceRequestStatus },
  ): Promise<ServiceRequest> {
    const actor = await this.requireStaff(authorization, [
      'admin',
      'dispatcher',
    ]);
    try {
      return await this.appService.updateStatus(requestId, body.status, {
        staffId: actor.id,
        action: 'request.status_updated',
        subjectType: 'service_request',
        subjectId: requestId,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        [
          'Invalid status transition',
          'Quote approval required',
          'Provider must start tracking through the provider action',
        ].includes(error.message)
      ) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  @Get('service-requests/:id/history')
  async getServiceRequestEvents(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') requestId: string,
  ): Promise<import('./app.service').ServiceRequestEvent[]> {
    await this.requireStaff(authorization, ['admin', 'dispatcher']);
    return this.appService.getServiceRequestEvents(requestId);
  }

  @Get('service-requests/:id/provider-location')
  async getOperationsProviderCurrentPosition(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') requestId: string,
  ): Promise<import('./service-request.repository').ProviderCurrentPosition> {
    await this.requireStaff(authorization, ['admin', 'dispatcher']);
    const position =
      await this.appService.getOperationsProviderCurrentPosition(requestId);
    if (!position) throw new NotFoundException('Provider location not found');
    return position;
  }

  @Post('service-requests/:id/provider-location/stop')
  async stopOperationsProviderTracking(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') requestId: string,
  ): Promise<{ stopped: true }> {
    await this.requireStaff(authorization, ['admin']);
    try {
      await this.appService.stopProviderTrackingForOperations(requestId);
      return { stopped: true };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'Service request not found'
      ) {
        throw new NotFoundException(error.message);
      }
      if (
        error instanceof Error &&
        error.message === 'Provider tracking is not enabled'
      ) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  @Get('service-requests')
  async getServiceRequests(
    @Headers('authorization') authorization: string | undefined,
  ): Promise<ServiceRequest[]> {
    await this.requireStaff(authorization, ['admin', 'dispatcher']);
    return this.appService.getServiceRequests();
  }

  private clientIp(request: Request): string {
    const clientIp = request.ip ?? request.socket.remoteAddress;
    if (!clientIp) {
      throw new BadRequestException('Client IP address is required');
    }
    return clientIp.startsWith('::ffff:') ? clientIp.slice(7) : clientIp;
  }

  private requiredString(
    body: unknown,
    field: string,
    minimumLength: number,
    maximumLength: number,
  ): string {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new BadRequestException(`Invalid ${field}`);
    }
    const value = (body as Record<string, unknown>)[field];
    if (typeof value !== 'string') {
      throw new BadRequestException(`Invalid ${field}`);
    }
    const normalized = value.trim();
    if (
      normalized.length < minimumLength ||
      normalized.length > maximumLength
    ) {
      throw new BadRequestException(`Invalid ${field}`);
    }
    return normalized;
  }

  private requiredUuid(body: unknown, field: string): string {
    const value = this.requiredString(body, field, 36, 36);
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      )
    ) {
      throw new BadRequestException(`Invalid ${field}`);
    }
    return value;
  }

  private requiredOtpCode(body: unknown, field: string): string {
    const value = this.requiredSecretString(body, field, 4, 10);
    if (!/^\d+$/.test(value)) {
      throw new BadRequestException(`Invalid ${field}`);
    }
    return value;
  }

  private requiredSecretString(
    body: unknown,
    field: string,
    minimumLength: number,
    maximumLength: number,
  ): string {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new BadRequestException(`Invalid ${field}`);
    }
    const value = (body as Record<string, unknown>)[field];
    if (
      typeof value !== 'string' ||
      value.length < minimumLength ||
      value.length > maximumLength
    ) {
      throw new BadRequestException(`Invalid ${field}`);
    }
    return value;
  }

  private requiredProviderIds(body: unknown): string[] {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new BadRequestException('Invalid providerIds');
    }
    const value = (body as Record<string, unknown>).providerIds;
    if (
      !Array.isArray(value) ||
      value.some((item) => typeof item !== 'string')
    ) {
      throw new BadRequestException('providerIds must be an array of strings');
    }
    const trimmed = value.map((item) => (item as string).trim());
    if (trimmed.length === 0 || trimmed.every((item) => item === '')) {
      throw new BadRequestException('providerIds must not be empty');
    }
    return trimmed;
  }

  private requiredAmountHalalas(body: unknown): number {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new BadRequestException('Invalid amountHalalas');
    }
    const value = (body as Record<string, unknown>).amountHalalas;
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value <= 0
    ) {
      throw new BadRequestException('amountHalalas must be a positive integer');
    }
    return value;
  }

  private async requireStaff(
    authorization: string | undefined,
    allowedRoles: StaffRole[],
  ): Promise<StaffPrincipal> {
    const staff = await this.staffAuthService.getCurrentStaff(
      this.extractBearerToken(authorization),
    );
    if (!allowedRoles.includes(staff.role)) {
      throw new ForbiddenException('Insufficient staff permission');
    }
    return staff;
  }

  private extractBearerToken(authorization: string | undefined): string {
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) throw new UnauthorizedException('Bearer token required');
    return token;
  }
}

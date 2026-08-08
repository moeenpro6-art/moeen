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
} from '@nestjs/common';
import type { Request } from 'express';
import { AppService } from './app.service';
import type {
  CreateServiceRequest,
  LaunchService,
  ServiceRequest,
} from './app.service';
import { StaffAuditService } from './staff-audit.service';
import { CustomerAuthService } from './customer-auth.service';
import { ProviderAuthService } from './provider-auth.service';
import { PublicAuthRateLimiter } from './public-auth-rate-limiter.service';
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
  ): Promise<ServiceRequest[]> {
    const provider = await this.providerAuthService.getCurrentProvider(
      this.extractBearerToken(authorization),
    );
    return this.appService.getProviderServiceRequests(provider.id);
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
  ): Promise<ServiceRequest> {
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
        ['Invalid status transition', 'Quote approval required'].includes(
          error.message,
        )
      ) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
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
    const provider = await this.appService.registerPilotProvider(input);
    await this.staffAuditService.record(actor, {
      action: 'provider.pilot_registered',
      subjectType: 'provider',
      subjectId: provider.id,
      newState: {
        verificationStatus: provider.verificationStatus,
        serviceZone: provider.serviceZone,
      },
    });
    return provider;
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
    await this.staffAuditService.record(actor, {
      action: 'provider.access_code_rotated',
      subjectType: 'provider',
      subjectId: providerId,
      newState: { accessCodeRotated: true },
    });
  }

  @Patch('providers/:providerId/verification')
  async verifyPilotProvider(
    @Headers('authorization') authorization: string | undefined,
    @Param('providerId') providerId: string,
  ): Promise<import('./app.service').PilotProvider> {
    const actor = await this.requireStaff(authorization, ['admin']);
    const currentProvider = (await this.appService.getProviders()).find(
      (provider) => provider.id === providerId,
    );
    if (!currentProvider || currentProvider.verificationStatus !== 'pending') {
      throw new NotFoundException('Pending pilot provider not found');
    }
    const provider = await this.appService.verifyPilotProvider(providerId);
    await this.staffAuditService.record(actor, {
      action: 'provider.pilot_verified',
      subjectType: 'provider',
      subjectId: provider.id,
      oldState: {
        verificationStatus: currentProvider.verificationStatus,
        available: currentProvider.available,
      },
      newState: {
        verificationStatus: provider.verificationStatus,
        available: provider.available,
      },
    });
    return provider;
  }

  @Patch('providers/:providerId/suspension')
  async suspendPilotProvider(
    @Headers('authorization') authorization: string | undefined,
    @Param('providerId') providerId: string,
  ): Promise<import('./app.service').PilotProvider> {
    const actor = await this.requireStaff(authorization, ['admin']);
    const currentProvider = (await this.appService.getProviders()).find(
      (provider) => provider.id === providerId,
    );
    if (!currentProvider || currentProvider.verificationStatus !== 'verified') {
      throw new NotFoundException('Verified pilot provider not found');
    }
    const provider = await this.appService.suspendPilotProvider(providerId);
    await this.staffAuditService.record(actor, {
      action: 'provider.pilot_suspended',
      subjectType: 'provider',
      subjectId: provider.id,
      oldState: {
        verificationStatus: currentProvider.verificationStatus,
        available: currentProvider.available,
      },
      newState: {
        verificationStatus: provider.verificationStatus,
        available: provider.available,
      },
    });
    return provider;
  }

  @Patch('providers/:providerId/reactivation')
  async reactivatePilotProvider(
    @Headers('authorization') authorization: string | undefined,
    @Param('providerId') providerId: string,
  ): Promise<import('./app.service').PilotProvider> {
    const actor = await this.requireStaff(authorization, ['admin']);
    const currentProvider = (await this.appService.getProviders()).find(
      (provider) => provider.id === providerId,
    );
    if (
      !currentProvider ||
      currentProvider.verificationStatus !== 'suspended'
    ) {
      throw new NotFoundException('Suspended pilot provider not found');
    }
    const provider = await this.appService.reactivatePilotProvider(providerId);
    await this.staffAuditService.record(actor, {
      action: 'provider.pilot_reactivated',
      subjectType: 'provider',
      subjectId: provider.id,
      oldState: {
        verificationStatus: currentProvider.verificationStatus,
        available: currentProvider.available,
      },
      newState: {
        verificationStatus: provider.verificationStatus,
        available: provider.available,
      },
    });
    return provider;
  }

  @Post('service-requests')
  createServiceRequest(
    @Headers('authorization') authorization: string | undefined,
    @Body() request: CreateServiceRequest,
  ): Promise<ServiceRequest> {
    return this.appService.createMyServiceRequest(
      this.extractBearerToken(authorization),
      request,
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
    const previous = (await this.appService.getSupportTickets()).find(
      (ticket) => ticket.id === ticketId,
    );
    const updated = await this.appService.updateSupportTicketStatus(
      ticketId,
      body.status,
    );
    await this.staffAuditService.record(actor, {
      action: 'support_ticket.status_updated',
      subjectType: 'support_ticket',
      subjectId: ticketId,
      oldState: { status: previous?.status ?? null },
      newState: { status: updated.status },
    });
    return updated;
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
    const previous = (await this.appService.getServiceRequests()).find(
      (request) => request.id === requestId,
    );
    const updated = await this.appService.assignProvider(
      requestId,
      body.providerId,
    );
    await this.staffAuditService.record(actor, {
      action: 'request.provider_assigned',
      subjectType: 'service_request',
      subjectId: requestId,
      oldState: {
        status: previous?.status ?? null,
        providerId: previous?.assignedProvider?.id ?? null,
      },
      newState: {
        status: updated.status,
        providerId: updated.assignedProvider?.id ?? body.providerId,
      },
    });
    return updated;
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
      );
      await this.staffAuditService.record(actor, {
        action: 'request.quote_proposed',
        subjectType: 'service_request',
        subjectId: requestId,
        newState: {
          quoteStatus: quote.status,
          amountHalalas: quote.amountHalalas,
        },
      });
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
    );
    await this.staffAuditService.record(actor, {
      action: 'request.opportunities_invited',
      subjectType: 'service_request',
      subjectId: requestId,
      newState: {
        invitedProviderIds: created.map((item) => item.requestId),
      },
    });
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
    );
    await this.staffAuditService.record(actor, {
      action: 'request.opportunity_closed',
      subjectType: 'service_request',
      subjectId: requestId,
      newState: { providerId, closed: result.closed },
    });
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
      const payment = await this.appService.collectCashPayment(requestId);
      await this.staffAuditService.record(actor, {
        action: 'payment.cash_collected',
        subjectType: 'service_request',
        subjectId: requestId,
        newState: {
          paymentId: payment.id,
          method: payment.method,
          status: payment.status,
          amountHalalas: payment.amountHalalas,
          currency: payment.currency,
        },
      });
      return payment;
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
      const payment = await this.appService.refundCashPayment(requestId);
      await this.staffAuditService.record(actor, {
        action: 'payment.cash_refunded',
        subjectType: 'service_request',
        subjectId: requestId,
        newState: {
          paymentId: payment.id,
          method: payment.method,
          status: payment.status,
          amountHalalas: payment.amountHalalas,
          currency: payment.currency,
        },
      });
      return payment;
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
    const previous = (await this.appService.getServiceRequests()).find(
      (request) => request.id === requestId,
    );
    let updated: ServiceRequest;
    try {
      updated = await this.appService.updateStatus(requestId, body.status);
    } catch (error) {
      if (
        error instanceof Error &&
        ['Invalid status transition', 'Quote approval required'].includes(
          error.message,
        )
      ) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
    await this.staffAuditService.record(actor, {
      action: 'request.status_updated',
      subjectType: 'service_request',
      subjectId: requestId,
      oldState: { status: previous?.status ?? null },
      newState: { status: updated.status },
    });
    return updated;
  }

  @Get('service-requests/:id/history')
  async getServiceRequestEvents(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') requestId: string,
  ): Promise<import('./app.service').ServiceRequestEvent[]> {
    await this.requireStaff(authorization, ['admin', 'dispatcher']);
    return this.appService.getServiceRequestEvents(requestId);
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

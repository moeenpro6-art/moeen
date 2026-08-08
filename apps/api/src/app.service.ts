import {
  Inject,
  Injectable,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { ServiceRequestRepository } from './service-request.repository';

export type LaunchService = {
  id: string;
  nameAr: string;
};

export type CreateServiceRequest = {
  serviceId: string;
  address: string;
  details?: string;
  timing: 'as-soon-as-possible' | 'scheduled';
};

const launchServiceIds = new Set([
  'ac-cleaning',
  'upholstery',
  'home-cleaning',
  'tank-cleaning',
  'plumbing',
]);
const requestTimings = new Set<CreateServiceRequest['timing']>([
  'as-soon-as-possible',
  'scheduled',
]);

export function validateCreateServiceRequest(
  input: unknown,
): CreateServiceRequest {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BadRequestException('Invalid service request');
  }

  const candidate = input as Record<string, unknown>;
  const serviceId = candidate.serviceId;
  const address = candidate.address;
  const timing = candidate.timing;
  const details = candidate.details;

  if (
    typeof serviceId !== 'string' ||
    !launchServiceIds.has(serviceId) ||
    typeof address !== 'string' ||
    address.trim().length < 3 ||
    address.trim().length > 240 ||
    typeof timing !== 'string' ||
    !requestTimings.has(timing as CreateServiceRequest['timing']) ||
    (details !== undefined &&
      (typeof details !== 'string' || details.trim().length > 1000))
  ) {
    throw new BadRequestException('Invalid service request');
  }

  const normalizedDetails = details?.trim();
  return {
    serviceId,
    address: address.trim(),
    timing: timing as CreateServiceRequest['timing'],
    ...(normalizedDetails ? { details: normalizedDetails } : {}),
  };
}

export type ServiceRequestStatus =
  | 'pending_dispatch'
  | 'assigned'
  | 'on_the_way'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

export type ServiceRequestEventType =
  | 'request_created'
  | 'provider_assigned'
  | 'status_updated'
  | 'quote_proposed'
  | 'quote_approved'
  | 'quote_rejected';

export type ServiceRequestEvent = {
  type: ServiceRequestEventType;
  status: ServiceRequestStatus;
  createdAt: string;
};

export type ServiceQuoteStatus =
  'proposed' | 'approved' | 'rejected' | 'withdrawn';

export type ServiceQuote = {
  id: string;
  providerId?: string;
  amountHalalas: number;
  scope: string;
  status: ServiceQuoteStatus;
  proposedAt: string;
  decidedAt?: string;
};

export type ProviderOpportunityStatus =
  'invited' | 'quoted' | 'withdrawn' | 'closed';

export type ProviderOpportunity = {
  requestId: string;
  serviceId: string;
  timing: ServiceRequest['timing'];
  opportunityStatus: ProviderOpportunityStatus;
  myQuote?: ServiceQuote;
};

export type CustomerQuoteProviderSummary = {
  name: string;
  averageRating: number | null;
  ratingCount: number;
};

export type CustomerQuoteView = {
  id: string;
  amountHalalas?: number;
  scope?: string;
  status: ServiceQuoteStatus;
  proposedAt?: string;
  decidedAt?: string;
  providerSummary?: CustomerQuoteProviderSummary;
};

export type ServicePaymentMethod = 'cash_on_completion' | 'paymob';
export type ServicePaymentStatus =
  | 'cash_due'
  | 'cash_collected'
  | 'checkout_created'
  | 'paid'
  | 'failed'
  | 'refund_pending'
  | 'refunded';

export type ServicePayment = {
  id: string;
  amountHalalas: number;
  currency: 'SAR';
  method: ServicePaymentMethod;
  status: ServicePaymentStatus;
  createdAt: string;
  collectedAt?: string;
  refundedAt?: string;
};

export type ServiceRequest = CreateServiceRequest & {
  id: string;
  status: ServiceRequestStatus;
  assignedProvider?: Provider;
  quote?: ServiceQuote;
  quotes?: CustomerQuoteView[];
  payment?: ServicePayment;
  rating?: number;
  ratingComment?: string;
  createdAt: string;
};

export type Provider = {
  id: string;
  name: string;
  specialties: string[];
  available: boolean;
};

export type ProviderAppPrincipal = {
  id: string;
  name: string;
  specialties: string[];
  serviceZone: string;
  available: boolean;
};

export type PilotProviderVerificationStatus =
  'pending' | 'verified' | 'suspended';

export type PilotProvider = Provider & {
  serviceZone: string;
  verificationStatus: PilotProviderVerificationStatus;
};

export type CreatePilotProvider = {
  name: string;
  specialties: string[];
  serviceZone: string;
};

export type Customer = { id: string; phone: string };

export type SupportCategory =
  'no_show' | 'price' | 'quality' | 'payment' | 'other';
export type SupportTicketStatus = 'open' | 'in_progress' | 'resolved';
export type SupportTicket = {
  id: string;
  requestId: string;
  category: SupportCategory;
  comment: string;
  status: SupportTicketStatus;
  createdAt: string;
};

export interface ServiceRequestStore {
  create(
    input: CreateServiceRequest,
    customerId: string,
  ): Promise<ServiceRequest>;
  findAll(): Promise<ServiceRequest[]>;
  findByCustomerId(customerId: string): Promise<ServiceRequest[]>;
  findByProviderId(providerId: string): Promise<ServiceRequest[]>;
  findRequestEvents(requestId: string): Promise<ServiceRequestEvent[]>;
  findCustomerBySession(token: string): Promise<Customer | undefined>;
  findProviderByAccessCode(
    accessCode: string,
  ): Promise<ProviderAppPrincipal | undefined>;
  findProviderBySession(
    token: string,
  ): Promise<ProviderAppPrincipal | undefined>;
  setProviderAccessCode(providerId: string, accessCode: string): Promise<void>;
  createProviderSession(providerId: string, token: string): Promise<void>;
  revokeProviderSession(token: string): Promise<void>;
  updateProviderAvailability(
    providerId: string,
    available: boolean,
  ): Promise<ProviderAppPrincipal>;
  findProviders(): Promise<PilotProvider[]>;
  createPilotProvider(input: CreatePilotProvider): Promise<PilotProvider>;
  updatePilotProviderVerification(
    providerId: string,
    verificationStatus: PilotProviderVerificationStatus,
  ): Promise<PilotProvider>;
  assignProvider(
    requestId: string,
    providerId: string,
  ): Promise<ServiceRequest>;
  updateStatus(
    requestId: string,
    status: ServiceRequestStatus,
  ): Promise<ServiceRequest>;
  updateStatusForProvider(
    requestId: string,
    providerId: string,
    status: Extract<
      ServiceRequestStatus,
      'on_the_way' | 'in_progress' | 'completed'
    >,
  ): Promise<ServiceRequest>;
  proposeQuote(
    requestId: string,
    amountHalalas: number,
    scope: string,
  ): Promise<ServiceQuote>;
  decideQuote(
    requestId: string,
    customerId: string,
    quoteId: string,
    decision: Exclude<ServiceQuoteStatus, 'proposed'>,
  ): Promise<ServiceQuote>;
  inviteProvidersToRequest(
    requestId: string,
    providerIds: string[],
  ): Promise<ProviderOpportunity[]>;
  listProviderOpportunities(providerId: string): Promise<ProviderOpportunity[]>;
  submitProviderQuote(
    requestId: string,
    providerId: string,
    amountHalalas: number,
    scope: string,
  ): Promise<ServiceQuote>;
  withdrawProviderQuote(
    quoteId: string,
    providerId: string,
  ): Promise<ServiceQuote>;
  closeProviderOpportunity(
    requestId: string,
    providerId: string,
  ): Promise<{ closed: boolean }>;
  collectCashPayment(requestId: string): Promise<ServicePayment>;
  refundCashPayment(requestId: string): Promise<ServicePayment>;
  rateRequest(
    requestId: string,
    customerId: string,
    rating: number,
    comment?: string,
  ): Promise<ServiceRequest>;
  createSupportTicket(
    requestId: string,
    customerId: string,
    category: SupportCategory,
    comment: string,
  ): Promise<SupportTicket>;
  findSupportTickets(): Promise<SupportTicket[]>;
  updateSupportTicketStatus(
    ticketId: string,
    status: SupportTicketStatus,
  ): Promise<SupportTicket>;
  upsertCustomer(phone: string): Promise<Customer>;
  createCustomerSession(customerId: string, token: string): Promise<void>;
}

@Injectable()
export class AppService {
  constructor(
    @Inject(ServiceRequestRepository)
    private readonly serviceRequestStore: ServiceRequestStore,
  ) {}

  getHello(): string {
    return 'Moeen API is running';
  }

  getLaunchServices(): LaunchService[] {
    return [
      { id: 'ac-cleaning', nameAr: 'تنظيف المكيفات' },
      { id: 'upholstery', nameAr: 'غسيل الكنب والمجالس' },
      { id: 'home-cleaning', nameAr: 'تنظيف المنازل' },
      { id: 'tank-cleaning', nameAr: 'تنظيف الخزانات' },
      { id: 'plumbing', nameAr: 'سباكة وتسربات' },
    ];
  }

  async createMyServiceRequest(
    token: string,
    input: unknown,
  ): Promise<ServiceRequest> {
    const customer = await this.getCustomerForToken(token);
    return this.serviceRequestStore.create(
      validateCreateServiceRequest(input),
      customer.id,
    );
  }

  getServiceRequests(): Promise<ServiceRequest[]> {
    return this.serviceRequestStore.findAll();
  }

  async getMyServiceRequests(token: string): Promise<ServiceRequest[]> {
    const customer =
      await this.serviceRequestStore.findCustomerBySession(token);
    if (!customer) throw new UnauthorizedException('Unauthorized');
    return this.serviceRequestStore.findByCustomerId(customer.id);
  }

  async getMyServiceRequestEvents(
    token: string,
    requestId: string,
  ): Promise<ServiceRequestEvent[]> {
    const customer = await this.getCustomerForToken(token);
    const request = (
      await this.serviceRequestStore.findByCustomerId(customer.id)
    ).find((item) => item.id === requestId);
    if (!request) throw new Error('Customer request not found');
    return this.serviceRequestStore.findRequestEvents(requestId);
  }

  async getServiceRequestEvents(
    requestId: string,
  ): Promise<ServiceRequestEvent[]> {
    const request = (await this.getServiceRequests()).find(
      (item) => item.id === requestId,
    );
    if (!request) throw new Error('Service request not found');
    return this.serviceRequestStore.findRequestEvents(requestId);
  }

  async rateMyServiceRequest(
    token: string,
    requestId: string,
    rating: number,
    comment?: string,
  ): Promise<ServiceRequest> {
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new Error('Rating must be an integer from 1 to 5');
    }
    const customer = await this.getCustomerForToken(token);
    return this.serviceRequestStore.rateRequest(
      requestId,
      customer.id,
      rating,
      comment?.trim() || undefined,
    );
  }

  async createMySupportTicket(
    token: string,
    requestId: string,
    category: SupportCategory,
    comment: string,
  ): Promise<SupportTicket> {
    const allowedCategories = new Set<SupportCategory>([
      'no_show',
      'price',
      'quality',
      'payment',
      'other',
    ]);
    const normalizedComment = comment.trim();
    if (!allowedCategories.has(category) || normalizedComment.length < 3) {
      throw new Error('Invalid support ticket');
    }
    const customer = await this.getCustomerForToken(token);
    return this.serviceRequestStore.createSupportTicket(
      requestId,
      customer.id,
      category,
      normalizedComment,
    );
  }

  getSupportTickets(): Promise<SupportTicket[]> {
    return this.serviceRequestStore.findSupportTickets();
  }

  updateSupportTicketStatus(
    ticketId: string,
    status: SupportTicketStatus,
  ): Promise<SupportTicket> {
    if (!['in_progress', 'resolved'].includes(status)) {
      throw new Error('Unsupported support ticket status');
    }
    return this.serviceRequestStore.updateSupportTicketStatus(ticketId, status);
  }

  getProviders(): Promise<PilotProvider[]> {
    return this.serviceRequestStore.findProviders();
  }

  async registerPilotProvider(
    input: CreatePilotProvider,
  ): Promise<PilotProvider> {
    const name = input.name.trim();
    const serviceZone = input.serviceZone.trim();
    const launchServiceIds = new Set(
      this.getLaunchServices().map((service) => service.id),
    );
    const specialties = [...new Set(input.specialties)].filter((specialty) =>
      launchServiceIds.has(specialty),
    );
    if (name.length < 2 || serviceZone.length < 2 || specialties.length === 0) {
      throw new Error('Invalid pilot provider');
    }
    return this.serviceRequestStore.createPilotProvider({
      name,
      specialties,
      serviceZone,
    });
  }

  async verifyPilotProvider(providerId: string): Promise<PilotProvider> {
    if (!providerId.startsWith('PILOT-')) {
      throw new Error('Invalid pilot provider');
    }
    return this.serviceRequestStore.updatePilotProviderVerification(
      providerId,
      'verified',
    );
  }

  async suspendPilotProvider(providerId: string): Promise<PilotProvider> {
    if (!providerId.startsWith('PILOT-')) {
      throw new Error('Invalid pilot provider');
    }
    return this.serviceRequestStore.updatePilotProviderVerification(
      providerId,
      'suspended',
    );
  }

  async reactivatePilotProvider(providerId: string): Promise<PilotProvider> {
    if (!providerId.startsWith('PILOT-')) {
      throw new Error('Invalid pilot provider');
    }
    return this.serviceRequestStore.updatePilotProviderVerification(
      providerId,
      'verified',
    );
  }

  async setPilotProviderAccessCode(
    providerId: string,
    accessCode: string,
  ): Promise<void> {
    if (providerId.trim().length < 3 || accessCode.trim().length < 16) {
      throw new Error('Invalid provider access code');
    }
    await this.serviceRequestStore.setProviderAccessCode(
      providerId,
      accessCode.trim(),
    );
  }

  getProviderServiceRequests(providerId: string): Promise<ServiceRequest[]> {
    return this.serviceRequestStore.findByProviderId(providerId);
  }

  updateProviderServiceRequestStatus(
    providerId: string,
    requestId: string,
    status: Extract<
      ServiceRequestStatus,
      'on_the_way' | 'in_progress' | 'completed'
    >,
  ): Promise<ServiceRequest> {
    return this.serviceRequestStore.updateStatusForProvider(
      requestId,
      providerId,
      status,
    );
  }

  assignProvider(
    requestId: string,
    providerId: string,
  ): Promise<ServiceRequest> {
    return this.serviceRequestStore.assignProvider(requestId, providerId);
  }

  updateStatus(
    requestId: string,
    status: ServiceRequestStatus,
  ): Promise<ServiceRequest> {
    return this.serviceRequestStore.updateStatus(requestId, status);
  }

  async proposeQuote(
    requestId: string,
    amountHalalas: number,
    scope: string,
  ): Promise<ServiceQuote> {
    const normalizedScope = scope.trim();
    if (
      !Number.isInteger(amountHalalas) ||
      amountHalalas <= 0 ||
      normalizedScope.length < 3
    ) {
      throw new Error('Invalid quote');
    }
    return this.serviceRequestStore.proposeQuote(
      requestId,
      amountHalalas,
      normalizedScope,
    );
  }

  async inviteProvidersToRequest(
    requestId: string,
    providerIds: unknown,
  ): Promise<ProviderOpportunity[]> {
    return this.serviceRequestStore.inviteProvidersToRequest(
      requestId,
      this.normalizeProviderInvitationIds(providerIds),
    );
  }

  private normalizeProviderInvitationIds(providerIds: unknown): string[] {
    if (!Array.isArray(providerIds)) {
      throw new Error('Provider invitation list must be an array');
    }
    const normalized = providerIds.map((providerId) => {
      if (typeof providerId !== 'string') {
        throw new Error(
          'Provider invitation list must contain only provider ids',
        );
      }
      return providerId.trim();
    });
    const uniqueProviderIds = [...new Set(normalized)];
    if (uniqueProviderIds.length === 0) {
      throw new Error('Provider invitation list is empty');
    }
    return uniqueProviderIds;
  }

  getProviderOpportunities(providerId: string): Promise<ProviderOpportunity[]> {
    return this.serviceRequestStore.listProviderOpportunities(providerId);
  }

  async submitProviderQuote(
    providerId: string,
    requestId: string,
    amountHalalas: number,
    scope: string,
  ): Promise<ServiceQuote> {
    const normalizedScope = scope.trim();
    if (
      !Number.isSafeInteger(amountHalalas) ||
      amountHalalas <= 0 ||
      normalizedScope.length < 3
    ) {
      throw new Error('Invalid quote');
    }
    return this.serviceRequestStore.submitProviderQuote(
      requestId,
      providerId,
      amountHalalas,
      normalizedScope,
    );
  }

  withdrawProviderQuote(
    providerId: string,
    quoteId: string,
  ): Promise<ServiceQuote> {
    return this.serviceRequestStore.withdrawProviderQuote(quoteId, providerId);
  }

  closeProviderOpportunity(
    requestId: string,
    providerId: string,
  ): Promise<{ closed: boolean }> {
    return this.serviceRequestStore.closeProviderOpportunity(
      requestId,
      providerId,
    );
  }

  async collectCashPayment(requestId: string): Promise<ServicePayment> {
    if (!/^MOE-\d+$/.test(requestId)) {
      throw new Error('Invalid service request');
    }
    return this.serviceRequestStore.collectCashPayment(requestId);
  }

  async refundCashPayment(requestId: string): Promise<ServicePayment> {
    if (!/^MOE-\d+$/.test(requestId)) {
      throw new Error('Invalid service request');
    }
    return this.serviceRequestStore.refundCashPayment(requestId);
  }

  async decideMyQuote(
    token: string,
    requestId: string,
    quoteId: string,
    decision: Exclude<ServiceQuoteStatus, 'proposed'>,
  ): Promise<ServiceQuote> {
    if (!['approved', 'rejected'].includes(decision)) {
      throw new Error('Invalid quote decision');
    }
    const customer = await this.getCustomerForToken(token);
    const quote = await this.serviceRequestStore.decideQuote(
      requestId,
      customer.id,
      quoteId,
      decision,
    );
    // Customer-facing responses never reveal which provider owns a quote;
    // only the whitelisted quote fields are returned (approved and rejected).
    return {
      id: quote.id,
      amountHalalas: quote.amountHalalas,
      scope: quote.scope,
      status: quote.status,
      proposedAt: quote.proposedAt,
      decidedAt: quote.decidedAt,
    };
  }

  private async getCustomerForToken(token: string): Promise<Customer> {
    const customer =
      await this.serviceRequestStore.findCustomerBySession(token);
    if (!customer) throw new UnauthorizedException('Unauthorized');
    return customer;
  }
}

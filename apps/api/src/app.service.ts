import {
  Inject,
  Injectable,
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { ServiceRequestRepository } from './service-request.repository';
import type { StaffAuditSpec } from './staff-auth.repository';
import {
  RequestImageCreateOrchestrator,
  RequestSubmissionConflictError,
  RequestSubmissionReplayError,
  type CreateServiceRequestMultipartResult,
  type ServiceRequestMultipartInput,
  type ServiceRequestSubmissionContext,
} from './request-image-create.contracts';
import { RequestImageService } from './request-image.service';
import type {
  RequestImageDto,
  StoredRequestImage,
} from './request-image.types';

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
  | 'quote_rejected'
  | 'opportunity_invited'
  | 'opportunity_closed'
  | 'provider_quote_submitted'
  | 'provider_quote_withdrawn';

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
  providerName?: string;
  amountHalalas: number;
  scope: string;
  status: ServiceQuoteStatus;
  proposedAt: string;
  decidedAt?: string;
};

export type ServiceOpportunitySummary = {
  invited: number;
  quoted: number;
  withdrawn: number;
  closed: number;
  rejected: number;
  total: number;
};

export type ProviderOpportunityStatus =
  'invited' | 'quoted' | 'withdrawn' | 'closed' | 'rejected';

/**
 * Public, pre-assignment-safe provider opportunity projection. `address`,
 * `details` and `images` are present ONLY when the authenticated provider
 * owns the opportunity and it is in an actually eligible/current state
 * (`invited`/`quoted` while the request is still `pending_dispatch`);
 * terminal opportunities (withdrawn/closed/rejected) and non-pending
 * requests never carry them. Customer identity/contact fields are never
 * part of this shape.
 */
export type ProviderOpportunity = {
  requestId: string;
  serviceId: string;
  timing: ServiceRequest['timing'];
  opportunityStatus: ProviderOpportunityStatus;
  myQuote?: ServiceQuote;
  address?: string;
  details?: string;
  images?: RequestImageDto[];
};

/**
 * Store-level opportunity read: the server-side projection used to decide
 * pre-quote eligibility. `requestStatus` is an authorization input, never a
 * client value, and is stripped before anything reaches a client.
 */
export type ProviderOpportunityAccess = ProviderOpportunity & {
  requestStatus?: ServiceRequestStatus;
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
  opportunities?: ServiceOpportunitySummary;
  payment?: ServicePayment;
  rating?: number;
  ratingComment?: string;
  images?: RequestImageDto[];
  /**
   * Post-assignment customer contact disclosure. Present ONLY on the
   * assigned-provider read path while the request is in an active lifecycle
   * state (`assigned` / `on_the_way` / `in_progress`) and the authenticated
   * provider is the assigned provider (`service_requests.assigned_provider_id`).
   * Never present in opportunity, customer, staff, or terminal-state reads,
   * and never set from any client-supplied value.
   */
  customerPhone?: string;
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
    submission?: ServiceRequestSubmissionContext,
    images?: StoredRequestImage[],
  ): Promise<ServiceRequest>;
  findRequestByCustomerSubmission(
    customerId: string,
    clientSubmissionId: string,
  ): Promise<ServiceRequest | undefined>;
  findRequestImages(requestId: string): Promise<StoredRequestImage[]>;
  findRequestImagesByRequestIds(
    requestIds: string[],
  ): Promise<Map<string, StoredRequestImage[]>>;
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
  setProviderAccessCode(
    providerId: string,
    accessCode: string,
    audit?: StaffAuditSpec,
  ): Promise<void>;
  createProviderSession(providerId: string, token: string): Promise<void>;
  revokeProviderSession(token: string): Promise<void>;
  updateProviderAvailability(
    providerId: string,
    available: boolean,
  ): Promise<ProviderAppPrincipal>;
  findProviders(): Promise<PilotProvider[]>;
  createPilotProvider(
    input: CreatePilotProvider,
    audit?: StaffAuditSpec,
  ): Promise<PilotProvider>;
  updatePilotProviderVerification(
    providerId: string,
    verificationStatus: PilotProviderVerificationStatus,
    audit?: StaffAuditSpec,
    expectedCurrentStatus?: PilotProviderVerificationStatus,
  ): Promise<PilotProvider>;
  assignProvider(
    requestId: string,
    providerId: string,
    audit?: StaffAuditSpec,
  ): Promise<ServiceRequest>;
  updateStatus(
    requestId: string,
    status: ServiceRequestStatus,
    audit?: StaffAuditSpec,
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
    audit?: StaffAuditSpec,
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
    audit?: StaffAuditSpec,
  ): Promise<ProviderOpportunity[]>;
  listProviderOpportunities(
    providerId: string,
  ): Promise<ProviderOpportunityAccess[]>;
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
    audit?: StaffAuditSpec,
  ): Promise<{ closed: boolean }>;
  collectCashPayment(
    requestId: string,
    audit?: StaffAuditSpec,
  ): Promise<ServicePayment>;
  refundCashPayment(
    requestId: string,
    audit?: StaffAuditSpec,
  ): Promise<ServicePayment>;
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
    audit?: StaffAuditSpec,
  ): Promise<SupportTicket>;
  upsertCustomer(phone: string): Promise<Customer>;
  createCustomerSession(customerId: string, token: string): Promise<void>;
}

@Injectable()
export class AppService {
  constructor(
    @Inject(ServiceRequestRepository)
    private readonly serviceRequestStore: ServiceRequestStore,
    private readonly requestImageService: RequestImageService = undefined as never,
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
    return this.createAuthenticatedServiceRequest(customer, input);
  }

  createAuthenticatedServiceRequest(
    customer: Customer,
    input: unknown,
  ): Promise<ServiceRequest> {
    return this.serviceRequestStore.create(
      validateCreateServiceRequest(input),
      customer.id,
    );
  }

  /**
   * Multipart creation with server-canonicalized images and atomic
   * idempotency (Slice 2B).
   *
   * Execution order is fixed so that an authenticated-only flow is followed
   * by strictly bounded, compensating work:
   *
   *   1. canonicalize (decode/resize/hash — rejects invalid or excessive
   *      inputs before anything is uploaded),
   *   2. compute the content fingerprint over normalized fields + ordered
   *      image hashes,
   *   3. upload canonical objects to storage (best-effort compensation
   *      deletes them if anything later fails),
   *   4. persist the request row, submission idempotency columns and image
   *      metadata in ONE repository transaction (unique-index arbitration:
   *      same key + same content replays the committed request, same key +
   *      different content conflicts with 409),
   *   5. sign and return image DTOs only for committed images.
   *
   * Uploaded objects are compensated only while the repository transaction
   * has NOT committed (database failure, idempotency conflict, replay of an
   * already-committed submission): in those paths create() rejects and every
   * object uploaded for that attempt is an orphan. Once the create
   * transaction resolves it has committed and the committed rows own the
   * uploaded objects — a later failure (such as signing DTOs) propagates
   * without deleting them, and a retry with the same Idempotency-Key
   * replays the committed request and image metadata.
   */
  async createAuthenticatedServiceRequestWithImages(
    customer: Customer,
    input: ServiceRequestMultipartInput,
    idempotencyKey: string,
  ): Promise<ServiceRequest & CreateServiceRequestMultipartResult> {
    const orchestrator = this.imageOrchestrator();
    const canonical = await orchestrator.canonicalizeImages(input.images);
    const createInput = {
      serviceId: input.serviceId,
      address: input.address,
      details: input.details,
      timing: input.timing,
    };
    const submissionFingerprint = await orchestrator.computeFingerprint(
      createInput,
      canonical,
    );
    const uploadedKeys = await orchestrator.uploadImages(canonical);
    const submission: ServiceRequestSubmissionContext = {
      clientSubmissionId: idempotencyKey,
      submissionFingerprint,
    };
    const storedImages = canonical.map((image) => ({
      id: image.id,
      storageKey: image.storageKey,
      mimeType: image.mimeType,
      byteSize: image.byteSize,
      contentSha256: image.contentSha256,
      sortOrder: image.sortOrder,
    }));
    let created: ServiceRequest;
    try {
      created = await this.serviceRequestStore.create(
        createInput,
        customer.id,
        submission,
        storedImages,
      );
    } catch (error) {
      // Compensation is scoped to the un-committed create attempt only:
      // create() rejects before COMMIT on database failure, idempotency
      // conflict, and replay paths, so every object uploaded for THIS
      // attempt is an orphan that must be removed. Objects owned by a
      // committed (winner) request are never deleted here.
      await this.compensateUploadedObjects(uploadedKeys);
      if (error instanceof RequestSubmissionReplayError) {
        const original =
          await this.serviceRequestStore.findRequestByCustomerSubmission(
            customer.id,
            idempotencyKey,
          );
        if (!original) throw error;
        const committedImages =
          await this.serviceRequestStore.findRequestImages(original.id);
        const images =
          committedImages.length > 0
            ? await orchestrator.toPublicDtos(committedImages)
            : undefined;
        return images ? { ...original, images } : original;
      }
      if (error instanceof RequestSubmissionConflictError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }

    // create() resolved: the transaction COMMITTED and the committed
    // service_request_images rows now own the uploaded objects. Failures
    // after this point (e.g. DTO signing) propagate normally WITHOUT
    // compensation, and a retry with the same Idempotency-Key replays the
    // committed request and image metadata.
    const images =
      canonical.length > 0
        ? await orchestrator.toPublicDtos(storedImages)
        : undefined;
    return images ? { ...created, images } : created;
  }

  /**
   * Test-friendly access to the image orchestration pipeline. The
   * orchestrator is stateless; a fresh instance is built per call from the
   * injected {@link RequestImageService} so no state can leak between
   * requests.
   */
  private imageOrchestrator(): RequestImageCreateOrchestrator {
    return new RequestImageCreateOrchestrator(
      (files) => this.requestImageService.canonicalize(files),
      (request, orderedContentHashes) =>
        this.requestImageService.fingerprint(request, orderedContentHashes),
      (images) => this.requestImageService.upload(images),
      (keys) => this.requestImageService.deleteBestEffort(keys),
      (images) => this.requestImageService.toDtos(images),
    );
  }

  /**
   * Compensating object cleanup that can never mask the primary failure.
   */
  private async compensateUploadedObjects(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await this.imageOrchestrator().cleanUploadedObjects(keys);
    } catch {
      // A scheduled reconciliation command reports exact unreferenced keys.
    }
  }

  async getServiceRequests(): Promise<ServiceRequest[]> {
    const requests = await this.serviceRequestStore.findAll();
    return this.attachImagesToRequests(requests);
  }

  async getMyServiceRequests(token: string): Promise<ServiceRequest[]> {
    const customer =
      await this.serviceRequestStore.findCustomerBySession(token);
    if (!customer) throw new UnauthorizedException('Unauthorized');
    const requests = await this.serviceRequestStore.findByCustomerId(
      customer.id,
    );
    return this.attachImagesToRequests(requests);
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
    audit?: StaffAuditSpec,
  ): Promise<SupportTicket> {
    if (!['in_progress', 'resolved'].includes(status)) {
      throw new Error('Unsupported support ticket status');
    }
    return this.serviceRequestStore.updateSupportTicketStatus(
      ticketId,
      status,
      audit,
    );
  }

  getProviders(): Promise<PilotProvider[]> {
    return this.serviceRequestStore.findProviders();
  }

  async registerPilotProvider(
    input: CreatePilotProvider,
    audit?: StaffAuditSpec,
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
    return this.serviceRequestStore.createPilotProvider(
      {
        name,
        specialties,
        serviceZone,
      },
      audit,
    );
  }

  async verifyPilotProvider(
    providerId: string,
    audit?: StaffAuditSpec,
  ): Promise<PilotProvider> {
    if (!providerId.startsWith('PILOT-')) {
      throw new Error('Invalid pilot provider');
    }
    return this.serviceRequestStore.updatePilotProviderVerification(
      providerId,
      'verified',
      audit,
      'pending',
    );
  }

  async suspendPilotProvider(
    providerId: string,
    audit?: StaffAuditSpec,
  ): Promise<PilotProvider> {
    if (!providerId.startsWith('PILOT-')) {
      throw new Error('Invalid pilot provider');
    }
    return this.serviceRequestStore.updatePilotProviderVerification(
      providerId,
      'suspended',
      audit,
      'verified',
    );
  }

  async reactivatePilotProvider(
    providerId: string,
    audit?: StaffAuditSpec,
  ): Promise<PilotProvider> {
    if (!providerId.startsWith('PILOT-')) {
      throw new Error('Invalid pilot provider');
    }
    return this.serviceRequestStore.updatePilotProviderVerification(
      providerId,
      'verified',
      audit,
      'suspended',
    );
  }

  async setPilotProviderAccessCode(
    providerId: string,
    accessCode: string,
    audit?: StaffAuditSpec,
  ): Promise<void> {
    if (providerId.trim().length < 3 || accessCode.trim().length < 16) {
      throw new Error('Invalid provider access code');
    }
    await this.serviceRequestStore.setProviderAccessCode(
      providerId,
      accessCode.trim(),
      audit,
    );
  }

  async getProviderServiceRequests(
    providerId: string,
  ): Promise<ServiceRequest[]> {
    const requests =
      await this.serviceRequestStore.findByProviderId(providerId);
    return this.attachImagesToRequests(requests);
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
    audit?: StaffAuditSpec,
  ): Promise<ServiceRequest> {
    return this.serviceRequestStore.assignProvider(
      requestId,
      providerId,
      audit,
    );
  }

  updateStatus(
    requestId: string,
    status: ServiceRequestStatus,
    audit?: StaffAuditSpec,
  ): Promise<ServiceRequest> {
    return this.serviceRequestStore.updateStatus(requestId, status, audit);
  }

  async proposeQuote(
    requestId: string,
    amountHalalas: number,
    scope: string,
    audit?: StaffAuditSpec,
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
      audit,
    );
  }

  async inviteProvidersToRequest(
    requestId: string,
    providerIds: unknown,
    audit?: StaffAuditSpec,
  ): Promise<ProviderOpportunity[]> {
    return this.serviceRequestStore.inviteProvidersToRequest(
      requestId,
      this.normalizeProviderInvitationIds(providerIds),
      audit,
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

  async getProviderOpportunities(
    providerId: string,
  ): Promise<ProviderOpportunity[]> {
    const opportunities =
      await this.serviceRequestStore.listProviderOpportunities(providerId);
    // Authorization derives exclusively from the server-side listing: the
    // store only returns opportunities owned by `providerId` (which itself
    // comes from the authenticated principal, never from the client). The
    // signed image lookup below is restricted to opportunities that are in
    // an actually eligible/current state.
    const eligibleRequestIds = opportunities
      .filter((opportunity) => this.isEligiblePreQuoteOpportunity(opportunity))
      .map((opportunity) => opportunity.requestId);
    const signedImagesByRequest =
      await this.signRequestImagesForIds(eligibleRequestIds);
    return opportunities.map((opportunity) =>
      this.toProviderOpportunityDto(opportunity, signedImagesByRequest),
    );
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
    audit?: StaffAuditSpec,
  ): Promise<{ closed: boolean }> {
    return this.serviceRequestStore.closeProviderOpportunity(
      requestId,
      providerId,
      audit,
    );
  }

  async collectCashPayment(
    requestId: string,
    audit?: StaffAuditSpec,
  ): Promise<ServicePayment> {
    if (!/^MOE-\d+$/.test(requestId)) {
      throw new Error('Invalid service request');
    }
    return this.serviceRequestStore.collectCashPayment(requestId, audit);
  }

  async refundCashPayment(
    requestId: string,
    audit?: StaffAuditSpec,
  ): Promise<ServicePayment> {
    if (!/^MOE-\d+$/.test(requestId)) {
      throw new Error('Invalid service request');
    }
    return this.serviceRequestStore.refundCashPayment(requestId, audit);
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

  /**
   * Pre-quote eligibility uses ONLY the real opportunity state machine:
   * `invited`/`quoted` opportunities are current while the request is still
   * `pending_dispatch`; withdrawn/closed/rejected opportunities and requests
   * that left `pending_dispatch` never retain pre-assignment visibility.
   */
  private isEligiblePreQuoteOpportunity(
    opportunity: ProviderOpportunityAccess,
  ): boolean {
    return (
      ['invited', 'quoted'].includes(opportunity.opportunityStatus) &&
      opportunity.requestStatus === 'pending_dispatch'
    );
  }

  /**
   * Whitelist projection for provider opportunities. Ineligible
   * opportunities keep ONLY the pre-existing base fields; the protected
   * pre-assignment fields (address/details/images) are attached exclusively
   * to eligible opportunities. Customer identity/contact fields are never
   * present because this shape never carries them.
   */
  private toProviderOpportunityDto(
    opportunity: ProviderOpportunityAccess,
    signedImagesByRequest: Map<string, RequestImageDto[]>,
  ): ProviderOpportunity {
    const base: ProviderOpportunity = {
      requestId: opportunity.requestId,
      serviceId: opportunity.serviceId,
      timing: opportunity.timing,
      opportunityStatus: opportunity.opportunityStatus,
      // Rebuilt field-by-field: the store projection is trusted, but the
      // public shape must stay a fixed whitelist even if that ever changes.
      ...(opportunity.myQuote
        ? {
            myQuote: {
              id: opportunity.myQuote.id,
              providerId: opportunity.myQuote.providerId,
              amountHalalas: opportunity.myQuote.amountHalalas,
              scope: opportunity.myQuote.scope,
              status: opportunity.myQuote.status,
              proposedAt: opportunity.myQuote.proposedAt,
              decidedAt: opportunity.myQuote.decidedAt,
            },
          }
        : {}),
    };
    if (!this.isEligiblePreQuoteOpportunity(opportunity)) {
      return base;
    }
    return {
      ...base,
      address: opportunity.address,
      details: opportunity.details,
      images: signedImagesByRequest.get(opportunity.requestId) ?? [],
    };
  }

  /**
   * Attaches signed image DTOs to authorized request reads using ONE batch
   * image-metadata query for the whole list (no per-request N+1). Requests
   * without committed images keep the previous shape (no `images` field).
   * Signed URLs are generated on demand and never persisted.
   */
  private async attachImagesToRequests(
    requests: ServiceRequest[],
  ): Promise<ServiceRequest[]> {
    if (requests.length === 0) return requests;
    const signedImagesByRequest = await this.signRequestImagesForIds(
      requests.map((request) => request.id),
    );
    if (signedImagesByRequest.size === 0) return requests;
    return requests.map((request) => {
      const images = signedImagesByRequest.get(request.id);
      return images ? { ...request, images } : request;
    });
  }

  private async signRequestImagesForIds(
    requestIds: string[],
  ): Promise<Map<string, RequestImageDto[]>> {
    const uniqueRequestIds = [...new Set(requestIds)];
    const signed = new Map<string, RequestImageDto[]>();
    if (uniqueRequestIds.length === 0) return signed;
    const storedByRequest =
      await this.serviceRequestStore.findRequestImagesByRequestIds(
        uniqueRequestIds,
      );
    for (const [requestId, images] of storedByRequest) {
      if (images.length === 0) continue;
      signed.set(requestId, await this.requestImageService.toDtos(images));
    }
    return signed;
  }

  private async getCustomerForToken(token: string): Promise<Customer> {
    const customer =
      await this.serviceRequestStore.findCustomerBySession(token);
    if (!customer) throw new UnauthorizedException('Unauthorized');
    return customer;
  }
}

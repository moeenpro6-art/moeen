import {
  Inject,
  Injectable,
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ServiceRequestRepository,
  type ProviderCurrentPosition,
  type ProviderLocationSubmissionResult,
} from './service-request.repository';
import type { StaffAuditSpec } from './staff-auth.repository';
import {
  projectProviderTrackingStatus,
  validateProviderLocationSample,
  type ProviderLocationSample,
  type ProviderTrackingAuthorityRecord,
  type ProviderTrackingStatusResponseDto,
} from './provider-tracking';
import {
  DEFAULT_PROVIDER_TRACKING_CONFIG,
  PROVIDER_TRACKING_CONFIG,
  type ProviderTrackingConfig,
} from './provider-tracking.config';
import {
  RequestImageCreateOrchestrator,
  RequestSubmissionConflictError,
  RequestSubmissionReplayError,
  parseIdempotencyKey,
  type CreateServiceRequestMultipartResult,
  type ServiceRequestMultipartInput,
  type ServiceRequestSubmissionContext,
} from './request-image-create.contracts';
import {
  RequestImageService,
  requestSubmissionFingerprint,
} from './request-image.service';
import type {
  RequestImageDto,
  StoredRequestImage,
} from './request-image.types';
import {
  SERVICE_LOCATION_CONFIG,
  type ServiceLocationConfig,
} from './service-location.config';
import {
  resolveServiceLocation,
  type ServiceLocation,
} from './service-location.contracts';

export type LaunchService = {
  id: string;
  nameAr: string;
};

export type CreateServiceRequest = {
  serviceId: string;
  address: string;
  details?: string;
  timing: 'as-soon-as-possible' | 'scheduled';
  location?: ServiceLocation;
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
  locationConfig: ServiceLocationConfig = { mode: 'off' },
  now: () => Date = () => new Date(),
): CreateServiceRequest {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BadRequestException('Invalid service request');
  }

  const candidate = input as Record<string, unknown>;
  const serviceId = candidate.serviceId;
  const address = candidate.address;
  const timing = candidate.timing;
  const details = candidate.details;
  const location = candidate.location;
  const allowedKeys = new Set([
    'serviceId',
    'address',
    'details',
    'timing',
    'location',
  ]);

  if (
    Object.keys(candidate).some((key) => !allowedKeys.has(key)) ||
    typeof serviceId !== 'string' ||
    !launchServiceIds.has(serviceId) ||
    typeof timing !== 'string' ||
    !requestTimings.has(timing as CreateServiceRequest['timing']) ||
    (details !== undefined &&
      (typeof details !== 'string' || details.trim().length > 1000))
  ) {
    throw new BadRequestException('Invalid service request');
  }

  const resolvedLocation = resolveServiceLocation(
    address,
    location,
    locationConfig,
    now,
  );
  const normalizedDetails = details?.trim();
  return {
    serviceId,
    address: resolvedLocation.address,
    timing: timing as CreateServiceRequest['timing'],
    ...(normalizedDetails ? { details: normalizedDetails } : {}),
    ...(resolvedLocation.location
      ? { location: resolvedLocation.location }
      : {}),
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
 * Public provider-opportunity projection. Eligible invited/quoted providers
 * receive the request description and signed image DTOs needed to price the
 * work, but exact address/coordinates and customer identity/contact data are
 * never part of this shape.
 */
export type ProviderOpportunity = {
  requestId: string;
  serviceId: string;
  timing: ServiceRequest['timing'];
  opportunityStatus: ProviderOpportunityStatus;
  myQuote?: ServiceQuote;
  details?: string;
  images?: RequestImageDto[];
  /**
   * Coarse customer-area disclosure for the pre-quote tier, derived
   * server-side from the exact confirmed point. Present ONLY while the
   * authenticated provider owns an eligible (`invited`/`quoted`,
   * request still pending dispatch) opportunity. The exact point,
   * address, and customer identity/contact data are never part of this
   * shape.
   */
  approximateLocation?: ProviderApproximateLocation;
};

/**
 * Store-level opportunity read: the server-side projection used to decide
 * pre-quote eligibility. `requestStatus` is an authorization input, never a
 * client value, and is stripped before anything reaches a client.
 */
export type ProviderOpportunityAccess = ProviderOpportunity & {
  requestStatus?: ServiceRequestStatus;
  /** Internal exact point used only to derive the public coarse projection. */
  location?: Pick<ServiceLocation, 'point'>;
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

type ProviderServiceRequestSummary = Pick<
  ServiceRequest,
  | 'id'
  | 'serviceId'
  | 'timing'
  | 'status'
  | 'assignedProvider'
  | 'quote'
  | 'payment'
  | 'rating'
  | 'ratingComment'
  | 'createdAt'
>;

/**
 * Provider-owned job projection. Active assignments use the full exact
 * request shape; pre-assignment reads may carry only a coarse location; all
 * other states use the redacted summary.
 */
export type ProviderServiceRequest =
  | ServiceRequest
  | (ProviderServiceRequestSummary & {
      approximateLocation?: ProviderApproximateLocation;
    });

export type ProviderStatusTransitionResponseDto = ProviderServiceRequest &
  ProviderTrackingStatusResponseDto;

const ACTIVE_PROVIDER_LOCATION_STATUSES = new Set<ServiceRequestStatus>([
  'assigned',
  'on_the_way',
  'in_progress',
]);

/**
 * Coarse customer-area disclosure for the pre-quote provider tier.
 *
 * Derived server-side from the exact confirmed point; the exact
 * latitude/longitude never appears in this shape and it is never
 * accepted from client input. Coordinates are rounded to one decimal
 * place (roughly a 10 km bucket around Buraidah/Qassim), so the exact
 * customer pin cannot be recovered from this projection.
 */
export type ProviderApproximateLocation = {
  point: {
    latitude: number;
    longitude: number;
  };
  /** Approximate width of the disclosed coordinate bucket. */
  precisionKm: 10;
};

// One decimal degree is roughly a 10 km bucket around Buraidah/Qassim.
// This gives invited providers useful coarse area context without an exact pin.
const APPROXIMATE_LOCATION_COORDINATE_PRECISION = 10;

/**
 * Strips the exact service point down to a coarse, non-recoverable
 * representation. Always derived from the stored exact point and never
 * from any client-supplied value.
 */
export function deriveProviderApproximateLocation(
  location: Pick<ServiceLocation, 'point'>,
): ProviderApproximateLocation {
  const coarse = (coordinate: number): number =>
    Math.round(coordinate * APPROXIMATE_LOCATION_COORDINATE_PRECISION) /
    APPROXIMATE_LOCATION_COORDINATE_PRECISION;
  return {
    point: {
      latitude: coarse(location.point.latitude),
      longitude: coarse(location.point.longitude),
    },
    precisionKm: 10,
  };
}

/**
 * The three provider location tiers, enforced in one place:
 *  - active assignment statuses -> exact `location` (unchanged);
 *  - pre-quote bidder/invited statuses -> coarse `approximateLocation`
 *    only (never the exact point);
 *  - terminal/other statuses -> no location at all (unchanged).
 */
const BIDDER_PROVIDER_LOCATION_STATUSES = new Set<ServiceRequestStatus>([
  'pending_dispatch',
]);

/**
 * Explicit provider projection for assigned jobs. Exact address, details,
 * customer contact, images and confirmed coordinates exist only while the
 * assignment is active; pre-quote history is reduced to a coarse
 * approximate location; terminal history is rebuilt from a safe whitelist.
 */
export function projectServiceRequestForProvider(
  request: ServiceRequest,
): ProviderServiceRequest {
  if (ACTIVE_PROVIDER_LOCATION_STATUSES.has(request.status)) return request;
  if (BIDDER_PROVIDER_LOCATION_STATUSES.has(request.status)) {
    return {
      id: request.id,
      serviceId: request.serviceId,
      timing: request.timing,
      status: request.status,
      assignedProvider: request.assignedProvider,
      quote: request.quote,
      payment: request.payment,
      rating: request.rating,
      ratingComment: request.ratingComment,
      createdAt: request.createdAt,
      ...(request.location
        ? {
            approximateLocation: deriveProviderApproximateLocation(
              request.location,
            ),
          }
        : {}),
    };
  }
  return {
    id: request.id,
    serviceId: request.serviceId,
    timing: request.timing,
    status: request.status,
    assignedProvider: request.assignedProvider,
    quote: request.quote,
    payment: request.payment,
    rating: request.rating,
    ratingComment: request.ratingComment,
    createdAt: request.createdAt,
  };
}

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
  findProviderTrackingAuthority(
    requestId: string,
    providerId: string,
  ): Promise<ProviderTrackingAuthorityRecord | undefined>;

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
  submitProviderLocationSample(
    requestId: string,
    providerId: string,
    sample: ProviderLocationSample,
  ): Promise<ProviderLocationSubmissionResult>;
  findCurrentProviderPositionForProvider(
    requestId: string,
    providerId: string,
  ): Promise<ProviderCurrentPosition | undefined>;
  findCurrentProviderPositionForCustomer(
    requestId: string,
    customerId: string,
  ): Promise<ProviderCurrentPosition | undefined>;
  findCurrentProviderPositionForOperations(
    requestId: string,
  ): Promise<ProviderCurrentPosition | undefined>;
  stopProviderTrackingForOperations(requestId: string): Promise<void>;
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
    @Inject(SERVICE_LOCATION_CONFIG)
    private readonly serviceLocationConfig: ServiceLocationConfig = {
      mode: 'off',
    },
    @Inject(PROVIDER_TRACKING_CONFIG)
    private readonly providerTrackingConfig: ProviderTrackingConfig = DEFAULT_PROVIDER_TRACKING_CONFIG,
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

  async createAuthenticatedServiceRequest(
    customer: Customer,
    input: unknown,
    idempotencyKey?: string,
  ): Promise<ServiceRequest> {
    const request = validateCreateServiceRequest(
      input,
      this.serviceLocationConfig,
    );
    if (!request.location) {
      return this.serviceRequestStore.create(request, customer.id);
    }

    const clientSubmissionId = parseIdempotencyKey(idempotencyKey);
    const submission: ServiceRequestSubmissionContext = {
      clientSubmissionId,
      submissionFingerprint: requestSubmissionFingerprint(request, []),
    };
    try {
      return await this.serviceRequestStore.create(
        request,
        customer.id,
        submission,
      );
    } catch (error) {
      if (error instanceof RequestSubmissionReplayError) {
        const original =
          await this.serviceRequestStore.findRequestByCustomerSubmission(
            customer.id,
            clientSubmissionId,
          );
        if (original) return original;
      }
      if (error instanceof RequestSubmissionConflictError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
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
    const createInput = validateCreateServiceRequest(
      {
        serviceId: input.serviceId,
        address: input.address,
        details: input.details,
        timing: input.timing,
        location: input.location,
      },
      this.serviceLocationConfig,
    );
    const submissionFingerprint = orchestrator.computeFingerprint(
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
  ): Promise<ProviderServiceRequest[]> {
    const requests =
      await this.serviceRequestStore.findByProviderId(providerId);
    const active = requests.filter((request) =>
      ACTIVE_PROVIDER_LOCATION_STATUSES.has(request.status),
    );
    const withImages = await this.attachImagesToRequests(active);
    const activeById = new Map(
      withImages.map((request) => [request.id, request]),
    );
    return requests.map((request) =>
      projectServiceRequestForProvider(activeById.get(request.id) ?? request),
    );
  }

  async updateProviderServiceRequestStatus(
    providerId: string,
    requestId: string,
    status: Extract<
      ServiceRequestStatus,
      'on_the_way' | 'in_progress' | 'completed'
    >,
  ): Promise<ProviderStatusTransitionResponseDto> {
    const updated = await this.serviceRequestStore.updateStatusForProvider(
      requestId,
      providerId,
      status,
    );
    const projected = projectServiceRequestForProvider(updated);
    const statusResponse = await this.getProviderTrackingStatus(
      providerId,
      requestId,
    );
    if (!statusResponse) throw new Error('Assigned provider request not found');
    return { ...projected, ...statusResponse };
  }

  async getProviderTrackingStatus(
    providerId: string,
    requestId: string,
  ): Promise<ProviderTrackingStatusResponseDto | undefined> {
    const record = await this.serviceRequestStore.findProviderTrackingAuthority(
      requestId,
      providerId,
    );
    return record
      ? projectProviderTrackingStatus(record, this.providerTrackingConfig)
      : undefined;
  }

  submitProviderLocationSample(
    providerId: string,
    requestId: string,
    input: unknown,
  ): Promise<ProviderLocationSubmissionResult> {
    return this.serviceRequestStore.submitProviderLocationSample(
      requestId,
      providerId,
      validateProviderLocationSample(input),
    );
  }

  getProviderCurrentPosition(
    providerId: string,
    requestId: string,
  ): Promise<ProviderCurrentPosition | undefined> {
    return this.serviceRequestStore.findCurrentProviderPositionForProvider(
      requestId,
      providerId,
    );
  }

  async getMyProviderCurrentPosition(
    token: string,
    requestId: string,
  ): Promise<ProviderCurrentPosition | undefined> {
    const customer = await this.getCustomerForToken(token);
    return this.serviceRequestStore.findCurrentProviderPositionForCustomer(
      requestId,
      customer.id,
    );
  }

  getOperationsProviderCurrentPosition(
    requestId: string,
  ): Promise<ProviderCurrentPosition | undefined> {
    return this.serviceRequestStore.findCurrentProviderPositionForOperations(
      requestId,
    );
  }

  stopProviderTrackingForOperations(requestId: string): Promise<void> {
    return this.serviceRequestStore.stopProviderTrackingForOperations(
      requestId,
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
    // The repository derives ownership from the authenticated provider id.
    // Sign images only for opportunities that are still eligible to quote;
    // terminal/ineligible rows never trigger an image metadata read.
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
   * Pre-quote eligibility uses only server-side lifecycle state. Invited or
   * quoted opportunities remain eligible while the request is pending
   * dispatch; terminal opportunities and requests that moved on do not.
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
   * Fixed whitelist projection for provider opportunities. Eligible owners
   * receive description/images needed to quote and a coarse approximate
   * location. Exact address/coordinates, customer identity/contact,
   * auth/session data, and storage metadata are never copied from the
   * store projection.
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
    const approximateLocation = opportunity.location
      ? deriveProviderApproximateLocation(opportunity.location)
      : undefined;
    return {
      ...base,
      details: opportunity.details,
      images: signedImagesByRequest.get(opportunity.requestId) ?? [],
      ...(approximateLocation ? { approximateLocation } : {}),
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

import { Inject, Injectable } from '@nestjs/common';
import { StaffAuthRepository } from './staff-auth.repository';
import type {
  CreateAuditEventInput,
  StaffAuditEvent,
} from './staff-auth.repository';
import type { StaffPrincipal } from './staff-auth.service';

export interface StaffAuditStore {
  appendAuditEvent(input: CreateAuditEventInput): Promise<void>;
  listAuditEvents(options?: {
    subjectId?: string;
    limit?: number;
  }): Promise<StaffAuditEvent[]>;
}

@Injectable()
export class StaffAuditService {
  constructor(
    @Inject(StaffAuthRepository) private readonly store: StaffAuditStore,
  ) {}

  record(
    actor: StaffPrincipal,
    event: Omit<CreateAuditEventInput, 'staffId'>,
  ): Promise<void> {
    return this.store.appendAuditEvent({ ...event, staffId: actor.id });
  }

  list(limit?: number): Promise<StaffAuditEvent[]> {
    return this.store.listAuditEvents({ limit });
  }
}

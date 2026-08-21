import { Inject, Injectable } from '@nestjs/common';
import { StaffAuthRepository } from './staff-auth.repository';
import type {
  CreateAuditEventInput,
  StaffAuditEvent,
} from './staff-auth.repository';
import type { StaffPrincipal } from './staff-auth.service';
import { assertBroadAuditLocationSafe } from './location-privacy';

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

  async record(
    actor: StaffPrincipal,
    event: Omit<CreateAuditEventInput, 'staffId'>,
  ): Promise<void> {
    assertBroadAuditLocationSafe(event.oldState);
    assertBroadAuditLocationSafe(event.newState);
    await this.store.appendAuditEvent({ ...event, staffId: actor.id });
  }

  list(limit?: number): Promise<StaffAuditEvent[]> {
    return this.store.listAuditEvents({ limit });
  }
}

import { StaffAuditService } from './staff-audit.service';
import { StaffAuthRepository } from './staff-auth.repository';
import {
  BROAD_AUDIT_LOCATION_FORBIDDEN_FIELDS,
  assertBroadAuditLocationSafe,
} from './location-privacy';

const actor = {
  id: 'STF-1001',
  email: 'dispatcher@example.test',
  displayName: 'Dispatcher',
  role: 'dispatcher' as const,
};

describe('exact location privacy outside request-scoped DTOs', () => {
  it.each(BROAD_AUDIT_LOCATION_FORBIDDEN_FIELDS)(
    'rejects %s recursively from broad audit JSON',
    (field) => {
      expect(() =>
        assertBroadAuditLocationSafe({ nested: { [field]: 'sensitive' } }),
      ).toThrow('Staff audit state contains forbidden location data');
    },
  );

  it('allows non-sensitive operational audit state', () => {
    expect(() =>
      assertBroadAuditLocationSafe({ status: 'assigned', providerId: 'P-1' }),
    ).not.toThrow();
  });

  it('fails before broad audit persistence when exact location is present', async () => {
    const store = {
      appendAuditEvent: jest.fn().mockResolvedValue(undefined),
      listAuditEvents: jest.fn(),
    };
    const service = new StaffAuditService(store);

    await expect(
      service.record(actor, {
        action: 'request.updated',
        subjectType: 'service_request',
        subjectId: 'MOE-1042',
        newState: { serviceLocation: { point: 'sensitive' } },
      }),
    ).rejects.toThrow('Staff audit state contains forbidden location data');
    expect(store.appendAuditEvent).not.toHaveBeenCalled();
  });

  it('fails closed at the low-level audit repository persistence boundary', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const repository = Object.create(
      StaffAuthRepository.prototype,
    ) as StaffAuthRepository;
    (repository as unknown as { pool: { query: typeof query } }).pool = {
      query,
    };

    await expect(
      repository.appendAuditEvent({
        staffId: actor.id,
        action: 'request.status_updated',
        subjectType: 'service_request',
        subjectId: 'MOE-1001',
        newState: {
          serviceLocation: { point: { latitude: 'sensitive' } },
        },
      }),
    ).rejects.toThrow('Staff audit state contains forbidden location data');
    expect(query).not.toHaveBeenCalled();
  });
});

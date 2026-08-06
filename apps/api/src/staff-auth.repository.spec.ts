import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { hashStaffPassword } from './staff-auth.service';
import { StaffAuthRepository } from './staff-auth.repository';

describe('StaffAuthRepository', () => {
  const repository = new StaffAuthRepository();
  const email = `staff-auth-${randomUUID()}@example.test`;
  let staffId = '';

  beforeAll(async () => {
    await repository.initialize();
  });

  afterAll(async () => {
    await repository.close();
  });

  it('atomically counts public auth attempts within their fixed window', async () => {
    const subjectHash = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    const windowStartedAt = new Date(
      Date.now() - (Date.now() % 600_000),
    );

    const concurrentAttemptCounts = await Promise.all(
      Array.from({ length: 10 }, () =>
        repository.reservePublicAuthAttempt(
          'customer_otp_request',
          subjectHash,
          windowStartedAt,
        ),
      ),
    );
    expect(concurrentAttemptCounts.sort((left, right) => left - right)).toEqual(
      Array.from({ length: 10 }, (_value, index) => index + 1),
    );
    await expect(
      repository.reservePublicAuthAttempt(
        'customer_otp_request',
        subjectHash,
        new Date(600_000),
      ),
    ).resolves.toBe(1);
  });

  it('persists an active staff member and resolves only an unexpired session', async () => {
    const passwordHash = await hashStaffPassword('test-only password');
    const staff = await repository.createStaff({
      email,
      displayName: 'موظف اختبار',
      role: 'dispatcher',
      passwordHash,
    });
    staffId = staff.id;

    await expect(repository.findStaffByEmail(email)).resolves.toEqual({
      ...staff,
      passwordHash,
      isActive: true,
    });

    const token = `test-session-${randomUUID()}`;
    await repository.createStaffSession(staff.id, token);
    await expect(repository.findStaffBySession(token)).resolves.toEqual(staff);

    await repository.revokeStaffSession(token);
    await expect(repository.findStaffBySession(token)).resolves.toBeUndefined();
  });

  it('bootstraps the initial admin only once', async () => {
    const bootstrapEmail = `bootstrap-${randomUUID()}@example.test`;
    const passwordHash = await hashStaffPassword('test-only password');

    const first = await repository.bootstrapInitialAdmin({
      email: bootstrapEmail,
      displayName: 'مدير اختبار',
      passwordHash,
    });
    const second = await repository.bootstrapInitialAdmin({
      email: bootstrapEmail,
      displayName: 'اسم مختلف لا يجب استبداله',
      passwordHash: await hashStaffPassword('another test-only password'),
    });

    expect(typeof first.id).toBe('string');
    expect(first).toEqual({
      id: first.id,
      email: bootstrapEmail,
      displayName: 'مدير اختبار',
      role: 'admin',
    });
    expect(second).toEqual(first);
    await expect(repository.findStaffByEmail(bootstrapEmail)).resolves.toEqual(
      expect.objectContaining({
        displayName: 'مدير اختبار',
        role: 'admin',
        isActive: true,
      }),
    );
  });

  it('records a role-safe audit event', async () => {
    await repository.appendAuditEvent({
      staffId,
      action: 'request.status_updated',
      subjectType: 'service_request',
      subjectId: 'MOE-test',
      oldState: { status: 'assigned' },
      newState: { status: 'on_the_way' },
    });

    const events = await repository.listAuditEvents({ subjectId: 'MOE-test' });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor: { id: staffId, displayName: 'موظف اختبار' },
          action: 'request.status_updated',
          subjectType: 'service_request',
          subjectId: 'MOE-test',
          oldState: { status: 'assigned' },
          newState: { status: 'on_the_way' },
        }),
      ]),
    );
  });
});

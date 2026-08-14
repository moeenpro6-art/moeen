import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
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
    const subjectHash = createHash('sha256').update(randomUUID()).digest('hex');
    const windowStartedAt = new Date(Date.now() - (Date.now() % 600_000));

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

describe('pooled transaction cleanup invariant (Q0-SEC regression)', () => {
  // Deterministic, DB-free regression tests for the fail-safe transaction
  // cleanup: a transaction-scoped pool client must never be released back to
  // the pg pool as healthy while a transaction may be open or aborted. Query
  // failures are scripted per call (1-based) on a fake client, so no real
  // database connection is ever made.

  const scriptedClient = (failAt: Record<number, string>) => {
    const queries: string[] = [];
    const order: string[] = [];
    const client = {
      query: jest.fn((sql: string) => {
        const failMessage = failAt[queries.length + 1];
        queries.push(String(sql));
        order.push(`query:${sql}`);
        if (failMessage !== undefined) throw new Error(failMessage);
        return { rows: [] };
      }),
      release: jest.fn((err?: Error) => {
        order.push(err === undefined ? 'release:clean' : 'release:error');
      }),
    };
    return { client, queries, order };
  };

  const connectSpyFor = (repo: StaffAuthRepository, client: unknown) => {
    const pool = (repo as unknown as { pool: Pool }).pool;
    return jest.spyOn(pool, 'connect').mockResolvedValue(client as never);
  };

  const repositories: StaffAuthRepository[] = [];

  afterEach(async () => {
    await Promise.all(repositories.splice(0).map((repo) => repo.close()));
    jest.restoreAllMocks();
  });

  const freshRepository = () => {
    const repo = new StaffAuthRepository();
    repositories.push(repo);
    return repo;
  };

  it('initialize(): advisory-lock acquisition failure after BEGIN rolls back before releasing the client', async () => {
    const repo = freshRepository();
    const { client, queries, order } = scriptedClient({
      2: 'simulated advisory-lock acquisition failure',
    });
    connectSpyFor(repo, client);

    await expect(repo.initialize()).rejects.toThrow(
      'simulated advisory-lock acquisition failure',
    );

    expect(queries[0]).toBe('BEGIN');
    expect(queries).toContain('ROLLBACK');
    expect(order.indexOf('query:ROLLBACK')).toBeLessThan(
      order.indexOf('release:clean'),
    );
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith();
    expect(order).not.toContain('release:error');
  });

  it('initialize(): rollback failure discards the client via release(error) instead of a healthy release', async () => {
    const repo = freshRepository();
    const { client, order } = scriptedClient({
      2: 'simulated advisory-lock acquisition failure',
      3: 'simulated rollback failure',
    });
    connectSpyFor(repo, client);

    await expect(repo.initialize()).rejects.toThrow(
      'simulated advisory-lock acquisition failure',
    );

    expect(order).toContain('query:ROLLBACK');
    expect(order).toContain('release:error');
    expect(order).not.toContain('release:clean');
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(expect.any(Error));
  });

  it('initialize(): BEGIN failure cannot leak an uncertain transaction state', async () => {
    const repo = freshRepository();
    const { client, queries, order } = scriptedClient({
      1: 'simulated BEGIN failure',
    });
    connectSpyFor(repo, client);

    await expect(repo.initialize()).rejects.toThrow('simulated BEGIN failure');

    expect(queries[0]).toBe('BEGIN');
    // ROLLBACK is still attempted (a harmless no-op outside a transaction),
    // so the connection state is proven clean before the client is released.
    expect(queries).toContain('ROLLBACK');
    expect(order).toContain('release:clean');
    expect(order).not.toContain('release:error');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('initialize(): successful migration transaction commits and releases exactly once', async () => {
    const repo = freshRepository();
    const { client, queries, order } = scriptedClient({});
    connectSpyFor(repo, client);

    await expect(repo.initialize()).resolves.toBeUndefined();

    expect(queries[0]).toBe('BEGIN');
    expect(queries).toContain('COMMIT');
    expect(order.filter((entry) => entry === 'release:clean')).toHaveLength(1);
    expect(order).not.toContain('release:error');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

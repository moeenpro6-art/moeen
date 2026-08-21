import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { ServiceRequestRepository } from './service-request.repository';

describe('request-scoped provider tracking repository', () => {
  const repository = new ServiceRequestRepository(undefined, { enabled: true });

  beforeAll(async () => repository.initialize());
  afterAll(async () => repository.close());

  it('starts only on assigned -> on_the_way and accepts active owner samples', async () => {
    const fixture = await createAssignedTrackingRequest();
    const preActivationCapturedAt = new Date();

    await expect(
      repository.submitProviderLocationSample(
        fixture.requestId,
        fixture.providerId,
        sample(preActivationCapturedAt),
        preActivationCapturedAt,
      ),
    ).rejects.toThrow('Active provider tracking request not found');

    await repository.updateStatusForProvider(
      fixture.requestId,
      fixture.providerId,
      'on_the_way',
    );
    const firstCapturedAt = activeSampleTime();

    await expect(
      repository.submitProviderLocationSample(
        fixture.requestId,
        fixture.providerId,
        sample(firstCapturedAt),
        firstCapturedAt,
      ),
    ).resolves.toMatchObject({ duplicate: false, arrivalObserved: false });
    await expect(
      repository.findCurrentProviderPositionForProvider(
        fixture.requestId,
        fixture.providerId,
      ),
    ).resolves.toMatchObject({
      requestId: fixture.requestId,
      latitude: 26.359123,
      longitude: 43.981988,
      accuracyMeters: 10,
      arrivalObserved: false,
    });
  });

  it('keeps the rollout default fail-closed', async () => {
    const disabledRepository = new ServiceRequestRepository(undefined, {
      enabled: false,
    });
    await disabledRepository.initialize();
    try {
      const capturedAt = activeSampleTime();
      await expect(
        disabledRepository.submitProviderLocationSample(
          'MOE-999999',
          'provider-1',
          sample(capturedAt),
          capturedAt,
        ),
      ).rejects.toThrow('Provider tracking is not enabled');
    } finally {
      await disabledRepository.close();
    }
  });

  it('keeps tracking active in progress and rejects another provider', async () => {
    const fixture = await createAssignedTrackingRequest();
    await repository.updateStatusForProvider(
      fixture.requestId,
      fixture.providerId,
      'on_the_way',
    );
    await repository.updateStatusForProvider(
      fixture.requestId,
      fixture.providerId,
      'in_progress',
    );
    const capturedAt = activeSampleTime();

    await expect(
      repository.submitProviderLocationSample(
        fixture.requestId,
        fixture.providerId,
        sample(capturedAt),
        capturedAt,
      ),
    ).resolves.toMatchObject({ duplicate: false });
    await expect(
      repository.submitProviderLocationSample(
        fixture.requestId,
        'provider-1',
        sample(new Date(capturedAt.getTime() + 10_000)),
        new Date(capturedAt.getTime() + 10_000),
      ),
    ).rejects.toThrow('Active provider tracking request not found');
  });

  it('handles duplicates idempotently, rejects out-of-order samples, and observes deterministic arrival', async () => {
    const fixture = await createAssignedTrackingRequest();
    await repository.updateStatusForProvider(
      fixture.requestId,
      fixture.providerId,
      'on_the_way',
    );
    const first = activeSampleTime();
    const second = new Date(first.getTime() + 15_000);
    const third = new Date(first.getTime() + 30_000);

    await repository.submitProviderLocationSample(
      fixture.requestId,
      fixture.providerId,
      sample(first),
      first,
    );
    await expect(
      repository.submitProviderLocationSample(
        fixture.requestId,
        fixture.providerId,
        sample(first),
        first,
      ),
    ).resolves.toMatchObject({ duplicate: true, arrivalObserved: false });
    await repository.submitProviderLocationSample(
      fixture.requestId,
      fixture.providerId,
      sample(second),
      second,
    );
    await expect(
      repository.submitProviderLocationSample(
        fixture.requestId,
        fixture.providerId,
        sample(first),
        second,
      ),
    ).resolves.toMatchObject({ duplicate: true, arrivalObserved: false });
    await expect(
      repository.submitProviderLocationSample(
        fixture.requestId,
        fixture.providerId,
        sample(new Date(first.getTime() + 1_000)),
        second,
      ),
    ).rejects.toThrow('Provider location sample is out of order');
    await expect(
      repository.submitProviderLocationSample(
        fixture.requestId,
        fixture.providerId,
        sample(third),
        third,
      ),
    ).resolves.toMatchObject({ duplicate: false, arrivalObserved: true });
  });

  it('rejects queued points captured before tracking activation as arrival evidence', async () => {
    const fixture = await createAssignedTrackingRequest();
    await repository.updateStatusForProvider(
      fixture.requestId,
      fixture.providerId,
      'on_the_way',
    );
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    try {
      const session = await pool.query<{ started_at: Date }>(
        `SELECT started_at
           FROM provider_tracking_sessions
          WHERE service_request_id = $1 AND provider_id = $2`,
        [requestDatabaseId(fixture.requestId), fixture.providerId],
      );
      const startedAt = session.rows[0]?.started_at;
      expect(startedAt).toBeInstanceOf(Date);
      const queuedPoints = [60_000, 30_000, 1].map(
        (offset) => new Date(startedAt.getTime() - offset),
      );

      for (const capturedAt of queuedPoints) {
        await expect(
          repository.submitProviderLocationSample(
            fixture.requestId,
            fixture.providerId,
            sample(capturedAt),
            new Date(startedAt.getTime() + 1_000),
          ),
        ).rejects.toThrow(
          'Provider location sample predates tracking activation',
        );
      }

      await expect(
        repository.findCurrentProviderPositionForProvider(
          fixture.requestId,
          fixture.providerId,
        ),
      ).resolves.toBeUndefined();
      const arrivalState = await pool.query<{
        arrival_qualifying_sample_count: number;
        arrival_observed_at: Date | null;
      }>(
        `SELECT arrival_qualifying_sample_count, arrival_observed_at
           FROM provider_tracking_sessions
          WHERE service_request_id = $1 AND provider_id = $2`,
        [requestDatabaseId(fixture.requestId), fixture.providerId],
      );
      expect(arrivalState.rows).toEqual([
        {
          arrival_qualifying_sample_count: 0,
          arrival_observed_at: null,
        },
      ]);
    } finally {
      await pool.end();
    }
  });

  it('rejects a point captured while tracking activation is blocked on the request row', async () => {
    const fixture = await createAssignedTrackingRequest();
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const blocker = await pool.connect();
    let blockerHeld = false;
    let transitionOutcome:
      Promise<{ value?: unknown; error?: unknown }> | undefined;

    try {
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT id FROM service_requests WHERE id = $1 FOR UPDATE',
        [requestDatabaseId(fixture.requestId)],
      );
      blockerHeld = true;

      transitionOutcome = repository
        .updateStatusForProvider(
          fixture.requestId,
          fixture.providerId,
          'on_the_way',
        )
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      await waitForDatabaseCondition(
        pool,
        `SELECT EXISTS (
           SELECT 1
             FROM pg_stat_activity
            WHERE pid <> pg_backend_pid()
              AND datname = current_database()
              AND usename = current_user
              AND wait_event_type = 'Lock'
              AND query LIKE '%FROM service_requests%'
              AND query LIKE '%FOR UPDATE%'
         ) AS ready`,
      );
      const captured = await pool.query<{ captured_at: Date }>(
        'SELECT clock_timestamp() AS captured_at',
      );
      const capturedAt = captured.rows[0]?.captured_at;
      expect(capturedAt).toBeInstanceOf(Date);

      await blocker.query('COMMIT');
      blockerHeld = false;
      const transition = await transitionOutcome;
      expect(transition.error).toBeUndefined();

      const received = await pool.query<{ received_at: Date }>(
        'SELECT clock_timestamp() AS received_at',
      );
      await expect(
        repository.submitProviderLocationSample(
          fixture.requestId,
          fixture.providerId,
          sample(capturedAt),
          received.rows[0]?.received_at,
        ),
      ).rejects.toThrow(
        'Provider location sample predates tracking activation',
      );
      await expect(
        repository.findCurrentProviderPositionForProvider(
          fixture.requestId,
          fixture.providerId,
        ),
      ).resolves.toBeUndefined();
      const arrivalState = await pool.query<{
        arrival_qualifying_sample_count: number;
        arrival_observed_at: Date | null;
      }>(
        `SELECT arrival_qualifying_sample_count, arrival_observed_at
           FROM provider_tracking_sessions
          WHERE service_request_id = $1 AND provider_id = $2`,
        [requestDatabaseId(fixture.requestId), fixture.providerId],
      );
      expect(arrivalState.rows).toEqual([
        {
          arrival_qualifying_sample_count: 0,
          arrival_observed_at: null,
        },
      ]);
    } finally {
      if (blockerHeld) await blocker.query('ROLLBACK');
      if (transitionOutcome) await transitionOutcome;
      blocker.release();
      await pool.end();
    }
  }, 20_000);

  it('replays an identical high-precision payload using database-canonical values', async () => {
    const fixture = await createAssignedTrackingRequest();
    await repository.updateStatusForProvider(
      fixture.requestId,
      fixture.providerId,
      'on_the_way',
    );
    const first = activeSampleTime();
    const second = new Date(first.getTime() + 10_000);
    const highPrecision = {
      latitude: 26.3591234,
      longitude: 43.9819884,
      accuracyMeters: 10.0004,
      capturedAt: first,
    };

    await expect(
      repository.submitProviderLocationSample(
        fixture.requestId,
        fixture.providerId,
        highPrecision,
        first,
      ),
    ).resolves.toMatchObject({
      latitude: 26.359123,
      longitude: 43.981988,
      accuracyMeters: 10,
      duplicate: false,
    });
    await expect(
      repository.submitProviderLocationSample(
        fixture.requestId,
        fixture.providerId,
        highPrecision,
        first,
      ),
    ).resolves.toMatchObject({
      latitude: 26.359123,
      longitude: 43.981988,
      accuracyMeters: 10,
      duplicate: true,
    });

    await repository.submitProviderLocationSample(
      fixture.requestId,
      fixture.providerId,
      sample(second),
      second,
    );
    await expect(
      repository.submitProviderLocationSample(
        fixture.requestId,
        fixture.providerId,
        highPrecision,
        second,
      ),
    ).resolves.toMatchObject({ duplicate: true });
    await expect(
      repository.submitProviderLocationSample(
        fixture.requestId,
        fixture.providerId,
        { ...highPrecision, latitude: 26.3591244 },
        second,
      ),
    ).rejects.toThrow('Provider location sample conflicts with existing data');
  });

  it('rejects conflicting payloads that reuse a captured-at idempotency key', async () => {
    const fixture = await createAssignedTrackingRequest();
    await repository.updateStatusForProvider(
      fixture.requestId,
      fixture.providerId,
      'on_the_way',
    );
    const first = activeSampleTime();
    const second = new Date(first.getTime() + 10_000);
    await repository.submitProviderLocationSample(
      fixture.requestId,
      fixture.providerId,
      sample(first),
      first,
    );

    await expect(
      repository.submitProviderLocationSample(
        fixture.requestId,
        fixture.providerId,
        { ...sample(first), latitude: 26.36 },
        first,
      ),
    ).rejects.toThrow('Provider location sample conflicts with existing data');

    await repository.submitProviderLocationSample(
      fixture.requestId,
      fixture.providerId,
      sample(second),
      second,
    );
    await expect(
      repository.submitProviderLocationSample(
        fixture.requestId,
        fixture.providerId,
        { ...sample(first), accuracyMeters: 11 },
        second,
      ),
    ).rejects.toThrow('Provider location sample conflicts with existing data');
  });

  it.each(['completed', 'cancelled'] as const)(
    'stops and clears current exact position on %s, and terminal samples cannot resurrect it',
    async (terminalStatus) => {
      const fixture = await createAssignedTrackingRequest();
      await repository.updateStatusForProvider(
        fixture.requestId,
        fixture.providerId,
        'on_the_way',
      );
      const capturedAt = activeSampleTime();
      await repository.submitProviderLocationSample(
        fixture.requestId,
        fixture.providerId,
        sample(capturedAt),
        capturedAt,
      );
      if (terminalStatus === 'completed') {
        await repository.updateStatusForProvider(
          fixture.requestId,
          fixture.providerId,
          'in_progress',
        );
        await repository.updateStatusForProvider(
          fixture.requestId,
          fixture.providerId,
          'completed',
        );
      } else {
        await repository.updateStatus(fixture.requestId, 'cancelled');
      }

      await expect(
        repository.findCurrentProviderPositionForProvider(
          fixture.requestId,
          fixture.providerId,
        ),
      ).resolves.toBeUndefined();
      const late = new Date(capturedAt.getTime() + 30_000);
      await expect(
        repository.submitProviderLocationSample(
          fixture.requestId,
          fixture.providerId,
          sample(late),
          late,
        ),
      ).rejects.toThrow('Active provider tracking request not found');
      await expect(
        repository.findCurrentProviderPositionForProvider(
          fixture.requestId,
          fixture.providerId,
        ),
      ).resolves.toBeUndefined();
    },
  );

  it('allows only the owning customer to poll an active current position', async () => {
    const fixture = await createAssignedTrackingRequest();
    const stranger = await repository.upsertCustomer(
      `tracking-${randomUUID()}`,
    );
    await repository.updateStatusForProvider(
      fixture.requestId,
      fixture.providerId,
      'on_the_way',
    );
    const capturedAt = activeSampleTime();
    await repository.submitProviderLocationSample(
      fixture.requestId,
      fixture.providerId,
      sample(capturedAt),
      capturedAt,
    );

    await expect(
      repository.findCurrentProviderPositionForCustomer(
        fixture.requestId,
        fixture.customerId,
      ),
    ).resolves.toMatchObject({ requestId: fixture.requestId });
    await expect(
      repository.findCurrentProviderPositionForCustomer(
        fixture.requestId,
        stranger.id,
      ),
    ).resolves.toBeUndefined();
  });

  it('stops active tracking atomically when the assigned provider is suspended', async () => {
    const fixture = await createAssignedTrackingRequest();
    await repository.updateStatusForProvider(
      fixture.requestId,
      fixture.providerId,
      'on_the_way',
    );
    const capturedAt = activeSampleTime();
    await repository.submitProviderLocationSample(
      fixture.requestId,
      fixture.providerId,
      sample(capturedAt),
      capturedAt,
    );

    await repository.updatePilotProviderVerification(
      fixture.providerId,
      'suspended',
      undefined,
      'verified',
    );

    await expect(
      repository.findCurrentProviderPositionForProvider(
        fixture.requestId,
        fixture.providerId,
      ),
    ).resolves.toBeUndefined();
    await expect(
      repository.submitProviderLocationSample(
        fixture.requestId,
        fixture.providerId,
        sample(new Date(capturedAt.getTime() + 30_000)),
        new Date(capturedAt.getTime() + 30_000),
      ),
    ).rejects.toThrow('Active provider tracking request not found');
  });

  it('serializes tracking start against a concurrent provider suspension', async () => {
    const fixture = await createAssignedTrackingRequest();
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const barrier = await pool.connect();
    const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
    const functionName = `tracking_start_barrier_${suffix}`;
    const triggerName = `tracking_start_barrier_trigger_${suffix}`;
    const advisoryKey = Number.parseInt(suffix.slice(0, 7), 16);
    let barrierHeld = false;
    let startOutcome: Promise<{ value?: unknown; error?: unknown }> | undefined;
    let suspensionOutcome:
      Promise<{ value?: unknown; error?: unknown }> | undefined;

    try {
      await pool.query(
        `CREATE FUNCTION ${functionName}() RETURNS trigger
         LANGUAGE plpgsql AS $$
         BEGIN
           PERFORM pg_advisory_xact_lock(${advisoryKey});
           RETURN NEW;
         END
         $$`,
      );
      await pool.query(
        `CREATE TRIGGER ${triggerName}
         BEFORE INSERT ON provider_tracking_sessions
         FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
      );
      await barrier.query('BEGIN');
      await barrier.query('SELECT pg_advisory_xact_lock($1)', [advisoryKey]);
      barrierHeld = true;

      startOutcome = repository
        .updateStatusForProvider(
          fixture.requestId,
          fixture.providerId,
          'on_the_way',
        )
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      await waitForDatabaseCondition(
        pool,
        `SELECT EXISTS (
           SELECT 1
             FROM pg_stat_activity
            WHERE pid <> pg_backend_pid()
              AND datname = current_database()
              AND usename = current_user
              AND wait_event = 'advisory'
              AND query LIKE '%INSERT INTO provider_tracking_sessions%'
         ) AS ready`,
      );

      suspensionOutcome = repository
        .updatePilotProviderVerification(
          fixture.providerId,
          'suspended',
          undefined,
          'verified',
        )
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      await waitForDatabaseCondition(
        pool,
        `SELECT
           EXISTS (
             SELECT 1 FROM providers
              WHERE id = $1 AND verification_status = 'suspended'
           ) OR EXISTS (
             SELECT 1
               FROM pg_stat_activity
              WHERE pid <> pg_backend_pid()
                AND datname = current_database()
                AND usename = current_user
                AND wait_event_type = 'Lock'
                AND query LIKE '%SELECT verification_status, available%'
                AND query LIKE '%FROM providers%'
           ) AS ready`,
        [fixture.providerId],
      );

      await barrier.query('COMMIT');
      barrierHeld = false;
      const [started, suspended] = await Promise.all([
        startOutcome,
        suspensionOutcome,
      ]);
      expect(started.error).toBeUndefined();
      expect(suspended.error).toBeUndefined();

      const state = await pool.query<{
        verification_status: string;
        active_sessions: number;
      }>(
        `SELECT p.verification_status,
                count(s.*) FILTER (WHERE s.state = 'active')::int AS active_sessions
           FROM providers p
           LEFT JOIN provider_tracking_sessions s ON s.provider_id = p.id
          WHERE p.id = $1
          GROUP BY p.verification_status`,
        [fixture.providerId],
      );
      expect(state.rows).toEqual([
        { verification_status: 'suspended', active_sessions: 0 },
      ]);
    } finally {
      if (barrierHeld) {
        await barrier.query('ROLLBACK');
      }
      if (startOutcome) await startOutcome;
      if (suspensionOutcome) await suspensionOutcome;
      await pool.query(
        `DROP TRIGGER IF EXISTS ${triggerName} ON provider_tracking_sessions`,
      );
      await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
      barrier.release();
      await pool.end();
    }
  }, 20_000);

  it.each([
    ['provider_suspended', 'completed'],
    ['operations_emergency', 'cancelled'],
  ] as const)(
    'terminal reason %s is upgraded deterministically to %s',
    async (initialReason, terminalStatus) => {
      const fixture = await createAssignedTrackingRequest();
      await repository.updateStatusForProvider(
        fixture.requestId,
        fixture.providerId,
        'on_the_way',
      );
      if (terminalStatus === 'completed') {
        await repository.updateStatusForProvider(
          fixture.requestId,
          fixture.providerId,
          'in_progress',
        );
      }
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      try {
        await pool.query(
          `UPDATE provider_tracking_sessions
              SET state = 'stopped', stopped_at = NOW(), stop_reason = $3
            WHERE service_request_id = $1 AND provider_id = $2`,
          [
            requestDatabaseId(fixture.requestId),
            fixture.providerId,
            initialReason,
          ],
        );
        if (terminalStatus === 'completed') {
          await repository.updateStatusForProvider(
            fixture.requestId,
            fixture.providerId,
            'completed',
          );
        } else {
          await repository.updateStatus(fixture.requestId, 'cancelled');
        }
        const stopped = await pool.query<{ stop_reason: string }>(
          `SELECT stop_reason
             FROM provider_tracking_sessions
            WHERE service_request_id = $1`,
          [requestDatabaseId(fixture.requestId)],
        );
        expect(stopped.rows).toEqual([{ stop_reason: terminalStatus }]);
      } finally {
        await pool.end();
      }
    },
  );

  it.each([
    ['completed', 'provider_suspended'],
    ['cancelled', 'operations_emergency'],
  ] as const)(
    'terminal reason %s is not weakened by later %s handling',
    async (terminalStatus, laterReason) => {
      void laterReason;
      const fixture = await createAssignedTrackingRequest();
      await repository.updateStatusForProvider(
        fixture.requestId,
        fixture.providerId,
        'on_the_way',
      );
      if (terminalStatus === 'completed') {
        await repository.updateStatusForProvider(
          fixture.requestId,
          fixture.providerId,
          'in_progress',
        );
        await repository.updateStatusForProvider(
          fixture.requestId,
          fixture.providerId,
          'completed',
        );
        await repository.updatePilotProviderVerification(
          fixture.providerId,
          'suspended',
          undefined,
          'verified',
        );
      } else {
        await repository.updateStatus(fixture.requestId, 'cancelled');
        await repository.stopProviderTrackingForOperations(fixture.requestId);
      }

      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      try {
        const stopped = await pool.query<{ stop_reason: string }>(
          `SELECT stop_reason
             FROM provider_tracking_sessions
            WHERE service_request_id = $1`,
          [requestDatabaseId(fixture.requestId)],
        );
        expect(stopped.rows).toEqual([{ stop_reason: terminalStatus }]);
      } finally {
        await pool.end();
      }
    },
  );

  it('supports an operations emergency stop without forging a request status', async () => {
    const fixture = await createAssignedTrackingRequest();
    await repository.updateStatusForProvider(
      fixture.requestId,
      fixture.providerId,
      'on_the_way',
    );
    const capturedAt = activeSampleTime();
    await repository.submitProviderLocationSample(
      fixture.requestId,
      fixture.providerId,
      sample(capturedAt),
      capturedAt,
    );

    await repository.stopProviderTrackingForOperations(fixture.requestId);

    await expect(
      repository.findCurrentProviderPositionForOperations(fixture.requestId),
    ).resolves.toBeUndefined();
    await expect(
      repository.submitProviderLocationSample(
        fixture.requestId,
        fixture.providerId,
        sample(new Date(capturedAt.getTime() + 30_000)),
        new Date(capturedAt.getTime() + 30_000),
      ),
    ).rejects.toThrow('Active provider tracking request not found');
    await expect(
      repository.findByProviderId(fixture.providerId),
    ).resolves.toEqual([
      expect.objectContaining({ id: fixture.requestId, status: 'on_the_way' }),
    ]);
  });

  it('prunes raw and stopped-session evidence at independent retention cutoffs', async () => {
    const oldFixture = await createAssignedTrackingRequest();
    const retainedFixture = await createAssignedTrackingRequest();
    const oldReceivedAt = new Date('2026-01-01T00:00:00.000Z');
    const cutoff = new Date('2026-02-01T00:00:00.000Z');
    const retainedReceivedAt = new Date('2026-02-01T00:00:00.000Z');
    for (const [fixture] of [
      [oldFixture, oldReceivedAt],
      [retainedFixture, retainedReceivedAt],
    ] as const) {
      await repository.updateStatusForProvider(
        fixture.requestId,
        fixture.providerId,
        'on_the_way',
      );
      await repository.submitProviderLocationSample(
        fixture.requestId,
        fixture.providerId,
        sample(new Date()),
        new Date(),
      );
      await repository.updateStatus(fixture.requestId, 'cancelled');
    }

    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    try {
      await pool.query(
        `UPDATE provider_location_samples
            SET received_at = CASE service_request_id
              WHEN $1 THEN $3::timestamptz
              WHEN $2 THEN $4::timestamptz
            END
          WHERE service_request_id = ANY($5::bigint[])`,
        [
          requestDatabaseId(oldFixture.requestId),
          requestDatabaseId(retainedFixture.requestId),
          oldReceivedAt,
          retainedReceivedAt,
          [
            requestDatabaseId(oldFixture.requestId),
            requestDatabaseId(retainedFixture.requestId),
          ],
        ],
      );
      await pool.query(
        `UPDATE provider_tracking_sessions
            SET stopped_at = CASE service_request_id
              WHEN $1 THEN $3::timestamptz
              WHEN $2 THEN $4::timestamptz
            END
          WHERE service_request_id = ANY($5::bigint[])`,
        [
          requestDatabaseId(oldFixture.requestId),
          requestDatabaseId(retainedFixture.requestId),
          oldReceivedAt,
          retainedReceivedAt,
          [
            requestDatabaseId(oldFixture.requestId),
            requestDatabaseId(retainedFixture.requestId),
          ],
        ],
      );

      await expect(
        repository.pruneProviderTrackingData(cutoff, cutoff),
      ).resolves.toEqual({ rawSamplesDeleted: 1, sessionsDeleted: 1 });
      const retained = await pool.query<{ request_id: string }>(
        `SELECT service_request_id::text AS request_id
           FROM provider_tracking_sessions
          WHERE service_request_id = ANY($1::bigint[])
          ORDER BY service_request_id`,
        [
          [
            requestDatabaseId(oldFixture.requestId),
            requestDatabaseId(retainedFixture.requestId),
          ],
        ],
      );
      expect(retained.rows).toEqual([
        { request_id: String(requestDatabaseId(retainedFixture.requestId)) },
      ]);
    } finally {
      await pool.end();
    }
  });

  it('bounds each retention invocation by the requested batch size', async () => {
    const fixtures = await Promise.all([
      createAssignedTrackingRequest(),
      createAssignedTrackingRequest(),
    ]);
    const oldReceivedAt = new Date('2026-01-01T00:00:00.000Z');
    const cutoff = new Date('2026-02-01T00:00:00.000Z');
    for (const fixture of fixtures) {
      await repository.updateStatusForProvider(
        fixture.requestId,
        fixture.providerId,
        'on_the_way',
      );
      await repository.submitProviderLocationSample(
        fixture.requestId,
        fixture.providerId,
        sample(new Date()),
        new Date(),
      );
      await repository.updateStatus(fixture.requestId, 'cancelled');
    }
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    try {
      await pool.query(
        `UPDATE provider_location_samples
            SET received_at = $1
          WHERE service_request_id = ANY($2::bigint[])`,
        [
          oldReceivedAt,
          fixtures.map((fixture) => requestDatabaseId(fixture.requestId)),
        ],
      );
      await pool.query(
        `UPDATE provider_tracking_sessions
            SET stopped_at = $1
          WHERE service_request_id = ANY($2::bigint[])`,
        [
          oldReceivedAt,
          fixtures.map((fixture) => requestDatabaseId(fixture.requestId)),
        ],
      );

      await expect(
        repository.pruneProviderTrackingData(cutoff, cutoff, 1),
      ).resolves.toEqual({ rawSamplesDeleted: 1, sessionsDeleted: 1 });
      const remaining = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM provider_tracking_sessions
          WHERE service_request_id = ANY($1::bigint[])`,
        [fixtures.map((fixture) => requestDatabaseId(fixture.requestId))],
      );
      expect(remaining.rows).toEqual([{ count: 1 }]);
    } finally {
      await pool.end();
    }
  });

  async function waitForDatabaseCondition(
    pool: Pool,
    sql: string,
    params: unknown[] = [],
  ): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await pool.query<{ ready: boolean }>(sql, params);
      if (result.rows[0]?.ready === true) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(
      'Timed out waiting for deterministic database interleaving',
    );
  }

  async function createAssignedTrackingRequest() {
    const serviceId = `tracking-${randomUUID()}`;
    const provider = await repository.createPilotProvider({
      name: `Tracking provider ${randomUUID().slice(0, 8)}`,
      specialties: [serviceId],
      serviceZone: 'بريدة',
    });
    await repository.updatePilotProviderVerification(provider.id, 'verified');
    const customer = await repository.upsertCustomer(
      `tracking-${randomUUID()}`,
    );
    const request = await repository.create(
      {
        serviceId,
        address: 'حي الصفراء، بريدة',
        timing: 'as-soon-as-possible',
        location: {
          point: { latitude: 26.359123, longitude: 43.981988 },
          displayAddress: 'حي الصفراء، بريدة',
          source: 'map_pin',
          confirmedAt: '2026-08-21T11:00:00.000Z',
        },
      },
      customer.id,
    );
    await repository.assignProvider(request.id, provider.id);
    return {
      requestId: request.id,
      providerId: provider.id,
      customerId: customer.id,
    };
  }

  function sample(capturedAt: Date) {
    return {
      latitude: 26.359123,
      longitude: 43.981988,
      accuracyMeters: 10,
      capturedAt,
    };
  }

  function activeSampleTime(): Date {
    return new Date(Date.now() + 1_000);
  }

  function requestDatabaseId(requestId: string): number {
    return Number(requestId.slice(4)) - 1000;
  }
});

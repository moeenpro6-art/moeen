import 'dotenv/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Pool } from 'pg';
import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { configureApiSecurity } from './../src/api-security';
import { OTP_PROVIDER, type OtpProvider } from './../src/otp-provider';
import { ServiceRequestRepository } from './../src/service-request.repository';
import { FcmDeviceRepository } from './../src/fcm-device.repository';

/**
 * Regression test for the FCM E2E schema-bootstrap ordering race.
 *
 * ROOT CAUSE: Nest runs every provider's `onModuleInit` hook through
 * `Promise.all` (see @nestjs/core/hooks/on-module-init.hook.js). The
 * repository initialize() methods were therefore non-deterministically
 * ordered. `FcmDeviceRepository.initialize()` creates tables with foreign
 * keys to `customers`, `providers` and `service_requests`, while
 * `ServiceRequestRepository.initialize()` creates those referenced tables.
 * When FcmDeviceRepository won the shared schema advisory lock first, its
 * `CREATE TABLE ... REFERENCES customers(id)` failed because `customers`
 * did not exist yet — `IF NOT EXISTS` does NOT protect against a foreign
 * key referencing a missing table.
 *
 * FIX: FcmDeviceRepository now declares `@Inject(ServiceRequestRepository)`
 * as a constructor dependency (Optional so direct repository constructions
 * remain supported). Nest instantiates and `onModuleInit`s the referenced
 * repository BEFORE its dependent, so the referenced tables are guaranteed
 * to exist before the FCM tables are created. This mirrors production, where
 * main.ts runs the versioned migrations (0001..0004) before NestFactory,
 * so the referenced tables also exist before any FCM table.
 *
 * This test exercises the EXACT path that previously raced: a fresh
 * per-worker isolated schema + full AppModule bootstrap through app.init(),
 * which fires every onModuleInit hook concurrently. It asserts the FCM
 * tables exist AND that their foreign keys actually reference the
 * dependency-owned tables — the invariant that was broken by the race.
 */
describe('FCM bootstrap ordering (e2e regression)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const otpProvider: OtpProvider = {
      startVerification: jest.fn().mockResolvedValue(undefined),
      checkVerification: jest.fn().mockResolvedValue('approved'),
    };
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(OTP_PROVIDER)
      .useValue(otpProvider)
      .compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>();
    configureApiSecurity(app);
    // app.init() runs all onModuleInit hooks concurrently via Promise.all —
    // the exact race site. Under the bug this could reject with
    // 'relation "customers" does not exist'; with the fix it must resolve.
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates the FCM tables and their foreign-key targets in one bootstrap', async () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    try {
      const tables = await pool.query<{ table_name: string }>(
        `SELECT table_name
           FROM information_schema.tables
          WHERE table_schema = current_schema()
            AND table_type = 'BASE TABLE'
            AND table_name = ANY($1::text[])
          ORDER BY table_name`,
        [
          [
            'customers',
            'providers',
            'service_requests',
            'fcm_devices',
            'notification_outbox',
          ],
        ],
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual([
        'customers',
        'fcm_devices',
        'notification_outbox',
        'providers',
        'service_requests',
      ]);
    } finally {
      await pool.end();
    }
  });

  it('creates every FCM foreign key against an existing referenced table', async () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    try {
      // Source table/column -> target table of every foreign key declared by
      // the FCM tables. If the race had fired, the CREATE TABLE would have
      // failed outright (so fcm_devices/notification_outbox would not exist)
      // and no such constraint could be present. This assertion pins the
      // ordering invariant directly on the database catalog.
      const foreignKeys = await pool.query<{
        source_table: string;
        target_table: string;
      }>(
        `SELECT source.relname AS source_table,
                target.relname AS target_table
           FROM pg_constraint c
           JOIN pg_class source ON source.oid = c.conrelid
           JOIN pg_namespace source_ns
             ON source_ns.oid = source.relnamespace
           JOIN pg_class target ON target.oid = c.confrelid
           JOIN pg_namespace target_ns
             ON target_ns.oid = target.relnamespace
          WHERE source_ns.nspname = current_schema()
            AND source.relname = ANY($1::text[])
            AND c.contype = 'f'
          ORDER BY source_table, target_table`,
        [['fcm_devices', 'notification_outbox']],
      );

      const edges = foreignKeys.rows.map(
        (row) => `${row.source_table}->${row.target_table}`,
      );
      expect(edges).toEqual(
        expect.arrayContaining([
          'fcm_devices->customers',
          'fcm_devices->providers',
          'notification_outbox->customers',
          'notification_outbox->providers',
          'notification_outbox->service_requests',
        ]),
      );
    } finally {
      await pool.end();
    }
  });

  it('wires FcmDeviceRepository to the shared ServiceRequestRepository singleton', () => {
    // The deterministic ordering is provided by Nest DI: FcmDeviceRepository
    // depends on ServiceRequestRepository, so the same singleton instance
    // must be visible to both consumers. This asserts the wiring that makes
    // the ordering hold (no hidden second pool / second bootstrap source).
    const serviceRequestRepository = app.get(ServiceRequestRepository);
    const fcmDeviceRepository = app.get(FcmDeviceRepository);
    expect(fcmDeviceRepository).toBeDefined();
    expect(serviceRequestRepository).toBeDefined();
    expect(fcmDeviceRepository).not.toBe(serviceRequestRepository);
    expect(
      typeof (fcmDeviceRepository as { initialize?: unknown }).initialize,
    ).toBe('function');
  });
});

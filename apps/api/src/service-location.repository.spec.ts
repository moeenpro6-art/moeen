import { randomUUID } from 'node:crypto';
import { ServiceRequestRepository } from './service-request.repository';
import { fcmConfigFromEnvironment } from './fcm.config';
import { NotificationOutboxWriter } from './notification-outbox.writer';

const databaseUrl = process.env.TEST_DATABASE_URL;

(databaseUrl ? describe : describe.skip)(
  'service request location persistence',
  () => {
    let repository: ServiceRequestRepository;

    beforeAll(async () => {
      repository = new ServiceRequestRepository(
        new NotificationOutboxWriter(fcmConfigFromEnvironment(process.env)),
      );
      await repository.initialize();
    });

    afterAll(async () => {
      await repository.onModuleDestroy();
    });

    it('persists canonical location atomically and returns it to customer/staff reads', async () => {
      const customer = await repository.upsertCustomer(
        `+9665${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`,
      );
      const location = {
        point: { latitude: 26.359123, longitude: 43.981988 },
        displayAddress: 'حي الصفراء، بريدة',
        source: 'map_pin' as const,
        confirmedAt: '2026-08-21T12:00:00.000Z',
      };
      const created = await repository.create(
        {
          serviceId: `location-${randomUUID()}`,
          address: location.displayAddress,
          timing: 'scheduled',
          location,
        },
        customer.id,
      );

      expect(created.location).toEqual(location);
      await expect(repository.findByCustomerId(customer.id)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: created.id, location }),
        ]),
      );
      await expect(repository.findAll()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: created.id, location }),
        ]),
      );
    });

    it('returns the persisted location on an idempotent replay lookup', async () => {
      const customer = await repository.upsertCustomer(
        `+9665${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`,
      );
      const key = randomUUID();
      const location = {
        point: { latitude: 26.301111, longitude: 43.901111 },
        displayAddress: 'حي الريان، بريدة',
        source: 'current_location' as const,
        confirmedAt: '2026-08-21T12:00:00.000Z',
      };
      const created = await repository.create(
        {
          serviceId: `location-${randomUUID()}`,
          address: location.displayAddress,
          timing: 'scheduled',
          location,
        },
        customer.id,
        { clientSubmissionId: key, submissionFingerprint: 'f'.repeat(64) },
      );

      await expect(
        repository.findRequestByCustomerSubmission(customer.id, key),
      ).resolves.toMatchObject({ id: created.id, location });
    });
  },
);

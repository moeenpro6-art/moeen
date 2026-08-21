import { BadRequestException } from '@nestjs/common';
import {
  arrivalSampleQualifies,
  evaluateObservedArrival,
  haversineDistanceMeters,
  validateProviderLocationSample,
} from './provider-tracking';

describe('provider tracking arrival engine', () => {
  it('calculates Haversine distance deterministically', () => {
    expect(
      haversineDistanceMeters(
        { latitude: 26.359123, longitude: 43.981988 },
        { latitude: 26.359123, longitude: 43.981988 },
      ),
    ).toBe(0);
    expect(
      haversineDistanceMeters(
        { latitude: 0, longitude: 0 },
        { latitude: 0.001, longitude: 0 },
      ),
    ).toBeCloseTo(111.195, 3);
  });

  it('qualifies only samples within 100 metres and no worse than 50 metres accuracy', () => {
    expect(arrivalSampleQualifies(100, 50)).toBe(true);
    expect(arrivalSampleQualifies(100.001, 50)).toBe(false);
    expect(arrivalSampleQualifies(99, 50.001)).toBe(false);
  });

  it.each([
    [1, '2026-08-21T12:00:00.000Z', '2026-08-21T12:01:00.000Z'],
    [2, '2026-08-21T12:00:00.000Z', '2026-08-21T12:01:00.000Z'],
    [3, '2026-08-21T12:00:00.000Z', '2026-08-21T12:00:29.999Z'],
  ])(
    'does not observe arrival from %i qualifying samples over an insufficient span',
    (qualifyingSampleCount, firstCapturedAt, lastCapturedAt) => {
      expect(
        evaluateObservedArrival({
          qualifyingSampleCount,
          firstQualifyingCapturedAt: new Date(firstCapturedAt),
          lastQualifyingCapturedAt: new Date(lastCapturedAt),
        }),
      ).toBe(false);
    },
  );

  it('observes arrival from three qualifying samples spanning at least 30 seconds', () => {
    expect(
      evaluateObservedArrival({
        qualifyingSampleCount: 3,
        firstQualifyingCapturedAt: new Date('2026-08-21T12:00:00.000Z'),
        lastQualifyingCapturedAt: new Date('2026-08-21T12:00:30.000Z'),
      }),
    ).toBe(true);
  });
});

describe('provider location sample contract', () => {
  const receivedAt = new Date('2026-08-21T12:00:00.000Z');

  it('accepts the minimal operational sample and ignores no extra metadata', () => {
    expect(
      validateProviderLocationSample(
        {
          latitude: 26.359123,
          longitude: 43.981988,
          accuracyMeters: 12.5,
          capturedAt: '2026-08-21T11:59:50.000Z',
        },
        receivedAt,
      ),
    ).toEqual({
      latitude: 26.359123,
      longitude: 43.981988,
      accuracyMeters: 12.5,
      capturedAt: new Date('2026-08-21T11:59:50.000Z'),
    });
  });

  it.each([
    [
      {
        latitude: Number.NaN,
        longitude: 0,
        accuracyMeters: 1,
        capturedAt: receivedAt.toISOString(),
      },
    ],
    [
      {
        latitude: 91,
        longitude: 0,
        accuracyMeters: 1,
        capturedAt: receivedAt.toISOString(),
      },
    ],
    [
      {
        latitude: 0,
        longitude: Number.POSITIVE_INFINITY,
        accuracyMeters: 1,
        capturedAt: receivedAt.toISOString(),
      },
    ],
    [
      {
        latitude: 0,
        longitude: -181,
        accuracyMeters: 1,
        capturedAt: receivedAt.toISOString(),
      },
    ],
    [
      {
        latitude: 0,
        longitude: 0,
        accuracyMeters: -1,
        capturedAt: receivedAt.toISOString(),
      },
    ],
    [
      {
        latitude: 0,
        longitude: 0,
        accuracyMeters: Number.POSITIVE_INFINITY,
        capturedAt: receivedAt.toISOString(),
      },
    ],
    [
      {
        latitude: 0,
        longitude: 0,
        accuracyMeters: 1,
        capturedAt: 'not-a-date',
      },
    ],
    [
      {
        latitude: 0,
        longitude: 0,
        accuracyMeters: 1,
        capturedAt: '2026-08-21T11:54:59.999Z',
      },
    ],
    [
      {
        latitude: 0,
        longitude: 0,
        accuracyMeters: 1,
        capturedAt: '2026-08-21T12:01:00.001Z',
      },
    ],
    [
      {
        latitude: 0,
        longitude: 0,
        accuracyMeters: 1,
        capturedAt: receivedAt.toISOString(),
        speed: 5,
      },
    ],
  ])('rejects invalid, stale, future, or over-broad samples', (input) => {
    expect(() => validateProviderLocationSample(input, receivedAt)).toThrow(
      BadRequestException,
    );
  });
});

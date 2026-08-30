import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decideProviderPoll,
  isProviderPosition,
  providerPositionFreshness,
  providerTrackingAllowedForRole,
  providerTrackingPollAllowed,
} from './request-tracking';

const validPosition = {
  requestId: 'MOE-1042',
  latitude: 26.359123,
  longitude: 43.981988,
  accuracyMeters: 12,
  capturedAt: '2026-08-30T12:00:00.000Z',
  receivedAt: '2026-08-30T12:00:01.000Z',
  arrivalObserved: false,
};

test('isProviderPosition accepts fractional device accuracy', () => {
  assert.equal(
    isProviderPosition({ ...validPosition, accuracyMeters: 9.5 }),
    true,
  );
});

test('isProviderPosition rejects out-of-range or malformed coordinates', () => {
  assert.equal(isProviderPosition({ ...validPosition, latitude: 91 }), false);
  assert.equal(isProviderPosition({ ...validPosition, longitude: -181 }), false);
  assert.equal(isProviderPosition({ ...validPosition, latitude: '26.3' }), false);
  assert.equal(isProviderPosition({ ...validPosition, accuracyMeters: -1 }), false);
  assert.equal(
    isProviderPosition({ ...validPosition, accuracyMeters: Number.POSITIVE_INFINITY }),
    false,
  );
  assert.equal(isProviderPosition(null), false);
});

test('providerPositionFreshness buckets a timestamp by the approved thresholds', () => {
  const now = Date.parse('2026-08-30T12:02:00.000Z');
  assert.equal(
    providerPositionFreshness('2026-08-30T12:01:30.000Z', now),
    'fresh',
  );
  assert.equal(
    providerPositionFreshness('2026-08-30T12:00:30.000Z', now),
    'stale',
  );
  assert.equal(
    providerPositionFreshness('2026-08-30T11:59:00.000Z', now),
    'offline',
  );
  assert.equal(providerPositionFreshness('not-a-date', now), 'offline');
});

test('decideProviderPoll stops on 401, 403 and 404', () => {
  assert.deepEqual(decideProviderPoll(401, {}), { kind: 'stop' });
  assert.deepEqual(decideProviderPoll(403, {}), { kind: 'stop' });
  assert.deepEqual(decideProviderPoll(404, {}), { kind: 'stop' });
});

test('decideProviderPoll returns a live position on 200 with valid body', () => {
  assert.deepEqual(decideProviderPoll(200, validPosition), {
    kind: 'position',
    position: validPosition,
  });
});

test('decideProviderPoll stops on any HTTP or payload error', () => {
  assert.deepEqual(decideProviderPoll(500, {}), { kind: 'stop' });
  assert.deepEqual(decideProviderPoll(200, { latitude: 'x' }), {
    kind: 'stop',
  });
});

test('provider tracking panel is restricted to operations roles', () => {
  assert.equal(providerTrackingAllowedForRole('admin'), true);
  assert.equal(providerTrackingAllowedForRole('dispatcher'), true);
  assert.equal(providerTrackingAllowedForRole('support_agent'), false);
});

test('provider tracking polls only while the request panel and tab are visible', () => {
  assert.equal(providerTrackingPollAllowed(true, 'visible'), true);
  assert.equal(providerTrackingPollAllowed(false, 'visible'), false);
  assert.equal(providerTrackingPollAllowed(true, 'hidden'), false);
});

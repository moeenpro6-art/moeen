import assert from 'node:assert/strict';
import test from 'node:test';
import * as requests from './requests';

const { toDashboardRequest } = requests;

test('toDashboardRequest translates a pending API request for operations staff', () => {
  const request = toDashboardRequest({
    id: 'MOE-1002',
    serviceId: 'upholstery',
    address: 'حي النهضة، بريدة',
    details: 'غسيل كنب',
    timing: 'as-soon-as-possible',
    status: 'pending_dispatch',
    rating: 5,
    ratingComment: 'خدمة ممتازة',
    createdAt: '2026-08-03T16:31:14.598Z',
  });

  assert.deepEqual(request, {
    id: 'MOE-1002',
    serviceId: 'upholstery',
    service: 'غسيل الكنب والمجالس',
    area: 'حي النهضة، بريدة',
    status: 'بانتظار التوزيع',
    provider: 'لم يُعيّن بعد',
    rating: 5,
    ratingComment: 'خدمة ممتازة',
  });
});

test('maps a pending customer quote into an operations-ready Saudi Riyal amount', () => {
  const request = toDashboardRequest({
    id: 'MOE-1003',
    serviceId: 'plumbing',
    address: 'حي الريان، بريدة',
    timing: 'as-soon-as-possible',
    status: 'on_the_way',
    quote: {
      id: 'QTE-7',
      amountHalalas: 15000,
      scope: 'إصلاح تسرب تحت المغسلة',
      status: 'proposed',
    },
    createdAt: '2026-08-05T01:00:00.000Z',
  });

  assert.deepEqual(request.quote, {
    id: 'QTE-7',
    amountHalalas: 15000,
    scope: 'إصلاح تسرب تحت المغسلة',
    status: 'proposed',
  });
});

test('maps a cash-due pilot payment into an operations-ready payment record', () => {
  const request = toDashboardRequest({
    id: 'MOE-1004',
    serviceId: 'plumbing',
    address: 'حي الريان، بريدة',
    timing: 'as-soon-as-possible',
    status: 'completed',
    payment: {
      id: 'PAY-7',
      amountHalalas: 15000,
      currency: 'SAR',
      method: 'cash_on_completion',
      status: 'cash_due',
      createdAt: '2026-08-05T01:00:00.000Z',
    },
    createdAt: '2026-08-05T01:00:00.000Z',
  } as Parameters<typeof toDashboardRequest>[0]);

  assert.deepEqual(
    (request as typeof request & { payment?: unknown }).payment,
    {
      id: 'PAY-7',
      amountHalalas: 15000,
      currency: 'SAR',
      method: 'cash_on_completion',
      status: 'cash_due',
      createdAt: '2026-08-05T01:00:00.000Z',
    },
  );
});

test('translates a provider-assignment event into Arabic for operations staff', () => {
  const eventLabel = (
    requests as typeof requests & {
      requestEventLabel?: (event: { type: string; status: string }) => string;
    }
  ).requestEventLabel;

  assert.equal(typeof eventLabel, 'function');
  assert.equal(
    eventLabel?.({ type: 'provider_assigned', status: 'assigned' }),
    'تم تعيين مقدم الخدمة',
  );
});

test('rejects an API request with a malformed quote payload', () => {
  assert.equal(
    requests.isApiServiceRequest({
      id: 'MOE-1003',
      serviceId: 'plumbing',
      address: 'حي الريان، بريدة',
      timing: 'as-soon-as-possible',
      status: 'on_the_way',
      createdAt: '2026-08-05T01:00:00.000Z',
      quote: { id: 'QTE-7', amountHalalas: '15000', scope: 'إصلاح', status: 'proposed' },
    }),
    false,
  );
});

test('accepts a complete API lifecycle event for the dashboard', () => {
  const isApiServiceRequestEvent = (
    requests as typeof requests & {
      isApiServiceRequestEvent?: (value: unknown) => boolean;
    }
  ).isApiServiceRequestEvent;

  assert.equal(typeof isApiServiceRequestEvent, 'function');
  assert.equal(
    isApiServiceRequestEvent?.({
      type: 'status_updated',
      status: 'on_the_way',
      createdAt: '2026-08-05T01:00:00.000Z',
    }),
    true,
  );
});

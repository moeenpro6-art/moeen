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

test('maps a marketplace provider quote and opportunity summary into the dashboard request', () => {
  const request = toDashboardRequest({
    id: 'MOE-1010',
    serviceId: 'ac-cleaning',
    address: 'حي الصفراء، بريدة',
    timing: 'as-soon-as-possible',
    status: 'pending_dispatch',
    quote: {
      id: 'QTE-9',
      providerId: 'provider-9',
      providerName: 'فريق التبريد السريع',
      amountHalalas: 12000,
      scope: 'تنظيف مكيفين',
      status: 'proposed',
    },
    opportunities: {
      invited: 2,
      quoted: 1,
      withdrawn: 0,
      closed: 0,
      rejected: 0,
      total: 3,
    },
    createdAt: '2026-08-06T01:00:00.000Z',
  });

  assert.deepEqual(request.quote, {
    id: 'QTE-9',
    providerId: 'provider-9',
    providerName: 'فريق التبريد السريع',
    amountHalalas: 12000,
    scope: 'تنظيف مكيفين',
    status: 'proposed',
  });
  assert.deepEqual(request.opportunities, {
    invited: 2,
    quoted: 1,
    withdrawn: 0,
    closed: 0,
    rejected: 0,
    total: 3,
  });
});

test('accepts a withdrawn provider quote alongside its opportunity summary', () => {
  assert.equal(
    requests.isApiServiceRequest({
      id: 'MOE-1011',
      serviceId: 'plumbing',
      address: 'حي الريان، بريدة',
      timing: 'as-soon-as-possible',
      status: 'pending_dispatch',
      quote: {
        id: 'QTE-10',
        providerId: 'provider-9',
        providerName: 'فريق التبريد السريع',
        amountHalalas: 9000,
        scope: 'إصلاح تسرب',
        status: 'withdrawn',
      },
      opportunities: {
        invited: 0,
        quoted: 0,
        withdrawn: 1,
        closed: 1,
        rejected: 0,
        total: 2,
      },
      createdAt: '2026-08-06T02:00:00.000Z',
    }),
    true,
  );
});

test('rejects a request whose opportunity summary is malformed', () => {
  assert.equal(
    requests.isApiServiceRequest({
      id: 'MOE-1012',
      serviceId: 'plumbing',
      address: 'حي الريان، بريدة',
      timing: 'as-soon-as-possible',
      status: 'pending_dispatch',
      opportunities: {
        invited: 'many',
        quoted: 1,
        withdrawn: 0,
        closed: 0,
        rejected: 0,
        total: 2,
      },
      createdAt: '2026-08-06T03:00:00.000Z',
    }),
    false,
  );
});

test('labels marketplace opportunity events in Arabic', () => {
  const eventLabel = (
    requests as typeof requests & {
      requestEventLabel?: (event: { type: string; status: string }) => string;
    }
  ).requestEventLabel;

  assert.equal(typeof eventLabel, 'function');
  assert.equal(
    eventLabel?.({ type: 'opportunity_invited', status: 'pending_dispatch' }),
    'تمت دعوة مقدم خدمة من السوق',
  );
  assert.equal(
    eventLabel?.({ type: 'opportunity_closed', status: 'assigned' }),
    'أُغلقت فرصة السوق',
  );
  assert.equal(
    eventLabel?.({
      type: 'provider_quote_submitted',
      status: 'pending_dispatch',
    }),
    'قدّم مقدم الخدمة عرضًا من السوق',
  );
  assert.equal(
    eventLabel?.({
      type: 'provider_quote_withdrawn',
      status: 'pending_dispatch',
    }),
    'سحب مقدم الخدمة عرضه',
  );
});

test('toDashboardRequest carries request images ordered by server sortOrder', () => {
  const request = toDashboardRequest({
    id: 'MOE-1020',
    serviceId: 'ac-cleaning',
    address: 'حي الصفراء، بريدة',
    timing: 'as-soon-as-possible',
    status: 'pending_dispatch',
    images: [
      {
        id: 'img-2',
        mimeType: 'image/jpeg',
        byteSize: 2048,
        sortOrder: 1,
        url: 'https://signed.example.test/img-2?sig=b',
        urlExpiresAt: '2026-08-17T12:00:00.000Z',
      },
      {
        id: 'img-1',
        mimeType: 'image/jpeg',
        byteSize: 1024,
        sortOrder: 0,
        url: 'https://signed.example.test/img-1?sig=a',
      },
    ],
    createdAt: '2026-08-06T04:00:00.000Z',
  });

  assert.deepEqual(
    request.images?.map((image) => image.sortOrder),
    [0, 1],
  );
  assert.deepEqual(
    request.images?.map((image) => image.id),
    ['img-1', 'img-2'],
  );
});

test('toDashboardRequest omits images for a zero-image request', () => {
  const request = toDashboardRequest({
    id: 'MOE-1021',
    serviceId: 'plumbing',
    address: 'حي الريان، بريدة',
    timing: 'as-soon-as-possible',
    status: 'pending_dispatch',
    createdAt: '2026-08-06T05:00:00.000Z',
  });

  assert.equal('images' in request, false);
});

test('accepts a request with valid signed image entries', () => {
  assert.equal(
    requests.isApiServiceRequest({
      id: 'MOE-1022',
      serviceId: 'ac-cleaning',
      address: 'حي الصفراء، بريدة',
      timing: 'scheduled',
      status: 'pending_dispatch',
      images: [
        {
          id: 'img-1',
          mimeType: 'image/jpeg',
          byteSize: 1024,
          sortOrder: 0,
          url: 'https://signed.example.test/img-1?sig=a',
        },
      ],
      createdAt: '2026-08-06T06:00:00.000Z',
    }),
    true,
  );
});

test('rejects a request with a non-http(s) image URL', () => {
  assert.equal(
    requests.isApiServiceRequest({
      id: 'MOE-1023',
      serviceId: 'ac-cleaning',
      address: 'حي الصفراء، بريدة',
      timing: 'scheduled',
      status: 'pending_dispatch',
      images: [
        {
          id: 'img-1',
          mimeType: 'image/jpeg',
          byteSize: 1024,
          sortOrder: 0,
          url: 'javascript:alert(1)',
        },
      ],
      createdAt: '2026-08-06T07:00:00.000Z',
    }),
    false,
  );
});

test('rejects a request with malformed image entries', () => {
  assert.equal(
    requests.isApiServiceRequest({
      id: 'MOE-1024',
      serviceId: 'ac-cleaning',
      address: 'حي الصفراء، بريدة',
      timing: 'scheduled',
      status: 'pending_dispatch',
      images: [
        {
          id: 'img-1',
          mimeType: 'image/jpeg',
          byteSize: '1024',
          sortOrder: 0,
          url: 'https://signed.example.test/img-1',
        },
      ],
      createdAt: '2026-08-06T08:00:00.000Z',
    }),
    false,
  );
});

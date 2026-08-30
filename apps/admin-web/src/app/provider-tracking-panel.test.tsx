import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProviderTrackingContent } from './provider-tracking-content';
import { createProviderTrackingPoller } from './provider-tracking-poller';
import { ProviderTrackingSlot } from './provider-tracking-slot';

const position = {
  requestId: 'MOE-1042',
  latitude: 26.359123,
  longitude: 43.981988,
  accuracyMeters: 9.5,
  capturedAt: '2026-08-30T12:00:00.000Z',
  receivedAt: '2026-08-30T12:00:01.000Z',
  arrivalObserved: true,
};

const classes = {
  providerTracking: 'providerTracking',
  trackingHint: 'trackingHint',
  trackingFresh: 'trackingFresh',
  trackingStale: 'trackingStale',
  trackingOffline: 'trackingOffline',
  trackingArrived: 'trackingArrived',
  trackingMap: 'trackingMap',
  trackingMarker: 'trackingMarker',
  providerMarker: 'providerMarker',
  serviceMarker: 'serviceMarker',
  trackingMapLegend: 'trackingMapLegend',
};

test('ProviderTrackingSlot renders only for live requests and operations roles', () => {
  const renderPanel = (role: 'admin' | 'dispatcher' | 'support_agent', status: string) =>
    renderToStaticMarkup(
      <ProviderTrackingSlot
        role={role}
        status={status}
        requestId="MOE-1042"
        renderPanel={(requestId) => <span>panel:{requestId}</span>}
      />,
    );

  assert.match(renderPanel('admin', 'on_the_way'), /panel:MOE-1042/);
  assert.match(renderPanel('dispatcher', 'in_progress'), /panel:MOE-1042/);
  assert.equal(renderPanel('support_agent', 'on_the_way'), '');
  assert.equal(renderPanel('admin', 'completed'), '');
});

test('ProviderTrackingContent renders fractional accuracy, both markers, freshness, and arrival', () => {
  const html = renderToStaticMarkup(
    <ProviderTrackingContent
      requestId="MOE-1042"
      state={{ kind: 'position', position }}
      now={Date.parse('2026-08-30T12:00:20.000Z')}
      serviceLocation={{ latitude: 26.36, longitude: 43.98 }}
      classes={classes}
    />,
  );

  assert.match(html, /الموقع محدّث الآن/);
  assert.match(html, /الدقة ±9.5م/);
  assert.match(html, /وصل الفني إلى موقع الخدمة/);
  assert.match(html, /title="موقع الفني"/);
  assert.match(html, /title="موقع الخدمة"/);
});

test('ProviderTrackingContent renders a safe unavailable state after an error', () => {
  const html = renderToStaticMarkup(
    <ProviderTrackingContent
      requestId="MOE-1042"
      state={{ kind: 'unavailable' }}
      now={Date.parse('2026-08-30T12:00:20.000Z')}
      classes={classes}
    />,
  );

  assert.match(html, /موقع الفني غير متاح الآن/);
  assert.doesNotMatch(html, /title="موقع الفني"/);
});

test('poller pauses while closed or hidden, resumes when visible, and stops on close disposal', async () => {
  let open = false;
  let visible = true;
  let fetchCalls = 0;
  let scheduled: (() => void) | undefined;
  const poller = createProviderTrackingPoller({
    canPoll: () => open && visible,
    fetchPosition: async () => {
      fetchCalls += 1;
      return { status: 200, body: position };
    },
    onPosition: () => {},
    onUnavailable: () => assert.fail('position should remain available'),
    schedule: (callback) => {
      scheduled = callback;
      return 1;
    },
    cancelScheduled: () => {
      scheduled = undefined;
    },
  });

  await poller.sync();
  assert.equal(fetchCalls, 0);

  open = true;
  await poller.sync();
  assert.equal(fetchCalls, 1);
  assert.ok(scheduled);

  visible = false;
  await poller.sync();
  assert.equal(scheduled, undefined);
  assert.equal(fetchCalls, 1);

  visible = true;
  await poller.sync();
  assert.equal(fetchCalls, 2);

  const callbackAfterDispose = scheduled as (() => void) | undefined;
  poller.dispose();
  if (callbackAfterDispose) callbackAfterDispose();
  await Promise.resolve();
  assert.equal(fetchCalls, 2);
});

test('poller aborts an in-flight hidden request and accepts a fresh response after resume', async () => {
  let visible = true;
  let firstSignal: AbortSignal | undefined;
  let fetchCalls = 0;
  let resolveFirst: ((result: { status: number; body: unknown }) => void) | undefined;
  const firstResponse = new Promise<{ status: number; body: unknown }>((resolve) => {
    resolveFirst = resolve;
  });
  const rendered: string[] = [];
  const poller = createProviderTrackingPoller({
    canPoll: () => visible,
    fetchPosition: async (signal) => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        firstSignal = signal;
        return firstResponse;
      }
      return { status: 200, body: { ...position, requestId: 'MOE-newer' } };
    },
    onPosition: (value) => rendered.push(value.requestId),
    onUnavailable: () => assert.fail('visibility abort is not an error'),
    schedule: () => 1,
    cancelScheduled: () => {},
  });

  const firstPoll = poller.sync();
  visible = false;
  await poller.sync();
  assert.equal(firstSignal?.aborted, true);

  visible = true;
  await poller.sync();
  assert.deepEqual(rendered, ['MOE-newer']);

  resolveFirst?.({ status: 200, body: position });
  await firstPoll;
  assert.deepEqual(rendered, ['MOE-newer']);
});

test('poller stops permanently after HTTP, malformed payload, or network errors', async () => {
  const errorFetches: Array<
    (signal: AbortSignal) => Promise<{ status: number; body: unknown }>
  > = [
    async () => ({ status: 500, body: {} }),
    async () => ({ status: 200, body: { latitude: 'bad' } }),
    async () => {
      throw new Error('offline');
    },
  ];
  for (const fetchPosition of errorFetches) {
    let unavailableCalls = 0;
    let fetchCalls = 0;
    let scheduledCalls = 0;
    const poller = createProviderTrackingPoller({
      canPoll: () => true,
      fetchPosition: async (signal) => {
        fetchCalls += 1;
        return fetchPosition(signal);
      },
      onPosition: () => assert.fail('invalid response must not render'),
      onUnavailable: () => {
        unavailableCalls += 1;
      },
      schedule: () => {
        scheduledCalls += 1;
        return 1;
      },
      cancelScheduled: () => {},
    });

    await poller.sync();
    await poller.sync();
    assert.equal(fetchCalls, 1);
    assert.equal(unavailableCalls, 1);
    assert.equal(scheduledCalls, 0);
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderLocationGetHandler } from './route';

test('provider-location BFF returns 401 without reading upstream when the staff cookie is absent', async () => {
  let upstreamCalls = 0;
  const get = createProviderLocationGetHandler({
    apiBaseUrl: 'https://api.example.test',
    readToken: async () => undefined,
    fetchUpstream: async () => {
      upstreamCalls += 1;
      return Response.json({});
    },
  });

  const response = await get(new Request('https://dashboard.example.test'), {
    params: Promise.resolve({ id: 'MOE-1042' }),
  });

  assert.equal(response.status, 401);
  assert.equal(upstreamCalls, 0);
});

test('provider-location BFF keeps the bearer credential server-side and relays the upstream response', async () => {
  let upstreamUrl = '';
  let upstreamInit: RequestInit | undefined;
  const get = createProviderLocationGetHandler({
    apiBaseUrl: 'https://api.example.test',
    readToken: async () => 'server-cookie-token',
    fetchUpstream: async (input, init) => {
      upstreamUrl = input;
      upstreamInit = init;
      return Response.json(
        { requestId: 'MOE-1042', accuracyMeters: 9.5 },
        { status: 200 },
      );
    },
  });

  const response = await get(new Request('https://dashboard.example.test'), {
    params: Promise.resolve({ id: 'MOE/1042' }),
  });

  assert.equal(
    upstreamUrl,
    'https://api.example.test/service-requests/MOE%2F1042/provider-location',
  );
  assert.equal(
    new Headers(upstreamInit?.headers).get('Authorization'),
    'Bearer server-cookie-token',
  );
  assert.equal(upstreamInit?.cache, 'no-store');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    requestId: 'MOE-1042',
    accuracyMeters: 9.5,
  });
});

test('provider-location BFF maps an upstream transport failure to 502', async () => {
  const get = createProviderLocationGetHandler({
    apiBaseUrl: 'https://api.example.test',
    readToken: async () => 'server-cookie-token',
    fetchUpstream: async () => {
      throw new Error('network unavailable');
    },
  });

  const response = await get(new Request('https://dashboard.example.test'), {
    params: Promise.resolve({ id: 'MOE-1042' }),
  });

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {});
});

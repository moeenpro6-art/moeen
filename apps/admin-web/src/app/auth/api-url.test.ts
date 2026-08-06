import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDashboardApiBaseUrl } from './api-url';

test('requires an HTTPS API URL in production', () => {
  assert.throws(
    () => resolveDashboardApiBaseUrl({ NODE_ENV: 'production' }),
    /MOEEN_API_URL must be configured in production/,
  );
  assert.throws(
    () =>
      resolveDashboardApiBaseUrl({
        NODE_ENV: 'production',
        MOEEN_API_URL: 'http://api.moeen.example',
      }),
    /must use HTTPS in production/,
  );
});

test('normalizes a configured production HTTPS API URL', () => {
  assert.equal(
    resolveDashboardApiBaseUrl({
      NODE_ENV: 'production',
      MOEEN_API_URL: 'https://api.moeen.example/',
    }),
    'https://api.moeen.example',
  );
});

test('keeps the localhost development default', () => {
  assert.equal(
    resolveDashboardApiBaseUrl({ NODE_ENV: 'development' }),
    'http://localhost:3002',
  );
});

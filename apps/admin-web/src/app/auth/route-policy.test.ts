import assert from 'node:assert/strict';
import test from 'node:test';
import { dashboardProxyRedirect } from './route-policy';

test('dashboardProxyRedirect sends anonymous root visitors to login', () => {
  assert.equal(dashboardProxyRedirect('/', false), '/login');
  assert.equal(dashboardProxyRedirect('/', true), undefined);
});

test('dashboardProxyRedirect does not trap a stale-cookie user away from login', () => {
  assert.equal(dashboardProxyRedirect('/login', true), undefined);
  assert.equal(dashboardProxyRedirect('/login', false), undefined);
});

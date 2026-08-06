import assert from 'node:assert/strict';
import test from 'node:test';
import {
  apiAuthorizationHeaders,
  staffActionFailureRedirect,
  staffSessionFailureRedirect,
  toStaffLogin,
} from './api-client';

test('apiAuthorizationHeaders forwards an opaque staff session only as a Bearer header', () => {
  assert.deepEqual(apiAuthorizationHeaders('opaque-session-value'), {
    Authorization: 'Bearer opaque-session-value',
  });
});

test('toStaffLogin accepts a role-safe API login response and rejects malformed data', () => {
  assert.deepEqual(
    toStaffLogin({
      token: 'opaque-session-value',
      staff: {
        id: 'STF-1001',
        email: 'admin@example.test',
        displayName: 'مدير معين',
        role: 'admin',
      },
    }),
    {
      token: 'opaque-session-value',
      staff: {
        id: 'STF-1001',
        email: 'admin@example.test',
        displayName: 'مدير معين',
        role: 'admin',
      },
    },
  );
  assert.equal(toStaffLogin({ token: 7, staff: { role: 'admin' } }), undefined);
});

test('staffSessionFailureRedirect clears an invalid session but preserves a transient service failure for retry', () => {
  assert.equal(staffSessionFailureRedirect(401), '/auth/invalid-session');
  assert.equal(staffSessionFailureRedirect(500), '/login?error=service');
});

test('staffActionFailureRedirect turns unauthorized and forbidden operations into safe navigations', () => {
  assert.equal(staffActionFailureRedirect(401), '/auth/invalid-session');
  assert.equal(staffActionFailureRedirect(403), '/?error=forbidden');
  assert.equal(staffActionFailureRedirect(500), undefined);
});

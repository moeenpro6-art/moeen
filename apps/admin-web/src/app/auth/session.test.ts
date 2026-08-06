import assert from 'node:assert/strict';
import test from 'node:test';
import {
  staffSessionCookieOptions,
  toStaffProfile,
} from './session';

test('staff session cookies are HttpOnly and strict in local and production environments', () => {
  assert.deepEqual(staffSessionCookieOptions(false), {
    httpOnly: true,
    sameSite: 'strict',
    secure: false,
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  });
  assert.equal(staffSessionCookieOptions(true).secure, true);
});

test('toStaffProfile accepts only known staff roles and role-safe profile fields', () => {
  assert.deepEqual(
    toStaffProfile({
      id: 'STF-1001',
      email: 'dispatcher@example.test',
      displayName: 'موظف التشغيل',
      role: 'dispatcher',
    }),
    {
      id: 'STF-1001',
      email: 'dispatcher@example.test',
      displayName: 'موظف التشغيل',
      role: 'dispatcher',
    },
  );
  assert.equal(toStaffProfile({ id: 'STF-1001', role: 'owner' }), undefined);
});

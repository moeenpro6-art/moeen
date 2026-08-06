import assert from 'node:assert/strict';
import test from 'node:test';
import { readLoginFields } from './credentials';

test('readLoginFields normalizes non-empty email and password values', () => {
  const form = new FormData();
  form.set('email', '  ADMIN@example.test ');
  form.set('password', 'test-only password');

  assert.deepEqual(readLoginFields(form), {
    email: 'ADMIN@example.test',
    password: 'test-only password',
  });
});

test('readLoginFields rejects blank or non-string form values', () => {
  const form = new FormData();
  form.set('email', '   ');
  form.set('password', '');
  assert.equal(readLoginFields(form), undefined);
});

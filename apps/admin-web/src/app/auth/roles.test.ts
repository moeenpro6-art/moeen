import assert from 'node:assert/strict';
import test from 'node:test';
import { staffCapabilities } from './roles';

test('staffCapabilities limits dashboard areas by staff role', () => {
  assert.deepEqual(staffCapabilities('admin'), {
    canDispatch: true,
    canSupport: true,
    canViewAudit: true,
  });
  assert.deepEqual(staffCapabilities('dispatcher'), {
    canDispatch: true,
    canSupport: false,
    canViewAudit: false,
  });
  assert.deepEqual(staffCapabilities('support_agent'), {
    canDispatch: false,
    canSupport: true,
    canViewAudit: false,
  });
});

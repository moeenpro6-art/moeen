import type { StaffRole } from './session';

export type StaffCapabilities = {
  canDispatch: boolean;
  canSupport: boolean;
  canViewAudit: boolean;
};

export function staffCapabilities(role: StaffRole): StaffCapabilities {
  return {
    canDispatch: role === 'admin' || role === 'dispatcher',
    canSupport: role === 'admin' || role === 'support_agent',
    canViewAudit: role === 'admin',
  };
}

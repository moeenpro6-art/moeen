import type { ReactNode } from 'react';
import type { StaffRole } from './auth/session';
import { providerTrackingAllowedForRole } from './request-tracking';
import type { ServiceLocationPoint } from './provider-tracking-content';

type ProviderTrackingSlotProps = {
  role: StaffRole;
  status: string;
  requestId: string;
  serviceLocation?: ServiceLocationPoint;
  renderPanel: (
    requestId: string,
    serviceLocation?: ServiceLocationPoint,
  ) => ReactNode;
};

export function ProviderTrackingSlot({
  role,
  status,
  requestId,
  serviceLocation,
  renderPanel,
}: ProviderTrackingSlotProps) {
  if (
    !providerTrackingAllowedForRole(role) ||
    (status !== 'on_the_way' && status !== 'in_progress')
  ) {
    return null;
  }
  return renderPanel(requestId, serviceLocation);
}

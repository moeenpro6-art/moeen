'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ProviderTrackingContent,
  type ProviderTrackingClasses,
  type ProviderTrackingPanelState,
  type ServiceLocationPoint,
} from './provider-tracking-content';
import { createProviderTrackingPoller } from './provider-tracking-poller';
import { providerTrackingPollAllowed } from './request-tracking';
import styles from './page.module.css';

type ProviderTrackingPanelProps = {
  requestId: string;
  serviceLocation?: ServiceLocationPoint;
};

/**
 * Operations-only provider tracking for one open request. It fetches through
 * the server proxy so the staff session token never leaves the HttpOnly cookie.
 * The poller runs only while the request details and tab are visible, and any
 * HTTP, payload, or network error stops polling and clears the position.
 */
export default function ProviderTrackingPanel({
  requestId,
  serviceLocation,
}: ProviderTrackingPanelProps) {
  const [state, setState] = useState<ProviderTrackingPanelState>({
    kind: 'loading',
  });
  const [now, setNow] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const requestDetails = rootRef.current?.closest('details');
    const panelIsOpen = () => requestDetails?.open ?? true;
    const canPoll = () =>
      providerTrackingPollAllowed(panelIsOpen(), document.visibilityState);
    const poller = createProviderTrackingPoller({
      canPoll,
      fetchPosition: async (signal) => {
        const response = await fetch(
          `/api/service-requests/${encodeURIComponent(requestId)}/provider-location`,
          { cache: 'no-store', signal },
        );
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          body = undefined;
        }
        return { status: response.status, body };
      },
      onPosition: (position) => setState({ kind: 'position', position }),
      onUnavailable: () => setState({ kind: 'unavailable' }),
    });
    const onPanelVisibilityChange = () => void poller.sync();

    onPanelVisibilityChange();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    document.addEventListener('visibilitychange', onPanelVisibilityChange);
    requestDetails?.addEventListener('toggle', onPanelVisibilityChange);

    return () => {
      poller.dispose();
      clearInterval(clock);
      document.removeEventListener('visibilitychange', onPanelVisibilityChange);
      requestDetails?.removeEventListener('toggle', onPanelVisibilityChange);
    };
  }, [requestId]);

  return (
    <div ref={rootRef} className={styles.providerTracking}>
      <ProviderTrackingContent
        requestId={requestId}
        state={state}
        now={now}
        serviceLocation={serviceLocation}
        classes={styles as ProviderTrackingClasses}
      />
    </div>
  );
}

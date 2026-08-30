import type { CSSProperties, ReactNode } from 'react';
import {
  providerPositionFreshness,
  type ProviderPosition,
  type ProviderPositionFreshness,
} from './request-tracking';

export type ServiceLocationPoint = { latitude: number; longitude: number };

export type ProviderTrackingPanelState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'position'; position: ProviderPosition };

export type ProviderTrackingClasses = {
  trackingHint: string;
  trackingFresh: string;
  trackingStale: string;
  trackingOffline: string;
  trackingArrived: string;
  trackingMap: string;
  trackingMarker: string;
  providerMarker: string;
  serviceMarker: string;
  trackingMapLegend: string;
};

const freshnessLabels: Record<ProviderPositionFreshness, string> = {
  fresh: 'الموقع محدّث الآن',
  stale: 'آخر موقع قديم قليلاً',
  offline: 'الموقع غير متصل حالياً',
};

function lastUpdatedLabel(receivedAt: string, now: number): string {
  const received = Date.parse(receivedAt);
  if (!Number.isFinite(received)) return 'غير معروف';
  const seconds = Math.max(0, Math.floor((now - received) / 1000));
  if (seconds < 5) return 'الآن';
  if (seconds < 60) return `منذ ${seconds} ثانية`;
  return `منذ ${Math.floor(seconds / 60)} دقيقة`;
}

export function ProviderTrackingContent({
  requestId,
  state,
  now,
  serviceLocation,
  classes,
}: {
  requestId: string;
  state: ProviderTrackingPanelState;
  now: number;
  serviceLocation?: ServiceLocationPoint;
  classes: ProviderTrackingClasses;
}) {
  let content: ReactNode;
  if (state.kind === 'loading') {
    content = <span className={classes.trackingHint}>جارٍ تحميل الموقع…</span>;
  } else if (state.kind === 'unavailable') {
    content = (
      <span className={classes.trackingHint}>
        موقع الفني غير متاح الآن للطلب {requestId}.
      </span>
    );
  } else {
    content = (
      <>
        <ProviderTrackingMap
          position={state.position}
          serviceLocation={serviceLocation}
          classes={classes}
        />
        <ProviderStatusLine
          position={state.position}
          now={now}
          serviceLocation={serviceLocation}
          classes={classes}
        />
      </>
    );
  }

  return (
    <>
      <strong>تتبع الفني</strong>
      {content}
    </>
  );
}

function ProviderStatusLine({
  position,
  now,
  serviceLocation,
  classes,
}: {
  position: ProviderPosition;
  now: number;
  serviceLocation?: ServiceLocationPoint;
  classes: ProviderTrackingClasses;
}) {
  const freshness = providerPositionFreshness(position.receivedAt, now);
  const distance =
    serviceLocation &&
    Number.isFinite(serviceLocation.latitude) &&
    Number.isFinite(serviceLocation.longitude)
      ? haversineMeters(serviceLocation, position)
      : null;
  const toneClass =
    freshness === 'fresh'
      ? classes.trackingFresh
      : freshness === 'stale'
        ? classes.trackingStale
        : classes.trackingOffline;

  return (
    <>
      <span className={toneClass}>{freshnessLabels[freshness]}</span>
      <span className={classes.trackingHint}>
        آخر تحديث: {lastUpdatedLabel(position.receivedAt, now)} · الدقة ±
        {position.accuracyMeters}م
        {distance !== null ? ` · المسافة للموقع ~${distance}م` : ''}
      </span>
      {position.arrivalObserved && (
        <span className={classes.trackingArrived}>
          وصل الفني إلى موقع الخدمة
        </span>
      )}
    </>
  );
}

function ProviderTrackingMap({
  position,
  serviceLocation,
  classes,
}: {
  position: ProviderPosition;
  serviceLocation?: ServiceLocationPoint;
  classes: ProviderTrackingClasses;
}) {
  const validServiceLocation =
    serviceLocation &&
    Number.isFinite(serviceLocation.latitude) &&
    Number.isFinite(serviceLocation.longitude)
      ? serviceLocation
      : undefined;
  const latitudeSpan = validServiceLocation
    ? Math.max(Math.abs(position.latitude - validServiceLocation.latitude), 0.002)
    : 0.002;
  const longitudeSpan = validServiceLocation
    ? Math.max(
        Math.abs(position.longitude - validServiceLocation.longitude),
        0.002,
      )
    : 0.002;
  const centerLatitude = validServiceLocation
    ? (position.latitude + validServiceLocation.latitude) / 2
    : position.latitude;
  const centerLongitude = validServiceLocation
    ? (position.longitude + validServiceLocation.longitude) / 2
    : position.longitude;
  const markerStyle = (point: ServiceLocationPoint): CSSProperties => ({
    insetInlineStart: `${50 + ((point.longitude - centerLongitude) / longitudeSpan) * 45}%`,
    top: `${50 - ((point.latitude - centerLatitude) / latitudeSpan) * 45}%`,
  });

  return (
    <div
      className={classes.trackingMap}
      role="img"
      aria-label="موضع الفني بالنسبة لموقع الخدمة"
    >
      <span
        className={`${classes.trackingMarker} ${classes.providerMarker}`}
        style={markerStyle(position)}
        title="موقع الفني"
      />
      {validServiceLocation && (
        <span
          className={`${classes.trackingMarker} ${classes.serviceMarker}`}
          style={markerStyle(validServiceLocation)}
          title="موقع الخدمة"
        />
      )}
      <span className={classes.trackingMapLegend}>
        الأزرق: الفني · الأخضر: موقع الخدمة
      </span>
    </div>
  );
}

function haversineMeters(
  left: ServiceLocationPoint,
  right: ProviderPosition,
): number {
  const radius = 6371000;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRadians(right.latitude - left.latitude);
  const dLon = toRadians(right.longitude - left.longitude);
  const lat1 = toRadians(left.latitude);
  const lat2 = toRadians(right.latitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return Math.round(radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

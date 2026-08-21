/** Sensitive exact-location keys forbidden from broad audit JSON. */
export const BROAD_AUDIT_LOCATION_FORBIDDEN_FIELDS = [
  'latitude',
  'longitude',
  'location',
  'locationLatitude',
  'locationLongitude',
  'serviceLocation',
  'providerLocation',
  'liveLocation',
  'trackingHistory',
  'coordinates',
  'coordinate',
  'point',
  'mapUrl',
  'mapURL',
  'mapsUrl',
  'mapsURL',
] as const;

const FORBIDDEN_NORMALIZED_KEYS = new Set(
  BROAD_AUDIT_LOCATION_FORBIDDEN_FIELDS.map(normalizeKey),
);

/**
 * Fails closed before exact location can enter broad staff audit old/new JSON.
 * The error identifies only the policy, never the rejected key or value.
 */
export function assertBroadAuditLocationSafe(value: unknown): void {
  if (containsForbiddenLocationKey(value, new Set<object>())) {
    throw new Error('Staff audit state contains forbidden location data');
  }
}

function containsForbiddenLocationKey(
  value: unknown,
  visited: Set<object>,
): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (visited.has(value)) return false;
  visited.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => containsForbiddenLocationKey(item, visited));
  }
  return Object.entries(value).some(
    ([key, child]) =>
      FORBIDDEN_NORMALIZED_KEYS.has(normalizeKey(key)) ||
      containsForbiddenLocationKey(child, visited),
  );
}

function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

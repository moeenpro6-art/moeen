const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_BATCH_SIZE = 1000;
const MAX_RETENTION_BATCH_SIZE = 10_000;

export const PROVIDER_TRACKING_RAW_RETENTION_DAYS = 30;
export const PROVIDER_TRACKING_DERIVED_RETENTION_DAYS = 180;

export function providerTrackingRetentionCutoffs(now = new Date()): {
  rawSamplesBefore: Date;
  derivedEvidenceBefore: Date;
} {
  return {
    rawSamplesBefore: new Date(
      now.getTime() - PROVIDER_TRACKING_RAW_RETENTION_DAYS * DAY_MS,
    ),
    derivedEvidenceBefore: new Date(
      now.getTime() - PROVIDER_TRACKING_DERIVED_RETENTION_DAYS * DAY_MS,
    ),
  };
}

export function providerTrackingRetentionBatchSizeFromEnvironment(
  environment: NodeJS.ProcessEnv,
): number {
  const raw = environment.MOEEN_PROVIDER_TRACKING_RETENTION_BATCH_SIZE;
  if (!raw) return DEFAULT_RETENTION_BATCH_SIZE;
  const batchSize = Number(raw);
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > MAX_RETENTION_BATCH_SIZE
  ) {
    throw new Error('Invalid MOEEN_PROVIDER_TRACKING_RETENTION_BATCH_SIZE');
  }
  return batchSize;
}

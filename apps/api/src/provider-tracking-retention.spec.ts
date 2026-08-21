import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PROVIDER_TRACKING_DERIVED_RETENTION_DAYS,
  PROVIDER_TRACKING_RAW_RETENTION_DAYS,
  providerTrackingRetentionBatchSizeFromEnvironment,
  providerTrackingRetentionCutoffs,
} from './provider-tracking-retention';

describe('provider tracking retention command contract', () => {
  it('uses the approved 30-day raw and 180-day derived cutoffs', () => {
    const now = new Date('2026-08-21T12:00:00.000Z');

    expect(PROVIDER_TRACKING_RAW_RETENTION_DAYS).toBe(30);
    expect(PROVIDER_TRACKING_DERIVED_RETENTION_DAYS).toBe(180);
    expect(providerTrackingRetentionCutoffs(now)).toEqual({
      rawSamplesBefore: new Date('2026-07-22T12:00:00.000Z'),
      derivedEvidenceBefore: new Date('2026-02-22T12:00:00.000Z'),
    });
  });

  it.each([undefined, '', '1000'])(
    'uses a safe bounded batch size for %p',
    (raw) => {
      expect(
        providerTrackingRetentionBatchSizeFromEnvironment({
          MOEEN_PROVIDER_TRACKING_RETENTION_BATCH_SIZE: raw,
        }),
      ).toBe(1000);
    },
  );

  it.each(['0', '-1', '1.5', '10001', 'not-a-number'])(
    'rejects invalid retention batch size %s',
    (raw) => {
      expect(() =>
        providerTrackingRetentionBatchSizeFromEnvironment({
          MOEEN_PROVIDER_TRACKING_RETENTION_BATCH_SIZE: raw,
        }),
      ).toThrow('Invalid MOEEN_PROVIDER_TRACKING_RETENTION_BATCH_SIZE');
    },
  );

  it('runs the production command from the built artifact without ts-node', () => {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.['retention:provider-tracking']).toBe(
      'node dist/scripts/prune-provider-tracking.js',
    );
    expect(packageJson.scripts?.['retention:provider-tracking:dev']).toBe(
      'node -r ts-node/register scripts/prune-provider-tracking.ts',
    );
  });
});

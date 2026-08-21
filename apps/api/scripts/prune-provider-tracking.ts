import 'dotenv/config';
import {
  providerTrackingRetentionBatchSizeFromEnvironment,
  providerTrackingRetentionCutoffs,
} from '../src/provider-tracking-retention';
import { ServiceRequestRepository } from '../src/service-request.repository';

/**
 * One bounded production retention batch for provider tracking.
 * Schedule this command repeatedly (for example, hourly). Each invocation
 * deletes at most the configured batch size from each retention class, uses
 * SKIP LOCKED in the repository, and exits after one transaction.
 */
async function main(): Promise<void> {
  const repository = new ServiceRequestRepository();
  try {
    await repository.initialize();
    const { rawSamplesBefore, derivedEvidenceBefore } =
      providerTrackingRetentionCutoffs();
    const batchSize = providerTrackingRetentionBatchSizeFromEnvironment(
      process.env,
    );
    const result = await repository.pruneProviderTrackingData(
      rawSamplesBefore,
      derivedEvidenceBefore,
      batchSize,
    );
    process.stdout.write(
      `${JSON.stringify({
        ...result,
        batchSize,
        moreWorkLikely:
          result.rawSamplesDeleted === batchSize ||
          result.sessionsDeleted === batchSize,
      })}\n`,
    );
  } finally {
    await repository.close();
  }
}

void main().catch(() => {
  process.stderr.write('Provider tracking retention failed\n');
  process.exitCode = 1;
});

/**
 * Bounded orphan-object reconciliation runner for the request-images
 * namespace.
 *
 * Usage (from apps/api):
 *   npm run reconcile:request-images            # dry-run report (no deletes)
 *   npm run reconcile:request-images -- --apply # actually delete orphans
 *
 * Safety:
 *  - fails fast (exit 1) when request-image storage is disabled or the
 *    configuration is invalid;
 *  - defaults to DRY-RUN; deletion requires an explicit --apply;
 *  - the printed report is sanitized (counts and internal messages only —
 *    no credentials, no signed URLs, no raw storage responses);
 *  - only the request-images/<environment>/ namespace is ever touched, and
 *    only by exact key after a grace period, never deleting keys referenced
 *    by committed service_request_images rows.
 */
import 'dotenv/config';
import { requestImageConfigFromEnvironment } from '../src/request-image.config';
import { S3RequestImageStorage } from '../src/request-image.storage';
import { ServiceRequestRepository } from '../src/service-request.repository';
import {
  DEFAULT_ORPHAN_GRACE_MS,
  RequestImageReconciler,
} from '../src/request-image-reconcile';

const MAX_GRACE_SECONDS = 365 * 24 * 60 * 60;

function gracePeriodFromEnvironment(): number {
  const raw = process.env.REQUEST_IMAGE_ORPHAN_GRACE_SECONDS;
  if (!raw) return DEFAULT_ORPHAN_GRACE_MS;
  const seconds = Number(raw);
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < 0 ||
    seconds > MAX_GRACE_SECONDS
  ) {
    throw new Error('Invalid REQUEST_IMAGE_ORPHAN_GRACE_SECONDS');
  }
  return seconds * 1000;
}

async function main(): Promise<void> {
  const config = requestImageConfigFromEnvironment(process.env);
  if (!config.enabled) {
    console.error('Request image storage is disabled; nothing to reconcile.');
    process.exitCode = 1;
    return;
  }
  const apply = process.argv.includes('--apply');
  const storage = new S3RequestImageStorage(config);
  const repository = new ServiceRequestRepository();
  try {
    await repository.initialize();
    const reconciler = new RequestImageReconciler(storage, repository, {
      prefix: `request-images/${config.environment}/`,
      gracePeriodMs: gracePeriodFromEnvironment(),
      dryRun: !apply,
    });
    const report = await reconciler.reconcile();
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.failures > 0 || report.errors.length > 0 ? 1 : 0;
  } finally {
    await repository.close();
  }
}

void main();

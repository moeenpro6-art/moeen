import type { RequestImageStorage } from './request-image.storage';

export const DEFAULT_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_LIST_PAGE_SIZE = 500;
export const DEFAULT_DB_PAGE_SIZE = 500;
export const DEFAULT_DELETE_BATCH_SIZE = 100;

const MAX_PAGE_SIZE = 1000;
/** Fail-closed reference-set bound; exceeding it aborts before any deletion. */
const MAX_REFERENCED_KEYS = 1_000_000;
/** Bounded storage-listing horizon per run; later pages wait for the next run. */
const MAX_LIST_PAGES = 200;
/**
 * Defensive bound on DB reference pages (500 keys x 10k pages = 5M keys).
 * A lister that never makes progress must abort the run fail-closed instead
 * of looping forever.
 */
const MAX_DB_PAGES = 10_000;

/**
 * Narrow server-side interface for reading the authoritative set of
 * committed `service_request_images` storage keys under a namespace prefix.
 * Implemented by {@link ServiceRequestRepository} and satisfied structurally.
 */
export interface RequestImageKeyLister {
  listImageStorageKeys(
    prefix: string,
    after?: string,
    limit?: number,
  ): Promise<{ keys: string[]; nextAfter?: string }>;
}

export type RequestImageReconcileOptions = {
  /** Exact namespace prefix; must match `request-images/<environment>/`. */
  prefix: string;
  /** Minimum object age before an unreferenced object may be deleted. */
  gracePeriodMs?: number;
  /** Report-only mode; nothing is ever deleted. */
  dryRun?: boolean;
  listPageSize?: number;
  dbPageSize?: number;
  deleteBatchSize?: number;
};

export type RequestImageReconcileReport = {
  prefix: string;
  dryRun: boolean;
  /** Storage objects examined under the prefix. */
  listed: number;
  /** Committed DB reference keys collected under the prefix. */
  referenced: number;
  /** Storage objects that matched a committed DB reference. */
  referencedObjects: number;
  /** Unreferenced objects preserved because they are younger than the grace period. */
  recentOrphans: number;
  /** Unreferenced objects older than the grace period. */
  orphans: number;
  /** Objects actually deleted (0 in dry-run mode). */
  deleted: number;
  /** Deletion or listing failures encountered (exact-key batches only). */
  failures: number;
  /** True when the bounded listing horizon was reached; later pages are left for the next run. */
  truncated: boolean;
  /** Sanitized error messages; never credentials, signed URLs or raw responses. */
  errors: string[];
};

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Sanitized: internal messages only, truncated to stay log-safe.
  return message.slice(0, 200) || 'Unknown reconciliation failure';
}

function boundedSize(value: number | undefined, fallback: number): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) < 1) return fallback;
  return Math.min(value as number, MAX_PAGE_SIZE);
}

/**
 * Bounded orphan-object reconciliation for the request-images namespace.
 *
 * Safety invariants:
 *  - operates ONLY under the validated `request-images/<environment>/`
 *    prefix — unrelated bucket objects are never listed or deleted;
 *  - builds the authoritative DB reference set FIRST; if that read fails
 *    (or exceeds the safety bound) the run aborts without deleting anything
 *    (fail-closed);
 *  - never deletes an object whose key exists in `service_request_images`;
 *  - applies a grace period so active uploads that have not committed yet
 *    are preserved;
 *  - deletes by exact keys in bounded batches only (no prefix deletes);
 *  - honors a bounded listing horizon and reports truncation;
 *  - logs/reports sanitized messages only (no credentials, signed URLs,
 *    or raw provider responses).
 */
export class RequestImageReconciler {
  private readonly prefix: string;
  private readonly gracePeriodMs: number;
  private readonly dryRun: boolean;
  private readonly listPageSize: number;
  private readonly dbPageSize: number;
  private readonly deleteBatchSize: number;
  private readonly now: () => Date;

  constructor(
    private readonly storage: RequestImageStorage,
    private readonly keyLister: RequestImageKeyLister,
    options: RequestImageReconcileOptions,
    now: () => Date = () => new Date(),
  ) {
    this.prefix = this.validatePrefix(options.prefix);
    const grace =
      options.gracePeriodMs === undefined
        ? DEFAULT_ORPHAN_GRACE_MS
        : options.gracePeriodMs;
    if (!Number.isSafeInteger(grace) || grace < 0) {
      throw new Error('Invalid request image orphan grace period');
    }
    this.gracePeriodMs = grace;
    this.dryRun = options.dryRun ?? false;
    this.listPageSize = boundedSize(
      options.listPageSize,
      DEFAULT_LIST_PAGE_SIZE,
    );
    this.dbPageSize = boundedSize(options.dbPageSize, DEFAULT_DB_PAGE_SIZE);
    this.deleteBatchSize = boundedSize(
      options.deleteBatchSize,
      DEFAULT_DELETE_BATCH_SIZE,
    );
    this.now = now;
  }

  async reconcile(): Promise<RequestImageReconcileReport> {
    const report: RequestImageReconcileReport = {
      prefix: this.prefix,
      dryRun: this.dryRun,
      listed: 0,
      referenced: 0,
      referencedObjects: 0,
      recentOrphans: 0,
      orphans: 0,
      deleted: 0,
      failures: 0,
      truncated: false,
      errors: [],
    };

    // Phase 1 — authoritative reference set (fail-closed). Without a
    // complete set of committed keys no deletion may happen, so any failure
    // aborts the whole run before a single object is touched.
    const referenced = new Set<string>();
    try {
      let after: string | undefined;
      for (let pageIndex = 0; pageIndex < MAX_DB_PAGES; pageIndex += 1) {
        const page = await this.keyLister.listImageStorageKeys(
          this.prefix,
          after,
          this.dbPageSize,
        );
        for (const key of page.keys) {
          if (key.startsWith(this.prefix)) referenced.add(key);
        }
        report.referenced = referenced.size;
        if (referenced.size > MAX_REFERENCED_KEYS) {
          throw new Error(
            'Request image reconciliation aborted: reference set exceeds the safety bound',
          );
        }
        if (!page.nextAfter) break;
        after = page.nextAfter;
        if (pageIndex === MAX_DB_PAGES - 1) {
          throw new Error(
            'Request image reconciliation aborted: reference listing is not making progress',
          );
        }
      }
    } catch (error) {
      report.errors.push(errorMessage(error));
      return report;
    }

    // Phase 2 — bounded storage listing under the prefix, comparing every
    // object against the committed reference set and the grace period.
    const orphans: string[] = [];
    const threshold = this.now().getTime() - this.gracePeriodMs;
    let continuationToken: string | undefined;
    for (let pageIndex = 0; pageIndex < MAX_LIST_PAGES; pageIndex += 1) {
      let page;
      try {
        page = await this.storage.list({
          prefix: this.prefix,
          maxKeys: this.listPageSize,
          continuationToken,
        });
      } catch (error) {
        // Safe failure: stop listing, delete nothing further.
        report.failures += 1;
        report.errors.push(errorMessage(error));
        report.truncated = true;
        break;
      }
      for (const item of page.items) {
        if (!item.key.startsWith(this.prefix)) continue;
        report.listed += 1;
        if (referenced.has(item.key)) {
          report.referencedObjects += 1;
          continue;
        }
        if (item.lastModified.getTime() > threshold) {
          report.recentOrphans += 1;
          continue;
        }
        orphans.push(item.key);
      }
      if (!page.isTruncated || !page.nextContinuationToken) break;
      continuationToken = page.nextContinuationToken;
      if (pageIndex === MAX_LIST_PAGES - 1) {
        report.truncated = true;
      }
    }
    report.orphans = orphans.length;

    // Phase 3 — exact-key deletion in bounded batches (skipped in dry-run).
    if (!this.dryRun && orphans.length > 0) {
      orphans.sort();
      for (
        let index = 0;
        index < orphans.length;
        index += this.deleteBatchSize
      ) {
        const batch = orphans.slice(index, index + this.deleteBatchSize);
        try {
          await this.storage.deleteMany(batch);
          report.deleted += batch.length;
        } catch (error) {
          report.failures += 1;
          report.errors.push(errorMessage(error));
        }
      }
    }
    return report;
  }

  private validatePrefix(prefix: string): string {
    if (!/^request-images\/[a-z0-9][a-z0-9_-]{0,31}\/$/.test(prefix)) {
      throw new Error('Invalid request image storage prefix');
    }
    return prefix;
  }
}

import type { RequestImageStorage } from './request-image.storage';
import {
  RequestImageReconciler,
  type RequestImageKeyLister,
  type RequestImageReconcileReport,
} from './request-image-reconcile';

const PREFIX = 'request-images/test/';
const NOW = new Date('2026-08-17T12:00:00.000Z');
const OLD = new Date('2026-08-01T00:00:00.000Z');
const RECENT = new Date('2026-08-17T11:59:00.000Z');

type StoragePage = {
  items: { key: string; lastModified: Date }[];
  isTruncated?: boolean;
  nextContinuationToken?: string;
};

function storageWithPages(pages: StoragePage[]): {
  storage: RequestImageStorage;
  list: jest.Mock;
  deleteMany: jest.Mock;
} {
  const list = jest.fn();
  const deleteMany = jest.fn().mockResolvedValue(undefined);
  for (const page of pages) {
    list.mockResolvedValueOnce({
      items: page.items,
      isTruncated: page.isTruncated ?? false,
      nextContinuationToken: page.nextContinuationToken,
    });
  }
  return {
    storage: { put: jest.fn(), signGet: jest.fn(), list, deleteMany },
    list,
    deleteMany,
  };
}

function keyListerWith(
  keys: string[],
  pageSize = 500,
): { keyLister: RequestImageKeyLister; listImageStorageKeys: jest.Mock } {
  const listImageStorageKeys = jest.fn(
    (_prefix: string, after?: string, limit: number = pageSize) => {
      const foundIndex = after ? keys.findIndex((key) => key > after) : 0;
      const startIndex = foundIndex < 0 ? keys.length : foundIndex;
      const page = keys.slice(startIndex, startIndex + limit);
      return Promise.resolve(
        page.length > 0
          ? { keys: page, nextAfter: page[page.length - 1] }
          : { keys: page },
      );
    },
  );
  return {
    keyLister: { listImageStorageKeys },
    listImageStorageKeys,
  };
}

describe('RequestImageReconciler', () => {
  it('never deletes an object referenced by a committed DB row', async () => {
    const referenced = `${PREFIX}2026/08/committed.jpg`;
    const { keyLister } = keyListerWith([referenced]);
    const { storage, deleteMany } = storageWithPages([
      { items: [{ key: referenced, lastModified: OLD }] },
    ]);

    const report = await new RequestImageReconciler(
      storage,
      keyLister,
      { prefix: PREFIX },
      () => NOW,
    ).reconcile();

    expect(report).toMatchObject({
      listed: 1,
      referenced: 1,
      referencedObjects: 1,
      orphans: 0,
      deleted: 0,
    });
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('deletes an orphan older than the grace period by its exact key only', async () => {
    const orphan = `${PREFIX}2026/08/orphan.jpg`;
    const { keyLister } = keyListerWith([]);
    const { storage, deleteMany } = storageWithPages([
      { items: [{ key: orphan, lastModified: OLD }] },
    ]);

    const report = await new RequestImageReconciler(
      storage,
      keyLister,
      { prefix: PREFIX },
      () => NOW,
    ).reconcile();

    expect(report).toMatchObject({
      listed: 1,
      orphans: 1,
      deleted: 1,
      failures: 0,
      truncated: false,
    });
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteMany).toHaveBeenCalledWith([orphan]);
  });

  it('preserves a recent orphan that is younger than the grace period', async () => {
    const recentOrphan = `${PREFIX}2026/08/fresh-upload.jpg`;
    const { keyLister } = keyListerWith([]);
    const { storage, deleteMany } = storageWithPages([
      { items: [{ key: recentOrphan, lastModified: RECENT }] },
    ]);

    const report = await new RequestImageReconciler(
      storage,
      keyLister,
      { prefix: PREFIX, gracePeriodMs: 5 * 60 * 1000 },
      () => NOW,
    ).reconcile();

    expect(report).toMatchObject({
      recentOrphans: 1,
      orphans: 0,
      deleted: 0,
    });
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('never lists or deletes outside the request-images namespace prefix', async () => {
    const { keyLister, listImageStorageKeys } = keyListerWith([]);
    const { storage, list, deleteMany } = storageWithPages([
      {
        items: [
          // A defensive fake returning out-of-prefix items: they must be
          // ignored entirely even though storage.list is prefix-scoped.
          { key: 'unrelated-bucket-object.json', lastModified: OLD },
          { key: 'request-images/other-env/2026/08/x.jpg', lastModified: OLD },
          { key: `${PREFIX}2026/08/real-orphan.jpg`, lastModified: OLD },
        ],
      },
    ]);

    const report = await new RequestImageReconciler(
      storage,
      keyLister,
      { prefix: PREFIX },
      () => NOW,
    ).reconcile();

    expect(report).toMatchObject({ listed: 1, orphans: 1, deleted: 1 });
    expect(list).toHaveBeenCalledWith({
      prefix: PREFIX,
      maxKeys: 500,
      continuationToken: undefined,
    });
    expect(listImageStorageKeys).toHaveBeenCalledWith(PREFIX, undefined, 500);
    expect(deleteMany).toHaveBeenCalledWith([
      `${PREFIX}2026/08/real-orphan.jpg`,
    ]);
  });

  it('reports orphans without deleting anything in dry-run mode', async () => {
    const orphan = `${PREFIX}2026/08/orphan.jpg`;
    const { keyLister } = keyListerWith([]);
    const { storage, deleteMany } = storageWithPages([
      { items: [{ key: orphan, lastModified: OLD }] },
    ]);

    const report = await new RequestImageReconciler(
      storage,
      keyLister,
      { prefix: PREFIX, dryRun: true },
      () => NOW,
    ).reconcile();

    expect(report).toMatchObject({
      dryRun: true,
      orphans: 1,
      deleted: 0,
    });
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('pages through truncated storage listings and pages DB reference keys', async () => {
    const orphanA = `${PREFIX}2026/08/orphan-a.jpg`;
    const orphanB = `${PREFIX}2026/08/orphan-b.jpg`;
    const referenced = `${PREFIX}2026/08/committed.jpg`;
    const { keyLister, listImageStorageKeys } = keyListerWith([referenced], 1);
    const { storage, deleteMany } = storageWithPages([
      {
        items: [{ key: orphanA, lastModified: OLD }],
        isTruncated: true,
        nextContinuationToken: 'token-1',
      },
      {
        items: [{ key: referenced, lastModified: OLD }],
        isTruncated: true,
        nextContinuationToken: 'token-2',
      },
      { items: [{ key: orphanB, lastModified: OLD }], isTruncated: false },
    ]);

    const report = await new RequestImageReconciler(
      storage,
      keyLister,
      { prefix: PREFIX, listPageSize: 1, dbPageSize: 1 },
      () => NOW,
    ).reconcile();

    expect(listImageStorageKeys).toHaveBeenCalledWith(PREFIX, undefined, 1);
    expect(report).toMatchObject({
      listed: 3,
      referenced: 1,
      referencedObjects: 1,
      orphans: 2,
      deleted: 2,
      truncated: false,
    });
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteMany).toHaveBeenCalledWith(
      expect.arrayContaining([orphanA, orphanB]),
    );
  });

  it('aborts without deleting anything when the DB reference read fails (fail-closed)', async () => {
    const keyLister: RequestImageKeyLister = {
      listImageStorageKeys: jest
        .fn()
        .mockRejectedValue(new Error('database unavailable')),
    };
    const { storage, deleteMany } = storageWithPages([
      { items: [{ key: `${PREFIX}x.jpg`, lastModified: OLD }] },
    ]);

    const report = await new RequestImageReconciler(
      storage,
      keyLister,
      { prefix: PREFIX },
      () => NOW,
    ).reconcile();

    expect(report).toMatchObject({ deleted: 0, failures: 0, listed: 0 });
    expect(report.errors).toEqual(['database unavailable']);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('records deletion failures with sanitized messages and continues', async () => {
    const orphanA = `${PREFIX}2026/08/a.jpg`;
    const orphanB = `${PREFIX}2026/08/b.jpg`;
    const { keyLister } = keyListerWith([]);
    const deleteMany = jest
      .fn()
      .mockRejectedValueOnce(new Error('delete failed'))
      .mockResolvedValueOnce(undefined);
    const storage: RequestImageStorage = {
      put: jest.fn(),
      signGet: jest.fn(),
      deleteMany,
      list: jest.fn().mockResolvedValue({
        items: [
          { key: orphanA, lastModified: OLD },
          { key: orphanB, lastModified: OLD },
        ],
        isTruncated: false,
      }),
    };

    const report = await new RequestImageReconciler(
      storage,
      keyLister,
      { prefix: PREFIX, deleteBatchSize: 1 },
      () => NOW,
    ).reconcile();

    expect(report).toMatchObject({
      orphans: 2,
      deleted: 1,
      failures: 1,
    });
    expect(report.errors).toEqual(['delete failed']);
    expect(deleteMany).toHaveBeenCalledWith([orphanA]);
    expect(deleteMany).toHaveBeenCalledWith([orphanB]);
  });

  it('rejects an invalid prefix before touching storage or the database', () => {
    const { keyLister, listImageStorageKeys } = keyListerWith([]);
    const { storage, list } = storageWithPages([]);

    expect(
      () =>
        new RequestImageReconciler(storage, keyLister, {
          prefix: 'request-images/../prod/',
        }),
    ).toThrow('Invalid request image storage prefix');
    expect(
      () =>
        new RequestImageReconciler(storage, keyLister, {
          prefix: 'avatars/production/',
        }),
    ).toThrow('Invalid request image storage prefix');
    expect(list).not.toHaveBeenCalled();
    expect(listImageStorageKeys).not.toHaveBeenCalled();
  });

  it('validates the grace period as a non-negative safe integer', () => {
    const { keyLister } = keyListerWith([]);
    const { storage } = storageWithPages([]);

    expect(
      () =>
        new RequestImageReconciler(storage, keyLister, {
          prefix: PREFIX,
          gracePeriodMs: Number.NaN,
        }),
    ).toThrow('Invalid request image orphan grace period');
    expect(
      () =>
        new RequestImageReconciler(storage, keyLister, {
          prefix: PREFIX,
          gracePeriodMs: -1,
        }),
    ).toThrow('Invalid request image orphan grace period');
  });

  it('never deletes anything when the storage listing itself fails', async () => {
    const { keyLister } = keyListerWith([]);
    const list = jest.fn().mockRejectedValue(new Error('listing failed'));
    const deleteMany = jest.fn();
    const storage: RequestImageStorage = {
      put: jest.fn(),
      signGet: jest.fn(),
      deleteMany,
      list,
    };

    const report = await new RequestImageReconciler(
      storage,
      keyLister,
      { prefix: PREFIX },
      () => NOW,
    ).reconcile();

    expect(report).toMatchObject({
      listed: 0,
      orphans: 0,
      deleted: 0,
      failures: 1,
      truncated: true,
    });
    expect(report.errors).toEqual(['listing failed']);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('reports a sanitized shape with no signed URLs or credentials', async () => {
    const { keyLister } = keyListerWith([]);
    const { storage } = storageWithPages([
      { items: [{ key: `${PREFIX}orphan.jpg`, lastModified: OLD }] },
    ]);

    const report: RequestImageReconcileReport =
      await new RequestImageReconciler(
        storage,
        keyLister,
        { prefix: PREFIX },
        () => NOW,
      ).reconcile();

    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/https?:\/\//i);
    expect(serialized).not.toMatch(/signature|credential|secret|token=/i);
    expect(Object.keys(report).sort()).toEqual(
      [
        'prefix',
        'dryRun',
        'listed',
        'referenced',
        'referencedObjects',
        'recentOrphans',
        'orphans',
        'deleted',
        'failures',
        'truncated',
        'errors',
      ].sort(),
    );
  });
});

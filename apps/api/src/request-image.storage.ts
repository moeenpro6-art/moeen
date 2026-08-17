import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type DeleteObjectsCommandOutput,
  type ListObjectsV2CommandOutput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { EnabledRequestImageConfig } from './request-image.config';

export const REQUEST_IMAGE_STORAGE = Symbol('REQUEST_IMAGE_STORAGE');

export type RequestImagePut = {
  key: string;
  body: Buffer;
  contentType: 'image/jpeg';
};

export type SignedRequestImage = {
  url: string;
  expiresAt: Date;
};

export type RequestImageStorageList = {
  items: { key: string; lastModified: Date }[];
  isTruncated: boolean;
  nextContinuationToken?: string;
};

export type RequestImageStorageListInput = {
  /** Key prefix the caller has already validated (never user input). */
  prefix: string;
  /** Page size; the storage implementation clamps it to [1, 1000]. */
  maxKeys: number;
  continuationToken?: string;
};

export interface RequestImageStorage {
  put(input: RequestImagePut): Promise<void>;
  deleteMany(keys: string[]): Promise<void>;
  signGet(key: string): Promise<SignedRequestImage>;
  list(input: RequestImageStorageListInput): Promise<RequestImageStorageList>;
}

type S3Sender = {
  send(command: unknown): Promise<unknown>;
};

type SignGet = (
  client: S3Sender,
  command: GetObjectCommand,
  options: { expiresIn: number },
) => Promise<string>;

export class S3RequestImageStorage implements RequestImageStorage {
  private readonly client: S3Sender;
  private readonly sign: SignGet;
  private readonly now: () => number;

  constructor(
    private readonly config: EnabledRequestImageConfig,
    client?: S3Sender,
    sign?: SignGet,
    now: () => number = Date.now,
  ) {
    this.client =
      client ??
      new S3Client({
        endpoint: config.endpoint,
        region: config.region,
        forcePathStyle: config.forcePathStyle,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
      });
    this.sign =
      sign ??
      ((s3Client, command, options) =>
        getSignedUrl(s3Client as S3Client, command, options));
    this.now = now;
  }

  async put(input: RequestImagePut): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        CacheControl: 'private, no-store',
      }),
    );
  }

  async deleteMany(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const response = (await this.client.send(
      new DeleteObjectsCommand({
        Bucket: this.config.bucket,
        Delete: {
          Objects: keys.map((Key) => ({ Key })),
          Quiet: true,
        },
      }),
    )) as DeleteObjectsCommandOutput;
    if ((response.Errors?.length ?? 0) > 0) {
      throw new Error('Request image deletion failed');
    }
  }

  async signGet(key: string): Promise<SignedRequestImage> {
    const url = await this.sign(
      this.client,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ResponseCacheControl: 'private, no-store',
      }),
      { expiresIn: this.config.signedUrlTtlSeconds },
    );
    return {
      url,
      expiresAt: new Date(this.now() + this.config.signedUrlTtlSeconds * 1000),
    };
  }

  async list(
    input: RequestImageStorageListInput,
  ): Promise<RequestImageStorageList> {
    const maxKeys = Math.min(Math.max(Math.trunc(input.maxKeys) || 1, 1), 1000);
    const response = (await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.config.bucket,
        Prefix: input.prefix,
        MaxKeys: maxKeys,
        ...(input.continuationToken
          ? { ContinuationToken: input.continuationToken }
          : {}),
      }),
    )) as ListObjectsV2CommandOutput;
    return {
      items: (response.Contents ?? [])
        .filter(
          (item) =>
            typeof item.Key === 'string' && item.LastModified instanceof Date,
        )
        .map((item) => ({
          key: item.Key as string,
          lastModified: item.LastModified as Date,
        })),
      isTruncated: response.IsTruncated ?? false,
      nextContinuationToken: response.NextContinuationToken,
    };
  }
}

export class DisabledRequestImageStorage implements RequestImageStorage {
  put(): Promise<void> {
    return Promise.reject(new Error('Request image storage is disabled'));
  }

  deleteMany(): Promise<void> {
    return Promise.reject(new Error('Request image storage is disabled'));
  }

  signGet(): Promise<SignedRequestImage> {
    return Promise.reject(new Error('Request image storage is disabled'));
  }

  list(): Promise<RequestImageStorageList> {
    return Promise.reject(new Error('Request image storage is disabled'));
  }
}

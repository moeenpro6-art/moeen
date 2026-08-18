export type RequestImageUploadFile = {
  buffer: Buffer;
  mimetype: string;
  size: number;
};

export type CanonicalRequestImage = {
  id: string;
  storageKey: string;
  mimeType: 'image/jpeg';
  byteSize: number;
  contentSha256: string;
  sortOrder: number;
  body: Buffer;
};

export type StoredRequestImage = Omit<CanonicalRequestImage, 'body'>;

export type RequestImageDto = {
  id: string;
  mimeType: 'image/jpeg';
  byteSize: number;
  sortOrder: number;
  url: string;
  urlExpiresAt: string;
};

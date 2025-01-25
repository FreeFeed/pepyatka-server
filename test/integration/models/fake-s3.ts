import { ReadStream } from 'fs';

type S3UploadParams = {
  Key: string;
  Body: ReadStream;
};

type S3DeleteParams = {
  Key: string;
  Bucket: string;
};

type S3UploadCbParams = Omit<S3UploadParams, 'Body'> & { Body: Buffer };

export type FakeS3Storage = Map<string, S3UploadCbParams>;

export const fakeS3Storage: FakeS3Storage = new Map();

export class FakeS3 {
  public readonly storage: FakeS3Storage;

  constructor(storage: FakeS3Storage = fakeS3Storage) {
    this.storage = storage;
  }

  putObject(params: S3UploadParams): Promise<void> {
    return new Promise((resolve) => {
      const chunks: Uint8Array[] = [];
      params.Body.on('data', (chunk) => chunks.push(chunk as Uint8Array));

      params.Body.on('end', () => {
        const Body = Buffer.concat(chunks);
        this.storage.set(params.Key, { ...params, Body });
        resolve();
      });
    });
  }

  deleteObject(params: S3DeleteParams): Promise<void> {
    this.storage.delete(params.Key);
    return Promise.resolve();
  }
}

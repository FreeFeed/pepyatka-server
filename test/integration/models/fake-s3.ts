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

export class FakeS3 {
  public readonly items = new Map<string, S3UploadCbParams>();

  putObject(params: S3UploadParams): Promise<void> {
    return new Promise((resolve) => {
      const chunks: Uint8Array[] = [];
      params.Body.on('data', (chunk) => chunks.push(chunk as Uint8Array));

      params.Body.on('end', () => {
        const Body = Buffer.concat(chunks);
        this.items.set(params.Key, { ...params, Body });
        resolve();
      });
    });
  }

  deleteObject(params: S3DeleteParams): Promise<void> {
    this.items.delete(params.Key);
    return Promise.resolve();
  }

  clear() {
    this.items.clear();
  }
}

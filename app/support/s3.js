import { S3 } from '@aws-sdk/client-s3';

import { FakeS3 } from '../../test/integration/models/fake-s3';

import { currentConfig } from './app-async-context';

export function s3Client() {
  const { storage } = currentConfig().media;

  if (storage.type === 's3') {
    if (storage.region === 'fake') {
      return new FakeS3();
    }

    const s3Config = {
      credentials: {
        accessKeyId: storage.accessKeyId || null,
        secretAccessKey: storage.secretAccessKey || null,
      },
      ...storage.s3ConfigOptions,
    };

    if ('region' in storage) {
      s3Config.region = storage.region;
    }

    if ('endpoint' in storage) {
      // useful for usage with DigitalOcean Spaces or other S3-compatible services
      s3Config.endpoint = storage.endpoint;
    }

    return new S3(s3Config);
  }

  return null;
}

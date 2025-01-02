/* eslint-env node, mocha */
/* global $pg_database */
import { join } from 'path';
import { promises as fsPromises } from 'fs';
import { createHash } from 'crypto';
import os from 'os';

import { exiftool } from 'exiftool-vendored';
import expect from 'unexpected';
import S3rver from 's3rver';

import { User } from '../../../app/models';
import cleanDB from '../../dbCleaner';
import { SANITIZE_NONE, SANITIZE_VERSION } from '../../../app/support/sanitize-media';
import { withModifiedConfig } from '../../helpers/with-modified-config';

import { createAttachment } from './attachment-helpers';

const photoWithGPSPath = join(__dirname, '../../fixtures/photo-with-gps.jpg');
const photoWithoutGPSPath = join(__dirname, '../../fixtures/photo-without-gps.jpg');

const gpsTags = ['GPSLatitude', 'GPSLongitude', 'GPSPosition', 'GPSLatitudeRef', 'GPSLongitudeRef'];

describe('Sanitize media metadata on create', () => {
  before(() => cleanDB($pg_database));

  let luna;
  before(async () => {
    luna = new User({ username: 'luna', password: 'pw' });
    await luna.create();
  });

  it('should sanitize attachment metadata', async () => {
    const oldTags = await exiftool.read(photoWithGPSPath);
    expect(oldTags, 'to have keys', gpsTags);

    const att = await createAttachment(luna.id, {
      name: `photo.jpg`,
      type: 'image/jpeg',
      content: await fsPromises.readFile(photoWithGPSPath),
    });

    const newTags = await exiftool.read(att.getPath());
    expect(newTags, 'to not have keys', gpsTags);
    expect(att.sanitized, 'to be', SANITIZE_VERSION);
  });

  it('should not alter file without sensitive metadata', async () => {
    const content = await fsPromises.readFile(photoWithoutGPSPath);
    const oldHash = fileHash(content);

    const att = await createAttachment(luna.id, {
      name: `photo.jpg`,
      type: 'image/jpeg',
      content,
    });

    const newContent = await fsPromises.readFile(att.getPath());
    const newHash = fileHash(newContent);
    expect(newHash, 'to equal', oldHash);
    expect(att.sanitized, 'to be', SANITIZE_VERSION);
  });

  describe(`Luna doesn't want to sanitize her files`, () => {
    before(() => luna.update({ preferences: { sanitizeMediaMetadata: false } }));
    after(() => luna.update({ preferences: { sanitizeMediaMetadata: true } }));

    it('should not alter file with sensitive metadata', async () => {
      const content = await fsPromises.readFile(photoWithGPSPath);
      const oldHash = fileHash(content);

      const att = await createAttachment(luna.id, {
        name: `photo.jpg`,
        type: 'image/jpeg',
        content,
      });

      const newContent = await fsPromises.readFile(att.getPath());
      const newHash = fileHash(newContent);
      expect(newHash, 'to equal', oldHash);
      expect(att.sanitized, 'to be', SANITIZE_NONE);
    });
  });
});

describe('sanitizeOriginal model method', () => {
  before(() => cleanDB($pg_database));

  let luna;
  before(async () => {
    luna = new User({ username: 'luna', password: 'pw' });
    await luna.create();
    await luna.update({ preferences: { sanitizeMediaMetadata: false } });
  });

  describe('Local file storage', () => {
    it('should sanitize file with GPS data', async () => {
      const att = await createAttachment(luna.id, {
        name: `photo.jpg`,
        type: 'image/jpeg',
        content: await fsPromises.readFile(photoWithGPSPath),
      });
      const prevSize = att.fileSize;
      const updated = await att.sanitizeOriginal();
      expect(updated, 'to be true');
      expect(prevSize, 'not to equal', att.fileSize);
      expect(att.sanitized, 'to be', SANITIZE_VERSION);

      const newTags = await exiftool.read(att.getPath());
      expect(newTags, 'to not have keys', gpsTags);
    });

    it('should sanitize file without GPS data', async () => {
      const att = await createAttachment(luna.id, {
        name: `photo.jpg`,
        type: 'image/jpeg',
        content: await fsPromises.readFile(photoWithoutGPSPath),
      });
      const prevSize = att.fileSize;
      const updated = await att.sanitizeOriginal();
      expect(updated, 'to be false');
      expect(prevSize, 'to equal', att.fileSize);
      expect(att.sanitized, 'to be', SANITIZE_VERSION);
    });
  });

  describe('S3 storage', () => {
    let s3instance;
    const storageConfig = {
      type: 's3',
      accessKeyId: 'S3RVER',
      secretAccessKey: 'S3RVER',
      region: 'us-east-1',
      bucket: 'bucket-name',
      endpoint: 'http://localhost:4569',
      s3ConfigOptions: { forcePathStyle: true },
    };

    withModifiedConfig({
      media: { storage: storageConfig },
      attachments: { storage: storageConfig },
    });

    before(async () => {
      s3instance = new S3rver({
        port: 4569,
        address: 'localhost',
        silent: true, // turn it off to show log
        directory: os.tmpdir(),
        configureBuckets: [{ name: storageConfig.bucket }],
      });
      await s3instance.run();
    });
    after(() => s3instance.close());

    it('should sanitize file with GPS data', async () => {
      const att = await createAttachment(
        luna.id,
        {
          name: `photo.jpg`,
          type: 'image/jpeg',
          content: await fsPromises.readFile(photoWithGPSPath),
        },
        { storageConfig },
      );
      const prevSize = att.fileSize;

      const capturedEvents = [];
      s3instance.on('event', (e) => capturedEvents.push(e.Records[0].eventName));
      const updated = await att.sanitizeOriginal();
      s3instance.removeAllListeners();

      expect(updated, 'to be true');
      expect(prevSize, 'not to equal', att.fileSize);
      expect(att.sanitized, 'to be', SANITIZE_VERSION);
      // Original should be updated on S3
      expect(capturedEvents, 'to equal', ['ObjectCreated:Put']);

      const localFile = await att.downloadOriginal();

      const newTags = await exiftool.read(localFile);
      expect(newTags, 'to not have keys', gpsTags);

      await fsPromises.unlink(localFile);
    });

    it('should sanitize file without GPS data', async () => {
      const att = await createAttachment(
        luna.id,
        {
          name: `photo.jpg`,
          type: 'image/jpeg',
          content: await fsPromises.readFile(photoWithoutGPSPath),
        },
        { storageConfig },
      );
      const prevSize = att.fileSize;

      const capturedEvents = [];
      s3instance.on('event', (e) => capturedEvents.push(e.Records[0].eventName));
      const updated = await att.sanitizeOriginal();
      s3instance.removeAllListeners();

      expect(updated, 'to be false');
      expect(prevSize, 'to equal', att.fileSize);
      expect(att.sanitized, 'to be', SANITIZE_VERSION);
      // Original should not be updated on S3
      expect(capturedEvents, 'to equal', []);
    });
  });
});

function fileHash(content) {
  return createHash('sha256').update(content).digest('hex');
}

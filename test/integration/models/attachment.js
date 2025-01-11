import { readFile, stat, writeFile } from 'fs/promises';
import { join, resolve, parse as parsePath, basename, extname } from 'path';
import { tmpdir } from 'os';

import { v4 as createUuid } from 'uuid';
import { before, beforeEach, describe, it } from 'mocha';
import expect from 'unexpected';
import { mkdirp } from 'mkdirp';
import { lookup as mimeLookup } from 'mime-types';

import cleanDB from '../../dbCleaner';
import { dbAdapter, Attachment } from '../../../app/models';
import { currentConfig } from '../../../app/support/app-async-context';
import { createUser } from '../helpers/users';
import { createPost } from '../helpers/posts-and-comments';
import { spawnAsync } from '../../../app/support/spawn-async';
import { withModifiedConfig } from '../../helpers/with-modified-config';

import { testFiles } from './attachment-data';
import { fakeS3Storage } from './fake-s3';

const fixturesDir = resolve(__dirname, '../../fixtures');

describe('Attachments', () => {
  before(() => cleanDB(dbAdapter.database));

  let user;
  before(async () => {
    // Create user
    user = await createUser('luna');

    const attConf = currentConfig().attachments;

    // Create directories for attachments
    await mkdirp(attConf.storage.rootDir + attConf.path);
  });

  beforeEach(() => fakeS3Storage.clear());

  let post;

  beforeEach(async () => {
    post = await createPost(user, 'Post body');
  });

  it('should create a small attachment', async () => {
    const att = await createAndCheckAttachment(testFiles.small, post, user);
    expect(att.previews, 'to equal', {
      image: { '': { h: 150, w: 150, ext: 'png' } },
    });
    expect(att.meta, 'to equal', {});
  });

  it('should create a medium attachment', async () => {
    const att = await createAndCheckAttachment(testFiles.medium, post, user);
    expect(att.previews, 'to equal', {
      image: {
        '': { h: 300, w: 900, ext: 'png' },
        p1: { h: 200, w: 600, ext: 'webp' },
        thumbnails: { h: 175, w: 525, ext: 'webp' },
      },
    });
  });

  it('should create a large attachment', async () => {
    const att = await createAndCheckAttachment(testFiles.large, post, user);
    expect(att.previews, 'to equal', {
      image: {
        '': { h: 1000, w: 1500, ext: 'png' },
        p1: { h: 283, w: 424, ext: 'webp' },
        p2: { h: 516, w: 775, ext: 'webp' },
        thumbnails: { h: 175, w: 263, ext: 'webp' },
        thumbnails2: { h: 350, w: 525, ext: 'webp' },
      },
    });
  });

  it('should create an x-large attachment', async () => {
    const att = await createAndCheckAttachment(testFiles.xlarge, post, user);
    expect(att.previews, 'to equal', {
      image: {
        p1: { h: 283, w: 424, ext: 'webp' },
        p2: { h: 516, w: 775, ext: 'webp' },
        p3: { h: 894, w: 1342, ext: 'webp' },
        p4: { h: 1633, w: 2449, ext: 'webp' }, // Maximum size, no entry for the original
        thumbnails: { h: 175, w: 263, ext: 'webp' },
        thumbnails2: { h: 350, w: 525, ext: 'webp' },
      },
    });
  });

  it('should create a medium attachment with exif rotation', async () => {
    const att = await createAndCheckAttachment(testFiles.rotated, post, user);
    expect(att.previews, 'to equal', {
      image: {
        p1: { h: 600, w: 200, ext: 'webp' },
        p2: { h: 900, w: 300, ext: 'webp' }, // Not an original file
        thumbnails: { h: 175, w: 58, ext: 'webp' },
        thumbnails2: { h: 350, w: 117, ext: 'webp' },
      },
    });

    // Check the real rotation of the original file
    const originalFile = join(
      currentConfig().attachments.storage.rootDir,
      att.getRelFilePath('p2', 'webp'),
    );
    const out = await spawnAsync('identify', ['-format', '%w %h %[orientation]', originalFile]);
    expect(out.stdout, 'to equal', '300 900 Undefined');
  });

  it('should create a proper colored preview from non-sRGB original', async () => {
    const att = await createAndCheckAttachment(testFiles.colorprofiled, post, user);
    const { rootDir } = currentConfig().attachments.storage;

    // original colors
    {
      const originalFile = join(rootDir, att.getRelFilePath('', att.fileExtension));
      const { stdout: buffer } = await spawnAsync(
        'convert',
        [originalFile, '-resize', '1x1!', '-colorspace', 'sRGB', '-depth', '8', 'rgb:-'],
        { binary: true },
      );

      expect(buffer, 'to have length', 3);
      expect(buffer[0], 'to be within', 191, 193);
      expect(buffer[1], 'to be within', 253, 255);
      expect(buffer[2], 'to be within', 127, 129);
    }

    // preview colors
    {
      const previewFile = join(rootDir, att.getRelFilePath('p1', 'webp'));
      const { stdout: buffer } = await spawnAsync(
        'convert',
        [previewFile, '-resize', '1x1!', '-colorspace', 'sRGB', '-depth', '8', 'rgb:-'],
        { binary: true },
      );

      expect(buffer, 'to have length', 3);
      expect(buffer[0], 'to be within', 253, 255);
      expect(buffer[1], 'to be within', 191, 193);
      expect(buffer[2], 'to be within', 127, 129);
    }
  });

  it('should create a webp attachment', async () => {
    const att = await createAndCheckAttachment(testFiles.webp, post, user);
    expect(att.previews, 'to equal', {
      image: {
        '': { h: 301, w: 400, ext: 'webp' },
        thumbnails: { h: 175, w: 233, ext: 'webp' },
      },
    });
  });

  it('should create a heic attachment', async () => {
    const att = await createAndCheckAttachment(testFiles.imageHeic, post, user);
    expect(att.previews, 'to equal', {
      image: {
        p1: { h: 283, w: 424, ext: 'webp' },
        p2: { h: 516, w: 775, ext: 'webp' },
        p3: { h: 894, w: 1342, ext: 'webp' },
        p4: { h: 1280, w: 1920, ext: 'webp' },
        thumbnails: { h: 175, w: 263, ext: 'webp' },
        thumbnails2: { h: 350, w: 525, ext: 'webp' },
      },
    });
  });

  it('should create a Adobe RGB attachment', async () => {
    const att = await createAndCheckAttachment(testFiles.adobeRgb, post, user);
    expect(att.previews, 'to equal', {
      image: {
        p1: { h: 283, w: 424, ext: 'webp' },
        p2: { h: 516, w: 775, ext: 'webp' },
        p3: { h: 894, w: 1342, ext: 'webp' },
        p4: { h: 1280, w: 1920, ext: 'webp' }, // Not an original image
        thumbnails: { h: 175, w: 263, ext: 'webp' },
        thumbnails2: { h: 350, w: 525, ext: 'webp' },
      },
    });
  });

  it('should create a CMYK attachment', async () => {
    const att = await createAndCheckAttachment(testFiles.cmyk, post, user);
    expect(att.previews, 'to equal', {
      image: {
        p1: { h: 283, w: 424, ext: 'webp' },
        p2: { h: 516, w: 775, ext: 'webp' },
        p3: { h: 894, w: 1342, ext: 'webp' },
        p4: { h: 1280, w: 1920, ext: 'webp' }, // Not an original image
        thumbnails: { h: 175, w: 263, ext: 'webp' },
        thumbnails2: { h: 350, w: 525, ext: 'webp' },
      },
    });
  });

  it('should create a CMYK attachment without profile', async () => {
    const att = await createAndCheckAttachment(testFiles.cmykNoProfile, post, user);
    expect(att.previews, 'to equal', {
      image: {
        p1: { h: 283, w: 424, ext: 'webp' },
        p2: { h: 516, w: 775, ext: 'webp' },
        p3: { h: 894, w: 1342, ext: 'webp' },
        p4: { h: 1280, w: 1920, ext: 'webp' }, // Not an original image
        thumbnails: { h: 175, w: 263, ext: 'webp' },
        thumbnails2: { h: 350, w: 525, ext: 'webp' },
      },
    });
  });

  it('should create a jpeg attachment without profile', async () => {
    const att = await createAndCheckAttachment(testFiles.jpegNoProfile, post, user);
    expect(att.previews, 'to equal', {
      image: {
        p1: { h: 283, w: 424, ext: 'webp' },
        p2: { h: 516, w: 775, ext: 'webp' },
        p3: { h: 894, w: 1342, ext: 'webp' },
        '': { h: 1280, w: 1920, ext: 'jpg' }, // Original image
        thumbnails: { h: 175, w: 263, ext: 'webp' },
        thumbnails2: { h: 350, w: 525, ext: 'webp' },
      },
    });
  });

  it('should create a jpeg sRGB attachment', async () => {
    const att = await createAndCheckAttachment(testFiles.srgb, post, user);
    expect(att.previews, 'to equal', {
      image: {
        p1: { h: 283, w: 424, ext: 'webp' },
        p2: { h: 516, w: 775, ext: 'webp' },
        p3: { h: 894, w: 1342, ext: 'webp' },
        '': { h: 1280, w: 1920, ext: 'jpg' }, // Original image
        thumbnails: { h: 175, w: 263, ext: 'webp' },
        thumbnails2: { h: 350, w: 525, ext: 'webp' },
      },
    });
  });

  it('should create an MP3 audio attachment', async () => {
    const att = await createAndCheckAttachment(testFiles.audioMp3, post, user);
    expect(att.mimeType, 'to equal', testFiles.audioMp3.type);
    expect(att.previews, 'to equal', {
      audio: {
        '': { ext: 'mp3' },
      },
    });
    expect(att.meta, 'to equal', {
      'dc:title': 'Improvisation with Sopranino Recorder',
      'dc:creator': 'Piermic',
    });
  });

  it('should create an M4A audio attachment', async () => {
    const att = await createAndCheckAttachment(testFiles.audioM4a, post, user);
    expect(att.mimeType, 'to equal', testFiles.audioM4a.type);
    expect(att.previews, 'to equal', {
      audio: {
        '': { ext: 'm4a' },
      },
    });
  });

  it('should create an OGG audio attachment', async () => {
    const att = await createAndCheckAttachment(testFiles.audioOgg, post, user);
    expect(att.mimeType, 'to equal', testFiles.audioOgg.type);
    expect(att.previews, 'to equal', {
      audio: {
        a1: { ext: 'm4a' },
      },
    });
  });

  it('should create an audio attachment from audio file without extension', async () => {
    const att = await createAndCheckAttachment(testFiles.unknown, post, user);
    expect(att.mimeType, 'to equal', testFiles.unknown.type);
    expect(att.previews, 'to equal', {
      audio: {
        '': { ext: 'mp3' },
      },
    });
  });

  it('should remove files of image attachment', async () => {
    const attachment = await createAndCheckAttachment(testFiles.large, post, user);
    await filesMustExist(attachment);
    await attachment.deleteFiles();
    await filesMustExist(attachment, false);
  });

  it('should destroy attachment object', async () => {
    const attachment = await createAndCheckAttachment(testFiles.audioMp3, post, user);
    await attachment.destroy();

    await filesMustExist(attachment, false);
    const deleted = await dbAdapter.getAttachmentById(attachment.id);
    expect(deleted, 'to be null');
  });

  describe("Old 'image_sizes' data in database", () => {
    it("should create a proper 'previews' field for a small attachment", async () => {
      const { id } = await createAndCheckAttachment(testFiles.small, post, user);
      await dbAdapter.database.raw(
        `update attachments set previews = null, image_sizes = :sizes where uid = :id`,
        {
          id,
          sizes: JSON.stringify({
            o: { w: 150, h: 150, url: `https://example.com/attachments/${id}.png` },
          }),
        },
      );
      const att = await dbAdapter.getAttachmentById(id);
      expect(att.previews, 'to equal', {
        image: { '': { h: 150, w: 150, ext: 'png' } },
      });
    });

    it("should create a proper 'previews' field for a medium attachment", async () => {
      const { id } = await createAndCheckAttachment(testFiles.medium, post, user);
      await dbAdapter.database.raw(
        `update attachments set previews = null, image_sizes = :sizes where uid = :id`,
        {
          id,
          sizes: JSON.stringify({
            o: { w: 900, h: 300, url: `https://example.com/attachments/${id}.png` },
            t: { w: 525, h: 175, url: `https://example.com/attachments/thumbnails/${id}.png` },
          }),
        },
      );
      const att = await dbAdapter.getAttachmentById(id);
      expect(att.previews, 'to equal', {
        image: {
          '': { h: 300, w: 900, ext: 'png' },
          thumbnails: { h: 175, w: 525, ext: 'png' },
        },
      });
    });

    it("should create a proper 'previews' field for a large attachment", async () => {
      const { id } = await createAndCheckAttachment(testFiles.large, post, user);
      await dbAdapter.database.raw(
        `update attachments set previews = null, image_sizes = :sizes where uid = :id`,
        {
          id,
          sizes: JSON.stringify({
            o: { w: 1500, h: 1000, url: `https://example.com/attachments/${id}.png` },
            t: { w: 263, h: 175, url: `https://example.com/attachments/thumbnails/${id}.png` },
            t2: { w: 525, h: 350, url: `https://example.com/attachments/thumbnails2/${id}.png` },
          }),
        },
      );
      const att = await dbAdapter.getAttachmentById(id);
      expect(att.previews, 'to equal', {
        image: {
          '': { h: 1000, w: 1500, ext: 'png' },
          thumbnails: { h: 175, w: 263, ext: 'png' },
          thumbnails2: { h: 350, w: 525, ext: 'png' },
        },
      });
    });

    it("should create a proper 'previews' field for an audio attachment", async () => {
      const { id } = await createAndCheckAttachment(testFiles.audioMp3, post, user);
      await dbAdapter.database.raw(`update attachments set previews = null where uid = :id`, {
        id,
      });
      const att = await dbAdapter.getAttachmentById(id);
      expect(att.previews, 'to equal', {
        audio: {
          '': { ext: 'mp3' },
        },
      });
    });
  });

  describe('S3 storage', () => {
    const storageConfig = {
      type: 's3',
      region: 'fake',
      accessKeyId: 'foo',
      secretAccessKey: 'bar',
      bucket: 'bucket',
    };
    withModifiedConfig({
      media: { storage: storageConfig },
      attachments: { storage: storageConfig },
    });

    it('should create a small attachment on S3', () =>
      createAndCheckAttachment(testFiles.small, post, user));
    it('should create a medium attachment on S3', () =>
      createAndCheckAttachment(testFiles.medium, post, user));
    it('should create a large attachment on S3', () =>
      createAndCheckAttachment(testFiles.large, post, user));
    it('should create an x-large attachment on S3', () =>
      createAndCheckAttachment(testFiles.xlarge, post, user));
    it('should create a webp attachment on S3', () =>
      createAndCheckAttachment(testFiles.webp, post, user));

    it('should remove files of image attachment', async () => {
      const attachment = await createAndCheckAttachment(testFiles.large, post, user);
      filesMustExistOnS3(attachment);
      await attachment.deleteFiles();
      filesMustExistOnS3(attachment, false);
    });
  });

  describe('Video attachments', () => {
    it('should create an h264 video attachment', async () => {
      const att = await createAndCheckAttachment(testFiles.videoMp4Avc, post, user);
      expect(att.mimeType, 'to equal', testFiles.videoMp4Avc.type);
      expect(att.previews, 'to equal', {
        video: {
          '': { h: 720, w: 1280, ext: 'mp4' },
          v1: { h: 480, w: 854, ext: 'mp4' },
        },
        image: {
          p1: { h: 260, w: 462, ext: 'webp' },
          p2: { h: 474, w: 843, ext: 'webp' },
          p3: { h: 720, w: 1280, ext: 'webp' },
          thumbnails: { h: 175, w: 311, ext: 'webp' },
          thumbnails2: { h: 350, w: 622, ext: 'webp' },
        },
      });
    });

    it('should create an Ogv video attachment', async () => {
      const att = await createAndCheckAttachment(testFiles.videoOgv, post, user);
      expect(att.mimeType, 'to equal', testFiles.videoOgv.type);
      expect(att.previews, 'to equal', {
        video: {
          '': { h: 720, w: 1280, ext: 'mp4' },
          v1: { h: 480, w: 854, ext: 'mp4' },
        },
        image: {
          p1: { h: 260, w: 462, ext: 'webp' },
          p2: { h: 474, w: 843, ext: 'webp' },
          p3: { h: 720, w: 1280, ext: 'webp' },
          thumbnails: { h: 175, w: 311, ext: 'webp' },
          thumbnails2: { h: 350, w: 622, ext: 'webp' },
        },
      });
    });

    it('should create a small h264 video attachment', async () => {
      const att = await createAndCheckAttachment(testFiles.mov, post, user);
      expect(att.mimeType, 'to equal', testFiles.mov.type);
      expect(att.previews, 'to equal', {
        video: {
          '': { h: 710, w: 1572, ext: 'mp4' },
          v1: { h: 480, w: 1062, ext: 'mp4' },
        },
        image: {
          p1: { h: 233, w: 515, ext: 'webp' },
          p2: { h: 425, w: 941, ext: 'webp' },
          p3: { h: 710, w: 1572, ext: 'webp' },
          thumbnails: { h: 175, w: 387, ext: 'webp' },
          thumbnails2: { h: 350, w: 775, ext: 'webp' },
        },
      });
    });

    it('should create a video attachment from animated gif', async () => {
      const att = await createAndCheckAttachment(testFiles.animated, post, user);
      expect(att.mimeType, 'to equal', testFiles.animated.type);
      expect(att.previews, 'to equal', {
        video: {
          v1: { h: 392, w: 774, ext: 'mp4' },
        },
        image: {
          p1: { h: 247, w: 487, ext: 'webp' },
          p2: { h: 392, w: 774, ext: 'webp' },
          thumbnails: { h: 175, w: 346, ext: 'webp' },
          thumbnails2: { h: 350, w: 691, ext: 'webp' },
        },
      });
      expect(att.meta, 'to equal', { animatedImage: true, silent: true });
    });
  });
});

async function uploadFile(fileObject) {
  const tmpDir = tmpdir();
  const path = join(tmpDir, `upl-${createUuid()}`);
  const data = await readFile(resolve(fixturesDir, fileObject.name));
  await writeFile(path, data);
  return path;
}

async function createAndCheckAttachment(fileObject, post, user) {
  const path = await uploadFile(fileObject);
  const baseName = basename(fileObject.name);
  const att = await Attachment.create(path, baseName, user, post?.id);

  expect(att, 'to be a', Attachment);
  expect(att.mediaType, 'to be one of', ['image', 'audio', 'video', 'general']);
  expect(att.fileName, 'to be', baseName);

  if (fileObject.size >= 0) {
    expect(att.fileSize, 'to be', fileObject.size);
  }

  expect(att.mimeType, 'to be', fileObject.type);
  expect(att.fileExtension, 'to be', fileObject.extension ?? extname(fileObject.name).slice(1));

  if (currentConfig().attachments.storage.type === 's3') {
    // Original should be uploaded
    const origKey = att.getRelFilePath('', att.fileExtension);
    expect(fakeS3Storage.has(origKey), 'to be truthy');
    expect(fakeS3Storage.get(origKey), 'to satisfy', {
      ACL: 'public-read',
      Bucket: currentConfig().attachments.storage.bucket,
      Key: origKey,
      ContentType: att.mimeType,
      ContentDisposition: att.getContentDisposition(att.fileName),
    });

    if (fileObject.size) {
      expect(fakeS3Storage.get(origKey).Body, 'to have length', fileObject.size);
    } else {
      // Just checking for not-zero size
      expect(fakeS3Storage.get(origKey).Body, 'to be non-empty');
    }

    // All previews should be uploaded
    for (const { variant, ext } of att.allFileVariants()) {
      const previewKey = att.getRelFilePath(variant, ext);
      const dispositionName = `${parsePath(att.fileName).name}.${ext}`;
      expect(fakeS3Storage.has(previewKey), 'to be truthy');
      expect(fakeS3Storage.get(previewKey), 'to satisfy', {
        ACL: 'public-read',
        Bucket: currentConfig().attachments.storage.bucket,
        Key: previewKey,
        ContentType: mimeLookup(ext) || 'application/octet-stream',
        ContentDisposition: att.getContentDisposition(dispositionName),
      });
    }
  } else {
    const { rootDir } = currentConfig().attachments.storage;
    const { size } = await stat(join(rootDir, att.getRelFilePath('', att.fileExtension)));

    if (fileObject.size >= 0) {
      expect(size, 'to be', fileObject.size);
    } else {
      // Just checking for not-zero size
      expect(size, 'to be above', 0);
    }

    // All previews should be created
    await Promise.all(
      att.allRelFilePaths().map(async (p) => {
        const { size: sz } = await stat(join(rootDir, p));
        expect(sz, 'to be above', 0);
      }),
    );
  }

  return att;
}

function filesMustExist(attachment, mustExist = true) {
  const { rootDir } = currentConfig().attachments.storage;

  return Promise.all(
    attachment.allRelFilePaths().map(async (p) => {
      const path = join(rootDir, p);

      try {
        await stat(path);

        if (!mustExist) {
          throw new Error(`File should not exist: ${path}`);
        }
      } catch (err) {
        if (mustExist && err.code === 'ENOENT') {
          throw new Error(`File should exist: ${path}`);
        } else if (err.code !== 'ENOENT' || mustExist) {
          throw err;
        }
      }
    }),
  );
}

function filesMustExistOnS3(attachment, mustExist = true) {
  for (const p of attachment.allRelFilePaths()) {
    if (!mustExist && fakeS3Storage.has(p)) {
      throw new Error(`File should not exist: ${p}`);
    } else if (mustExist && !fakeS3Storage.has(p)) {
      throw new Error(`File should exist: ${p}`);
    }
  }
}

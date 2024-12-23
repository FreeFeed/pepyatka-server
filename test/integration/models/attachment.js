/* eslint-env node, mocha */
/* global $pg_database */
import { promises as fsPromises } from 'fs';
import path from 'path';
import util from 'util';

import { mkdirp } from 'mkdirp';
import gmLib from 'gm';
import { expect, use as chaiUse } from 'chai';
import chaiFS from 'chai-fs';
import _ from 'lodash';
import config from 'config';

import cleanDB from '../../dbCleaner';
import { dbAdapter, User, Attachment } from '../../../app/models';
import { filesMustExist } from '../helpers/attachments';

import { fakeS3 } from './fake-s3';

const gm = gmLib.subClass({ imageMagick: true });

chaiUse(chaiFS);

const { readFile, writeFile, stat } = fsPromises;

describe('Attachment', () => {
  before(() => cleanDB($pg_database));

  describe('#create()', () => {
    let user;
    let post;

    // FormData file objects
    const files = {
      small: {
        size: 708,
        path: '/tmp/upload_12345678901234567890123456789012_1',
        name: 'test-image.150x150.png',
        type: 'image/png',
      },
      medium: {
        size: 1469,
        path: '/tmp/upload_12345678901234567890123456789012_2',
        name: 'test-image.900x300.png',
        type: 'image/png',
      },
      large: {
        size: 3199,
        path: '/tmp/upload_12345678901234567890123456789012_3',
        name: 'test-image.1500x1000.png',
        type: 'image/png',
      },
      xlarge: {
        size: 11639,
        path: '/tmp/upload_12345678901234567890123456789012_4',
        name: 'test-image.3000x2000.png',
        type: 'image/png',
      },
      rotated: {
        size: -1, // do not test
        path: '/tmp/upload_12345678901234567890123456789012_5',
        name: 'test-image-exif-rotated.900x300.jpg',
        type: 'image/jpeg',
      },
      colorprofiled: {
        size: 16698,
        path: '/tmp/upload_12345678901234567890123456789012_6',
        name: 'test-image-sgrb.png',
        type: 'image/png',
      },
      animated: {
        size: 128467,
        path: '/tmp/upload_12345678901234567890123456789012_7',
        name: 'test-image-animated.gif',
        type: 'image/gif',
      },
      audio: {
        size: 16836,
        path: '/tmp/upload_12345678901234567890123456789012_8',
        name: 'sample.mp3',
        type: 'audio/mpeg',
      },
      unknown: {
        size: 16836,
        path: '/tmp/upload_12345678901234567890123456789012_9',
        name: 'sample',
        type: 'audio/mpeg',
      },
      webp: {
        size: 18840,
        path: '/tmp/upload_12345678901234567890123456789012_10',
        name: 'test-image-webp.webp',
        type: 'image/webp',
        changeableExtension: true,
      },
      mov: {
        size: 589371,
        path: '/tmp/upload_12345678901234567890123456789012_11',
        name: 'test-quicktime-video.mov',
        type: 'video/quicktime',
      },
    };

    const createAndCheckAttachment = async (file, thePost, theUser, useS3 = false) => {
      const attachment = new Attachment({
        file,
        postId: thePost.id,
        userId: theUser.id,
      });

      const s3Uploads = {};
      const s3Deletes = {};

      if (useS3) {
        attachment.s3 = fakeS3({
          onUpload: (params) => {
            s3Uploads[params.Key] = params;
          },
          onDelete: (params) => {
            s3Deletes[params.Key] = params;
          },
        });
        attachment.s3bucket = 'bucket-name';
      }

      await attachment.create();

      attachment.should.be.an.instanceOf(Attachment);
      attachment.should.not.be.empty;
      attachment.should.have.property('id');

      const newAttachment = await dbAdapter.getAttachmentById(attachment.id);
      newAttachment.s3 = attachment.s3;
      newAttachment.s3bucket = attachment.s3bucket;

      newAttachment.should.be.an.instanceOf(Attachment);
      newAttachment.should.not.be.empty;
      newAttachment.should.have.property('id');
      newAttachment.id.should.eql(attachment.id);

      newAttachment.should.have.a.property('mediaType');
      expect(['image', 'audio', 'general']).to.include(newAttachment.mediaType);

      newAttachment.should.have.a.property('fileName');
      newAttachment.fileName.should.be.equal(file.name);

      newAttachment.should.have.a.property('fileSize');
      newAttachment.fileSize.should.be.equal(file.size.toString());

      newAttachment.should.have.a.property('mimeType');
      newAttachment.mimeType.should.be.equal(file.type);

      newAttachment.should.have.a.property('fileExtension');

      // Non-whitelisted file types are saved to FS without an extension
      const optionalExtension = newAttachment.fileExtension
        ? `.${newAttachment.fileExtension}`
        : '';
      newAttachment
        .getPath()
        .should.be.equal(
          `${config.attachments.storage.rootDir}${config.attachments.path}${newAttachment.id}${optionalExtension}`,
        );

      newAttachment.s3Uploads = s3Uploads;
      newAttachment.s3Deletes = s3Deletes;

      if (useS3) {
        // Should upload original
        const origKey = config.attachments.path + newAttachment.getFilename();
        s3Uploads.should.include.key(origKey);

        s3Uploads[origKey].should.have.property('ACL', 'public-read');
        s3Uploads[origKey].should.have.property('Bucket', config.attachments.storage.bucket);
        s3Uploads[origKey].should.have.property('Key', origKey);
        s3Uploads[origKey].should.have.property('ContentType', newAttachment.mimeType);

        for (const key of Object.keys(s3Uploads)) {
          const dispName = file.changeableExtension
            ? path.parse(newAttachment.fileName).name + path.parse(key).ext
            : file.name;
          s3Uploads[key].should.have.property(
            'ContentDisposition',
            newAttachment.getContentDisposition(dispName),
          );
        }

        if (file.size >= 0) {
          s3Uploads[origKey].Body.length.should.be.equal(file.size);
        } else {
          // Just checking for not-zero size
          s3Uploads[origKey].Body.length.should.be.above(0);
        }
      } else {
        const stats = await stat(newAttachment.getPath());

        if (file.size >= 0) {
          stats.size.should.be.equal(file.size);
        } else {
          // Just checking for not-zero size
          stats.size.should.be.above(0);
        }
      }

      return newAttachment;
    };

    before(async () => {
      // Create user
      user = new User({
        username: 'Luna',
        password: 'password',
      });
      await user.create();

      // Create directories for attachments
      await mkdirp(config.attachments.storage.rootDir + config.attachments.path);

      await Promise.all(
        _.map(config.attachments.imageSizes, (size) =>
          mkdirp(config.attachments.storage.rootDir + size.path),
        ),
      );
    });

    beforeEach(async () => {
      // "Upload" files
      const filesToUpload = {
        'test-image.150x150.png': '1',
        'test-image.900x300.png': '2',
        'test-image.1500x1000.png': '3',
        'test-image.3000x2000.png': '4',
        'test-image-exif-rotated.900x300.jpg': '5',
        'test-image-sgrb.png': '6',
        'test-image-animated.gif': '7',
        'sample.mp3': '8',
        sample: '9',
        'test-image-webp.webp': '10',
        'test-quicktime-video.mov': '11',
      };

      const srcPrefix = path.resolve(__dirname, '../../fixtures');
      const targetPrefix = '/tmp/upload_12345678901234567890123456789012_';

      await Promise.all(
        _.map(filesToUpload, async (target, src) => {
          const data = await readFile(path.resolve(srcPrefix, src));
          return writeFile(`${targetPrefix}${target}`, data);
        }),
      );
    });

    beforeEach(async () => {
      // Create post
      const newPost = await user.newPost({ body: 'Post body' });
      post = await newPost.create();
    });

    afterEach(async () => {
      await post.destroy();
    });

    it('should create a small attachment', async () => {
      const newAttachment = await createAndCheckAttachment(files.small, post, user);

      newAttachment.should.have.a.property('noThumbnail');
      newAttachment.noThumbnail.should.be.equal('1');

      newAttachment.should.have.property('imageSizes');
      newAttachment.imageSizes.should.be.deep.equal({
        o: {
          w: 150,
          h: 150,
          url: `${config.attachments.url}${config.attachments.path}${newAttachment.id}.${newAttachment.fileExtension}`,
        },
      });
    });

    it('should create a small attachment on S3', async () => {
      const newAttachment = await createAndCheckAttachment(files.small, post, user, true);
      const origKey = `${config.attachments.path}${newAttachment.id}.${newAttachment.fileExtension}`;
      newAttachment.s3Uploads.should.have.key(origKey);
    });

    it('should create a medium attachment', async () => {
      const newAttachment = await createAndCheckAttachment(files.medium, post, user);

      newAttachment.should.have.a.property('noThumbnail');
      newAttachment.noThumbnail.should.be.equal('0');

      newAttachment.should.have.property('imageSizes');
      newAttachment.imageSizes.should.be.deep.equal({
        o: {
          w: 900,
          h: 300,
          url: `${config.attachments.url}${config.attachments.path}${newAttachment.id}.${newAttachment.fileExtension}`,
        },
        t: {
          w: 525,
          h: 175,
          url: `${config.attachments.url}${config.attachments.imageSizes.t.path}${newAttachment.id}.${newAttachment.fileExtension}`,
        },
      });
    });

    it('should create a medium attachment on S3', async () => {
      const newAttachment = await createAndCheckAttachment(files.medium, post, user, true);
      newAttachment.s3Uploads.should.have.keys(
        `${config.attachments.path}${newAttachment.id}.${newAttachment.fileExtension}`,
        `${config.attachments.imageSizes.t.path}${newAttachment.id}.${newAttachment.fileExtension}`,
      );
    });

    it('should create a large attachment', async () => {
      const newAttachment = await createAndCheckAttachment(files.large, post, user);

      newAttachment.should.have.a.property('noThumbnail');
      newAttachment.noThumbnail.should.be.equal('0');

      newAttachment.should.have.property('imageSizes');
      newAttachment.imageSizes.should.be.deep.equal({
        o: {
          w: 1500,
          h: 1000,
          url: `${config.attachments.url}${config.attachments.path}${newAttachment.id}.${newAttachment.fileExtension}`,
        },
        t: {
          w: 263,
          h: 175,
          url: `${config.attachments.url}${config.attachments.imageSizes.t.path}${newAttachment.id}.${newAttachment.fileExtension}`,
        },
        t2: {
          w: 525,
          h: 350,
          url: `${config.attachments.url}${config.attachments.imageSizes.t2.path}${newAttachment.id}.${newAttachment.fileExtension}`,
        },
      });
    });

    it('should create a large attachment on S3', async () => {
      const newAttachment = await createAndCheckAttachment(files.large, post, user, true);
      newAttachment.s3Uploads.should.have.keys(
        `${config.attachments.path}${newAttachment.id}.${newAttachment.fileExtension}`,
        `${config.attachments.imageSizes.t.path}${newAttachment.id}.${newAttachment.fileExtension}`,
        `${config.attachments.imageSizes.t2.path}${newAttachment.id}.${newAttachment.fileExtension}`,
      );
    });

    it('should create an x-large attachment', async () => {
      const newAttachment = await createAndCheckAttachment(files.xlarge, post, user);

      newAttachment.should.have.a.property('noThumbnail');
      newAttachment.noThumbnail.should.be.equal('0');

      newAttachment.should.have.property('imageSizes');
      newAttachment.imageSizes.should.be.deep.equal({
        o: {
          w: 3000,
          h: 2000,
          url: `${config.attachments.url}${config.attachments.path}${newAttachment.id}.${newAttachment.fileExtension}`,
        },
        t: {
          w: 263,
          h: 175,
          url: `${config.attachments.url}${config.attachments.imageSizes.t.path}${newAttachment.id}.${newAttachment.fileExtension}`,
        },
        t2: {
          w: 525,
          h: 350,
          url: `${config.attachments.url}${config.attachments.imageSizes.t2.path}${newAttachment.id}.${newAttachment.fileExtension}`,
        },
        anotherTestSize: {
          w: 1600,
          h: 1067,
          url: `${config.attachments.url}${config.attachments.imageSizes.anotherTestSize.path}${newAttachment.id}.${newAttachment.fileExtension}`,
        },
      });
    });

    it('should create a medium attachment with exif rotation', async () => {
      const newAttachment = await createAndCheckAttachment(files.rotated, post, user);

      newAttachment.should.have.a.property('noThumbnail');
      newAttachment.noThumbnail.should.be.equal('0');

      newAttachment.should.have.property('imageSizes');
      newAttachment.imageSizes.should.be.deep.equal({
        o: {
          w: 900,
          h: 300,
          url: `${config.attachments.url}${config.attachments.path}${newAttachment.id}.${newAttachment.fileExtension}`,
        },
        t: {
          w: 525,
          h: 175,
          url: `${config.attachments.url}${config.attachments.imageSizes.t.path}${newAttachment.id}.${newAttachment.fileExtension}`,
        },
      });
    });

    it('should create a proper colored preview from non-sRGB original', async () => {
      const newAttachment = await createAndCheckAttachment(files.colorprofiled, post, user);

      // original colors
      {
        const original = gm(newAttachment.getPath());
        original.toBufferAsync = util.promisify(original.toBuffer);

        const buffer = await original.resize(1, 1).bitdepth(8).toBufferAsync('RGB');

        buffer.length.should.be.equal(3);
        buffer[0].should.be.within(191, 193);
        buffer[1].should.be.within(253, 255);
        buffer[2].should.be.within(127, 129);
      }

      // thumbnail colors
      {
        const thumbnailFile = newAttachment.getResizedImagePath('t');
        thumbnailFile.should.be.a.file().and.not.empty;

        const thumbnail = gm(thumbnailFile);
        thumbnail.toBufferAsync = util.promisify(thumbnail.toBuffer);

        const buffer = await thumbnail.resize(1, 1).bitdepth(8).toBufferAsync('RGB');

        buffer.length.should.be.equal(3);
        buffer[0].should.be.within(253, 255);
        buffer[1].should.be.within(191, 193);
        buffer[2].should.be.within(127, 129);
      }
    });

    it('should create a gif attachment', async () => {
      const newAttachment = await createAndCheckAttachment(files.animated, post, user);

      newAttachment.should.have.a.property('noThumbnail');
      newAttachment.noThumbnail.should.be.equal('0');

      newAttachment.should.have.property('imageSizes');
      newAttachment.imageSizes.should.be.deep.equal({
        o: {
          w: 774,
          h: 392,
          url: `${config.attachments.url}${config.attachments.path}${newAttachment.id}.${newAttachment.fileExtension}`,
        },
        t: {
          w: 346,
          h: 175,
          url: `${config.attachments.url}${config.attachments.imageSizes.t.path}${newAttachment.id}.${newAttachment.fileExtension}`,
        },
        t2: {
          w: 691,
          h: 350,
          url: `${config.attachments.url}${config.attachments.imageSizes.t2.path}${newAttachment.id}.${newAttachment.fileExtension}`,
        },
      });
    });

    it('should create a webp attachment', async () => {
      const newAttachment = await createAndCheckAttachment(files.webp, post, user);

      newAttachment.should.have.a.property('noThumbnail');
      newAttachment.noThumbnail.should.be.equal('0');

      newAttachment.should.have.property('imageSizes');
      newAttachment.imageSizes.should.be.deep.equal({
        o: {
          w: 400,
          h: 301,
          url: `${config.attachments.url}${config.attachments.path}${newAttachment.id}.${newAttachment.fileExtension}`,
        },
        t: {
          w: 233,
          h: 175,
          url: `${config.attachments.url}${config.attachments.imageSizes.t.path}${newAttachment.id}.jpg`,
        },
      });
    });

    it('should create a webp attachment on S3', async () => {
      const newAttachment = await createAndCheckAttachment(files.webp, post, user, true);
      newAttachment.s3Uploads.should.have.keys(
        `${config.attachments.path}${newAttachment.id}.${newAttachment.fileExtension}`,
        `${config.attachments.imageSizes.t.path}${newAttachment.id}.jpg`,
      );
    });

    it('should create an audio attachment', async () => {
      const newAttachment = await createAndCheckAttachment(files.audio, post, user);
      newAttachment.should.have.a.property('mimeType');
      newAttachment.mimeType.should.be.equal('audio/mpeg');
      newAttachment.should.have.a.property('noThumbnail');
      newAttachment.noThumbnail.should.be.equal('1');
      newAttachment.should.have.a.property('mediaType');
      newAttachment.mediaType.should.be.equal('audio');
    });

    it('should create an audio attachment from audio file without extension', async () => {
      const newAttachment = await createAndCheckAttachment(files.unknown, post, user);
      newAttachment.should.have.a.property('mimeType');
      newAttachment.mimeType.should.be.equal('audio/mpeg');
      newAttachment.should.have.a.property('noThumbnail');
      newAttachment.noThumbnail.should.be.equal('1');
      newAttachment.should.have.a.property('mediaType');
      newAttachment.mediaType.should.be.equal('audio');
    });

    it('should remove files of image attachment', async () => {
      const attachment = await createAndCheckAttachment(files.large, post, user);
      await filesMustExist(attachment);
      await attachment.deleteFiles();
      await filesMustExist(attachment, false);
    });

    it('should remove files of image attachment from S3', async () => {
      const attachment = await createAndCheckAttachment(files.large, post, user, true);
      await attachment.deleteFiles();
      attachment.s3Deletes.should.have.keys(...Object.keys(attachment.s3Uploads));
    });

    it('should remove files of audio attachment', async () => {
      const attachment = await createAndCheckAttachment(files.audio, post, user);
      await filesMustExist(attachment);
      await attachment.deleteFiles();
      await filesMustExist(attachment, false);
    });

    it('should destroy attachment object', async () => {
      const attachment = await createAndCheckAttachment(files.audio, post, user);
      await attachment.destroy();

      await filesMustExist(attachment, false);
      const deleted = await dbAdapter.getAttachmentById(attachment.id);
      expect(deleted).to.be.null;
    });

    it(`should produce 'inline' Content-Disposition for image/jpeg file`, () => {
      const attachment = new Attachment({ fileName: 'sample', mimeType: 'image/jpeg' });
      expect(attachment.getContentDisposition('sample')).to.be.equal(
        `inline; filename="sample"; filename*=utf-8''sample`,
      );
    });

    it(`should produce 'attachment' Content-Disposition for application/zip file`, () => {
      const attachment = new Attachment({ fileName: 'sample', mimeType: 'application/zip' });
      expect(attachment.getContentDisposition('sample')).to.be.equal(
        `attachment; filename="sample"; filename*=utf-8''sample`,
      );
    });

    it(`should use original filename in content-disposition header (including the extension) for video/quicktime file`, async () => {
      // Make sure non-whitelisted file formats (such as .mov) can be downloaded with their original name, including the extension
      await createAndCheckAttachment(files.mov, post, user, true);
    });
  });
});

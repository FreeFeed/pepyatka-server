import { promises as fs, createReadStream } from 'fs';
import childProcess from 'child_process';
import { join, parse as parsePath } from 'path';
import util from 'util';
import os from 'os';

import config from 'config';
import createDebug from 'debug';
import gm from 'gm';
import mime from 'mime-types';
import mmm from 'mmmagic';
import _ from 'lodash';
import mv from 'mv';
import gifsicle from 'gifsicle';
import probe from 'probe-image-size';
import Raven from 'raven';
import { exiftool } from 'exiftool-vendored';

import { getS3 } from '../support/s3';
import { sanitizeMediaMetadata, SANITIZE_NONE, SANITIZE_VERSION } from '../support/sanitize-media';

const mvAsync = util.promisify(mv);

const mimeMagic = new mmm.Magic(mmm.MAGIC_MIME_TYPE);
const detectMime = util.promisify(mimeMagic.detectFile).bind(mimeMagic);

const magic = new mmm.Magic();
const detectFile = util.promisify(magic.detectFile).bind(magic);

const execFile = util.promisify(childProcess.execFile);

const debug = createDebug('freefeed:model:attachment');

async function mimeTypeDetect(fileName, filePath) {
  // We need to dynamic import from ES-only modules
  const { fileTypeFromFile } = await import('file-type');
  // The file type is detected by checking the magic number of the buffer.
  const info = await fileTypeFromFile(filePath);

  if (info && info.mime && info.mime !== 'application/octet-stream') {
    return info.mime;
  }

  // legacy mmmagic based detection
  let mimeType = 'application/octet-stream';

  try {
    mimeType = await detectMime(filePath);

    if (mimeType === 'application/octet-stream') {
      const typeOfFile = await detectFile(filePath);

      if (typeOfFile.startsWith('Audio file with ID3')) {
        mimeType = 'audio/mpeg';
      }
    }
  } catch (e) {
    if (_.isEmpty(mimeType)) {
      throw e;
    }
  }

  // otherwise, we'll use the fallback to content-type detected with a file extension provided by the user
  if (mimeType === 'application/octet-stream') {
    mimeType = mime.lookup(fileName) || mimeType;
  }

  return mimeType;
}

export function addModel(dbAdapter) {
  return class Attachment {
    constructor(params) {
      this.id = params.id;
      this.file = params.file; // FormData File object
      this.fileName = params.fileName; // original file name, e.g. 'cute-little-kitten.jpg'
      this.fileSize = params.fileSize; // file size in bytes
      this.mimeType = params.mimeType; // used as a fallback, in case we can't detect proper one
      this.fileExtension = params.fileExtension; // jpg|png|gif etc, but empty for non-whitelisted types
      this.mediaType = params.mediaType; // image | audio | general

      this.noThumbnail = params.noThumbnail; // if true, image thumbnail URL == original URL
      this.imageSizes = params.imageSizes || {}; // pixel sizes of thumbnail(s) and original image, e.g. {t: {w: 200, h: 175}, o: {w: 600, h: 525}}

      this.artist = params.artist; // filled only for audio
      this.title = params.title; // filled only for audio

      this.userId = params.userId;
      this.postId = params.postId;

      this.sanitized = params.sanitized || SANITIZE_NONE;

      if (parseInt(params.createdAt, 10)) {
        this.createdAt = params.createdAt;
      }

      if (parseInt(params.updatedAt, 10)) {
        this.updatedAt = params.updatedAt;
      }

      const storageConfig = params.storageConfig || config.attachments.storage;

      this.s3 = storageConfig.type === 's3' ? getS3(storageConfig) : null;
      this.s3bucket = storageConfig.type === 's3' ? storageConfig.bucket : null;
    }

    get imageSizes() {
      return this.imageSizes_;
    }
    set imageSizes(newValue) {
      if (_.isString(newValue)) {
        newValue = JSON.parse(newValue);
      }

      this.imageSizes_ = newValue;
    }

    validate() {
      const valid =
        this.file &&
        Object.keys(this.file).length > 0 &&
        this.file.path &&
        this.file.path.length > 0 &&
        this.userId &&
        this.userId.length > 0;

      if (!valid) {
        throw new Error('Invalid');
      }
    }

    async create() {
      this.createdAt = new Date().getTime();
      this.updatedAt = new Date().getTime();
      this.postId = this.postId || '';

      this.validate();

      this.id = await dbAdapter.createAttachment({
        postId: this.postId,
        createdAt: this.createdAt.toString(),
        updatedAt: this.updatedAt.toString(),
      });

      this.fileName = this.file.name;
      this.fileSize = this.file.size;
      this.mimeType = this.file.type;

      // Determine initial file extension
      // (it might be overridden later when we know MIME type from its contents)
      const { supportedExtensions } = config.media;
      this.fileExtension = '';

      if (this.fileName && this.fileName.match(supportedExtensions) !== null) {
        const m = /\.([^.]+)$/.exec(this.fileName);
        const ext = m[1].toLowerCase();

        if (supportedExtensions.includes(ext)) {
          this.fileExtension = ext;
        }
      }

      await this.handleMedia();

      // Save record to DB
      const params = {
        fileName: this.fileName,
        fileSize: this.fileSize,
        mimeType: this.mimeType,
        mediaType: this.mediaType,
        fileExtension: this.fileExtension,
        noThumbnail: this.noThumbnail,
        imageSizes: JSON.stringify(this.imageSizes),
        userId: this.userId,
        postId: this.postId,
        createdAt: this.createdAt.toString(),
        updatedAt: this.updatedAt.toString(),
        sanitized: this.sanitized,
      };

      if (this.mediaType === 'audio') {
        params.artist = this.artist;
        params.title = this.title;
      }

      await dbAdapter.updateAttachment(this.id, params);

      return this;
    }

    get url() {
      return config.attachments.url + config.attachments.path + this.getFilename();
    }

    get thumbnailUrl() {
      if (this.noThumbnail === '1') {
        return this.url;
      }

      return this.getResizedImageUrl('t');
    }

    // Get user who created the attachment (via Promise, for serializer)
    getCreatedBy() {
      return dbAdapter.getUserById(this.userId);
    }

    // Get public URL of attachment (via Promise, for serializer)
    getUrl() {
      return config.attachments.url + config.attachments.path + this.getFilename();
    }

    // Get public URL of attachment's thumbnail (via Promise, for serializer)
    getThumbnailUrl() {
      if (this.noThumbnail === '1') {
        return this.getUrl();
      }

      return this.getResizedImageUrl('t');
    }

    // Get public URL of resized image attachment
    getResizedImageUrl(sizeId) {
      return (
        config.attachments.url +
        config.attachments.imageSizes[sizeId].path +
        this.getFilename(this.getResizedImageExtension())
      );
    }

    // Get local filesystem path for original file
    getPath() {
      return config.attachments.storage.rootDir + config.attachments.path + this.getFilename();
    }

    getResizedImageExtension() {
      return this.fileExtension === 'webp' ? 'jpg' : this.fileExtension;
    }

    getResizedImageMimeType() {
      return this.fileExtension === 'webp' ? 'image/jpeg' : this.mimeType;
    }

    // Get local filesystem path for resized image file
    getResizedImagePath(sizeId) {
      return (
        config.attachments.storage.rootDir +
        config.attachments.imageSizes[sizeId].path +
        this.getFilename(this.getResizedImageExtension())
      );
    }

    // Get file name
    getFilename(ext = null) {
      if (ext || this.fileExtension) {
        return `${this.id}.${ext || this.fileExtension}`;
      }

      return this.id;
    }

    // Store the file and process its thumbnail, if necessary
    async handleMedia() {
      const tmpAttachmentFile = this.file.path;
      const tmpAttachmentFileName = this.file.name;

      const supportedImageTypes = {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/gif': 'gif',
        'image/webp': 'webp',
        'image/svg+xml': 'svg',
      };
      const supportedAudioTypes = {
        'audio/mpeg': 'mp3',
        'audio/x-m4a': 'm4a',
        'audio/m4a': 'm4a',
        'audio/mp4': 'm4a',
        'audio/ogg': 'ogg',
        'audio/x-wav': 'wav',
      };

      this.mimeType = await mimeTypeDetect(tmpAttachmentFileName, tmpAttachmentFile);
      debug(`Mime-type of ${tmpAttachmentFileName} is ${this.mimeType}`);

      const user = await this.getCreatedBy();

      if (user.preferences.sanitizeMediaMetadata) {
        await sanitizeMediaMetadata(tmpAttachmentFile);
        this.sanitized = SANITIZE_VERSION;
      }

      if (supportedImageTypes[this.mimeType]) {
        // Set media properties for 'image' type
        this.mediaType = 'image';
        this.fileExtension = supportedImageTypes[this.mimeType];
        this.noThumbnail = '1'; // this may be overridden below
        await this.handleImage(tmpAttachmentFile);
      } else if (supportedAudioTypes[this.mimeType]) {
        // Set media properties for 'audio' type
        this.mediaType = 'audio';
        this.fileExtension = supportedAudioTypes[this.mimeType];
        this.noThumbnail = '1';

        if (this.fileExtension === 'm4a') {
          this.mimeType = 'audio/mp4'; // mime-type compatible with music-metadata
        }

        // Analyze metadata to get Artist & Title
        //
        // We need to dynamic import from ES-only modules. Also, for some reason
        // the VSCode eslint extension cannot resolve the 'music-metadata'.
        //
        // eslint-disable-next-line import/no-unresolved
        const { parseFile } = await import('music-metadata');
        const { common: metadata } = await parseFile(tmpAttachmentFile);

        debug(`Metadata of ${tmpAttachmentFileName}`, metadata);

        this.title = metadata.title;

        if (_.isArray(metadata.artist)) {
          [this.artist] = metadata.artist;
        } else {
          this.artist = metadata.artist;
        }
      } else {
        // Set media properties for 'general' type
        this.mediaType = 'general';
        this.noThumbnail = '1';
      }

      // Store an original attachment
      if (this.s3) {
        await this.uploadToS3(
          tmpAttachmentFile,
          config.attachments.path + this.getFilename(),
          this.mimeType,
        );
        await fs.unlink(tmpAttachmentFile);
      } else {
        await mvAsync(tmpAttachmentFile, this.getPath(), {});
      }
    }

    /**
     * @param {string} originalFile
     */
    async handleImage(originalFile) {
      const tmpResizedFile = (sizeId) => `${this.file.path}.resized.${sizeId}`;

      // Store original image size
      let originalSize = await getImageSize(originalFile);
      this.imageSizes.o = {
        w: originalSize.width,
        h: originalSize.height,
        url: this.getUrl(),
      };

      if (this.mimeType === 'image/svg+xml') {
        return;
      }

      // Reserved for GM-style object
      let originalImage = null;

      // Fix EXIF orientation for original image, if JPEG
      if (this.mimeType === 'image/jpeg') {
        originalImage = gm(originalFile);
        originalImage.writeAsync = util.promisify(originalImage.write);

        const autoOrientCommands = await gmAutoOrientCommands(originalFile);

        if (autoOrientCommands) {
          const img = originalImage
            .profile(`${__dirname}/../../lib/assets/sRGB.icm`)
            .out(...autoOrientCommands)
            .quality(95);
          await img.writeAsync(originalFile);

          originalImage = gm(originalFile);
          originalImage.writeAsync = util.promisify(originalImage.write);

          originalSize = await getImageSize(originalFile);
          this.imageSizes.o.w = originalSize.width;
          this.imageSizes.o.h = originalSize.height;
        }

        // In any case, clear all orientation tags
        await clearOrientation(originalFile);
      }

      const thumbIds = [];

      for (const sizeId of Object.keys(config.attachments.imageSizes)) {
        const { bounds } = config.attachments.imageSizes[sizeId];

        if (originalSize.width <= bounds.width && originalSize.height <= bounds.height) {
          continue;
        }

        const size = fitIntoBounds(originalSize, bounds);
        this.imageSizes[sizeId] = {
          w: size.width,
          h: size.height,
          url: this.getResizedImageUrl(sizeId),
        };
        thumbIds.push(sizeId);
      }

      if (thumbIds.length === 0) {
        // No thumbnails
        return;
      }

      this.noThumbnail = '0';

      if (this.mimeType === 'image/gif') {
        // Resize gif using gifsicle
        await Promise.all(
          thumbIds.map(async (sizeId) => {
            const { w, h } = this.imageSizes[sizeId];
            await execFile(gifsicle, [
              '--resize',
              `${w}x${h}`,
              '--resize-colors',
              '128',
              '--no-background',
              '-o',
              tmpResizedFile(sizeId),
              originalFile,
            ]);
          }),
        );
      } else {
        // Iterate over image sizes old-fashioned (and very synchronous) way
        // because gm is acting up weirdly when writing files in parallel mode
        if (originalImage === null) {
          originalImage = gm(originalFile);
          originalImage.writeAsync = util.promisify(originalImage.write);
        }

        for (const sizeId of thumbIds) {
          const { w, h } = this.imageSizes[sizeId];
          await originalImage // eslint-disable-line no-await-in-loop
            .resizeExact(w, h)
            .profile(`${__dirname}/../../lib/assets/sRGB.icm`)
            // Use white background for transparent images
            .background('white')
            .extent('0x0')
            .quality(95)
            .setFormat(this.getResizedImageExtension())
            .writeAsync(tmpResizedFile(sizeId));
        }
      }

      // Save image (permanently)
      if (this.s3) {
        await Promise.all(
          thumbIds.map(async (sizeId) => {
            const { path } = config.attachments.imageSizes[sizeId];
            const file = tmpResizedFile(sizeId);
            await this.uploadToS3(
              file,
              path + this.getFilename(this.getResizedImageExtension()),
              this.getResizedImageMimeType(),
            );
            await fs.unlink(file);
          }),
        );
      } else {
        await Promise.all(
          thumbIds.map(async (sizeId) => {
            const file = tmpResizedFile(sizeId);
            await mvAsync(file, this.getResizedImagePath(sizeId), {});
          }),
        );
      }
    }

    // Upload original attachment or its thumbnail to the S3 bucket
    async uploadToS3(sourceFile, destPath, mimeType) {
      const dispositionName = this.fileExtension
        ? parsePath(this.fileName).name + parsePath(destPath).ext // original extension for whitelisted types, but might be 'jpg' for webp
        : this.fileName; // original extension for non-whitelisted types

      await this.s3.putObject({
        ACL: 'public-read',
        Bucket: this.s3bucket,
        Key: destPath,
        Body: createReadStream(sourceFile),
        ContentType: mimeType,
        ContentDisposition: this.getContentDisposition(dispositionName),
      });
    }

    // Get cross-browser Content-Disposition header for attachment
    getContentDisposition(dispositionName) {
      // Old browsers (IE8) need ASCII-only fallback filenames
      const fileNameAscii = dispositionName.replace(/[^\x00-\x7F]/g, '_');

      // Modern browsers support UTF-8 filenames
      const fileNameUtf8 = encodeURIComponent(dispositionName);

      const disposition = config.media.inlineMimeTypes.includes(this.mimeType)
        ? 'inline'
        : 'attachment';

      // Inline version of 'attfnboth' method (http://greenbytes.de/tech/tc2231/#attfnboth)
      return `${disposition}; filename="${fileNameAscii}"; filename*=utf-8''${fileNameUtf8}`;
    }

    async destroy() {
      await this.deleteFiles();
      await dbAdapter.deleteAttachment(this.id);
    }

    /**
     * Delete all attachment's files
     */
    async deleteFiles() {
      const thumbIds = Object.keys(this.imageSizes).filter((s) => s !== 'o');

      if (this.s3) {
        const keys = [
          config.attachments.path + this.getFilename(),
          ...thumbIds.map((s) => config.attachments.imageSizes[s].path + this.getFilename()),
        ];

        await Promise.all(
          keys.map(async (Key) => {
            try {
              await this.s3.deleteObject({
                Key,
                Bucket: this.s3bucket,
              });
            } catch (err) {
              // It is ok if file isn't found
              if (err.code !== 'NotFound') {
                throw err;
              }
            }
          }),
        );
      } else {
        const filePaths = [this.getPath(), ...thumbIds.map((s) => this.getResizedImagePath(s))];

        await Promise.all(
          filePaths.map(async (filePath) => {
            try {
              await fs.unlink(filePath);
            } catch (err) {
              // It is ok if file isn't found
              if (err.code !== 'ENOENT') {
                throw err;
              }
            }
          }),
        );
      }
    }

    /**
     * Downloads original to the temp directory and returns the local file path
     *
     * @returns {Promise<string>}
     */
    async downloadOriginal() {
      const localFile = join(os.tmpdir(), `${this.id}.orig`);

      if (this.s3) {
        const { Body } = await this.s3.getObject({
          Key: config.attachments.path + this.getFilename(),
          Bucket: this.s3bucket,
        });

        if (!Body) {
          throw new Error('No body in S3 response');
        }

        await fs.writeFile(localFile, Body);
      } else {
        const filePath = this.getPath();
        await fs.copyFile(filePath, localFile);
      }

      return localFile;
    }

    /**
     * Downloads original, sanitizes it and (if changed) uploads it back
     *
     * @returns {Promise<boolean>}
     */
    async sanitizeOriginal() {
      const localFile = await this.downloadOriginal();

      try {
        let updated = false;

        try {
          updated = await sanitizeMediaMetadata(localFile);
        } catch (err) {
          // Exiftool is failed, so the file was not updated and we cannot do
          // anymore here
          debug(`sanitizeOriginal: cannot sanitize attachment ${this.id}: ${err.message}`);
          Raven.captureException(err, {
            extra: {
              err: `sanitizeOriginal: cannot sanitize attachment ${this.id}`,
            },
          });
        }

        if (!updated) {
          // File wasn't changed
          if (this.sanitized !== SANITIZE_VERSION) {
            const updAtt = await dbAdapter.updateAttachment(this.id, {
              updatedAt: 'now',
              sanitized: SANITIZE_VERSION,
            });
            this.updatedAt = updAtt.updatedAt;
            this.sanitized = updAtt.sanitized;
          }

          return false;
        }

        const { size: fileSize } = await fs.stat(localFile);
        const updAtt = await dbAdapter.updateAttachment(this.id, {
          updatedAt: 'now',
          sanitized: SANITIZE_VERSION,
          fileSize,
        });
        this.updatedAt = updAtt.updatedAt;
        this.sanitized = updAtt.sanitized;
        this.fileSize = updAtt.fileSize;

        // Uploading
        if (this.s3) {
          await this.uploadToS3(
            localFile,
            config.attachments.path + this.getFilename(),
            this.mimeType,
          );
        } else {
          await mvAsync(localFile, this.getPath(), {});
        }

        return true;
      } finally {
        try {
          await fs.unlink(localFile);
        } catch (err) {
          if (err.code !== 'ENOENT') {
            debug(`sanitizeOriginal: cannot remove temporary file: ${localFile}`);
            Raven.captureException(err, {
              extra: { err: `sanitizeOriginal: cannot remove temporary file: ${localFile}` },
            });
          }
        }
      }
    }
  };
}

async function getImageSize(fileName) {
  const input = createReadStream(fileName);

  try {
    const { width, height } = await probe(input);
    return { width, height };
  } finally {
    input.destroy();
  }
}

function fitIntoBounds(size, bounds) {
  let width, height;

  if (size.width * bounds.height > size.height * bounds.width) {
    width = bounds.width; // eslint-disable-line prefer-destructuring
    height = Math.max(1, Math.round((size.height * bounds.width) / size.width));
  } else {
    width = Math.max(1, Math.round((size.width * bounds.height) / size.height));
    height = bounds.height; // eslint-disable-line prefer-destructuring
  }

  return { width, height };
}

const orientationCommands = {
  2: ['-flop'],
  3: ['-rotate', 180],
  4: ['-flip'],
  5: ['-flip', '-rotate', 90],
  6: ['-rotate', 90],
  7: ['-flop', '-rotate', 90],
  8: ['-rotate', 270],
};

/**
 * @param {string} fileName
 * @returns {Promise<null | string[]>}
 */
async function gmAutoOrientCommands(fileName) {
  const { 'IFD0:Orientation': orientation } = await exiftool.readRaw(fileName, [
    '-IFD0:Orientation',
    '-G1',
    '-n',
  ]);
  const commands = orientationCommands[orientation];

  if (!commands) {
    return null;
  }

  return [...commands, '-page', '+0+0'];
}

/**
 * Clear all orientation tags
 *
 * @param {string} fileName
 * @returns {Promise<void>}
 */
async function clearOrientation(fileName) {
  const orientTags = ['IFD0:Orientation', 'IFD1:Orientation'];
  const imageTags = await exiftool.readRaw(fileName, [
    ...orientTags.map((t) => `-${t}`),
    '-G1',
    '-n',
  ]);
  const tagsToClean = {};

  // We do not want to change images if it is not necessary, so we ignore tag
  // values of '1' (Normal).
  for (const tag of orientTags) {
    if (tag in imageTags && imageTags[tag] !== 1) {
      tagsToClean[tag] = null;
    }
  }

  if (Object.keys(tagsToClean).length > 0) {
    try {
      await exiftool.write(fileName, tagsToClean, {
        writeArgs: ['-overwrite_original', '-ignoreMinorErrors'],
      });
    } catch {
      // It's ok to fail, we cannot do anything useful in this case
    }
  }
}

import { promises as fs, createReadStream } from 'fs';
import { extname, join, parse as parsePath } from 'path';
import util from 'util';
import os from 'os';

import createDebug from 'debug';
import mime, { lookup } from 'mime-types';
import mv from 'mv';
import Raven from 'raven';
import monitor from 'monitor-dog';

import { s3Client } from '../support/s3';
import { sanitizeMediaMetadata, SANITIZE_NONE, SANITIZE_VERSION } from '../support/sanitize-media';
import { processMediaFile } from '../support/media-files/process';
import { currentConfig } from '../support/app-async-context';
import { createPrepareVideoJob } from '../jobs/attachment-prepare-video';
import { PubSub as pubSub } from '../models';
import { TooManyRequestsException } from '../support/exceptions';

const mvAsync = util.promisify(mv);

const debug = createDebug('freefeed:model:attachment');

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

      this.width = params.width;
      this.height = params.height;
      this.duration = params.duration;

      if ((this.width === null || this.height === null) && params.imageSizes?.o) {
        this.width = params.imageSizes.o.w;
        this.height = params.imageSizes.o.h;
      }

      this._imageSizes = params.imageSizes; // pixel sizes of thumbnail(s) and original image, e.g. {t: {w: 200, h: 175}, o: {w: 600, h: 525}}
      this._previews = params.previews;
      this._meta = params.meta;

      this._artist = params.artist; // filled only for audio
      this._title = params.title; // filled only for audio

      this.userId = params.userId;
      this.postId = params.postId;

      this.sanitized = params.sanitized || SANITIZE_NONE;

      this.createdAt = params.createdAt;
      this.updatedAt = params.updatedAt;
    }

    get previews() {
      if (!this._previews) {
        this._previews = this.getPreviewsDataForLegacyFile();
      }

      return this._previews;
    }

    get meta() {
      if (!this._meta) {
        this._meta = this.getMetaDataForLegacyFile();
      }

      return this._meta;
    }

    getPreviewsDataForLegacyFile() {
      const result = {};

      if (this.mediaType === 'image') {
        const variants = {
          o: '',
          t: 'thumbnails',
          t2: 'thumbnails2',
        };

        result.image = {};

        for (const [key, variant] of Object.entries(variants)) {
          const entry = this._imageSizes[key];

          if (!entry) {
            continue;
          }

          result.image[variant] = {
            w: entry.w,
            h: entry.h,
            ext: entry.url?.split('.').pop(),
          };

          if (!entry.url) {
            debug(`no URL for image size ${variant} of attachment ${this.id}`, this._imageSizes);
          }
        }
      }

      if (this.mediaType === 'audio') {
        result.audio = {
          '': { ext: this.fileExtension },
        };
      }

      return result;
    }

    getMetaDataForLegacyFile() {
      const result = {};

      if (this.mediaType === 'audio') {
        if (this._title) {
          result['dc:title'] = this._title;
        }

        if (this._artist) {
          result['dc:creator'] = this._artist;
        }
      }

      return result;
    }

    static async create(filePath, fileName, user, postId = null) {
      const attCfg = currentConfig().attachments;

      let sanitized = SANITIZE_NONE;

      if (user.preferences.sanitizeMediaMetadata) {
        await sanitizeMediaMetadata(filePath);
        sanitized = SANITIZE_VERSION;
      }

      const { files = {}, ...mediaData } = await processMediaFile(filePath, fileName);

      if (mediaData.meta?.inProgress) {
        // How many of user's media are currently being processed?
        const limit = attCfg.userMediaProcessingLimit;
        const inProgressMedia = await dbAdapter.getInProgressAttachmentsNumber(user.id);

        if (inProgressMedia >= limit) {
          // User has too many media in progress, don't process any more
          debug(
            `user ${user.id} has too many attachments in progress, aborting the ${filePath} processing`,
          );
          await Promise.all(Object.values(files).map((file) => fs.unlink(file.path)));

          throw new TooManyRequestsException(
            `You cannot process more than ${limit} media files at the same time. Please try again later.`,
          );
        }
      }

      // Save record to DB
      const params = {
        ...mediaData,
        sanitized,
        postId,
        userId: user.id,
      };

      const id = await dbAdapter.createAttachment(params);
      /** @type {Attachment} */
      const object = await dbAdapter.getAttachmentById(id);

      if (object.meta.inProgress) {
        let origPath = files['original'].path;

        if (attCfg.sharedMediaDir) {
          origPath = join(attCfg.sharedMediaDir, `${id}.orig`);
          debug(`moving ${files['original'].path} to ${origPath} for further processing`);
          await mvAsync(files['original'].path, origPath);
        }

        debug(`creating ATTACHMENT_PREPARE_VIDEO job for ${id}`);
        await createPrepareVideoJob({ attId: id, filePath: origPath });
        delete files['original'];
      }

      // Upload or move files
      await object._placeFiles(files);

      // Realtime events
      await pubSub.attachmentCreated(id);

      monitor.increment('users.attachments');
      return object;
    }

    /**
     * Finalize attachment creation (called from the ATTACHMENT_PREPARE_VIDEO
     * job handler). This method doesn't update attachment object itself.
     *
     * @param {string} filePath
     * @returns {Promise<void>}
     */
    async finalizeCreation(filePath) {
      debug(`finalizing creation of ${this.id}`);

      try {
        const { files = {}, ...mediaData } = await processMediaFile(filePath, this.fileName, {
          synchronous: true,
        });

        if (!files['']) {
          debug(`no original file to upload (${this.id})`);
          throw new Error('No original file to upload');
        }

        // Upload or move files
        await this._placeFiles(files);

        // Delete stub file
        await this.deleteFiles();

        // Update data
        await dbAdapter.updateAttachment(this.id, { ...mediaData, updatedAt: 'now' });
      } catch (err) {
        debug(`finalizeCreation error: ${err.message}, treat file as 'general' type`);

        const { size: fileSize } = await fs.stat(filePath);
        const ext = extname(this.fileName)
          .toLowerCase()
          .replace(/[^a-z0-9_]/g, '') // Only the restricted set of chars is allowed
          .slice(0, 6); // Limit the length of the extension

        // Upload or move files
        await this._placeFiles({ '': { path: filePath, ext } });

        // Delete stub file
        await this.deleteFiles();

        // Update data
        const toUpdate = {
          updatedAt: 'now',
          mediaType: 'general',
          fileExtension: ext,
          fileSize,
          mimeType: lookup(ext) || 'application/octet-stream',
          previews: {},
          meta: {},
          width: null,
          height: null,
          duration: null,
        };
        await dbAdapter.updateAttachment(this.id, toUpdate);
      }

      // Realtime events
      await pubSub.attachmentUpdated(this.id);

      if (this.postId) {
        await pubSub.updatePost(this.postId);
      }
    }

    /**
     * Upload or move processed files (original or previews)
     *
     * @param {import('../support/media-files/types').FilesToUpload} files
     * @returns {Promise<void>}
     */
    async _placeFiles(files) {
      const storageConfig = currentConfig().attachments.storage;
      debug(`placing files for ${this.id} to ${storageConfig.type}`, files);
      await Promise.all(
        Object.entries(files).map(async ([variant, { path, ext }]) => {
          if (storageConfig.type === 's3') {
            const mimeType = mime.lookup(ext) || 'application/octet-stream';
            await this.uploadToS3(path, this.getRelFilePath(variant, ext), mimeType);
            await fs.unlink(path);
          } else {
            await mvAsync(path, this.getLocalFilePath(variant, ext), { mkdirp: true });
          }
        }),
      );
    }

    /**
     * @param {string} variant
     * @param {string|null} ext
     * @return {string}
     */
    getRelFilePath(variant, ext = null) {
      if (ext === null) {
        ext = this.allFileVariants().find(({ variant: v }) => v === variant)?.ext ?? 'unknown';
      }

      return `${currentConfig().attachments.path}${variant ? `${variant}/` : ''}${this.id}${ext ? `.${ext}` : ''}`;
    }

    getLocalFilePath(variant, ext = null) {
      return currentConfig().attachments.storage.rootDir + this.getRelFilePath(variant, ext);
    }

    getFileUrl(variant, ext = null) {
      return currentConfig().attachments.url + this.getRelFilePath(variant, ext);
    }

    // Get user who created the attachment (via Promise, for serializer)
    getCreatedBy() {
      return dbAdapter.getUserById(this.userId);
    }

    // Upload original attachment or its thumbnail to the S3 bucket
    async uploadToS3(sourceFile, destPath) {
      const { bucket } = currentConfig().attachments.storage;
      const dispositionName = parsePath(this.fileName).name + parsePath(destPath).ext;
      const mimeType = mime.lookup(dispositionName) || 'application/octet-stream';

      await s3Client().putObject({
        ACL: 'public-read',
        Bucket: bucket,
        Key: destPath,
        Body: createReadStream(sourceFile),
        ContentType: mimeType,
        ContentDisposition: this.getContentDisposition(dispositionName),
      });
    }

    // Get cross-browser Content-Disposition header for attachment
    getContentDisposition(dispositionName) {
      const mimeType = mime.lookup(dispositionName) || 'application/octet-stream';

      // Old browsers (IE8) need ASCII-only fallback filenames
      const fileNameAscii = dispositionName.replace(/[^\x00-\x7F]/g, '_');

      // Modern browsers support UTF-8 filenames
      const fileNameUtf8 = encodeURIComponent(dispositionName);

      const disposition = currentConfig().media.inlineMimeTypes.includes(mimeType)
        ? 'inline'
        : 'attachment';

      // Inline version of 'attfnboth' method (http://greenbytes.de/tech/tc2231/#attfnboth)
      return `${disposition}; filename="${fileNameAscii}"; filename*=utf-8''${fileNameUtf8}`;
    }

    /**
     * Get all file variants, including original (variant = '') and previews
     *
     * @param {boolean} includeOriginal
     * @returns {{variant: string, ext: string}[]}
     */
    allFileVariants(includeOriginal = true) {
      const variants = Object.values(this.previews).flatMap((vars) =>
        Object.entries(vars).map(([variant, { ext }]) => ({ variant, ext })),
      );

      if (includeOriginal && !variants.some(({ variant }) => variant === '')) {
        variants.push({ variant: '', ext: this.fileExtension });
      }

      return variants;
    }

    /**
     * Get list of relative paths to attachment's files, including original and previews
     *
     * @param {boolean} includeOriginal
     * @returns {string[]}
     */
    allRelFilePaths(includeOriginal = true) {
      return this.allFileVariants(includeOriginal).map(({ variant, ext }) =>
        this.getRelFilePath(variant, ext),
      );
    }

    /**
     * Return the largest available preview variant of given media type
     *
     * @param {'image'|'video'} mediaType
     * @returns {string|null}
     */
    maxSizedVariant(mediaType) {
      if (!this.previews[mediaType]) {
        return null;
      }

      let maxW = 0;
      let maxVariant = null;

      for (const [variant, { w }] of Object.entries(this.previews[mediaType])) {
        if (w > maxW) {
          maxW = w;
          maxVariant = variant;
        }
      }

      return maxVariant;
    }

    async destroy() {
      await this.deleteFiles();
      await dbAdapter.deleteAttachment(this.id);
    }

    /**
     * Delete all attachment's files
     */
    async deleteFiles() {
      const storageConfig = currentConfig().attachments.storage;

      if (storageConfig.type === 's3') {
        const keys = this.allRelFilePaths();

        await Promise.all(
          keys.map(async (Key) => {
            try {
              await s3Client().deleteObject({
                Key,
                Bucket: storageConfig.bucket,
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
        await Promise.all(
          this.allRelFilePaths().map(async (path) => {
            try {
              await fs.unlink(storageConfig.rootDir + path);
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

      const { type, bucket } = currentConfig().attachments.storage;

      if (type === 's3') {
        const { Body } = await s3Client().getObject({
          Key: this.getRelFilePath('', this.fileExtension),
          Bucket: bucket,
        });

        if (!Body) {
          throw new Error('No body in S3 response');
        }

        await fs.writeFile(localFile, Body);
      } else {
        const filePath = this.getLocalFilePath('', this.fileExtension);
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

          await fs.unlink(localFile);

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

        if (currentConfig().attachments.storage.type === 's3') {
          await this.uploadToS3(
            localFile,
            this.getRelFilePath('', this.fileExtension),
            this.mimeType,
          );
        } else {
          await mvAsync(localFile, this.getLocalFilePath('', this.fileExtension), { mkdirp: true });
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

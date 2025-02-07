import createDebug from 'debug';
import compose from 'koa-compose';
import { isInt } from 'validator';
import { lookup } from 'mime-types';
import { mediaType } from '@hapi/accept';
import { difference } from 'lodash';

import {
  reportError,
  BadRequestException,
  ValidationException,
  NotFoundException,
} from '../../../support/exceptions';
import { serializeAttachment } from '../../../serializers/v2/attachment';
import { serializeUsersByIds } from '../../../serializers/v2/user';
import { authRequired, inputSchemaRequired } from '../../middlewares';
import { dbAdapter, Attachment } from '../../../models';
import { startAttachmentsSanitizeJob } from '../../../jobs/attachments-sanitize';
import { currentConfig } from '../../../support/app-async-context';
import { getBestVariant } from '../../../support/media-files/geometry';
import { getAttachmentsByIdsInputSchema } from '../v2/data-schemes/attachmants';

export default class AttachmentsController {
  app;
  debug;

  constructor(app) {
    this.app = app;
    this.debug = createDebug('freefeed:AttachmentsController');
  }

  create = compose([
    authRequired(),
    async (ctx) => {
      // Accept one file-type field with any name
      const [file] = Object.values(ctx.request.files || []);
      const { user, apiVersion } = ctx.state;

      if (!file) {
        throw new BadRequestException('No file provided');
      }

      try {
        const newAttachment = await Attachment.create(file.filepath, file.originalFilename, user);

        ctx.body = {
          attachments: serializeAttachment(newAttachment, apiVersion),
          users: await serializeUsersByIds([newAttachment.userId], user.id),
        };
      } catch (e) {
        if (e.message && e.message.indexOf('Corrupt image') > -1) {
          this.debug(e.message);

          const errorDetails = { message: 'Corrupt image' };
          reportError(ctx)(errorDetails);
          return;
        }

        if (e.message && e.message.indexOf('LCMS encoding') > -1) {
          this.debug(`GraphicsMagick should be configured with --with-lcms2 option`);

          const errorDetails = { status: 500, message: 'Internal server error' };
          reportError(ctx)(errorDetails);
          return;
        }

        reportError(ctx)(e);
      }
    },
  ]);

  my = compose([
    authRequired(),
    async (ctx) => {
      const { user, apiVersion } = ctx.state;
      const { limit: qLimit, page: qPage } = ctx.request.query;

      const DEFAULT_LIMIT = 30;
      const MAX_LIMIT = 100;

      let limit = DEFAULT_LIMIT,
        page = 1;

      if (typeof qLimit !== 'undefined') {
        if (!isInt(qLimit, { min: 1 })) {
          throw new ValidationException("Invalid 'limit' value");
        }

        limit = Number.parseInt(qLimit, 10);

        if (limit > MAX_LIMIT) {
          limit = MAX_LIMIT;
        }
      }

      if (typeof qPage !== 'undefined') {
        if (!isInt(qPage, { min: 1 })) {
          throw new ValidationException("Invalid 'page' value");
        }

        page = Number.parseInt(qPage, 10);
      }

      const attachments = await dbAdapter.listAttachments({
        userId: user.id,
        limit: limit + 1,
        offset: limit * (page - 1),
      });

      const hasMore = attachments.length > limit;

      if (hasMore) {
        attachments.length = limit;
      }

      ctx.body = {
        attachments: attachments.map((a) => serializeAttachment(a, apiVersion)),
        users: await serializeUsersByIds([user.id], user.id),
        hasMore,
      };
    },
  ]);

  myStats = compose([
    authRequired(),
    async (ctx) => {
      const { user } = ctx.state;
      const [stats, task] = await Promise.all([
        dbAdapter.getAttachmentsStats(user.id),
        dbAdapter.getAttachmentsSanitizeTask(user.id),
      ]);
      ctx.body = {
        attachments: stats,
        sanitizeTask: task && { createdAt: task.createdAt },
      };
    },
  ]);

  mySanitize = compose([
    authRequired(),
    async (ctx) => {
      const { user } = ctx.state;
      const task = await startAttachmentsSanitizeJob(user);
      ctx.body = {
        sanitizeTask: { createdAt: task.createdAt },
      };
    },
  ]);

  async getById(ctx) {
    const { attId } = ctx.params;
    const { user, apiVersion } = ctx.state;

    const attachment = await dbAdapter.getAttachmentById(attId);

    if (!attachment) {
      throw new NotFoundException('Attachment not found');
    }

    const serAttachment = serializeAttachment(attachment, apiVersion);
    const users = await serializeUsersByIds([attachment.userId], user?.id);

    ctx.body = {
      attachments: serAttachment,
      users,
    };
  }

  /**
   * @param {import('koa').Context} ctx
   */
  async getPreview(ctx) {
    const { attId, type } = ctx.params;
    const { query } = ctx.request;
    const { useImgProxy } = currentConfig().attachments;
    const imageFormats = ['jpeg', 'webp', 'avif'];
    const formatExtensions = {
      jpeg: 'jpg',
      webp: 'webp',
      avif: 'avif',
    };

    if (!['original', 'image', 'video', 'audio'].includes(type)) {
      throw new NotFoundException('Invalid preview type');
    }

    if ('format' in query && !imageFormats.includes(query.format)) {
      throw new ValidationException('Invalid format value');
    }

    const width = 'width' in query ? Number.parseInt(query.width, 10) : undefined;
    const height = 'height' in query ? Number.parseInt(query.height, 10) : undefined;

    if (
      (width && (!Number.isFinite(width) || width <= 0)) ||
      (height && (!Number.isFinite(height) || height <= 0))
    ) {
      throw new ValidationException('Invalid width/height values');
    }

    const asRedirect = 'redirect' in query;

    const attachment = await dbAdapter.getAttachmentById(attId);

    if (!attachment) {
      throw new NotFoundException('Attachment not found');
    }

    if (type !== 'original' && !(type in attachment.previews)) {
      throw new NotFoundException('Preview of specified type not found');
    }

    const response = {};

    if (type === 'original') {
      response.url = attachment.getFileUrl('');
      response.mimeType = attachment.mimeType;

      if (attachment.width && attachment.height) {
        response.width = attachment.width;
        response.height = attachment.height;
      }
    } else if (type === 'audio') {
      // We always have one audio preview
      const [[variant, { ext }]] = Object.entries(attachment.previews.audio);
      response.url = attachment.getFileUrl(variant);
      response.mimeType = lookup(ext) || 'application/octet-stream';
    } else {
      // Visual types, 'image' and 'video'

      const previews = attachment.previews[type];
      const {
        variant,
        width: resWidth,
        height: resHeight,
      } = getBestVariant(previews, width, height);
      const prv = previews[variant];

      response.url = attachment.getFileUrl(variant);
      response.mimeType = lookup(prv.ext) || 'application/octet-stream';
      response.width = prv.w;
      response.height = prv.h;

      // With imgproxy, we can resize images and change their format
      if (type === 'image' && useImgProxy) {
        let { format } = query;

        if (!format) {
          const acceptedTypes = imageFormats.map((f) => `image/${f}`);
          format = mediaType(ctx.headers.accept ?? 'image/jpeg', acceptedTypes);

          if (acceptedTypes.includes(format)) {
            format = format.replace('image/', '');
          } else {
            format = 'jpeg';
          }
        }

        const fileUrl = new URL(response.url);

        if (prv.ext !== formatExtensions[format]) {
          fileUrl.searchParams.set('format', format);
          response.mimeType = `image/${format}`;
        }

        if (resWidth !== prv.w || resHeight !== prv.h) {
          fileUrl.searchParams.set('width', resWidth.toString());
          fileUrl.searchParams.set('height', resHeight.toString());
          response.width = resWidth;
          response.height = resHeight;
        }

        response.url = fileUrl.toString();
      }
    }

    if (asRedirect) {
      if (!attachment.meta.inProgress) {
        // If the attachment is ready, we can use permanent redirect
        ctx.status = 301;
        ctx.set('Cache-Control', 'max-age=3600');
      }

      ctx.redirect(response.url);
      ctx.body = `Redirecting to ${response.url}`;
    } else {
      ctx.body = response;
    }
  }

  getByIds = compose([
    inputSchemaRequired(getAttachmentsByIdsInputSchema),
    async (ctx) => {
      const maxAttByIds = 100;

      const { user: viewer, apiVersion } = ctx.state;
      const { ids } = ctx.request.body;

      const hasMore = ids.length > maxAttByIds;

      if (hasMore) {
        ids.length = maxAttByIds;
      }

      const atts = (await dbAdapter.getAttachmentsByIds(ids)).filter(Boolean);

      const attachments = atts.map((a) => serializeAttachment(a, apiVersion));
      const users = await serializeUsersByIds(
        atts.map((a) => a.userId),
        viewer?.id,
      );
      const idsFound = atts.map((p) => p.id);
      const idsNotFound = difference(ids, idsFound);

      ctx.body = {
        attachments,
        users,
        idsNotFound,
      };
    },
  ]);
}

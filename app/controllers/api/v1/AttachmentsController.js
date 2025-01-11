import createDebug from 'debug';
import compose from 'koa-compose';
import { isInt } from 'validator';

import { reportError, BadRequestException, ValidationException } from '../../../support/exceptions';
import { serializeAttachment } from '../../../serializers/v2/attachment';
import { serializeUsersByIds } from '../../../serializers/v2/user';
import { authRequired } from '../../middlewares';
import { dbAdapter, Attachment } from '../../../models';
import { startAttachmentsSanitizeJob } from '../../../jobs/attachments-sanitize';

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
      const { user } = ctx.state;

      if (!file) {
        throw new BadRequestException('No file provided');
      }

      try {
        const newAttachment = await Attachment.create(file.filepath, file.originalFilename, user);

        ctx.body = {
          attachments: serializeAttachment(newAttachment),
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
      const { user } = ctx.state;
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
        attachments: attachments.map(serializeAttachment),
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
}

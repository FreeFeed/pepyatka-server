import validator from 'validator';

import { Attachment } from '../../models';
import { SANITIZE_VERSION } from '../sanitize-media';

import { initObject, prepareModelPayload } from './utils';

///////////////////////////////////////////////////
// Attachments
///////////////////////////////////////////////////

const cacheVersion = 2;
const cacheTTL = 3 * 60 * 60; // 3 hours

const attachmentsTrait = (superClass) =>
  class extends superClass {
    async createAttachment(payload) {
      const preparedPayload = prepareModelPayload(
        payload,
        ATTACHMENT_COLUMNS,
        ATTACHMENT_COLUMNS_MAPPING,
      );
      const res = await this.database('attachments').returning('uid').insert(preparedPayload);
      return res[0].uid;
    }

    async getAttachmentById(id) {
      if (!validator.isUUID(id)) {
        return null;
      }

      const attrs = await this.getCachedAttachmentData(id);
      return initAttachmentObject(attrs);
    }

    async getAttachmentsByIds(ids) {
      const data = await this.getCachedAttachmentsData(ids);
      return data.map(initAttachmentObject);
    }

    async listAttachments({ userId, limit, offset = 0 }) {
      const rows = await this.database.getAll(
        `select * from attachments where 
          user_id = :userId 
          order by created_at desc limit :limit offset :offset`,
        { userId, limit, offset },
      );

      return rows.map(initAttachmentObject);
    }

    async updateAttachment(attachmentId, payload) {
      const preparedPayload = prepareModelPayload(
        payload,
        ATTACHMENT_COLUMNS,
        ATTACHMENT_COLUMNS_MAPPING,
      );

      const [row] = await this.database('attachments')
        .where('uid', attachmentId)
        .update(preparedPayload)
        .returning('*');

      await this.dropCachedAttachmentData(attachmentId);
      return initAttachmentObject(row);
    }

    async deleteAttachment(id) {
      await this.database.raw(`delete from attachments where uid = ?`, id);
      await this.dropCachedAttachmentData(id);
    }

    async linkAttachmentToPost(attachmentId, postId, ord = 0) {
      const payload = { post_id: postId, ord };
      await this.database('attachments').where('uid', attachmentId).update(payload);
      await this.dropCachedAttachmentData(attachmentId);
    }

    async unlinkAttachmentFromPost(attachmentId, postId) {
      const payload = { post_id: null };
      await this.database('attachments')
        .where('uid', attachmentId)
        .where('post_id', postId)
        .update(payload);
      await this.dropCachedAttachmentData(attachmentId);
    }

    async getPostAttachments(postId) {
      const res = await this.database('attachments')
        .select('uid')
        .orderBy('ord', 'asc')
        .orderBy('created_at', 'asc')
        .where('post_id', postId);
      const attrs = res.map((record) => {
        return record.uid;
      });
      return attrs;
    }

    async getAttachmentsOfPost(postId) {
      const responses = await this.database('attachments')
        .orderBy('ord', 'asc')
        .orderBy('created_at', 'asc')
        .where('post_id', postId);
      return responses.map(initAttachmentObject);
    }

    async createAttachmentsSanitizeTask(userId) {
      const row = await this.database.getRow(
        `insert into attachments_sanitize_task (user_id) values (:userId)
        on conflict (user_id) do 
        -- update row for the 'returning' statement
        update set user_id = excluded.user_id
        returning *`,
        { userId },
      );
      return initSanitizeTaskObject(row);
    }

    async deleteAttachmentsSanitizeTask(userId) {
      await this.database.raw(`delete from attachments_sanitize_task where user_id = :userId`, {
        userId,
      });
    }

    async getAttachmentsSanitizeTask(userId) {
      const row = await this.database.getRow(
        `select * from attachments_sanitize_task where user_id = :userId`,
        { userId },
      );
      return initSanitizeTaskObject(row);
    }

    async getNonSanitizedAttachments(userId, limit) {
      const rows = await this.database.getAll(
        `select * from attachments where 
            user_id = :userId and sanitized <> :sanVersion 
            order by created_at limit :limit`,
        { userId, sanVersion: SANITIZE_VERSION, limit },
      );
      return rows.map(initAttachmentObject);
    }

    async getAttachmentsStats(userId) {
      const rows = await this.database.getAll(
        `select sanitized, count(*)::int from attachments where user_id = :userId group by sanitized`,
        { userId },
      );
      return {
        total: rows.reduce((sum, row) => sum + row.count, 0),
        sanitized: rows
          .filter((row) => row.sanitized === SANITIZE_VERSION)
          .reduce((sum, row) => sum + row.count, 0),
      };
    }

    async getInProgressAttachmentsNumber(userId) {
      return await this.database.getOne(
        `select count(*)::int from attachments where user_id = :userId and meta @> '{ "inProgress": true }'`,
        { userId },
      );
    }

    // Attachments cache

    async dropCachedAttachmentData(attachmentId) {
      await this.cache.del(cacheKey(attachmentId));
    }

    async getCachedAttachmentData(attachmentId) {
      const key = cacheKey(attachmentId);
      let data = await this.cache.get(key);

      if (!data) {
        data = await this.database.getRow('select * from attachments where uid = :attachmentId', {
          attachmentId,
        });

        if (data) {
          await this.cache.set(key, data, cacheTTL);
        }
      }

      return data;
    }

    async getCachedAttachmentsData(attachmentIds) {
      if (attachmentIds.length === 0) {
        return [];
      }

      if (this.cache.store.name === 'redis') {
        const keys = attachmentIds.map((id) => cacheKey(id));
        const client = await this.cache.store.getClient();
        const data = (await client.mget(keys)).map((x) => (x ? JSON.parse(x) : null));

        const missedIds = data.map((attrs, i) => (attrs ? null : attachmentIds[i])).filter(Boolean);

        if (missedIds.length > 0) {
          const missedData = await this.database('attachments').whereIn('uid', missedIds);
          await Promise.all(
            missedData.map((attrs) => this.cache.set(cacheKey(attrs.uid), attrs, cacheTTL)),
          );

          for (let i = 0; i < data.length; i++) {
            if (data[i]) {
              continue;
            }

            const rec = missedData.find((attrs) => attrs.uid === attachmentIds[i]);

            if (rec) {
              data[i] = rec;
            }
          }
        }

        return data;
      }

      return Promise.all(attachmentIds.map((id) => this.getCachedAttachmentData(id)));
    }
  };

export default attachmentsTrait;

///////////////////////////////////////////////////

function initSanitizeTaskObject(row) {
  if (!row) {
    return null;
  }

  return {
    userId: row.user_id,
    createdAt: new Date(row.created_at),
  };
}

export function initAttachmentObject(attrs) {
  if (!attrs) {
    return null;
  }

  attrs = prepareModelPayload(attrs, ATTACHMENT_FIELDS, ATTACHMENT_FIELDS_MAPPING);
  return initObject(Attachment, attrs, attrs.id);
}

const ATTACHMENT_COLUMNS = {
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  fileName: 'file_name',
  fileSize: 'file_size',
  mimeType: 'mime_type',
  mediaType: 'media_type',
  fileExtension: 'file_extension',
  imageSizes: 'image_sizes',
  artist: 'artist',
  title: 'title',
  userId: 'user_id',
  postId: 'post_id',
  sanitized: 'sanitized',
  previews: 'previews',
  meta: 'meta',
  width: 'width',
  height: 'height',
  duration: 'duration',
};

const ATTACHMENT_COLUMNS_MAPPING = {
  /**
   * @param {Date|null|'now'} timestamp
   * @returns {string|null}
   */
  createdAt: (timestamp) => {
    return timestamp instanceof Date ? timestamp.toISOString() : timestamp;
  },
  /**
   * @param {Date|null|'now'} timestamp
   * @returns {string|null}
   */
  updatedAt: (timestamp) => {
    return timestamp instanceof Date ? timestamp.toISOString() : timestamp;
  },
  imageSizes: (image_sizes) => {
    return image_sizes ? JSON.stringify(image_sizes) : null;
  },
  previews: (previews) => {
    return previews ? JSON.stringify(previews) : null;
  },
  meta: (meta) => {
    return meta ? JSON.stringify(meta) : null;
  },
};

export const ATTACHMENT_FIELDS = {
  uid: 'id',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
  file_name: 'fileName',
  file_size: 'fileSize',
  mime_type: 'mimeType',
  media_type: 'mediaType',
  file_extension: 'fileExtension',
  image_sizes: 'imageSizes',
  artist: 'artist',
  title: 'title',
  user_id: 'userId',
  post_id: 'postId',
  sanitized: 'sanitized',
  previews: 'previews',
  meta: 'meta',
  width: 'width',
  height: 'height',
  duration: 'duration',
};

const ATTACHMENT_FIELDS_MAPPING = {
  no_thumbnail: (no_thumbnail) => {
    return no_thumbnail ? '1' : '0';
  },
  file_size: (file_size) => {
    return file_size && parseInt(file_size);
  },
  image_sizes: (image_sizes) => {
    return image_sizes ? JSON.parse(image_sizes) : '';
  },
  // 'created_at' may come from DB as Date or from Redis as string
  created_at: (created_at) => {
    return typeof created_at === 'string' ? new Date(created_at) : created_at;
  },
  // 'updated_at' may come from DB as Date or from Redis as string
  updated_at: (updated_at) => {
    return typeof updated_at === 'string' ? new Date(updated_at) : updated_at;
  },
};

function cacheKey(attId) {
  return `attachment_${cacheVersion}_${attId}`;
}

import { currentConfig } from '../../support/app-async-context';

export function serializeAttachment(att) {
  return serializeAttachmentV3(att);
}

/**
 * @typedef {import('../../models').Attachment} Attachment
 */

/**
 * @param {Attachment} att
 * @returns
 */
function serializeAttachmentV3(att) {
  const result = {
    id: att.id,
    mediaType: att.mediaType,
    fileName: att.fileName,
    fileSize: att.fileSize.toString(),
    createdAt: att.createdAt.getTime().toString(),
    updatedAt: att.updatedAt.getTime().toString(),
    url: currentConfig().attachments.url + att.getRelFilePath('', att.fileExtension),
    thumbnailUrl: currentConfig().attachments.url + att.getRelFilePath('', att.fileExtension),
    imageSizes: {},
    createdBy: att.userId,
    postId: att.postId,
  };

  if (att.mediaType === 'image') {
    let maxWidth = 0;

    for (const [variant, { w, h, ext }] of Object.entries(att.previews.image)) {
      if (variant === 'thumbnails') {
        result.imageSizes['t'] = { w, h, url: att.getFileUrl(variant, ext) };
        result.thumbnailUrl = att.getFileUrl(variant, ext);
      }

      if (variant === 'thumbnails2') {
        result.imageSizes['t2'] = { w, h, url: att.getFileUrl(variant, ext) };
      }

      if (w > maxWidth) {
        maxWidth = w;
        result.imageSizes['o'] = { w, h, url: att.getFileUrl(variant, ext) };
      }
    }
  }

  if (att.mediaType === 'audio') {
    result.artist = att.meta['dc:creator'];
    result.title = att.meta['dc:title'];
  }

  return result;
}

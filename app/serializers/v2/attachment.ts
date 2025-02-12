import { API_VERSION_3 } from '../../api-versions';
import type { Attachment } from '../../models';
import { currentConfig } from '../../support/app-async-context';
import { setExtension } from '../../support/media-files/file-ext';
import type { MediaMetaData, MediaPreviews, MediaType } from '../../support/media-files/types';
import type { ISO8601DateTimeString, UUID } from '../../support/types';

type SerializedAttachmentV2 = {
  id: UUID;
  mediaType: Exclude<MediaType, 'video'>;
  fileName: string;
  fileSize: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  thumbnailUrl: string;
  imageSizes: Record<string, { w: number; h: number; url: string }>;
  createdBy: UUID;
  postId: UUID | null;
  artist?: string;
  title?: string;
  inProgress?: true;
};

type SerializedAttachmentV4 = {
  id: UUID;
  mediaType: MediaType;
  fileName: string;
  fileSize: number;
  previewTypes: (keyof MediaPreviews)[];
  // File metadata, don't send if empty
  meta?: MediaMetaData;
  // Original size, only send for visual types (image, video)
  width?: number;
  height?: number;
  // Duration in seconds, only for playable files (video, audio). Can be absent
  // for old (pre-v4) files.
  duration?: number;
  // Maximum possible preview size, only when different from the (width, height)
  previewWidth?: number;
  previewHeight?: number;

  createdAt: ISO8601DateTimeString;
  updatedAt: ISO8601DateTimeString;
  createdBy: UUID;
  postId: UUID | null;
};

export function serializeAttachment(att: Attachment, apiVersion: number) {
  if (apiVersion <= API_VERSION_3) {
    return serializeAttachmentV2(att);
  }

  return serializeAttachmentV4(att);
}

function serializeAttachmentV2(att: Attachment): SerializedAttachmentV2 {
  const result: SerializedAttachmentV2 = {
    id: att.id,
    mediaType: att.mediaType !== 'video' ? att.mediaType : 'general',
    fileName: att.fileName,
    fileSize: att.fileSize.toString(),
    createdAt: att.createdAt.getTime().toString(),
    updatedAt: att.updatedAt.getTime().toString(),
    url: currentConfig().attachments.url + att.getRelFilePath('', att.fileExtension),
    thumbnailUrl: currentConfig().attachments.url + att.getRelFilePath('', att.fileExtension),
    imageSizes: {} as Record<string, { w: number; h: number; url: string }>,
    createdBy: att.userId,
    postId: att.postId,
  };

  if (att.mediaType === 'image') {
    let maxWidth = 0;

    for (const [variant, { w, h, ext }] of Object.entries(att.previews.image ?? {})) {
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

  if (att.mediaType === 'video') {
    if (att.meta.animatedImage) {
      // Show it as 'image'
      result.mediaType = 'image';

      for (const [variant, { w, h, ext }] of Object.entries(att.previews.image ?? {})) {
        if (variant === 'thumbnails') {
          result.imageSizes['t'] = { w, h, url: att.getFileUrl(variant, ext) };
          result.thumbnailUrl = att.getFileUrl(variant, ext);
        }

        if (variant === 'thumbnails2') {
          result.imageSizes['t2'] = { w, h, url: att.getFileUrl(variant, ext) };
        }
      }

      result.imageSizes['o'] = { w: att.width!, h: att.height!, url: result.url };
    } else {
      // Show it as 'general'
      result.mediaType = 'general';
    }
  }

  if (att.meta.inProgress) {
    result.inProgress = true;

    if (att.mediaType === 'video') {
      // Optimistically set the URL as the URL of after-processed video
      result.fileName = setExtension(att.fileName, 'mp4');
      result.url = currentConfig().attachments.url + att.getRelFilePath('', 'mp4');
      result.thumbnailUrl = result.url;
    }
  }

  return result;
}

function serializeAttachmentV4(att: Attachment): SerializedAttachmentV4 {
  const maxVar = att.maxSizedVariant('image');
  const maxPrv = att.previews.image?.[maxVar ?? '-'];

  const isMetaEmpty = Object.keys(att.meta).length === 0;
  const isPreviewSizesDifferent = maxPrv && (maxPrv.w !== att.width || maxPrv.h !== att.height);

  return {
    id: att.id,
    mediaType: att.mediaType,
    fileName: att.fileName,
    fileSize: att.fileSize,
    previewTypes: Object.keys(att.previews).sort() as (keyof MediaPreviews)[],
    meta: isMetaEmpty ? undefined : att.meta,

    width: att.width ?? undefined,
    height: att.height ?? undefined,
    duration: att.duration ?? undefined,

    previewWidth: isPreviewSizesDifferent ? maxPrv?.w : undefined,
    previewHeight: isPreviewSizesDifferent ? maxPrv?.h : undefined,

    createdAt: att.createdAt.toISOString(),
    updatedAt: att.updatedAt.toISOString(),
    createdBy: att.userId,
    postId: att.postId,
  };
}

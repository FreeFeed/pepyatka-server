import { stat } from 'fs/promises';

import { lookup as mimeLookup } from 'mime-types';
import { exiftool } from 'exiftool-vendored';

import { spawnAsync } from '../spawn-async';

import { detectMediaType } from './detect';
import {
  FilesToUpload,
  MediaInfoAudio,
  MediaInfoImage,
  MediaProcessResult,
  NonVisualPreviews,
  VisualPreviews,
} from './types';
import { getImagePreviewSizes } from './geometry';

/**
 * Process media file:
 * 1. Detect media type
 * 2. Generate previews or schedule them to be generated in the background
 * 3. Return data for create DB record
 */
export async function processMediaFile(
  localFilePath: string,
  origFileName: string,
): Promise<MediaProcessResult> {
  const info = await detectMediaType(localFilePath, origFileName);
  const fileStat = await stat(localFilePath);

  const commonResult = {
    fileExtension: info.extension,
    fileSize: fileStat.size,
    fileName: origFileName,
    mimeType: mimeLookup(info.extension) || 'application/octet-stream',
  };

  if (info.type === 'image') {
    const [imagePreviews, files] = await processImage(info, localFilePath);
    return { mediaType: 'image', ...commonResult, previews: { image: imagePreviews }, files };
  }

  if (info.type === 'audio') {
    const [audioPreviews, files] = await processAudio(info, localFilePath);
    const meta: MediaProcessResult['meta'] = {};

    if (info.tags?.title) {
      meta['dc:title'] = info.tags.title;
    }

    if (info.tags?.artist) {
      meta['dc:creator'] = info.tags.artist;
    }

    return {
      mediaType: 'audio',
      ...commonResult,
      duration: info.duration,
      previews: { audio: audioPreviews },
      meta,
      files,
    };
  }

  return { mediaType: 'general', ...commonResult };
}

async function processImage(
  info: MediaInfoImage,
  localFilePath: string,
): Promise<[VisualPreviews, FilesToUpload]> {
  const previewSizes = getImagePreviewSizes(info);

  // Now we should create all the previews

  const [maxPreviewSize] = previewSizes;

  if (maxPreviewSize.width === info.width && maxPreviewSize.height === info.height) {
    // We can probably use original as a largest preview
    const fileSize = await stat(localFilePath).then((s) => s.size);

    if (
      // We can always use original in case of WebP and (some) JPEGs
      ['jpeg', 'webp'].includes(info.format) ||
      // We can use original in case of PNG and GIF if it is not too big
      (['png', 'gif'].includes(info.format) && fileSize < 512 * 1024)
    ) {
      if (info.format === 'jpeg') {
        const ok = await canUseJpegOriginal(localFilePath);

        if (ok) {
          maxPreviewSize.variant = '';
        }
      } else {
        maxPreviewSize.variant = '';
      }
    }
  }

  const previews: VisualPreviews = {};
  const filesToUpload: FilesToUpload = { '': { path: localFilePath, ext: info.extension } };

  await Promise.all(
    previewSizes.map(async ({ variant, width, height }) => {
      if (variant === '') {
        previews[variant] = { w: width, h: height, ext: info.extension };
        return;
      }

      await spawnAsync('convert', [
        localFilePath,
        '-auto-orient',
        '-resize',
        `${width}!x${height}!`,
        '-profile',
        `${__dirname}/../../../lib/assets/sRGB.icm`,
        '-strip',
        '-quality',
        '75',
        `webp:${tmpFileVariant(localFilePath, variant, 'webp')}`,
      ]);

      previews[variant] = { w: width, h: height, ext: 'webp' };
      filesToUpload[variant] = {
        path: tmpFileVariant(localFilePath, variant, 'webp'),
        ext: 'webp',
      };
    }),
  );

  return [previews, filesToUpload];
}

async function processAudio(
  info: MediaInfoAudio,
  localFilePath: string,
): Promise<[NonVisualPreviews, FilesToUpload]> {
  const previews: NonVisualPreviews = {};
  const filesToUpload: FilesToUpload = { '': { path: localFilePath, ext: info.extension } };

  if (
    (info.format === 'mp3' && info.aCodec === 'mp3') ||
    (info.format === 'mov' && info.aCodec === 'aac')
  ) {
    // We don't need to generate previews for mp3 and m4a audio files
    previews[''] = { ext: info.extension };
    return [previews, filesToUpload];
  }

  const variant = 'a1';
  const ext = 'm4a';
  const outFile = tmpFileVariant(localFilePath, variant, ext);

  await spawnAsync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    localFilePath,
    '-y', // Overwrite existing file
    '-map',
    '0:a:0', // Use only the first audio stream
    '-c:a',
    'aac', // Convert to AAC
    '-b:a',
    '192k', // Set bitrate to 192k
    '-sn', // Skip subtitles (if any)
    '-dn', // Skip other data (if any)
    '-map_metadata',
    '-1', // Remove all metadata
    '-f',
    'mp4', // Output in m4a/mov container
    outFile,
  ]);

  previews[variant] = { ext };
  filesToUpload[variant] = { path: outFile, ext };

  return [previews, filesToUpload];
}

function tmpFileVariant(filePath: string, variant: string, ext: string): string {
  return `${filePath}.variant.${variant}.${ext}`;
}

/**
 * Can we use the original JPEG file for preview? If so, then process it and
 * return true, otherwise return false.
 *
 * The image can be:
 *  1. Rotated
 *  2. Have a non-RGB colorspace
 *  3. Have a non-sRGB color profile
 *  4. Have an additional image layer (HDR, etc.)
 *
 * When none of these conditions apply, we can use the original image without
 * changes. Otherwise return false.
 */
async function canUseJpegOriginal(localFilePath: string): Promise<boolean> {
  const tags = await exiftool.readRaw(localFilePath, ['-G1', '-n']);
  const {
    'File:ColorComponents': colorComponents,
    'ICC_Profile:ProfileDescription': profileDescription = null,
    'IFD0:Orientation': orientation = null,
    'MPF0:NumberOfImages': numberOfImages = 1,
  } = tags;

  return (
    // 3-component image
    colorComponents === 3 &&
    // sRGB profile
    (typeof profileDescription !== 'string' || profileDescription.startsWith('sRGB ')) &&
    // Have only one image
    (typeof numberOfImages !== 'number' || numberOfImages === 1) &&
    // Have no rotation
    (typeof orientation !== 'number' || orientation === 1)
  );
}

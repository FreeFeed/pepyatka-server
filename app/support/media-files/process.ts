import { stat, unlink, writeFile } from 'fs/promises';

import { lookup as mimeLookup } from 'mime-types';
import { exiftool } from 'exiftool-vendored';

import { spawnAsync, SpawnAsyncArgs } from '../spawn-async';
import { currentConfig } from '../app-async-context';
import { ContentTooLargeException } from '../exceptions';

import { detectMediaType } from './detect';
import {
  Box,
  FilesToUpload,
  MediaInfoAudio,
  MediaInfoImage,
  MediaInfoVideo,
  MediaProcessResult,
  NonVisualPreviews,
  VisualPreviews,
} from './types';
import { getImagePreviewSizes, getVideoPreviewSizes } from './geometry';

type FileProps = {
  fileName: string;
  fileExtension: string;
  fileSize: number;
  mimeType: string;
};

/**
 * Process media file:
 * 1. Detect media type
 * 2. Generate previews or schedule them to be generated in the background
 * 3. Return data for create DB record
 */
export async function processMediaFile(
  localFilePath: string,
  origFileName: string,
  {
    // Process media in this function call, don't create delayed processing job
    synchronous = false,
  } = {},
): Promise<MediaProcessResult> {
  const info = await detectMediaType(localFilePath, origFileName);

  const commonResult = {
    ...(await fileProps(localFilePath, origFileName, info.extension)),
    meta: {} as MediaProcessResult['meta'],
    width: undefined as number | undefined,
    height: undefined as number | undefined,
    duration: undefined as number | undefined,
  };

  // Check the file size, if it is too big, throw an error
  {
    const limits = currentConfig().attachments.fileSizeLimitByType;
    const sizeLimit = limits[info.type] ?? limits['default'];

    if (commonResult.fileSize > sizeLimit) {
      throw new ContentTooLargeException(
        `This '${info.type}' file is too large (the maximum size is ${sizeLimit} bytes)`,
      );
    }
  }

  if (info.type === 'image' || info.type === 'video') {
    commonResult.width = info.width;
    commonResult.height = info.height;
  }

  if (info.type === 'audio' || info.type === 'video') {
    commonResult.duration = info.duration;

    if (info.tags?.title) {
      commonResult.meta!['dc:title'] = info.tags.title;
    }

    if (info.tags?.artist) {
      commonResult.meta!['dc:creator'] = info.tags.artist;
    }
  }

  if (info.type === 'image') {
    const [imagePreviews, files] = await processImage(info, localFilePath);
    return { mediaType: 'image', ...commonResult, previews: { image: imagePreviews }, files };
  }

  if (info.type === 'audio') {
    const [audioPreviews, files] = await processAudio(info, localFilePath);

    return {
      mediaType: 'audio',
      ...commonResult,
      duration: info.duration,
      previews: { audio: audioPreviews },
      files,
    };
  }

  if (info.type === 'video') {
    const meta: MediaProcessResult['meta'] = {};

    if (info.isAnimatedImage) {
      meta.animatedImage = true;
      meta.silent = true;
    }

    if (!info.aCodec) {
      meta.silent = true;
    }

    if (!info.isAnimatedImage && !synchronous) {
      // Truly video, should create processing task
      const stubContent = 'This file is being processed.';
      const stubFilePath = tmpFileVariant(localFilePath, '', 'tmp');
      await writeFile(stubFilePath, stubContent);

      meta.inProgress = true;

      const [maxPreviewSize] = getVideoPreviewSizes(info);

      return {
        mediaType: 'video',
        ...commonResult,
        ...(await fileProps(stubFilePath, origFileName, 'tmp')),
        mimeType: 'text/plain',
        duration: info.duration,
        width: maxPreviewSize.width,
        height: maxPreviewSize.height,
        previews: {},
        meta,
        files: {
          '': { path: stubFilePath, ext: 'tmp' },
          original: { path: localFilePath, ext: info.extension },
        },
      };
    }

    const [previews, files] = await processVideo(info, localFilePath);

    let origProps: Partial<FileProps & { width: number; height: number }> = {};

    // For video files we may not keep the original, so get some props from the '' file
    const origFile = files[''];
    const origPreview = previews.video?.[''];

    if (origFile) {
      origProps = await fileProps(origFile.path, origFileName, origFile.ext);
    }

    if (origPreview) {
      origProps.width = origPreview.w;
      origProps.height = origPreview.h;
    }

    return {
      mediaType: 'video',
      ...commonResult,
      ...origProps,
      previews,
      meta,
      files,
    };
  }

  return {
    mediaType: 'general',
    ...commonResult,
    files: { '': { path: localFilePath, ext: info.extension } },
  };
}

async function processImage(
  info: MediaInfoImage,
  localFilePath: string,
  isVideoStill = false,
): Promise<[VisualPreviews, FilesToUpload]> {
  const previewSizes = getImagePreviewSizes(info);

  // Now we should create all the previews

  const [maxPreviewSize] = previewSizes;
  let useOriginal = false;

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
        useOriginal = await canUseJpegOriginal(localFilePath);
      } else {
        useOriginal = true;
      }
    }
  }

  const previews: VisualPreviews = {};
  const filesToUpload: FilesToUpload = {};

  if (!isVideoStill) {
    filesToUpload[''] = { path: localFilePath, ext: info.extension };
  }

  await Promise.all(
    previewSizes.map(async ({ variant, width, height }) => {
      if (variant === maxPreviewSize.variant && useOriginal) {
        previews[variant] = { w: width, h: height, ext: info.extension };
        filesToUpload[variant] = {
          path: localFilePath,
          ext: info.extension,
        };
        return;
      }

      await spawnAsync('convert', [
        `${localFilePath}[0]`, // Adding [0] for the case of animated or multi-page images
        '-auto-orient',
        ['-resize', `${width}!x${height}!`],
        ['-profile', `${__dirname}/../../../lib/assets/sRGB.icm`],
        '-strip',
        ['-quality', '75'],
        `webp:${tmpFileVariant(localFilePath, variant, 'webp')}`,
      ]);

      previews[variant] = { w: width, h: height, ext: 'webp' };
      filesToUpload[variant] = {
        path: tmpFileVariant(localFilePath, variant, 'webp'),
        ext: 'webp',
      };
    }),
  );

  if (useOriginal && !isVideoStill) {
    previews[''] = previews[maxPreviewSize.variant];
    filesToUpload[''] = filesToUpload[maxPreviewSize.variant];
    delete previews[maxPreviewSize.variant];
    delete filesToUpload[maxPreviewSize.variant];
  }

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
    ['-err_detect', 'explode', '-xerror'], // Fail on error
    ['-loglevel', 'error'],
    ['-i', localFilePath],
    '-y', // Overwrite existing file
    ['-map', '0:a:0'], // Use only the first audio stream
    ['-c:a', 'aac'], // Convert to AAC
    ['-b:a', '192k'], // Set bitrate to 192k
    '-sn', // Skip subtitles (if any)
    '-dn', // Skip other data (if any)
    ['-map_metadata', '-1'], // Remove all metadata
    ['-f', 'mp4'], // Output in m4a/mov container
    outFile,
  ]);

  previews[variant] = { ext };
  filesToUpload[variant] = { path: outFile, ext };

  return [previews, filesToUpload];
}

async function processVideo(
  info: MediaInfoVideo,
  localFilePath: string,
): Promise<[{ video: VisualPreviews; image: VisualPreviews }, FilesToUpload]> {
  const previewSizes = getVideoPreviewSizes(info);

  const keepOriginalFile = info.isAnimatedImage === true;

  const [maxPreviewSize] = previewSizes;
  const maxVariant = maxPreviewSize.variant;

  const stillFrameOffset = info.isAnimatedImage ? 0 : info.duration / 2;
  const canUseOriginalVideo = canUseOriginalVideoStream(info, maxPreviewSize);

  const videoPreviews: VisualPreviews = {};
  const videoFiles: FilesToUpload = {};

  // Ffmpeg CLI arguments
  const commands: SpawnAsyncArgs = [];

  const audioCommands = [];

  if (!info.aCodec) {
    // No audio stream
    audioCommands.push('-an');
  } else if (info.aCodec === 'aac') {
    // We can use audio as is
    audioCommands.push(['-map', '0:a:0'], ['-c:a', 'copy']);
  } else {
    // We need to convert audio to AAC
    audioCommands.push(['-map', '0:a:0'], ['-c:a', 'aac'], ['-b:a', '160k']);
  }

  // Components of 'filter_complex' graph
  const filters: string[] = [];

  // First, we need to resize the original video to maximum preview size
  if (maxPreviewSize.width === info.width && maxPreviewSize.height === info.height) {
    // We can use original video sizes
    filters.push(`[0:v:0]copy[max]`);
  } else if (maxPreviewSize.width + 1 === info.width || maxPreviewSize.height + 1 === info.height) {
    // Special case: the original has odd dimensions, so we just need to crop it to maxPreviewSize
    filters.push(`[0:v:0]crop=${maxPreviewSize.width}:${maxPreviewSize.height}:0:0[max]`);
  } else {
    filters.push(
      `[0:v:0]zscale=w=${maxPreviewSize.width}:h=${maxPreviewSize.height}:filter=lanczos[max]`,
    );
  }

  // Next, we need to split video stream for the further processing. We should
  // have one 'still' stream for the still frame and some streams for each of
  // the preview sizes. If we can use original video, then we don't need the
  // split output for the maximum preview size.
  const splitVariants = [
    'still',
    ...previewSizes.map((p) => p.variant).filter((v) => !canUseOriginalVideo || v !== maxVariant),
  ];
  filters.push(
    `[max]split=${splitVariants.length}${splitVariants.map((v) => `[${v}in]`).join('')}`,
  );

  // Command for the still frame
  const stillFile = tmpFileVariant(localFilePath, 'still', 'webp');
  commands.push(
    ['-map', `[stillin]`],
    ['-ss', stillFrameOffset.toString()],
    ['-frames:v', '1'],
    stillFile,
  );

  for (const { variant, width, height } of previewSizes) {
    if (variant === maxVariant) {
      if (!canUseOriginalVideo) {
        filters.push(`[${variant}in]copy[${variant}out]`);
      }
    } else {
      filters.push(`[${variant}in]zscale=w=${width}:h=${height}:filter=lanczos[${variant}out]`);
    }

    const commonCommands = [
      ...audioCommands,
      ['-map_metadata', '-1'],
      ['-map_chapters', '-1'],
      ['-movflags', '+faststart'],
    ];

    const targetFile = tmpFileVariant(localFilePath, variant, 'mp4');

    if (variant === maxVariant && canUseOriginalVideo) {
      commands.push(
        ['-map', '0:v:0'],
        ['-c:v', 'copy'], // Just copy the original video stream
        ...commonCommands,
        targetFile,
      );
    } else {
      commands.push(
        ['-map', `[${variant}out]`],
        ['-c:v', 'libx264'],
        ['-preset', 'slow'],
        ['-profile:v', 'high'],
        ['-crf', '23'],
        ['-g', '60'], // For better seeking performance
        ['-pix_fmt', 'yuv420p'],
        ...commonCommands,
        targetFile,
      );
    }

    videoFiles[variant] = {
      path: targetFile,
      ext: 'mp4',
    };
    videoPreviews[variant] = {
      w: width,
      h: height,
      ext: 'mp4',
    };
  }

  await spawnAsync('ffmpeg', [
    '-hide_banner',
    ['-err_detect', 'explode', '-xerror'], // Fail on error
    ['-loglevel', 'error'],
    ['-i', localFilePath],
    ['-filter_complex', filters.join(';')],
    ...commands,
  ]);

  const [imagePreviews, imageFiles] = await processImage(
    {
      type: 'image',
      format: 'webp',
      extension: 'webp',
      width: maxPreviewSize.width,
      height: maxPreviewSize.height,
    },
    stillFile,
    true,
  );

  if (!keepOriginalFile) {
    await unlink(localFilePath);

    videoPreviews[''] = videoPreviews[maxVariant];
    videoFiles[''] = videoFiles[maxVariant];
    delete videoPreviews[maxVariant];
    delete videoFiles[maxVariant];
  } else {
    videoFiles[''] = { path: localFilePath, ext: info.extension };
  }

  return [
    { video: videoPreviews, image: imagePreviews },
    { ...videoFiles, ...imageFiles },
  ];
}

function tmpFileVariant(filePath: string, variant: string, ext: string): string {
  return `${filePath}.variant.${variant ? `${variant}.` : ''}${ext}`;
}

/**
 * Can we use the original JPEG file for preview? If so, then process it and
 * return true, otherwise return false.
 *
 * The image can be:
 *  1. Rotated
 *  2. Have an exotic colorspace
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
    'IFD1:Orientation': previewOrientation = null,
    'MPF0:NumberOfImages': numberOfImages = 1,
  } = tags;

  return (
    // Only grayscale or rgb images
    (colorComponents === 1 || colorComponents === 3) &&
    // sRGB profile
    (typeof profileDescription !== 'string' || profileDescription.startsWith('sRGB ')) &&
    // Have only one image
    (typeof numberOfImages !== 'number' || numberOfImages === 1) &&
    // Have no rotation
    (typeof orientation !== 'number' || orientation === 1) &&
    // Have no preview rotation
    (typeof previewOrientation !== 'number' || previewOrientation === 1)
  );
}

// Can we use the original video stream for the largest preview as is?
function canUseOriginalVideoStream(info: MediaInfoVideo, maxPreviewSize: Box): boolean {
  const safeH264Profiles = ['Baseline', 'Main', 'High', 'Constrained Baseline'];
  return (
    info.h264info?.pix_fmt === 'yuv420p' &&
    safeH264Profiles.includes(info.h264info?.profile) &&
    info.width === maxPreviewSize.width &&
    info.height === maxPreviewSize.height
  );
}

async function fileProps(filePath: string, origFileName: string, ext: string): Promise<FileProps> {
  return {
    fileName: origFileName, // File name is always equal to the original file name
    fileExtension: ext, // This is the extension of the '' variant, i.e. the file in the /attachments/ root
    fileSize: await stat(filePath).then((s) => s.size),
    mimeType: mimeLookup(ext) || 'application/octet-stream',
  };
}

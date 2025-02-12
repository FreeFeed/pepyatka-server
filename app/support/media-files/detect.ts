import { open } from 'fs/promises';

import { spawnAsync } from '../spawn-async';

import {
  AvcStream,
  FfprobeResult,
  H264Info,
  MediaInfo,
  MediaInfoVideo,
  VideoStream,
} from './types';
import { addFileExtension } from './file-ext';

export async function detectMediaType(
  localFilePath: string,
  origFileName: string,
): Promise<MediaInfo> {
  // Check by file signature
  const probablyImage = await hasImageSignature(localFilePath);

  if (probablyImage) {
    // Identify using ImageMagick
    try {
      const out = await spawnAsync('identify', [
        ['-format', '%m %W %H %[orientation] %n|'],
        `${localFilePath}[0,1]`, // Select only up to 2 first frames to reduce the memory usage
      ]);

      // Select only the first values sequence (there could be more for animated images)
      const pipePos = out.stdout.indexOf('|');
      const parts = out.stdout.slice(0, pipePos).split(' ');

      const format = parts[0].toLowerCase();

      let width = parseInt(parts[1], 10);
      let height = parseInt(parts[2], 10);

      // Fix orientation
      if (['LeftTop', 'RightTop', 'RightBottom', 'LeftBottom'].includes(parts[3])) {
        [width, height] = [height, width];
      }

      const nFrames = parseInt(parts[4], 10);

      // Animated image? Only GIF is supported for now
      if (format === 'gif' && nFrames > 1) {
        const data = await detectAnimatedImage(localFilePath);

        if (data) {
          return addFileExtension(data, origFileName);
        }
      }

      return addFileExtension(
        {
          type: 'image',
          format,
          width,
          height,
        },
        origFileName,
      );
    } catch {
      return addFileExtension({ type: 'general' }, origFileName);
    }
  }

  // Identify other types using ffprobe
  try {
    const { format, streams } = await runFfprobe(localFilePath);
    const fmt = format.format_name.split(',')[0].toLowerCase();

    const videoStream = streams.find(
      (s) =>
        s.codec_type === 'video' &&
        // And not an album cover or other static image
        s.disposition.attached_pic !== 1 &&
        s.disposition.still_image !== 1,
    ) as VideoStream | undefined;
    const audioStream = streams.find((s) => s.codec_type === 'audio');

    if (videoStream && format.duration) {
      let width = videoStream.width!;
      let height = videoStream.height!;

      // If video has rotation, swap width and height
      if (videoStream.side_data_list) {
        const rotation = videoStream.side_data_list.find((s) => 'rotation' in s)?.rotation ?? 0;

        if (rotation === 90 || rotation === 270 || rotation === -90 || rotation === -270) {
          [width, height] = [height, width];
        }
      }

      // Extract additional info if video codec is h264
      let h264info: H264Info | undefined = undefined;

      if (videoStream.codec_name === 'h264' && videoStream.is_avc === 'true') {
        const s = videoStream as AvcStream;
        h264info = {
          profile: s.profile,
          level: s.level,
          pix_fmt: s.pix_fmt,
        };
      }

      return addFileExtension(
        {
          type: 'video',
          format: fmt,
          vCodec: videoStream.codec_name,
          aCodec: audioStream?.codec_name,
          duration: parseFloat(format.duration),
          bitrate: parseInt(format.bit_rate),
          width,
          height,
          h264info,
          tags: format.tags,
        },
        origFileName,
      );
    } else if (audioStream && format.duration) {
      return addFileExtension(
        {
          type: 'audio',
          format: fmt,
          aCodec: audioStream.codec_name,
          duration: parseFloat(format.duration),
          tags: format.tags,
        },
        origFileName,
      );
    }

    return addFileExtension({ type: 'general' }, origFileName);
  } catch {
    return addFileExtension({ type: 'general' }, origFileName);
  }
}

async function detectAnimatedImage(
  file: string,
): Promise<Omit<MediaInfoVideo, 'extension'> | null> {
  const { format, streams } = await runFfprobe(file);
  const fmt = format.format_name.split(',')[0].toLowerCase();

  const videoStream = streams.find((s) => s.codec_type === 'video');

  if (
    videoStream &&
    format.duration &&
    videoStream.nb_frames &&
    parseInt(videoStream.nb_frames) > 1
  ) {
    return {
      type: 'video',
      format: fmt,
      vCodec: videoStream.codec_name,
      width: videoStream.width!,
      height: videoStream.height!,
      duration: parseFloat(format.duration),
      bitrate: parseInt(format.bit_rate),
      isAnimatedImage: true,
    };
  }

  return null;
}

async function runFfprobe(file: string): Promise<FfprobeResult> {
  const out = await spawnAsync('ffprobe', [
    '-hide_banner',
    ['-loglevel', 'error'],
    '-show_format',
    '-show_streams',
    ['-print_format', 'json'],
    ['-i', file],
  ]);

  if (out.stderr !== '') {
    // ffprobe can return zero exit code even if it fails to process the file.
    // In that case, stderr will contain an error message.
    throw new Error(out.stderr.trim());
  }

  return JSON.parse(out.stdout) as FfprobeResult;
}

async function hasImageSignature(file: string): Promise<boolean> {
  const fh = await open(file, 'r');

  try {
    const buffer = new Uint8Array(16);
    await fh.read({ buffer });
    return checkImageSignature(buffer);
  } finally {
    await fh.close();
  }
}

function isStartsWith(buf: Uint8Array, codes: number[] | string, offset = 0): boolean {
  let prefix: Uint8Array;

  if (typeof codes === 'string') {
    prefix = new TextEncoder().encode(codes);
  } else {
    prefix = new Uint8Array(codes);
  }

  for (let i = 0; i < prefix.length; i++) {
    if (buf[i + offset] !== prefix[i]) {
      return false;
    }
  }

  return true;
}

/**
 * We support only those image types: JPEG/JFIF, PNG, WEBP, AVIF, GIF, HEIC and HEIF
 *
 * @see https://en.wikipedia.org/wiki/List_of_file_signatures
 * @see https://legacy.imagemagick.org/api/MagickCore/magic_8c_source.html
 */
function checkImageSignature(x: Uint8Array): boolean {
  return (
    // JPEG variants
    isStartsWith(x, [0xff, 0xd8, 0xff]) ||
    // PNG
    isStartsWith(x, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    // WEBP
    (isStartsWith(x, 'RIFF') && isStartsWith(x, 'WEBP', 8)) ||
    // GIF
    isStartsWith(x, 'GIF87a') ||
    isStartsWith(x, 'GIF89a') ||
    // HEIC/HEIF
    isStartsWith(x, 'ftypheic', 4) ||
    isStartsWith(x, 'ftypheix', 4) ||
    isStartsWith(x, 'ftypmif1', 4) ||
    // AVIF
    isStartsWith(x, 'ftypavif', 4) ||
    // The end
    false
  );
}

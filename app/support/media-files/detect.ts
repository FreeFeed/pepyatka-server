import util from 'util';
import { open } from 'fs/promises';

import gmLib from 'gm';

import { spawnAsync } from '../spawn-async';

import { FfprobeResult, MediaInfo, MediaInfoVideo } from './types';
import { addFileExtension } from './file-ext';

const gm = gmLib.subClass({ imageMagick: true });

export async function detectMediaType(
  localFilePath: string,
  origFileName: string,
): Promise<MediaInfo> {
  // Check by file signature
  const probablyImage = await hasImageSignature(localFilePath);

  if (probablyImage) {
    // Identify using ImageMagick
    const image = gm(localFilePath);
    const identifyAsync = util.promisify<string, string>(image.identify);

    try {
      const info = await identifyAsync.call(image, '%m %w %h');
      const parts = info.split(' ');
      const fmt = parts[0].toLowerCase();

      // Animated images? Only GIF is supported for now
      if (fmt === 'gif') {
        const data = await detectAnimatedImage(localFilePath);

        if (data) {
          return addFileExtension(data, origFileName);
        }
      }

      return addFileExtension(
        {
          type: 'image',
          format: fmt,
          width: parseInt(parts[1], 10),
          height: parseInt(parts[2], 10),
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

    const videoStream = streams.find((s) => s.codec_type === 'video');
    const audioStream = streams.find((s) => s.codec_type === 'audio');

    if (videoStream && format.duration) {
      return addFileExtension(
        {
          type: 'video',
          format: fmt,
          vCodec: videoStream.codec_name,
          aCodec: audioStream?.codec_name,
          duration: parseFloat(format.duration),
          width: videoStream.width!,
          height: videoStream.height!,
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
      isAnimatedImage: true,
    };
  }

  return null;
}

async function runFfprobe(file: string): Promise<FfprobeResult> {
  const out = await spawnAsync('ffprobe', [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-show_format',
    '-show_streams',
    '-print_format',
    'json',
    '-i',
    file,
  ]);
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

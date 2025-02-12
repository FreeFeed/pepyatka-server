import { promises as fs, createWriteStream } from 'fs';
import crypto from 'crypto';
import path from 'path';
import { URL } from 'url';
import { pipeline, finished } from 'stream/promises';

import meter from 'stream-meter';
import mediaType from 'media-type';
import config from 'config';

const sizeLimits = config.attachments.fileSizeLimitByType;

export async function downloadURL(
  url: string,
  sizeLimit = sizeLimits['image'] ?? sizeLimits['default'],
) {
  const parsedURL = new URL(url);

  if (parsedURL.protocol !== 'http:' && parsedURL.protocol !== 'https:') {
    throw new Error('Unsupported URL protocol');
  }

  const parsedPath = path.parse(parsedURL.pathname);
  const originalFileName = parsedPath.base !== '' ? decodeURIComponent(parsedPath.base) : 'file';

  const bytes = crypto.randomBytes(4).readUInt32LE(0);
  const filePath = `/tmp/pepyatka${bytes}tmp${parsedPath.ext}`;

  const response = await fetch(parsedURL.href);

  if (response.status !== 200) {
    throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error('No response body');
  }

  const mType = mediaType.fromString(response.headers.get('content-type') || '');

  // if (mType.type !== 'image') {
  //   throw new Error(`Unsupported content type: '${mType.asString() || '-'}'`);
  // }

  if (response.headers.has('content-length')) {
    const contentLength = parseInt(response.headers.get('content-length')!);

    if (!isNaN(contentLength) && contentLength > sizeLimit) {
      throw new Error(`File is too large (${contentLength} bytes, max. ${sizeLimit})`);
    }
  }

  try {
    // We use 'as' here because of weird Node's typing
    // see https://stackoverflow.com/a/66629140
    // @ts-expect-error
    const inStream = response.body as NodeJS.ReadableStream;
    const outStream = createWriteStream(filePath, { flags: 'w' });
    await pipeline(inStream, meter(sizeLimit), outStream);
    await finished(outStream); // wait for the file to be written and closed

    const stats = await fs.stat(filePath);

    return {
      name: originalFileName,
      size: stats.size,
      type: mType.asString() || 'application/octet-stream',
      path: filePath,
      unlink() {
        return fs.unlink(this.path);
      },
    };
  } catch (e) {
    await fs.unlink(filePath);
    throw e;
  }
}

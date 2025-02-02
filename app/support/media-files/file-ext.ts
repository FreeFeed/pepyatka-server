import { extname, format as formatPath, parse as parsePath } from 'path';

import { MediaType } from './types';

// For some formats there are predefined extensions
const wellKnownFormats = new Map<string, string>();

// Some formats are extensions themselves
const formatTypes = {
  image: ['png', 'gif', 'webp', 'avif', 'heic'],
  audio: ['mp3', 'ogg', 'wav', 'm4a'],
  video: ['mp4'],
};

for (const [type, formats] of Object.entries(formatTypes)) {
  for (const format of formats) {
    wellKnownFormats.set(`${type}:${format}`, format);
  }
}

// Some formats have different extensions
wellKnownFormats.set('image:jpeg', 'jpg');
wellKnownFormats.set('audio:mov', 'm4a');
wellKnownFormats.set('audio:asf', 'wma');
wellKnownFormats.set('video:mov', 'mp4');
wellKnownFormats.set('video:ogg', 'ogv');
wellKnownFormats.set('video:asf', 'wmv');

type TypeInfo = {
  type: MediaType;
  format?: string;
};

export function addFileExtension<T extends TypeInfo>(
  info: T,
  fileName: string,
): T & { extension: string } {
  let extension = wellKnownFormats.get(`${info.type}:${info.format ?? ''}`);

  if (extension) {
    return { ...info, extension };
  }

  // For other files we need to guess it from the file name
  const ext = extname(fileName);

  if (!ext) {
    extension = '';
  } else {
    extension = ext
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '') // Only the restricted set of chars is allowed
      .slice(0, 6); // Limit the length of the extension
  }

  return { ...info, extension };
}

export function setExtension(fileName: string, ext: string): string {
  const { name } = parsePath(fileName);
  return formatPath({ name, ext });
}

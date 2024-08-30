import Raven from 'raven';
import config from 'config';
import { exiftool } from 'exiftool-vendored';

const sentryIsEnabled = 'sentryDsn' in config;

export const SANITIZE_NONE = 0;
export const SANITIZE_VERSION = 1;

/**
 * @param filePath path to the media file
 * @returns _true_, if the file been updated, _false_ otherwise
 */
export async function sanitizeMediaMetadata(filePath: string): Promise<boolean> {
  const { removeTags, ignoreTags } = config.attachments.sanitizeMetadata;

  const tags = await exiftool.read(filePath);
  const tagsToClean = {} as Record<string, null>;

  for (const tag of Object.keys(tags)) {
    const toRemove = removeTags.some((re) => re.test(tag));
    const toIgnore = toRemove && ignoreTags.some((re) => re.test(tag));

    if (toRemove && !toIgnore) {
      tagsToClean[tag] = null;
    }
  }

  if (Object.keys(tagsToClean).length > 0) {
    try {
      await exiftool.write(filePath, tagsToClean, {
        writeArgs: ['-overwrite_original', '-ignoreMinorErrors'],
      });
      return true;
    } catch (e) {
      // It's ok to fail, we cannot do anything useful in this case

      // Some exiftool 'errors' are really a warnings
      if (e instanceof Error && !e.message.startsWith('Warning:') && sentryIsEnabled) {
        Raven.captureException(e);
      }
    }
  }

  return false;
}

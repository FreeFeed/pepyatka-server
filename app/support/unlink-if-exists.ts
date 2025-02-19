import { unlink } from 'fs/promises';

import { isNoEntryError } from './is-no-entry';

export async function unlinkIfExists(path: string) {
  try {
    await unlink(path);
  } catch (err) {
    if (!isNoEntryError(err)) {
      throw err;
    }
  }
}

import { stat } from 'fs/promises';

import { Attachment } from '../../../app/models';

export async function filesMustExist(attachment: Attachment, mustExist = true) {
  const filePaths = attachment
    .allFileVariants()
    .map(({ variant, ext }) => attachment.getLocalFilePath(variant, ext));

  await Promise.all(
    filePaths.map(async (filePath) => {
      try {
        await stat(filePath);

        if (!mustExist) {
          throw new Error(`File should not exist: ${filePath}`);
        }
      } catch (err) {
        if (!err || typeof err !== 'object') {
          throw err;
        }

        if (mustExist && (err as { code: string }).code === 'ENOENT') {
          throw new Error(`File should exist: ${filePath}`);
        } else if ((err as { code: string }).code !== 'ENOENT' || mustExist) {
          throw err;
        }
      }
    }),
  );
}

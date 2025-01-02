import path from 'path';
import os from 'os';
import { writeFile } from 'fs/promises';

import { UUID } from '../../../app/support/types';
import { Attachment, dbAdapter } from '../../../app/models';

type FileInfo = {
  name: string;
  content: string | Uint8Array;
};

export async function createAttachment(userId: UUID, { name, content }: FileInfo) {
  const localPath = path.join(
    os.tmpdir(),
    `attachment${(Math.random() * 0x100000000 + 1).toString(36)}`,
  );
  await writeFile(localPath, content);
  const user = await dbAdapter.getUserById(userId);
  const attachment = await Attachment.create(localPath, name, user!, null);
  return attachment;
}

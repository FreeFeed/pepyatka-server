import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';

import { UUID } from '../../../app/support/types';
import { Attachment } from '../../../app/models';

type FileInfo = {
  name: string;
  type: string;
  content: string | Uint8Array;
};

export async function createAttachment(
  userId: UUID,
  { name, type = 'application/octet-stream', content }: FileInfo,
  additionalParams = {},
) {
  const localPath = path.join(
    os.tmpdir(),
    `attachment${(Math.random() * 0x100000000 + 1).toString(36)}`,
  );
  await fs.writeFile(localPath, content);
  const attachment = new Attachment({
    ...additionalParams,
    file: { name, type, size: content.length, path: localPath },
    userId,
  });
  await attachment.create();
  return attachment;
}

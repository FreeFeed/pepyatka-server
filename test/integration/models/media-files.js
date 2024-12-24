import { readFile } from 'fs/promises';
import { join } from 'path';

import { describe, it } from 'mocha';
import expect from 'unexpected';

import { detectMediaType } from '../../../app/support/media-files/detect';

describe('Media files', () => {
  const samplesDir = join(__dirname, '../../fixtures/media-files');

  it('should be ok', async () => {
    const filesData = JSON.parse(await readFile(join(samplesDir, 'file-info.json'), 'utf8'));

    for (const file of filesData) {
      const { file: fileName, info } = file;
      console.log(`Running test for ${fileName}`);

      // eslint-disable-next-line no-await-in-loop
      const detected = await detectMediaType(join(samplesDir, fileName), fileName);
      expect(info, 'to equal', detected);
    }
  });
});

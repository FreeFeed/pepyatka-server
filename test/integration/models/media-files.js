import { join } from 'path';
import { readFileSync } from 'fs';

import { describe, it } from 'mocha';
import expect from 'unexpected';

import { detectMediaType } from '../../../app/support/media-files/detect';

const samplesDir = join(__dirname, '../../fixtures/media-files');
const filesData = JSON.parse(readFileSync(join(samplesDir, 'file-info.json'), 'utf8'));

describe('Media files', () => {
  for (const file of filesData) {
    const { file: fileName, info } = file;
    it(`should detect media info for ${fileName}`, async () => {
      const detected = await detectMediaType(join(samplesDir, fileName), fileName);
      expect(info, 'to equal', detected);
    });
  }
});

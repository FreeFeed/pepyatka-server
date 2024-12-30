/* eslint-env node, mocha */
import expect from 'unexpected';

import { getImagePreviewSizes } from '../../../../app/support/media-files/geometry';

describe('media-files:geometry', () => {
  it('should generate preview sizes for large image', () => {
    const result = getImagePreviewSizes({ width: 6000, height: 4000 });
    expect(result, 'to equal', [
      { variant: 'p3', width: 2449, height: 1633 },
      { variant: 'p2', width: 1225, height: 816 },
      { variant: 'p1', width: 612, height: 408 },
      { variant: 'thumbnails2', width: 525, height: 350 },
      { variant: 'thumbnails', width: 263, height: 175 },
    ]);
  });

  it('should generate preview sizes for image that is slightly bigger than maximum of preset sizes', () => {
    const result = getImagePreviewSizes({ width: 2700, height: 1800 });
    expect(result, 'to equal', [
      { variant: 'p3', width: 2700, height: 1800 },
      { variant: 'p2', width: 1225, height: 816 },
      { variant: 'p1', width: 612, height: 408 },
      { variant: 'thumbnails2', width: 525, height: 350 },
      { variant: 'thumbnails', width: 263, height: 175 },
    ]);
  });

  it('should generate preview sizes for medium size image', () => {
    const result = getImagePreviewSizes({ width: 1500, height: 1000 });
    expect(result, 'to equal', [
      { variant: 'p2', width: 1500, height: 1000 },
      { variant: 'p1', width: 612, height: 408 },
      { variant: 'thumbnails2', width: 525, height: 350 },
      { variant: 'thumbnails', width: 263, height: 175 },
    ]);
  });

  it('should generate preview sizes for small image', () => {
    const result = getImagePreviewSizes({ width: 500, height: 300 });
    expect(result, 'to equal', [
      { variant: 'p1', width: 500, height: 300 },
      { variant: 'thumbnails', width: 292, height: 175 },
    ]);
  });

  it('should generate preview sizes for very small image', () => {
    const result = getImagePreviewSizes({ width: 50, height: 30 });
    expect(result, 'to equal', [{ variant: 'p1', width: 50, height: 30 }]);
  });
});

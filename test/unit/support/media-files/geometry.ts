/* eslint-env node, mocha */
import expect from 'unexpected';

import {
  getBestVariant,
  getImagePreviewSizes,
  getVideoPreviewSizes,
} from '../../../../app/support/media-files/geometry';

describe('Geometry of images', () => {
  it('should generate preview sizes for large image', () => {
    const result = getImagePreviewSizes({ width: 6000, height: 4000 });
    expect(result, 'to equal', [
      { variant: 'p4', width: 2449, height: 1633 },
      { variant: 'p3', width: 1342, height: 894 },
      { variant: 'p2', width: 775, height: 516 },
      { variant: 'thumbnails2', width: 525, height: 350 },
      { variant: 'p1', width: 424, height: 283 },
      { variant: 'thumbnails', width: 263, height: 175 },
    ]);
  });

  it('should generate preview sizes for image that is slightly bigger than maximum of preset sizes', () => {
    const result = getImagePreviewSizes({ width: 2700, height: 1800 });
    expect(result, 'to equal', [
      { variant: 'p4', width: 2700, height: 1800 },
      { variant: 'p3', width: 1342, height: 894 },
      { variant: 'p2', width: 775, height: 516 },
      { variant: 'thumbnails2', width: 525, height: 350 },
      { variant: 'p1', width: 424, height: 283 },
      { variant: 'thumbnails', width: 263, height: 175 },
    ]);
  });

  it('should generate preview sizes for medium size image', () => {
    const result = getImagePreviewSizes({ width: 1500, height: 1000 });
    expect(result, 'to equal', [
      { variant: 'p3', width: 1500, height: 1000 },
      { variant: 'p2', width: 775, height: 516 },
      { variant: 'thumbnails2', width: 525, height: 350 },
      { variant: 'p1', width: 424, height: 283 },
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

describe('Geometry of videos', () => {
  it('should generate preview sizes for 4k video', () => {
    const result = getVideoPreviewSizes({ width: 4096, height: 2160 });
    expect(result, 'to equal', [
      { variant: 'v3', width: 2048, height: 1080 },
      { variant: 'v2', width: 1366, height: 720 },
      { variant: 'v1', width: 910, height: 480 },
    ]);
  });

  it('should generate preview sizes for HD 1080 video', () => {
    const result = getVideoPreviewSizes({ width: 1920, height: 1080 });
    expect(result, 'to equal', [
      { variant: 'v3', width: 1920, height: 1080 },
      { variant: 'v2', width: 1280, height: 720 },
      { variant: 'v1', width: 854, height: 480 },
    ]);
  });

  it('should generate preview sizes for HD 720 video', () => {
    const result = getVideoPreviewSizes({ width: 1280, height: 720 });
    expect(result, 'to equal', [
      { variant: 'v2', width: 1280, height: 720 },
      { variant: 'v1', width: 854, height: 480 },
    ]);
  });

  it('should generate preview sizes for small video', () => {
    const result = getVideoPreviewSizes({ width: 100, height: 100 });
    expect(result, 'to equal', [{ variant: 'v1', width: 100, height: 100 }]);
  });

  it('should generate preview sizes for small video with odd height', () => {
    const result = getVideoPreviewSizes({ width: 51, height: 103 });
    expect(result, 'to equal', [{ variant: 'v1', width: 50, height: 102 }]);
  });

  it('should generate preview sizes for video that is slightly bigger than maximum of preset sizes', () => {
    const result = getVideoPreviewSizes({ width: 1600, height: 1200 });
    expect(result, 'to equal', [
      { variant: 'v3', width: 1600, height: 1200 },
      { variant: 'v2', width: 960, height: 720 },
      { variant: 'v1', width: 640, height: 480 },
    ]);
  });
});

describe('getBestVariant', () => {
  const variants = {
    x1: { w: 100, h: 200 },
    x2: { w: 200, h: 400 },
    x3: { w: 300, h: 600 },
  };

  const testData = [
    {
      width: 100,
      height: 200,
      result: { variant: 'x1', width: 100, height: 200 },
    },
    {
      width: 120,
      height: 200,
      result: { variant: 'x2', width: 120, height: 200 },
    },
    {
      width: 100,
      height: 400,
      result: { variant: 'x2', width: 100, height: 400 },
    },
    {
      width: 1000,
      height: 1000,
      result: { variant: 'x3', width: 300, height: 300 }, // Don't upscale
    },
    {
      width: 400,
      height: 400,
      result: { variant: 'x3', width: 300, height: 300 }, // Don't upscale
    },
  ] as const;

  for (const { width, height, result } of testData) {
    it(`should return ${JSON.stringify(result.variant)} for ${width}x${height}`, () => {
      expect(getBestVariant(variants, width, height), 'to equal', result);
    });
  }
});

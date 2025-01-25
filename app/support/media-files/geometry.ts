import config from 'config';

import { Box } from './types';

export function getImagePreviewSizes(
  info: Box,
  { imagePreviewAreas, legacyImagePreviewSizes } = config.attachments.previews,
): ({ variant: string } & Box)[] {
  const previews: { [variant: string]: Box } = {};

  // Modern preview sizes, area-based
  const presets = [...Object.entries(imagePreviewAreas)];
  presets.sort((a, b) => b[1] - a[1]); // Sort by descending area

  const imageArea = info.width * info.height;

  for (const [variant, area] of presets) {
    if (imageArea >= area) {
      previews[variant] = fitIntoArea(info, area);
    }
  }

  // If the image area is larger than any of preset sizes
  if (imageArea > presets[0][1]) {
    const [[variant, size]] = presets;

    // If image is slightly bigger than the largest preset, use the image size
    if (imageArea < size * 1.5) {
      previews[variant] = fitIntoArea(info, imageArea);
    }
  } else {
    // Find the preset with the closest size, and use image size for it
    let dist = Infinity;
    let matched = null;

    for (const [variant, area] of presets) {
      const d = Math.abs(Math.log(imageArea / area));

      if (d < dist) {
        dist = d;
        matched = variant;
      }
    }

    if (matched) {
      previews[matched] = fitIntoArea(info, imageArea);
    }
  }

  // Legacy preview sizes
  for (const [variant, sizes] of Object.entries(legacyImagePreviewSizes)) {
    if (info.width >= sizes.width || info.height >= sizes.height) {
      previews[variant] = fitIntoBox(info, sizes);
    }
  }

  const result = [...Object.entries(previews)].map(([variant, size]) => ({ variant, ...size }));
  // Sort by descending size
  result.sort((a, b) => b.width - a.width);

  return result;
}

export function getVideoPreviewSizes(
  info: Box,
  { videoPreviewShortSides } = config.attachments.previews,
): ({ variant: string } & Box)[] {
  const previews: { [variant: string]: Box } = {};

  const presets = [...Object.entries(videoPreviewShortSides)];
  presets.sort((a, b) => b[1] - a[1]); // Sort by descending size

  const shortSide = Math.min(info.width, info.height);
  const longSide = Math.max(info.width, info.height);

  for (const [variant, size] of presets) {
    if (shortSide >= size) {
      // The size must be a multiple of 2
      const newLongSide = Math.round((size * longSide) / shortSide / 2) * 2;
      previews[variant] = {
        width: shortSide === info.width ? size : newLongSide,
        height: shortSide === info.height ? size : newLongSide,
      };
    }
  }

  // If the video is larger than any of preset sizes
  if (shortSide > presets[0][1]) {
    const [[variant, size]] = presets;

    // If video is slightly bigger than the largest preset, use the video size
    if (shortSide < size * 1.25) {
      previews[variant] = {
        width: downToEven(info.width),
        height: downToEven(info.height),
      };
    }
  } else {
    // Find the preset with the closest size, and use image size for it
    let dist = Infinity;
    let matched = null;

    for (const [variant, size] of presets) {
      const d = Math.abs(Math.log(shortSide / size));

      if (d < dist) {
        dist = d;
        matched = variant;
      }
    }

    if (matched) {
      previews[matched] = {
        width: downToEven(info.width),
        height: downToEven(info.height),
      };
    }
  }

  const result = [...Object.entries(previews)].map(([variant, size]) => ({ variant, ...size }));
  // Sort by descending size
  result.sort((a, b) => b.width - a.width);

  return result;
}

/**
 * Find the best variant that can fill (as CSS' 'cover') the given target size.
 * Returns the variant ID and the its updated size. The variant image never
 * upscales, if there is no suitable variant, the maximum variant is returned,
 * cropped to match the target aspect ratio.
 */
export function getBestVariant(
  variants: { [variant: string]: { w: number; h: number } },
  targetWidth?: number,
  targetHeight?: number,
): {
  variant: string;
  width: number;
  height: number;
} {
  const entries = Object.entries(variants).sort((a, b) => a[1].w - b[1].w); // Sort by ascending size

  // If no dimensions are required, use the maximum available variant
  if (!targetWidth || !targetHeight) {
    const bestEntry = entries[entries.length - 1];
    return {
      variant: bestEntry[0],
      width: bestEntry[1].w,
      height: bestEntry[1].h,
    };
  }

  const bestEntry =
    entries.find(([, { w, h }]) => w >= targetWidth && h >= targetHeight) ??
    entries[entries.length - 1]; // Or the last entry as the biggest one

  const [variant, { w, h }] = bestEntry;

  if (w >= targetWidth && h >= targetHeight) {
    return {
      variant,
      width: targetWidth,
      height: targetHeight,
    };
  }

  // No suitable variant, crop to the target aspect ratio
  const cropped = fitIntoBox({ width: targetWidth, height: targetHeight }, { width: w, height: h });

  return {
    variant,
    ...cropped,
  };
}

// Internals

function fitIntoArea({ width, height }: Box, area: number): Box {
  if (width * height > area) {
    const ratio = Math.sqrt(area / (width * height));

    return { width: Math.round(width * ratio), height: Math.round(height * ratio) };
  }

  return { width, height };
}

function fitIntoBox({ width, height }: Box, { width: boxWidth, height: boxHeight }: Box): Box {
  const wRatio = width / boxWidth;
  const hRatio = height / boxHeight;

  if (wRatio > hRatio) {
    return { width: boxWidth, height: Math.round(height / wRatio) };
  }

  return { width: Math.round(width / hRatio), height: boxHeight };
}

function downToEven(x: number): number {
  return x % 2 === 0 ? x : x - 1;
}

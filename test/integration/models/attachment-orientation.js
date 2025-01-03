/* eslint-env node, mocha */
/* global $pg_database */
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, join } from 'path';

import { exiftool } from 'exiftool-vendored';
import expect from 'unexpected';

import cleanDB from '../../dbCleaner';
import { User, Attachment } from '../../../app/models';
import { spawnAsync } from '../../../app/support/spawn-async';

const orientationNames = [
  'Undefined', // No orientation tag
  'TopLeft', // 1: No changes
  'TopRight', // 2: Mirror horizontal
  'BottomRight', // 3: Rotate 180
  'BottomLeft', // 4: Mirror vertical
  'LeftTop', // 5: Mirror horizontal and rotate 270 CW
  'RightTop', // 6: Rotate 90 CW
  'RightBottom', // 7: Mirror horizontal and rotate 90 CW
  'LeftBottom', // 8: Rotate 270 CW
];

describe('Orientation', () => {
  let tmpDir;
  let luna;
  before(async () => {
    await cleanDB($pg_database);
    tmpDir = await mkdtemp(join(tmpdir(), 'orient-test-'));
    luna = new User({ username: 'luna', password: 'pw' });
    await luna.create();
  });

  after(() => rm(tmpDir, { recursive: true }));

  for (let orientation = 0; orientation <= 8; orientation++) {
    describe(`Create attachment with ${orientationNames[orientation]} orientation`, () => {
      let attachment;

      before(async () => {
        const filename = join(tmpDir, `img-${orientation}.jpg`);

        await createTestImage(filename, orientation);
        attachment = await Attachment.create(filename, basename(filename), luna);
      });

      it(`should create proper big file`, async () => {
        const variant = attachment.maxSizedVariant('image');
        expect(variant, 'to be', orientation <= 1 ? '' : 'p1');
        const filePath = attachment.getLocalFilePath(variant);
        const o = await getOrientation(filePath);
        expect(o, 'to be', orientation <= 1 ? orientationNames[orientation] : 'Undefined');

        await expectOrientation(filePath, orientation);
      });

      it(`should create proper thumbnail file`, async () => {
        const filePath = attachment.getLocalFilePath('thumbnails');
        const o = await getOrientation(filePath);
        expect(o, 'to be', 'Undefined');

        await expectOrientation(filePath, orientation);
      });
    });
  }
});

async function getOrientation(filename) {
  const out = await spawnAsync('identify', ['-format', '%[orientation]', filename]);
  return out.stdout;
}

/**
 * Create black 200x300 image with white to-left 100x100 corner and apply
 * orientation tag when it is not zero.
 */
async function createTestImage(filename, orientation) {
  await spawnAsync('convert', [
    '-size',
    '200x300',
    'xc:#000000',
    '-fill',
    '#ffffff',
    '-draw',
    'rectangle 0,0 100,100',
    `jpeg:${filename}`,
  ]);

  if (orientation !== 0) {
    await exiftool.write(
      filename,
      { 'Orientation#': orientation },
      { writeArgs: ['-overwrite_original'] },
    );
  }
}

function patternForOrientation(orientation) {
  switch (orientation) {
    case 2:
      return 'OXOOOO';
    case 3:
      return 'OOOOOX';
    case 4:
      return 'OOOOXO';
    case 5:
      return 'XOOOOO';
    case 6:
      return 'OOXOOO';
    case 7:
      return 'OOOOOX';
    case 8:
      return 'OOOXOO';
    default:
      return 'XOOOOO';
  }
}

async function expectOrientation(filePath, orientation) {
  const { stdout: buffer } = await spawnAsync(
    'convert',
    [filePath, '-filter', 'Point', '-resize', '3x3', 'gray:-'],
    { binary: true },
  );

  const pattern = patternForOrientation(orientation);
  let newLine = '';

  for (let i = 0; i < pattern.length; i++) {
    newLine += buffer[i] === 0 ? 'O' : 'X';
  }

  expect(newLine, 'to be', pattern);
}

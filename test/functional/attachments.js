/* eslint-env node, mocha */
/* global $pg_database */
import fs from 'fs';
import path from 'path';

import unexpected from 'unexpected';
import unexpectedDate from 'unexpected-date';
import { Blob, fileFrom } from 'node-fetch';

import cleanDB from '../dbCleaner';
import { dbAdapter } from '../../app/models';
import { initJobProcessing } from '../../app/jobs';

import {
  createTestUser,
  updateUserAsync,
  performJSONRequest,
  authHeaders,
} from './functional_test_helper';

const expect = unexpected.clone().use(unexpectedDate);

describe('Attachments', () => {
  let luna;
  before(async () => {
    await cleanDB($pg_database);
    luna = await createTestUser('luna');
  });

  it(`should not create attachment anonymously`, async () => {
    const data = new FormData();
    data.append('file', new Blob(['this is a test'], { type: 'text/plain' }), 'test.txt');
    const resp = await performJSONRequest('POST', '/v1/attachments', data);
    expect(resp, 'to satisfy', { __httpCode: 401 });
  });

  it(`should return error if no file is provided`, async () => {
    const data = new FormData();
    const resp = await performJSONRequest('POST', '/v1/attachments', data, authHeaders(luna));
    expect(resp, 'to satisfy', { __httpCode: 400 });
  });

  it(`should create text attachment`, async () => {
    const data = new FormData();
    data.append('file', new Blob(['this is a test'], { type: 'text/plain' }), 'test.txt');
    const resp = await performJSONRequest('POST', '/v1/attachments', data, authHeaders(luna));
    const { id } = resp.attachments;
    const attObj = await dbAdapter.getAttachmentById(id);
    expect(resp, 'to satisfy', {
      attachments: {
        fileName: 'test.txt',
        mediaType: 'general',
        fileSize: 'this is a test'.length.toString(),
        createdAt: attObj.createdAt.getTime().toString(),
        updatedAt: attObj.updatedAt.getTime().toString(),
        url: attObj.getFileUrl('', 'txt'),
        thumbnailUrl: attObj.getFileUrl('', 'txt'),
        imageSizes: {},
        createdBy: luna.user.id,
        postId: null,
      },
      users: [{ id: luna.user.id }],
    });
  });

  it(`should create small image attachment`, async () => {
    const filePath = path.join(__dirname, '../fixtures/test-image.150x150.png');
    const data = new FormData();
    data.append('file', await fileFrom(filePath, 'image/png'));
    const resp = await performJSONRequest('POST', '/v1/attachments', data, authHeaders(luna));
    const { id } = resp.attachments;
    const attObj = await dbAdapter.getAttachmentById(id);
    expect(resp, 'to satisfy', {
      attachments: {
        fileName: 'test-image.150x150.png',
        mediaType: 'image',
        fileSize: fs.statSync(filePath).size.toString(),
        createdAt: attObj.createdAt.getTime().toString(),
        updatedAt: attObj.updatedAt.getTime().toString(),
        url: attObj.getFileUrl('', 'png'),
        thumbnailUrl: attObj.getFileUrl('', 'png'),
        imageSizes: { o: { w: 150, h: 150, url: attObj.getFileUrl('', 'png') } },
        createdBy: luna.user.id,
        postId: null,
      },
      users: [{ id: luna.user.id }],
    });
  });

  it(`should create medium image attachment`, async () => {
    const filePath = path.join(__dirname, '../fixtures/test-image.900x300.png');
    const data = new FormData();
    data.append('file', await fileFrom(filePath, 'image/png'));
    const resp = await performJSONRequest('POST', '/v1/attachments', data, authHeaders(luna));
    const { id } = resp.attachments;
    const attObj = await dbAdapter.getAttachmentById(id);
    expect(resp, 'to satisfy', {
      attachments: {
        fileName: 'test-image.900x300.png',
        mediaType: 'image',
        fileSize: fs.statSync(filePath).size.toString(),
        createdAt: attObj.createdAt.getTime().toString(),
        updatedAt: attObj.updatedAt.getTime().toString(),
        url: attObj.getFileUrl('', 'png'),
        thumbnailUrl: attObj.getFileUrl('thumbnails', 'webp'),
        imageSizes: {
          o: { w: 900, h: 300, url: attObj.getFileUrl('', 'png') },
          t: { w: 525, h: 175, url: attObj.getFileUrl('thumbnails', 'webp') },
        },
        createdBy: luna.user.id,
        postId: null,
      },
      users: [{ id: luna.user.id }],
    });
  });

  it(`should create large image attachment`, async () => {
    const filePath = path.join(__dirname, '../fixtures/test-image.3000x2000.png');
    const data = new FormData();
    data.append('file', await fileFrom(filePath, 'image/png'));
    const resp = await performJSONRequest('POST', '/v1/attachments', data, authHeaders(luna));
    const { id } = resp.attachments;
    const attObj = await dbAdapter.getAttachmentById(id);
    expect(resp, 'to satisfy', {
      attachments: {
        fileName: 'test-image.3000x2000.png',
        mediaType: 'image',
        fileSize: fs.statSync(filePath).size.toString(),
        createdAt: attObj.createdAt.getTime().toString(),
        updatedAt: attObj.updatedAt.getTime().toString(),
        url: attObj.getFileUrl('', 'png'),
        thumbnailUrl: attObj.getFileUrl('thumbnails', 'webp'),
        imageSizes: {
          o: { w: 2449, h: 1633, url: attObj.getFileUrl('p4', 'webp') },
          t: { w: 263, h: 175, url: attObj.getFileUrl('thumbnails', 'webp') },
          t2: { w: 525, h: 350, url: attObj.getFileUrl('thumbnails2', 'webp') },
        },
        createdBy: luna.user.id,
        postId: null,
      },
      users: [{ id: luna.user.id }],
    });
  });

  it(`should create mp3 audio attachment`, async () => {
    const filePath = path.join(__dirname, '../fixtures/media-files/music.mp3');
    const data = new FormData();
    data.append('file', await fileFrom(filePath, 'audio/mpeg'));
    const resp = await performJSONRequest('POST', '/v1/attachments', data, authHeaders(luna));
    const { id } = resp.attachments;
    const attObj = await dbAdapter.getAttachmentById(id);
    expect(resp, 'to satisfy', {
      attachments: {
        fileName: 'music.mp3',
        mediaType: 'audio',
        fileSize: fs.statSync(filePath).size.toString(),
        createdAt: attObj.createdAt.getTime().toString(),
        updatedAt: attObj.updatedAt.getTime().toString(),
        url: attObj.getFileUrl('', 'mp3'),
        thumbnailUrl: attObj.getFileUrl('', 'mp3'),
        imageSizes: {},
        createdBy: luna.user.id,
        postId: null,
        artist: 'Piermic',
        title: 'Improvisation with Sopranino Recorder',
      },
      users: [{ id: luna.user.id }],
    });
  });

  it(`should create attachment from animated gif`, async () => {
    const filePath = path.join(__dirname, '../fixtures/test-image-animated.gif');
    const data = new FormData();
    data.append('file', await fileFrom(filePath, 'image/gif'));
    const resp = await performJSONRequest('POST', '/v1/attachments', data, authHeaders(luna));
    const { id } = resp.attachments;
    const attObj = await dbAdapter.getAttachmentById(id);
    expect(resp, 'to satisfy', {
      attachments: {
        fileName: 'test-image-animated.gif',
        mediaType: 'image',
        fileSize: fs.statSync(filePath).size.toString(),
        createdAt: attObj.createdAt.getTime().toString(),
        updatedAt: attObj.updatedAt.getTime().toString(),
        url: attObj.getFileUrl('', 'gif'),
        thumbnailUrl: attObj.getFileUrl('thumbnails', 'webp'),
        imageSizes: {
          o: { w: 774, h: 392, url: attObj.getFileUrl('', 'gif') },
          t: { w: 346, h: 175, url: attObj.getFileUrl('thumbnails', 'webp') },
          t2: { w: 691, h: 350, url: attObj.getFileUrl('thumbnails2', 'webp') },
        },
        createdBy: luna.user.id,
        postId: null,
      },
      users: [{ id: luna.user.id }],
    });
  });

  it(`should create attachment from video file`, async () => {
    const jobManager = await initJobProcessing();
    const filePath = path.join(__dirname, '../fixtures/media-files/polyphon.mp4');
    const data = new FormData();
    data.append('file', await fileFrom(filePath, 'image/gif'));
    let resp = await performJSONRequest('POST', '/v1/attachments', data, authHeaders(luna));
    const { id } = resp.attachments;
    let attObj = await dbAdapter.getAttachmentById(id);

    // At first, we should have a stub file
    expect(resp, 'to satisfy', {
      attachments: {
        fileName: 'polyphon.in-progress',
        mediaType: 'general',
        fileSize: '29',
        createdAt: attObj.createdAt.getTime().toString(),
        updatedAt: attObj.updatedAt.getTime().toString(),
        url: attObj.getFileUrl('', 'in-progress'),
        thumbnailUrl: attObj.getFileUrl('', 'in-progress'),
        imageSizes: expect.it('to equal', {}),
        createdBy: luna.user.id,
        postId: null,
      },
      users: [{ id: luna.user.id }],
    });

    // Now execute the job
    await jobManager.fetchAndProcess();

    // The video should have been processed. In pre-v4 API the video attachments
    // have a 'general' media type.
    attObj = await dbAdapter.getAttachmentById(id);
    resp = await performJSONRequest('GET', '/v1/attachments/my', null, authHeaders(luna));
    expect(resp.attachments, 'to have an item satisfying', {
      fileName: 'polyphon.mp4',
      mediaType: 'general',
      createdAt: attObj.createdAt.getTime().toString(),
      updatedAt: attObj.updatedAt.getTime().toString(),
      url: attObj.getFileUrl('', 'mp4'),
      thumbnailUrl: attObj.getFileUrl('', 'mp4'),
      imageSizes: expect.it('to equal', {}),
      createdBy: luna.user.id,
      postId: null,
    });
  });

  it(`should create attachment from any binary form field`, async () => {
    const data = new FormData();
    data.append('name', 'john');
    data.append(
      'attachment[a42]',
      new Blob(['this is a test'], { type: 'text/plain' }),
      'test.txt',
    );
    const resp = await performJSONRequest('POST', '/v1/attachments', data, authHeaders(luna));
    expect(resp, 'to satisfy', {
      attachments: {
        fileName: 'test.txt',
        mediaType: 'general',
        fileSize: 'this is a test'.length.toString(),
      },
      users: [{ id: luna.user.id }],
    });
  });

  describe('List attachments', () => {
    let mars;
    before(async () => {
      mars = await createTestUser('mars');

      for (let i = 0; i < 10; i++) {
        const data = new FormData();
        data.append(
          'file',
          new Blob(['this is a test'], { type: 'text/plain' }),
          `test${i + 1}.txt`,
        );
        // eslint-disable-next-line no-await-in-loop
        await performJSONRequest('POST', '/v1/attachments', data, authHeaders(mars));
      }
    });

    it(`should list Mars'es attachments`, async () => {
      const resp = await performJSONRequest(
        'GET',
        '/v2/attachments/my?limit=4',
        null,
        authHeaders(mars),
      );
      expect(resp, 'to satisfy', {
        attachments: [
          { fileName: 'test10.txt' },
          { fileName: 'test9.txt' },
          { fileName: 'test8.txt' },
          { fileName: 'test7.txt' },
        ],
        users: [{ id: mars.user.id }],
        hasMore: true,
      });
    });

    it(`should list the rest of Mars'es attachments`, async () => {
      const resp = await performJSONRequest(
        'GET',
        '/v2/attachments/my?limit=4&page=3',
        null,
        authHeaders(mars),
      );
      expect(resp, 'to satisfy', {
        attachments: [{ fileName: 'test2.txt' }, { fileName: 'test1.txt' }],
        users: [{ id: mars.user.id }],
        hasMore: false,
      });
    });

    it(`should not list for the anonymous`, async () => {
      const resp = await performJSONRequest('GET', '/v2/attachments/my');
      expect(resp, 'to satisfy', { __httpCode: 401 });
    });

    it(`should return error if limit isn't valid`, async () => {
      const resp = await performJSONRequest(
        'GET',
        '/v2/attachments/my?limit=3w4',
        null,
        authHeaders(mars),
      );
      expect(resp, 'to satisfy', { __httpCode: 422 });
    });

    it(`should return error if page isn't valid`, async () => {
      const resp = await performJSONRequest(
        'GET',
        '/v2/attachments/my?page=-454',
        null,
        authHeaders(mars),
      );
      expect(resp, 'to satisfy', { __httpCode: 422 });
    });
  });

  describe('Attachments stats', () => {
    let mars;
    before(async () => {
      mars = await createTestUser('mars1');

      for (let i = 0; i < 10; i++) {
        const data = new FormData();
        data.append(
          'file',
          new Blob(['this is a test'], { type: 'text/plain' }),
          `test${i + 1}.txt`,
        );
        // eslint-disable-next-line no-await-in-loop
        await performJSONRequest('POST', '/v1/attachments', data, authHeaders(mars));
      }
    });

    it(`should not return attachments stats for anonymous`, async () => {
      const resp = await performJSONRequest('GET', '/v2/attachments/my/stats');
      expect(resp, 'to satisfy', { __httpCode: 401 });
    });

    it(`should return attachments stats for Mars`, async () => {
      const resp = await performJSONRequest(
        'GET',
        '/v2/attachments/my/stats',
        null,
        authHeaders(mars),
      );
      expect(resp, 'to equal', {
        attachments: { total: 10, sanitized: 10 },
        sanitizeTask: null,
        __httpCode: 200,
      });
    });
  });

  describe('Attachments batch sanitizing', () => {
    let jobManager;
    before(async () => {
      await cleanDB($pg_database);
      luna = await createTestUser('luna');
      await updateUserAsync(luna, { preferences: { sanitizeMediaMetadata: false } });

      for (let i = 0; i < 10; i++) {
        const data = new FormData();
        data.append(
          'file',
          new Blob(['this is a test'], { type: 'text/plain' }),
          `test${i + 1}.txt`,
        );
        // eslint-disable-next-line no-await-in-loop
        await performJSONRequest('POST', '/v1/attachments', data, authHeaders(luna));
      }

      jobManager = await initJobProcessing();
    });

    it(`should start sanitize task`, async () => {
      const now = await dbAdapter.now();
      const resp = await performJSONRequest(
        'POST',
        '/v2/attachments/my/sanitize',
        {},
        authHeaders(luna),
      );

      expect(resp, 'to satisfy', {
        sanitizeTask: { createdAt: expect.it('to be a string') },
        __httpCode: 200,
      });
      expect(new Date(resp.sanitizeTask.createdAt), 'to be close to', now);
    });

    it(`should return stats with the started task`, async () => {
      const resp = await performJSONRequest(
        'GET',
        '/v2/attachments/my/stats',
        null,
        authHeaders(luna),
      );
      expect(resp, 'to satisfy', {
        attachments: { total: 10, sanitized: 0 },
        sanitizeTask: { createdAt: expect.it('to be a string') },
        __httpCode: 200,
      });
    });

    it(`should execute task`, async () => {
      await jobManager.fetchAndProcess();

      const resp = await performJSONRequest(
        'GET',
        '/v2/attachments/my/stats',
        null,
        authHeaders(luna),
      );
      expect(resp, 'to satisfy', {
        attachments: { total: 10, sanitized: 10 },
        sanitizeTask: { createdAt: expect.it('to be a string') },
        __httpCode: 200,
      });
    });

    it(`should finish task`, async () => {
      await jobManager.fetchAndProcess();

      const resp = await performJSONRequest(
        'GET',
        '/v2/attachments/my/stats',
        null,
        authHeaders(luna),
      );
      expect(resp, 'to satisfy', {
        attachments: { total: 10, sanitized: 10 },
        sanitizeTask: null,
        __httpCode: 200,
      });
    });
  });
});

/* eslint-env node, mocha */
/* global $pg_database, $database */
import fs from 'fs';
import path from 'path';

import unexpected from 'unexpected';
import unexpectedDate from 'unexpected-date';
import { Blob, fileFrom } from 'node-fetch';
import { beforeEach } from 'mocha';

import cleanDB from '../dbCleaner';
import { dbAdapter, PubSub } from '../../app/models';
import { initJobProcessing } from '../../app/jobs';
import { eventNames, PubSubAdapter } from '../../app/support/PubSubAdapter';
import { getSingleton } from '../../app/app';
import { withModifiedConfig } from '../helpers/with-modified-config';

import {
  createTestUser,
  updateUserAsync,
  performJSONRequest,
  authHeaders,
  justCreatePost,
  performRequest,
} from './functional_test_helper';
import Session from './realtime-session';

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

    // Test the v4 API response
    const resp1 = await performJSONRequest('GET', `/v4/attachments/${id}`);
    expect(resp1, 'to satisfy', {
      attachments: {
        id,
        mediaType: 'general',
        fileName: 'test.txt',
        fileSize: 'this is a test'.length,
        previewTypes: expect.it('to equal', []),
        createdAt: attObj.createdAt.toISOString(),
        updatedAt: attObj.updatedAt.toISOString(),
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

    // Test the v4 API response
    const resp1 = await performJSONRequest('GET', `/v4/attachments/${id}`);
    expect(resp1.attachments, 'to equal', {
      id,
      mediaType: 'image',
      fileName: 'test-image.150x150.png',
      fileSize: fs.statSync(filePath).size,
      previewTypes: ['image'],
      width: 150,
      height: 150,
      createdAt: attObj.createdAt.toISOString(),
      updatedAt: attObj.updatedAt.toISOString(),
      createdBy: luna.user.id,
      postId: null,
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

    // Test the v4 API response
    const resp1 = await performJSONRequest('GET', `/v4/attachments/${id}`);
    expect(resp1.attachments, 'to equal', {
      id,
      mediaType: 'image',
      fileName: 'test-image.900x300.png',
      fileSize: fs.statSync(filePath).size,
      previewTypes: ['image'],
      width: 900,
      height: 300,
      createdAt: attObj.createdAt.toISOString(),
      updatedAt: attObj.updatedAt.toISOString(),
      createdBy: luna.user.id,
      postId: null,
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

    // Test the v4 API response
    const resp1 = await performJSONRequest('GET', `/v4/attachments/${id}`);
    expect(resp1.attachments, 'to equal', {
      id,
      mediaType: 'image',
      fileName: 'test-image.3000x2000.png',
      fileSize: fs.statSync(filePath).size,
      previewTypes: ['image'],
      width: 3000,
      height: 2000,
      previewWidth: 2449,
      previewHeight: 1633,
      createdAt: attObj.createdAt.toISOString(),
      updatedAt: attObj.updatedAt.toISOString(),
      createdBy: luna.user.id,
      postId: null,
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

    // Test the v4 API response
    const resp1 = await performJSONRequest('GET', `/v4/attachments/${id}`);
    expect(resp1.attachments, 'to equal', {
      id,
      mediaType: 'audio',
      fileName: 'music.mp3',
      fileSize: fs.statSync(filePath).size,
      previewTypes: ['audio'],
      meta: {
        'dc:title': 'Improvisation with Sopranino Recorder',
        'dc:creator': 'Piermic',
      },
      duration: 24.032653,
      createdAt: attObj.createdAt.toISOString(),
      updatedAt: attObj.updatedAt.toISOString(),
      createdBy: luna.user.id,
      postId: null,
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

    // Test the v4 API response
    const resp1 = await performJSONRequest('GET', `/v4/attachments/${id}`);
    expect(resp1.attachments, 'to equal', {
      id,
      mediaType: 'video',
      fileName: 'test-image-animated.gif',
      fileSize: fs.statSync(filePath).size,
      previewTypes: ['image', 'video'],
      meta: {
        animatedImage: true,
        silent: true,
      },
      width: 774,
      height: 392,
      duration: 2.4,
      createdAt: attObj.createdAt.toISOString(),
      updatedAt: attObj.updatedAt.toISOString(),
      createdBy: luna.user.id,
      postId: null,
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
        fileName: 'polyphon.mp4',
        mediaType: 'general',
        fileSize: '29',
        createdAt: attObj.createdAt.getTime().toString(),
        updatedAt: attObj.updatedAt.getTime().toString(),
        url: attObj.getFileUrl('', 'tmp'),
        thumbnailUrl: attObj.getFileUrl('', 'tmp'),
        imageSizes: expect.it('to equal', {}),
        createdBy: luna.user.id,
        postId: null,
        inProgress: true,
      },
      users: [{ id: luna.user.id }],
    });

    // Test the v4 API response
    {
      const resp1 = await performJSONRequest('GET', `/v4/attachments/${id}`);
      expect(resp1.attachments, 'to equal', {
        id,
        mediaType: 'video',
        fileName: 'polyphon.mp4',
        fileSize: 29,
        width: 1280,
        height: 720,
        duration: 5.005,
        previewTypes: [],
        meta: { inProgress: true },
        createdAt: attObj.createdAt.toISOString(),
        updatedAt: attObj.updatedAt.toISOString(),
        createdBy: luna.user.id,
        postId: null,
      });
    }

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

    // Test the v4 API response
    {
      const maxFile = attObj.getLocalFilePath('');
      const resp1 = await performJSONRequest('GET', `/v4/attachments/${id}`);
      expect(resp1.attachments, 'to equal', {
        id,
        mediaType: 'video',
        fileName: 'polyphon.mp4',
        fileSize: fs.statSync(maxFile).size,
        previewTypes: ['image', 'video'],
        duration: 5.005,
        width: 1280,
        height: 720,
        createdAt: attObj.createdAt.toISOString(),
        updatedAt: attObj.updatedAt.toISOString(),
        createdBy: luna.user.id,
        postId: null,
      });
    }
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

      // Test the v4 API response
      {
        const resp1 = await performJSONRequest(
          'GET',
          '/v4/attachments/my?limit=4',
          null,
          authHeaders(mars),
        );
        expect(resp1, 'to satisfy', {
          attachments: [
            { fileName: 'test10.txt', previewTypes: [] },
            { fileName: 'test9.txt', previewTypes: [] },
            { fileName: 'test8.txt', previewTypes: [] },
            { fileName: 'test7.txt', previewTypes: [] },
          ],
          users: [{ id: mars.user.id }],
          hasMore: true,
        });
      }
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

  describe('Realtime events for attachments processing', () => {
    let jobManager;
    before(async () => {
      const pubsubAdapter = new PubSubAdapter($database);
      PubSub.setPublisher(pubsubAdapter);
      jobManager = await initJobProcessing();
    });

    /** @type {Session} */
    let lunaSubscribedToHerChannel;
    /** @type {Session} */
    let lunaSubscribedToPost;
    /** @type {Session} */
    let lunaSubscribedToAttachment;
    /** @type {Session} */
    let anonSubscribedToPost;
    /** @type {Session} */
    let anonSubscribedToAttachment;

    const clearCollected = () =>
      [
        lunaSubscribedToHerChannel,
        lunaSubscribedToPost,
        lunaSubscribedToAttachment,
        anonSubscribedToPost,
        anonSubscribedToAttachment,
      ].forEach((s) => (s.collected.length = 0));

    beforeEach(async () => {
      const app = await getSingleton();
      const port = process.env.PEPYATKA_SERVER_PORT || app.context.config.port;

      lunaSubscribedToHerChannel = await Session.create(port, 'Luna subscribed to her channel');
      await lunaSubscribedToHerChannel.sendAsync('auth', { authToken: luna.authToken });

      lunaSubscribedToPost = await Session.create(port, 'Luna subscribed to post');
      await lunaSubscribedToPost.sendAsync('auth', { authToken: luna.authToken });

      lunaSubscribedToAttachment = await Session.create(port, 'Luna subscribed to attachment');
      await lunaSubscribedToAttachment.sendAsync('auth', { authToken: luna.authToken });

      anonSubscribedToPost = await Session.create(port, 'Anonymous subscribed to post');
      anonSubscribedToAttachment = await Session.create(port, 'Anonymous subscribed to attachment');
    });
    afterEach(() =>
      [
        lunaSubscribedToHerChannel,
        lunaSubscribedToPost,
        lunaSubscribedToAttachment,
        anonSubscribedToPost,
        anonSubscribedToAttachment,
      ].forEach((s) => s.disconnect()),
    );

    it(`should send realtime events to the listener's channels`, async () => {
      await Promise.all([
        lunaSubscribedToHerChannel.sendAsync('subscribe', { user: [luna.user.id] }),
      ]);

      // Create an attachment
      const filePath = path.join(__dirname, '../fixtures/media-files/polyphon.mp4');
      const data = new FormData();
      data.append('file', await fileFrom(filePath, 'image/gif'));
      const resp = await performJSONRequest('POST', '/v1/attachments', data, authHeaders(luna));
      const { id: attId } = resp.attachments;

      await Promise.all([
        lunaSubscribedToAttachment.sendAsync('subscribe', { attachment: [attId] }),
        anonSubscribedToAttachment.sendAsync('subscribe', { attachment: [attId] }),
      ]);

      {
        const events = await Promise.all([
          lunaSubscribedToHerChannel.haveCollected(eventNames.ATTACHMENT_CREATED),
        ]);

        expect(events, 'to satisfy', [
          { attachments: { id: attId, url: expect.it('to end with', '.tmp') } },
        ]);
        clearCollected();
      }

      const post = await justCreatePost(luna, `Luna post`);
      await post.linkAttachments([attId]);

      {
        const events = await Promise.all([
          lunaSubscribedToHerChannel.haveCollected(eventNames.ATTACHMENT_UPDATED),
          lunaSubscribedToAttachment.haveCollected(eventNames.ATTACHMENT_UPDATED),
          anonSubscribedToAttachment.haveCollected(eventNames.ATTACHMENT_UPDATED),
        ]);

        expect(events, 'to satisfy', [
          { attachments: { id: attId, url: expect.it('to end with', '.tmp') } },
          { attachments: { id: attId, url: expect.it('to end with', '.tmp') } },
          { attachments: { id: attId, url: expect.it('to end with', '.tmp') } },
        ]);
      }

      await Promise.all([
        lunaSubscribedToPost.sendAsync('subscribe', { post: [post.id] }),
        anonSubscribedToPost.sendAsync('subscribe', { post: [post.id] }),
      ]);

      // Run processing
      clearCollected();

      await jobManager.fetchAndProcess();

      {
        const events = await Promise.all([
          lunaSubscribedToHerChannel.haveCollected(eventNames.ATTACHMENT_UPDATED),
          lunaSubscribedToPost.haveCollected(eventNames.POST_UPDATED),
          lunaSubscribedToAttachment.haveCollected(eventNames.ATTACHMENT_UPDATED),
          anonSubscribedToPost.haveCollected(eventNames.POST_UPDATED),
          anonSubscribedToAttachment.haveCollected(eventNames.ATTACHMENT_UPDATED),
        ]);

        expect(events, 'to satisfy', [
          { attachments: { id: attId, url: expect.it('to end with', '.mp4') } },
          {
            posts: { id: post.id },
            attachments: [{ id: attId, url: expect.it('to end with', '.mp4') }],
          },
          { attachments: { id: attId, url: expect.it('to end with', '.mp4') } },
          {
            posts: { id: post.id },
            attachments: [{ id: attId, url: expect.it('to end with', '.mp4') }],
          },
          { attachments: { id: attId, url: expect.it('to end with', '.mp4') } },
        ]);
      }
    });
  });

  describe('Preview endpoint', () => {
    /** @type {Attachment} */
    let att;

    it('should return a error for invalid ID', async () => {
      const resp = await performJSONRequest(
        'GET',
        `/v4/attachments/00000000-00000000-00000000-00000000/original`,
      );
      expect(resp, 'to satisfy', {
        err: 'Attachment not found',
        __httpCode: 404,
      });
    });

    describe("'general' type and common errors", () => {
      before(async () => {
        const data = new FormData();
        data.append('file', new Blob(['this is a test'], { type: 'text/plain' }), 'test.txt');
        const resp = await performJSONRequest('POST', '/v4/attachments', data, authHeaders(luna));
        const { id } = resp.attachments;
        att = await dbAdapter.getAttachmentById(id);
      });

      it('should return a link to the original', async () => {
        const resp = await performJSONRequest('GET', `/v4/attachments/${att.id}/original`);
        expect(resp, 'to satisfy', {
          url: att.getFileUrl(''),
          mimeType: 'text/plain',
        });
      });

      it('should return redirect to the original', async () => {
        /** @type {Response} */
        const resp = await performRequest(`/v4/attachments/${att.id}/original?redirect`, {
          redirect: 'manual',
        });
        expect(resp.status, 'to be', 302);
        expect(resp.headers.get('Location'), 'to be', att.getFileUrl(''));
      });

      for (const type of ['image', 'video', 'audio']) {
        it(`should return a error for '${type}' preview type`, async () => {
          const resp = await performJSONRequest('GET', `/v4/attachments/${att.id}/${type}`);
          expect(resp, 'to satisfy', {
            err: 'Preview of specified type not found',
            __httpCode: 404,
          });
        });
      }

      it(`should return a error for 'incorrect' preview type`, async () => {
        const resp = await performJSONRequest('GET', `/v4/attachments/${att.id}/incorrect`);
        expect(resp, 'to satisfy', {
          err: 'Invalid preview type',
          __httpCode: 404,
        });
      });
    });

    describe("'image' type", () => {
      before(async () => {
        const filePath = path.join(__dirname, '../fixtures/test-image.900x300.png');
        const data = new FormData();
        data.append('file', await fileFrom(filePath, 'image/png'));
        const resp = await performJSONRequest('POST', '/v1/attachments', data, authHeaders(luna));
        const { id } = resp.attachments;
        att = await dbAdapter.getAttachmentById(id);
      });

      it('should return a link to the original', async () => {
        const resp = await performJSONRequest('GET', `/v4/attachments/${att.id}/original`);
        expect(resp, 'to satisfy', {
          url: att.getFileUrl(''),
          mimeType: 'image/png',
          width: 900,
          height: 300,
        });
      });

      for (const type of ['video', 'audio']) {
        it(`should return a error for '${type}' preview type`, async () => {
          const resp = await performJSONRequest('GET', `/v4/attachments/${att.id}/${type}`);
          expect(resp, 'to satisfy', {
            err: 'Preview of specified type not found',
            __httpCode: 404,
          });
        });
      }

      it(`should return the original as a largest 'image' preview`, async () => {
        const resp = await performJSONRequest('GET', `/v4/attachments/${att.id}/image`);
        expect(resp, 'to satisfy', {
          url: att.getFileUrl(''),
          mimeType: 'image/png',
          width: 900,
          height: 300,
        });
      });

      it(`should return a small 'image' preview`, async () => {
        const resp = await performJSONRequest(
          'GET',
          `/v4/attachments/${att.id}/image?width=100&height=100`,
        );
        expect(resp, 'to satisfy', {
          url: att.getFileUrl('thumbnails'),
          mimeType: 'image/webp',
          width: 525,
          height: 175,
        });
      });

      it(`should return 'image' preview that is bigger than the original`, async () => {
        const resp = await performJSONRequest(
          'GET',
          `/v4/attachments/${att.id}/image?width=1000&height=1000`,
        );
        expect(resp, 'to satisfy', {
          url: att.getFileUrl(''),
          mimeType: 'image/png',
          width: 900,
          height: 300,
        });
      });

      describe(`when the imgproxy is turned on`, () => {
        withModifiedConfig({ attachments: { useImgProxy: true } });

        it(`should return a small 'image' preview`, async () => {
          const resp = await performJSONRequest(
            'GET',
            `/v4/attachments/${att.id}/image?width=100&height=100`,
          );
          expect(resp, 'to satisfy', {
            url: `${att.getFileUrl('thumbnails')}?format=jpeg&width=100&height=100`,
            mimeType: 'image/jpeg',
            width: 100,
            height: 100,
          });
        });

        it(`should return a small 'image' preview in reply to the request with Accept header`, async () => {
          const resp = await performJSONRequest(
            'GET',
            `/v4/attachments/${att.id}/image?width=100&height=100`,
            null,
            { Accept: 'image/avif,image/webp' },
          );
          expect(resp, 'to satisfy', {
            url: `${att.getFileUrl('thumbnails')}?format=avif&width=100&height=100`,
            mimeType: 'image/avif',
            width: 100,
            height: 100,
          });
        });

        it(`should return a small 'image' preview with requested AVIF format`, async () => {
          const resp = await performJSONRequest(
            'GET',
            `/v4/attachments/${att.id}/image?width=100&height=100&format=avif`,
          );
          expect(resp, 'to satisfy', {
            url: `${att.getFileUrl('thumbnails')}?format=avif&width=100&height=100`,
            mimeType: 'image/avif',
            width: 100,
            height: 100,
          });
        });
      });
    });

    describe("'audio' type", () => {
      before(async () => {
        const filePath = path.join(__dirname, '../fixtures/media-files/music.mp3');
        const data = new FormData();
        data.append('file', await fileFrom(filePath, 'audio/mpeg'));
        const resp = await performJSONRequest('POST', '/v1/attachments', data, authHeaders(luna));
        const { id } = resp.attachments;
        att = await dbAdapter.getAttachmentById(id);
      });

      it('should return a link to the original', async () => {
        const resp = await performJSONRequest('GET', `/v4/attachments/${att.id}/original`);
        expect(resp, 'to satisfy', {
          url: att.getFileUrl(''),
          mimeType: 'audio/mpeg',
        });
      });

      for (const type of ['video', 'image']) {
        it(`should return a error for '${type}' preview type`, async () => {
          const resp = await performJSONRequest('GET', `/v4/attachments/${att.id}/${type}`);
          expect(resp, 'to satisfy', {
            err: 'Preview of specified type not found',
            __httpCode: 404,
          });
        });
      }

      it('should return the original as an audio preview', async () => {
        const resp = await performJSONRequest('GET', `/v4/attachments/${att.id}/audio`);
        expect(resp, 'to satisfy', {
          url: att.getFileUrl(''),
          mimeType: 'audio/mpeg',
        });
      });
    });

    describe("'video' type", () => {
      before(async () => {
        const filePath = path.join(__dirname, '../fixtures/test-image-animated.gif');
        const data = new FormData();
        data.append('file', await fileFrom(filePath, 'image/gif'));
        const resp = await performJSONRequest('POST', '/v1/attachments', data, authHeaders(luna));
        const { id } = resp.attachments;
        att = await dbAdapter.getAttachmentById(id);
      });

      it('should return a link to the original', async () => {
        const resp = await performJSONRequest('GET', `/v4/attachments/${att.id}/original`);
        expect(resp, 'to satisfy', {
          url: att.getFileUrl(''),
          mimeType: 'image/gif',
          width: 774,
          height: 392,
        });
      });

      for (const type of ['audio']) {
        it(`should return a error for '${type}' preview type`, async () => {
          const resp = await performJSONRequest('GET', `/v4/attachments/${att.id}/${type}`);
          expect(resp, 'to satisfy', {
            err: 'Preview of specified type not found',
            __httpCode: 404,
          });
        });
      }

      it(`should return a small 'image' preview`, async () => {
        const resp = await performJSONRequest(
          'GET',
          `/v4/attachments/${att.id}/image?width=100&height=100`,
        );
        expect(resp, 'to satisfy', {
          url: att.getFileUrl('thumbnails'),
          mimeType: 'image/webp',
          width: 346,
          height: 175,
        });
      });

      it(`should return a small 'video' preview`, async () => {
        const resp = await performJSONRequest(
          'GET',
          `/v4/attachments/${att.id}/video?width=100&height=100`,
        );
        expect(resp, 'to satisfy', {
          url: att.getFileUrl('v1'),
          mimeType: 'video/mp4',
          width: 774,
          height: 392,
        });
      });
    });
  });
});

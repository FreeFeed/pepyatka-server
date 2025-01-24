/* eslint-env node, mocha */
/* global $database, $pg_database */
import { Readable } from 'stream';

import { fromPairs } from 'lodash';
import expect from 'unexpected';
import config from 'config';

import cleanDB from '../dbCleaner';
import { getSingleton } from '../../app/app';
import { dbAdapter, PubSub } from '../../app/models';
import { PubSubAdapter } from '../../app/support/PubSubAdapter';

import {
  createPostViaBookmarklet,
  createGroupAsync,
  createTestUser,
  MockHTTPServer,
} from './functional_test_helper';
import { postResponse } from './schemaV2-helper';
import Session from './realtime-session';

const sizeLimits = config.attachments.fileSizeLimitByType;
const imageSizeLimit = sizeLimits['image'] ?? sizeLimits['default'];

describe('BookmarkletController', () => {
  let rtPort;

  before(async () => {
    const app = await getSingleton();
    rtPort = process.env.PEPYATKA_SERVER_PORT || app.context.config.port;
    const pubsubAdapter = new PubSubAdapter($database);
    PubSub.setPublisher(pubsubAdapter);
  });

  beforeEach(() => cleanDB($pg_database));

  describe('#create()', () => {
    let luna;
    beforeEach(async () => {
      luna = await createTestUser();
    });

    it('should create post in the author feed by default', async () => {
      const response = await callBookmarklet(luna, { title: 'Post' });
      expect(response.subscriptions, 'to have length', 1);
      expect(response.subscriptions, 'to satisfy', [{ name: 'Posts', user: luna.user.id }]);
    });

    it('should create post in the author feed', async () => {
      const response = await callBookmarklet(luna, {
        title: 'Post',
        meta: { feeds: [luna.username] },
      });
      expect(response.subscriptions, 'to have length', 1);
      expect(response.subscriptions, 'to satisfy', [{ name: 'Posts', user: luna.user.id }]);
    });

    it('should create post in the multiple feeds', async () => {
      const group = await createGroupAsync(luna, 'new-shiny-group');
      const response = await callBookmarklet(luna, {
        title: 'Post',
        meta: { feeds: [luna.username, group.username] },
      });
      expect(response.subscriptions, 'to have length', 2);
      expect(response.subscriptions, 'to have an item satisfying', {
        name: 'Posts',
        user: luna.user.id,
      });
      expect(response.subscriptions, 'to have an item satisfying', {
        name: 'Posts',
        user: group.group.id,
      });
    });

    it('should force an error when trying to post into nonexistent groups', async () => {
      const call = callBookmarklet(luna, {
        title: 'Post',
        meta: { feeds: [luna.username, 'non-existent-group'] },
      });
      await expect(call, 'to be rejected with', /^HTTP error 404:/);
    });

    it('should create post with comment', async () => {
      const response = await callBookmarklet(luna, { title: 'Post', comment: 'Comment' });
      expect(response.comments, 'to have length', 1);
      expect(response.comments, 'to satisfy', [{ body: 'Comment', createdBy: luna.user.id }]);
    });

    describe('Realtime', () => {
      let lunaSession;
      beforeEach(async () => {
        lunaSession = await Session.create(rtPort, 'Luna session');
        const lunaPostsFeed = await dbAdapter.getUserNamedFeed(luna.user.id, 'Posts');
        await lunaSession.sendAsync('subscribe', { timeline: [lunaPostsFeed.id] });
      });

      afterEach(() => lunaSession.disconnect());

      it(`should deliver 'post:new' event when post created`, async () => {
        const test = lunaSession.receiveWhile('post:new', () =>
          callBookmarklet(luna, { title: 'Post' }),
        );
        await expect(test, 'to be fulfilled');
      });

      it(`should deliver 'post:new' and 'comment:new' events when post created with comment`, async () => {
        const test = lunaSession.receiveWhileSeq(['post:new', 'comment:new'], () =>
          callBookmarklet(luna, { title: 'Post', comment: 'Comment' }),
        );
        await expect(test, 'to be fulfilled');
      });
    });

    describe('Attachments', () => {
      const server = new MockHTTPServer((ctx) => {
        const {
          request: { url },
        } = ctx;

        if (url === '/big-cl.jpg') {
          ctx.status = 200;
          ctx.response.type = 'image/jpeg';
          ctx.body = 'sss';
          ctx.response.length = imageSizeLimit * 2;
        } else if (url === '/big-body.jpg') {
          ctx.status = 200;
          ctx.response.type = 'image/jpeg';
          ctx.body = getStreamOfLength(imageSizeLimit * 2);
        } else if (url === '/im%C3%A5ge.png') {
          ctx.status = 200;
          ctx.response.type = 'image/png';
          ctx.body = 'sss';
        } else if (/\.jpg$/.test(url)) {
          ctx.status = 200;
          ctx.response.type = 'image/jpeg';
          ctx.body = 'sss';
        } else if (/\.txt$/.test(url)) {
          ctx.status = 200;
          ctx.response.type = 'text/plain';
          ctx.body = 'sss';
        }
      });

      before(() => server.start());
      after(() => server.stop());

      it(`should create post with the image attachment`, async () => {
        const result = await callBookmarklet(luna, {
          title: 'Post',
          image: `${server.origin}/image.jpg`,
        });
        expect(result.attachments, 'to satisfy', [{ fileName: 'image.jpg' }]);
      });

      it(`should create post with N image attachments in proper order`, async () => {
        const n = 5;
        const fileNames = [];

        for (let i = 0; i < n; i++) {
          fileNames.push(`image${i}.jpg`);
        }

        const result = await callBookmarklet(luna, {
          title: 'Post',
          images: fileNames.map((name) => `${server.origin}/${name}`),
        });
        expect(
          result.attachments,
          'to satisfy',
          fromPairs(fileNames.map((fileName, i) => [i, { fileName }])),
        );
      });

      it(`should not create post with too many image attachments`, async () => {
        const n = config.attachments.maxCount + 5;
        const fileNames = [];

        for (let i = 0; i < n; i++) {
          fileNames.push(`image${i}.jpg`);
        }

        const call = callBookmarklet(luna, {
          title: 'Post',
          images: fileNames.map((name) => `${server.origin}/${name}`),
        });
        await expect(call, 'to be rejected with', /^HTTP error 422:/);
      });

      it(`should not create post with non-image attachment`, async () => {
        const call = callBookmarklet(luna, {
          title: 'Post',
          images: [`${server.origin}/image.txt`],
        });
        await expect(call, 'to be rejected with', /^HTTP error 403:/);
      });

      it(`should not create post with unexistent attachment`, async () => {
        const call = callBookmarklet(luna, {
          title: 'Post',
          images: [`${server.origin}/image.pdf`],
        });
        await expect(call, 'to be rejected with', /^HTTP error 403:/);
      });

      it(`should not create post with image and non-image attachment`, async () => {
        const call = callBookmarklet(luna, {
          title: 'Post',
          images: [`${server.origin}/image1.jpg`, `${server.origin}/image2.txt`],
        });
        await expect(call, 'to be rejected with', /^HTTP error 403:/);
      });

      it(`should not create post with attachment with very large Content-Length`, async () => {
        const call = callBookmarklet(luna, {
          title: 'Post',
          images: [`${server.origin}/big-cl.jpg`],
        });
        await expect(call, 'to be rejected with', /^HTTP error 403:/);
      });

      it(`should not create post with very large attachment without Content-Length`, async () => {
        const call = callBookmarklet(luna, {
          title: 'Post',
          images: [`${server.origin}/big-body.jpg`],
        });
        await expect(call, 'to be rejected with', /^HTTP error 403:/);
      });

      it(`should create post with unescaped unicode image URL`, async () => {
        const result = await callBookmarklet(luna, {
          title: 'Post',
          image: `${server.origin}/imåge.png`,
        });
        expect(result.attachments, 'to have length', 1);
        expect(result.attachments, 'to satisfy', [{ fileName: 'imåge.png' }]);
      });
    });
  });
});

async function callBookmarklet(author, body) {
  const response = await createPostViaBookmarklet(author, body);
  const respBody = await response.json();

  if (response.status !== 200) {
    throw new Error(`HTTP error ${response.status}: ${respBody.err}`);
  }

  expect(respBody, 'to exhaustively satisfy', postResponse);
  return respBody;
}

function getStreamOfLength(length, chunk = Buffer.alloc(1024)) {
  let bytesLeft = length;
  return new Readable({
    read() {
      if (bytesLeft >= chunk.length) {
        this.push(chunk);
        bytesLeft -= chunk.length;
      } else if (bytesLeft > 0) {
        this.push(chunk.slice(0, bytesLeft));
        bytesLeft = 0;
      } else {
        this.push(null);
      }
    },
  });
}

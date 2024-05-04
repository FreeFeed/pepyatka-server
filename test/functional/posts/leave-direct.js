/* eslint-env node, mocha */
/* global $database, $pg_database */
import expect from 'unexpected';

import cleanDB from '../../dbCleaner';
import { getSingleton } from '../../../app/app';
import { PubSubAdapter } from '../../../app/support/PubSubAdapter';
import { dbAdapter, PubSub } from '../../../app/models';
import {
  authHeaders,
  createTestUsers,
  justCreatePost,
  mutualSubscriptions,
  performJSONRequest,
} from '../functional_test_helper';
import Session from '../realtime-session';
import { EVENT_TYPES } from '../../../app/support/EventTypes';
import { serializeEvents } from '../../../app/serializers/v2/event';
import { getEventText } from '../../../app/mailers/NotificationDigestMailer';

describe('POST /v2/posts/:postId/leave', () => {
  let luna, mars, venus, jupiter;
  before(async () => {
    await cleanDB($pg_database);

    [luna, mars, venus, jupiter] = await createTestUsers(['luna', 'mars', 'venus', 'jupiter']);
    await mutualSubscriptions([luna, mars, venus, jupiter]);
  });

  describe('Luna create direct with Mars and Venus', () => {
    let post;
    beforeEach(async () => {
      post = await justCreatePost(luna, 'Hello', [luna.username, mars.username, venus.username]);
    });
    afterEach(async () => {
      await post.destroy();
    });

    it('should allow Mars to leave direct', async () => {
      const resp = await leave(post, mars);
      expect(resp, 'to satisfy', { __httpCode: 200 });
    });

    it('should allow Venus to leave direct', async () => {
      const resp = await leave(post, mars);
      expect(resp, 'to satisfy', { __httpCode: 200 });
    });

    it('should not allow Luna to leave direct', async () => {
      const resp = await leave(post, luna);
      expect(resp, 'to satisfy', { __httpCode: 403 });
    });

    it('should not allow Jupiter to leave direct', async () => {
      const resp = await leave(post, jupiter);
      expect(resp, 'to satisfy', { __httpCode: 403 });
    });

    it('should not allow anonymous to leave direct', async () => {
      const resp = await leave(post, null);
      expect(resp, 'to satisfy', { __httpCode: 401 });
    });

    describe('Mars leaving direct', () => {
      beforeEach(async () => {
        await clearAllEvents();
        await leave(post, mars);
      });

      it('should not allow Mars to see post', async () => {
        const resp = await getPost(post, mars);
        expect(resp, 'to satisfy', { __httpCode: 403 });
      });

      it('should allow Luna to see post', async () => {
        const resp = await getPost(post, luna);
        expect(resp, 'to satisfy', { __httpCode: 200 });
      });

      it('should allow Venus to see post', async () => {
        const resp = await getPost(post, venus);
        expect(resp, 'to satisfy', { __httpCode: 200 });
      });

      it(`should show post in Luna's homefdeed`, async () => {
        const resp = await getHome(luna);
        expect(resp, 'to satisfy', { timelines: { posts: [post.id] } });
      });

      it(`should show post in Venuses homefdeed`, async () => {
        const resp = await getHome(venus);
        expect(resp, 'to satisfy', { timelines: { posts: [post.id] } });
      });

      it(`should not show post in Marses homefdeed`, async () => {
        const resp = await getHome(mars);
        expect(resp, 'to satisfy', { timelines: { posts: [] } });
      });

      describe('Notifications', () => {
        it(`should create notification for Mars`, async () => {
          const events = await getSerializedEvents(mars.user.id);
          expect(events.events, 'to have length', 1);
          const text = stripHTML(getEventText(events.events[0], events.users, events.groups));
          expect(text, 'to be', 'You left a direct message created by @luna');
        });

        it(`should create notification for Luna`, async () => {
          const events = await getSerializedEvents(luna.user.id);
          expect(events.events, 'to have length', 1);
          const text = stripHTML(getEventText(events.events[0], events.users, events.groups));
          expect(text, 'to be', '@mars left a direct message created by you');
        });

        it(`should create notification for Venus`, async () => {
          const events = await getSerializedEvents(venus.user.id);
          expect(events.events, 'to have length', 1);
          const text = stripHTML(getEventText(events.events[0], events.users, events.groups));
          expect(text, 'to be', '@mars left a direct message created by @luna');
        });
      });
    });

    describe('Mars and Venus leaving direct', () => {
      beforeEach(() => Promise.all([leave(post, mars), leave(post, venus)]));

      it('should not allow Mars to see post', async () => {
        const resp = await getPost(post, mars);
        expect(resp, 'to satisfy', { __httpCode: 403 });
      });

      it('should allow Luna to see post', async () => {
        const resp = await getPost(post, luna);
        expect(resp, 'to satisfy', { __httpCode: 200 });
      });

      it('should not allow Venus to see post', async () => {
        const resp = await getPost(post, venus);
        expect(resp, 'to satisfy', { __httpCode: 403 });
      });

      it(`should show post in Luna's homefdeed`, async () => {
        const resp = await getHome(luna);
        expect(resp, 'to satisfy', { timelines: { posts: [post.id] } });
      });

      it(`should not show post in Venuses homefdeed`, async () => {
        const resp = await getHome(venus);
        expect(resp, 'to satisfy', { timelines: { posts: [] } });
      });

      it(`should not show post in Marses homefdeed`, async () => {
        const resp = await getHome(mars);
        expect(resp, 'to satisfy', { timelines: { posts: [] } });
      });

      it(`should allow Luna to update post with empty 'feeds' array`, async () => {
        const resp = await performJSONRequest(
          'PUT',
          `/v1/posts/${post.id}`,
          {
            post: { body: 'Updated post', feeds: [] },
          },
          authHeaders(luna),
        );
        expect(resp, 'to satisfy', { __httpCode: 200 });
      });
    });

    describe('Realtime', () => {
      let port;

      before(async () => {
        const app = await getSingleton();
        ({ port } = app.context);
        const pubsubAdapter = new PubSubAdapter($database);
        PubSub.setPublisher(pubsubAdapter);
      });

      let lunaSession, marsSession, venusSession;

      beforeEach(async () => {
        [lunaSession, marsSession, venusSession] = await Promise.all([
          Session.create(port, 'Luna session'),
          Session.create(port, 'Mars session'),
          Session.create(port, 'Venus session'),
        ]);

        await Promise.all([
          lunaSession.sendAsync('auth', { authToken: luna.authToken }),
          marsSession.sendAsync('auth', { authToken: mars.authToken }),
          venusSession.sendAsync('auth', { authToken: venus.authToken }),
        ]);

        await Promise.all([
          lunaSession.sendAsync('subscribe', { post: [post.id] }),
          marsSession.sendAsync('subscribe', { post: [post.id] }),
          venusSession.sendAsync('subscribe', { post: [post.id] }),
        ]);
      });

      afterEach(() => [lunaSession, marsSession, venusSession].forEach((s) => s.disconnect()));

      it(`should deliver 'post:destroy' event to Mars when he leaves post`, async () => {
        const test = marsSession.receiveWhile('post:destroy', () => leave(post, mars));
        await expect(test, 'to be fulfilled with', { meta: { postId: post.id } });
      });

      it(`should not deliver 'post:destroy' event to Luna when Mars leaves post`, async () => {
        const test = lunaSession.notReceiveWhile('post:destroy', () => leave(post, mars));
        await expect(test, 'to be fulfilled');
      });

      it(`should not deliver 'post:destroy' event to Venus when Mars leaves post`, async () => {
        const test = venusSession.notReceiveWhile('post:destroy', () => leave(post, mars));
        await expect(test, 'to be fulfilled');
      });

      it(`should deliver 'post:update' event to Luna when Mars leaves post`, async () => {
        const test = lunaSession.receiveWhile('post:update', () => leave(post, mars));
        await expect(test, 'to be fulfilled');
      });

      it(`should deliver 'post:update' event to Venus when Mars leaves post`, async () => {
        const test = venusSession.receiveWhile('post:update', () => leave(post, mars));
        await expect(test, 'to be fulfilled');
      });
    });
  });
});

const leave = (post, ctx) =>
  performJSONRequest('POST', `/v2/posts/${post.id}/leave`, {}, authHeaders(ctx));

const getPost = (post, ctx) =>
  performJSONRequest('GET', `/v2/posts/${post.id}`, null, authHeaders(ctx));

const getHome = (ctx) => performJSONRequest('GET', `/v2/timelines/home`, null, authHeaders(ctx));

async function getSerializedEvents(userId) {
  const userObj = await dbAdapter.getUserById(userId);
  const events = await dbAdapter.getUserEvents(userObj.intId, [EVENT_TYPES.DIRECT_LEFT]);
  return serializeEvents(events, userId);
}

async function clearAllEvents() {
  await dbAdapter.database.raw(`delete from events`);
}

function stripHTML(str) {
  return str.replace(/<.+?>/g, '');
}

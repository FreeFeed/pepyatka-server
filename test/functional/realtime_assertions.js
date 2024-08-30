import socketIO from 'socket.io-client';

import { API_VERSION_ACTUAL } from '../../app/api-versions';
import { getSingleton as initApp } from '../../app/app';

import * as funcTestHelper from './functional_test_helper';

const eventTimeout = 2000;
const silenceTimeout = 600;

class Session {
  socket = null;
  context = {};

  static async create(userContext = { authToken: '' }) {
    const app = await initApp();
    const port = process.env.PEPYATKA_SERVER_PORT || app.context.config.port;
    const options = {
      transports: ['websocket'],
      forceNew: true,
      query: { token: userContext.authToken, apiVersion: API_VERSION_ACTUAL },
    };
    return new Promise((resolve, reject) => {
      const socket = socketIO.connect(`http://localhost:${port}/`, options);
      socket.on('error', reject);
      socket.on('connect_error', reject);
      socket.on('connect', () => resolve(new Session(socket)));
    });
  }

  constructor(socket) {
    this.socket = socket;
  }

  send(event, data) {
    this.socket.emit(event, data);
  }

  sendAsync = (event, data) => {
    return new Promise((resolve, reject) => {
      this.socket.emit(event, data, (result) => {
        if (result.success) {
          resolve(true);
        } else {
          reject(new Error(result.message));
        }
      });
    });
  };

  disconnect() {
    this.socket.disconnect();
  }

  receive(event, timeout = eventTimeout) {
    return new Promise((resolve, reject) => {
      const success = (data) => {
        this.socket.off(event, success);
        clearTimeout(timer);
        resolve(data);
      };
      this.socket.on(event, success);
      const timer = setTimeout(() => reject(new Error('unexpected timeout')), timeout);
    });
  }
}

// unexpected-realtime plugin

export const name = 'unexpected-realtime';

export function installInto(unexpected) {
  // Types
  unexpected.addType({
    name: 'userContext',
    base: 'object',
    identify: (ctx) => ctx !== null && typeof ctx === 'object' && 'authToken' in ctx,
    inspect: (ctx, depth, output, inspect) => {
      output
        .text('userContext(')
        .append(ctx.user ? inspect(ctx.user.username, depth) : 'ANONYMOUS')
        .text(')');
    },
  });

  unexpected.addType({
    name: 'realtimeSession',
    base: 'object',
    identify: (sess) => sess !== null && typeof sess === 'object' && sess instanceof Session,
    inspect: (sess, depth, output, inspect) =>
      output.text('Session(').append(inspect(sess.context, depth)).text(')'),
  });

  // Pre-conditions
  unexpected.addAssertion(
    '<userContext> when subscribed to timeline <string> <assertion>',
    async (expect, viewer, timeline) => {
      const session = await Session.create(viewer);
      await session.sendAsync('subscribe', { timeline: [timeline] });

      try {
        return await expect.shift(session);
      } finally {
        session.disconnect();
      }
    },
  );

  unexpected.addAssertion(
    '<userContext> when subscribed to user <string> <assertion>',
    async (expect, viewer, userUUID) => {
      const session = await Session.create(viewer);
      await session.sendAsync('subscribe', { user: [userUUID] });

      try {
        session.context.subscribedUserId = userUUID;
        return await expect.shift(session);
      } finally {
        session.disconnect();
      }
    },
  );

  unexpected.addAssertion(
    '<userContext> when subscribed to post <string> <assertion>',
    async (expect, viewer, postId) => {
      const session = await Session.create(viewer);
      await session.sendAsync('subscribe', { post: [postId] });

      try {
        return await expect.shift(session);
      } finally {
        session.disconnect();
      }
    },
  );

  unexpected.addAssertion(
    '<realtimeSession> when authorized as <userContext> <assertion>',
    async (expect, session, user) => {
      await session.sendAsync('auth', { authToken: user.authToken });

      try {
        return await expect.shift(session);
      } finally {
        session.disconnect();
      }
    },
  );

  unexpected.addAssertion(
    '<realtimeSession> with post having id <string> <assertion>',
    (expect, session, postId) => {
      session.context.postId = postId;
      return expect.shift(session);
    },
  );

  unexpected.addAssertion(
    '<realtimeSession> with comment having id <string> <assertion>',
    (expect, session, commentId) => {
      session.context.commentId = commentId;
      return expect.shift(session);
    },
  );

  // Assertions
  unexpected.addAssertion(
    '<realtimeSession> [not] to receive event <string>',
    async (expect, session, event) => {
      if (!expect.flags['not']) {
        try {
          return await session.receive(event);
        } catch {
          // pass
        }

        expect.fail();
      } else {
        try {
          await session.receive(event, silenceTimeout);
        } catch {
          return null;
        }

        expect.fail();
      }

      return null;
    },
  );

  unexpected.addAssertion(
    '<realtimeSession> to get post:* events from <userContext>',
    async (expect, session, publisher) => {
      expect.errorMode = 'nested';

      // Create post
      const [{ id: postId }, newPostEvent] = await Promise.all([
        funcTestHelper.createAndReturnPost(publisher, 'test post'),
        expect(session, 'to receive event', 'post:new'),
      ]);
      expect(newPostEvent.posts.id, 'to be', postId);
      session.context.newPostRealtimeMsg = newPostEvent;

      // Delete post
      const [, destroyPostEvent] = await Promise.all([
        funcTestHelper.deletePostAsync(publisher, postId),
        expect(session, 'to receive event', 'post:destroy'),
      ]);
      expect(destroyPostEvent.meta.postId, 'to be', postId);
      session.context.destroyPostRealtimeMsg = destroyPostEvent;
      return expect.shift(session);
    },
  );

  unexpected.addAssertion(
    '<realtimeSession> [not] to get post:update events from <userContext>',
    async (expect, session, publisher) => {
      expect.errorMode = 'nested';
      const noEvents = expect.flags['not'];

      expect(session.context, 'to have key', 'postId');
      const { postId } = session.context;

      const res = await Promise.all([
        funcTestHelper.updatePostAsync(
          { post: { id: postId }, authToken: publisher.authToken },
          { body: 'Updated post body' },
        ),
        expect(session, `${noEvents ? 'not ' : ''}to receive event`, 'post:update'),
      ]);
      [, session.context.postUpdateRealtimeMsg] = res;
      return expect.shift(session);
    },
  );

  unexpected.addAssertion(
    '<realtimeSession> not to get post:* events from <userContext>',
    async (expect, session, publisher) => {
      expect.errorMode = 'nested';

      // Create post
      await Promise.all([
        funcTestHelper.createAndReturnPost(publisher, 'test post'),
        expect(session, 'not to receive event', 'post:new'),
      ]);
    },
  );

  unexpected.addAssertion(
    '<realtimeSession> [not] to get comment:* events from <userContext>',
    async (expect, session, publisher) => {
      expect.errorMode = 'nested';
      const noEvents = expect.flags['not'];

      expect(session.context, 'to have key', 'postId');
      const { postId } = session.context;

      const res = await Promise.all([
        funcTestHelper.createCommentAsync(publisher, postId, 'reply'),
        expect(session, `${noEvents ? 'not ' : ''}to receive event`, 'comment:new'),
      ]);
      [, session.context.commentRealtimeMsg] = res;
      return expect.shift(session);
    },
  );

  unexpected.addAssertion(
    '<realtimeSession> [not] to get comment:update events from <userContext>',
    async (expect, session, publisher) => {
      expect.errorMode = 'nested';
      const noEvents = expect.flags['not'];

      expect(session.context, 'to have key', 'commentId');
      const { commentId } = session.context;

      const res = await Promise.all([
        funcTestHelper.updateCommentAsync(publisher, commentId, 'changed reply'),
        expect(session, `${noEvents ? 'not ' : ''}to receive event`, 'comment:update'),
      ]);
      [, session.context.commentRealtimeMsg] = res;
      return expect.shift(session);
    },
  );

  unexpected.addAssertion(
    '<realtimeSession> [not] to get like:* events from <userContext>',
    async (expect, session, publisher) => {
      expect.errorMode = 'nested';
      const noEvents = expect.flags['not'];

      expect(session.context, 'to have key', 'postId');
      const { postId } = session.context;

      await Promise.all([
        funcTestHelper.like(postId, publisher),
        expect(session, `${noEvents ? 'not ' : ''}to receive event`, 'like:new'),
      ]);
    },
  );

  unexpected.addAssertion(
    '<realtimeSession> [not] to get comment_like:new event from <userContext>',
    async (expect, session, publisher) => {
      expect.errorMode = 'nested';
      const noEvents = expect.flags['not'];

      expect(session.context, 'to have key', 'commentId');
      const { commentId } = session.context;

      const res = await Promise.all([
        funcTestHelper.likeComment(commentId, publisher),
        expect(session, `${noEvents ? 'not ' : ''}to receive event`, 'comment_like:new'),
      ]);
      [, session.context.commentLikeRealtimeMsg] = res;
      return expect.shift(session);
    },
  );

  unexpected.addAssertion(
    '<realtimeSession> [not] to get comment_like:remove event from <userContext>',
    async (expect, session, publisher) => {
      expect.errorMode = 'nested';
      const noEvents = expect.flags['not'];

      expect(session.context, 'to have key', 'commentId');
      const { commentId } = session.context;

      const res = await Promise.all([
        funcTestHelper.unlikeComment(commentId, publisher),
        expect(session, `${noEvents ? 'not ' : ''}to receive event`, 'comment_like:remove'),
      ]);
      [, session.context.commentLikeRealtimeMsg] = res;
      return expect.shift(session);
    },
  );

  unexpected.addAssertion(
    '<realtimeSession> [not] to get user:update event when called <function>',
    async (expect, session, method) => {
      expect.errorMode = 'nested';
      const noEvents = expect.flags['not'];

      expect(session.context, 'to have key', 'subscribedUserId');
      const { subscribedUserId } = session.context;

      const res = await Promise.all([
        method(subscribedUserId),
        expect(session, `${noEvents ? 'not ' : ''}to receive event`, 'user:update'),
      ]);
      [, session.context.userUpdateRealtimeMsg] = res;
      return expect.shift(session);
    },
  );
}

import Redis from 'ioredis';
import {
  cloneDeep,
  intersection,
  isArray,
  isFunction,
  isPlainObject,
  keyBy,
  last,
  map,
  noop,
  uniqBy,
} from 'lodash';
import IoServer from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import createDebug from 'debug';
import Raven from 'raven';
import config from 'config';

import { dbAdapter, Comment } from './models';
import { eventNames } from './support/PubSubAdapter';
import { List } from './support/open-lists';
import { withJWT } from './controllers/middlewares/with-jwt';
import { withAuthToken } from './controllers/middlewares/with-auth-token';
import {
  HOMEFEED_MODE_FRIENDS_ALL_ACTIVITY,
  HOMEFEED_MODE_CLASSIC,
  HOMEFEED_MODE_FRIENDS_ONLY,
} from './models/timeline';
import { serializeSinglePost } from './serializers/v2/post';
import { serializeCommentFull } from './serializers/v2/comment';
import { serializeUsersByIds } from './serializers/v2/user';
import { serializeEvents } from './serializers/v2/event';
import { API_VERSION_ACTUAL, API_VERSION_MINIMAL } from './api-versions';
import { connect as redisConnection } from './setup/database';
import { serializeAttachment } from './serializers/v2/attachment';
/** @typedef {import('./support/types').UUID} UUID */

const sentryIsEnabled = 'sentryDsn' in config;
const debug = createDebug('freefeed:PubsubListener');

export default class PubsubListener {
  app;
  io;

  constructor(server, app) {
    this.app = app;

    const pubClient = redisConnection();
    const subClient = pubClient.duplicate();

    this.io = IoServer(server, {
      allowEIO3: true,
      cors: { origin: true, credentials: true },
    });
    this.io.adapter(createAdapter(pubClient, subClient));

    this.io.on('error', (err) => {
      debug('socket.io error', err);
    });

    // Initialization
    this.io.use(async (socket, next) => {
      const { token, apiVersion: sApiVersion } = socket.handshake.query;

      socket.userId = null;
      socket.authToken = null;
      socket.apiVersion = Number.parseInt(sApiVersion || '0', 10);

      if (
        !Number.isFinite(socket.apiVersion) ||
        socket.apiVersion < API_VERSION_MINIMAL ||
        socket.apiVersion > API_VERSION_ACTUAL
      ) {
        socket.apiVersion = API_VERSION_MINIMAL;
      }

      if (token) {
        try {
          socket.userId = await getAuthUserId(socket.handshake.query.token, socket);
          socket.authToken = socket.handshake.query.token;
          debug(`[socket.id=${socket.id}] auth user`, socket.userId);
        } catch (e) {
          // Can not properly return error to client so just treat user as anonymous
          debug(`[socket.id=${socket.id}] auth error`, e.message);
        }
      }

      return next();
    });

    this.io.on('connection', this.onConnect);

    const redisClient = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      db: config.database,
    });
    redisClient.on('error', (err) => {
      if (sentryIsEnabled) {
        Raven.captureException(err, { extra: { err: 'PubsubListener Redis subscriber error' } });
      }

      debug('redis error', err);
    });
    redisClient.subscribe(Object.values(eventNames));

    redisClient.on('message', this.onRedisMessage);
  }

  onConnect = (socket) => {
    socket.on('error', (e) => {
      debug(`[socket.id=${socket.id}] error`, e);
    });

    onSocketEvent(socket, 'auth', async (data) => {
      if (!isPlainObject(data)) {
        throw new EventHandlingError('request without data');
      }

      socket.userId = await getAuthUserId(data.authToken, socket);
      socket.authToken = data.authToken;
      debug(`[socket.id=${socket.id}] auth user`, socket.userId);
    });

    onSocketEvent(socket, 'status', () => ({
      userId: socket.userId,
      apiVersion: socket.apiVersion,
      rooms: buildGroupedListOfSubscriptions(socket),
    }));

    onSocketEvent(socket, 'subscribe', async (data, debugPrefix) => {
      if (!isPlainObject(data)) {
        throw new EventHandlingError('request without data');
      }

      const channelListsPromises = map(data, async (channelIds, channelType) => {
        if (!isArray(channelIds)) {
          throw new EventHandlingError(`List of ${channelType} ids has to be an array`);
        }

        const promises = channelIds.map(async (channelId) => {
          const [objId] = channelId.split('?', 2); // channelId may have params after '?'

          if (channelType === 'timeline') {
            const t = await dbAdapter.getTimelineById(objId);

            if (!t) {
              throw new EventHandlingError(
                `attempt to subscribe to nonexistent timeline`,
                `User ${socket.userId} attempted to subscribe to nonexistent timeline (ID=${objId})`,
              );
            }

            if (t.isPersonal() && t.userId !== socket.userId) {
              throw new EventHandlingError(
                `attempt to subscribe to someone else's '${t.name}' timeline`,
                `User ${socket.userId} attempted to subscribe to '${t.name}' timeline (ID=${objId}) belonging to user ${t.userId}`,
              );
            }
          } else if (channelType === 'user') {
            if (objId !== socket.userId) {
              throw new EventHandlingError(
                `attempt to subscribe to someone else's '${channelType}' channel`,
                `User ${socket.userId} attempted to subscribe to someone else's '${channelType}' channel (ID=${objId})`,
              );
            }
          }

          return `${channelType}:${channelId}`;
        });

        return await Promise.all(promises);
      });

      const channelLists = await Promise.all(channelListsPromises);
      const roomsToSubscribe = channelLists.flat();
      socket.join(roomsToSubscribe);
      debug(`${debugPrefix}: successfully subscribed to ${JSON.stringify(roomsToSubscribe)}`);

      const rooms = buildGroupedListOfSubscriptions(socket);

      return { rooms };
    });

    onSocketEvent(socket, 'unsubscribe', (data, debugPrefix) => {
      if (!isPlainObject(data)) {
        throw new EventHandlingError('request without data');
      }

      const roomsToLeave = [];

      for (const channelType of Object.keys(data)) {
        const channelIds = data[channelType];

        if (!isArray(channelIds)) {
          throw new EventHandlingError(
            `List of ${channelType} ids has to be an array`,
            `got bogus channel list`,
          );
        }

        roomsToLeave.push(...channelIds.filter(Boolean).map((id) => `${channelType}:${id}`));
      }

      for (const room of roomsToLeave) {
        socket.leave(room);
      }

      debug(`${debugPrefix}: successfully unsubscribed from ${JSON.stringify(roomsToLeave)}`);

      const rooms = buildGroupedListOfSubscriptions(socket);
      return { rooms };
    });
  };

  onRedisMessage = async (channel, msg) => {
    const messageRoutes = {
      [eventNames.USER_UPDATE]: this.onUserUpdate,

      [eventNames.POST_CREATED]: this.onPostNew,
      [eventNames.POST_UPDATED]: this.onPostUpdate,
      [eventNames.POST_DESTROYED]: this.onPostDestroy,
      [eventNames.POST_HIDDEN]: this.onPostHide,
      [eventNames.POST_UNHIDDEN]: this.onPostUnhide,
      [eventNames.POST_SAVED]: this.onPostSave,
      [eventNames.POST_UNSAVED]: this.onPostUnsave,

      [eventNames.COMMENT_CREATED]: this.onCommentNew,
      [eventNames.COMMENT_UPDATED]: this.onCommentUpdate,
      [eventNames.COMMENT_DESTROYED]: this.onCommentDestroy,

      [eventNames.LIKE_ADDED]: this.onLikeNew,
      [eventNames.LIKE_REMOVED]: this.onLikeRemove,
      [eventNames.COMMENT_LIKE_ADDED]: this.onCommentLikeNew,
      [eventNames.COMMENT_LIKE_REMOVED]: this.onCommentLikeRemove,

      [eventNames.GLOBAL_USER_UPDATED]: this.onGlobalUserUpdate,
      [eventNames.GROUP_TIMES_UPDATED]: this.onGroupTimesUpdate,

      [eventNames.EVENT_CREATED]: this.onEventCreated,

      [eventNames.ATTACHMENT_UPDATE]: this.onAttachmentUpdate,
    };

    try {
      await messageRoutes[channel](JSON.parse(msg));
    } catch (e) {
      if (sentryIsEnabled) {
        Raven.captureException(e, { extra: { err: 'PubsubListener Redis message handler error' } });
      }

      debug(`onRedisMessage: error while processing ${channel} request`, e);
    }
  };

  async broadcastMessage(
    rooms,
    type,
    payload,
    {
      post = null,
      emitter = defaultEmitter,
      // Deliver message only for these users
      onlyForUsers = List.everything(),
      // Only for the POST_UPDATED events: the new and removed post viewers IDs
      newUsers = List.empty(),
      removedUsers = List.empty(),
      keptUsers = List.empty(),
    } = {},
  ) {
    if (rooms.length === 0) {
      return;
    }

    let destSockets = [...this.io.sockets.sockets.values()].filter((socket) =>
      rooms.some((r) => socket.rooms.has(r)),
    );

    if (destSockets.length === 0) {
      return;
    }

    emitter = this._onlyUsersEmitter(onlyForUsers, emitter);

    let userIds = destSockets.map((s) => s.userId);

    if (post) {
      if (type === eventNames.POST_UPDATED) {
        if (!newUsers.isEmpty()) {
          // Users who listen to post rooms but
          // could not see post before. They should
          // receive a 'post:new' event.

          const newUserIds = List.intersection(newUsers, userIds).items;
          const newUserRooms = destSockets
            .filter((s) => newUserIds.includes(s.userId))
            .flatMap((s) => [...s.rooms]);

          await this.broadcastMessage(
            intersection(newUserRooms, rooms),
            eventNames.POST_CREATED,
            payload,
            { post, emitter: this._postEventEmitter },
            { onlyForUsers: newUsers },
          );

          userIds = List.difference(userIds, newUserIds).items;
        }

        if (!removedUsers.isEmpty()) {
          // Users who listen to post rooms but
          // can not see post anymore. They should
          // receive a 'post:destroy' event.

          const removedUserIds = List.intersection(removedUsers, userIds).items;
          const removedUserRooms = destSockets
            .filter((s) => removedUserIds.includes(s.userId))
            .flatMap((s) => [...s.rooms]);

          await this.broadcastMessage(
            intersection(removedUserRooms, rooms),
            eventNames.POST_DESTROYED,
            { meta: { postId: post.id } },
            { onlyForUsers: removedUsers },
          );

          userIds = List.difference(userIds, removedUserIds).items;
        }

        emitter = this._onlyUsersEmitter(keptUsers, emitter);
      } else {
        const allPostReaders = await post.usersCanSee();
        userIds = List.intersection(allPostReaders, userIds).items;
      }

      destSockets = destSockets.filter((s) => userIds.includes(s.userId));
    }

    // See doc/visibility-rules.md for details
    const [bansMap, bannedByMap] = await Promise.all([
      dbAdapter.getUsersBansIdsMap(userIds),
      dbAdapter.getUsersBanedByIdsMap(userIds),
    ]);

    /** @type {UUID[]} */
    let usersDisabledBans = [];
    /** @type {UUID[]} */
    let adminsDisabledBans = [];

    if (post) {
      const postGroups = await dbAdapter.getPostGroups(post.id);

      // Users/admins who have disabled bans in some post groups
      const groupIds = postGroups.map((g) => g.id);
      const disabledBans = await dbAdapter.getUsersWithDisabledBansInGroups(groupIds);
      usersDisabledBans = disabledBans.map((u) => u.user_id);
      adminsDisabledBans = disabledBans.filter((u) => u.is_admin).map((u) => u.user_id);
    }

    await Promise.all(
      destSockets.map(async (socket) => {
        const { userId } = socket;
        // We may need to change the json data, so we create a deep copy for this
        // socket.
        const data = cloneDeep(payload);

        // Bans
        if (post && userId) {
          let bannedUserIds = bansMap.get(userId) ?? [];
          let bannedByUserIds = bannedByMap.get(userId) ?? [];

          if (usersDisabledBans.includes(userId)) {
            bannedUserIds = [];
          }

          if (adminsDisabledBans.includes(userId) || userId === post.userId) {
            bannedByUserIds = [];
          }

          const isBanned = (id) => bannedUserIds.includes(id) || bannedByUserIds.includes(id);

          if (
            (type === eventNames.COMMENT_UPDATED && isBanned(data.comments.createdBy)) ||
            (type === eventNames.LIKE_ADDED && isBanned(data.users.id)) ||
            ((type === eventNames.COMMENT_LIKE_ADDED || type === eventNames.COMMENT_LIKE_REMOVED) &&
              (isBanned(data.comments.createdBy) || isBanned(data.comments.userId)))
          ) {
            return;
          }

          // A very special case: comment author is banned, but the viewer chooses
          // to see such comments as placeholders.
          if (type === eventNames.COMMENT_CREATED) {
            let hideType = null;

            if (bannedUserIds.includes(data.comments.createdBy)) {
              hideType = Comment.HIDDEN_AUTHOR_BANNED;
            } else if (bannedByUserIds.includes(data.comments.createdBy)) {
              hideType = Comment.HIDDEN_VIEWER_BANNED;
            }

            if (hideType !== null) {
              const user = await dbAdapter.getUserById(userId);

              if (user.getHiddenCommentTypes().includes(hideType)) {
                return;
              }

              const { createdBy } = data.comments;
              data.comments.hideType = hideType;
              data.comments.body = Comment.hiddenBody(hideType);
              data.comments.createdBy = null;
              data.users = data.users.filter((u) => u.id !== createdBy);
              data.admins = data.admins.filter((u) => u.id !== createdBy);
            }
          }
        }

        const realtimeChannels = intersection(rooms, [...socket.rooms]);

        await emitter(socket, type, { ...data, realtimeChannels });
      }),
    );
  }

  onUserUpdate = async (data) => {
    await this.broadcastMessage([`user:${data.user.id}`], 'user:update', data);
  };

  // Message-handlers follow
  onPostDestroy = async ({
    postId,
    rooms,
    // The JSON of List.everything()
    onlyForUsers = { items: [], inclusive: false },
  }) => {
    const json = { meta: { postId } };
    const type = eventNames.POST_DESTROYED;
    await this.broadcastMessage(rooms, type, json, { onlyForUsers: List.from(onlyForUsers) });
  };

  onPostNew = async ({ postId }) => {
    const post = await dbAdapter.getPostById(postId);
    const json = { postId };
    const type = eventNames.POST_CREATED;
    const rooms = await getRoomsOfPost(post);
    await this.broadcastMessage(rooms, type, json, { post, emitter: this._postEventEmitter });
  };

  onPostUpdate = async ({
    postId,
    rooms = null,
    usersBeforeIds = null,
    // The JSON of List.everything()
    onlyForUsers = { items: [], inclusive: false },
  }) => {
    const post = await dbAdapter.getPostById(postId);

    if (!post) {
      return;
    }

    if (!rooms) {
      rooms = await getRoomsOfPost(post);
    }

    const broadcastOptions = {
      post,
      onlyForUsers: List.from(onlyForUsers),
      emitter: this._postEventEmitter,
    };

    // It is possible that after the update of the posts
    // destinations it will become invisible or visible for the some users.
    // 'broadcastMessage' will send 'post:destroy' or 'post:new' to such users.
    const currentUserIds = await post.usersCanSee();

    if (usersBeforeIds) {
      broadcastOptions.newUsers = List.difference(currentUserIds, usersBeforeIds);
      broadcastOptions.removedUsers = List.difference(usersBeforeIds, currentUserIds);
      // These users should receive the 'post:update' event.
      broadcastOptions.keptUsers = List.intersection(usersBeforeIds, currentUserIds);
    } else {
      broadcastOptions.keptUsers = currentUserIds;
    }

    await this.broadcastMessage(rooms, eventNames.POST_UPDATED, { postId }, broadcastOptions);
  };

  onCommentNew = async ({ commentId }) => {
    const comment = await dbAdapter.getCommentById(commentId);

    if (!comment) {
      // might be outdated event
      return;
    }

    const post = await dbAdapter.getPostById(comment.postId);
    const json = await serializeCommentFull(comment);

    const type = eventNames.COMMENT_CREATED;
    const rooms = await getRoomsOfPost(post);
    await this.broadcastMessage(rooms, type, json, {
      post,
      emitter: this._commentLikeEventEmitter,
    });
  };

  onCommentUpdate = async (data) => {
    const comment = await dbAdapter.getCommentById(data.commentId);
    const post = await dbAdapter.getPostById(comment.postId);
    const json = await serializeCommentFull(comment);

    const type = eventNames.COMMENT_UPDATED;
    const rooms = await getRoomsOfPost(post);
    await this.broadcastMessage(rooms, type, json, {
      post,
      emitter: this._commentLikeEventEmitter,
    });
  };

  onCommentDestroy = async ({ postId, commentId, rooms }) => {
    const json = { postId, commentId };
    const post = await dbAdapter.getPostById(postId);
    const type = eventNames.COMMENT_DESTROYED;
    await this.broadcastMessage(rooms, type, json, { post });
  };

  onLikeNew = async ({ userId, postId }) => {
    const post = await dbAdapter.getPostById(postId);
    const json = {
      users: { id: userId }, // will be filled by _likeEventEmitter
      meta: { postId },
    };
    const type = eventNames.LIKE_ADDED;
    const rooms = await getRoomsOfPost(post);
    await this.broadcastMessage(rooms, type, json, { post, emitter: this._likeEventEmitter });
  };

  onLikeRemove = async ({ userId, postId, rooms }) => {
    const json = { meta: { userId, postId } };
    const post = await dbAdapter.getPostById(postId);
    const type = eventNames.LIKE_REMOVED;
    await this.broadcastMessage(rooms, type, json, { post });
  };

  onPostHide = async ({ postId, userId }) => {
    // NOTE: this event only broadcasts to hider's sockets
    // so it won't leak any personal information
    const json = { meta: { postId } };
    const post = await dbAdapter.getPostById(postId);

    const type = eventNames.POST_HIDDEN;
    const rooms = await getRoomsOfPost(post);
    await this.broadcastMessage(rooms, type, json, {
      post,
      emitter: this._singleUserEmitter(userId),
    });
  };

  onPostUnhide = async ({ postId, userId }) => {
    // NOTE: this event only broadcasts to hider's sockets
    // so it won't leak any personal information
    const json = { meta: { postId } };
    const post = await dbAdapter.getPostById(postId);

    const type = eventNames.POST_UNHIDDEN;
    const rooms = await getRoomsOfPost(post);
    await this.broadcastMessage(rooms, type, json, {
      post,
      emitter: this._singleUserEmitter(userId),
    });
  };

  onPostSave = async ({ postId, userId }) => {
    // NOTE: this event only broadcasts to saver's sockets
    // so it won't leak any personal information
    const json = { meta: { postId } };
    const post = await dbAdapter.getPostById(postId);

    const type = eventNames.POST_SAVED;
    const rooms = await getRoomsOfPost(post);
    await this.broadcastMessage(rooms, type, json, {
      post,
      emitter: this._singleUserEmitter(userId),
    });
  };

  onPostUnsave = async ({ postId, userId }) => {
    // NOTE: this event only broadcasts to saver's sockets
    // so it won't leak any personal information
    const json = { meta: { postId } };
    const post = await dbAdapter.getPostById(postId);

    const type = eventNames.POST_UNSAVED;
    const rooms = await getRoomsOfPost(post);
    await this.broadcastMessage(rooms, type, json, {
      post,
      emitter: this._singleUserEmitter(userId),
    });
  };

  onEventCreated = async (eventId) => {
    const event = await dbAdapter.getEventById(eventId);

    const [{ uid: userId }] = await dbAdapter.getUsersIdsByIntIds([event.user_id]);

    const { events, users, groups } = await serializeEvents([event], userId);

    await this.broadcastMessage(
      [`user:${userId}`],
      eventNames.EVENT_CREATED,
      {
        Notifications: events,
        users,
        groups,
      },
      { emitter: this._singleUserEmitter(userId) },
    );
  };

  onAttachmentUpdate = async (attId) => {
    const att = await dbAdapter.getAttachmentById(attId);
    await this.broadcastMessage(
      [
        `user:${att.userId}`, // for the user who owns the attachment
        `attachment:${att.id}`, // for whomever listens specifically to this attachment
      ],
      eventNames.ATTACHMENT_UPDATE,
      {},
      {
        emitter: async (socket, type, json) => {
          const { userId } = socket;
          const { realtimeChannels } = json;

          if (userId !== att.userId && !realtimeChannels.includes(`attachment:${attId}`)) {
            // Other users can only listen to `attachment:${userId}`
            return;
          }

          const attachments = serializeAttachment(att, socket.apiVersion);
          const users = await serializeUsersByIds([att.userId], userId);
          await socket.emit(type, { ...json, attachments, users });
        },
      },
    );
  };

  onCommentLikeNew = async (data) => {
    await this._sendCommentLikeMsg(data, eventNames.COMMENT_LIKE_ADDED);
  };

  onCommentLikeRemove = async (data) => {
    await this._sendCommentLikeMsg(data, eventNames.COMMENT_LIKE_REMOVED);
  };

  onGlobalUserUpdate = async (userId) => {
    const account = await dbAdapter.getFeedOwnerById(userId);

    if (!account) {
      return;
    }

    let receivers = List.everything();

    if (account.isGroup() && account.isPrivate === '1') {
      const postsFeed = await account.getPostsTimeline();
      receivers = List.from(await dbAdapter.getTimelineSubscribersIds(postsFeed.id));
    }

    await this.broadcastMessage(['global:users'], eventNames.GLOBAL_USER_UPDATED, null, {
      emitter: async (socket, type, json) => {
        if (!receivers.includes(socket.userId)) {
          return;
        }

        const [user] = await serializeUsersByIds([userId], socket.userId);
        await socket.emit(type, { ...json, user });
      },
    });
  };
  onGroupTimesUpdate = async ({ groupIds }) => {
    const groups = (await dbAdapter.getFeedOwnersByIds(groupIds)).filter((g) => g.isGroup());

    if (groups.length === 0) {
      return;
    }

    groupIds = groups.map((g) => g.id);
    const feedIds = (await dbAdapter.getUsersNamedTimelines(groupIds, 'Posts')).map((f) => f.id);

    const rooms = (await dbAdapter.getUsersSubscribedToTimelines(feedIds)).map(
      (id) => `user:${id}`,
    );

    await this.broadcastMessage(rooms, 'user:update', null, {
      emitter: async (socket, type, json) => {
        if (!socket.userId) {
          return;
        }

        let isSubscribed = [true];

        if (groupIds.length > 1) {
          // User probably not subscribed to all of these groups
          isSubscribed = await Promise.all(
            feedIds.map((id) => dbAdapter.isUserSubscribedToTimeline(socket.userId, id)),
          );
        }

        const subscribedGroupIds = groupIds.filter((_, i) => isSubscribed[i]);

        const updatedGroups = await serializeUsersByIds(subscribedGroupIds, socket.userId);

        await socket.emit(type, {
          ...json,
          updatedGroups: updatedGroups.slice(0, subscribedGroupIds.length),
          id: socket.userId,
        });
      },
    });
  };

  // Helpers

  _sendCommentLikeMsg = async (data, msgType) => {
    const comment = await dbAdapter.getCommentById(data.commentId);
    const post = await dbAdapter.getPostById(data.postId);

    if (!comment || !post) {
      return;
    }

    const json = await serializeCommentFull(comment);

    if (msgType === eventNames.COMMENT_LIKE_ADDED) {
      json.comments.userId = data.likerUUID;
    } else {
      json.comments.userId = data.unlikerUUID;
    }

    const rooms = await getRoomsOfPost(post);
    await this.broadcastMessage(rooms, msgType, json, {
      post,
      emitter: this._commentLikeEventEmitter,
    });
  };

  async _commentLikeEventEmitter(socket, type, json) {
    const viewerId = socket.userId;
    // We need to re-serialize users according to the viewerId
    const users = await serializeUsersByIds(
      json.users.map((u) => u.id),
      viewerId,
    );
    json.users = users;
    json.admins = users;
    const commentUUID = json.comments.id;
    const [commentLikesData = { c_likes: 0, has_own_like: false }] =
      await dbAdapter.getLikesInfoForComments([commentUUID], viewerId);
    json.comments.likes = parseInt(commentLikesData.c_likes);
    json.comments.hasOwnLike = commentLikesData.has_own_like;

    defaultEmitter(socket, type, json);
  }

  async _likeEventEmitter(socket, type, json) {
    const viewerId = socket.userId;
    const userId = json.users.id;
    // We need to re-serialize users according to the viewerId
    const users = await serializeUsersByIds([userId], viewerId, false);
    // eslint-disable-next-line prefer-destructuring
    json.users = users[0];
    defaultEmitter(socket, type, json);
  }

  _postEventEmitter = async (socket, type, { postId, realtimeChannels }) => {
    const json = await serializeSinglePost(postId, socket.userId, {
      apiVersion: socket.apiVersion,
    });
    defaultEmitter(socket, type, { ...json, realtimeChannels });
  };

  /**
   * Emits message only to the specified List of users
   * @param {List<UUID>} userIds
   */
  _onlyUsersEmitter =
    (userIds, emitter = defaultEmitter) =>
    (socket, type, json) =>
      userIds.includes(socket.userId) && emitter(socket, type, json);

  /**
   * Emits message only to the specified user
   */
  _singleUserEmitter = (userId, emitter = defaultEmitter) =>
    this._onlyUsersEmitter(List.from([userId]), emitter);

  _withUserIdEmitter = (socket, type, json) =>
    socket.userId && defaultEmitter(socket, type, { ...json, id: socket.userId });

  async _insertCommentLikesInfo(postPayload, viewerUUID) {
    postPayload.posts = {
      ...postPayload.posts,
      commentLikes: 0,
      ownCommentLikes: 0,
      omittedCommentLikes: 0,
      omittedOwnCommentLikes: 0,
    };

    const commentIds = postPayload.posts.comments;

    if (!commentIds || commentIds.length == 0) {
      return postPayload;
    }

    const [commentLikesData, [commentLikesForPost]] = await Promise.all([
      dbAdapter.getLikesInfoForComments(commentIds, viewerUUID),
      dbAdapter.getLikesInfoForPosts([postPayload.posts.id], viewerUUID),
    ]);

    const commentLikes = keyBy(commentLikesData, 'uid');
    postPayload.comments = postPayload.comments.map((comment) => {
      comment.likes = 0;
      comment.hasOwnLike = false;

      if (commentLikes[comment.id]) {
        comment.likes = parseInt(commentLikes[comment.id].c_likes);
        comment.hasOwnLike = commentLikes[comment.id].has_own_like;
      }

      return comment;
    });

    postPayload.posts.commentLikes = parseInt(commentLikesForPost.post_c_likes_count);
    postPayload.posts.ownCommentLikes = parseInt(commentLikesForPost.own_c_likes_count);

    if (postPayload.posts.commentLikes == 0) {
      return postPayload;
    }

    postPayload.posts.omittedCommentLikes = postPayload.posts.commentLikes;
    postPayload.posts.omittedOwnCommentLikes = postPayload.posts.ownCommentLikes;

    for (const comment of postPayload.comments) {
      postPayload.posts.omittedCommentLikes -= comment.likes;
      postPayload.posts.omittedOwnCommentLikes -= comment.hasOwnLike * 1;
    }

    return postPayload;
  }

  reAuthorizeSockets() {
    return Promise.all(
      [...this.io.sockets.sockets.values()]
        .filter((socket) => !!socket.authToken)
        .map(async (socket) => {
          let userId = null;

          try {
            userId = await getAuthUserId(socket.authToken, socket);
          } catch {
            // pass
          }

          if (!userId) {
            socket.authTokenData = null;
            socket.userId = null;
          }
        }),
    );
  }
}

/**
 * Returns array of all room names related to post as union of
 * post room and all timelines of posts, materialized or dynamic
 * (as RiverOfNews and MyDiscussions).
 *
 * @param {Post} post
 * @return {Promise<string[]>}
 */
export async function getRoomsOfPost(post) {
  if (!post) {
    return [];
  }

  const author = await dbAdapter.getUserById(post.userId);

  if (!author.isActive) {
    return [];
  }

  const [postFeeds, myDiscussionsFeeds, riverOfNewsFeedsByModes] = await Promise.all([
    post.getTimelines(),
    post.getMyDiscussionsTimelines(),
    post.getRiverOfNewsTimelinesByModes(),
  ]);

  const materialFeeds = postFeeds.filter((f) => f.isMaterial());

  // All feeds related to post
  const allFeeds = uniqBy(
    [
      ...materialFeeds,
      ...riverOfNewsFeedsByModes[HOMEFEED_MODE_FRIENDS_ALL_ACTIVITY],
      ...myDiscussionsFeeds,
    ],
    'id',
  );

  const rooms = allFeeds
    .flatMap((t) => {
      if (t.isRiverOfNews()) {
        const inNarrowMode = riverOfNewsFeedsByModes[HOMEFEED_MODE_FRIENDS_ONLY].some(
          (f) => f.id === t.id,
        );
        const inClassicMode = riverOfNewsFeedsByModes[HOMEFEED_MODE_CLASSIC].some(
          (f) => f.id === t.id,
        );
        return t.isInherent
          ? [
              `timeline:${t.id}?homefeed-mode=${HOMEFEED_MODE_FRIENDS_ALL_ACTIVITY}`,
              inClassicMode && `timeline:${t.id}`, // Default mode for inherent feed
              inClassicMode && `timeline:${t.id}?homefeed-mode=${HOMEFEED_MODE_CLASSIC}`,
              inNarrowMode && `timeline:${t.id}?homefeed-mode=${HOMEFEED_MODE_FRIENDS_ONLY}`,
            ]
          : [
              inNarrowMode && `timeline:${t.id}`, // The only available mode for auxiliary feed
            ];
      }

      return `timeline:${t.id}`;
    })
    .filter(Boolean);
  rooms.push(`post:${post.id}`);
  return rooms;
}

function buildGroupedListOfSubscriptions(socket) {
  return [...socket.rooms]
    .map((room) => room.split(':'))
    .filter((pieces) => pieces.length === 2)
    .reduce((result, [channelType, channelId]) => {
      if (!(channelType in result)) {
        result[channelType] = [];
      }

      result[channelType].push(channelId);
      return result;
    }, {});
}

const defaultEmitter = (socket, type, json) => socket.emit(type, json);

class EventHandlingError extends Error {
  logMessage;

  constructor(message, logMessage = message) {
    super(message);
    this.logMessage = logMessage;
  }
}

/**
 * Adds handler for the incoming socket events of given type that
 * properly handles: callback parameter and it's absence, debug logging
 * on error, Sentry exceptions capture, and acknowledgment messages.
 *
 * @param {object} socket
 * @param {string} event
 * @param {function} handler
 */
const onSocketEvent = (socket, event, handler) =>
  socket.on(event, async (data, ...extra) => {
    const debugPrefix = `[socket.id=${socket.id}] '${event}' request`;
    const callback = isFunction(last(extra)) ? last(extra) : noop;

    try {
      debug(debugPrefix);
      const result = await handler(data, debugPrefix);
      callback({ success: true, ...result });
    } catch (e) {
      if (e instanceof EventHandlingError) {
        debug(`${debugPrefix}: ${e.logMessage}`);
      } else {
        debug(`${debugPrefix}: ${e.message}`);
      }

      if (sentryIsEnabled) {
        Raven.captureException(e, { extra: { err: `PubsubListener ${event} error` } });
      }

      callback({ success: false, message: e.message });
    }
  });

async function getAuthUserId(jwtToken, socket) {
  if (!jwtToken) {
    return null;
  }

  // Parse the 'X-Forwarded-For' header ("client, proxy1, proxy2")
  const proxyHeader = socket.handshake.headers[config.proxyIpHeader.toLowerCase()];
  const ips = config.trustProxyHeaders && proxyHeader ? proxyHeader.split(/\s*,\s*/) : [];

  // Fake context
  const ctx = {
    ip: ips[0] || socket.handshake.address,
    headers: {
      ...socket.handshake.headers,
      authorization: `Bearer ${jwtToken}`,
    },
    method: 'WS',
    state: { matchedRoute: '*' },
  };

  await withJWT(ctx, () => null);
  await withAuthToken(ctx, () => null);

  return ctx.state.authToken.userId;
}

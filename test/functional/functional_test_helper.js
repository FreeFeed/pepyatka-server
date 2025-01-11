/* eslint-env mocha */
import http from 'http';
import { stringify as qsStringify } from 'querystring';
import util from 'util';

import { fileFrom } from 'node-fetch';
import request from 'superagent';
import _, { merge } from 'lodash';
import socketIO from 'socket.io-client';
import expect from 'unexpected';
import Application from 'koa';

import { dbAdapter, sessionTokenV1Store, User, Group } from '../../app/models';
import { getSingleton as initApp } from '../../app/app';
import { addMailListener } from '../../lib/mailer';
import { API_VERSION_2, API_VERSION_3, API_VERSION_ACTUAL } from '../../app/api-versions';
import { createPost as iCreatePost } from '../integration/helpers/posts-and-comments';

import * as schema from './schemaV2-helper';

const apiUrl = async (relativeUrl) => {
  const app = await initApp();
  return `${app.context.config.host}${relativeUrl}`;
};

export function subscribeToCtx(context, username) {
  return function (done) {
    apiUrl(`/v1/users/${username}/subscribe`)
      .then((url) => {
        request
          .post(url)
          .send({ authToken: context.authToken })
          .end((err, res) => {
            done(err, res);
          });
      })
      .catch((e) => {
        done(e);
      });
  };
}

export function updateUserCtx(context, attrs) {
  return function (done) {
    apiUrl(`/v1/users/${context.user.id}`)
      .then((url) => {
        request
          .post(url)
          .send({
            authToken: context.authToken,
            user: { email: attrs.email },
            _method: 'put',
          })
          .end((err, res) => {
            done(err, res);
          });
      })
      .catch((e) => {
        done(e);
      });
  };
}

export function resetPassword(token) {
  return function (done) {
    apiUrl(`/v1/passwords/${token}`)
      .then((url) => {
        request
          .post(url)
          .send({ _method: 'put' })
          .end((err, res) => {
            done(err, res);
          });
      })
      .catch((e) => {
        done(e);
      });
  };
}

export async function performSearch(context, query, params = {}) {
  params = {
    limit: 30,
    offset: 0,
    ...params,
  };

  const response = await postJson(
    `/v2/search?qs=${encodeURIComponent(query)}&limit=${params.limit}&offset=${params.offset}`,
    {
      authToken: context.authToken,
      _method: 'get',
    },
  );
  return await response.json();
}

export async function getSummary(context, params = {}) {
  params = { days: 7, ...params };

  const url = params.username
    ? `/v2/summary/${params.username}/${params.days}`
    : `/v2/summary/${params.days}`;

  const response = await postJson(url, {
    authToken: context.authToken,
    _method: 'get',
  });

  return await response.json();
}

// The just* functions create objects using the model API (without HTTP
// requests) and without any checks. Use them to speed up test setup (for
// example, in beforeEach) when object creation is not the purpose of the test.

export async function justCreatePost(authorCtx, body, destNames = [authorCtx.username]) {
  const destAccounts = await dbAdapter.getFeedOwnersByUsernames(destNames);
  return await iCreatePost(authorCtx.user, body, destAccounts);
}

export async function justCreateComment(authorCtx, postId, body) {
  const comment = authorCtx.user.newComment({ body, postId });
  await comment.create();
  return comment;
}

export async function justCreateGroup(
  creatorCtx,
  username,
  screenName = username,
  { isPrivate = false, isProtected = isPrivate, isRestricted = false } = {},
) {
  const g = new Group({
    username,
    screenName,
    isPrivate: isPrivate ? '1' : '0',
    isProtected: isProtected ? '1' : '0',
    isRestricted: isRestricted ? '1' : '0',
  });
  await g.create(creatorCtx.user.id);
  return g;
}

export async function justLikeComment(commentObj, userCtx) {
  await commentObj.addLike(userCtx.user);
}

export function createPost(context, body, callback) {
  return function (done) {
    apiUrl('/v1/posts')
      .then((url) => {
        request
          .post(url)
          .send({ post: { body }, meta: { feeds: context.username }, authToken: context.authToken })
          .end((err, res) => {
            context.post = res.body.posts;

            if (typeof callback !== 'undefined') {
              callback(context.post);
            }

            done(err, res);
          });
      })
      .catch((e) => {
        done(e);
      });
  };
}

export function createPostWithCommentsDisabled(context, body, commentsDisabled) {
  return postJson('/v1/posts', {
    post: { body },
    meta: { feeds: context.username, commentsDisabled },
    authToken: context.authToken,
  });
}

export function createPostForTest(context, body, callback) {
  apiUrl('/v1/posts')
    .then((url) => {
      request
        .post(url)
        .send({ post: { body }, meta: { feeds: context.username }, authToken: context.authToken })
        .end((err, res) => {
          context.post = res.body.posts;
          callback(err, res);
        });
    })
    .catch((e) => {
      callback(e);
    });
}

export function createComment(body, postId, authToken, callback) {
  return (function (done) {
    apiUrl('/v1/comments')
      .then((url) => {
        const comment = {
          body,
          postId,
        };

        request
          .post(url)
          .send({ comment, authToken })
          .end((err, res) => {
            done(err, res);
          });
      })
      .catch((e) => {
        done(e);
      });
  })(callback);
}

export function createCommentCtx(context, body) {
  return function (done) {
    apiUrl('/v1/comments')
      .then((url) => {
        const comment = {
          body,
          postId: context.post.id,
        };

        request
          .post(url)
          .send({ comment, authToken: context.authToken })
          .end((err, res) => {
            context.comment = res.body.comments;
            done(err, res);
          });
      })
      .catch((e) => {
        done(e);
      });
  };
}

export function removeComment(commentId, authToken, callback) {
  return (function (done) {
    apiUrl(`/v1/comments/${commentId}`)
      .then((url) => {
        request
          .post(url)
          .send({
            authToken,
            _method: 'delete',
          })
          .end((err, res) => {
            done(err, res);
          });
      })
      .catch((e) => {
        done(e);
      });
  })(callback);
}

export function removeCommentAsync(context, commentId) {
  return postJson(`/v1/comments/${commentId}`, {
    authToken: context.authToken,
    _method: 'delete',
  });
}

export function getTimeline(timelinePath, authToken, callback) {
  return (function (done) {
    apiUrl(timelinePath)
      .then((url) => {
        const sendParams = {};

        if (authToken) {
          sendParams.authToken = authToken;
        }

        request
          .get(url)
          .query(sendParams)
          .end((err, res) => {
            done(err, res);
          });
      })
      .catch((e) => {
        done(e);
      });
  })(callback);
}

export function getTimelinePaged(timelinePath, authToken, offset, limit, callback) {
  return (function (done) {
    apiUrl(timelinePath)
      .then((url) => {
        const sendParams = {};

        if (!_.isUndefined(authToken)) {
          sendParams.authToken = authToken;
        }

        if (!_.isUndefined(offset)) {
          sendParams.offset = offset;
        }

        if (!_.isUndefined(limit)) {
          sendParams.limit = limit;
        }

        request
          .get(url)
          .query(sendParams)
          .end((err, res) => {
            done(err, res);
          });
      })
      .catch((e) => {
        done(e);
      });
  })(callback);
}

export function getSubscribers(username, authToken, callback) {
  return (function (done) {
    const sendParams = {};

    if (authToken) {
      sendParams.authToken = authToken;
    }

    apiUrl(`/v1/users/${username}/subscribers`)
      .then((url) => {
        request
          .get(url)
          .query(sendParams)
          .end((err, res) => {
            done(err, res);
          });
      })
      .catch((e) => {
        done(e);
      });
  })(callback);
}

const agent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 5000,
  maxSockets: 50,
});

export async function performRequest(relativePath, params) {
  return await fetch(await apiUrl(relativePath), { agent, ...params });
}

/**
 * Bulletproof HTTP JSON request
 *
 * @param {string} method
 * @param {string} relativePath
 * @param {any} [body]
 * @param {object} [headers]
 */
export async function performJSONRequest(method, relativePath, body = undefined, headers = {}) {
  method = method.toUpperCase();

  if (method === 'GET' || method === 'HEAD' || body === undefined || body === null) {
    body = undefined;
  } else if (body instanceof FormData) {
    // The Content-Type will be sets up automatically
  } else {
    body = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }

  const response = await performRequest(relativePath, { method, body, headers });
  const textResponse = await response.text();

  try {
    const json = JSON.parse(textResponse);

    if (typeof json === 'object' && json !== null) {
      json.__httpCode = response.status;
    }

    return json;
  } catch (e) {
    return {
      err: `JSON parsing error: ${e.message}`,
      textResponse,
      __httpCode: response.status,
    };
  }
}

export function authHeaders(userCtx) {
  return userCtx ? { Authorization: `Bearer ${userCtx.authToken}` } : {};
}

export async function sessionRequest(username, password) {
  return await fetch(await apiUrl('/v1/session'), {
    agent,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: qsStringify({ username, password }),
  });
}

export async function getSubscribersAsync(username, userContext) {
  const relativeUrl = `/v1/users/${username}/subscribers`;
  let url = await apiUrl(relativeUrl);

  if (!_.isUndefined(userContext)) {
    const encodedToken = encodeURIComponent(userContext.authToken);
    url = `${url}?authToken=${encodedToken}`;
  }

  return fetch(url, { agent });
}

export async function getSubscriptionsAsync(username, userContext) {
  const relativeUrl = `/v1/users/${username}/subscriptions`;
  let url = await apiUrl(relativeUrl);

  if (!_.isUndefined(userContext)) {
    const encodedToken = encodeURIComponent(userContext.authToken);
    url = `${url}?authToken=${encodedToken}`;
  }

  return fetch(url, { agent });
}

export function getSubscriptions(username, authToken, callback) {
  return (function (done) {
    const sendParams = {};

    if (authToken) {
      sendParams.authToken = authToken;
    }

    apiUrl(`/v1/users/${username}/subscriptions`)
      .then((url) => {
        request
          .get(url)
          .query(sendParams)
          .end((err, res) => {
            done(err, res);
          });
      })
      .catch((e) => {
        done(e);
      });
  })(callback);
}

async function postJson(relativeUrl, data) {
  return fetch(await apiUrl(relativeUrl), {
    agent,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export function createUserAsyncPost(user) {
  return postJson(`/v1/users`, user);
}

export async function createUserAsync(username, password = 'pw', { email, ...attributes } = {}) {
  const user = new User({ username, password, email, ...attributes });
  await user.create();
  const session = await sessionTokenV1Store.create(user.id);
  return {
    authToken: session.tokenString(),
    username: user.username,
    password,
    user,
    attributes: { email, ...attributes },
  };
}

let testUserCounter = 1;
export function createTestUser(username = null) {
  return createUserAsync(username || `testuser${testUserCounter++}`, 'pw');
}

export function createTestUsers(countOrUsernames) {
  if (Array.isArray(countOrUsernames)) {
    return Promise.all(countOrUsernames.map((username) => createTestUser(username)));
  }

  const promises = [];

  for (let i = 0; i < countOrUsernames; i++) {
    promises.push(createTestUser());
  }

  return Promise.all(promises);
}

export function whoami(authToken) {
  return postJson('/v2/users/whoami', {
    authToken,
    _method: 'get',
  });
}

export function like(postId, authToken) {
  return postJson(`/v1/posts/${postId}/like`, { authToken });
}

export function unlike(postId, authToken) {
  return postJson(`/v1/posts/${postId}/unlike`, { authToken });
}

export function updateUserAsync(userContext, user) {
  return postJson(`/v1/users/${userContext.user.id}`, {
    authToken: userContext.authToken,
    user,
    _method: 'put',
  });
}

export function updateGroupAsync(group, adminContext, groupData) {
  return postJson(`/v1/users/${group.id}`, {
    authToken: adminContext.authToken,
    user: groupData,
    _method: 'put',
  });
}

export async function updateProfilePicture(userContext, filePath) {
  const form = new FormData();
  form.append('file', await fileFrom(filePath, 'image/png'));
  const url = await apiUrl(`/v1/users/updateProfilePicture`);
  return await fetch(url, {
    agent,
    method: 'POST',
    headers: { 'X-Authentication-Token': userContext.authToken },
    body: form,
  });
}

export async function updateGroupProfilePicture(userContext, groupName, filePath) {
  const form = new FormData();
  form.append('file', await fileFrom(filePath, 'image/png'));
  const url = await apiUrl(`/v1/groups/${groupName}/updateProfilePicture`);
  return await fetch(url, {
    agent,
    method: 'POST',
    headers: { 'X-Authentication-Token': userContext.authToken },
    body: form,
  });
}

export function getUserAsync(context, username) {
  return postJson(`/v1/users/${username}`, {
    authToken: context.authToken,
    _method: 'get',
  });
}

export function goPrivate(userContext) {
  return updateUserAsync(userContext, { isPrivate: '1' });
}

export function goPublic(userContext) {
  return updateUserAsync(userContext, { isPrivate: '0' });
}

export function goProtected(userContext) {
  return updateUserAsync(userContext, { isPrivate: '0', isProtected: '1' });
}

export function groupToPrivate(group, userContext) {
  return updateGroupAsync(group, userContext, { isPrivate: '1' });
}

export function groupToProtected(group, userContext) {
  return updateGroupAsync(group, userContext, { isPrivate: '0', isProtected: '1' });
}

export async function subscribeToAsync(subscriber, victim) {
  let victimObj;

  if (victim instanceof User) {
    victimObj = victim;
  } else if (victim.user) {
    victimObj = victim.user;
  } else {
    // Old-fashion group or user context
    victimObj = await dbAdapter.getFeedOwnerById(victim.id ?? victim.group.id);
  }

  await subscriber.user.subscribeTo(victimObj);
}

export function unsubscribeFromAsync(unsubscriber, victim) {
  return postJson(`/v1/users/${victim.username}/unsubscribe`, {
    authToken: unsubscriber.authToken,
  });
}

export function unsubscribeUserFromMeAsync(user, victim) {
  return postJson(`/v1/users/${victim.username}/unsubscribeFromMe`, { authToken: user.authToken });
}

export function acceptRequestAsync(subject, requester) {
  return postJson(`/v1/users/acceptRequest/${requester.username}`, {
    authToken: subject.authToken,
  });
}

export function rejectRequestAsync(subject, requester) {
  return postJson(`/v1/users/rejectRequest/${requester.username}`, {
    authToken: subject.authToken,
  });
}

export async function mutualSubscriptions(userContexts) {
  const promises = [];

  for (const ctx1 of userContexts) {
    for (const ctx2 of userContexts) {
      if (ctx1.username == ctx2.username) {
        continue;
      }

      promises.push(ctx1.user.subscribeTo(ctx2.user));
    }
  }

  await Promise.all(promises);
}

export async function createAndReturnPostToFeed(feed, userContext, body) {
  const destinations = _.isArray(feed) ? _.map(feed, 'username') : [feed.username];
  const response = await postJson('/v1/posts', {
    post: { body },
    meta: { feeds: destinations },
    authToken: userContext.authToken,
  });

  if (response.status != 200) {
    throw new Error(`HTTP/1.1 ${response.status}`);
  }

  const data = await response.json();

  return data.posts;
}

export function createAndReturnPost(userContext, body) {
  return createAndReturnPostToFeed(userContext, userContext, body);
}

export function createCommentAsync(userContext, postId, body) {
  return postJson('/v1/comments', { comment: { body, postId }, authToken: userContext.authToken });
}

export function updateCommentAsync(userContext, commentId, body) {
  return postJson(`/v1/comments/${commentId}`, {
    comment: { body },
    authToken: userContext.authToken,
    _method: 'put',
  });
}

const getTimelineAsync = async (relativeUrl, userContext) => {
  let url = await apiUrl(relativeUrl);

  if (!_.isUndefined(userContext)) {
    const encodedToken = encodeURIComponent(userContext.authToken);
    url = `${url}?authToken=${encodedToken}`;
  }

  const response = await fetch(url, { agent });

  if (response.status != 200) {
    throw new Error(`HTTP/1.1 ${response.status}`);
  }

  const data = await response.json();

  return data;
};

export function getUserFeed(feedOwnerContext, readerContext) {
  return getTimelineAsync(`/v2/timelines/${feedOwnerContext.username}`, readerContext);
}

export function getUserLikesFeed(feedOwnerContext, readerContext) {
  return getTimelineAsync(`/v2/timelines/${feedOwnerContext.username}/likes`, readerContext);
}

export function getUserCommentsFeed(feedOwnerContext, readerContext) {
  return getTimelineAsync(`/v2/timelines/${feedOwnerContext.username}/comments`, readerContext);
}

export function getRiverOfNews(userContext) {
  return getTimelineAsync('/v2/timelines/home', userContext);
}

export function getMyDiscussions(userContext) {
  return getTimelineAsync('/v2/timelines/filter/discussions', userContext);
}

export function sendResetPassword(email) {
  return postJson('/v1/passwords', { email });
}

export async function readPostAsync(postId, userContext) {
  const relativeUrl = `/v2/posts/${postId}?maxComments=all`;
  let url = await apiUrl(relativeUrl);

  if (!_.isUndefined(userContext)) {
    const encodedToken = encodeURIComponent(userContext.authToken);
    url = `${url}&authToken=${encodedToken}`;
  }

  return fetch(url, { agent });
}

export function disableComments(postId, authToken) {
  return postJson(`/v1/posts/${postId}/disableComments`, { authToken });
}

export function enableComments(postId, authToken) {
  return postJson(`/v1/posts/${postId}/enableComments`, { authToken });
}

export async function createPostViaBookmarklet(userContext, body) {
  return await fetch(await apiUrl(`/v1/bookmarklet`), {
    agent,
    method: 'POST',
    headers: {
      'X-Authentication-Token': userContext.authToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

export async function createMockAttachmentAsync(context) {
  const params = {
    mediaType: 'image',
    fileName: 'lion.jpg',
    fileExtension: 'jpg',
    fileSize: 12345,
    userId: context.user.id,
    imageSizes: {
      t: { w: 200, h: 175, url: 'https://example.com/t/lion.jpg' },
      o: { w: 600, h: 525, url: 'https://example.com/lion.jpg' },
    },
  };

  const id = await dbAdapter.createAttachment(params);

  return {
    id,
    ...params,
  };
}

export function updatePostAsync(context, post) {
  return postJson(`/v1/posts/${context.post.id}`, {
    authToken: context.authToken,
    post,
    _method: 'put',
  });
}

export function deletePostAsync(context, postId) {
  return postJson(`/v1/posts/${postId}`, {
    authToken: context.authToken,
    _method: 'delete',
  });
}

export async function createGroupAsync(
  context,
  username,
  screenName = null,
  isPrivate = false,
  isRestricted = false,
) {
  const params = {
    group: {
      username,
      screenName: screenName || username,
      isPrivate: isPrivate ? '1' : '0',
      isRestricted: isRestricted ? '1' : '0',
    },
    authToken: context.authToken,
  };

  const response = await postJson(`/v1/groups`, params);
  const data = await response.json();

  return {
    group: data.groups,
    username,
  };
}

export function promoteToAdmin(group, existingAdminContext, potentialAdminContext) {
  return postJson(
    `/v1/groups/${group.username}/subscribers/${potentialAdminContext.user.username}/admin`,
    { authToken: existingAdminContext.authToken },
  );
}

export function demoteFromAdmin(group, existingAdminContext, victimAdminContext) {
  return postJson(
    `/v1/groups/${group.username}/subscribers/${victimAdminContext.user.username}/unadmin`,
    { authToken: existingAdminContext.authToken },
  );
}

export function kickOutUserFromGroup(group, adminContext, victim) {
  return postJson(`/v1/groups/${group.username}/unsubscribeFromGroup/${victim.user.username}`, {
    authToken: adminContext.authToken,
  });
}

export function sendRequestToSubscribe(subscriber, user) {
  return postJson(`/v1/users/${user.username}/sendRequest`, { authToken: subscriber.authToken });
}

export function revokeSubscriptionRequest(subscriber, user) {
  return postJson(`/v2/requests/${user.username}/revoke`, { authToken: subscriber.authToken });
}

export function acceptRequestToSubscribe(subscriber, user) {
  return postJson(`/v1/users/acceptRequest/${subscriber.username}`, { authToken: user.authToken });
}

export function sendRequestToJoinGroup(subscriber, group) {
  return postJson(`/v1/groups/${group.username}/sendRequest`, { authToken: subscriber.authToken });
}

export function acceptRequestToJoinGroup(admin, subscriber, group) {
  return postJson(`/v1/groups/${group.username}/acceptRequest/${subscriber.user.username}`, {
    authToken: admin.authToken,
  });
}

export function rejectSubscriptionRequestToGroup(admin, subscriber, group) {
  return postJson(`/v1/groups/${group.username}/rejectRequest/${subscriber.user.username}`, {
    authToken: admin.authToken,
  });
}

export function banUser(who, whom) {
  return postJson(`/v1/users/${whom.username}/ban`, { authToken: who.authToken });
}

export function unbanUser(who, whom) {
  return postJson(`/v1/users/${whom.username}/unban`, { authToken: who.authToken });
}

export function hidePost(postId, user) {
  return postJson(`/v1/posts/${postId}/hide`, { authToken: user.authToken });
}

export function unhidePost(postId, user) {
  return postJson(`/v1/posts/${postId}/unhide`, { authToken: user.authToken });
}

export function savePost(postId, user) {
  return postJson(`/v1/posts/${postId}/save`, { authToken: user.authToken });
}

export function unsavePost(postId, user) {
  return postJson(`/v1/posts/${postId}/save`, { authToken: user.authToken, _method: 'delete' });
}

export async function getUserEvents(
  userContext,
  eventTypes = null,
  limit = null,
  offset = null,
  startDate = null,
  endDate = null,
) {
  const eventTypesQS = eventTypes ? eventTypes.map((t) => `filter=${t}&`).join('') : '';
  const limitQS = limit ? `limit=${limit}&` : '';
  const offsetQS = offset ? `offset=${offset}&` : '';
  const startDateQS = startDate ? `startDate=${startDate}&` : '';
  const endDateQS = endDate ? `endDate=${endDate}` : '';
  const queryString = `/v2/notifications?${eventTypesQS}${limitQS}${offsetQS}${startDateQS}${endDateQS}`;

  const response = await postJson(queryString, {
    authToken: userContext.authToken,
    _method: 'get',
  });
  return await response.json();
}

export async function getUnreadNotificationsNumber(user) {
  const response = await postJson('/v2/users/getUnreadNotificationsNumber', {
    authToken: user.authToken,
    _method: 'get',
  });
  return response;
}

export async function getUnreadDirectsNumber(user) {
  const response = await postJson('/v2/users/getUnreadDirectsNumber', {
    authToken: user.authToken,
    _method: 'get',
  });
  return response;
}

export async function markAllDirectsAsRead(user) {
  const response = await postJson('/v2/users/markAllDirectsAsRead', {
    authToken: user.authToken,
    _method: 'get',
  });
  return response;
}

export async function markAllNotificationsAsRead(user) {
  const response = await postJson('/v2/users/markAllNotificationsAsRead', {
    authToken: user.authToken,
    _method: 'post',
  });
  return response;
}

// ************************
// Comment likes
// ************************

export async function likeComment(commentId, likerContext = null) {
  const headers = {};

  if (likerContext) {
    headers['X-Authentication-Token'] = likerContext.authToken;
  }

  const url = await apiUrl(`/v2/comments/${commentId}/like`);
  return fetch(url, { agent, method: 'POST', headers });
}

export async function unlikeComment(commentId, unlikerContext = null) {
  const headers = {};

  if (unlikerContext) {
    headers['X-Authentication-Token'] = unlikerContext.authToken;
  }

  const url = await apiUrl(`/v2/comments/${commentId}/unlike`);
  return fetch(url, { agent, method: 'POST', headers });
}

export async function getCommentLikes(commentId, viewerContext = null) {
  const headers = {};

  if (viewerContext) {
    headers['X-Authentication-Token'] = viewerContext.authToken;
  }

  const url = await apiUrl(`/v2/comments/${commentId}/likes`);
  return fetch(url, { agent, method: 'GET', headers });
}

/**
 * Async-friendly wrapper around Socket.IO client.
 * Convenient for testing
 */
const PromisifiedIO = (host, options, events) => {
  return new Promise((resolve, reject) => {
    try {
      const client = socketIO.connect(host, options);

      client.on('error', reject);
      client.on('connect_error', reject);

      client.on('disconnect', () => {
        if ('disconnect' in events) {
          try {
            events.disconnect();
          } catch {
            // do nothing
          }
        }

        resolve();
      });

      for (const k of Object.keys(events)) {
        if (k === 'disconnect') {
          continue;
        }

        client.on(k, (...args) => {
          try {
            args.push(client);
            const result = events[k](...args);

            if (result instanceof Promise) {
              result.catch((e) => {
                reject(e);
              });
            }
          } catch (e) {
            reject(e);
          }
        });
      }
    } catch (e) {
      reject(e);
    }
  });
};

export async function createRealtimeConnection(context, callbacks) {
  const app = await initApp();

  const port = process.env.PEPYATKA_SERVER_PORT || app.context.port;
  const options = {
    transports: ['websocket'],
    forceNew: true,
    query: { token: context.authToken, apiVersion: API_VERSION_ACTUAL },
  };

  return PromisifiedIO(`http://localhost:${port}/`, options, callbacks);
}

export async function fetchPost(postId, viewerContext = null, params = {}) {
  params = {
    returnError: false,
    allComments: false,
    allLikes: false,
    apiVersion: API_VERSION_2,
    ...params,
  };
  const headers = {};

  if (viewerContext) {
    headers['X-Authentication-Token'] = viewerContext.authToken;
  }

  const response = await fetch(
    await apiUrl(
      `/v${params.apiVersion}/posts/${postId}?maxComments=${
        params.allComments ? 'all' : ''
      }&maxLikes=${params.allLikes ? 'all' : ''}`,
    ),
    { agent, headers },
  );
  const post = await response.json();

  if (response.status !== 200) {
    if (params.returnError) {
      return response;
    }

    expect.fail('HTTP error (code {0}): {1}', response.status, post.err);
  }

  if (params.apiVersion === API_VERSION_2 || params.apiVersion === API_VERSION_3) {
    expect(post, 'to exhaustively satisfy', schema.postResponse);
  }

  return post;
}

export async function fetchTimeline(path, viewerContext = null) {
  const headers = {};

  if (viewerContext) {
    headers['X-Authentication-Token'] = viewerContext.authToken;
  }

  const response = await fetch(await apiUrl(`/v2/timelines/${path}`), { agent, headers });
  const feed = await response.json();

  // console.log(feed);
  if (response.status !== 200) {
    expect.fail('HTTP error (code {0}): {1}', response.status, feed.err);
  }

  expect(feed, 'to exhaustively satisfy', schema.timelineResponse);
  return feed;
}

/**
 * Returns checker for the should.satisfy that checks
 * that the given object has not property `name` or
 * this property is an empty array.
 *
 * @param {String} name
 */
export function noFieldOrEmptyArray(name) {
  return function (obj) {
    return !(name in obj) || (_.isArray(obj[name]) && obj[name].length === 0);
  };
}

// ************************
// Invitations
// ************************

export async function createInvitation(creatorContext, invitation) {
  const headers = { 'Content-Type': 'application/json' };

  if (creatorContext) {
    headers['X-Authentication-Token'] = creatorContext.authToken;
  }

  const url = await apiUrl(`/v2/invitations`);
  return fetch(url, { agent, method: 'POST', headers, body: JSON.stringify(invitation) });
}

export async function getInvitation(secureId, viewerContext) {
  const headers = {};

  if (viewerContext) {
    headers['X-Authentication-Token'] = viewerContext.authToken;
  }

  const url = await apiUrl(`/v2/invitations/${secureId}`);
  return fetch(url, { agent, method: 'GET', headers });
}

export class MockHTTPServer {
  port;
  _server;

  constructor(handler, { timeout = 500 } = {}) {
    const app = new Application();
    app.use(handler);

    this._server = http.createServer(app.callback());
    this._server.timeout = timeout;

    this._server.listenAsync = util.promisify(this._server.listen);
    this._server.closeAsync = util.promisify(this._server.close);
  }

  get origin() {
    return `http://localhost:${this.port}`;
  }

  async start() {
    await this._server.listenAsync(0);
    this.port = this._server.address().port;
  }

  async stop() {
    await this._server.closeAsync();
  }
}

/**
 * Run tests in 'describe' block with modified app config. Use it only in
 * 'describe', not in test functions!
 *
 * See also the `withModifiedConfig()` helper from
 * `test/helpers/with-modified-config.ts`
 *
 * @typedef {import('config').Config} Config
 * @param {import('../../app/support/types').DeepPartial<Config>} patch
 */
export function withModifiedAppConfig(patch) {
  let app, prevConfig;
  before(async () => {
    app = await initApp();
    prevConfig = app.context.config;
    app.context.config = merge({}, prevConfig, patch);
  });

  after(() => {
    app.context.config = prevConfig;
  });
}

/**
 * Capture sent emails for all tests in 'describe' block. Use it only in
 * 'describe', not in test functions!
 */
export function withEmailCapture({ clearBeforeEach = true, multiple = false } = {}) {
  const ref = { current: multiple ? [] : null };
  let removeMailListener = () => null;
  before(
    () =>
      (removeMailListener = addMailListener((r) => {
        if (multiple) {
          ref.current.push(r);
        } else {
          ref.current = r;
        }
      })),
  );
  after(removeMailListener);
  clearBeforeEach && beforeEach(() => (ref.current = multiple ? [] : null));
  return ref;
}

export function cmpBy(key) {
  return (a, b) => {
    // eslint-disable-next-line no-nested-ternary
    return a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0;
  };
}
